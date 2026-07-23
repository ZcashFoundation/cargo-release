import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, test, vi } from "vitest";

import { observeCrateVersion } from "./crates-registry.js";

const expectedSha = "a".repeat(40);

function tarEntry(path: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path);
  header.write("0000644\0", 100, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.fill(" ", 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
}

function tarFile(path: string, content: string): Buffer {
  return Buffer.concat([tarEntry(path, content), Buffer.alloc(1024)]);
}

function response(status: number, body?: Buffer): Response {
  return new Response(body === undefined ? undefined : new Uint8Array(body), {
    status,
  });
}

describe("observeCrateVersion", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("reports a crate whose published archive records the expected clean source SHA", async () => {
    const archive = gzipSync(
      tarFile(
        "example-1.2.3/.cargo_vcs_info.json",
        JSON.stringify({ git: { sha1: expectedSha } }),
      ),
    );
    const requests: string[] = [];

    const observation = await observeCrateVersion({
      name: "example",
      version: "1.2.3",
      expectedSha,
      apiUrl: "https://registry.example/api/v1/crates/{name}/{version}",
      downloadUrl:
        "https://registry.example/api/v1/crates/{name}/{version}/download",
      fetch: async (url) => {
        requests.push(String(url));
        return requests.length === 1 ? response(200) : response(200, archive);
      },
    });

    expect(observation).toEqual({
      state: "matching",
      subject: "example@1.2.3",
    });
    expect(requests).toEqual([
      "https://registry.example/api/v1/crates/example/1.2.3",
      "https://registry.example/api/v1/crates/example/1.2.3/download",
    ]);
  });

  test("reports a 404 package lookup as missing without downloading an archive", async () => {
    const fetch = async () => response(404);

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch,
      }),
    ).resolves.toEqual({ state: "missing", subject: "example@1.2.3" });
  });

  test("reports a published archive with dirty or mismatched provenance as conflicting", async () => {
    const archive = gzipSync(
      tarFile(
        "example-1.2.3/.cargo_vcs_info.json",
        JSON.stringify({ git: { sha1: "b".repeat(40), dirty: true } }),
      ),
    );
    let requestCount = 0;

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch: async () => {
          requestCount += 1;
          return requestCount === 1 ? response(200) : response(200, archive);
        },
      }),
    ).resolves.toMatchObject({
      state: "conflicting",
      subject: "example@1.2.3",
    });
  });

  test("treats failed registry requests and non-success service statuses as transient", async () => {
    const inputs = [
      async (): Promise<Response> => {
        throw new Error("offline");
      },
      async (): Promise<Response> => response(429),
      async (): Promise<Response> => response(503),
      async (): Promise<Response> => response(400),
    ];

    for (const fetch of inputs) {
      await expect(
        observeCrateVersion({
          name: "example",
          version: "1.2.3",
          expectedSha,
          apiUrl: "https://registry.example/{name}/{version}",
          downloadUrl: "https://registry.example/{name}/{version}/download",
          fetch,
        }),
      ).resolves.toMatchObject({
        state: "transient",
        subject: "example@1.2.3",
      });
    }
  });

  test("encodes package identity in both configured endpoint templates", async () => {
    const archive = gzipSync(
      tarFile(
        "a-b-1.2.3+build/.cargo_vcs_info.json",
        JSON.stringify({ git: { sha1: expectedSha, dirty: false } }),
      ),
    );
    const requests: string[] = [];

    await observeCrateVersion({
      name: "a-b",
      version: "1.2.3+build",
      expectedSha,
      apiUrl: "https://registry.example/{name}/{version}",
      downloadUrl: "https://registry.example/{name}/{version}/download",
      fetch: async (url) => {
        requests.push(String(url));
        return requests.length === 1 ? response(200) : response(200, archive);
      },
    });

    expect(requests).toEqual([
      "https://registry.example/a-b/1.2.3%2Bbuild",
      "https://registry.example/a-b/1.2.3%2Bbuild/download",
    ]);
  });

  test("rejects provenance under the wrong package archive root", async () => {
    const archive = gzipSync(
      tarFile(
        "another-package-1.2.3/.cargo_vcs_info.json",
        JSON.stringify({ git: { sha1: expectedSha } }),
      ),
    );
    let requestCount = 0;

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch: async () => {
          requestCount += 1;
          return requestCount === 1 ? response(200) : response(200, archive);
        },
      }),
    ).resolves.toMatchObject({
      state: "conflicting",
      subject: "example@1.2.3",
      detail: "archive has no .cargo_vcs_info.json provenance",
    });
  });

  test("rejects malformed or oversized archive provenance as conflicting", async () => {
    const malformed = Buffer.from("not a tar archive");
    const requests: Array<() => Response> = [
      () => response(200),
      () => response(200, malformed),
    ];

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        maxArchiveBytes: 1,
        fetch: async () => requests.shift()!(),
      }),
    ).resolves.toMatchObject({
      state: "conflicting",
      subject: "example@1.2.3",
    });
  });

  test("rejects archives without valid, unique provenance", async () => {
    const cases = [
      gzipSync(tarFile("example-1.2.3/src/lib.rs", "pub fn example() {}")),
      gzipSync(tarFile("example-1.2.3/.cargo_vcs_info.json", "not json")),
      gzipSync(
        Buffer.concat([
          tarEntry(
            "example-1.2.3/.cargo_vcs_info.json",
            JSON.stringify({ git: { sha1: expectedSha, dirty: false } }),
          ),
          tarEntry(
            "example-1.2.3/.cargo_vcs_info.json",
            JSON.stringify({ git: { sha1: expectedSha, dirty: false } }),
          ),
          Buffer.alloc(1024),
        ]),
      ),
      gzipSync(
        tarFile(
          "example-1.2.3/.cargo_vcs_info.json",
          "x".repeat(64 * 1024 + 1),
        ),
      ),
      gzipSync(
        tarFile(
          "example-1.2.3/.cargo_vcs_info.json",
          JSON.stringify({ git: {} }),
        ),
      ),
    ];

    for (const archive of cases) {
      let requestCount = 0;
      await expect(
        observeCrateVersion({
          name: "example",
          version: "1.2.3",
          expectedSha,
          apiUrl: "https://registry.example/{name}/{version}",
          downloadUrl: "https://registry.example/{name}/{version}/download",
          fetch: async () => {
            requestCount += 1;
            return requestCount === 1 ? response(200) : response(200, archive);
          },
        }),
      ).resolves.toMatchObject({
        state: "conflicting",
        subject: "example@1.2.3",
      });
    }
  });

  test("enforces configured archive limits before parsing", async () => {
    const oversized = response(200, Buffer.from("archive"));
    oversized.headers.set("content-length", "100");
    const responses = [response(200), oversized];

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        maxArchiveBytes: 99,
        fetch: async () => responses.shift()!,
      }),
    ).resolves.toMatchObject({
      state: "conflicting",
      subject: "example@1.2.3",
    });

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        maxArchiveBytes: 0,
        fetch: async () => response(200),
      }),
    ).rejects.toThrow("maxArchiveBytes must be a positive safe integer");
  });

  test("uses the platform fetch by default and treats an empty archive response as conflicting", async () => {
    vi.stubGlobal("fetch", async () => response(404));
    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
      }),
    ).resolves.toEqual({ state: "missing", subject: "example@1.2.3" });

    const responses = [response(200), response(200)];
    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch: async () => responses.shift()!,
      }),
    ).resolves.toMatchObject({
      state: "conflicting",
      subject: "example@1.2.3",
    });
  });

  test("treats a 404 archive response and an archive request failure as transient", async () => {
    const archived404 = [() => response(200), () => response(404)];
    const archiveFailure = [
      async (): Promise<Response> => response(200),
      async (): Promise<Response> => {
        throw new Error("offline");
      },
    ];
    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch: async () => archived404.shift()!(),
      }),
    ).resolves.toMatchObject({
      state: "transient",
      subject: "example@1.2.3",
    });

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        fetch: async () => archiveFailure.shift()!(),
      }),
    ).resolves.toMatchObject({ state: "transient", subject: "example@1.2.3" });
  });

  test("bounds registry requests with an abort signal", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );

    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        requestTimeoutMilliseconds: 1,
        fetch,
      }),
    ).resolves.toMatchObject({
      state: "transient",
      subject: "example@1.2.3",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects an invalid request timeout", async () => {
    await expect(
      observeCrateVersion({
        name: "example",
        version: "1.2.3",
        expectedSha,
        apiUrl: "https://registry.example/{name}/{version}",
        downloadUrl: "https://registry.example/{name}/{version}/download",
        requestTimeoutMilliseconds: 0,
        fetch: async () => response(200),
      }),
    ).rejects.toThrow(
      "requestTimeoutMilliseconds must be a positive safe integer",
    );
  });
});
