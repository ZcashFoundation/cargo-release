import path from "node:path";

import { gte as semverGte } from "semver";
import { parse as parseYaml } from "yaml";

import { asError } from "./errors.js";
import {
  deriveReleasePlan,
  findGithubReleaseCandidate,
  renderReleaseTemplate,
  validateReleaseSource,
  type CargoMetadataSnapshot,
  type ReleasePlan,
  type ReleasePlanConfig,
} from "./release-plan.js";

type JsonObject = Record<string, unknown>;

const ROOT_KEYS = new Set(["tagTemplate", "packageOverrides", "githubRelease"]);
const OVERRIDE_KEYS = new Set(["tagTemplate"]);
const GITHUB_RELEASE_KEYS = new Set([
  "package",
  "nameTemplate",
  "notesFile",
  "notesHeadingTemplate",
  "prerelease",
  "makeLatest",
]);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface WorkspacePlanPorts {
  run(
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult>;
  readText(file: string): Promise<string>;
  makeTempDirectory(): Promise<string>;
  removeDirectory(directory: string): Promise<void>;
}

export interface LoadReleasePlanOptions {
  readonly controllerDirectory: string;
  readonly sourceDirectory: string;
  readonly baseSha: string;
  readonly targetSha: string;
  readonly configPath: string;
}

export interface LoadReleasePlanResult {
  readonly plan: ReleasePlan;
  readonly githubReleaseError?: Error;
}

export async function loadReleasePlan(
  options: LoadReleasePlanOptions,
  ports: WorkspacePlanPorts,
): Promise<LoadReleasePlanResult> {
  validateReleaseSource(options.baseSha, options.targetSha);

  const controllerDirectory = path.resolve(options.controllerDirectory);
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const cargoVersion = await requiredRun(
    ports,
    "cargo",
    ["--version"],
    sourceDirectory,
  );
  requireSupportedCargo(cargoVersion.stdout);

  const repository = (
    await requiredRun(
      ports,
      "git",
      ["rev-parse", "--show-toplevel"],
      sourceDirectory,
    )
  ).stdout.trim();
  const workspaceRelativePath = (
    await requiredRun(
      ports,
      "git",
      ["rev-parse", "--show-prefix"],
      sourceDirectory,
    )
  ).stdout.trim();
  requireSafeGitPrefix(workspaceRelativePath);
  const head = (
    await requiredRun(ports, "git", ["rev-parse", "HEAD"], repository)
  ).stdout.trim();
  if (head.toLowerCase() !== options.targetSha.toLowerCase()) {
    throw new Error(
      `source checkout HEAD ${head} does not match target SHA ${options.targetSha}`,
    );
  }
  const status = await requiredRun(
    ports,
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    repository,
  );
  if (status.stdout.trim().length > 0)
    throw new Error("source checkout must be clean");
  await requiredRun(
    ports,
    "git",
    ["cat-file", "-e", `${options.baseSha}^{commit}`],
    repository,
  );
  const ancestry = await ports.run(
    "git",
    ["merge-base", "--is-ancestor", options.baseSha, options.targetSha],
    repository,
  );
  if (ancestry.exitCode !== 0) {
    throw new Error(
      `base SHA ${options.baseSha} must be an ancestor of target SHA ${options.targetSha}`,
    );
  }

  const configFile = resolveWithin(
    controllerDirectory,
    options.configPath,
    "config path",
  );
  const config = parseReleasePlanConfig(await ports.readText(configFile));
  const targetMetadata = parseCargoMetadata(
    (
      await requiredRun(
        ports,
        "cargo",
        ["metadata", "--format-version", "1", "--no-deps"],
        sourceDirectory,
      )
    ).stdout,
    "target",
  );

  const temporaryDirectory = await ports.makeTempDirectory();
  const baseRepository = path.join(temporaryDirectory, "repository");
  let baseMetadata: CargoMetadataSnapshot;
  try {
    await requiredRun(
      ports,
      "git",
      ["clone", "--no-checkout", "--local", repository, baseRepository],
      repository,
    );
    await requiredRun(
      ports,
      "git",
      ["checkout", "--detach", options.baseSha],
      baseRepository,
    );
    const baseWorkspace = path.resolve(baseRepository, workspaceRelativePath);
    baseMetadata = parseCargoMetadata(
      (
        await requiredRun(
          ports,
          "cargo",
          ["metadata", "--format-version", "1", "--no-deps"],
          baseWorkspace,
        )
      ).stdout,
      "base",
    );
  } finally {
    await ports.removeDirectory(temporaryDirectory);
  }

  const packagePlan = deriveReleasePlan({
    baseSha: options.baseSha,
    targetSha: options.targetSha,
    baseMetadata,
    targetMetadata,
    config: packageOnlyConfig(config),
  });
  if (packagePlan.packages.length === 0) {
    throw new Error(
      "release plan is empty; no publishable workspace package version changed",
    );
  }

  try {
    const notes = await loadNotes(
      ports,
      sourceDirectory,
      config,
      baseMetadata,
      targetMetadata,
    );
    return {
      plan: deriveReleasePlan({
        baseSha: options.baseSha,
        targetSha: options.targetSha,
        baseMetadata,
        targetMetadata,
        config,
        ...(notes === undefined ? {} : { notes }),
      }),
    };
  } catch (error: unknown) {
    return {
      plan: packagePlan,
      githubReleaseError: asError(error),
    };
  }
}

export function parseReleasePlanConfig(source: string): ReleasePlanConfig {
  const parsed: unknown = parseYaml(source);
  const root = parsed === null ? {} : requireObject(parsed, "release config");
  rejectUnknownKeys(root, ROOT_KEYS, "release config");

  const config: {
    tagTemplate?: string;
    packageOverrides?: Record<string, { tagTemplate?: string }>;
    githubRelease?: {
      package: string;
      nameTemplate?: string;
      notesFile: string;
      notesHeadingTemplate?: string;
      prerelease?: boolean;
      makeLatest?: "auto" | "true" | "false";
    };
  } = {};

  if (root.tagTemplate !== undefined) {
    config.tagTemplate = requireString(root.tagTemplate, "tagTemplate");
  }

  if (root.packageOverrides !== undefined) {
    const overrides = requireObject(root.packageOverrides, "packageOverrides");
    config.packageOverrides = Object.fromEntries(
      Object.entries(overrides).map(([name, value]) => {
        const override = requireObject(value, `packageOverrides.${name}`);
        rejectUnknownKeys(override, OVERRIDE_KEYS, `packageOverrides.${name}`);
        return [
          name,
          override.tagTemplate === undefined
            ? {}
            : {
                tagTemplate: requireString(
                  override.tagTemplate,
                  `packageOverrides.${name}.tagTemplate`,
                ),
              },
        ];
      }),
    );
  }

  if (root.githubRelease !== undefined) {
    const release = requireObject(root.githubRelease, "githubRelease");
    rejectUnknownKeys(release, GITHUB_RELEASE_KEYS, "githubRelease");
    config.githubRelease = {
      package: requireString(release.package, "githubRelease.package"),
      notesFile: requireString(release.notesFile, "githubRelease.notesFile"),
      ...(release.nameTemplate === undefined
        ? {}
        : {
            nameTemplate: requireString(
              release.nameTemplate,
              "githubRelease.nameTemplate",
            ),
          }),
      ...(release.notesHeadingTemplate === undefined
        ? {}
        : {
            notesHeadingTemplate: requireString(
              release.notesHeadingTemplate,
              "githubRelease.notesHeadingTemplate",
            ),
          }),
      ...(release.prerelease === undefined
        ? {}
        : {
            prerelease: requireBoolean(
              release.prerelease,
              "githubRelease.prerelease",
            ),
          }),
      ...(release.makeLatest === undefined
        ? {}
        : {
            makeLatest: requireMakeLatest(
              release.makeLatest,
              "githubRelease.makeLatest",
            ),
          }),
    };
  }

  return config;
}

export function extractReleaseNotes(
  source: string,
  headingTemplate: string | undefined,
  item: { readonly name: string; readonly version: string },
): string {
  if (headingTemplate === undefined) return requireNotes(source);

  const heading = renderReleaseTemplate(headingTemplate, item);
  const headingLevel = /^(#{1,6})\s/.exec(heading)?.[1]?.length;
  if (headingLevel === undefined) {
    throw new Error(
      "githubRelease.notesHeadingTemplate must be a Markdown heading",
    );
  }

  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const matches = lines
    .map((line, index) => ({ line: line.trimEnd(), index }))
    .filter(({ line }) => {
      if (!line.startsWith(heading)) return false;
      const delimiter = line.at(heading.length);
      return (
        delimiter === undefined || delimiter === "(" || /\s/.test(delimiter)
      );
    });
  if (matches.length === 0) {
    throw new Error(`release notes heading "${heading}" was not found`);
  }
  if (matches.length > 1) {
    throw new Error(`release notes heading "${heading}" is ambiguous`);
  }
  const start = matches[0]!.index;

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const candidateLevel = /^(#{1,6})\s/.exec(lines[index] ?? "")?.[1]?.length;
    if (candidateLevel !== undefined && candidateLevel <= headingLevel) {
      end = index;
      break;
    }
  }

  return requireNotes(lines.slice(start + 1, end).join("\n"));
}

function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function rejectUnknownKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  if (key !== undefined)
    throw new Error(`${label} contains unknown key "${key}"`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function requireMakeLatest(
  value: unknown,
  label: string,
): "auto" | "true" | "false" {
  if (typeof value === "boolean") return value ? "true" : "false";
  return requireEnum(value, ["auto", "true", "false"] as const, label);
}

function requireNotes(source: string): string {
  const notes = source.trim();
  if (notes.length === 0)
    throw new Error("GitHub Release notes must be non-empty");
  return notes;
}

function packageOnlyConfig(config: ReleasePlanConfig): ReleasePlanConfig {
  return {
    ...(config.tagTemplate === undefined
      ? {}
      : { tagTemplate: config.tagTemplate }),
    ...(config.packageOverrides === undefined
      ? {}
      : { packageOverrides: config.packageOverrides }),
  };
}

async function requiredRun(
  ports: WorkspacePlanPorts,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await ports.run(command, args, cwd);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.exitCode}${detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  return result;
}

function requireSupportedCargo(stdout: string): void {
  const version = /^cargo\s+(\d+\.\d+\.\d+)/.exec(stdout.trim())?.[1];
  if (version === undefined || !semverGte(version, "1.90.0")) {
    throw new Error(
      "Cargo 1.90 or newer is required for multi-package publication",
    );
  }
}

function requireRelativePath(
  root: string,
  target: string,
  label: string,
): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be inside the Git repository`);
  }
  return relative;
}

function requireSafeGitPrefix(prefix: string): void {
  if (
    path.isAbsolute(prefix) ||
    prefix === ".." ||
    prefix.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Git workspace prefix must be relative");
  }
}

function resolveWithin(root: string, candidate: string, label: string): string {
  if (path.isAbsolute(candidate)) throw new Error(`${label} must be relative`);
  const resolved = path.resolve(root, candidate);
  requireRelativePath(root, resolved, label);
  return resolved;
}

function parseCargoMetadata(
  source: string,
  label: "base" | "target",
): CargoMetadataSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} Cargo metadata is not valid JSON`, {
      cause: error,
    });
  }
  const metadata = requireObject(parsed, `${label} Cargo metadata`);
  if (typeof metadata.workspace_root !== "string") {
    throw new Error(`${label} Cargo metadata workspace_root must be a string`);
  }
  if (
    !Array.isArray(metadata.workspace_members) ||
    !metadata.workspace_members.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `${label} Cargo metadata workspace_members must be a string array`,
    );
  }
  if (!Array.isArray(metadata.packages)) {
    throw new Error(`${label} Cargo metadata packages must be an array`);
  }
  const packages = metadata.packages.map((value, index) => {
    const item = requireObject(
      value,
      `${label} Cargo metadata package ${index}`,
    );
    for (const key of ["id", "name", "version", "manifest_path"] as const) {
      if (typeof item[key] !== "string") {
        throw new Error(
          `${label} Cargo metadata package ${index}.${key} must be a string`,
        );
      }
    }
    if (
      item.publish !== undefined &&
      item.publish !== null &&
      (!Array.isArray(item.publish) ||
        !item.publish.every((entry) => typeof entry === "string"))
    ) {
      throw new Error(
        `${label} Cargo metadata package ${index}.publish must be a string array or null`,
      );
    }
    return {
      id: item.id as string,
      name: item.name as string,
      version: item.version as string,
      manifest_path: item.manifest_path as string,
      ...(item.publish === undefined ? {} : { publish: item.publish }),
    };
  });
  return {
    workspace_root: metadata.workspace_root,
    workspace_members: metadata.workspace_members,
    packages,
  };
}

async function loadNotes(
  ports: WorkspacePlanPorts,
  sourceDirectory: string,
  config: ReleasePlanConfig,
  baseMetadata: CargoMetadataSnapshot,
  targetMetadata: CargoMetadataSnapshot,
): Promise<string | undefined> {
  const release = config.githubRelease;
  if (release === undefined) return undefined;
  const item = findGithubReleaseCandidate(baseMetadata, targetMetadata, config);
  if (item === undefined) return undefined;
  if (release.notesFile === undefined) {
    throw new Error("githubRelease.notesFile must be configured");
  }
  const notesFile = resolveWithin(
    sourceDirectory,
    release.notesFile,
    "githubRelease.notesFile",
  );
  return extractReleaseNotes(
    await ports.readText(notesFile),
    release.notesHeadingTemplate,
    item,
  );
}
