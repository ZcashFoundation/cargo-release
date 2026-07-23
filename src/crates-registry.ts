import { Parser } from "tar";

import type { Observation } from "./reconcile.js";

const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_PROVENANCE_BYTES = 64 * 1024;

export interface ObserveCrateVersionInput {
  /** The exact package identity to look up. */
  name: string;
  version: string;
  /** The full Git commit SHA expected in the published crate provenance. */
  expectedSha: string;
  /** URL template with `{name}` and `{version}` placeholders for the package API. */
  apiUrl: string;
  /** URL template with `{name}` and `{version}` placeholders for the crate archive. */
  downloadUrl: string;
  fetch?: typeof globalThis.fetch;
  maxArchiveBytes?: number;
  requestTimeoutMilliseconds?: number;
}

function subjectFor(name: string, version: string): string {
  return `${name}@${version}`;
}

function endpoint(template: string, name: string, version: string): string {
  return template
    .replaceAll("{name}", encodeURIComponent(name))
    .replaceAll("{version}", encodeURIComponent(version));
}

function transient(subject: string, detail: string): Observation {
  return { state: "transient", subject, detail };
}

function statusObservation(
  subject: string,
  response: Response,
  allowMissing: boolean,
): Observation | undefined {
  if (response.status === 404 && allowMissing)
    return { state: "missing", subject };
  if (response.status === 429 || response.status >= 500 || !response.ok) {
    return transient(subject, `registry returned HTTP ${response.status}`);
  }
  return undefined;
}

async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximum) {
    throw new RangeError(`archive exceeds the ${maximum}-byte limit`);
  }

  if (response.body === null) return Buffer.alloc(0);

  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new RangeError(`archive exceeds the ${maximum}-byte limit`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function readProvenance(
  archive: Buffer,
  expectedRoot: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let provenance: Buffer | undefined;
    let provenanceError: Error | undefined;
    const parser = new Parser({
      strict: true,
      maxDecompressionRatio: 100,
      onReadEntry(entry) {
        if (
          entry.path !== `${expectedRoot}/.cargo_vcs_info.json` ||
          entry.type !== "File"
        ) {
          entry.resume();
          return;
        }
        if (provenance !== undefined || entry.size > MAX_PROVENANCE_BYTES) {
          provenanceError = new Error(
            "archive has invalid .cargo_vcs_info.json provenance",
          );
          entry.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        entry.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length <= MAX_PROVENANCE_BYTES) chunks.push(chunk);
        });
        entry.on("end", () => {
          provenance = Buffer.concat(chunks);
        });
        entry.resume();
      },
    });
    parser.once("error", reject);
    parser.once("end", () => {
      if (provenanceError !== undefined) {
        reject(provenanceError);
        return;
      }
      if (provenance === undefined) {
        reject(new Error("archive has no .cargo_vcs_info.json provenance"));
        return;
      }
      try {
        resolve(JSON.parse(provenance.toString("utf8")));
      } catch {
        reject(new Error("archive provenance is not valid JSON"));
      }
    });
    parser.end(archive);
  });
}

function hasExpectedProvenance(value: unknown, expectedSha: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const git = (value as { git?: unknown }).git;
  if (typeof git !== "object" || git === null) return false;
  const record = git as { sha1?: unknown; dirty?: unknown };
  return (
    record.sha1 === expectedSha &&
    (record.dirty === undefined || record.dirty === false)
  );
}

/**
 * Observe a single published crate without extracting its untrusted archive to disk.
 */
export async function observeCrateVersion(
  input: ObserveCrateVersionInput,
): Promise<Observation> {
  const subject = subjectFor(input.name, input.version);
  const request = input.fetch ?? globalThis.fetch;
  const maximum = input.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const requestTimeoutMilliseconds =
    input.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("maxArchiveBytes must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(requestTimeoutMilliseconds) ||
    requestTimeoutMilliseconds <= 0
  ) {
    throw new RangeError(
      "requestTimeoutMilliseconds must be a positive safe integer",
    );
  }

  let packageResponse: Response;
  try {
    packageResponse = await request(
      endpoint(input.apiUrl, input.name, input.version),
      { signal: AbortSignal.timeout(requestTimeoutMilliseconds) },
    );
  } catch {
    return transient(subject, "registry package lookup failed");
  }
  const packageStatus = statusObservation(subject, packageResponse, true);
  if (packageStatus !== undefined) return packageStatus;

  let archiveResponse: Response;
  try {
    archiveResponse = await request(
      endpoint(input.downloadUrl, input.name, input.version),
      { signal: AbortSignal.timeout(requestTimeoutMilliseconds) },
    );
  } catch {
    return transient(subject, "crate archive download failed");
  }
  const archiveStatus = statusObservation(subject, archiveResponse, false);
  if (archiveStatus !== undefined) return archiveStatus;

  let archive: Buffer;
  try {
    archive = await boundedBody(archiveResponse, maximum);
  } catch (error) {
    return error instanceof RangeError
      ? { state: "conflicting", subject, detail: error.message }
      : transient(subject, "crate archive download failed");
  }

  let provenance: unknown;
  try {
    provenance = await readProvenance(
      archive,
      `${input.name}-${input.version}`,
    );
  } catch (error) {
    return {
      state: "conflicting",
      subject,
      detail:
        error instanceof Error
          ? error.message
          : "crate archive provenance is invalid",
    };
  }
  if (hasExpectedProvenance(provenance, input.expectedSha)) {
    return { state: "matching", subject };
  }
  return {
    state: "conflicting",
    subject,
    detail:
      "crate archive provenance does not match the expected clean source commit",
  };
}
