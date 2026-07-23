# Cargo Release Reconcile

`cargo-release-reconcile` resumes a Cargo workspace release after partial
publication. It derives one immutable plan from the approved base and target
commits, observes crates.io before writing, verifies Cargo's recorded source
commit in every existing crate archive, and creates only the missing release
state.

The action delegates dependency ordering, packaging, and publication to native
Cargo. It does not add a release database, a dependency solver, or a
repository-specific workflow framework.

## Release composition

Use this action as the post-merge mechanism in a larger release workflow:

- [release-plz](https://github.com/release-plz/release-plz) can prepare and
  update the Release PR.
- [rust-lang/crates-io-auth-action](https://github.com/rust-lang/crates-io-auth-action)
  supplies a short-lived crates.io token through trusted publishing.
- Cargo 1.90 or newer performs one complete dry run and publishes the missing
  package set in dependency order.
- This action reconciles crate versions, annotated Git tags, and an optional
  public GitHub Release.
- The caller retains approval checks, protected environments, changelog policy,
  binary smoke tests, artifact distribution, and deployment triggers.

This division also works for server repositories. The action can publish the
server's Cargo packages and complete its GitHub release state, while tools such
as [cargo-dist](https://axodotdev.github.io/cargo-dist/book/) build and attach
platform artifacts after reconciliation succeeds.

## Recovery guarantees

The target commit is the desired source of truth. Before a mutation, the action
classifies each external object:

| State         | Meaning                                                                              | Result                                                              |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `matching`    | The object already matches the target commit and release plan.                       | Keep it unchanged.                                                  |
| `missing`     | The object does not exist.                                                           | Create it in `publish`, `finalize`, or `all`.                       |
| `repairable`  | A GitHub Release has the correct tag but safe mutable metadata differs.              | Update its title, notes, draft state, or explicit latest selection. |
| `conflicting` | Existing immutable state points at another commit or otherwise contradicts the plan. | Stop before further writes.                                         |
| `transient`   | crates.io or GitHub could not be observed reliably.                                  | Stop with a retryable report.                                       |

Each run submits a missing package set to Cargo at most once. The action then
polls crates.io without resubmitting that set, which avoids converting registry
indexing delay into an `already uploaded` error. A later workflow rerun observes
what succeeded and resumes from the remaining package set.

Finalization starts only after every planned crate version exists with the
expected Cargo-recorded commit. Tags are created next, and the optional GitHub
Release is created or repaired last. Concurrent tag or release creation is
safe because the action re-observes desired state after every mutation attempt.

## Configuration

Add `.github/cargo-release-reconcile.yml` to the consuming repository:

```yaml
tagTemplate: "{name}-v{version}"

packageOverrides:
  example-server:
    tagTemplate: "v{version}"

githubRelease:
  package: example-server
  nameTemplate: "Example Server {version}"
  notesFile: CHANGELOG.md
  notesHeadingTemplate: "## [Example Server {version}]"
  makeLatest: auto
```

The planner selects publishable workspace packages whose versions differ
between `base-sha` and `target-sha`. Packages with `publish = false` or a
registry list that excludes `crates-io` remain outside the plan. The optional
GitHub Release is included only when its configured package version changes, so
library-only releases reconcile crate tags without creating a product release.

Templates support `{name}` and `{version}`. `notesHeadingTemplate` identifies a
Markdown heading prefix, so a changelog heading can append a link or date. Set
`makeLatest` to `auto`, `true`, or `false`; `auto` uses GitHub's legacy
version and creation-date policy. GitHub's REST API does not expose the
persistent legacy decision, so the action delegates `auto` to GitHub on writes.
Explicit `true` and `false` settings are observed against the current latest
release and reconciled. A prerelease cannot set `makeLatest` to `true`.

## Workflow

The caller must check out the exact target commit with full history, provide
Cargo 1.90 or newer, and determine the approved base and target SHAs according
to its own release policy.

```yaml
permissions:
  contents: write
  id-token: write

steps:
  - name: Checkout approved release commit
    uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
    with:
      ref: ${{ inputs.target-sha }}
      fetch-depth: 0
      persist-credentials: false

  - name: Preflight release
    uses: ZcashFoundation/cargo-release-reconcile@<full-commit-sha>
    with:
      phase: check
      base-sha: ${{ inputs.base-sha }}
      target-sha: ${{ inputs.target-sha }}
      github-token: ${{ github.token }}

  - name: Generate release GitHub App token
    id: release-app
    uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
    with:
      app-id: ${{ secrets.RELEASE_APP_ID }}
      private-key: ${{ secrets.RELEASE_APP_PRIVATE_KEY }}

  - name: Authenticate to crates.io
    id: crates-io
    uses: rust-lang/crates-io-auth-action@c6f97d42243bad5fab37ca0427f495c86d5b1a18 # v1.0.5

  - name: Publish missing crates
    id: publish
    uses: ZcashFoundation/cargo-release-reconcile@<full-commit-sha>
    with:
      phase: publish
      base-sha: ${{ inputs.base-sha }}
      target-sha: ${{ inputs.target-sha }}
      github-token: ${{ steps.release-app.outputs.token }}
    env:
      CARGO_REGISTRY_TOKEN: ${{ steps.crates-io.outputs.token }}

  - name: Verify the published product
    run: cargo install --locked example-server --version "${{ inputs.version }}"

  - name: Finalize tags and GitHub Release
    id: finalize
    uses: ZcashFoundation/cargo-release-reconcile@<full-commit-sha>
    with:
      phase: finalize
      base-sha: ${{ inputs.base-sha }}
      target-sha: ${{ inputs.target-sha }}
      github-token: ${{ steps.release-app.outputs.token }}
```

Pin the action to a full commit SHA. GitHub treats a full SHA as the only
immutable action reference, and Dependabot can keep pinned actions current.
Use a GitHub App installation token or personal access token for finalization
when tag or release events must start downstream workflows. Events created with
the workflow's `GITHUB_TOKEN` do not normally create new workflow runs.

The checkout must be clean, and the local Git object database must contain
`base-sha` as an ancestor of `target-sha`. The action clones that object
database into a temporary directory to obtain base metadata without mutating
the caller's checkout. `config-path` is resolved from the current workflow
checkout, while `source-directory` and configured release-note files identify
the immutable release source. A recovery workflow can therefore run the current
action and policy against a separate historical source checkout.

## Inputs and outputs

| Input              | Required | Default                               | Description                                                 |
| ------------------ | -------- | ------------------------------------- | ----------------------------------------------------------- |
| `phase`            | No       | `all`                                 | `check`, `publish`, `finalize`, or `all`.                   |
| `source-directory` | No       | `.`                                   | Cargo workspace within the target checkout.                 |
| `base-sha`         | Yes      |                                       | Full commit SHA before the approved release change.         |
| `target-sha`       | Yes      |                                       | Full approved release commit SHA.                           |
| `config-path`      | No       | `.github/cargo-release-reconcile.yml` | Policy path relative to the current workflow checkout.      |
| `github-token`     | Yes      |                                       | Token used to observe tags and releases before every phase. |
| `attempts`         | No       | `3`                                   | Registry observations after one Cargo publication attempt.  |

The `plan` output contains the deterministic release plan as JSON. The `report`
output contains the final observations for the selected phase. A `complete`
report from `publish` means crate publication is complete; tags and the GitHub
Release can still be missing until `finalize` succeeds. A failed publication
report includes `operationError` when Cargo returned an error.

## Phases

| Phase      | Behavior                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| `check`    | Observe all state; if crates are missing, dry-run the complete Cargo plan.   |
| `publish`  | If needed, dry-run the complete plan, publish missing crates, then poll.     |
| `finalize` | Require every crate, then reconcile tags and the optional GitHub Release.    |
| `all`      | Publish missing crates and continue to finalization after crates.io matches. |

`check` exits successfully when desired state is incomplete because that is the
normal pre-release condition. Its JSON report uses `reason: "incomplete"` to
describe the missing objects. Contradictions, transient observation failures,
and Cargo dry-run failures still fail the step.

Product releases should use `publish`, run their repository-owned install or
runtime verification, and call `finalize` only after that gate succeeds. Use
`all` only when the caller has no required verification between publication
and tags or the public GitHub Release.

## Security boundary

The action accepts package identities only from Cargo metadata at the target
commit. It passes package names as argument-array elements rather than shell
source, bounds downloaded crate archives, parses them without extracting files,
and requires the archive's `.cargo_vcs_info.json` to record the target SHA
without a dirty source flag.

The crates.io token stays in `CARGO_REGISTRY_TOKEN` and is managed by the
official authentication action. The GitHub token is used only for repository
tag and release APIs. Callers should grant only `contents: write` and
`id-token: write`, preferably through a protected release environment.

## License

Licensed under the MIT License.
