import { describe, expect, test, vi } from "vitest";

import {
  GithubState,
  type GithubApi,
  type GithubObject,
  type GithubReleaseRecord,
} from "./github-state.js";
import type { GithubRelease, ReleasePackage } from "./release-plan.js";

const targetSha = "2".repeat(40);
const item: ReleasePackage = {
  name: "example-core",
  version: "1.2.3",
  manifestPath: "crates/example-core/Cargo.toml",
  tag: "example-core-v1.2.3",
};
const release: GithubRelease = {
  package: item.name,
  version: item.version,
  tag: item.tag,
  tagTemplate: "{name}-v{version}",
  name: "Example 1.2.3",
  notes: "Release notes",
  prerelease: false,
};

function api(overrides: Partial<GithubApi> = {}): GithubApi {
  return {
    getRef: vi.fn(async () => ({ type: "commit", sha: targetSha })),
    getAnnotatedTag: vi.fn(async () => ({ type: "commit", sha: targetSha })),
    createAnnotatedTag: vi.fn(async () => ({ sha: "3".repeat(40) })),
    createRef: vi.fn(async () => undefined),
    getReleaseByTag: vi.fn(async () => ({
      id: 42,
      tagName: item.tag,
      name: "Example 1.2.3",
      body: "Release notes",
      prerelease: false,
      draft: false,
    })),
    getLatestRelease: vi.fn(async () => ({ id: 42 })),
    listReleases: vi.fn(
      async (): Promise<readonly GithubReleaseRecord[]> => [],
    ),
    createRelease: vi.fn(async () => undefined),
    updateRelease: vi.fn(async () => undefined),
    ...overrides,
  };
}

function published(
  tagName: string,
  overrides: Partial<GithubReleaseRecord> = {},
): GithubReleaseRecord {
  return {
    id: 7,
    tagName,
    name: tagName,
    body: null,
    prerelease: false,
    draft: false,
    ...overrides,
  };
}

describe("GithubState", () => {
  test("recognizes a lightweight tag at the exact target commit", async () => {
    const state = new GithubState(api(), targetSha);

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "matching",
      subject: item.tag,
    });
  });

  test("recognizes an annotated tag that peels to the exact target commit", async () => {
    const getAnnotatedTag = vi.fn(async (): Promise<GithubObject> => ({
      type: "commit",
      sha: targetSha,
    }));
    const state = new GithubState(
      api({
        getRef: vi.fn(async () => ({ type: "tag", sha: "1".repeat(40) })),
        getAnnotatedTag,
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "matching",
      subject: item.tag,
    });
    expect(getAnnotatedTag).toHaveBeenCalledExactlyOnceWith("1".repeat(40));
  });

  test("reports a missing tag only when the tag ref returns 404", async () => {
    const state = new GithubState(
      api({ getRef: vi.fn(async () => Promise.reject({ status: 404 })) }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "missing",
      subject: item.tag,
    });
  });

  test("peels nested annotated tags with bounded calls", async () => {
    const first = "1".repeat(40);
    const second = "3".repeat(40);
    const getAnnotatedTag = vi
      .fn<(sha: string) => Promise<GithubObject>>()
      .mockResolvedValueOnce({ type: "tag", sha: second })
      .mockResolvedValueOnce({ type: "commit", sha: targetSha });
    const state = new GithubState(
      api({
        getRef: vi.fn(async () => ({ type: "tag", sha: first })),
        getAnnotatedTag,
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toMatchObject({
      state: "matching",
    });
    expect(getAnnotatedTag).toHaveBeenNthCalledWith(1, first);
    expect(getAnnotatedTag).toHaveBeenNthCalledWith(2, second);
  });

  test("rejects a cycle in an annotated tag chain", async () => {
    const tagSha = "1".repeat(40);
    const state = new GithubState(
      api({
        getRef: vi.fn(async () => ({ type: "tag", sha: tagSha })),
        getAnnotatedTag: vi.fn(async () => ({ type: "tag", sha: tagSha })),
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "conflicting",
      subject: item.tag,
      detail: "annotated tag chain contains a cycle",
    });
  });

  test("bounds annotated tag peeling", async () => {
    let next = 1;
    const getAnnotatedTag = vi.fn(async (): Promise<GithubObject> => ({
      type: "tag",
      sha: String((next += 1) % 10).repeat(40),
    }));
    const state = new GithubState(
      api({
        getRef: vi.fn(async () => ({ type: "tag", sha: "1".repeat(40) })),
        getAnnotatedTag,
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toMatchObject({
      state: "conflicting",
    });
    expect(getAnnotatedTag).toHaveBeenCalledTimes(8);
  });

  test("treats a missing annotated tag object as conflicting state", async () => {
    const state = new GithubState(
      api({
        getRef: vi.fn(async () => ({ type: "tag", sha: "1".repeat(40) })),
        getAnnotatedTag: vi.fn(async () =>
          Promise.reject({ status: 404, message: "not found" }),
        ),
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "conflicting",
      subject: item.tag,
      detail: "GitHub tag observation failed: not found",
    });
  });

  test("fails closed when a tag resolves to another commit", async () => {
    const state = new GithubState(api(), "4".repeat(40));

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "conflicting",
      subject: item.tag,
      detail: "tag does not target the release commit",
    });
  });

  test("reports GitHub availability errors as transient tag observations", async () => {
    const state = new GithubState(
      api({
        getRef: vi.fn(async () =>
          Promise.reject({ status: 503, message: "unavailable" }),
        ),
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toEqual({
      state: "transient",
      subject: item.tag,
      detail: "GitHub tag observation failed: unavailable",
    });
  });

  test("creates an annotated tag object before its ref", async () => {
    const client = api();
    const state = new GithubState(client, targetSha);

    await state.createTag(item);

    expect(client.createAnnotatedTag).toHaveBeenCalledExactlyOnceWith({
      tag: item.tag,
      message: "Release example-core 1.2.3",
      object: targetSha,
      type: "commit",
    });
    expect(client.createRef).toHaveBeenCalledExactlyOnceWith({
      ref: `refs/tags/${item.tag}`,
      sha: "3".repeat(40),
    });
  });

  test("recognizes an exact public GitHub Release", async () => {
    const state = new GithubState(api(), targetSha);

    await expect(state.observeGithubRelease(release)).resolves.toEqual({
      state: "matching",
      subject: item.tag,
    });
  });

  test("classifies mutable GitHub Release metadata drift as repairable", async () => {
    const state = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () => ({
          id: 42,
          tagName: item.tag,
          name: null,
          body: null,
          prerelease: false,
          draft: true,
        })),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toEqual({
      state: "repairable",
      subject: item.tag,
      detail: "GitHub Release metadata differs: name, notes, draft",
    });
  });

  test("fails closed when the GitHub Release channel differs", async () => {
    const state = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () => ({
          id: 42,
          tagName: item.tag,
          name: release.name,
          body: release.notes,
          prerelease: true,
          draft: false,
        })),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toEqual({
      state: "conflicting",
      subject: item.tag,
      detail: "GitHub Release prerelease channel differs",
    });
  });

  test.each([
    ["true", 42, "matching"],
    ["true", 7, "repairable"],
    ["false", 42, "repairable"],
    ["false", 7, "matching"],
    ["false", undefined, "matching"],
  ] as const)(
    "observes explicit make_latest=%s when the latest release id is %s",
    async (makeLatest, latestId, expectedState) => {
      const state = new GithubState(
        api({
          getLatestRelease: vi.fn(async () =>
            latestId === undefined ? undefined : { id: latestId },
          ),
        }),
        targetSha,
      );

      await expect(
        state.observeGithubRelease({ ...release, makeLatest }),
      ).resolves.toMatchObject({ state: expectedState, subject: item.tag });
    },
  );

  test("observes a selected latest release against the published history", async () => {
    const state = new GithubState(
      api({
        getLatestRelease: vi.fn(async () => ({ id: 7 })),
        listReleases: vi.fn(async () => [published("example-core-v1.2.2")]),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toEqual({
      state: "repairable",
      subject: item.tag,
      detail: "GitHub Release latest state differs: expected latest",
    });
  });

  test("leaves the latest release untouched for a prerelease", async () => {
    const client = api({
      getReleaseByTag: vi.fn(async () => ({
        id: 42,
        tagName: item.tag,
        name: release.name,
        body: release.notes,
        prerelease: true,
        draft: false,
      })),
    });
    const state = new GithubState(client, targetSha);

    await expect(
      state.observeGithubRelease({ ...release, prerelease: true }),
    ).resolves.toEqual({ state: "matching", subject: item.tag });
    expect(client.listReleases).not.toHaveBeenCalled();
    expect(client.getLatestRelease).not.toHaveBeenCalled();
  });

  test("classifies a failed release history observation", async () => {
    const state = new GithubState(
      api({
        listReleases: vi.fn(async () =>
          Promise.reject({ status: 503, message: "unavailable" }),
        ),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toMatchObject({
      state: "transient",
      detail: "GitHub Release history observation failed: unavailable",
    });
  });

  test("classifies failures while observing explicit latest state", async () => {
    const transient = new GithubState(
      api({
        getLatestRelease: vi.fn(async () =>
          Promise.reject({ status: 503, message: "unavailable" }),
        ),
      }),
      targetSha,
    );
    const conflicting = new GithubState(
      api({
        getLatestRelease: vi.fn(async () => Promise.reject("invalid state")),
      }),
      targetSha,
    );

    await expect(
      transient.observeGithubRelease({ ...release, makeLatest: "true" }),
    ).resolves.toMatchObject({
      state: "transient",
      detail: "GitHub latest Release observation failed: unavailable",
    });
    await expect(
      conflicting.observeGithubRelease({ ...release, makeLatest: "true" }),
    ).resolves.toMatchObject({
      state: "conflicting",
      detail: "GitHub latest Release observation failed: invalid state",
    });
  });

  test("fails closed if a GitHub Release lookup returns another tag", async () => {
    const state = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () => ({
          id: 42,
          tagName: "another-tag",
          name: release.name,
          body: release.notes,
          prerelease: release.prerelease,
          draft: false,
        })),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toMatchObject({
      state: "conflicting",
      subject: item.tag,
    });
  });

  test("distinguishes a missing GitHub Release from transient lookup failure", async () => {
    const missing = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () => Promise.reject({ status: 404 })),
      }),
      targetSha,
    );
    const transient = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () =>
          Promise.reject({ status: 429, message: "rate limited" }),
        ),
      }),
      targetSha,
    );

    await expect(missing.observeGithubRelease(release)).resolves.toEqual({
      state: "missing",
      subject: item.tag,
    });
    await expect(transient.observeGithubRelease(release)).resolves.toEqual({
      state: "transient",
      subject: item.tag,
      detail: "GitHub Release observation failed: rate limited",
    });
  });

  test("reports network failures as transient observations", async () => {
    const networkError = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    });
    const state = new GithubState(
      api({ getReleaseByTag: vi.fn(async () => Promise.reject(networkError)) }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toMatchObject({
      state: "transient",
      subject: item.tag,
    });
  });

  test("recognizes a nested network cause as transient", async () => {
    const cause = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const state = new GithubState(
      api({
        getRef: vi.fn(async () =>
          Promise.reject(new Error("request failed", { cause })),
        ),
      }),
      targetSha,
    );

    await expect(state.observeTag(item)).resolves.toMatchObject({
      state: "transient",
    });
  });

  test("recognizes request aborts and timeouts as transient", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const state = new GithubState(
        api({
          getRef: vi.fn(async () =>
            Promise.reject(new DOMException("request ended", name)),
          ),
        }),
        targetSha,
      );

      await expect(state.observeTag(item)).resolves.toMatchObject({
        state: "transient",
      });
    }
  });

  test("fails closed on an unclassified client error", async () => {
    const state = new GithubState(
      api({
        getReleaseByTag: vi.fn(async () => Promise.reject("bad client state")),
      }),
      targetSha,
    );

    await expect(state.observeGithubRelease(release)).resolves.toEqual({
      state: "conflicting",
      subject: item.tag,
      detail: "GitHub Release observation failed: bad client state",
    });
  });

  test("creates a public release at the target commit", async () => {
    const client = api();
    const state = new GithubState(client, targetSha);

    await state.createGithubRelease(release);

    expect(client.createRelease).toHaveBeenCalledExactlyOnceWith({
      tagName: release.tag,
      targetCommitish: targetSha,
      name: release.name,
      body: release.notes,
      prerelease: false,
      draft: false,
      makeLatest: "true",
    });
  });

  test.each([
    ["no release exists yet", "1.2.3", [], "true"],
    [
      "the version is above every published version",
      "1.2.3",
      [published("example-core-v1.0.0"), published("example-core-v1.2.2")],
      "true",
    ],
    [
      "a newer major version is already published",
      "6.3.1",
      [published("example-core-v6.3.0"), published("example-core-v7.0.0")],
      "false",
    ],
    [
      "the version leads its own line and every other line",
      "6.3.1",
      [published("example-core-v6.3.0")],
      "true",
    ],
    [
      "the version is already published",
      "6.3.1",
      [published("example-core-v6.3.0"), published("example-core-v6.3.1")],
      "true",
    ],
    [
      "the version is a prerelease",
      "7.0.0-rc.1",
      [published("example-core-v6.3.1")],
      "false",
    ],
    [
      "published prereleases and foreign tags surround the version",
      "6.3.1",
      [
        published("example-core-v7.0.0-rc.1", { prerelease: true }),
        published("example-core-v8.0.0", { draft: true }),
        published("other-crate-v9.0.0"),
        published("v10.0.0"),
        published("example-core-v6.3.0"),
      ],
      "true",
    ],
    [
      "the version has a two-digit component",
      "6.10.0",
      [published("example-core-v6.9.0")],
      "true",
    ],
  ] as const)(
    "selects the latest release flag when %s",
    async (_case, version, releases, expected) => {
      const client = api({ listReleases: vi.fn(async () => releases) });
      const state = new GithubState(client, targetSha);

      await state.createGithubRelease({
        ...release,
        version,
        tag: `example-core-v${version}`,
      });

      expect(client.createRelease).toHaveBeenCalledWith(
        expect.objectContaining({ makeLatest: expected }),
      );
    },
  );

  test.each(["true", "false"] as const)(
    "passes through explicit make_latest=%s semantics",
    async (makeLatest) => {
      const client = api();
      const state = new GithubState(client, targetSha);

      await state.createGithubRelease({ ...release, makeLatest });

      expect(client.createRelease).toHaveBeenCalledWith(
        expect.objectContaining({ makeLatest }),
      );
    },
  );

  test("repairs mutable release metadata without changing its tag", async () => {
    const client = api();
    const state = new GithubState(client, targetSha);

    await state.updateGithubRelease(release);

    expect(client.updateRelease).toHaveBeenCalledExactlyOnceWith({
      releaseId: 42,
      tagName: release.tag,
      name: release.name,
      body: release.notes,
      prerelease: false,
      draft: false,
      makeLatest: "true",
    });
  });

  test("does not overwrite a release whose channel changed before repair", async () => {
    const client = api({
      getReleaseByTag: vi.fn(async () => ({
        id: 42,
        tagName: item.tag,
        name: release.name,
        body: release.notes,
        prerelease: true,
        draft: false,
      })),
    });
    const state = new GithubState(client, targetSha);

    await expect(state.updateGithubRelease(release)).rejects.toThrow(
      "GitHub Release prerelease channel changed",
    );
    expect(client.updateRelease).not.toHaveBeenCalled();
  });
});
