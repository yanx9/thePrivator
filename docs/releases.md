# Automated builds and releases

The Release workflow builds Windows x86-64 EXE/MSI, macOS Apple Silicon and Intel
DMGs, Linux x86-64 DEB/RPM/AppImage, and an Arch x86-64 package plus its PKGBUILD.
Each platform packs its own Python runtime; builds cannot share that executable.

## Triggers

| Event | Result |
| --- | --- |
| Push to `master` or a `3.*` branch | Publish a development prerelease after every required job succeeds |
| Push a `vX.Y.Z` tag | Publish a stable release; the tag must match the application version |
| Push a version tag containing a prerelease suffix | Publish a prerelease and leave stable AUR unchanged |
| PR changing release tooling | Build and test installers, without publishing |
| Actions → Release → Run workflow → `artifacts` | Build all packages for testing, without publishing |
| Manual `nightly` | Publish a development prerelease from the selected ref |
| Manual `release` | Publish the matching version; optional existing tag selects the source |

The source SHA is resolved once and reused by all jobs. Development tags include
the workflow run ID, attempt and SHA. Their application version remains the
version in the source tree; the release manifest identifies the exact build.
Development Arch packages use the separate name `theprivator-preview-bin`.

Update `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json` and `CHANGELOG.md` together
before creating a stable tag. `node scripts/verify-release.mjs vX.Y.Z` checks this.

## Publication guarantees

The build jobs have read-only repository permissions. Only the final publication
job has `contents: write`, using GitHub's built-in `GITHUB_TOKEN`; no PAT is needed.
Frontend, Python and Rust tests run before packaging. Linux also runs the real
Chromium regressions using Chrome for Testing, which supports loading the test
extensions. The packaged Python runtime is tested, including the runtime
extracted from the Arch package. Every expected installer must exist and be nonempty.
Individual Python tests have a 120-second timeout. Tests that require POSIX shell
executables and signal delivery are explicitly skipped on Windows; portable tests
and the packaged Windows runtime still run there.

The final job creates `SHA256SUMS` and `release-manifest.json`, uploads the complete
asset set to a draft, then publishes. Failed uploads leave a draft that can be
retried. A rerun refuses to overwrite an already published release. Development
releases never replace GitHub's latest stable release. Build artifacts are retained
for 14 days; published release assets are separate from that retention policy.

This publishes installers. It does not install updates automatically on users' machines.

## Signing

Without signing credentials, Windows installers are unsigned and macOS uses an
ad-hoc signature. These builds can be tested but may require an operating-system
security exception. Full signing can be enabled through repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that certificate |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_PASSWORD` | Apple app-specific password |
| `APPLE_TEAM_ID` | Apple developer team ID |
| `WINDOWS_CERTIFICATE` | Optional base64-encoded code-signing PFX usable by the runner |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for that PFX |

Tauri imports the Apple identity before its build hook. The hook signs the Python
runtime with the same identity before bundling. Windows imports the PFX only for
the job and removes it afterwards. Hardware/cloud-backed Windows signing services
need their own provider integration instead of the optional PFX path.

See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and
[Windows signing](https://v2.tauri.app/distribute/sign/windows/).

## Arch and AUR

Every build generates `PKGBUILD`, `.SRCINFO` and the license in a recipe archive.
The recipe pins the exact release URL and SHA-256 of the DEB produced in the same
run. It is tested with `makepkg` in an Arch container; the resulting `.pkg.tar.zst`
and recipe archive are included in the release. The template is
`packaging/arch/PKGBUILD.in`; generated version/checksum files are release artifacts.

To enable automatic AUR updates for stable releases:

1. Create an AUR account and arrange maintainer access to `theprivator-bin`.
2. Add a dedicated SSH public key to that AUR account.
3. Store the private key as the GitHub Actions secret `AUR_SSH_PRIVATE_KEY`.
4. Set repository variable `AUR_KNOWN_HOSTS` to the verified SSH host-key entry for
   `aur.archlinux.org` (check it against Arch's published host-key fingerprints).
5. Set repository variable `AUR_PUBLISH` to `true`.

The AUR job runs after GitHub publication, so its download URL already exists.
It pushes only the tested stable recipe to `theprivator-bin`, using strict SSH
host verification. An AUR failure does not remove the GitHub release; retry the
failed AUR job after correcting access. Leave `AUR_PUBLISH` unset to publish the
recipe as a release asset without pushing to AUR.
An older stable build finishing late cannot downgrade the current AUR version.

## Local checks

```sh
python -m unittest discover -s tests/release -p 'test_*.py'
node --test tests/release/publish.node.cjs
bash scripts/release/check-workflows.sh
```

The workflow checker downloads a pinned actionlint binary and checks its SHA-256
before execution. The checker runs on Linux x86-64. Full Windows/macOS packaging
must be verified on their respective GitHub runners.
