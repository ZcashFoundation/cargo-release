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
  const inputs: Record<string, string> = {
    phase: "check",
    attempts: "3",
    "source-directory": "release-source",
    "base-sha": plan.source.baseSha,
    "target-sha": plan.source.targetSha,
    "config-path": ".github/release.yml",
    "github-token": "masked-token",
  };
  mocks.getInput.mockImplementation((name: string) => inputs[name] ?? "");
  mocks.loadReleasePlan.mockResolvedValue(plan);
  mocks.observeCrateVersion.mockResolvedValue({
    state: "missing",
    subject: "example@1.2.3",
  });
  mocks.observeTag.mockResolvedValue({
    state: "missing",
    subject: "example-v1.2.3",
  });
  mocks.observeGithubRelease.mockResolvedValue(undefined);
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
      expect(options).toEqual({ attempts: 3 });
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
        state: "failed",
        reason: "incomplete",
        retryable: true,
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
      expect.stringContaining('"reason":"incomplete"'),
    ),
  );

  expect(mocks.setSecret).toHaveBeenCalledWith("masked-token");
  expect(mocks.getOctokit).toHaveBeenCalledExactlyOnceWith("masked-token");
  expect(mocks.loadReleasePlan).toHaveBeenCalledWith(
    {
      controllerDirectory: process.cwd(),
      sourceDirectory: expect.stringMatching(/release-source$/),
      baseSha: plan.source.baseSha,
      targetSha: plan.source.targetSha,
      configPath: ".github/release.yml",
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
