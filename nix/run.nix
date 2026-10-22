# Single-file self-extracting gcode-sheet: a POSIX sh header, a static zstd, then the
# zstd-compressed bundle. The first run unpacks into the cache dir; later runs exec it.
# The host needs only sh, readlink, mktemp, head, tail and tar (busybox is enough).
{ runCommand, gnutar, zstd, staticZstd, bundle }:

runCommand "gcode-sheet.run" {
  nativeBuildInputs = [ gnutar zstd ];
} ''
  tar -C ${bundle} --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --mode=u+w -cf - . |
    zstd -19 -T0 --long=27 -q -o payload.zst
  id=$(sha256sum payload.zst | cut -c1-16)
  zsize=$(stat -c %s ${staticZstd}/bin/zstd)

  header() { # $1 = header size in bytes; the payload offsets depend on it
    cat <<EOF
  #!/bin/sh
  # Self-extracting gcode-sheet ($id): https://github.com/werdnum/gcode-sheet
  # Unpacks once into \$GCODE_SHEET_CACHE (default ~/.cache/gcode-sheet), then runs.
  set -e
  self=\$(readlink -f "\$0")
  dir="\''${GCODE_SHEET_CACHE:-\''${XDG_CACHE_HOME:-\''${HOME:-/tmp}/.cache}/gcode-sheet}/$id"
  if [ ! -x "\$dir/gcode-sheet" ]; then
    mkdir -p "\''${dir%/*}"
    tmp=\$(mktemp -d "\$dir.XXXXXX")
    tail -c +$(( $1 + 1 )) "\$self" | head -c $zsize > "\$tmp/.zstd"
    chmod +x "\$tmp/.zstd"
    tail -c +$(( $1 + zsize + 1 )) "\$self" | "\$tmp/.zstd" -dc --long=27 | tar -x -C "\$tmp"
    rm "\$tmp/.zstd"
    # A concurrent first run may have got there first (mv would nest into its dir).
    if [ -e "\$dir" ]; then rm -rf "\$tmp"; else mv "\$tmp" "\$dir"; fi
  fi
  exec "\$dir/gcode-sheet" "\$@"
  EOF
  }
  size=0
  while :; do
    n=$(header $size | wc -c)
    [ "$n" = "$size" ] && break
    size=$n
  done
  { header $size; cat ${staticZstd}/bin/zstd payload.zst; } > $out
  chmod +x $out
''
