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

          mkGcodeSheet = runtime: runtimeBin: pkgs.buildNpmPackage {
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
              sed -i '1c#!${runtime}/bin/${runtimeBin}' "$out/lib/node_modules/gcode-sheet/gcode-sheet.mjs"

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
          gcode-sheet = mkGcodeSheet pkgs.nodejs_24 "node";
          gcode-sheet-bun = mkGcodeSheet pkgs.bun "bun";
        in
        {
          default = gcode-sheet;
          inherit gcode-sheet;
          bun = gcode-sheet-bun;
          # Relocatable directory and single-file self-extractor for machines without Nix.
          bundle = pkgs.callPackage ./nix/bundle.nix {
            inherit gcode-sheet runtimeLibs;
            nodejs = pkgs.nodejs_24;
          };
          run = pkgs.callPackage ./nix/run.nix {
            bundle = self.packages.${system}.bundle;
            staticZstd = pkgs.pkgsStatic.zstd.bin;
          };
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
        bun = {
          type = "app";
          program = "${self.packages.${system}.bun}/bin/gcode-sheet";
          meta.description = "G-code contact-sheet renderer using Bun";
        };
      });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          fixture = ./caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode;
          checkPackage = gcode-sheet: pkgs.runCommand "gcode-sheet-check" {
            nativeBuildInputs = [ gcode-sheet pkgs.nodejs_24 ];
          } ''
            export HOME="$TMPDIR"
            GCODE_SHEET_BIN="${gcode-sheet}/bin/gcode-sheet" \
              node --test ${./test/parser.test.mjs}
            gcode-sheet "${fixture}" "$TMPDIR/caliper.png" > "$TMPDIR/summary.json"
            gcode-sheet "${fixture}" "$TMPDIR/caliper-feature.png" --color-by feature > "$TMPDIR/feature-summary.json"
            cat "$TMPDIR/summary.json"
            cat "$TMPDIR/feature-summary.json"

            NODE_PATH="${gcode-sheet}/lib/node_modules/gcode-sheet/node_modules" \
            node - "$TMPDIR/caliper.png" "$TMPDIR/summary.json" "$TMPDIR/feature-summary.json" <<'EOF'
            const fs = require('node:fs');
            const assert = require('node:assert/strict');
            const { PNG } = require('pngjs');

            const [pngPath, jsonPath, featureJsonPath] = process.argv.slice(2);
            const summary = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            assert.equal(summary.layers, 29, 'Expected 29 layers in caliper fixture');
            assert.deepEqual(summary.tools, [2], 'Expected tool [2] in caliper fixture');

            const featureSummary = JSON.parse(fs.readFileSync(featureJsonPath, 'utf8'));
            assert.equal(featureSummary.colorBy, 'feature');
            assert.deepEqual(featureSummary.tools, [2], 'Feature mode must report the physical tool [2]');
            assert.deepEqual(featureSummary.bbox_mm, summary.bbox_mm);
            assert.equal(featureSummary.layers, summary.layers);
            assert.ok(featureSummary.legend.includes('External perimeter=#F59E0B'));

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
            cp "$TMPDIR/caliper-feature.png" "$out/caliper-feature.png"
            cp "$TMPDIR/feature-summary.json" "$out/feature-summary.json"
          '';
          nodeCheck = checkPackage self.packages.${system}.default;
          bunCheck = checkPackage self.packages.${system}.bun;
        in
        {
          default = nodeCheck;
          bun = bunCheck;
          # The self-extractor must unpack, load every library from inside the bundle, and
          # render exactly what the Nix package renders.
          bundle = pkgs.runCommand "gcode-sheet-bundle-check" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            export HOME="$TMPDIR" GCODE_SHEET_CACHE="$TMPDIR/cache"
            LD_DEBUG=libs,files LD_DEBUG_OUTPUT="$TMPDIR/ld" \
              ${self.packages.${system}.run} "${fixture}" caliper.png > summary.json
            # Once a process has exec'd into the bundled loader, every lookup must stay inside it.
            outside=$(awk 'FNR == 1 { inside = 0 } /libexec\/(node|bgcode) / { inside = 1 }
              inside && /trying file=/' "$TMPDIR"/ld.* | grep -v "trying file=$GCODE_SHEET_CACHE/" || true)
            if [ -n "$outside" ]; then echo "Libraries loaded from outside the bundle:"; echo "$outside"; exit 1; fi
            grep -q 'libexec/node ' "$TMPDIR"/ld.* && grep -q 'libexec/bgcode ' "$TMPDIR"/ld.*

            NODE_PATH="${self.packages.${system}.default}/lib/node_modules/gcode-sheet/node_modules" \
            node - caliper.png summary.json "${nodeCheck}" <<'EOF'
            const fs = require('node:fs');
            const assert = require('node:assert/strict');
            const { PNG } = require('pngjs');
            const [png, json, ref] = process.argv.slice(2);
            assert.deepEqual(PNG.sync.read(fs.readFileSync(png)).data,
              PNG.sync.read(fs.readFileSync(ref + '/caliper.png')).data, 'bundle pixels differ from the Nix package');
            const summary = JSON.parse(fs.readFileSync(json, 'utf8'));
            const refSummary = JSON.parse(fs.readFileSync(ref + '/summary.json', 'utf8'));
            delete summary.output;
            delete refSummary.output;
            assert.deepEqual(summary, refSummary);
            EOF
            touch "$out"
          '';
          runtime-equivalence = pkgs.runCommand "gcode-sheet-runtime-equivalence" {
            nativeBuildInputs = [ pkgs.nodejs_24 ];
          } ''
            NODE_PATH="${self.packages.${system}.default}/lib/node_modules/gcode-sheet/node_modules" \
            node - "${nodeCheck}" "${bunCheck}" <<'EOF'
            const fs = require('node:fs');
            const assert = require('node:assert/strict');
            const { PNG } = require('pngjs');
            const [nodeDir, bunDir] = process.argv.slice(2);
            for (const name of ['caliper', 'caliper-feature']) {
              const nodeImage = PNG.sync.read(fs.readFileSync(nodeDir + '/' + name + '.png'));
              const bunImage = PNG.sync.read(fs.readFileSync(bunDir + '/' + name + '.png'));
              assert.equal(nodeImage.width, bunImage.width);
              assert.equal(nodeImage.height, bunImage.height);
              assert.deepEqual(nodeImage.data, bunImage.data, name + ' pixels differ between runtimes');
              const json = name === 'caliper' ? 'summary.json' : 'feature-summary.json';
              const nodeSummary = JSON.parse(fs.readFileSync(nodeDir + '/' + json, 'utf8'));
              const bunSummary = JSON.parse(fs.readFileSync(bunDir + '/' + json, 'utf8'));
              delete nodeSummary.output;
              delete bunSummary.output;
              assert.deepEqual(nodeSummary, bunSummary);
            }
            EOF
            touch "$out"
          '';
        }
      );
    };
}
