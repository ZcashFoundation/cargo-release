import { beforeEach, expect, test, vi } from "vitest";

import type { GithubApi } from "./github-state.js";
import type { ReconcilePorts, ReleasePlan } from "./reconcile.js";

const plan: ReleasePlan = {
  schemaVersion: 1,
  source: {
    baseSha: "1".repeat(40),
    targetSha: "2".repeat(40),
  },
  packages: [
    {
      name: "example",
      version: "1.2.3",
      manifestPath: "Cargo.toml",
      tag: "example-v1.2.3",
    },
  ],
};

const policy = { finalize: { allowMissingCrates: false } };
const tagFirstPolicy = { finalize: { allowMissingCrates: true } };

const defaultInputs: Readonly<Record<string, string>> = {
  phase: "check",
  attempts: "3",
  "source-directory": "release-source",
  "base-sha": plan.source.baseSha,
  "target-sha": plan.source.targetSha,
  "github-token": "masked-token",
};

const mocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
  setSecret: vi.fn(),
  loadReleasePlan: vi.fn(),
  reconcile: vi.fn(),
  observeCrateVersion: vi.fn(),
  dryRun: vi.fn(),
  publish: vi.fn(),
  observeTag: vi.fn(),
  createTag: vi.fn(),
  observeGithubRelease: vi.fn(),
  createGithubRelease: vi.fn(),
  updateGithubRelease: vi.fn(),
  captureGithubApi: vi.fn(),
  getOctokit: vi.fn(),
  getRef: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mocks.getInput,
  setFailed: mocks.setFailed,
  setOutput: mocks.setOutput,
  setSecret: mocks.setSecret,
}));

vi.mock("@actions/exec", () => ({
  exec: vi.fn(),
  getExecOutput: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: { repo: { owner: "example", repo: "repository" } },
  getOctokit: mocks.getOctokit,
}));

vi.mock("./workspace-plan.js", () => ({
  loadReleasePlan: mocks.loadReleasePlan,
}));

vi.mock("./crates-registry.js", () => ({
  observeCrateVersion: mocks.observeCrateVersion,
}));

vi.mock("./cargo-publisher.js", () => ({
  CargoPublisher: class {
    dryRun = mocks.dryRun;
    publish = mocks.publish;
  },
}));

vi.mock("./github-state.js", () => ({
  GithubState: class {
    constructor(api: unknown) {
      mocks.captureGithubApi(api);
    }

    observeTag = mocks.observeTag;
    createTag = mocks.createTag;
    observeGithubRelease = mocks.observeGithubRelease;
    createGithubRelease = mocks.createGithubRelease;
    updateGithubRelease = mocks.updateGithubRelease;
  },
}));

vi.mock("./reconcile.js", () => ({
  reconcile: mocks.reconcile,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env["INPUT_GITHUB-TOKEN"] = "masked-token";
  mocks.getInput.mockImplementation(
    (name: string) => defaultInputs[name] ?? "",
  );
  mocks.loadReleasePlan.mockResolvedValue({ plan, policy });
  mocks.observeCrateVersion.mockResolvedValue({
    state: "missing",
    subject: "example@1.2.3",
  });
  mocks.observeTag.mockResolvedValue({
    state: "missing",
    subject: "example-v1.2.3",
  });
  mocks.observeGithubRelease.mockResolvedValue({
    state: "missing",
    subject: "release",
  });
  mocks.getRef.mockResolvedValue({
    data: { object: { type: "commit", sha: plan.source.targetSha } },
  });
  mocks.getOctokit.mockReturnValue({
    rest: {
      git: { getRef: mocks.getRef },
      repos: {},
    },
  });
  mocks.reconcile.mockImplementation(
    async (
      releasePlan: ReleasePlan,
      phase: string,
      ports: ReconcilePorts,
      options: { attempts: number },
    ) => {
      expect(releasePlan).toBe(plan);
      expect(phase).toBe("check");
      expect(options).toEqual({ attempts: 3, policy });
      const item = releasePlan.packages[0];
      if (item === undefined) throw new Error("test plan has no package");
      await expect(ports.observePackage(item)).resolves.toEqual({
        state: "missing",
        subject: "example@1.2.3",
      });
      await expect(ports.observeTag(item)).resolves.toEqual({
        state: "missing",
        subject: "example-v1.2.3",
      });
      await ports.dryRunPackages(releasePlan.packages);
      return {
        state: "incomplete",
        retryable: true,
        policy,
        status: {
          crates: "incomplete",
          tags: "incomplete",
          pendingCrates: ["example@1.2.3"],
        },
        packages: [{ state: "missing", subject: "example@1.2.3" }],
        tags: [{ state: "missing", subject: "example-v1.2.3" }],
      };
    },
  );
});

test("assembles a side-effect-free check and succeeds for incomplete state", async () => {
  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setOutput).toHaveBeenCalledWith(
      "report",
      expect.stringContaining('"state":"incomplete"'),
    ),
  );

  expect(mocks.setSecret).toHaveBeenCalledWith("masked-token");
  expect(process.env["INPUT_GITHUB-TOKEN"]).toBeUndefined();
  expect(mocks.getInput).toHaveBeenCalledWith("github-token", {
    required: true,
  });
  expect(mocks.getOctokit).toHaveBeenCalledExactlyOnceWith("masked-token");
  expect(mocks.loadReleasePlan).toHaveBeenCalledWith(
    {
      controllerDirectory: process.cwd(),
      sourceDirectory: expect.stringMatching(/release-source$/),
      baseSha: plan.source.baseSha,
      targetSha: plan.source.targetSha,
      configPath: ".github/cargo-release.yml",
    },
    expect.any(Object),
  );
  expect(mocks.dryRun).toHaveBeenCalledExactlyOnceWith(plan.packages);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.setFailed).not.toHaveBeenCalled();

  const api = mocks.captureGithubApi.mock.calls[0]?.[0] as
    GithubApi | undefined;
  if (api === undefined) throw new Error("GitHub API adapter was not captured");
  await expect(api.getRef("example-v1.2.3")).resolves.toEqual({
    type: "commit",
    sha: plan.source.targetSha,
  });
  expect(mocks.getRef).toHaveBeenCalledWith({
    owner: "example",
    repo: "repository",
    ref: "tags/example-v1.2.3",
    request: { signal: expect.any(AbortSignal) },
  });
});

test("check dry-runs complete packages before reporting a missing release-notes heading", async () => {
  const githubReleaseError = new Error(
    'release notes heading "## [Zebra 1.2.3]" was not found',
  );
  const reconcileError = "cargo publish --dry-run failed with exit code 101";
  mocks.loadReleasePlan.mockResolvedValueOnce({
    plan,
    policy,
    githubReleaseError,
  });
  mocks.reconcile.mockImplementationOnce(
    async (releasePlan: ReleasePlan, phase: string, ports: ReconcilePorts) => {
      expect(releasePlan).toBe(plan);
      expect(phase).toBe("check");
      await ports.dryRunPackages(releasePlan.packages);
      throw new Error(reconcileError);
    },
  );

  await import("./main.js");

  await vi.waitFor(() => expect(mocks.setFailed).toHaveBeenCalledOnce());
  expect(mocks.dryRun).toHaveBeenCalledExactlyOnceWith(plan.packages);
  expect(mocks.publish).not.toHaveBeenCalled();
  const failure = mocks.setFailed.mock.lastCall?.[0];
  expect(failure).toEqual(expect.stringContaining(githubReleaseError.message));
  expect(failure).toEqual(expect.stringContaining(reconcileError));
});

test("check reports release state before failing on invalid release notes", async () => {
  const githubReleaseError = new Error(
    'release notes heading "## Release 1.2.3" was not found',
  );
  mocks.loadReleasePlan.mockResolvedValueOnce({
    plan,
    policy,
    githubReleaseError,
  });
  mocks.reconcile.mockResolvedValueOnce({
    state: "incomplete",
    retryable: true,
    policy,
    status: {
      crates: "incomplete",
      tags: "incomplete",
      pendingCrates: ["example@1.2.3"],
    },
    packages: [{ state: "missing", subject: "example@1.2.3" }],
    tags: [{ state: "missing", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      `GitHub Release validation failed: ${githubReleaseError.message}`,
    ),
  );
  expect(mocks.setOutput).toHaveBeenCalledWith("plan", JSON.stringify(plan));
  expect(mocks.setOutput).toHaveBeenCalledWith(
    "report",
    expect.stringContaining('"state":"incomplete"'),
  );
});

test("publish fails before reconciliation when GitHub Release validation fails", async () => {
  const githubReleaseError = new Error(
    'release notes heading "## [Zebra 1.2.3]" was not found',
  );
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "publish" : (defaultInputs[name] ?? ""),
  );
  mocks.loadReleasePlan.mockResolvedValueOnce({
    plan,
    policy,
    githubReleaseError,
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      githubReleaseError.message,
    ),
  );
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(mocks.dryRun).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});

test("succeeds when tags are complete and crates stay pending", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "finalize" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "incomplete",
    retryable: true,
    policy: tagFirstPolicy,
    status: {
      crates: "incomplete",
      tags: "complete",
      pendingCrates: ["example@1.2.3"],
    },
    packages: [{ state: "missing", subject: "example@1.2.3" }],
    tags: [{ state: "matching", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setOutput).toHaveBeenCalledWith(
      "report",
      expect.stringContaining('"crates":"incomplete"'),
    ),
  );
  expect(mocks.setFailed).not.toHaveBeenCalled();
});

test("fails a pending-crates run that also reports a Cargo error", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "all" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "incomplete",
    retryable: true,
    operationError: "credential rejected",
    policy: tagFirstPolicy,
    status: {
      crates: "incomplete",
      tags: "complete",
      pendingCrates: ["example@1.2.3"],
    },
    packages: [{ state: "missing", subject: "example@1.2.3" }],
    tags: [{ state: "matching", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      "release reconciliation incomplete: example@1.2.3: missing; operation failed: credential rejected",
    ),
  );
});

test("succeeds when the release is already complete", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "all" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "complete",
    policy,
    status: { crates: "complete", tags: "complete", pendingCrates: [] },
    packages: [{ state: "matching", subject: "example@1.2.3" }],
    tags: [{ state: "matching", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setOutput).toHaveBeenCalledWith(
      "report",
      expect.stringContaining('"state":"complete"'),
    ),
  );
  expect(mocks.setFailed).not.toHaveBeenCalled();
});

test("fails a stopped run with the offending observations", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "finalize" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "failed",
    reason: "conflict",
    retryable: false,
    policy,
    status: { crates: "conflict", tags: "complete", pendingCrates: [] },
    packages: [
      {
        state: "conflicting",
        subject: "example@1.2.3",
        detail: "published from another commit",
      },
    ],
    tags: [{ state: "matching", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      "release reconciliation conflict: example@1.2.3: published from another commit",
    ),
  );
});

test("fails a publish phase that leaves crates pending", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "publish" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "incomplete",
    retryable: true,
    policy: tagFirstPolicy,
    status: {
      crates: "incomplete",
      tags: "complete",
      pendingCrates: ["example@1.2.3"],
    },
    packages: [{ state: "missing", subject: "example@1.2.3" }],
    tags: [{ state: "matching", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      "release reconciliation incomplete: example@1.2.3: missing",
    ),
  );
});

test("fails a finalize phase the default policy stopped short", async () => {
  mocks.getInput.mockImplementation((name: string) =>
    name === "phase" ? "finalize" : (defaultInputs[name] ?? ""),
  );
  mocks.reconcile.mockResolvedValueOnce({
    state: "incomplete",
    retryable: true,
    policy,
    status: {
      crates: "incomplete",
      tags: "incomplete",
      pendingCrates: ["example@1.2.3"],
    },
    packages: [{ state: "missing", subject: "example@1.2.3" }],
    tags: [{ state: "missing", subject: "example-v1.2.3" }],
  });

  await import("./main.js");

  await vi.waitFor(() =>
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      "release reconciliation incomplete: example@1.2.3: missing; example-v1.2.3: missing",
    ),
  );
});
