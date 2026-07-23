# Security

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Follow the Zcash
Foundation's [security policy](https://zfnd.org/security/) to report it
privately, and include the affected action commit, workflow permissions, and
the smallest reproduction you can provide.

## Supported versions

Before the first stable release, only the latest commit on the default branch
receives security fixes. Consumers should pin an audited full commit SHA and
use Dependabot to propose updates. Tagged releases, created with the process in
[docs/RELEASING.md](docs/RELEASING.md), mark audited commits to pin.

## Verifying the bundled action

Every push to the default branch publishes a build-provenance attestation for
the committed `dist/index.js` bundle. From a checkout of the commit you intend
to pin, run:

```sh
gh attestation verify dist/index.js --repo ZcashFoundation/cargo-release
```
