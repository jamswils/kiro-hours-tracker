#!/usr/bin/env bash
# Build a distributable zip of KiroSessionsInspector.app. Output:
#   .build/dist/KiroSessionsInspector-<version>-arm64.zip
#
# Zip preserves extended attributes and code signatures when created with
# `ditto`, which is important so the bundle still launches after download.
#
# Usage:
#   scripts/make-zip.sh [version]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLIST="$PKG_DIR/Resources/Info.plist"
DEFAULT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null || echo "0.0.0")"
VERSION="${1:-$DEFAULT_VERSION}"

APP_NAME="KiroSessionsInspector"
DIST_DIR="$PKG_DIR/.build/dist"
BUNDLE_DIR="$PKG_DIR/.build/bundle"
APP_BUNDLE="$BUNDLE_DIR/$APP_NAME.app"
ZIP_PATH="$DIST_DIR/${APP_NAME}-${VERSION}-arm64.zip"

echo "==> Building app bundle"
"$SCRIPT_DIR/make-app-bundle.sh" "$BUNDLE_DIR"

echo "==> Creating $ZIP_PATH"
mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP_PATH"

echo "==> Done: $ZIP_PATH"
ls -lh "$ZIP_PATH"
