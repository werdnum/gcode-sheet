#!/usr/bin/env bash
# One-shot setup for running gcode-sheet without Nix (Linux x86_64/aarch64, glibc).
# Installs the Mesa EGL/GLES runtime and libbgcode's `bgcode` CLI if missing, installs
# the npm dependencies (webgl-node downloads a prebuilt GLES addon; nothing is compiled),
# then renders the bundled fixture as a smoke test.
#
# With root or passwordless sudo, system packages come from apt (dnf: Mesa only). Without
# them, apt's .debs are downloaded and unpacked into .deps/, which bin/gcode-sheet uses.
#
# Usage: scripts/setup.sh   SKIP_SYSTEM_DEPS=1 skips system packages; FORCE_ROOTLESS=1
#                           always uses .deps/ (as CI does to test that path).
set -euo pipefail

cd "$(dirname "$0")/.."
repo="$(pwd)"
deps="$repo/.deps"

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-aarch64) ;;
  *) die "unsupported platform $(uname -s)-$(uname -m); only Linux x86_64/aarch64 are supported" ;;
esac
triplet="$(uname -m)-linux-gnu"

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
have_bgcode() { command -v "${BGCODE_BIN:-bgcode}" >/dev/null; }
can_root() { [ "${FORCE_ROOTLESS:-0}" != 1 ] && { [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null; }; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }

# `bgcode` is libbgcode's CLI, used to decode .bgcode (Debian trixie+, Ubuntu 24.04+).
apt_packages() {
  local pkgs=(libegl1 libgles2 libegl-mesa0 libgl1-mesa-dri)
  if apt-cache "$@" show bgcode >/dev/null 2>&1; then pkgs+=(bgcode)
  else log "warning: this release has no bgcode package; .bgcode input will need libbgcode on PATH or BGCODE_BIN"
  fi
  echo "${pkgs[@]}"
}

# Without root: resolve the missing packages against the system's dpkg state, download
# them with apt using private lists/cache dirs, and unpack them into .deps/root.
install_rootless() {
  local apt_opts=(-o "Dir::State::Lists=$deps/apt/lists" -o "Dir::Cache=$deps/apt/cache"
    -o "Dir::Cache::archives=$deps/apt/cache/archives"
    -o Debug::NoLocking=1 -o "APT::Sandbox::User=$(id -un)")
  rm -rf "$deps"
  mkdir -p "$deps/apt/lists/partial" "$deps/apt/cache/archives/partial" "$deps/root"
  # Images' apt.conf.d cleanup hooks (e.g. docker-clean) can't touch /var/cache as a
  # user and complain harmlessly, so update's stderr is only shown if it fails.
  apt-get "${apt_opts[@]}" update -qq >/dev/null 2>"$deps/update.log" ||
    { cat "$deps/update.log" >&2; die "apt-get update failed"; }
  local missing
  # shellcheck disable=SC2046
  missing="$(apt-get "${apt_opts[@]}" install -s --no-install-recommends $(apt_packages "${apt_opts[@]}") |
    awk '/^Inst /{print $2}')"
  if [ -n "$missing" ]; then
    # shellcheck disable=SC2086
    (cd "$deps/apt/cache/archives" && apt-get "${apt_opts[@]}" download -qq $missing >/dev/null)
    for deb in "$deps"/apt/cache/archives/*.deb; do dpkg-deb -x "$deb" "$deps/root"; done
  fi
  rm -rf "$deps/apt" "$deps/update.log"

  local root="$deps/root"
  {
    echo "# Written by scripts/setup.sh: private Mesa/bgcode unpacked without root."
    echo "export LD_LIBRARY_PATH=\"$root/usr/lib/$triplet:$root/lib/$triplet\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}\""
    [ -f "$root/usr/share/glvnd/egl_vendor.d/50_mesa.json" ] &&
      echo "export __EGL_VENDOR_LIBRARY_FILENAMES=\"$root/usr/share/glvnd/egl_vendor.d/50_mesa.json\""
    [ -d "$root/usr/lib/$triplet/dri" ] && echo "export LIBGL_DRIVERS_PATH=\"$root/usr/lib/$triplet/dri\""
    [ -x "$root/usr/bin/bgcode" ] && echo "export BGCODE_BIN=\"$root/usr/bin/bgcode\""
    true
  } > "$deps/env"
}

if [ "${SKIP_SYSTEM_DEPS:-0}" != 1 ] && { ! have_libs || ! have_bgcode || [ "${FORCE_ROOTLESS:-0}" = 1 ]; }; then
  if command -v apt-get >/dev/null && can_root; then
    log "Installing Mesa EGL/GLES runtime and bgcode with apt-get"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    # shellcheck disable=SC2046
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      $(apt_packages) >/dev/null
  elif command -v apt-get >/dev/null; then
    log "No root or passwordless sudo: unpacking Mesa EGL/GLES runtime and bgcode into .deps/"
    install_rootless
  elif command -v dnf >/dev/null && can_root; then
    log "Installing Mesa EGL/GLES runtime with dnf"
    as_root dnf install -y -q mesa-libEGL mesa-libGLES mesa-dri-drivers >/dev/null
    have_bgcode ||
      log "warning: no packaged bgcode CLI here; .bgcode input needs libbgcode (https://github.com/prusa3d/libbgcode) on PATH or BGCODE_BIN"
  else
    die "install Mesa's EGL + GLESv2 libraries, the llvmpipe driver and libbgcode's bgcode CLI, then re-run (or set SKIP_SYSTEM_DEPS=1)"
  fi
fi

log "Installing npm dependencies"
npm ci --no-audit --no-fund --loglevel=error

out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
if ( [ -f "$deps/env" ] && . "$deps/env"; have_bgcode ); then
  log "Smoke-testing with the bundled .bgcode fixture"
  bin/gcode-sheet caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode "$out/caliper.png" > "$out/summary.json"
  expected_layers=29
else
  log "Smoke-testing with plain G-code (no bgcode CLI: .bgcode input will not work)"
  printf ';LAYER_CHANGE\nG90\nM83\nG1 X0 Y0 Z0.2\nG1 X10 E1\nG1 Y10 E1\n' > "$out/square.gcode"
  bin/gcode-sheet "$out/square.gcode" "$out/square.png" > "$out/summary.json"
  expected_layers=1
fi
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (s.layers !== Number(process.argv[2])) throw new Error("unexpected smoke-test summary: " + JSON.stringify(s));
' "$out/summary.json" "$expected_layers"

log "Ready: $repo/bin/gcode-sheet INPUT.(gcode|bgcode) OUTPUT.png [options]"
