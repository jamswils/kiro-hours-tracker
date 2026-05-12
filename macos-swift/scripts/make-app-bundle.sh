#!/usr/bin/env bash
# Assembles a KiroSessionsInspector.app bundle from a release `swift build`.
#
# Usage:
#   scripts/make-app-bundle.sh [output-dir]
#
# Output:
#   <output-dir>/KiroSessionsInspector.app

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="${1:-$PKG_DIR/.build/bundle}"
APP_NAME="KiroSessionsInspector"
APP_BUNDLE="$OUT_DIR/$APP_NAME.app"

echo "==> Building release binary"
(cd "$PKG_DIR" && swift build -c release)

BIN_PATH="$(cd "$PKG_DIR" && swift build -c release --show-bin-path)/$APP_NAME"
if [[ ! -x "$BIN_PATH" ]]; then
    echo "error: release binary not found at $BIN_PATH" >&2
    exit 1
fi

echo "==> Assembling $APP_BUNDLE"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

cp "$BIN_PATH" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cp "$PKG_DIR/Resources/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

# Build or refresh the .icns next to the SVG, then copy it into the bundle.
"$SCRIPT_DIR/make-icon.sh"
cp "$PKG_DIR/Resources/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"

# Ad-hoc codesign so Gatekeeper / LaunchServices treats the bundle as valid.
# Without this, `open` on a fresh bundle can fail with "damaged" errors.
codesign --force --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true

echo "==> Done: $APP_BUNDLE"
