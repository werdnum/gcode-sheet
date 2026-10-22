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
  if [ -n "\''${GCODE_SHEET_CACHE:-}" ]; then root=\$GCODE_SHEET_CACHE
  elif [ -n "\''${XDG_CACHE_HOME:-}" ]; then root=\$XDG_CACHE_HOME/gcode-sheet
  elif [ -n "\''${HOME:-}" ]; then root=\$HOME/.cache/gcode-sheet
  else
    # No home directory: use a per-user dir in /tmp, and refuse one another user could
    # have planted (the launcher runs whatever it finds there).
    root=\''${TMPDIR:-/tmp}/gcode-sheet-\$(id -u)
    mkdir -m 700 -p "\$root"
    if [ -L "\$root" ] || [ ! -O "\$root" ]; then
      echo "gcode-sheet: \$root is not a directory you own; set GCODE_SHEET_CACHE" >&2
      exit 1
    fi
    chmod 700 "\$root"
  fi
  dir=\$root/$id
  if [ ! -x "\$dir/gcode-sheet" ]; then
    mkdir -p "\''${dir%/*}"
    tmp=\$(mktemp -d "\$dir.XXXXXX")
    tail -c +$(( $1 + 1 )) "\$self" | head -c $zsize > "\$tmp/.zstd"
    chmod +x "\$tmp/.zstd"
    tail -c +$(( $1 + zsize + 1 )) "\$self" | "\$tmp/.zstd" -dc --long=27 | tar -x -C "\$tmp"
    rm "\$tmp/.zstd"
    # Publish atomically: ln -n fails if a concurrent first run already won.
    ln -sn "\''${tmp##*/}" "\$dir" 2>/dev/null || rm -rf "\$tmp"
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
