# TODO: Reduce runtime dependencies to `tar` + `yaml`

Status: proposed, not yet implemented.

## Rationale

The executed artifact of this action is the committed `dist/index.js`
(~900 KB minified), bundled by `@vercel/ncc` from `src/` plus 30
runtime-reachable npm packages. A 2026-07 security review found no
vulnerabilities in the source, but the bundle size makes human review of the
actual shipped artifact impractical, and every bundled package is build-time
supply-chain surface for software on the critical path of Rust releases.

Of the 30 runtime packages, 17 (the `@octokit/*` stack, `undici`,
`before-after-hook`, `universal-user-agent`, `content-type`,
`json-with-bigint`) enter solely via `@actions/github`, which the code uses
for exactly 8 REST endpoints. `@actions/core` and `@actions/exec` add
`@actions/http-client`, `@actions/io`, `tunnel`, and a second `undici`, and
are used for a handful of trivial wrappers. All of this usage is already
isolated behind adapters in `src/main.ts` — no other file imports any
`@actions/*` package — so replacement is a `main.ts`-only change.

Target end state: runtime dependencies are `tar` and `yaml` only
(~8 packages including transitives), and the dist bundle shrinks roughly 10x,
making bundle diffs reviewable.

## Replacements

### `@actions/core` (~35 lines)

Used only in `src/main.ts`: `getInput` (7 sites), `setSecret`, `setOutput`
(2 sites), `setFailed`.

- `getInput(name, {required})`: read `process.env["INPUT_" + name.toUpperCase().replace(/ /g, "_")]`,
  trim, throw when required and empty. Note the existing
  `delete process.env["INPUT_GITHUB-TOKEN"]` shows the convention.
- `setOutput(name, value)`: append to the file named by `$GITHUB_OUTPUT` as
  `name<<DELIM\nvalue\nDELIM\n`. The delimiter MUST be unpredictable
  (`crypto.randomUUID()`) so output values cannot inject additional outputs.
- `setSecret(value)`: print `::add-mask::<value>` on its own line.
- `setFailed(message)`: print `::error::<message>` (escape `%`, `\r`, `\n` as
  `%25`, `%0D`, `%0A`) and set `process.exitCode = 1`.

Dropping `@actions/core` also drops `@actions/http-client`, `@actions/io`,
`tunnel`, and `undici` from the tree.

### `@actions/exec` (~30 lines)

Used only in `src/main.ts`, already behind port interfaces:

- `exec.exec(command, args, { cwd, ignoreReturnCode: true })`
  (`src/main.ts`, cargo publish adapter): `node:child_process` `spawn` with
  `stdio: "inherit"`, resolve with the exit code.
- `exec.getExecOutput(command, args, { cwd, ignoreReturnCode: true, silent: true })`
  (`src/main.ts`, `workspacePlanPorts().run`): `spawn` capturing stdout/stderr
  into strings, resolve `{ exitCode, stdout, stderr }`.

Never pass a shell: keep argv arrays exactly as today.

### `@actions/github` (~120 lines)

Replace `getOctokit` and `github.context.repo` in the `githubApi()` adapter
(`src/main.ts`) with a fetch-based client for exactly these endpoints:

| Adapter method       | Request                                      |
| -------------------- | -------------------------------------------- |
| `getRef`             | `GET /repos/{o}/{r}/git/ref/tags/{tag}`      |
| `getAnnotatedTag`    | `GET /repos/{o}/{r}/git/tags/{sha}`          |
| `createAnnotatedTag` | `POST /repos/{o}/{r}/git/tags`               |
| `createRef`          | `POST /repos/{o}/{r}/git/refs`               |
| `getReleaseByTag`    | `GET /repos/{o}/{r}/releases/tags/{tag}`     |
| `getLatestRelease`   | `GET /repos/{o}/{r}/releases/latest`         |
| `createRelease`      | `POST /repos/{o}/{r}/releases`               |
| `updateRelease`      | `PATCH /repos/{o}/{r}/releases/{release_id}` |

Requirements:

- **Error contract (MUST preserve):** thrown errors carry a numeric `status`
  property. `statusOf` in `src/github-state.ts` maps 404 to `missing` and
  429/5xx to `transient`; `getLatestRelease` in `src/main.ts` swallows 404.
  Throw a small `class GithubRequestError extends Error { status: number }`
  on any non-2xx response.
- Headers: `Authorization: Bearer <token>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  and an explicit `User-Agent` (mirror `cratesIoFetch` in `src/main.ts`).
- Base URL from `process.env.GITHUB_API_URL`, defaulting to
  `https://api.github.com`. Owner/repo from `process.env.GITHUB_REPOSITORY`
  (`owner/repo`), failing loudly when absent.
- Path segments through `encodeURIComponent`, following the pattern in
  `src/crates-registry.ts` (`crateUrl`).
- Keep the existing `AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MILLISECONDS)`
  per request.
- Never include the token, request headers, or response bodies in error
  messages (only status code and a short context string).

### `semver` (~25 lines)

Three call sites, no range logic:

- `valid(version)` — `src/release-plan.ts` (reject invalid package versions)
- `prerelease(version)` — `src/release-plan.ts` (default release channel)
- `gte(version, "1.90.0")` — `src/workspace-plan.ts` (Cargo version gate)

Implement with the official SemVer regex (semver.org) plus a numeric-tuple
comparison for `gte`. `@types/semver` leaves devDependencies at the same time.

## Keep

- **`tar`**: the streaming `Parser` in `src/crates-registry.ts` parses
  untrusted crates.io archives in memory with `strict: true` and
  `maxDecompressionRatio` as a zip-bomb guard. Hand-rolling a tar parser and
  decompression bomb guard for untrusted input would be a security regression,
  not an improvement. Its transitive tree is 5 small packages.
- **`yaml`**: zero transitive dependencies; the config format stays YAML
  (decided 2026-07). Parsed output is already strictly allow-list validated in
  `src/workspace-plan.ts`.

## Test strategy

The ports/adapter architecture means existing unit tests inject fakes and are
unaffected. Add unit tests for the new adapters:

- input parsing (env-var naming, `required`, trimming),
- `GITHUB_OUTPUT` writing (random delimiter, multiline values),
- workflow-command escaping in `setFailed`/`setSecret`,
- error `status` mapping (404, 429, 5xx, network errors) in the fetch client,
- child-process wrappers (exit codes, output capture).

`.github/workflows/hosted-smoke.yml` already exercises the real bundle
end-to-end and asserts on `plan`/`report` outputs, which covers the
`GITHUB_OUTPUT` and exec replacements in a real runner.

## Risks

- `GITHUB_OUTPUT` heredoc delimiters must be unpredictable per write
  (`crypto.randomUUID()`), or a crafted value could inject extra outputs.
- The fetch client loses Octokit's automatic retries. The reconciler already
  classifies 429/5xx/network failures as `transient` and re-observes
  (`src/github-state.ts`), so retry behavior is preserved at the architecture
  level; verify this in the smoke test.
- `isNetworkError` in `src/github-state.ts` matches undici error codes
  (`UND_ERR_*`); global `fetch` in Node 24 is undici, so the list still
  applies — confirm when implementing.
- Expected tree after the cut: `tar`, `@isaacs/fs-minipass`, `chownr`,
  `minipass`, `minizlib`, `yallist`, `yaml` (+ dev-only packages). Update
  `package.json`, run `npm install` to refresh the lock file, and confirm
  `npm ls --omit=dev` matches this list.
