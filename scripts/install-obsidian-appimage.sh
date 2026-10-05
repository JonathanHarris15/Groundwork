#!/usr/bin/env bash
# Download and extract the Obsidian Linux AppImage for real-plugin e2e (scripts/obsidian-plugin-e2e.mjs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${OBSIDIAN_VERSION:-1.13.7}"
INSTALL_DIR="${GROUNDWORK_OBSIDIAN_INSTALL_DIR:-$ROOT/tmp/obsidian-install}"
BIN="$INSTALL_DIR/squashfs-root/obsidian"

if [[ -x "$BIN" ]]; then
	echo "$BIN"
	exit 0
fi

mkdir -p "$INSTALL_DIR"
APPIMAGE="$INSTALL_DIR/Obsidian-${VERSION}.AppImage"
URL="https://github.com/obsidianmd/obsidian-releases/releases/download/v${VERSION}/Obsidian-${VERSION}.AppImage"

if [[ ! -f "$APPIMAGE" ]]; then
	echo "Downloading Obsidian ${VERSION} AppImage…" >&2
	if ! curl -fsSL --retry 3 --retry-delay 5 -o "$APPIMAGE" "$URL"; then
		echo "Failed to download Obsidian AppImage from $URL" >&2
		exit 1
	fi
	chmod +x "$APPIMAGE"
fi

(
	cd "$INSTALL_DIR"
	./"Obsidian-${VERSION}.AppImage" --appimage-extract >/dev/null
)

if [[ ! -x "$BIN" ]]; then
	echo "Obsidian extract did not produce $BIN" >&2
	exit 1
fi

echo "$BIN"
