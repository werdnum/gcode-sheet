{
  description = "Headless G-code/bgcode toolpath contact-sheet renderer (Three.js + webgl-node + Mesa llvmpipe)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };

          glesTarball = {
            "x86_64-linux" = pkgs.fetchurl {
              url = "https://github.com/monteslu/native-gles/releases/download/v0.7.1/gles.node-v0.7.1-linux-x64.tar.gz";
              hash = "sha256-M9CBt4j+Ols+CKNLifsMUJ2b7foei918Aw4NpsDwwic=";
            };
            "aarch64-linux" = pkgs.fetchurl {
              url = "https://github.com/monteslu/native-gles/releases/download/v0.7.1/gles.node-v0.7.1-linux-arm64.tar.gz";
              hash = "sha256-YHrMILlTBBN7RPakh/qsQb1AQYGp6vt0g315bt1N290=";
            };
          }.${system} or (throw "Unsupported system: ${system}");

          runtimeLibs = [
            pkgs.libglvnd
            pkgs.mesa
            pkgs.stdenv.cc.cc.lib
          ];

          gcode-sheet = pkgs.buildNpmPackage {
            pname = "gcode-sheet";
            version = "1.0.0";

            src = pkgs.lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                let base = baseNameOf (toString path);
                in builtins.elem base [
                  "package.json"
                  "package-lock.json"
                  "gcode-sheet.mjs"
                ];
            };

            nodejs = pkgs.nodejs_24;

            npmDeps = pkgs.importNpmLock {
              npmRoot = ./.;
            };
            npmConfigHook = pkgs.importNpmLock.npmConfigHook;

            npmFlags = [ "--ignore-scripts" ];
            dontNpmBuild = true;

            nativeBuildInputs = [
              pkgs.makeWrapper
              pkgs.autoPatchelfHook
            ];

            buildInputs = runtimeLibs;

            postInstall = ''
              addonDir="$out/lib/node_modules/gcode-sheet/node_modules/native-gles/dist"
              rm -rf "$addonDir"
              mkdir -p "$addonDir"
              tar -xzf "${glesTarball}" --no-same-owner -C "$addonDir"
              chmod +x "$out/lib/node_modules/gcode-sheet/gcode-sheet.mjs"

              wrapProgram "$out/bin/gcode-sheet" \
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.libbgcode ]}" \
                --set BGCODE_BIN "${pkgs.libbgcode}/bin/bgcode" \
                --set LD_LIBRARY_PATH "${pkgs.lib.makeLibraryPath runtimeLibs}" \
                --set __EGL_VENDOR_LIBRARY_FILENAMES "${pkgs.mesa}/share/glvnd/egl_vendor.d/50_mesa.json" \
                --set EGL_PLATFORM "surfaceless" \
                --set LIBGL_ALWAYS_SOFTWARE "1" \
                --set GALLIUM_DRIVER "llvmpipe" \
                --set-default LP_NUM_THREADS "4" \
                --unset NODE_OPTIONS
            '';

            meta = with pkgs.lib; {
              description = "Headless G-code/bgcode toolpath contact-sheet renderer";
              homepage = "https://github.com/werdnum/gcode-sheet";
              license = licenses.mit;
              platforms = systems;
              mainProgram = "gcode-sheet";
            };
          };
        in
        {
          default = gcode-sheet;
          inherit gcode-sheet;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/gcode-sheet";
          meta = {
            description = "Headless G-code/bgcode toolpath contact-sheet renderer";
          };
        };
      });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          gcode-sheet = self.packages.${system}.default;
          fixture = ./caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode;
        in
        {
          default = pkgs.runCommand "gcode-sheet-check" {
            nativeBuildInputs = [ gcode-sheet pkgs.nodejs_24 ];
          } ''
            export HOME="$TMPDIR"
            gcode-sheet "${fixture}" "$TMPDIR/caliper.png" > "$TMPDIR/summary.json"
            cat "$TMPDIR/summary.json"

            NODE_PATH="${gcode-sheet}/lib/node_modules/gcode-sheet/node_modules" \
            node - "$TMPDIR/caliper.png" "$TMPDIR/summary.json" <<'EOF'
            const fs = require('node:fs');
            const assert = require('node:assert/strict');
            const { PNG } = require('pngjs');

            const [pngPath, jsonPath] = process.argv.slice(2);
            const summary = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            assert.equal(summary.layers, 29, 'Expected 29 layers in caliper fixture');
            assert.deepEqual(summary.tools, [2], 'Expected tool [2] in caliper fixture');

            const buf = fs.readFileSync(pngPath);
            assert.ok(buf.length > 50000, "PNG file too small: " + buf.length);
            const png = PNG.sync.read(buf);
            assert.equal(png.width, 1600, 'Expected width 1600');
            assert.equal(png.height, 1280, 'Expected height 1280');

            // Background is #DCDFE4 -> RGB (220, 223, 228)
            let nonBgPixels = 0;
            const d = png.data;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] !== 220 || d[i + 1] !== 223 || d[i + 2] !== 228) {
                nonBgPixels++;
              }
            }
            console.log("Verified PNG (" + png.width + "x" + png.height + "): " + nonBgPixels + " non-background pixels");
            assert.ok(nonBgPixels > 200000, "Expected >200k non-background pixels, got " + nonBgPixels);
            EOF

            mkdir -p "$out"
            cp "$TMPDIR/caliper.png" "$out/caliper.png"
            cp "$TMPDIR/summary.json" "$out/summary.json"
          '';
        }
      );
    };
}
