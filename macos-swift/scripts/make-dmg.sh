#!/usr/bin/env bash
# Build a distributable .dmg containing KiroSessionsInspector.app and an
# Applications shortcut. Output:
#   .build/dist/KiroSessionsInspector-<version>-arm64.dmg
#
# Usage:
#   scripts/make-dmg.sh [version]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Prefer CFBundleShortVersionString from Info.plist as the source of truth.
PLIST="$PKG_DIR/Resources/Info.plist"
DEFAULT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null || echo "0.0.0")"
VERSION="${1:-$DEFAULT_VERSION}"

APP_NAME="KiroSessionsInspector"
DIST_DIR="$PKG_DIR/.build/dist"
STAGE_DIR="$PKG_DIR/.build/dmg-stage"
BUNDLE_DIR="$PKG_DIR/.build/bundle"
APP_BUNDLE="$BUNDLE_DIR/$APP_NAME.app"
DMG_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-arm64.dmg"

echo "==> Building app bundle"
"$SCRIPT_DIR/make-app-bundle.sh" "$BUNDLE_DIR"

echo "==> Staging DMG contents at $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -R "$APP_BUNDLE" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"

echo "==> Creating $DMG_PATH"
mkdir -p "$DIST_DIR"
rm -f "$DMG_PATH"
hdiutil create \
    -volname "$APP_NAME" \
    -srcfolder "$STAGE_DIR" \
    -fs HFS+ \
    -format UDZO \
    -ov \
    "$DMG_PATH" >/dev/null

echo "==> Done: $DMG_PATH"
ls -lh "$DMG_PATH"
