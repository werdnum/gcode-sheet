#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
DATA_DIR="${BENCH_DATA_DIR:-$BENCH_DIR/data}"

TIME_BIN="$(type -P time || true)"
if [[ -z "$TIME_BIN" ]]; then
  exec nix shell nixpkgs#time --command "$0" "$@"
fi

REPEATS="${BENCH_REPEATS:-5}"
if [[ ! "$REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BENCH_REPEATS must be a positive integer" >&2
  exit 2
fi

if [[ $# -eq 0 && ( ! -f "$DATA_DIR/caliper.gcode" || ! -f "$DATA_DIR/medium.gcode" || ! -f "$DATA_DIR/medium.bgcode" || ! -f "$DATA_DIR/large.gcode" ) ]]; then
  "$BENCH_DIR/generate.sh" "$DATA_DIR" >&2
fi

if [[ -z "${GCODE_SHEET_BIN:-}" ]]; then
  echo "Building gcode-sheet flake package..." >&2
  PKG_OUT="$(nix build "$REPO_ROOT" --no-link --print-out-paths)"
  GCODE_SHEET_BIN="$PKG_OUT/bin/gcode-sheet"
fi

TMP_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_OUT"' EXIT

echo "Median of $REPEATS runs per case."
echo
echo "| Input | Size | Detail | Wall Time (s) | Peak RSS (MiB) |"
echo "|---|---:|---|---:|---:|"

run_case() {
  local label="$1"
  local file="$2"
  local detail="$3"
  local size_bytes
  size_bytes=$(stat -c%s "$file")
  local size_mb
  size_mb=$(awk "BEGIN { printf \"%.2f MB\", $size_bytes / 1000000 }")

  local stats_file="$TMP_OUT/stats"
  : > "$stats_file"
  local r
  for ((r = 0; r < REPEATS; r++)); do
    "$TIME_BIN" -f "%e %M" -o "$TMP_OUT/run.stats" \
      "$GCODE_SHEET_BIN" "$file" "$TMP_OUT/out.png" --detail "$detail" >/dev/null
    cat "$TMP_OUT/run.stats" >> "$stats_file"
  done
  local wall rss_kb rss_mb
  wall=$(sort -n -k1,1 "$stats_file" | awk '{v[NR]=$1} END {print NR%2 ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2}')
  rss_kb=$(sort -n -k2,2 "$stats_file" | awk '{v[NR]=$2} END {print NR%2 ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2}')
  rss_mb=$(awk "BEGIN { printf \"%.0f\", $rss_kb / 1024 }")

  echo "| $label | $size_mb | \`$detail\` | ${wall} s | ${rss_mb} MiB ($rss_kb KiB) |"
}

if [[ $# -gt 0 ]]; then
  for file in "$@"; do
    run_case "$(basename "$file")" "$file" "full"
    run_case "$(basename "$file")" "$file" "shell"
  done
  exit 0
fi

run_case "caliper (\`.bgcode\`)" "$REPO_ROOT/caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode" "full"
run_case "caliper (\`.gcode\`)"  "$DATA_DIR/caliper.gcode" "full"
run_case "caliper (\`.gcode\`)"  "$DATA_DIR/caliper.gcode" "shell"
run_case "medium (\`.bgcode\`)"  "$DATA_DIR/medium.bgcode" "full"
run_case "medium (\`.gcode\`)"   "$DATA_DIR/medium.gcode"  "full"
run_case "medium (\`.gcode\`)"   "$DATA_DIR/medium.gcode"  "shell"
run_case "large (\`.gcode\`)"    "$DATA_DIR/large.gcode"   "full"
run_case "large (\`.gcode\`)"    "$DATA_DIR/large.gcode"   "shell"
