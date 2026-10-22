# Relocatable gcode-sheet: Node, the app, bgcode and every shared library they load
# (glibc and its dynamic loader included) in one directory that runs from any path on
# any Linux of the same architecture, without /nix, root, user namespaces or FUSE.
#
# Binaries are started through the bundled loader with --library-path, and RPATHs are
# removed, so every library lookup resolves inside the bundle.
{ lib, stdenv, runCommand, patchelf, gcode-sheet, nodejs, libbgcode, mesa, runtimeLibs }:

let
  loader = baseNameOf stdenv.cc.bintools.dynamicLinker;
  app = "${gcode-sheet}/lib/node_modules/gcode-sheet";
  # Everything else is reached from these through DT_NEEDED; glvnd dlopens
  # libEGL_mesa, so it is a root too.
  roots = [
    "${nodejs}/bin/node"
    "${libbgcode}/bin/bgcode"
    "${app}/node_modules/native-gles/dist/gles.node"
    "${mesa}/lib/libEGL_mesa.so.0"
  ];
in
runCommand "gcode-sheet-bundle-${gcode-sheet.version}" {
  nativeBuildInputs = [ patchelf ];
} ''
  mkdir -p $out/lib $out/libexec $out/share

  export LD_LIBRARY_PATH=${lib.makeLibraryPath runtimeLibs}
  for f in ${lib.concatStringsSep " " roots}; do
    ${stdenv.cc.libc.bin}/bin/ldd "$f" | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }'
  done | awk '{ n = $0; sub(/.*\//, "", n) } !seen[n]++' > libs # same file via lib/ and lib64/
  cp -L $(cat libs) ${mesa}/lib/libEGL_mesa.so.0 $out/lib/

  cp -L ${nodejs}/bin/node ${libbgcode}/bin/bgcode $out/libexec/
  cp -rL ${app} $out/app
  chmod -R u+w $out
  sed -i 1d $out/app/gcode-sheet.mjs # the /nix/store node shebang

  for f in $out/lib/* $out/libexec/* $(find $out/app -name '*.node'); do
    [ "$(basename "$f")" = ${loader} ] || patchelf --remove-rpath "$f"
  done

  # glvnd resolves the vendor library by soname, i.e. from the bundle.
  cat > $out/share/50_mesa.json <<'EOF'
  { "file_format_version": "1.0.0", "ICD": { "library_path": "libEGL_mesa.so.0" } }
  EOF

  launcher() { # $1 = name, $2 = exec line
    cat > $out/$1 <<EOF
  #!/bin/sh
  d=\$(dirname "\$(readlink -f "\$0")")
  $2
  EOF
    chmod +x $out/$1
  }
  launcher gcode-sheet 'export __EGL_VENDOR_LIBRARY_FILENAMES="$d/share/50_mesa.json" BGCODE_BIN="$d/bgcode"
  unset NODE_OPTIONS
  exec "$d/lib/${loader}" --library-path "$d/lib" "$d/libexec/node" "$d/app/gcode-sheet.mjs" "$@"'
  launcher bgcode 'exec "$d/lib/${loader}" --library-path "$d/lib" "$d/libexec/bgcode" "$@"'
''
