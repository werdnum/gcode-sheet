# gcode-sheet

Headless 3D-print G-code / `.bgcode` toolpath contact-sheet renderer, packaged as a Nix flake for `x86_64-linux` and `aarch64-linux`.

`gcode-sheet` renders sliced 3D-print toolpaths (such as Prusa MK4 + MMU3 output) into a multi-view PNG contact sheet (`iso`, `top`, `front`, `first`, `right`, `bottom`) of shaded 3D extrusion tubes coloured either by MMU tool/slot or by PrusaSlicer feature type (`;TYPE:` blocks). It runs entirely in Node.js without a browser or display server using Three.js, `webgl-node` (`native-gles`), and Mesa `llvmpipe` in surfaceless EGL mode, with `libbgcode` wired in to accept `.bgcode` files directly.

![Medium benchmark rendered by feature type](docs/medium-feature-after.png)

## Quick Start (`nix run`)

Run directly from GitHub on any `.bgcode` or `.gcode` file:

```bash
nix run github:werdnum/gcode-sheet -- part.bgcode out.png
```

Or from a local checkout:

```bash
nix run . -- caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode out.png
nix run . -- caliper-battery-cover-flatbase-0.1mm-black-pla-slot3.bgcode out-feature.png --color-by feature
```

An optional Bun package offers the same CLI and can be faster, with workload-dependent memory use. Node.js 24 remains the default:

```bash
nix run .#bun -- part.bgcode out.png
# From GitHub:
nix run github:werdnum/gcode-sheet#bun -- part.bgcode out.png
```

Run the flake test suite (checks parser regressions and the caliper `.bgcode` fixture under both runtimes, verifies the PNG dimensions, pixel count, and JSON summary, compares decoded pixels and summaries between runtimes, and checks that the single-file bundle matches them):

```bash
nix flake check -L
```

## Without Nix: Single-File Download

Pushes to `main` that change the executable publish a new [release](https://github.com/werdnum/gcode-sheet/releases) automatically. If several land while a release is building, only the newest is released. Each release attaches a self-contained executable for `x86_64` and `aarch64` Linux. It includes Node.js, Mesa `llvmpipe`, libbgcode and the libraries they load, glibc's dynamic loader among them. It works on any distro, including musl-based Alpine, and doesn't need Nix, root, user namespaces, FUSE or a GPU:

```bash
curl -fsSLo gcode-sheet https://github.com/werdnum/gcode-sheet/releases/latest/download/gcode-sheet-$(uname -m).run
chmod +x gcode-sheet
./gcode-sheet part.bgcode out.png
```

The download is about 110 MB. The first run unpacks it (~430 MB) into `$GCODE_SHEET_CACHE`, which defaults to `~/.cache/gcode-sheet`. That takes a few seconds; after that, startup costs nothing extra. The host only needs `sh`, `readlink`, `mktemp`, `head`, `tail` and `tar`, which busybox provides.

The file is the flake's `run` output. `bundle` is the same thing as a plain directory:

```bash
nix build .#run      # result: the self-extracting executable
nix build .#bundle   # result/gcode-sheet runs from any path
```

The bundle starts Node and `bgcode` through its own copy of glibc's dynamic loader with `--library-path`, and RPATHs are removed from the copied libraries. Every library therefore comes from inside the bundle, never from `/nix/store` or the host. `nix flake check` runs the self-extractor and fails if any library loads from outside it. It also checks that the result is pixel-identical to the Nix package's render.

## Example Output

### Caliper Battery Cover (`.bgcode` fixture)

| Colour by Tool (`--color-by tool`) | Colour by Feature (`--color-by feature`) |
|---|---|
| ![Caliper by tool](docs/caliper-after.png) | ![Caliper by feature](docs/caliper-feature-after.png) |

### Stdout JSON Summary

Every run prints a JSON summary to `stdout` for downstream automation / AI inspection:

`tools` always lists the physical MMU slots that contributed rendered paths, including in feature colour mode. `legend` describes the colours used by the selected mode.

```json
{
  "output": "out.png",
  "views": ["iso", "top", "front", "first"],
  "layers": 29,
  "tools": [2],
  "detail": "full",
  "colorBy": "tool",
  "legend": ["T2=#8C8C8C"],
  "bbox_mm": {
    "x": [116.55, 133.46],
    "y": [98.27, 111.73],
    "z": [0.2, 3]
  }
}
```

## CLI Options

```
Usage: gcode-sheet INPUT.(gcode|bgcode) OUTPUT.png [options]
```

| Option | Default | Description |
|---|---|---|
| `--views LIST` | `iso,top,front,first` | Comma-separated panels (`iso`, `top`, `front`, `right`, `bottom`, `first`), arranged in a 2-column grid |
| `--color-by MODE` | `tool` | `tool` (colour by MMU tool `T0..T7` / `M600` changes) or `feature` (colour by `;TYPE:` blocks) |
| `--tool-colors HEX,...` | `#F67910,#F2F2F2,#8C8C8C,#7B2FBE,#9A9A9A` | Comma-separated hex colours for `T0..T7` (default matches Prusa MMU3 slots 1–5, with black lifted to grey for shading contrast) |
| `--size N` | `800` | Panel width in pixels (each panel is `N` × `0.8*N`, so default 4-panel sheet is `1600×1280`) |
| `--detail MODE` | `auto` | `full`, `shell` (hides interior perimeters/infill/gap-fill above layer 1), or `auto` (`shell` when decoded G-code > 9 MB) |
| `--end-layer N` | *(all)* | Cut the 3D views at layer `N` (1-based) |
| `--include-start` | `false` | Include extrusions before the first `;LAYER_CHANGE` or Cura `;LAYER:n` marker (hides the start-gcode purge line by default when markers exist; markerless files render all extrusions) |
| `--include-wipe-tower` | `false` | Include `;TYPE:Wipe tower` in the camera bounding-box fit (excluded by default so the printed part fills the frame) |
| `--light A,D,B` | `0.6,1.2,1.5` | Ambient, directional, and brightness multipliers for the tube shader |
| `--background HEX` | `#DCDFE4` | Background colour |
| `--extrusion-width MM` | `0.45` | Fallback extrusion width in mm before the first `;WIDTH:` comment |
| `--layer-height MM` | `0.2` | Fallback layer height in mm before the first `;HEIGHT:` comment |
| `--arc-tol MM` | `0.05` | Chord tolerance in mm when tessellating `G2`/`G3` arcs |
| `--lines` | `false` | Render flat `GL_LINES` segments instead of shaded 3D tubes |
| `--no-labels` | `false` | Omit the built-in panel view badges and bottom-left colour legend overlay |
| `-h`, `--help` | | Print CLI usage help |

The parser supports absolute (`G90`) and relative (`G91`) XYZ moves, independent absolute/relative extrusion (`M82`/`M83`), `G92` offsets, and inch (`G20`) or millimetre (`G21`) coordinates. Arc coordinates, I/J offsets, signed R radii, and extrusion values are normalized to millimetres; a negative R selects the arc longer than 180 degrees.

### Feature Colour Groups (`--color-by feature`)

| Feature Group | PrusaSlicer `;TYPE:` | Colour |
|---|---|---|
| External perimeter | `External perimeter` | `#F59E0B` (amber) |
| Perimeter | `Perimeter` | `#FCD34D` (yellow) |
| Overhang / bridge | `Overhang perimeter`, `Bridge infill` | `#2563EB` (blue) |
| Sparse infill | `Internal infill` | `#B91C1C` (red) |
| Solid / top infill | `Solid infill`, `Top solid infill`, `Gap fill`, `Ironing` | `#A855F7` (purple) |
| Support | `Support material`, `Support material interface` | `#16A34A` (green) |
| Skirt / brim | `Skirt/Brim`, `Skirt`, `Brim` | `#0D9488` (teal) |
| Wipe tower / other | `Wipe tower`, `Custom`, any other `;TYPE:` | `#6B7280` (grey) |

## Benchmarks

The `bench/` directory contains scripts to reproducibly generate medium (~11.2 MB) and large (~22.4 MB) G-code and `.bgcode` plates by slicing the bundled PrusaSlicer `3DBenchy.stl` with a Prusa MK4 0.4 mm nozzle / 0.2 mm layer / 15% gyroid infill profile (`bench/mk4.ini`), and to measure wall time and peak RSS.

### Running the Benchmarks

```bash
# Generate benchmark G-code / bgcode files in bench/data/ (uses nix shell for prusa-slicer + libbgcode)
./bench/generate.sh

# Run the benchmark suite and print the Markdown table
./bench/run.sh

# Compare a package on your own inputs (full and shell; median of 5 runs)
GCODE_SHEET_BIN="$(nix build .#bun --no-link --print-out-paths)/bin/gcode-sheet" \
  BENCH_REPEATS=5 ./bench/run.sh part.gcode another.bgcode
```

See [runtime and PNG encoding measurements](docs/performance.md) for comparisons with Node 26 and Bun, methodology, and the tradeoffs behind the current defaults.

### Before vs. After Performance (`x86_64-linux`, Mesa `llvmpipe`)

| Benchmark | Size | Detail | Before (Draft) Time | After Time | Speedup | Before Peak RSS | After Peak RSS | Memory Reduction |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| `caliper` (`.bgcode`) | 0.12 MB | `full` | *(n/a)* | **0.86 s** | — | *(n/a)* | **250 MB** | — |
| `caliper` (`.gcode`) | 0.29 MB | `full` | 1.06 s | **0.82 s** | **1.3×** | 322 MB | **251 MB** | **−22%** |
| `caliper` (`.gcode`) | 0.29 MB | `shell` | 0.93 s | **0.74 s** | **1.3×** | 288 MB | **240 MB** | **−17%** |
| `medium` (`.bgcode`) | 4.29 MB | `full` | *(n/a)* | **3.04 s** | — | *(n/a)* | **368 MB** | — |
| `medium` (`.gcode`, 4× Benchy) | 11.22 MB | `full` | 14.10 s | **2.48 s** | **5.7×** | 1,374 MB | **371 MB** | **−73% (3.7× less)** |
| `medium` (`.gcode`, 4× Benchy) | 11.22 MB | `shell` | 4.43 s | **1.44 s** | **3.1×** | 755 MB | **328 MB** | **−57% (2.3× less)** |
| `large` (`.gcode`, 8× Benchy) | 22.45 MB | `full` | 27.54 s | **3.51 s** | **7.8×** | 2,250 MB | **413 MB** | **−82% (5.4× less)** |
| `large` (`.gcode`, 8× Benchy) | 22.45 MB | `shell` | 7.62 s | **2.01 s** | **3.8×** | 973 MB | **353 MB** | **−64% (2.8× less)** |

### Summary of Optimisations

1. **Bypassed `gcode-preview`'s `BatchedMesh` 3× over-allocation and compact 4-segment diamond tubes**:
   - `gcode-preview` passed `position.count * 3` (number of floats instead of vertices) to `new THREE.BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount)`, allocating **3× too much VBO memory** in both V8 and Mesa `llvmpipe`, plus `Uint32` indices, unused `uv` attributes, and duplicate seam vertices (`(L+1)*5` instead of `L*4`).
   - Building 4-segment diamond tube rings directly into reusable 16,380-point (`≤ 65,520` vertex) chunks with `Float32Array` positions, normalized `Int8Array` normals (`gl.BYTE`), and `Uint16Array` indices reduced per-point geometry memory from **~288 bytes/point to 68 bytes/point (4.2× smaller)**.
2. **Immediate GL upload + JS typed-array detachment**:
   - Each completed chunk is uploaded to its GL VBO immediately via a 1-triangle dummy draw (`setDrawRange(0, 3)`) and its JS typed arrays are replaced with empty 0-length views so the same single scratch buffer is reused across the entire file.
3. **Streaming 256 KB chunk reader + zero-allocation G-code parser**:
   - Eliminated `fs.readFileSync()`, full-file strings, `.split('\n')`, and `gcode-preview`'s millions of `GCodeCommand` and `Path` objects (which previously consumed ~760 MB of V8 heap on the 22.4 MB file before building any geometry).
   - For `.bgcode` files, the temporary decoded `.gcode` file is unlinked as soon as streaming completes, before final scene rendering.
4. **Online $O(1)$-memory exact camera frustum tracker**:
   - Instead of storing a duplicate `Float32Array` of all 4M+ vertices for camera fitting, we precompute the 2D camera-space projection basis vectors `(ux, uy)` for each view direction and track the 4 extreme 3D points per view online during parsing (`48 bytes` per view instead of `48 MB`).
5. **Fast planar horizontal tube path & per-chunk Z culling**:
   - Added a fast 2D perpendicular path for planar `Z`-constant moves (>99% of 3D print moves), avoiding 3 cross products and 2 `Math.sqrt` calls per point, and added per-chunk `minZ` visibility culling for `first` / `--end-layer` views.

### Before vs. After Visual Comparison

| Caliper (Before) | Caliper (After) |
|---|---|
| ![Caliper before](docs/caliper-before.png) | ![Caliper after](docs/caliper-after.png) |

| Medium 4× Benchy (Before) | Medium 4× Benchy (After) |
|---|---|
| ![Medium before](docs/medium-before.png) | ![Medium after](docs/medium-after.png) |

## Print-Head Collision Checker (`gcode-collide`)

`gcode-collide` checks a sliced `.gcode` or `.bgcode` file against a 3D printer head geometry profile (`profiles/mk4.json` by default) to detect collisions between any already-deposited material and the moving head (nozzle, heater block, print-fan shroud, extruder body, X gantry; including `G28` homing and `M600` filament-change park moves).

The built-in `mk4` profile models the head as overlapping parts in nozzle-tip coordinates (x, y relative to the tip, z up from it); parts marked `measured: false` are conservative placeholders, and every report warns about them until they are measured:

| Part | Shape | Extent | Source |
|---|---|---|---|
| `nozzle_cone` | cylinder r 2.5 | z 0–2.5 | E3D Prusa Nextruder nozzle drawing (conservative) |
| `nozzle_hex` | cylinder r 4.5 | z 2.5–5 | E3D drawing: 7 mm hex about 2.5 mm above the tip |
| `heater_block` | box x ±12, y ±12 | z 5–13 | placeholder (block + silicone sock) |
| `fan_shroud` | box x −30…12, y −22…12 | z 4–13 | placeholder for the MK4 print-fan duct (left/front of the nozzle), deliberately generous |
| `extruder` | cylinder r 45 | z 13–200 | PrusaSlicer `*commonMK4*`: `extruder_clearance_radius = 45`, `extruder_clearance_height = 13` |
| `gantry` | box x ±1000, y −30…45 | z 20–400 | forum: "a bit over 20 mm" from the tip to the X-axis rods; Y extents are a guess |

`mk4s` currently reuses this geometry; the MK4S's 360° fan shroud sits only about 3 mm above the tip, so measure it before relying on the result.

```bash
node gcode-collide.mjs plate.bgcode --printer mk4 --grid 1.0 --margin 0.5 --png collision.png
# Or via Nix:
nix run .#collide -- plate.bgcode --png collision.png
```

| Option | Default | Description |
|---|---|---|
| `--printer NAME\|PATH` | `mk4` | Built-in profile (`mk4`) or path to a custom JSON/YAML printer profile |
| `--grid MM` | `1.0` | Deposited-material height-map grid resolution in mm |
| `--margin MM` | `0.5` | Horizontal safety margin added to deposited widths in mm |
| `--json PATH` | *(stdout)* | Also write the JSON collision report to `PATH` |
| `--png PATH` | *(none)* | Render the deposited geometry up to the first collision with the offending head parts overlaid (a render failure is added to `warnings` and does not change the exit status) |

Exit status: `0` = no collision, `1` = collision detected, `2` = error.

### Measuring your printer

The unmeasured parts are guesses on the safe side, so they reject some plates a real head would clear. With calipers, the head homed and the nozzle clean, measure:

1. Nozzle tip to the lowest edge of the print-fan shroud, and how far the shroud reaches left, right, in front of and behind the nozzle.
2. Nozzle tip to the bottom of the heater block / silicone sock, and the block's extents around the nozzle.
3. Nozzle tip to the underside of the X-axis extrusion / rods, and how far the carriage and beam extend in front of and behind the nozzle.
4. Anything else that hangs lower than 13 mm within 45 mm of the nozzle (cables, the hotend fan, the load-cell housing).

Then copy `profiles/mk4.json`, put the numbers in the matching parts (z ranges are heights above the tip; box x/y are offsets from the nozzle, +x right, +y towards the back of the printer; a part may overlap others), set `"measured": true` on the parts you measured, and pass the file with `--printer my-mk4.json` to either tool.

Parts whose `id` starts with `nozzle` are the nozzle itself. A part is **wide** when its horizontal reach (the shortest distance from the nozzle axis to its outer edge: a cylinder's `r`, a box's smallest of `-x_lo`, `x_hi`, `-y_lo`, `y_hi`) is at least 30 mm. On the MK4 that is the extruder body and the gantry, not the fan shroud or the heater block. The profile's clearance height (what PrusaSlicer calls `extruder_clearance_height`) is the lowest `z_lo` of a wide part, or the highest part start if none is wide. It sets the wipe-tower height limit, `--split-at clearance` (every wide part's `z_lo`) and the planner's clearance ladder; collisions are always checked against every part.

### Library Interface

```js
import { loadToolpath, loadProfile, DepositStore, checkMoves } from './lib/collide.mjs';

const profile = loadProfile('mk4');
const path = loadToolpath('plate.bgcode');
const store = new DepositStore(profile, { grid: 1 });
store.paint(path.movesOf(objectA));
const hits = checkMoves(profile, store, path.movesOf(objectB));
```

## Multicolour Sequential Planner (`gcode-sequence`)

`gcode-sequence` takes a multi-object G-code / `.bgcode` slice (sliced with PrusaSlicer's **Label objects** enabled; layer-interleaved or "complete objects") and a colour per object, and plans the fastest collision-free way to print it on a single-extruder printer with `M600` colour changes. It minimises the number of filament changes first and the added travel second. It emits a normalised (`G21`, `G90`, `M83`) G-code file that keeps all non-motion printer state, and accepts the plan only if `gcode-collide` verifies the emitted file clean.

```bash
node gcode-sequence.mjs plate.gcode -o sequenced.gcode --colours red,blue,red
# Or via Nix:
nix run .#sequence -- plate.gcode -o sequenced.gcode --colours ObjA=red,ObjB=blue --json report.json
```

How it plans:

- Each object is a stack of layer slices. A **step** prints one object from its current height up to a higher candidate height in one colour. A step never crosses a colour boundary; boundaries come from the file's tool / `M600` state per layer, or from `--colours`.
- **Colour regions:** an object whose parts use different filaments (say a raised inscription on extruder 2, with a tool change on every text layer) is split into one planning unit per colour. Each region's layers are rasterised on the deposit grid, and a layer that rests on another region's layer below may print only after that one (**support dependency**). So a white L with black text prints the whole L and then the text when the L's upright is out of the head's reach (1 change), or white, text, then the rest of the upright when it is close (2 changes). The checker decides which.
- **Candidate heights** per object (snapped to real layer tops, about a dozen at most): the top, every colour boundary, `--split-at` heights, the clearance ladder (multiples of the heights where the wide parts begin: 13 mm extruder body and 20 mm gantry on the MK4), and each neighbour's heights ± the height of every head part above the nozzle that can reach that neighbour from this object's footprint, or the other way round (on the MK4: 4 and 5 mm for the fan shroud and heater block of a close neighbour, 13 mm for one within 45 mm, 20 mm for the gantry), so a band can stop exactly where a neighbour's conflict with some part begins.
- **Feasibility** of a step comes from the phase-1 checker only: its descent, layers and glue moves run through `checkMoves` against the deposits of every other object at its current height plus the object's own lower layers (decomposed per object, which is exact because deposits combine by per-cell maximum).
- **Clusters:** units with material side by side on the same layers, so close that neither may lead the other by a single layer (the checker decides, typically the nozzle body reaching the neighbour), are planned as one unit printed layer by layer. Vertically stacked regions are ordered by the support dependencies instead. Each layer starts with the colour the previous one ended in, so a two-colour cluster costs one `M600` per layer, issued at the safe plane. The cluster is still banded against the rest of the plate.
- **Search:** A\* over (per-unit height, loaded colour), with an admissible bound on the remaining colour changes. When the plate exceeds `--max-states`, it switches to a beam search, then to a depth-first search for any feasible plan within its node budget. If the emitted file fails verification, the planner retries with finer candidates, then falls back to the fixed-split solver; the report names the planner that produced the plan.

- **Never worse than the file:** with either planner the file's own order is a candidate too. Unless a plan needs fewer filament changes (or the file's own order collides), the result is "no improvement": the input file is copied byte for byte to the output, the report describes the kept file and says why (`planner.name: "file-order"`, the rejected plan or failure under `planner.considered`; `travel_distance_mm` is `null`, as it is not estimated for the file's own order), and the exit status is 0. A file without colour changes is only checked, not planned, unless it collides.
- **Changes are counted from what the start G-code leaves loaded** (its last tool select; nothing known for an `M600` file without one): a plan whose first step needs another colour starts with a change, which is emitted and counted.
- **MMU files:** when the objects use more than one tool and the file changes colour only with tool changes (`T<n>` after the first object, no `M600`), the plan's changes are emitted as `T<n>`, and a change is estimated at the file's `filament_unload_time + filament_load_time` (from the slicer's config block; 30 s if absent or zero, PrusaSlicer's default for many filaments) instead of the profile's `change_cost_s` for `M600` (120 s); the report says which (`change_cost`). Purging is not regenerated (the wipe tower is dropped), so such an output is for analysis only, and the report warns. A file that passes through keeps its wipe tower.
- Object labels may be comments (`; printing object`) or firmware labels (`M486 S<n>` / `M486 A<name>`, names also from the `; objects_info` header; the first name seen for an id is kept, and an id never named becomes `object <n>`).

The report (text on stdout, JSON with `--json`) lists the steps and compares the plan's filament changes and estimated time with the file's own order and with printing whole objects one after another. That last baseline is judged by the feasibility tables only and is marked as not verified. Example, two 36 mm cubes side by side, about 92 mm apart in X in the same Y band. The extruder body (r 45) and the fan shroud do not reach across, but the X gantry, 20 mm above the nozzle and spanning all of X, rules out printing either cube whole first (a finished 36 mm cube is more than 20 mm above the other's first layer). The left cube can pause anywhere from 16 mm (resuming next to the finished right cube puts the gantry at 36 mm or more) up to about 20 mm (the gantry is 20 mm above the right cube's first layer); only the gantry's 20 mm level reaches the other cube, so the candidates are the same as with the earlier head model and the planner pauses at 19.8 mm. Our estimates use nominal feedrates (no acceleration, no wipe tower); when the file carries the slicer's `; estimated printing time (normal mode)`, the report shows it too (`slicer_estimate_s`), and a pass-through leads with it:

```
Plan: 3 step(s), 2 filament change(s), est. 12m 32s at nominal feedrate (A*, fewest changes over the candidate heights, 33 states)
Slicer estimate: 13m 03s for the file as sliced (its own order; the nominal-feedrate estimates here ignore acceleration and the wipe tower)
Colour change cost: 120 s (profile change_cost_s, M600)
   #  object                          Z from     Z to  colour
   1  fx_tall_left.stl id:0 copy 0      0.00    19.80  red
      -- M600: red -> blue
   2  fx_tall_right.stl id:1 copy 0     0.00    36.00  blue
      -- M600: blue -> red
   3  fx_tall_left.stl id:0 copy 0     19.80    36.00  red
Compared with:
  file order          239 change(s), 8h 06m
  sequential objects  infeasible (not verified)
Verified collision-free: yes
```

From JavaScript: `import { sequenceToolpath } from './lib/plan.mjs'` (`lib/sequence.mjs` holds slice extraction, the emitter and the fixed-split solver).

| Option | Default | Description |
|---|---|---|
| `-o`, `--output PATH` | *(none)* | Write the resequenced G-code to `PATH` (or give it as the second positional) |
| `--printer NAME\|PATH` | `mk4` | Built-in profile (`mk4`) or path to a custom JSON/YAML printer profile |
| `--colours SPEC` | *(from tool / `M600`)* | Colour per object (`c1,c2,...` by object index or `ObjA=c1,ObjB=c2`); an entry colours the whole object, so it is refused for an object the file itself changes tool/colour on (leave such objects out to use the file's colours) |
| `--split-at HEIGHTS` | *(none)* | Extra candidate heights in mm (e.g. `20`, or `clearance` for the heights where the wide head parts begin: `13,20` on the MK4) |
| `--grid MM` | `1.0` | Deposited-material grid resolution in mm |
| `--margin MM` | `0.5` | Horizontal safety margin in mm |
| `--max-candidates N` | `12` | Candidate pause heights per object (mandatory ones are always kept) |
| `--max-states N` | `200000` | A\* expansion budget before switching to beam search |
| `--beam N` | `2000` | Beam width of the fallback search |
| `--planner adaptive\|fixed` | `adaptive` | `fixed` = the earlier solver over chunks cut only at `--split-at` and colour boundaries (needs one colour per object layer) |
| `--json PATH` | *(none)* | Write the JSON report to `PATH`; `-` prints it to stdout instead of the text report |

Non-object extrusion other than the first-layer skirt/brim (upper skirt layers, a short wipe tower) is not emitted; when the input has any, the report includes a warning.

Exit status: `0` = feasible & verified collision-free, `1` = infeasible plate (prints conflict diagnostics), `2` = error.
