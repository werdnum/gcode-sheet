#!/usr/bin/env bash
# One-shot setup for running gcode-sheet without Nix (Linux x86_64/aarch64, glibc).
# Installs the Mesa EGL/GLES runtime and libbgcode's `bgcode` CLI if missing
# (apt; dnf gets Mesa only), installs the npm
# dependencies (webgl-node downloads a prebuilt GLES addon; nothing is compiled),
# then renders the bundled fixture as a smoke test.
#
# Usage: scripts/setup.sh            (set SKIP_SYSTEM_DEPS=1 to skip the package manager)
set -euo pipefail

cd "$(dirname "$0")/.."

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-aarch64) ;;
  *) die "unsupported platform $(uname -s)-$(uname -m); only Linux x86_64/aarch64 are supported" ;;
esac

command -v node >/dev/null || die "Node.js 20+ is required (https://nodejs.org/ or your package manager)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] || die "Node.js 20+ is required, found $(node --version)"

have_libs() {
  for lib in libEGL.so.1 libGLESv2.so.2 libEGL_mesa.so.0; do
    ldconfig -p 2>/dev/null | grep -q "$lib" || return 1
  done
  # Mesa >= 24.2 ships llvmpipe in libgallium; older releases use swrast_dri.so.
  ldconfig -p 2>/dev/null | grep -q libgallium ||
    ls /usr/lib/*/dri/swrast_dri.so /usr/lib*/dri/swrast_dri.so >/dev/null 2>&1
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null; then sudo "$@"
  else die "need root (or sudo) to run: $*"
  fi
}

if [ "${SKIP_SYSTEM_DEPS:-0}" != 1 ] && { ! have_libs || ! command -v "${BGCODE_BIN:-bgcode}" >/dev/null; }; then
  if command -v apt-get >/dev/null; then
    # `bgcode` is libbgcode's CLI (Debian trixie+, Ubuntu 24.04+), used to decode .bgcode.
    log "Installing Mesa EGL/GLES runtime and bgcode with apt-get"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      libegl1 libgles2 libegl-mesa0 libgl1-mesa-dri bgcode >/dev/null
  elif command -v dnf >/dev/null; then
    log "Installing Mesa EGL/GLES runtime with dnf"
    as_root dnf install -y -q mesa-libEGL mesa-libGLES mesa-dri-drivers >/dev/null
    command -v "${BGCODE_BIN:-bgcode}" >/dev/null ||
      log "warning: no packaged bgcode CLI here; .bgcode input needs libbgcode (https://github.com/prusa3d/libbgcode) on PATH or BGCODE_BIN"
  else
    die "install Mesa's EGL + GLESv2 libraries, the llvmpipe driver and libbgcode's bgcode CLI, then re-run (or set SKIP_SYSTEM_DEPS=1)"
  fi
fi

log "Installing npm dependencies"
npm ci --no-audit --no-fund --loglevel=error

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
if command -v "${BGCODE_BIN:-bgcode}" >/dev/null; then
  log "Smoke-testing with the bundled .bgcode fixture"
  node gcode-sheet.mjs caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode "$out/caliper.png" > "$out/summary.json"
  expected_layers=29
else
  log "Smoke-testing with plain G-code (no bgcode CLI: .bgcode input will not work)"
  printf ';LAYER_CHANGE\nG90\nM83\nG1 X0 Y0 Z0.2\nG1 X10 E1\nG1 Y10 E1\n' > "$out/square.gcode"
  node gcode-sheet.mjs "$out/square.gcode" "$out/square.png" > "$out/summary.json"
  expected_layers=1
fi
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (s.layers !== Number(process.argv[2])) throw new Error("unexpected smoke-test summary: " + JSON.stringify(s));
' "$out/summary.json" "$expected_layers"

log "Ready: node $(pwd)/gcode-sheet.mjs INPUT.(gcode|bgcode) OUTPUT.png [options]"
