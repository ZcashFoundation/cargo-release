import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";

import { CargoPublisher } from "./cargo-publisher.js";
import { observeCrateVersion } from "./crates-registry.js";
import { asError, errorMessage } from "./errors.js";
import {
  GithubState,
  type CreateAnnotatedTagInput,
  type CreateRefInput,
  type CreateReleaseInput,
  type GithubApi,
  type UpdateReleaseInput,
} from "./github-state.js";
import {
  reconcile,
  type Observation,
  type Phase,
  type ReconcilePorts,
  type ReconcileReport,
} from "./reconcile.js";
import { loadReleasePlan, type WorkspacePlanPorts } from "./workspace-plan.js";

const CRATES_IO_API = "https://crates.io/api/v1/crates/{name}/{version}";
const CRATES_IO_DOWNLOAD =
  "https://crates.io/api/v1/crates/{name}/{version}/download";
const GITHUB_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const REOBSERVATION_DELAY_MILLISECONDS = 15_000;

async function run(): Promise<void> {
  const phase = parsePhase(core.getInput("phase"));
  const attempts = parseAttempts(core.getInput("attempts"));
  const sourceDirectory = path.resolve(
    core.getInput("source-directory") || ".",
  );
  const baseSha = core.getInput("base-sha", { required: true });
  const targetSha = core.getInput("target-sha", { required: true });
  const configPath =
    core.getInput("config-path") || ".github/cargo-release.yml";
  const githubToken = core.getInput("github-token", { required: true });
  core.setSecret(githubToken);
  // Cargo can execute package build scripts, which do not need this token.
  delete process.env["INPUT_GITHUB-TOKEN"];

  const { plan, githubReleaseError } = await loadReleasePlan(
    {
      controllerDirectory: process.cwd(),
      sourceDirectory,
      baseSha,
      targetSha,
      configPath,
    },
    workspacePlanPorts(),
  );
  core.setOutput("plan", JSON.stringify(plan));
  if (phase !== "check" && githubReleaseError !== undefined) {
    throw githubReleaseError;
  }

  const publisher = new CargoPublisher(
    sourceDirectory,
    async (command, args, cwd) =>
      exec.exec(command, args, { cwd, ignoreReturnCode: true }),
  );
  const githubState = new GithubState(
    githubApi(githubToken),
    plan.source.targetSha,
  );
  const ports: ReconcilePorts = {
    async observePackage(item) {
      return observeCrateVersion({
        name: item.name,
        version: item.version,
        expectedSha: plan.source.targetSha,
        apiUrl: CRATES_IO_API,
        downloadUrl: CRATES_IO_DOWNLOAD,
        fetch: cratesIoFetch,
      });
    },
    async dryRunPackages(items) {
      await publisher.dryRun(items);
    },
    async publishPackages(items) {
      await publisher.publish(items);
    },
    async observeTag(item) {
      return githubState.observeTag(item);
    },
    async createTag(item) {
      await githubState.createTag(item);
    },
    async observeGithubRelease(release) {
      return githubState.observeGithubRelease(release);
    },
    async createGithubRelease(release) {
      await githubState.createGithubRelease(release);
    },
    async updateGithubRelease(release) {
      await githubState.updateGithubRelease(release);
    },
    async wait() {
      await new Promise((resolve) =>
        setTimeout(resolve, REOBSERVATION_DELAY_MILLISECONDS),
      );
    },
  };

  let report: ReconcileReport;
  try {
    report = await reconcile(plan, phase, ports, { attempts });
  } catch (error: unknown) {
    if (githubReleaseError === undefined) throw error;
    throw new Error(
      `GitHub Release validation failed: ${githubReleaseError.message}; release reconciliation failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  core.setOutput("report", JSON.stringify(report));
  const failures = [
    ...(githubReleaseError === undefined
      ? []
      : [`GitHub Release validation failed: ${githubReleaseError.message}`]),
    ...reportFailureMessages(report, phase),
  ];
  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

function reportFailureMessages(
  report: ReconcileReport,
  phase: Phase,
): string[] {
  if (report.state === "complete") return [];
  if (
    phase === "check" &&
    report.reason === "incomplete" &&
    report.operationError === undefined
  ) {
    return [];
  }

  const observations: Observation[] = [
    ...report.packages,
    ...report.tags,
    ...(report.githubRelease === undefined ? [] : [report.githubRelease]),
  ];
  const details = observations
    .filter((observation) => observation.state !== "matching")
    .map(
      (observation) =>
        `${observation.subject}: ${
          observation.state === "missing"
            ? observation.state
            : observation.detail
        }`,
    )
    .join("; ");
  const operation =
    report.operationError === undefined
      ? ""
      : `; operation failed: ${report.operationError}`;
  return [`release reconciliation ${report.reason}: ${details}${operation}`];
}

function workspacePlanPorts(): WorkspacePlanPorts {
  return {
    async run(command, args, cwd) {
      const result = await exec.getExecOutput(command, [...args], {
        cwd,
        ignoreReturnCode: true,
        silent: true,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async readText(file) {
      return readFile(file, "utf8");
    },
    async makeTempDirectory() {
      return mkdtemp(path.join(tmpdir(), "cargo-release-"));
    },
    async removeDirectory(directory) {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function githubApi(token: string): GithubApi {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const request = () => ({
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MILLISECONDS),
  });
  return {
    async getRef(tag) {
      const { data } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${tag}`,
        request: request(),
      });
      return { type: data.object.type, sha: data.object.sha };
    },
    async getAnnotatedTag(sha) {
      const { data } = await octokit.rest.git.getTag({
        owner,
        repo,
        tag_sha: sha,
        request: request(),
      });
      return { type: data.object.type, sha: data.object.sha };
    },
    async createAnnotatedTag(input: CreateAnnotatedTagInput) {
      const { data } = await octokit.rest.git.createTag({
        owner,
        repo,
        tag: input.tag,
        message: input.message,
        object: input.object,
        type: input.type,
        request: request(),
      });
      return { sha: data.sha };
    },
    async createRef(input: CreateRefInput) {
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: input.ref,
        sha: input.sha,
        request: request(),
      });
    },
    async getReleaseByTag(tag) {
      const { data } = await octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag,
        request: request(),
      });
      return {
        id: data.id,
        tagName: data.tag_name,
        name: data.name,
        body: data.body ?? null,
        prerelease: data.prerelease,
        draft: data.draft,
      };
    },
    async getLatestRelease() {
      try {
        const { data } = await octokit.rest.repos.getLatestRelease({
          owner,
          repo,
          request: request(),
        });
        return { id: data.id };
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) {
          return undefined;
        }
        throw asError(error);
      }
    },
    async createRelease(input: CreateReleaseInput) {
      await octokit.rest.repos.createRelease({
        owner,
        repo,
        tag_name: input.tagName,
        target_commitish: input.targetCommitish,
        name: input.name,
        body: input.body,
        prerelease: input.prerelease,
        draft: input.draft,
        make_latest: input.makeLatest,
        request: request(),
      });
    },
    async updateRelease(input: UpdateReleaseInput) {
      await octokit.rest.repos.updateRelease({
        owner,
        repo,
        release_id: input.releaseId,
        tag_name: input.tagName,
        name: input.name,
        body: input.body,
        prerelease: input.prerelease,
        draft: input.draft,
        make_latest: input.makeLatest,
        request: request(),
      });
    },
  };
}

function parsePhase(value: string): Phase {
  if (
    value === "check" ||
    value === "publish" ||
    value === "finalize" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("phase must be check, publish, finalize, or all");
}

function parseAttempts(value: string): number {
  const attempts = Number(value);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("attempts must be an integer between 1 and 10");
  }
  return attempts;
}

const cratesIoFetch: typeof globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "ZcashFoundation/cargo-release");
  return globalThis.fetch(input, { ...init, headers });
};

run().catch((error: unknown) => {
  core.setFailed(errorMessage(error));
});
