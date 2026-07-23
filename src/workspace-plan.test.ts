import { describe, expect, it } from "vitest";

import {
  extractReleaseNotes,
  loadReleasePlan,
  parseReleasePlanConfig,
  type CommandResult,
  type WorkspacePlanPorts,
} from "./workspace-plan.js";

const BASE_SHA = "1111111111111111111111111111111111111111";
const TARGET_SHA = "2222222222222222222222222222222222222222";

describe("parseReleasePlanConfig", () => {
  it("parses the portable release policy and rejects unknown keys", () => {
    expect(
      parseReleasePlanConfig(`
tagTemplate: "{name}-v{version}"
packageOverrides:
  zebrad:
    tagTemplate: "v{version}"
githubRelease:
  package: zebrad
  nameTemplate: "Zebra {version}"
  notesFile: CHANGELOG.md
  notesHeadingTemplate: "## [Zebra {version}]"
  makeLatest: auto
`),
    ).toEqual({
      tagTemplate: "{name}-v{version}",
      packageOverrides: { zebrad: { tagTemplate: "v{version}" } },
      githubRelease: {
        package: "zebrad",
        nameTemplate: "Zebra {version}",
        notesFile: "CHANGELOG.md",
        notesHeadingTemplate: "## [Zebra {version}]",
        makeLatest: "auto",
      },
    });

    expect(() => parseReleasePlanConfig("dependencySolver: custom\n")).toThrow(
      'release config contains unknown key "dependencySolver"',
    );
  });

  it("requires a notes file when a GitHub Release is configured", () => {
    expect(() =>
      parseReleasePlanConfig("githubRelease:\n  package: zebrad\n"),
    ).toThrow("githubRelease.notesFile must be a non-empty string");
  });

  it.each([
    ["true", "true"],
    ["false", "false"],
    ["auto", "auto"],
  ] as const)("normalizes makeLatest: %s to %s", (source, expected) => {
    expect(
      parseReleasePlanConfig(`
githubRelease:
  package: zebrad
  notesFile: CHANGELOG.md
  makeLatest: ${source}
`),
    ).toMatchObject({
      githubRelease: { makeLatest: expected },
    });
  });
});

describe("extractReleaseNotes", () => {
  it("extracts one Markdown section without consuming the next release", () => {
    const changelog = `# Changelog

## [Zebra 6.2.1]

Fixed publishing.

### Security

No changes.

## [Zebra 6.2.0]

Older notes.
`;

    expect(
      extractReleaseNotes(changelog, "## [Zebra {version}]", {
        name: "zebrad",
        version: "6.2.1",
      }),
    ).toBe("Fixed publishing.\n\n### Security\n\nNo changes.");
  });

  it("allows a release heading link and date after the stable configured prefix", () => {
    const changelog = `# Changelog

## [Zebra 6.2.1](https://example.invalid/v6.2.1) - 2026-07-22

Recovered publication.

## [Zebra 6.2.0](https://example.invalid/v6.2.0) - 2026-07-17
`;

    expect(
      extractReleaseNotes(changelog, "## [Zebra {version}]", {
        name: "zebrad",
        version: "6.2.1",
      }),
    ).toBe("Recovered publication.");
  });

  it("fails when the exact release heading is absent", () => {
    expect(() =>
      extractReleaseNotes("# Changelog\n", "## {name} {version}", {
        name: "zebrad",
        version: "6.2.1",
      }),
    ).toThrow('release notes heading "## zebrad 6.2.1" was not found');
  });

  it("rejects unsupported placeholders in a notes heading template", () => {
    expect(() =>
      extractReleaseNotes("# Changelog\n", "## {versoin}", {
        name: "zebrad",
        version: "6.2.1",
      }),
    ).toThrow('template contains unsupported placeholder "{versoin}"');
  });
});

describe("loadReleasePlan", () => {
  it.each([
    ["abc123", TARGET_SHA, "baseSha must be a full 40-character commit SHA"],
    [BASE_SHA, "abc123", "targetSha must be a full 40-character commit SHA"],
    [
      BASE_SHA,
      BASE_SHA,
      "baseSha and targetSha must identify different commits",
    ],
  ])(
    "rejects an invalid release source before using any port",
    async (baseSha, targetSha, message) => {
      const calls: string[] = [];
      const ports: WorkspacePlanPorts = {
        async run() {
          calls.push("run");
          return ok("");
        },
        async readText() {
          calls.push("readText");
          return "";
        },
        async makeTempDirectory() {
          calls.push("makeTempDirectory");
          return "/tmp/reconcile/base";
        },
        async removeDirectory() {
          calls.push("removeDirectory");
        },
      };

      await expect(
        loadReleasePlan(
          {
            controllerDirectory: "/repo",
            sourceDirectory: "/repo",
            baseSha,
            targetSha,
            configPath: "release.yml",
          },
          ports,
        ),
      ).rejects.toThrow(message);
      expect(calls).toEqual([]);
    },
  );

  it("derives a plan from clean target and isolated base snapshots", async () => {
    const calls: string[] = [];
    const targetMetadata = metadata("/repo/workspace", "2.0.0");
    const baseMetadata = metadata(
      "/tmp/reconcile/base/repository/workspace",
      "1.0.0",
    );
    const responses = new Map<string, CommandResult>([
      [
        "cargo --version @ /repo/workspace",
        ok("cargo 1.91.0 (ea2d97820 2025-10-10)\n"),
      ],
      ["git rev-parse --show-toplevel @ /repo/workspace", ok("/repo\n")],
      ["git rev-parse --show-prefix @ /repo/workspace", ok("workspace/\n")],
      ["git rev-parse HEAD @ /repo", ok(`${TARGET_SHA}\n`)],
      ["git status --porcelain --untracked-files=all @ /repo", ok("")],
      [`git cat-file -e ${BASE_SHA}^{commit} @ /repo`, ok("")],
      [
        `git merge-base --is-ancestor ${BASE_SHA} ${TARGET_SHA} @ /repo`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /repo/workspace",
        ok(JSON.stringify(targetMetadata)),
      ],
      [
        "git clone --no-checkout --local /repo /tmp/reconcile/base/repository @ /repo",
        ok(""),
      ],
      [
        `git checkout --detach ${BASE_SHA} @ /tmp/reconcile/base/repository`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /tmp/reconcile/base/repository/workspace",
        ok(JSON.stringify(baseMetadata)),
      ],
    ]);
    let removed = "";
    const ports: WorkspacePlanPorts = {
      async run(command, args, cwd) {
        const key = `${command} ${args.join(" ")} @ ${cwd}`;
        calls.push(key);
        const response = responses.get(key);
        if (response === undefined)
          throw new Error(`unexpected command: ${key}`);
        return response;
      },
      async readText(file) {
        if (file === "/repo/controller/release.yml") {
          return "githubRelease:\n  package: example\n  notesFile: CHANGELOG.md\n";
        }
        if (file === "/repo/workspace/CHANGELOG.md") return "Release notes.\n";
        throw new Error(`unexpected file: ${file}`);
      },
      async makeTempDirectory() {
        return "/tmp/reconcile/base";
      },
      async removeDirectory(directory) {
        removed = directory;
      },
    };

    await expect(
      loadReleasePlan(
        {
          controllerDirectory: "/repo/controller",
          sourceDirectory: "/repo/workspace",
          baseSha: BASE_SHA,
          targetSha: TARGET_SHA,
          configPath: "release.yml",
        },
        ports,
      ),
    ).resolves.toMatchObject({
      plan: {
        source: { baseSha: BASE_SHA, targetSha: TARGET_SHA },
        packages: [{ name: "example", version: "2.0.0" }],
        githubRelease: { notes: "Release notes." },
      },
    });
    expect(removed).toBe("/tmp/reconcile/base");
    expect(calls).toContain(
      `git checkout --detach ${BASE_SHA} @ /tmp/reconcile/base/repository`,
    );
  });

  it("retains the package plan when GitHub Release notes are invalid", async () => {
    const targetMetadata = metadata("/repo", "2.0.0");
    const baseMetadata = metadata("/tmp/reconcile/base/repository", "1.0.0");
    const responses = new Map<string, CommandResult>([
      ["cargo --version @ /repo", ok("cargo 1.91.0\n")],
      ["git rev-parse --show-toplevel @ /repo", ok("/repo\n")],
      ["git rev-parse --show-prefix @ /repo", ok("")],
      ["git rev-parse HEAD @ /repo", ok(`${TARGET_SHA}\n`)],
      ["git status --porcelain --untracked-files=all @ /repo", ok("")],
      [`git cat-file -e ${BASE_SHA}^{commit} @ /repo`, ok("")],
      [
        `git merge-base --is-ancestor ${BASE_SHA} ${TARGET_SHA} @ /repo`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /repo",
        ok(JSON.stringify(targetMetadata)),
      ],
      [
        "git clone --no-checkout --local /repo /tmp/reconcile/base/repository @ /repo",
        ok(""),
      ],
      [
        `git checkout --detach ${BASE_SHA} @ /tmp/reconcile/base/repository`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /tmp/reconcile/base/repository",
        ok(JSON.stringify(baseMetadata)),
      ],
    ]);
    const ports: WorkspacePlanPorts = {
      async run(command, args, cwd) {
        const key = `${command} ${args.join(" ")} @ ${cwd}`;
        const response = responses.get(key);
        if (response === undefined)
          throw new Error(`unexpected command: ${key}`);
        return response;
      },
      async readText(file) {
        if (file === "/repo/release.yml") {
          return [
            "githubRelease:",
            "  package: example",
            "  notesFile: CHANGELOG.md",
            '  notesHeadingTemplate: "## example {version}"',
          ].join("\n");
        }
        if (file === "/repo/CHANGELOG.md") return "# Changelog\n";
        throw new Error(`unexpected file: ${file}`);
      },
      async makeTempDirectory() {
        return "/tmp/reconcile/base";
      },
      async removeDirectory() {},
    };

    const result = await loadReleasePlan(
      {
        controllerDirectory: "/repo",
        sourceDirectory: "/repo",
        baseSha: BASE_SHA,
        targetSha: TARGET_SHA,
        configPath: "release.yml",
      },
      ports,
    );
    expect(result.plan).toEqual({
      schemaVersion: 1,
      source: { baseSha: BASE_SHA, targetSha: TARGET_SHA },
      packages: [
        {
          name: "example",
          version: "2.0.0",
          manifestPath: "Cargo.toml",
          tag: "example-v2.0.0",
        },
      ],
    });
    expect(result.githubReleaseError?.message).toBe(
      'release notes heading "## example 2.0.0" was not found',
    );
  });

  it("refuses a dirty or wrong target checkout before Cargo metadata", async () => {
    const commands: string[] = [];
    const ports: WorkspacePlanPorts = {
      async run(command, args, cwd) {
        const key = `${command} ${args.join(" ")} @ ${cwd}`;
        commands.push(key);
        if (command === "cargo") return ok("cargo 1.91.0\n");
        if (args.join(" ") === "rev-parse --show-toplevel")
          return ok("/repo\n");
        if (args.join(" ") === "rev-parse --show-prefix") return ok("");
        if (args.join(" ") === "rev-parse HEAD") return ok(`${TARGET_SHA}\n`);
        if (args[0] === "status") return ok(" M Cargo.toml\n");
        throw new Error(`unexpected command: ${key}`);
      },
      async readText() {
        throw new Error("must not read files");
      },
      async makeTempDirectory() {
        throw new Error("must not create temp directory");
      },
      async removeDirectory() {},
    };

    await expect(
      loadReleasePlan(
        {
          controllerDirectory: "/repo",
          sourceDirectory: "/repo",
          baseSha: BASE_SHA,
          targetSha: TARGET_SHA,
          configPath: "release.yml",
        },
        ports,
      ),
    ).rejects.toThrow("source checkout must be clean");
    expect(
      commands.some((command) => command.startsWith("cargo metadata")),
    ).toBe(false);
  });

  it("requires Cargo 1.90 or newer", async () => {
    const ports: WorkspacePlanPorts = {
      async run() {
        return ok("cargo 1.89.0\n");
      },
      async readText() {
        throw new Error("must not read files");
      },
      async makeTempDirectory() {
        throw new Error("must not create temp directory");
      },
      async removeDirectory() {},
    };

    await expect(
      loadReleasePlan(
        {
          controllerDirectory: "/repo",
          sourceDirectory: "/repo",
          baseSha: BASE_SHA,
          targetSha: TARGET_SHA,
          configPath: "release.yml",
        },
        ports,
      ),
    ).rejects.toThrow("Cargo 1.90 or newer is required");
  });

  it("refuses a base commit outside the target history", async () => {
    const ports: WorkspacePlanPorts = {
      async run(command, args) {
        const operation = `${command} ${args.join(" ")}`;
        if (operation === "cargo --version") return ok("cargo 1.91.0\n");
        if (operation === "git rev-parse --show-toplevel") return ok("/repo\n");
        if (operation === "git rev-parse --show-prefix") return ok("");
        if (operation === "git rev-parse HEAD") return ok(`${TARGET_SHA}\n`);
        if (operation === "git status --porcelain --untracked-files=all")
          return ok("");
        if (operation === `git cat-file -e ${BASE_SHA}^{commit}`) return ok("");
        if (
          operation === `git merge-base --is-ancestor ${BASE_SHA} ${TARGET_SHA}`
        ) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${operation}`);
      },
      async readText() {
        throw new Error("must not read files");
      },
      async makeTempDirectory() {
        throw new Error("must not create temp directory");
      },
      async removeDirectory() {},
    };

    await expect(
      loadReleasePlan(
        {
          controllerDirectory: "/repo",
          sourceDirectory: "/repo",
          baseSha: BASE_SHA,
          targetSha: TARGET_SHA,
          configPath: "release.yml",
        },
        ports,
      ),
    ).rejects.toThrow(
      `base SHA ${BASE_SHA} must be an ancestor of target SHA ${TARGET_SHA}`,
    );
  });

  it("does not read product notes for a library-only release", async () => {
    const targetMetadata = workspaceMetadata("/repo", {
      "example-cli": "2.0.0",
      "example-library": "1.1.0",
    });
    const baseMetadata = workspaceMetadata("/tmp/reconcile/base/repository", {
      "example-cli": "2.0.0",
      "example-library": "1.0.0",
    });
    const responses = new Map<string, CommandResult>([
      ["cargo --version @ /repo", ok("cargo 1.91.0\n")],
      ["git rev-parse --show-toplevel @ /repo", ok("/repo\n")],
      ["git rev-parse --show-prefix @ /repo", ok("")],
      ["git rev-parse HEAD @ /repo", ok(`${TARGET_SHA}\n`)],
      ["git status --porcelain --untracked-files=all @ /repo", ok("")],
      [`git cat-file -e ${BASE_SHA}^{commit} @ /repo`, ok("")],
      [
        `git merge-base --is-ancestor ${BASE_SHA} ${TARGET_SHA} @ /repo`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /repo",
        ok(JSON.stringify(targetMetadata)),
      ],
      [
        "git clone --no-checkout --local /repo /tmp/reconcile/base/repository @ /repo",
        ok(""),
      ],
      [
        `git checkout --detach ${BASE_SHA} @ /tmp/reconcile/base/repository`,
        ok(""),
      ],
      [
        "cargo metadata --format-version 1 --no-deps @ /tmp/reconcile/base/repository",
        ok(JSON.stringify(baseMetadata)),
      ],
    ]);
    const readFiles: string[] = [];
    const ports: WorkspacePlanPorts = {
      async run(command, args, cwd) {
        const key = `${command} ${args.join(" ")} @ ${cwd}`;
        const response = responses.get(key);
        if (response === undefined)
          throw new Error(`unexpected command: ${key}`);
        return response;
      },
      async readText(file) {
        readFiles.push(file);
        if (file === "/repo/release.yml") {
          return [
            "githubRelease:",
            "  package: example-cli",
            "  notesFile: CHANGELOG.md",
          ].join("\n");
        }
        throw new Error(`unexpected file: ${file}`);
      },
      async makeTempDirectory() {
        return "/tmp/reconcile/base";
      },
      async removeDirectory() {},
    };

    const { plan } = await loadReleasePlan(
      {
        controllerDirectory: "/repo",
        sourceDirectory: "/repo",
        baseSha: BASE_SHA,
        targetSha: TARGET_SHA,
        configPath: "release.yml",
      },
      ports,
    );
    expect(plan).toMatchObject({
      packages: [{ name: "example-library", version: "1.1.0" }],
    });
    expect(plan.githubRelease).toBeUndefined();
    expect(readFiles).toEqual(["/repo/release.yml"]);
  });
});

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function metadata(root: string, version: string) {
  return {
    workspace_root: root,
    workspace_members: [`example ${version} (path+file://${root})`],
    packages: [
      {
        id: `example ${version} (path+file://${root})`,
        name: "example",
        version,
        manifest_path: `${root}/Cargo.toml`,
      },
    ],
  };
}

function workspaceMetadata(
  root: string,
  versions: Readonly<Record<string, string>>,
) {
  const packages = Object.entries(versions).map(([name, version]) => ({
    id: `${name} ${version} (path+file://${root}/${name})`,
    name,
    version,
    manifest_path: `${root}/${name}/Cargo.toml`,
  }));
  return {
    workspace_root: root,
    workspace_members: packages.map((item) => item.id),
    packages,
  };
}
