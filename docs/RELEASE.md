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
the new number, and run `bun run check:all` — every check
[CONTRIBUTING.md](../CONTRIBUTING.md) lists, so the count here cannot go stale
again.

## 2. Tag and push

```bash
git tag v0.2.0
git push origin v0.2.0
```

The tag is what triggers `.github/workflows/release.yml`. It builds four
bundles — Apple silicon, Intel Mac, Windows, Linux — and attaches them to a
**draft** release.

The same workflow runs on every pull request as a rehearsal: it builds the same
four bundles, creates no release, and attaches them to the run instead. So a
bundle that cannot build is a failed pull request rather than a tag that has to
be deleted and re-pushed.

If a release run fails halfway, re-run it from the Actions tab rather than
re-cutting the tag — tick **Cut a draft release** and give it the tag:

```bash
gh workflow run release.yml -f release=true -f tag=v0.2.1
```

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
above on `release: published`, which makes step 4 nothing at all. It needs one
secret, `PACKAGES_PAT`: a fine-grained token with Contents read and write on
`ronny1020/homebrew-tap` and `ronny1020/scoop-bucket` only. Without it the
checkout steps fail and the manifests stay where they are.

For a release whose event has already passed — one published before the secret
existed, or a run that failed — trigger it by hand:

```bash
gh workflow run update-packages.yml -f version=v0.2.1
gh run watch "$(gh run list --workflow=update-packages.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

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
