#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
OUT_DIR="${1:-$BENCH_DIR/data}"

if ! command -v prusa-slicer >/dev/null 2>&1 || ! command -v bgcode >/dev/null 2>&1; then
  exec nix shell nixpkgs#prusa-slicer nixpkgs#libbgcode --command "$0" "$@"
fi

PRUSA_BIN="$(command -v prusa-slicer)"
PRUSA_PREFIX="$(cd "$(dirname "$PRUSA_BIN")/.." && pwd)"
BENCHY_STL="$PRUSA_PREFIX/share/PrusaSlicer/shapes/3DBenchy.stl"

if [[ ! -f "$BENCHY_STL" ]]; then
  echo "Error: Could not find bundled 3DBenchy.stl at $BENCHY_STL" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Decoding caliper fixture -> $OUT_DIR/caliper.gcode ..."
cp "$REPO_ROOT/caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode" "$OUT_DIR/caliper.bgcode"
rm -f "$OUT_DIR/caliper.gcode"
bgcode "$OUT_DIR/caliper.bgcode"

echo "Slicing medium benchmark (4x 3DBenchy, ~11.2 MB G-code) -> $OUT_DIR/medium.gcode ..."
prusa-slicer --load "$BENCH_DIR/mk4.ini" \
  --duplicate 4 \
  --export-gcode \
  --output "$OUT_DIR/medium.gcode" \
  "$BENCHY_STL"

echo "Slicing medium binary G-code benchmark -> $OUT_DIR/medium.bgcode ..."
prusa-slicer --load "$BENCH_DIR/mk4.ini" \
  --binary-gcode \
  --duplicate 4 \
  --export-gcode \
  --output "$OUT_DIR/medium.bgcode" \
  "$BENCHY_STL"

echo "Slicing large benchmark (8x 3DBenchy, ~22.4 MB G-code) -> $OUT_DIR/large.gcode ..."
prusa-slicer --load "$BENCH_DIR/mk4.ini" \
  --duplicate 8 \
  --export-gcode \
  --output "$OUT_DIR/large.gcode" \
  "$BENCHY_STL"

ls -lh "$OUT_DIR"/*.gcode "$OUT_DIR"/*.bgcode
