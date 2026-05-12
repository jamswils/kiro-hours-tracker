# Sharing the app with others

The project supports four distribution channels, ordered from least to most
friction for the recipient.

| Channel                        | Recipient effort        | You need                    |
| ------------------------------ | ----------------------- | --------------------------- |
| Signed + notarized `.dmg`      | Double-click install    | Apple Developer ID ($99/yr) |
| Ad-hoc signed `.dmg` or `.zip` | Right-click → Open once | Nothing                     |
| GitHub Release via CI          | Download link           | GitHub repo                 |
| Homebrew tap                   | `brew install`          | GitHub repo + tap repo      |

All artifacts target **macOS 14+ on arm64**.

## Local builds

```bash
cd macos-swift
make dmg          # .build/dist/KiroSessionsInspector-<version>-arm64.dmg
make zip          # .build/dist/KiroSessionsInspector-<version>-arm64.zip
make dist         # both
```

Version string comes from `CFBundleShortVersionString` in
`Resources/Info.plist`. Pass a custom value as the first argument:
`./scripts/make-dmg.sh 0.2.0`.

## Option 1 — GitHub Release (recommended for non-developers)

Workflow `.github/workflows/release.yml` builds, signs ad-hoc, and attaches
`.dmg` + `.zip` + `SHA256SUMS.txt` to a GitHub Release whenever you push a
`v*` tag.

```bash
# bump version in macos-swift/Resources/Info.plist first
git commit -am "Release v0.1.0"
git tag v0.1.0
git push && git push --tags
```

The release page becomes your download link: share that URL.

Because the bundle is ad-hoc signed (not notarized with an Apple Developer
ID), first-launch UX for recipients is:

1. Download and move `KiroSessionsInspector.app` to `/Applications`.
2. Right-click the app → **Open** → **Open**. (Gatekeeper allows the app
   after this one-time override.)

Or, from a terminal, strip the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/KiroSessionsInspector.app
```

Add a short note in your release description so recipients aren't surprised
by the "cannot verify developer" dialog.

## Option 2 — Homebrew tap (recommended for developers)

See [HOMEBREW.md](HOMEBREW.md). The formula builds from source on the
recipient's machine, so Gatekeeper isn't involved at all.

```bash
brew tap jamswils/kiro
brew install --HEAD kiro-sessions-inspector
```

## Option 3 — Signed + notarized (no Gatekeeper prompt)

This is the only option that launches without any warnings or right-click
dance. It requires a paid Apple Developer account and a "Developer ID
Application" certificate installed in your login keychain.

### One-time setup

1. Enroll at <https://developer.apple.com/programs/>.
2. In Xcode **Settings → Accounts → Manage Certificates**, create a
   _Developer ID Application_ certificate.
3. Create an app-specific password at <https://appleid.apple.com> and store
   the notary credentials in the keychain so `notarytool` can find them:

   ```bash
   xcrun notarytool store-credentials "AC_PASSWORD" \
       --apple-id "you@example.com" \
       --team-id "ABCDE12345" \
       --password "app-specific-password"
   ```

### Signed build

Replace the ad-hoc signing line in `scripts/make-app-bundle.sh`:

```bash
# Replace:
codesign --force --sign - "$APP_BUNDLE"
# With:
codesign --force --deep --options runtime \
    --sign "Developer ID Application: Your Name (TEAMID)" \
    "$APP_BUNDLE"
```

Then notarize the `.dmg`:

```bash
make dmg
xcrun notarytool submit .build/dist/KiroSessionsInspector-*.dmg \
    --keychain-profile "AC_PASSWORD" --wait
xcrun stapler staple .build/dist/KiroSessionsInspector-*.dmg
```

After stapling, the DMG launches cleanly on any Mac with no right-click
workaround.

### Wiring into CI

To notarize from GitHub Actions, add these secrets to the repo:

- `BUILD_CERTIFICATE_BASE64` — p12 of the Developer ID Application cert
- `P12_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `NOTARY_APPLE_ID`, `NOTARY_TEAM_ID`, `NOTARY_PASSWORD`

Then extend `release.yml` to import the cert into a temporary keychain and
run `notarytool submit --wait` before uploading. Happy to add that
workflow once the Developer ID is in place.

## Which should I pick?

- **Just sharing with a few teammates?** GitHub Release `.dmg`. Works
  today, no cost, one right-click on first launch.
- **Publishing publicly, want zero friction?** Developer ID + notarization.
- **Users are developers with Xcode installed?** Homebrew tap.
