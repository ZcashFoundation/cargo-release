import type { Observation } from "./reconcile.js";
import type { GithubRelease, ReleasePackage } from "./release-plan.js";

const MAX_TAG_DEPTH = 8;

export interface GithubObject {
  readonly type: string;
  readonly sha: string;
}

export interface GithubReleaseRecord {
  readonly id: number;
  readonly tagName: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly prerelease: boolean;
  readonly draft: boolean;
}

export interface GithubLatestRelease {
  readonly id: number;
}

export interface CreateAnnotatedTagInput {
  readonly tag: string;
  readonly message: string;
  readonly object: string;
  readonly type: "commit";
}

export interface CreateRefInput {
  readonly ref: string;
  readonly sha: string;
}

export interface CreateReleaseInput {
  readonly tagName: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
  readonly draft: false;
  readonly makeLatest: "true" | "false" | "legacy";
}

export interface UpdateReleaseInput {
  readonly releaseId: number;
  readonly tagName: string;
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
  readonly draft: false;
  readonly makeLatest: "true" | "false" | "legacy";
}

export interface GithubApi {
  getRef(tag: string): Promise<GithubObject>;
  getAnnotatedTag(sha: string): Promise<GithubObject>;
  createAnnotatedTag(
    input: CreateAnnotatedTagInput,
  ): Promise<{ readonly sha: string }>;
  createRef(input: CreateRefInput): Promise<void>;
  getReleaseByTag(tag: string): Promise<GithubReleaseRecord>;
  getLatestRelease(): Promise<GithubLatestRelease | undefined>;
  createRelease(input: CreateReleaseInput): Promise<void>;
  updateRelease(input: UpdateReleaseInput): Promise<void>;
}

export class GithubState {
  constructor(
    private readonly api: GithubApi,
    private readonly targetSha: string,
  ) {}

  async observeTag(item: ReleasePackage): Promise<Observation> {
    const subject = item.tag;
    let reference: GithubObject;
    try {
      reference = await this.api.getRef(item.tag);
    } catch (error: unknown) {
      return errorObservation(
        subject,
        "GitHub tag observation failed",
        error,
        true,
      );
    }

    try {
      let object = reference;
      const visited = new Set<string>();
      for (
        let depth = 0;
        object.type === "tag" && depth < MAX_TAG_DEPTH;
        depth += 1
      ) {
        const sha = object.sha.toLowerCase();
        if (visited.has(sha)) {
          return {
            state: "conflicting",
            subject,
            detail: "annotated tag chain contains a cycle",
          };
        }
        visited.add(sha);
        object = await this.api.getAnnotatedTag(object.sha);
      }

      if (
        object.type === "commit" &&
        object.sha.toLowerCase() === this.targetSha.toLowerCase()
      ) {
        return { state: "matching", subject };
      }
      return {
        state: "conflicting",
        subject,
        detail: "tag does not target the release commit",
      };
    } catch (error: unknown) {
      return errorObservation(
        subject,
        "GitHub tag observation failed",
        error,
        false,
      );
    }
  }

  async createTag(item: ReleasePackage): Promise<void> {
    const tagObject = await this.api.createAnnotatedTag({
      tag: item.tag,
      message: `Release ${item.name} ${item.version}`,
      object: this.targetSha,
      type: "commit",
    });
    await this.api.createRef({
      ref: `refs/tags/${item.tag}`,
      sha: tagObject.sha,
    });
  }

  async observeGithubRelease(release: GithubRelease): Promise<Observation> {
    const subject = release.tag;
    let actual: GithubReleaseRecord;
    try {
      actual = await this.api.getReleaseByTag(release.tag);
    } catch (error: unknown) {
      return errorObservation(
        subject,
        "GitHub Release observation failed",
        error,
        true,
      );
    }
    if (actual.tagName !== release.tag) {
      return {
        state: "conflicting",
        subject,
        detail: "GitHub Release lookup returned a different tag",
      };
    }
    if (actual.prerelease !== release.prerelease) {
      return {
        state: "conflicting",
        subject,
        detail: "GitHub Release prerelease channel differs",
      };
    }
    const mismatches = [
      actual.name === release.name ? undefined : "name",
      actual.body === release.notes ? undefined : "notes",
      actual.draft === false ? undefined : "draft",
    ].filter((field): field is string => field !== undefined);

    if (mismatches.length > 0) {
      return {
        state: "repairable",
        subject,
        detail: `GitHub Release metadata differs: ${mismatches.join(", ")}`,
      };
    }

    if (release.prerelease || release.makeLatest === "auto") {
      return { state: "matching", subject };
    }

    let latest: GithubLatestRelease | undefined;
    try {
      latest = await this.api.getLatestRelease();
    } catch (error: unknown) {
      return errorObservation(
        subject,
        "GitHub latest Release observation failed",
        error,
        false,
      );
    }
    const isLatest = latest?.id === actual.id;
    const shouldBeLatest = release.makeLatest === "true";
    return isLatest === shouldBeLatest
      ? { state: "matching", subject }
      : {
          state: "repairable",
          subject,
          detail: `GitHub Release latest state differs: expected ${
            shouldBeLatest ? "latest" : "not latest"
          }`,
        };
  }

  async createGithubRelease(release: GithubRelease): Promise<void> {
    await this.api.createRelease({
      tagName: release.tag,
      targetCommitish: this.targetSha,
      name: release.name,
      body: release.notes,
      prerelease: release.prerelease,
      draft: false,
      makeLatest: githubMakeLatest(release),
    });
  }

  async updateGithubRelease(release: GithubRelease): Promise<void> {
    const actual = await this.api.getReleaseByTag(release.tag);
    if (actual.tagName !== release.tag) {
      throw new Error("GitHub Release lookup returned a different tag");
    }
    if (actual.prerelease !== release.prerelease) {
      throw new Error("GitHub Release prerelease channel changed");
    }
    await this.api.updateRelease({
      releaseId: actual.id,
      tagName: release.tag,
      name: release.name,
      body: release.notes,
      prerelease: release.prerelease,
      draft: false,
      makeLatest: githubMakeLatest(release),
    });
  }
}

function githubMakeLatest(release: GithubRelease): "true" | "false" | "legacy" {
  return release.makeLatest === "auto" ? "legacy" : release.makeLatest;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error))
    return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function messageOf(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function errorObservation(
  subject: string,
  context: string,
  error: unknown,
  missingAllowed: boolean,
): Observation {
  const status = statusOf(error);
  if (missingAllowed && status === 404) return { state: "missing", subject };
  const state =
    status === 429 ||
    (status !== undefined && status >= 500) ||
    isNetworkError(error)
      ? "transient"
      : "conflicting";
  return { state, subject, detail: `${context}: ${messageOf(error)}` };
}

function isNetworkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true;
  }
  if ("code" in error && typeof error.code === "string") {
    if (
      [
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "ENETUNREACH",
        "ENOTFOUND",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(error.code)
    ) {
      return true;
    }
  }
  return "cause" in error && isNetworkError(error.cause);
}
