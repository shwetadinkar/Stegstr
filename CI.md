# CI and buildability

## Workflows

| Workflow | File | What it does |
|----------|------|--------------|
| **Build Stegstr** | `build.yml` | Desktop Tauri app on macOS, Ubuntu, Windows. Uploads artifacts per platform. |
| **Release Stegstr** | `release.yml` | Desktop Tauri on macOS/Ubuntu/Windows; DMG (macOS), exe/msi (Windows), deb/AppImage (Linux); creates the GitHub Release with stable-named assets and `SHA256SUMS`. |
| **Deploy web app** | `pages.yml` | Builds the browser app and publishes it to the `gh-pages` branch. |
| **Lint workflows** | `lint-workflows.yml` | actionlint over `.github/workflows`. |
| **Claude Code Review** | `claude-review.yml` | Automated review on pull requests. |
| **Clean up failed workflow runs** | `cleanup-failed-runs.yml` | Housekeeping for the Actions run history. |

All workflows live in `.github/workflows/`.

> This table previously listed four Android and iOS workflows under
> `mobile-android/.github/workflows/`. **None of them exist** — `mobile-android/`
> is an empty directory inherited from upstream and is not tracked by git. It
> also omitted four workflows that do exist. Both corrected.

## Buildability rules

- **Desktop release runs on Windows.** Any step in `.github/workflows/release.yml` (or any job that uses `windows-latest`) whose `run:` script uses bash syntax must set **`shell: bash`**. See [.github/workflows/README.md](.github/workflows/README.md) for the shell convention.
- **Releases must target the fork's own commit.** `action-gh-release` creates a missing tag on the *default* branch, which once produced a release tagged against upstream's code rather than this fork's. Pass `target_commitish` explicitly.
- **The web app deploys by branch, not by the Pages environment.** `actions/deploy-pages` fails at job setup on a fork, before any step runs, so the log shows nothing useful. `pages.yml` publishes to `gh-pages` directly.

## Optional: macOS code signing and notarization

Without an Apple Developer account, the macOS .dmg is unsigned and not notarized. Users see Gatekeeper dialogs the first time they open Stegstr (they can use **Right-click → Open** or **System Settings → Privacy & Security → Open Anyway**). The downloads page documents this.

To **remove those dialogs**, you need a paid [Apple Developer Program](https://developer.apple.com/programs/) membership (~$99/year). Then you can sign and notarize the macOS build in CI so the .dmg opens without security popups.

### Setup

1. **Create a Developer ID Application certificate** in [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list) (Account Holder only). Export it as a .p12 from Keychain Access (certificate + private key), set a password, and encode for CI: `base64 -i YourCert.p12 -o cert-base64.txt`
2. **Create an app-specific password** at [appleid.apple.com](https://appleid.apple.com/account/manage) → Sign-in and Security → App-Specific Passwords.
3. **Get your Team ID** from [Membership](https://developer.apple.com/account#MembershipDetailsCard).

### GitHub Actions secrets

Add these repository secrets (Settings → Secrets and variables → Actions). Only when **all** are set and `APPLE_SIGNING_ENABLED` is `true` will the release workflow sign and notarize the macOS build.

| Secret | Description |
|--------|-------------|
| `APPLE_SIGNING_ENABLED` | Set to `true` to enable signing and notarization (omit or leave empty to keep building unsigned macOS .dmg). |
| `APPLE_CERTIFICATE` | Base64-encoded .p12 file (contents of cert-base64.txt). |
| `APPLE_CERTIFICATE_PASSWORD` | Password you set when exporting the .p12. |
| `KEYCHAIN_PASSWORD` | Any strong password; used for the temporary CI keychain. |
| `APPLE_SIGNING_IDENTITY` | Full identity string, e.g. `Developer ID Application: Your Name (TEAMID)`. Find with `security find-identity -v -p codesigning` after importing the cert. |
| `APPLE_ID` | Your Apple ID email. |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password from step 2. |
| `APPLE_TEAM_ID` | Your Team ID from step 3. |

After pushing a release, the macOS artifact will be signed and notarized; users can open the .dmg and run Stegstr without Gatekeeper dialogs.
