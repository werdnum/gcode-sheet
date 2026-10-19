#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
DATA_DIR="${BENCH_DATA_DIR:-$BENCH_DIR/data}"

if ! command -v time >/dev/null 2>&1; then
  exec nix shell nixpkgs#time --command "$0" "$@"
fi

TIME_BIN="$(type -P time)"

if [[ ! -f "$DATA_DIR/caliper.gcode" || ! -f "$DATA_DIR/medium.gcode" || ! -f "$DATA_DIR/large.gcode" ]]; then
  "$BENCH_DIR/generate.sh" "$DATA_DIR" >&2
fi

if [[ -z "${GCODE_SHEET_BIN:-}" ]]; then
  echo "Building gcode-sheet flake package..." >&2
  PKG_OUT="$(nix build "$REPO_ROOT" --no-link --print-out-paths)"
  GCODE_SHEET_BIN="$PKG_OUT/bin/gcode-sheet"
fi

TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_OUT"' EXIT

echo "| Input | Size | Detail | Wall Time (s) | Peak RSS (MB) |"
echo "|---|---:|---|---:|---:|"

run_case() {
  local label="$1"
  local file="$2"
  local detail="$3"
  local size_bytes
  size_bytes=$(stat -c%s "$file")
  local size_mb
  size_mb=$(awk "BEGIN { printf \"%.2f MB\", $size_bytes / 1000000 }")

  local stats
  stats=$("$TIME_BIN" -f "%e %M" "$GCODE_SHEET_BIN" "$file" "$TMP_OUT/out.png" --detail "$detail" 2>&1 >/dev/null | tail -n 1)
  local wall rss_kb rss_mb
  wall=$(echo "$stats" | awk '{print $1}')
  rss_kb=$(echo "$stats" | awk '{print $2}')
  rss_mb=$(awk "BEGIN { printf \"%.0f\", $rss_kb / 1000 }")

  echo "| $label | $size_mb | \`$detail\` | ${wall} s | ${rss_mb} MB ($rss_kb KB) |"
}

run_case "caliper (\`.bgcode\`)" "$REPO_ROOT/caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode" "full"
run_case "caliper (\`.gcode\`)"  "$DATA_DIR/caliper.gcode" "full"
run_case "caliper (\`.gcode\`)"  "$DATA_DIR/caliper.gcode" "shell"
run_case "medium (\`.bgcode\`)"  "$DATA_DIR/medium.bgcode" "full"
run_case "medium (\`.gcode\`)"   "$DATA_DIR/medium.gcode"  "full"
run_case "medium (\`.gcode\`)"   "$DATA_DIR/medium.gcode"  "shell"
run_case "large (\`.gcode\`)"    "$DATA_DIR/large.gcode"   "full"
run_case "large (\`.gcode\`)"    "$DATA_DIR/large.gcode"   "shell"
