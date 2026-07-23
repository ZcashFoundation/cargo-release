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
});

describe("loadReleasePlan", () => {
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
      source: { baseSha: BASE_SHA, targetSha: TARGET_SHA },
      packages: [{ name: "example", version: "2.0.0" }],
      githubRelease: { notes: "Release notes." },
    });
    expect(removed).toBe("/tmp/reconcile/base");
    expect(calls).toContain(
      `git checkout --detach ${BASE_SHA} @ /tmp/reconcile/base/repository`,
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
