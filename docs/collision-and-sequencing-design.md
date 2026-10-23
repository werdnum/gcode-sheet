# Design: print-head collision checking and multicolour sequencing

Two tools, built in this repository so they share the streaming G-code /
`.bgcode` reader and the headless renderer that `gcode-sheet` already has:

1. **`gcode-collide`** — given a sliced file and a printer profile, report
   whether the print head (nozzle, extruder body, X gantry) would hit material
   that was deposited earlier in the same file, and where.
2. **`gcode-sequence`** — given a plate of objects, each printed in one colour,
   find the fastest collision-free order to print them on a single-extruder
   printer (minimal filament changes), and emit the re-ordered G-code.

Phase 2 is a search over orders whose feasibility oracle is phase 1's core
library, so phase 1 is designed as a library first and a CLI second.

## Scope and assumptions

- **Target printer:** Original Prusa MK4 / MK4S family (i3 "bed slinger":
  bed moves in Y, head moves in X along a beam that is fixed in Y, Z moves the
  beam). The geometry is a data profile, so other printers are a new profile,
  not new code. A CoreXY or fixed-bed machine only changes the profile's
  gantry prisms (the sweep is along a different axis), not the algorithm.
- **"Collision" means** a volume of the moving head, at some instant of the
  print, intersects material deposited before that instant. Material deposited
  by the same layer or earlier of the *same* object is always at or below the
  nozzle and never collides; collisions only arise from sequential ("complete
  objects") printing, from re-sequenced prints (phase 2), and from parked/wipe
  moves over finished parts.
- **Out of scope:** curling overhangs, warped parts, spaghetti, bed clips,
  purge-line blobs. These are not derivable from G-code. The tool models
  deposited material as the nominal toolpath.
- **"Multicolour print" in phase 2** means a plate where each object (or each
  separately sliced body) is a single colour and colour is changed with `M600`
  on a single extruder. MMU prints already have no sequencing problem the
  slicer does not handle. An object with internal colour changes can be
  represented as a stack of Z-band chunks, each monochrome (see phase 2).

## Printer model

A profile is a JSON/YAML file listing **head parts**, each a volume expressed
in nozzle-tip coordinates (x, y relative to the tip; z measured *up* from the
tip), plus bed and axis limits. Volumes are axis-aligned boxes or cylinders,
which keeps every query a rectangle/disc lookup; a convex-hull-from-STEP
importer can refine a part later without changing the query code.

```yaml
name: Prusa MK4
bed: { x: [0, 250], y: [0, 210], z_max: 220 }
parts:
  - id: nozzle           # brass tip + heater block, small radius, starts at the tip
    shape: cylinder
    r: 4
    z: [0, 12]
  - id: extruder         # Nextruder body, fan shroud, hotend fan
    shape: cylinder
    r: 45                # PrusaSlicer MK4 profile extruder_clearance_radius
    z: [20, 120]         # PrusaSlicer MK4 profile extruder_clearance_height = 20
  - id: gantry           # X beam + carriage: spans the whole X travel
    shape: box
    x: [-1000, 1000]     # "infinite" in X: the beam covers every X position
    y: [-30, 45]         # extent in front of / behind the nozzle (measure)
    z: [20, 400]         # beam underside above the tip (measure)
park:
  m600: { x: 0, y: 210, z_lift: 0 }   # where M600 parks and how much it lifts
```

Default numbers come from PrusaSlicer's MK4 sequential-printing clearance
settings, which encode a cylinder of radius 45 mm above 20 mm. The gantry Y
extents and underside height must be **measured** (calipers on the printer, or
the published MK4 STEP models). The profile ships with a `measured: false`
flag per part so results carry a warning until someone fills them in. The
gantry's Y extent is deliberately asymmetric because the Nextruder hangs
forward of the beam; the asymmetry is what makes "front then back" sometimes
feasible in only one order, which phase 2 exploits.

Because the bed moves, all geometry is expressed in **bed coordinates** (the
coordinates G-code uses). In that frame the head at nozzle position (x, y, z)
occupies, for the gantry part, all of X, the Y band `[y - 30, y + 45]`, and
heights above `z + 20`. That reproduces the user's intuition: two tall parts
side by side in X fail (same Y band), one at the front and one at the back
pass if the Y gap exceeds the gantry's reach in that direction.

## Phase 1: `gcode-collide`

### Inputs and outputs

```
gcode-collide part.bgcode --printer mk4 [--grid 1.0] [--margin 0.5]
              [--json out.json] [--png out.png] [--fail-on-collision]
```

Output is a JSON report on stdout (the `gcode-sheet` convention) and exit
status 0/1/2 (no collision / collision / error):

```json
{
  "collides": true,
  "events": [
    { "line": 184233, "layer": 61, "z": 12.2, "nozzle": [112.4, 88.0],
      "part": "gantry", "hit_object": "Benchy id:2 copy:1",
      "hit_cell": [40, 85], "deposited_top": 48.0, "penetration_mm": 15.8,
      "move": "G1 X112.4 Y88.0 E0.0413" }
  ],
  "objects": [ { "name": "Benchy id:1 copy:0", "bbox": ..., "top": 48.0 } ],
  "summary": { "events": 1240, "first_line": 184233, "parts_hit": ["gantry"] }
}
```

Consecutive events with the same part and object are collapsed into one range
(first/last line, max penetration) so a sequential print that drags the gantry
through a neighbour reports one incident, not ten thousand. `--png` renders
the deposited geometry with the offending head position overlaid, using the
existing Three.js/llvmpipe path.

### Components

**1. Toolpath walker (shared with `gcode-sheet`).** Extract the parser inside
`main()` of `gcode-sheet.mjs` (`visitGcodeLines`, `parseFastFloat`, the
G0/G1/G2/G3 handling with arc interpolation, absolute/relative E and
coordinates, `.bgcode` decoding via `bgcode`) into `lib/toolpath.mjs` that
emits a stream of moves: `{ line, x0,y0,z0, x1,y1,z1, extruding, feedrate,
layer, object, type }`. It also tracks the markers the collision tool needs:

- `;LAYER_CHANGE` / `;Z:` (already parsed);
- `; printing object <name> id:N copy:M` / `; stop printing object ...`
  (PrusaSlicer *Label objects*; required for per-object attribution and for
  phase 2's chunking — the tool warns when absent and treats the file as one
  object);
- `M600`, `T<n>`, `M601`/`M0`/pause: filament-change and pause events, which
  are modelled as a move to the profile's park position;
- `G28`, `G92`, `M82/M83`, `G90/G91`: homing and coordinate-mode state.

`gcode-sheet` keeps its behaviour and tests; it just consumes the module. This
is a refactor-only PR with pixel-identical output as the acceptance test.

**2. Deposited-geometry store.** A 2-D grid over the bed at `--grid` mm
(default 1 mm → 250×210 = 52 500 cells for the MK4) holding, per cell:

- `top`: highest Z deposited so far;
- `bottom`: lowest Z deposited so far (lets a bridge or a part printed on a
  raft be distinguished from a solid column; the first version treats
  `[bottom, top]` as solid);
- `object`: id of the last object that deposited there.

Rasterising an extruding move widens the segment by half the extrusion width
plus `--margin` and paints every cell it crosses. This is conservative: it can
over-report by at most one grid cell plus the margin, never under-report.
If false positives from true overhangs matter later, the per-cell record can
become a short list of Z intervals without changing the query interface.

**3. Collision query.** For every move (extruding or travel) the walker
samples the nozzle position at most once per grid cell along the segment, and
for every head part asks: *does any cell in the part's footprint around the
nozzle have deposited material above `z + part.z_lo` and below
`z + part.z_hi`?*

Naively that is footprint-area work per sample. Instead the store maintains,
per part, a **dilated top map**: `dilated[p][cell] = max(top over the part's
footprint centred on cell)`. Then a sample is one lookup and one comparison.
The dilated maps are kept incremental: painting a cell updates the dilated
values in its neighbourhood (a 45 mm radius disc is ~6 400 cells, but a cell
is painted once per layer, so the whole print costs on the order of
`layers × cells painted × neighbourhood`; for the gantry the footprint is a
full-width Y band so its map is one dimension, `dilatedGantry[y]`, and updates
are a 75-entry loop). A benchy-sized file checks in seconds; a full 4-object
plate in well under a minute. If that proves slow, replace the incremental
disc update with a per-layer rebuild via van Herk/Gil-Werman running maxima.

Within one object nothing above the nozzle exists, so the check short-circuits
whenever `dilated[part][cell] <= z + part.z_lo`, which is the common case.

**4. Object attribution.** When the walker is inside a labelled object, the
painted cells carry that id, and a hit reports both the object being printed
and the object hit. Without labels, the report still gives coordinates and
the line number.

**5. Special moves.** Homing (`G28`) is modelled as a move of the head to the
profile's home position at the current Z (MK4 homes XY before Z). `M600`
and pauses are modelled as the park move from the profile; the first
measurement task is to confirm on the MK4 whether M600 lifts Z (user reports
suggest it does not, which makes a park move over a finished neighbour a real
collision risk and exactly what phase 2 must plan around).

### Library interface (what phase 2 consumes)

```js
import { loadToolpath, DepositStore, checkMoves } from './lib/collide.mjs';
const path  = loadToolpath('plate.bgcode');            // moves + objects + chunks
const store = new DepositStore(profile, { grid: 1 });
store.paint(path.movesOf(objectA));                    // deposit A
const hits  = checkMoves(profile, store, path.movesOf(objectB)); // print B after A?
```

`checkMoves` is pure with respect to the store (it only reads), so phase 2 can
paint a set of chunks once and test many candidates against it.

### Validation

- **Synthetic fixtures** generated with PrusaSlicer CLI (`bench/mk4.ini`
  already drives it): two 60 mm-tall cubes (a) side by side in X with
  `complete_objects = 1` → expect gantry collision; (b) front and back,
  separated by more than the gantry reach → expect none; (c) front and back,
  separated by less than the gantry reach → expect collision in exactly one of
  the two orders; (d) two 10 mm cubes side by side → expect none (below the
  20 mm clearance); (e) a normal interleaved multi-object print → none.
  Cases (a)–(d) are also what PrusaSlicer's own sequential-print validation
  accepts or rejects, so the slicer's verdict is a cross-check (PrusaSlicer is
  more conservative: it allows only the last object to exceed the clearance
  height, with no gantry Y model).
- **Parser parity:** `gcode-sheet` renders stay pixel-identical after the
  extraction (the existing `nix flake check` already compares PNGs).
- **Real prints:** the Prusa MMU and large fixtures used by the benchmarks
  must report no collision.

### Milestones

1. Extract `lib/toolpath.mjs` from `gcode-sheet.mjs`; tests unchanged.
2. Printer profile schema + MK4 profile with PrusaSlicer-derived defaults.
3. Deposit store + per-part dilated maps + `checkMoves`.
4. CLI, JSON report, event collapsing, exit codes.
5. Synthetic fixtures (a)–(e) as `node --test` cases; add to `nix flake check`.
6. PNG overlay of collisions via the existing renderer.
7. Measure the gantry extents on a real MK4 and set `measured: true`.

## Phase 2: `gcode-sequence`

### Problem

Input: one sliced file with *Label objects* enabled and interleaved layers
(the normal, non-sequential slice), plus a colour assignment per object
(`--colours "Benchy id:1=red,Stand id:2=blue"` or a sidecar file; objects
sliced with a per-object filament colour can be read from the file's
`; filament_colour` and `T` state when present). Output: an order of print
**chunks**, the number of filament changes, the estimated time, and a
rewritten G-code file.

The **scheduling unit is a chunk** = (object, Z band). The simplest run uses
one chunk per object (print each object completely, as `complete_objects`
would). Allowing an object to be split at the clearance height (everything up
to 20 mm, then the rest) is a cheap and valuable generalisation: all objects'
bottoms can be printed interleaved in any colour grouping with no collision at
all, and only the tall tops need sequencing. The chunk boundaries are a
parameter (`--split-at 20` or a list of heights); the search handles any set.

### Feasibility from phase 1

Chunk j may be printed when chunk i has already been printed iff
`checkMoves(profile, store(i), moves(j))` reports nothing. Because the head
collides with a union of deposited chunks iff it collides with at least one
of them, the pairwise matrix `ok[i][j]` ("j after i") decides feasibility of
any order: an order is feasible iff every earlier/later pair is `ok`. That is
n² phase-1 checks, each sub-second, and chunks of the same object are forced
into Z order.

The moves tested for chunk j are not only its extrusion moves but the **glue
moves** the re-sequencer will add: lift to a safe travel height, move over
the chunk, descend, and, where a colour change precedes it, the park move.
The safe height is the maximum deposited top plus the nozzle part height, so
a travel at that height is collision-free for every part (raising the nozzle
raises the gantry with it). The descent is the dangerous move: with a tall
neighbour in the gantry's Y band, dropping the nozzle back to a low layer of a
short object collides even though the travel did not. The matrix captures
this because the glue moves are included in `moves(j)`.

Diagnostics when no order exists: report the pair(s) with `ok[i][j]` and
`ok[j][i]` both false and the part/height involved, so the user can move the
object on the plate or lower the split height.

### Objective

Print time of a chunk is order-independent (its moves are copied verbatim),
so the order only changes:

- **Filament changes:** count of colour transitions × `change_cost` (default
  120 s, profile-settable; also reported as a plain count since it is the
  number of times a human must attend the printer);
- **Glue travel:** lift/travel/descend per chunk transition, estimated from
  distance and the file's travel feedrate (seconds each, usually negligible
  but it is what breaks ties);
- **Reheat/cool-down:** ignored in the first version.

So the cost of an order is `Σ transition_cost(prev, next)`, a TSP-with-
precedence over at most a few dozen chunks.

### Solver

- n ≤ ~20 chunks: exact Held–Karp DP over subsets, `O(2ⁿ · n²)`, with the
  precedence matrix pruning states (a state `S` with last chunk `l` is valid
  only if `ok[i][l]` for all `i ∈ S` and the same-object Z-order holds).
  Twenty chunks is a million states times twenty, well within a second in JS.
- Larger n: greedy by colour groups (print every chunk of one colour, then the
  next, choosing the group order that keeps tall chunks last) followed by
  2-opt / or-opt local search under the same feasibility check. Since colour
  changes dominate, the greedy solution is usually optimal already; the exact
  solver is there to prove it on small plates and to catch the asymmetric
  front/back cases where the cheaper colour grouping is only reachable in one
  direction.

### Re-sequencer (G-code output)

Emit the original header and start G-code, then for each chunk in order:

1. If the colour differs from the previous chunk: lift to safe height, emit
   `M600` (or the profile's change macro), and the park move is checked as
   part of the matrix.
2. Lift to safe height, travel to the chunk's first point, descend, restore
   `;Z:`/`;LAYER_CHANGE` markers so the printer's progress display and
   `gcode-sheet` still work.
3. Copy the chunk's layer blocks verbatim (retract/unretract state carried
   across because the walker tracks E and the cut points are at
   `; printing object` boundaries, where PrusaSlicer has already retracted).
4. Skirt/brim, purge line and wipe tower blocks (which belong to no object)
   are printed first at their original heights, since they are all first-layer
   or below the clearance; a wipe tower taller than the clearance makes the
   file unsuitable and is reported.

Finally **run phase 1 on the output file**. The re-sequenced file must come
back collision-free; this closes the loop and catches any glue move the
matrix did not model. The design keeps the matrix and the emitter using the
same glue-move generator so the two cannot drift.

### Validation

- The synthetic fixtures from phase 1, assigned colours, with expected
  orders: side-by-side tall parts in two colours → infeasible as whole
  objects, feasible with `--split-at 20` and exactly one colour change in the
  bottom band plus one per tall top; front/back parts → the order the
  asymmetric gantry permits.
- Re-sequenced output: phase 1 reports no collision; total extrusion length
  and per-object move counts equal the input (nothing lost or duplicated);
  `gcode-sheet` renders the before and after plates identically in the top
  view.
- A real MK4 test print of the two-cube front/back case, which is also how
  the gantry measurements get confirmed.

### Milestones

1. Chunk extraction from labelled files (object × Z band) + glue-move
   generator.
2. Pairwise matrix via the phase-1 library; infeasibility diagnostics.
3. Exact DP solver + greedy/local-search fallback; cost model and report.
4. G-code emitter + phase-1 verification pass on the output.
5. Fixtures and tests; `nix flake check` integration; README.

## Risks and open questions

- **Head geometry accuracy** is the whole game for phase 1. The PrusaSlicer
  numbers are a safe envelope for the extruder but say nothing about the
  gantry; until the MK4 beam is measured the tool should err conservative and
  say so in its report.
- **M600 behaviour on Buddy firmware** (park position, whether Z lifts, the
  reported 20 mm unload lift) must be confirmed on the printer, as it decides
  whether colour changes can happen next to a finished tall part.
- **Label objects** must be on in PrusaSlicer for phase 2 and for per-object
  attribution in phase 1; the tools say so loudly when the markers are
  absent.
- **Solid-column assumption** in the deposit store over-reports for bridges
  and overhangs printed over empty space; acceptable for a safety tool, and
  the per-cell interval list is the escape hatch.
- **Thermal effects** of printing a tall part next to a long-cooled one
  (adhesion, re-warming) are not modelled; the tool orders for collisions and
  time only.
