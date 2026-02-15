#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.pshkrh.pulse-deck.sdPlugin"
DIST_DIR="$ROOT_DIR/dist"

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "Plugin directory not found: $PLUGIN_DIR" >&2
  exit 1
fi

VERSION="$(node -p "require('$PLUGIN_DIR/manifest.json').Version")"
UUID="$(node -p "require('$PLUGIN_DIR/manifest.json').UUID")"
ARTIFACT="$DIST_DIR/$UUID-$VERSION.streamDeckPlugin"

npm --prefix "$PLUGIN_DIR" install
mkdir -p "$DIST_DIR"

if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --sequesterRsrc --keepParent "$PLUGIN_DIR" "$ARTIFACT"
else
  (
    cd "$ROOT_DIR"
    zip -r -q "$ARTIFACT" "$(basename "$PLUGIN_DIR")"
  )
fi

echo "Created package:"
echo "  $ARTIFACT"
