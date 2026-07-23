# Releasing Cargo Release

This runbook describes how maintainers publish a tagged release of this action.
Consumers always pin a full commit SHA; a tag marks which commits have been
audited and released.

## How `dist/` stays trustworthy

The action executes the committed `dist/index.js` bundle, not `src/`. Three
controls keep the bundle honest:

1. Every PR and push to `main` rebuilds the bundle with `npm run build` and
   fails CI if the committed `dist/` differs from the rebuilt output
   (`.github/workflows/ci.yml`, "Check bundled action").
2. Every push to `main` re-verifies reproducibility and publishes a SLSA
   build-provenance attestation for `dist/index.js`
   (`.github/workflows/attest.yml`).
3. The release workflow re-runs the same reproducibility check before creating
   a tag (`.github/workflows/release.yml`).

A PR that changes `src/` or dependencies must therefore also commit the
matching rebuilt `dist/` (run `npm run build` locally before pushing).

## Release steps

1. Confirm the target commit is on `main` with all CI workflows green,
   including "Attest bundled action".
2. From a clean checkout of the target commit, verify the attestation:

   ```sh
   gh attestation verify dist/index.js --repo ZcashFoundation/cargo-release
   ```

3. Run the "Release" workflow (`workflow_dispatch` on `main`) with the version
   input in `vMAJOR.MINOR.PATCH` form. The workflow validates the version
   format, re-checks that `dist/` is reproducible from `src/`, creates an
   annotated tag pointing at the release commit, and publishes a GitHub
   Release with generated notes.
4. Announce the released full commit SHA. Consumers pin that SHA, not the tag
   (see `SECURITY.md`).

## Version policy

Use SemVer. Before v1.0.0, breaking changes to inputs, outputs, or the config
schema bump the minor version and must be called out in the release notes.
