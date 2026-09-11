# Releasing

Tagging is the whole process. Everything else on this page is either bumping a
number beforehand or checking the result afterwards.

## 1. Bump the version

Three files, and they must agree — `tauri-action` names the artifacts from
`tauri.conf.json`, while the Homebrew cask and Scoop manifest are matched to the
tag:

| File                        | Field                       |
| --------------------------- | --------------------------- |
| `package.json`              | `"version"`                 |
| `src-tauri/tauri.conf.json` | `"version"`                 |
| `src-tauri/Cargo.toml`      | `version` under `[package]` |

Then `bun install` and `(cd src-tauri && cargo build)` so both lockfiles pick up
the new number, and run the six checks from
[CONTRIBUTING.md](../CONTRIBUTING.md).

## 2. Tag and push

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag is what triggers `.github/workflows/release.yml`. It builds four
bundles — Apple silicon, Intel Mac, Windows, Linux — and attaches them to a
**draft** release.

## 3. Review the draft, then publish

Look at the draft on the Releases page before publishing:

- All four platforms' assets present. A failed matrix leg leaves a gap rather
  than failing the release.
- The filenames carry the version you meant.
- The release notes read the way you want; the workflow supplies a default.

Publishing is the point of no return for anyone watching the repo, so download
one asset and open it first.

## 4. Update the tap and the bucket

Users on Homebrew and Scoop get nothing until the manifests move.

**By hand** — for each repository, set the version and paste the checksum from
the Release page:

```bash
# checksums for the assets you just published
gh release download v0.2.0 --pattern '*.dmg' --pattern '*-setup.exe' --dir /tmp/rel
shasum -a 256 /tmp/rel/*
```

- `ronny1020/homebrew-tap` → `Casks/muster.rb`: `version`, `sha256 arm:`,
  `sha256 intel:`
- `ronny1020/scoop-bucket` → `bucket/muster.json`: `version`, the `64bit.hash`,
  and the version inside `64bit.url`

Templates for both live in [`dist-packaging/`](../dist-packaging), and are the
right thing to copy when first creating those repositories.

**Automatically** — `.github/workflows/update-packages.yml` does exactly the
above on `release: published`. It ships disabled; its header comment lists the
three steps to turn it on (create the two repositories, add a `PACKAGES_PAT`
secret, delete the `if: false`).

## Signing, later

Nothing is signed today, which is a deliberate cost decision, not an oversight.
Two upgrade paths when there are users to justify them:

- **Windows** — apply to the [SignPath Foundation](https://signpath.org/), which
  signs open-source projects for free. Once accepted, their action signs the
  NSIS installer and SmartScreen stops warning.
- **macOS** — an Apple Developer Program membership (currently $99/year) buys a
  Developer ID certificate and notarization. Add `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` and `APPLE_TEAM_ID` as repository secrets, and replace
  `signingIdentity: "-"` in `tauri.conf.json` with the real identity.

Both are drop-in: the release workflow does not change shape, and the README's
"Why the warnings" section is what gets deleted.
