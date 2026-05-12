#!/usr/bin/env bash
# Builds Resources/AppIcon.icns from Resources/AppIcon.svg using macOS
# system tools (qlmanage, sips, iconutil). Idempotent — skips rebuild if
# the .icns is newer than the .svg.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SVG="$PKG_DIR/Resources/AppIcon.svg"
ICNS="$PKG_DIR/Resources/AppIcon.icns"

if [[ ! -f "$SVG" ]]; then
    echo "error: icon source not found at $SVG" >&2
    exit 1
fi

if [[ -f "$ICNS" && "$ICNS" -nt "$SVG" ]]; then
    echo "==> $ICNS is up to date"
    exit 0
fi

echo "==> Rasterizing $SVG → 1024px master"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

qlmanage -t -s 1024 "$SVG" -o "$WORK" >/dev/null 2>&1
MASTER="$WORK/$(basename "$SVG").png"
if [[ ! -f "$MASTER" ]]; then
    echo "error: qlmanage did not produce $MASTER" >&2
    exit 1
fi

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"

# Each entry: "size filename"
ENTRIES=(
    "16 icon_16x16.png"
    "32 icon_16x16@2x.png"
    "32 icon_32x32.png"
    "64 icon_32x32@2x.png"
    "128 icon_128x128.png"
    "256 icon_128x128@2x.png"
    "256 icon_256x256.png"
    "512 icon_256x256@2x.png"
    "512 icon_512x512.png"
    "1024 icon_512x512@2x.png"
)

echo "==> Generating iconset tiles"
for entry in "${ENTRIES[@]}"; do
    size="${entry%% *}"
    name="${entry##* }"
    sips -z "$size" "$size" "$MASTER" --out "$ICONSET/$name" >/dev/null
done

echo "==> Compiling $ICNS"
iconutil -c icns "$ICONSET" -o "$ICNS"
echo "==> Done: $ICNS"
