#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.pshkrh.pulse-deck.sdPlugin"
TARGET_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.pshkrh.pulse-deck.sdPlugin"
# Remove previous install path from the old UUID/folder naming.
LEGACY_TARGET="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.pshkrh.system-vitals.sdPlugin"

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "Plugin directory not found: $PLUGIN_DIR" >&2
  exit 1
fi

npm --prefix "$PLUGIN_DIR" install

mkdir -p "$(dirname "$TARGET_DIR")"
rm -rf "$LEGACY_TARGET" || true

if command -v rsync >/dev/null 2>&1; then
  mkdir -p "$TARGET_DIR"
  rsync -a --delete "$PLUGIN_DIR/" "$TARGET_DIR/"
else
  rm -rf "$TARGET_DIR" || true
  cp -R "$PLUGIN_DIR" "$TARGET_DIR"
fi

echo "Pulse Deck installed to:"
echo "  $TARGET_DIR"
echo "Restart Stream Deck to load the latest build."
