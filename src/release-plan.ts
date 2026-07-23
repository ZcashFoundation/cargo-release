import path from "node:path";

import { prerelease as semverPrerelease, valid as validSemver } from "semver";

export interface CargoPackageSnapshot {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly manifest_path: string;
  readonly publish?: readonly string[] | null;
}

export interface CargoMetadataSnapshot {
  readonly workspace_root: string;
  readonly workspace_members: readonly string[];
  readonly packages: readonly CargoPackageSnapshot[];
}

export interface PackageOverride {
  readonly tagTemplate?: string;
}

export interface GithubReleaseConfig {
  readonly package: string;
  readonly nameTemplate?: string;
  readonly notesFile?: string;
  readonly notesHeadingTemplate?: string;
  readonly prerelease?: boolean;
  readonly makeLatest?: "auto" | "true" | "false";
}

export interface ReleasePlanConfig {
  readonly tagTemplate?: string;
  readonly packageOverrides?: Readonly<Record<string, PackageOverride>>;
  readonly githubRelease?: GithubReleaseConfig;
}

export interface ReleasePackage {
  readonly name: string;
  readonly version: string;
  readonly manifestPath: string;
  readonly tag: string;
}

export interface GithubRelease {
  readonly tag: string;
  readonly name: string;
  readonly notes: string;
  readonly prerelease: boolean;
  readonly makeLatest: "auto" | "true" | "false";
}

export interface ReleasePlan {
  readonly schemaVersion: 1;
  readonly source: {
    readonly baseSha: string;
    readonly targetSha: string;
  };
  readonly packages: readonly ReleasePackage[];
  readonly githubRelease?: GithubRelease;
}

export interface DeriveReleasePlanOptions {
  readonly baseSha: string;
  readonly targetSha: string;
  readonly baseMetadata: CargoMetadataSnapshot;
  readonly targetMetadata: CargoMetadataSnapshot;
  readonly config: ReleasePlanConfig;
  readonly notes?: string;
}

const DEFAULT_TAG_TEMPLATE = "{name}-v{version}";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const FORBIDDEN_REF_CHARACTERS = new Set([
  "~",
  "^",
  ":",
  "?",
  "*",
  "[",
  "]",
  "\\",
]);

export function deriveReleasePlan({
  baseSha,
  targetSha,
  baseMetadata,
  targetMetadata,
  config,
  notes,
}: DeriveReleasePlanOptions): ReleasePlan {
  validateSource(baseSha, targetSha);

  const baseWorkspacePackages = getWorkspacePackages(baseMetadata, "base");
  const targetWorkspacePackages = getWorkspacePackages(
    targetMetadata,
    "target",
  );
  validatePackageOverrides(config, targetWorkspacePackages);
  validateGithubReleaseConfig(config, targetWorkspacePackages);
  const baseVersions = new Map(
    baseWorkspacePackages.map((item) => [item.name, item.version]),
  );

  const packages = targetWorkspacePackages
    .filter(
      (item) =>
        item.publish === null ||
        item.publish === undefined ||
        item.publish.includes("crates-io"),
    )
    .filter((item) => baseVersions.get(item.name) !== item.version)
    .map((item): ReleasePackage => ({
      name: item.name,
      version: item.version,
      manifestPath: relativeManifestPath(targetMetadata, item, "target"),
      tag: renderTemplate(
        config.packageOverrides?.[item.name]?.tagTemplate ??
          config.tagTemplate ??
          DEFAULT_TAG_TEMPLATE,
        item,
      ),
    }))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  validateUniqueTags(packages);

  const githubRelease = deriveGithubRelease(packages, config, notes);

  return {
    schemaVersion: 1,
    source: {
      baseSha: baseSha.toLowerCase(),
      targetSha: targetSha.toLowerCase(),
    },
    packages,
    ...(githubRelease === undefined ? {} : { githubRelease }),
  };
}

function validateUniqueTags(packages: readonly ReleasePackage[]): void {
  const tags = new Set<string>();
  for (const item of packages) {
    validateTag(item.tag);
    if (tags.has(item.tag)) {
      throw new Error(`release plan contains duplicate tag "${item.tag}"`);
    }
    tags.add(item.tag);
  }
}

function validatePackageOverrides(
  config: ReleasePlanConfig,
  packages: readonly CargoPackageSnapshot[],
): void {
  const names = new Set(packages.map((item) => item.name));
  for (const name of Object.keys(config.packageOverrides ?? {})) {
    if (!names.has(name)) {
      throw new Error(
        `package override "${name}" does not identify a target workspace package`,
      );
    }
  }
}

function validateGithubReleaseConfig(
  config: ReleasePlanConfig,
  packages: readonly CargoPackageSnapshot[],
): void {
  const name = config.githubRelease?.package;
  if (name !== undefined && !packages.some((item) => item.name === name)) {
    throw new Error(
      `GitHub Release package "${name}" is not in the target workspace`,
    );
  }
}

function validateTag(tag: string): void {
  const components = tag.split("/");
  const invalid =
    tag.length === 0 ||
    tag === "@" ||
    tag.startsWith("/") ||
    tag.endsWith("/") ||
    tag.endsWith(".") ||
    tag.includes("..") ||
    tag.includes("@{") ||
    [...tag].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 32 ||
        codePoint === 127 ||
        FORBIDDEN_REF_CHARACTERS.has(character)
      );
    }) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".lock"),
    );
  if (invalid)
    throw new Error(`release plan contains invalid Git tag "${tag}"`);
}

function deriveGithubRelease(
  packages: readonly ReleasePackage[],
  config: ReleasePlanConfig,
  notes: string | undefined,
): GithubRelease | undefined {
  if (config.githubRelease === undefined) {
    return undefined;
  }
  const item = packages.find(
    (candidate) => candidate.name === config.githubRelease?.package,
  );
  if (item === undefined) return undefined;
  if (notes === undefined || notes.trim().length === 0) {
    throw new Error("GitHub Release notes must be supplied and non-empty");
  }
  const prerelease =
    config.githubRelease.prerelease ?? semverPrerelease(item.version) !== null;
  const makeLatest = config.githubRelease.makeLatest ?? "auto";
  if (prerelease && makeLatest === "true") {
    throw new Error(
      'githubRelease.makeLatest cannot be "true" for a prerelease',
    );
  }

  return {
    tag: item.tag,
    name: renderTemplate(
      config.githubRelease.nameTemplate ?? "{name} {version}",
      item,
    ),
    notes,
    prerelease,
    makeLatest,
  };
}

function getWorkspacePackages(
  metadata: CargoMetadataSnapshot,
  label: "base" | "target",
): readonly CargoPackageSnapshot[] {
  validateWorkspaceRoot(metadata.workspace_root, label);
  const packagesById = new Map<string, CargoPackageSnapshot>();
  for (const item of metadata.packages) {
    if (packagesById.has(item.id)) {
      throw new Error(
        `${label} metadata contains duplicate package id "${item.id}"`,
      );
    }
    packagesById.set(item.id, item);
  }

  const names = new Set<string>();
  const manifestPaths = new Set<string>();
  return metadata.workspace_members.map((id) => {
    const item = packagesById.get(id);
    if (item === undefined) {
      throw new Error(
        `${label} workspace member "${id}" does not identify a package`,
      );
    }
    validatePackage(item, label);
    const manifestPath = relativeManifestPath(metadata, item, label);
    if (names.has(item.name)) {
      throw new Error(
        `${label} metadata contains duplicate package name "${item.name}"`,
      );
    }
    if (manifestPaths.has(manifestPath)) {
      throw new Error(
        `${label} metadata contains duplicate manifest path "${manifestPath}"`,
      );
    }
    names.add(item.name);
    manifestPaths.add(manifestPath);
    return item;
  });
}

function validateWorkspaceRoot(
  workspaceRoot: string,
  label: "base" | "target",
): void {
  const pathApi = pathApiFor(workspaceRoot);
  if (!pathApi.isAbsolute(workspaceRoot)) {
    throw new Error(`${label} workspace_root must be an absolute path`);
  }
}

function relativeManifestPath(
  metadata: CargoMetadataSnapshot,
  item: CargoPackageSnapshot,
  label: "base" | "target",
): string {
  const pathApi = pathApiFor(metadata.workspace_root);
  if (!pathApi.isAbsolute(item.manifest_path)) {
    throw new Error(
      `${label} package "${item.name}" manifest_path must be absolute`,
    );
  }
  if (pathApi.basename(item.manifest_path) !== "Cargo.toml") {
    throw new Error(
      `${label} package "${item.name}" manifest_path must end with Cargo.toml`,
    );
  }

  const relative = pathApi.relative(
    metadata.workspace_root,
    item.manifest_path,
  );
  if (
    relative === ".." ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative)
  ) {
    throw new Error(
      `${label} package "${item.name}" manifest_path must be inside workspace_root`,
    );
  }
  return relative.split(pathApi.sep).join("/");
}

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)
    ? path.win32
    : path.posix;
}

function validatePackage(
  item: CargoPackageSnapshot,
  label: "base" | "target",
): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.name)) {
    throw new Error(`${label} package has invalid name "${item.name}"`);
  }
  if (validSemver(item.version) === null) {
    throw new Error(
      `${label} package "${item.name}" has invalid version "${item.version}"`,
    );
  }
}

function validateSource(baseSha: string, targetSha: string): void {
  if (!FULL_COMMIT_SHA.test(baseSha)) {
    throw new Error("baseSha must be a full 40-character commit SHA");
  }
  if (!FULL_COMMIT_SHA.test(targetSha)) {
    throw new Error("targetSha must be a full 40-character commit SHA");
  }
  if (baseSha.toLowerCase() === targetSha.toLowerCase()) {
    throw new Error("baseSha and targetSha must identify different commits");
  }
}

function renderTemplate(
  template: string,
  item: Pick<CargoPackageSnapshot, "name" | "version">,
): string {
  const rendered = template
    .replaceAll("{name}", item.name)
    .replaceAll("{version}", item.version);
  const unsupported = /\{[^{}]+\}/.exec(rendered)?.[0];
  if (unsupported !== undefined) {
    throw new Error(
      `template contains unsupported placeholder "${unsupported}"`,
    );
  }
  return rendered;
}
