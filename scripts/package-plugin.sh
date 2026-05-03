#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR/com.pshkrh.pulse-deck.sdPlugin"
DIST_DIR="$ROOT_DIR/dist"
ARCH="$(uname -m)"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pulse-deck-package.XXXXXX")"
STAGED_PLUGIN_DIR="$STAGE_DIR/$(basename "$PLUGIN_DIR")"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "Plugin directory not found: $PLUGIN_DIR" >&2
  exit 1
fi

VERSION="$(node -p "require('$PLUGIN_DIR/manifest.json').Version")"
UUID="$(node -p "require('$PLUGIN_DIR/manifest.json').UUID")"
ARTIFACT="$DIST_DIR/$UUID-$VERSION-macos-$ARCH.streamDeckPlugin"

npm --prefix "$PLUGIN_DIR" install
mkdir -p "$DIST_DIR"

if [[ ! -x "$PLUGIN_DIR/bin/scripts/cpu_temp_bin" ]]; then
  echo "Missing bundled CPU temp binary: $PLUGIN_DIR/bin/scripts/cpu_temp_bin" >&2
  exit 1
fi

node -e "require(require('node:path').join(process.argv[1], 'bin/lib/render/canvas-renderer.js'))" "$PLUGIN_DIR"
rm -f "$ARTIFACT"

rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '__MACOSX' \
  "$PLUGIN_DIR/" "$STAGED_PLUGIN_DIR/"

# Strip files that are not needed at runtime from bundled dependencies.
find "$STAGED_PLUGIN_DIR/node_modules" \
  \( -type d \( -name test -o -name tests -o -name example -o -name examples -o -name docs -o -name doc -o -name .github -o -name src \) \
   -o -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.ts' -o -name '*.yml' -o -name '*.yaml' -o -name 'binding.gyp' -o -name 'Makefile' \) \) \
  -print0 | xargs -0 rm -rf

# Keep only the runtime pieces of node-canvas.
find "$STAGED_PLUGIN_DIR/node_modules/canvas/build" -mindepth 1 -maxdepth 1 ! -name Release -print0 | xargs -0 rm -rf

# Drop package manager metadata that Stream Deck does not use at runtime.
rm -f \
  "$STAGED_PLUGIN_DIR/package-lock.json" \
  "$STAGED_PLUGIN_DIR/package.json"

(
  cd "$STAGE_DIR"
  zip -X -r -q "$ARTIFACT" "$(basename "$PLUGIN_DIR")"
)

echo "Created package:"
echo "  $ARTIFACT"
