import { describe, expect, expectTypeOf, test, vi } from "vitest";

import {
  reconcile,
  type FailedReport,
  type Observation,
  type ReconcilePorts,
  type ReleasePlan,
} from "./reconcile.js";

const plan: ReleasePlan = {
  schemaVersion: 1,
  source: {
    baseSha: "1".repeat(40),
    targetSha: "2".repeat(40),
  },
  packages: [
    {
      name: "example-core",
      version: "1.2.3",
      manifestPath: "crates/example-core/Cargo.toml",
      tag: "example-core-v1.2.3",
    },
  ],
};

function matching(subject: string): Observation {
  return { state: "matching", subject };
}

function matchingPorts(): ReconcilePorts {
  return {
    observePackage: async (item) => matching(`${item.name}@${item.version}`),
    dryRunPackages: async () => undefined,
    publishPackages: async () => undefined,
    observeTag: async (item) => matching(item.tag),
    createTag: async () => undefined,
    observeGithubRelease: async (release) => ({
      state: "missing",
      subject: release.tag,
    }),
    createGithubRelease: async () => undefined,
    updateGithubRelease: async () => undefined,
    wait: async () => undefined,
  };
}

describe("reconcile", () => {
  test("ties failure reasons to their retry contract", () => {
    expectTypeOf<
      Extract<FailedReport, { reason: "conflict" }>["retryable"]
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Extract<FailedReport, { reason: "transient" }>["retryable"]
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Extract<FailedReport, { reason: "incomplete" }>["retryable"]
    >().toEqualTypeOf<true>();
  });

  test("reports an already complete release without writing", async () => {
    const ports = matchingPorts();
    const report = await reconcile(plan, "all", ports, { attempts: 3 });

    expect(report).toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
    });
  });

  test("observes package archives sequentially to bound memory and registry load", async () => {
    const twoPackagePlan: ReleasePlan = {
      ...plan,
      packages: [
        ...plan.packages,
        {
          name: "example-cli",
          version: "1.2.3",
          manifestPath: "crates/example-cli/Cargo.toml",
          tag: "example-cli-v1.2.3",
        },
      ],
    };
    const ports = matchingPorts();
    let active = 0;
    let maximumActive = 0;
    ports.observePackage = async (item) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return matching(`${item.name}@${item.version}`);
    };

    await expect(
      reconcile(twoPackagePlan, "check", ports, { attempts: 1 }),
    ).resolves.toMatchObject({ state: "complete" });
    expect(maximumActive).toBe(1);
  });

  test("fails conflicts before making a release write", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "conflicting",
      subject: `${item.name}@${item.version}`,
      detail: "published from another commit",
    });
    ports.dryRunPackages = vi.fn();
    ports.publishPackages = vi.fn();
    ports.createTag = vi.fn();
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(plan, "all", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "conflict",
      retryable: false,
      packages: [
        {
          state: "conflicting",
          subject: "example-core@1.2.3",
          detail: "published from another commit",
        },
      ],
      tags: [matching("example-core-v1.2.3")],
    });

    expect(ports.dryRunPackages).not.toHaveBeenCalled();
    expect(ports.publishPackages).not.toHaveBeenCalled();
    expect(ports.createTag).not.toHaveBeenCalled();
    expect(ports.createGithubRelease).not.toHaveBeenCalled();
  });

  test("finds a conflicting tag before publishing a missing crate", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "missing",
      subject: `${item.name}@${item.version}`,
    });
    ports.observeTag = async (item) => ({
      state: "conflicting",
      subject: item.tag,
      detail: "tag points at another commit",
    });
    ports.dryRunPackages = vi.fn();
    ports.publishPackages = vi.fn();

    await expect(
      reconcile(plan, "all", ports, { attempts: 1 }),
    ).resolves.toMatchObject({
      state: "failed",
      reason: "conflict",
      tags: [{ state: "conflicting", subject: "example-core-v1.2.3" }],
    });
    expect(ports.dryRunPackages).not.toHaveBeenCalled();
    expect(ports.publishPackages).not.toHaveBeenCalled();
  });

  test("check dry-runs the complete plan without publishing missing crates", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "missing",
      subject: `${item.name}@${item.version}`,
    });
    ports.observeTag = async (item) => ({
      state: "missing",
      subject: item.tag,
    });
    ports.dryRunPackages = vi.fn();
    ports.publishPackages = vi.fn();

    await expect(
      reconcile(plan, "check", ports, { attempts: 1 }),
    ).resolves.toMatchObject({ state: "failed", reason: "incomplete" });
    expect(ports.dryRunPackages).toHaveBeenCalledExactlyOnceWith(plan.packages);
    expect(ports.publishPackages).not.toHaveBeenCalled();
  });

  test("reports a transient check observation as retryable", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "transient",
      subject: `${item.name}@${item.version}`,
      detail: "crates.io timed out",
    });

    await expect(
      reconcile(plan, "check", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "transient",
      retryable: true,
      packages: [
        {
          state: "transient",
          subject: "example-core@1.2.3",
          detail: "crates.io timed out",
        },
      ],
      tags: [matching("example-core-v1.2.3")],
    });
  });

  test("checks missing tags without creating a tag or GitHub Release", async () => {
    const ports = matchingPorts();
    ports.observeTag = async (item) => ({
      state: "missing",
      subject: item.tag,
    });
    ports.createTag = vi.fn();
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(plan, "check", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "incomplete",
      retryable: true,
      packages: [matching("example-core@1.2.3")],
      tags: [{ state: "missing", subject: "example-core-v1.2.3" }],
    });

    expect(ports.createTag).not.toHaveBeenCalled();
    expect(ports.createGithubRelease).not.toHaveBeenCalled();
  });

  test("dry-runs the complete set and publishes only missing packages", async () => {
    const twoPackagePlan: ReleasePlan = {
      ...plan,
      packages: [
        ...plan.packages,
        {
          name: "example-cli",
          version: "1.2.3",
          manifestPath: "crates/example-cli/Cargo.toml",
          tag: "example-cli-v1.2.3",
        },
      ],
    };
    const ports = matchingPorts();
    const observations = [
      { state: "missing" as const, subject: "example-core@1.2.3" },
      matching("example-cli@1.2.3"),
      matching("example-core@1.2.3"),
      matching("example-cli@1.2.3"),
    ];
    ports.observePackage = vi.fn(async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected package observation");
      return observation;
    });
    ports.dryRunPackages = vi.fn();
    ports.publishPackages = vi.fn();
    ports.wait = vi.fn();
    ports.observeTag = vi.fn(async (item) => matching(item.tag));

    await expect(
      reconcile(twoPackagePlan, "publish", ports, { attempts: 2 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3"), matching("example-cli@1.2.3")],
      tags: [matching("example-core-v1.2.3"), matching("example-cli-v1.2.3")],
    });

    expect(ports.dryRunPackages).toHaveBeenCalledExactlyOnceWith(
      twoPackagePlan.packages,
    );
    expect(ports.publishPackages).toHaveBeenCalledExactlyOnceWith([
      twoPackagePlan.packages[0],
    ]);
    expect(ports.wait).toHaveBeenCalledOnce();
    expect(ports.observeTag).toHaveBeenCalledTimes(2);
  });

  test("refuses finalization while any package is missing", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "missing",
      subject: `${item.name}@${item.version}`,
    });
    ports.createTag = vi.fn();
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(plan, "finalize", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "incomplete",
      retryable: true,
      packages: [{ state: "missing", subject: "example-core@1.2.3" }],
      tags: [matching("example-core-v1.2.3")],
    });

    expect(ports.createTag).not.toHaveBeenCalled();
    expect(ports.createGithubRelease).not.toHaveBeenCalled();
  });

  test("finalizes missing tags before creating the optional GitHub Release", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "true",
      },
    };
    const ports = matchingPorts();
    const tagObservations = [
      { state: "missing" as const, subject: "example-core-v1.2.3" },
      matching("example-core-v1.2.3"),
    ];
    const releaseObservations = [
      { state: "missing" as const, subject: "v1.2.3" },
      { state: "missing" as const, subject: "v1.2.3" },
      matching("v1.2.3"),
    ];
    const writes: string[] = [];
    ports.observeTag = vi.fn(async () => {
      const observation = tagObservations.shift();
      if (!observation) throw new Error("unexpected tag observation");
      return observation;
    });
    ports.createTag = vi.fn(async () => {
      writes.push("tag");
    });
    ports.observeGithubRelease = vi.fn(async () => {
      const observation = releaseObservations.shift();
      if (!observation) throw new Error("unexpected release observation");
      return observation;
    });
    ports.createGithubRelease = vi.fn(async () => {
      writes.push("release");
    });

    await expect(
      reconcile(releasePlan, "finalize", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
      githubRelease: matching("v1.2.3"),
    });

    expect(ports.createTag).toHaveBeenCalledExactlyOnceWith(
      releasePlan.packages[0],
    );
    expect(ports.createGithubRelease).toHaveBeenCalledExactlyOnceWith(
      releasePlan.githubRelease,
    );
    expect(writes).toEqual(["tag", "release"]);
  });

  test("reobserves a tag after an already-exists creation race", async () => {
    const ports = matchingPorts();
    const observations = [
      { state: "missing" as const, subject: "example-core-v1.2.3" },
      matching("example-core-v1.2.3"),
    ];
    ports.observeTag = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected tag observation");
      return observation;
    };
    ports.createTag = vi.fn(async () => {
      throw new Error("reference already exists");
    });

    await expect(
      reconcile(plan, "finalize", ports, { attempts: 1 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
    });
  });

  test("stops tag creation when a concurrent tag conflicts", async () => {
    const twoPackagePlan: ReleasePlan = {
      ...plan,
      packages: [
        ...plan.packages,
        {
          name: "example-cli",
          version: "1.2.3",
          manifestPath: "crates/example-cli/Cargo.toml",
          tag: "example-cli-v1.2.3",
        },
      ],
    };
    const ports = matchingPorts();
    let observations = 0;
    ports.observeTag = vi.fn(async (item): Promise<Observation> => {
      observations += 1;
      if (observations <= 2) return { state: "missing", subject: item.tag };
      return {
        state: "conflicting",
        subject: item.tag,
        detail: "tag points at another commit",
      };
    });
    ports.createTag = vi.fn(async () => undefined);

    await expect(
      reconcile(twoPackagePlan, "finalize", ports, { attempts: 1 }),
    ).resolves.toMatchObject({
      state: "failed",
      reason: "conflict",
      tags: [
        { state: "conflicting", subject: "example-core-v1.2.3" },
        { state: "missing", subject: "example-cli-v1.2.3" },
      ],
    });
    expect(ports.createTag).toHaveBeenCalledExactlyOnceWith(
      twoPackagePlan.packages[0],
    );
  });

  test("polls after one publish without resubmitting packages during registry lag", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "missing",
      subject: `${item.name}@${item.version}`,
    });
    ports.dryRunPackages = vi.fn();
    ports.publishPackages = vi.fn();
    ports.wait = vi.fn();

    await expect(
      reconcile(plan, "publish", ports, { attempts: 2 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "incomplete",
      retryable: true,
      packages: [{ state: "missing", subject: "example-core@1.2.3" }],
      tags: [matching("example-core-v1.2.3")],
    });

    expect(ports.dryRunPackages).toHaveBeenCalledOnce();
    expect(ports.publishPackages).toHaveBeenCalledOnce();
    expect(ports.wait).toHaveBeenCalledTimes(2);
  });

  test("accepts completed desired state when Cargo reports an error after uploading", async () => {
    const ports = matchingPorts();
    const observations = [
      { state: "missing" as const, subject: "example-core@1.2.3" },
      matching("example-core@1.2.3"),
    ];
    ports.observePackage = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected package observation");
      return observation;
    };
    ports.publishPackages = vi.fn(async () => {
      throw new Error("connection reset after upload");
    });

    await expect(
      reconcile(plan, "publish", ports, { attempts: 2 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
    });
  });

  test("reports a Cargo error with the recalculated missing set", async () => {
    const ports = matchingPorts();
    ports.observePackage = async (item) => ({
      state: "missing",
      subject: `${item.name}@${item.version}`,
    });
    ports.publishPackages = vi.fn(async () => {
      throw new Error("credential rejected");
    });
    ports.wait = vi.fn(async () => undefined);

    await expect(
      reconcile(plan, "publish", ports, { attempts: 2 }),
    ).resolves.toEqual({
      state: "failed",
      reason: "incomplete",
      retryable: true,
      operationError: "credential rejected",
      packages: [{ state: "missing", subject: "example-core@1.2.3" }],
      tags: [matching("example-core-v1.2.3")],
    });
    expect(ports.publishPackages).toHaveBeenCalledOnce();
    expect(ports.wait).toHaveBeenCalledTimes(2);
  });

  test("checks a configured matching GitHub Release without writing", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "true",
      },
    };
    const ports = matchingPorts();
    ports.observeGithubRelease = vi.fn(async () => matching("v1.2.3"));
    ports.createTag = vi.fn();
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(releasePlan, "check", ports, { attempts: 3 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
      githubRelease: matching("v1.2.3"),
    });

    expect(ports.createTag).not.toHaveBeenCalled();
    expect(ports.createGithubRelease).not.toHaveBeenCalled();
  });

  test("does not create a GitHub Release when its state conflicts", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "true",
      },
    };
    const ports = matchingPorts();
    ports.observeGithubRelease = async () => ({
      state: "conflicting",
      subject: "v1.2.3",
      detail: "release metadata is owned by another release",
    });
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(releasePlan, "finalize", ports, { attempts: 3 }),
    ).resolves.toMatchObject({
      state: "failed",
      reason: "conflict",
      retryable: false,
      githubRelease: { state: "conflicting", subject: "v1.2.3" },
    });

    expect(ports.createGithubRelease).not.toHaveBeenCalled();
  });

  test("repairs mutable GitHub Release metadata and verifies desired state", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "auto",
      },
    };
    const ports = matchingPorts();
    const observations = [
      {
        state: "repairable" as const,
        subject: "v1.2.3",
        detail: "notes differ",
      },
      matching("v1.2.3"),
    ];
    ports.observeGithubRelease = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected release observation");
      return observation;
    };
    ports.updateGithubRelease = vi.fn(async () => undefined);

    await expect(
      reconcile(releasePlan, "finalize", ports, { attempts: 1 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
      githubRelease: matching("v1.2.3"),
    });
    expect(ports.updateGithubRelease).toHaveBeenCalledExactlyOnceWith(
      releasePlan.githubRelease,
    );
  });

  test("continues from publishing to finalization in the all phase", async () => {
    const ports = matchingPorts();
    const observations = [
      { state: "missing" as const, subject: "example-core@1.2.3" },
      matching("example-core@1.2.3"),
    ];
    ports.observePackage = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected package observation");
      return observation;
    };

    await expect(
      reconcile(plan, "all", ports, { attempts: 1 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
    });
  });

  test("uses an explicit missing GitHub Release observation and verifies its creation", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "true",
      },
    };
    const ports = matchingPorts();
    const observations: Observation[] = [
      { state: "missing", subject: "v1.2.3" },
      matching("v1.2.3"),
    ];
    ports.observeGithubRelease = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected release observation");
      return observation;
    };
    ports.createGithubRelease = vi.fn();

    await expect(
      reconcile(releasePlan, "finalize", ports, { attempts: 1 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
      githubRelease: matching("v1.2.3"),
    });

    expect(ports.createGithubRelease).toHaveBeenCalledOnce();
  });

  test("reobserves a GitHub Release after an already-exists creation race", async () => {
    const releasePlan: ReleasePlan = {
      ...plan,
      githubRelease: {
        tag: "v1.2.3",
        name: "Zebra 1.2.3",
        notes: "Release notes",
        prerelease: false,
        makeLatest: "true",
      },
    };
    const ports = matchingPorts();
    const observations = [
      { state: "missing" as const, subject: "v1.2.3" },
      matching("v1.2.3"),
    ];
    ports.observeGithubRelease = async () => {
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected release observation");
      return observation;
    };
    ports.createGithubRelease = vi.fn(async () => {
      throw new Error("release already exists");
    });

    await expect(
      reconcile(releasePlan, "finalize", ports, { attempts: 1 }),
    ).resolves.toEqual({
      state: "complete",
      packages: [matching("example-core@1.2.3")],
      tags: [matching("example-core-v1.2.3")],
      githubRelease: matching("v1.2.3"),
    });
  });
});
