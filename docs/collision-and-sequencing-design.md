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
              [--json out.json] [--png out.png]
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

### Approach

Phase 1 has a weaker oracle than phase 2: nothing else will tell us whether
a G-code file hits the gantry except the printer itself. So the checker is
built around a reference it can be compared with, a test set that grows as
disagreements appear, and a small number of physical confirmations:

1. **Reference implementation first.** A deliberately naive checker: voxelise
   the deposited toolpath, and for every move intersect the volume each
   head part sweeps along it with the voxels by brute force. It is slow and
   obviously correct, and it is what the fast version is tested against on
   every fixture and on random toolpaths. Any optimisation (a height map,
   dilated footprints, incremental updates, coarser sampling) is accepted
   only while it matches the reference or is provably more conservative
   than it.
2. **Fixture set with expected verdicts.** Sliced with PrusaSlicer's CLI from
   `bench/mk4.ini`: tall cubes side by side in X with sequential printing
   (collision), front and back far apart (none), front and back close
   enough that only one order works, short cubes side by side (none), a
   normal interleaved multi-object plate (none), and the repo's real MMU and
   large fixtures (none). PrusaSlicer's own sequential-print validation
   decides the same question more conservatively, so its accept/reject
   verdict is recorded alongside ours as a cross-check and every
   disagreement is explained in the test.
3. **Property tests** that hold whatever the implementation: a print whose
   nozzle never drops below the deposited top never collides; adding
   deposited material never removes a collision; halving the grid or
   shrinking the margin never adds one; collapsed events cover exactly the
   lines the reference flags.
4. **Physical confirmation.** The two-cube front/back plate printed on the
   MK4 at the predicted boundary distance, which is also how the gantry
   measurements get confirmed, and a deliberately colliding plate stopped
   by hand just before contact.

The implementation choices (the deposited-material representation, how
head footprints are looked up, how overhangs are treated, how homing, park
and filament-change moves are modelled) are settled against the reference
and the fixtures during development rather than here. The one fixed
decision is that the tool errs conservative: it may over-report and must
never under-report relative to the reference.

### Shared toolpath reader

The parser inside `main()` of `gcode-sheet.mjs` (streaming line visitor,
fast float parsing, G0–G3 with arc interpolation, coordinate and extrusion
modes, `.bgcode` decoding) becomes a module both tools consume, emitting
moves with layer, object and feature attribution from PrusaSlicer's
`;LAYER_CHANGE`, `; printing object` and `;TYPE:` markers, plus homing,
pause and filament-change events. This is a refactor-only change whose
acceptance test is that `gcode-sheet` renders stay pixel-identical, which
`nix flake check` already verifies.

### Library interface (what phase 2 consumes)

```js
import { loadToolpath, DepositStore, checkMoves } from './lib/collide.mjs';
const path  = loadToolpath('plate.bgcode');            // moves + objects + chunks
const store = new DepositStore(profile, { grid: 1 });
store.paint(path.movesOf(objectA));                    // deposit A
const hits  = checkMoves(profile, store, path.movesOf(objectB)); // print B after A?
```

`checkMoves` only reads the store, so phase 2 can paint a set of chunks
once and test many candidates against it.

### Milestones

1. Extract the shared toolpath reader; `gcode-sheet` tests unchanged.
2. Printer profile schema + MK4 profile with PrusaSlicer-derived defaults.
3. Reference checker and the fixture set with expected verdicts, in CI.
4. Fast checker, accepted against the reference and the property tests.
5. CLI, JSON report, event collapsing, exit codes, PNG overlay.
6. Measure the gantry on a real MK4, print the boundary plate, set
   `measured: true`.

## Phase 2: `gcode-sequence`

### Problem

Input: one sliced file with *Label objects* enabled and interleaved layers
(the normal, non-sequential slice), plus a colour per object. Output: an
order of print chunks, the number of filament changes, the estimated time,
and a rewritten G-code file that phase 1 reports as collision-free.

A **chunk** is an object, or an object's Z band when a tall object is split
at the clearance height so that all the short bottoms can be printed in any
colour grouping and only the tall tops need sequencing; an object's chunks
are always printed in Z order. Print time of a chunk does not depend on
order, so the order only changes the number of filament changes (dominant)
and the travel between chunks (tie-breaker).

### Approach

The phase 1 checker is the oracle, and the sequencer is developed against
it rather than specified ahead of it:

1. **Build the test set first.** Slice the phase 1 fixtures (side-by-side
   and front/back cubes, short and tall, two and three colours) plus a few
   real plates with PrusaSlicer's CLI, and record for each the orders a human
   expects to be feasible or infeasible and the minimum number of colour
   changes. These are the acceptance tests; new ones are added whenever the
   checker finds something the sequencer did not predict.
2. **Generate candidate orders, verify every one with the checker.** The
   sequencer never trusts its own feasibility reasoning. Whatever shortcut it
   uses to prune the search (a pairwise compatibility matrix, colour
   grouping, a DP over subsets) is a heuristic; the emitted G-code is run
   through `gcode-collide` and only a clean result is accepted. A rejected
   candidate is a test case, not a surprise.
3. **Property tests on the emitter.** For random chunk orders of a fixture:
   the output's total extrusion and per-object move counts equal the input;
   every object renders identically in `gcode-sheet`'s top view; the walker
   parses the output to the same absolute positions it would have reached
   in the input, regardless of the input's E and coordinate modes; every
   move executes under the same printer state (fan, temperatures,
   acceleration, flow) as it did in the input; and the checker's verdict
   on the output matches the sequencer's prediction. Any
   mismatch is a bug in the prediction, and the property test pins it.
4. **Iterate on the search only as the tests demand.** Start with the
   simplest thing (colour groups, tall chunks last, verify), and add
   machinery (splitting, exact search, smarter glue moves) when a fixture
   shows a feasible, cheaper order the current version misses.

The details that would otherwise be argued in prose (how glue moves are
chosen, how coordinates are rebased, where the safe travel height sits
relative to the Z limit, whether pairwise checks suffice) are exactly the
things the checker and the property tests can prove or refute during
development, so they are left to it.

### Milestones

1. Fixture plates with expected verdicts and change counts; CI runs them.
2. Chunk extraction from labelled files and a G-code emitter under the
   property tests above.
3. First sequencer (colour grouping + verify) passing the fixtures.
4. Splitting at the clearance height and an exact search where the
   fixtures show the simple version is not optimal.
5. A real MK4 test print of the two-cube front/back plate.

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
- **Over-reporting** on bridges and overhangs is accepted for a safety tool;
  how far to refine the deposited-material model is decided by the
  fixtures, not in advance.
- **Thermal effects** of printing a tall part next to a long-cooled one
  (adhesion, re-warming) are not modelled; the tool orders for collisions and
  time only.
