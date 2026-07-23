import { describe, expect, test } from "vitest";

import {
  deriveReleasePlan,
  type CargoMetadataSnapshot,
} from "./release-plan.js";

const baseSha = "1".repeat(40);
const targetSha = "2".repeat(40);

function metadata(
  root: string,
  packages: CargoMetadataSnapshot["packages"],
  workspaceMembers = packages.map((item) => item.id),
): CargoMetadataSnapshot {
  return {
    workspace_root: root,
    workspace_members: workspaceMembers,
    packages,
  };
}

function cargoPackage(
  root: string,
  name: string,
  version: string,
  publish: readonly string[] | null = null,
) {
  return {
    id: `${name} ${version} (path+file://${root}/${name})`,
    name,
    version,
    manifest_path: `${root}/${name}/Cargo.toml`,
    publish,
  };
}

describe("deriveReleasePlan", () => {
  test("selects changed and new publishable target workspace packages", () => {
    const baseRoot = "/checkouts/base";
    const targetRoot = "/checkouts/target";
    const unchanged = cargoPackage(baseRoot, "unchanged", "1.0.0");
    const changed = cargoPackage(baseRoot, "changed", "1.0.0");
    const targetUnchanged = cargoPackage(targetRoot, "unchanged", "1.0.0");
    const targetChanged = cargoPackage(targetRoot, "changed", "1.1.0");
    const newPackage = cargoPackage(targetRoot, "new-package", "0.1.0");
    const privatePackage = cargoPackage(targetRoot, "private", "1.0.0", []);
    const dependency = cargoPackage(targetRoot, "dependency", "1.0.0");

    const plan = deriveReleasePlan({
      baseSha,
      targetSha,
      baseMetadata: metadata(baseRoot, [unchanged, changed]),
      targetMetadata: metadata(
        targetRoot,
        [
          targetUnchanged,
          targetChanged,
          newPackage,
          privatePackage,
          dependency,
        ],
        [
          targetUnchanged.id,
          targetChanged.id,
          newPackage.id,
          privatePackage.id,
        ],
      ),
      config: {},
    });

    expect(plan).toEqual({
      schemaVersion: 1,
      source: { baseSha, targetSha },
      packages: [
        {
          name: "changed",
          version: "1.1.0",
          manifestPath: "changed/Cargo.toml",
          tag: "changed-v1.1.0",
        },
        {
          name: "new-package",
          version: "0.1.0",
          manifestPath: "new-package/Cargo.toml",
          tag: "new-package-v0.1.0",
        },
      ],
    });
  });

  test("rejects source revisions that are not distinct full commit SHAs", () => {
    const root = "/checkouts/target";
    const snapshot = metadata(root, []);

    expect(() =>
      deriveReleasePlan({
        baseSha: "abc123",
        targetSha,
        baseMetadata: snapshot,
        targetMetadata: snapshot,
        config: {},
      }),
    ).toThrow("baseSha must be a full 40-character commit SHA");

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha: baseSha,
        baseMetadata: snapshot,
        targetMetadata: snapshot,
        config: {},
      }),
    ).toThrow("baseSha and targetSha must identify different commits");
  });

  test("normalizes commit SHAs used for external provenance checks", () => {
    const root = "/checkouts/target";
    const item = cargoPackage(root, "example", "1.0.0");

    const plan = deriveReleasePlan({
      baseSha: "A".repeat(40),
      targetSha: "B".repeat(40),
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [item]),
      config: {},
    });

    expect(plan.source).toEqual({
      baseSha: "a".repeat(40),
      targetSha: "b".repeat(40),
    });
  });

  test("rejects ambiguous workspace package identities", () => {
    const root = "/checkouts/target";
    const first = cargoPackage(root, "duplicate", "1.0.0");
    const second = {
      ...cargoPackage(root, "duplicate", "2.0.0"),
      id: "duplicate 2.0.0 (path+file:///checkouts/target/other)",
      manifest_path: `${root}/other/Cargo.toml`,
    };

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [first, second]),
        config: {},
      }),
    ).toThrow('target metadata contains duplicate package name "duplicate"');
  });

  test("validates workspace package names and versions", () => {
    const root = "/checkouts/target";
    const invalidName = cargoPackage(root, "bad name", "1.0.0");

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [invalidName]),
        config: {},
      }),
    ).toThrow('target package has invalid name "bad name"');

    const invalidVersion = cargoPackage(root, "example", "1.2");
    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [invalidVersion]),
        config: {},
      }),
    ).toThrow('target package "example" has invalid version "1.2"');
  });

  test("requires absolute Cargo.toml paths inside each workspace", () => {
    const root = "/checkouts/target";
    const outside = {
      ...cargoPackage(root, "example", "1.0.0"),
      manifest_path: "/checkouts/other/example/Cargo.toml",
    };

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [outside]),
        config: {},
      }),
    ).toThrow(
      'target package "example" manifest_path must be inside workspace_root',
    );

    const notManifest = {
      ...cargoPackage(root, "example", "1.0.0"),
      manifest_path: `${root}/example/package.toml`,
    };
    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [notManifest]),
        config: {},
      }),
    ).toThrow(
      'target package "example" manifest_path must end with Cargo.toml',
    );
  });

  test("applies the default tag template and package-specific overrides", () => {
    const root = "/checkouts/target";
    const beta = cargoPackage(root, "beta", "2.0.0");
    const alpha = cargoPackage(root, "alpha", "1.0.0");

    const plan = deriveReleasePlan({
      baseSha,
      targetSha,
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [beta, alpha]),
      config: {
        tagTemplate: "release/{name}/{version}",
        packageOverrides: {
          beta: { tagTemplate: "beta-v{version}" },
        },
      },
    });

    expect(plan.packages.map(({ name, tag }) => ({ name, tag }))).toEqual([
      { name: "alpha", tag: "release/alpha/1.0.0" },
      { name: "beta", tag: "beta-v2.0.0" },
    ]);
  });

  test("derives one GitHub Release descriptor and infers prereleases", () => {
    const root = "/checkouts/target";
    const cli = cargoPackage(root, "example-cli", "2.0.0-rc.1");

    const plan = deriveReleasePlan({
      baseSha,
      targetSha,
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [cli]),
      config: {
        githubRelease: {
          package: "example-cli",
          nameTemplate: "Example CLI {version}",
        },
      },
      notes: "## Changes\n\n- First candidate\n",
    });

    expect(plan.githubRelease).toEqual({
      tag: "example-cli-v2.0.0-rc.1",
      name: "Example CLI 2.0.0-rc.1",
      notes: "## Changes\n\n- First candidate\n",
      prerelease: true,
      makeLatest: "auto",
    });
  });

  test("omits the GitHub Release for a library-only release", () => {
    const baseRoot = "/checkouts/base";
    const targetRoot = "/checkouts/target";
    const baseCli = cargoPackage(baseRoot, "example-cli", "2.0.0");
    const baseLibrary = cargoPackage(baseRoot, "example-library", "1.0.0");
    const targetCli = cargoPackage(targetRoot, "example-cli", "2.0.0");
    const targetLibrary = cargoPackage(targetRoot, "example-library", "1.1.0");

    const plan = deriveReleasePlan({
      baseSha,
      targetSha,
      baseMetadata: metadata(baseRoot, [baseCli, baseLibrary]),
      targetMetadata: metadata(targetRoot, [targetCli, targetLibrary]),
      config: { githubRelease: { package: "example-cli" } },
    });

    expect(plan.packages.map((item) => item.name)).toEqual(["example-library"]);
    expect(plan.githubRelease).toBeUndefined();
  });

  test("rejects a GitHub Release package outside the target workspace", () => {
    const root = "/checkouts/target";
    const item = cargoPackage(root, "example", "1.0.0");

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [item]),
        config: { githubRelease: { package: "typo" } },
      }),
    ).toThrow('GitHub Release package "typo" is not in the target workspace');
  });

  test("requires non-empty notes for the configured GitHub Release package", () => {
    const root = "/checkouts/target";
    const cli = cargoPackage(root, "example-cli", "2.0.0");
    const options = {
      baseSha,
      targetSha,
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [cli]),
      config: { githubRelease: { package: "example-cli" } },
    } as const;

    expect(() => deriveReleasePlan(options)).toThrow(
      "GitHub Release notes must be supplied and non-empty",
    );
    expect(() => deriveReleasePlan({ ...options, notes: "   " })).toThrow(
      "GitHub Release notes must be supplied and non-empty",
    );
  });

  test("rejects making a prerelease the latest release", () => {
    const root = "/checkouts/target";
    const cli = cargoPackage(root, "example-cli", "2.0.0-rc.1");

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [cli]),
        config: {
          githubRelease: {
            package: "example-cli",
            makeLatest: "true",
          },
        },
        notes: "Release candidate",
      }),
    ).toThrow('githubRelease.makeLatest cannot be "true" for a prerelease');
  });

  test("rejects duplicate rendered tags", () => {
    const root = "/checkouts/target";

    expect(() =>
      deriveReleasePlan({
        baseSha,
        targetSha,
        baseMetadata: metadata("/checkouts/base", []),
        targetMetadata: metadata(root, [
          cargoPackage(root, "alpha", "1.0.0"),
          cargoPackage(root, "beta", "1.0.0"),
        ]),
        config: { tagTemplate: "v{version}" },
      }),
    ).toThrow('release plan contains duplicate tag "v1.0.0"');
  });

  test("only selects packages publishable to crates.io", () => {
    const root = "/checkouts/target";
    const cratesIo = cargoPackage(root, "crates-io-package", "1.0.0", [
      "crates-io",
    ]);
    const anotherRegistry = cargoPackage(root, "internal-package", "1.0.0", [
      "internal",
    ]);

    const plan = deriveReleasePlan({
      baseSha,
      targetSha,
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [cratesIo, anotherRegistry]),
      config: {},
    });

    expect(plan.packages.map((item) => item.name)).toEqual([
      "crates-io-package",
    ]);
  });

  test("rejects unknown package overrides and invalid rendered tags", () => {
    const root = "/checkouts/target";
    const item = cargoPackage(root, "example", "1.0.0");
    const options = {
      baseSha,
      targetSha,
      baseMetadata: metadata("/checkouts/base", []),
      targetMetadata: metadata(root, [item]),
    };

    expect(() =>
      deriveReleasePlan({
        ...options,
        config: { packageOverrides: { typo: { tagTemplate: "v{version}" } } },
      }),
    ).toThrow(
      'package override "typo" does not identify a target workspace package',
    );

    expect(() =>
      deriveReleasePlan({
        ...options,
        config: { tagTemplate: "release {version}" },
      }),
    ).toThrow('release plan contains invalid Git tag "release 1.0.0"');

    expect(() =>
      deriveReleasePlan({
        ...options,
        config: { tagTemplate: "{unknown}-{version}" },
      }),
    ).toThrow('template contains unsupported placeholder "{unknown}"');
  });
});
