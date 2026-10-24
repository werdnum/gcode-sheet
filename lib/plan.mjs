// lib/plan.mjs: adaptive multicolour print planner and the gcode-sequence entry point.
// Each planning unit (an object, or a cluster of objects too close to print apart) is a stack of
// layer slices; a plan is an ordered list of steps (unit, zLo -> zHi). Step feasibility comes
// from the phase-1 checker (checkMoves against DepositStores), the search is A* over per-unit
// heights with beam / depth-first fallbacks, and the emitted G-code is accepted only if
// checkToolpath verifies it clean. Builds on lib/sequence.mjs (slices, emitter, fixed solver).
import { DepositStore, checkMoves, checkToolpath, loadProfile } from './collide.mjs';
import { unmeasuredWarning, wideClearanceHeights } from './profiles.mjs';
import {
  EPS,
  InputError,
  extractSlices,
  buildFixedChunks,
  buildBandChunk,
  appendSliceMoves,
  sliceFirstMotion,
  sliceTransitionMoves,
  descentMove,
  liftMove,
  movesPrintTime,
  emitResequencedGcode,
  evaluateOrderCost,
  buildPairwiseMatrix,
  solveChunkOrder,
} from './sequence.mjs';

const CHANGE_WEIGHT = 1e6;            // lexicographic: one filament change outweighs any travel
const STEP_TIEBREAK = 1e-3;           // among equal plans prefer fewer steps (fewer lifts/descents)
export const DEFAULT_MAX_CANDIDATES = 12;
export const DEFAULT_MAX_STATES = 200000;
export const DEFAULT_BEAM = 2000;

const r3 = (z) => +Number(z).toFixed(3);
const clean = (profile, store, moves) => checkMoves(profile, store, moves, { stopOnFirst: true });

// Largest layer top <= z (null if z is below the first layer).
function snapDown(tops, z) {
  let lo = 0, hi = tops.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= z + EPS) { best = tops[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// Z of the first layer printed after stopping at height h.
function nextLayerZ(tops, h) {
  for (const t of tops) if (t > h + EPS) return t;
  return Infinity;
}

// Pick `count` items spread evenly over a sorted list.
function spread(list, count) {
  if (count <= 0) return [];
  if (list.length <= count) return list;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(list[Math.round(((i + 0.5) * list.length) / count - 0.5)]);
  }
  return [...new Set(out)];
}

const sliceMoves = (slice, segs) => {
  const moves = [];
  appendSliceMoves(moves, slice, segs);
  return moves;
};

function makeUnit(name, members, slices) {
  slices.sort((a, b) => a.z - b.z || a.fileOrder - b.fileOrder);
  // Within one layer the members of a cluster may print in any order (equal heights never
  // collide), so each layer starts with the colour the previous layer ended in: one change per
  // layer for two colours instead of two. Single objects are unaffected (one colour per layer).
  const ordered = [];
  let lastColour = null;
  for (let i = 0; i < slices.length;) {
    let j = i;
    while (j < slices.length && slices[j].z === slices[i].z) j++;
    const layer = slices.slice(i, j);
    const first = layer.filter((s) => s.colour === lastColour);
    ordered.push(...first, ...layer.filter((s) => s.colour !== lastColour));
    lastColour = ordered[ordered.length - 1].colour;
    i = j;
  }
  const tops = [...new Set(ordered.map((s) => s.z))].sort((a, b) => a - b);
  // Colour signature of each layer height: the set of colours printed on that layer. A step
  // never crosses a change of signature (for a single object: a colour boundary).
  const coloursAt = new Map();
  for (const s of ordered) {
    if (!coloursAt.has(s.z)) coloursAt.set(s.z, new Set());
    coloursAt.get(s.z).add(s.colour);
  }
  const sigAt = new Map([...coloursAt].map(([z, set]) => [z, [...set].sort().join('\u0000')]));
  const parents = [...new Set(ordered.map((s) => s.object))];
  return { name, members, parents, slices: ordered, tops, top: tops[tops.length - 1], sigAt };
}

/**
 * Planning units. Every (object, colour) region is a unit: an object whose parts print in
 * different filaments (an inscription on another extruder) becomes one unit per colour, each a
 * Z-ordered stack of that colour's slices; labels and reports keep the parent object's name.
 *
 * Units that can only be printed layer by layer are merged into one unit (a cluster). The
 * rule: at a sampled height z (from the lower unit's layers; each unit's own layer at or below z),
 * a cannot print its layer while b already has its next layer above it, AND b cannot print its
 * layer while a has its next layer: neither may ever lead by one layer, which no banded plan
 * expresses. Layer schedules need not match (variable layer heights).
 * Vertically stacked regions are kept apart by the support relation instead: if one unit rests
 * on the other and not the other way round (an inscription on a body), the pair is ordered by
 * the dependency rule and never clustered, even though "body layer vs the inscription's next
 * layer" hits by construction. Supports in both directions (material interlocking on
 * alternating layers, or regions side by side whose dilated footprints touch) leave the pair
 * to the collision test, since layer-by-layer printing is then what those dependencies need.
 * The verdict is the checker's (checkMoves on a's layer plus its descent against b's next
 * layer only; b's lower layers lie below a's nozzle and cannot be hit), so the profile decides,
 * not a distance rule. A cluster's slices are its members' slices in layer order, in file order
 * within a layer. Also returns the support dependencies of the final units.
 */
export function clusterUnits(extracted, profile, options = {}) {
  const { toolpath, objectLayerSlices, segmentsByLine } = extracted;
  const storeOpts = { grid: options.grid, margin: options.margin };
  const singles = [];
  for (const obj of toolpath.objects) {
    const byColour = new Map();
    for (const sl of objectLayerSlices.get(obj.name) || []) {
      if (!byColour.has(sl.colour)) byColour.set(sl.colour, []);
      byColour.get(sl.colour).push(sl);
    }
    for (const [colour, slices] of byColour) {
      const name = byColour.size > 1 ? `${obj.name} (${colour})` : obj.name;
      singles.push(makeUnit(name, [name], slices));
    }
  }
  const highZ = Math.min(profile.bed.z_max ?? 220, Math.max(0, ...singles.map((u) => u.top)) + 1.0);

  const lockedBy = (a, b, z) => {
    const ta = snapDown(a.tops, z);
    if (ta === null) return null;
    const nb = nextLayerZ(b.tops, ta);
    if (!Number.isFinite(nb)) return null;
    const store = new DepositStore(profile, storeOpts);
    for (const s of b.slices) if (Math.abs(s.z - nb) < EPS) store.paint(sliceMoves(s, segmentsByLine));
    const moves = [];
    for (const s of a.slices) if (Math.abs(s.z - ta) < EPS) appendSliceMoves(moves, s, segmentsByLine);
    if (moves.length === 0) return null;
    moves.unshift(descentMove([moves[0].x0, moves[0].y0, moves[0].z0], highZ, { ...moves[0], object: a.name }));
    return clean(profile, store, moves)[0] || null;
  };

  const singleDeps = regionDependencies(singles, extracted, profile, options);
  const restsOn = (x, y) => singleDeps[x].some((d) => d.unit === y);
  const parent = singles.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const evidence = [];
  for (let ai = 0; ai < singles.length; ai++) {
    for (let bi = ai + 1; bi < singles.length; bi++) {
      const a = singles[ai];
      const b = singles[bi];
      if (restsOn(ai, bi) !== restsOn(bi, ai)) continue; // stacked: ordered by support instead
      const low = a.top <= b.top ? a.tops : b.tops;
      const samples = [...new Set([low[Math.min(1, low.length - 1)], low[low.length >> 1], low[Math.max(0, low.length - 2)]])];
      for (const z of samples) {
        const hitA = lockedBy(a, b, z);
        if (!hitA) continue;
        const hitB = lockedBy(b, a, z);
        if (!hitB) continue;
        parent[find(bi)] = find(ai);
        evidence.push({ objects: [a.name, b.name], z: r3(z), parts: [hitA.part, hitB.part] });
        break;
      }
    }
  }

  const groups = new Map();
  singles.forEach((u, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(u);
  });
  const units = [];
  const clusters = [];
  for (const members of groups.values()) {
    if (members.length === 1) { units.push(members[0]); continue; }
    const names = members.map((m) => m.name);
    const name = `[${names.join(' + ')}]`;
    units.push(makeUnit(name, names, members.flatMap((m) => m.slices)));
    clusters.push({
      name,
      objects: names,
      evidence: evidence.filter((e) => names.includes(e.objects[0])),
    });
  }
  const deps = clusters.length === 0 ? singleDeps : regionDependencies(units, extracted, profile, options);
  return { units, clusters, deps };
}

/**
 * Support dependencies between units of one object, so a region is never printed over air.
 * Each (unit, object, layer) footprint is rasterised on the deposit grid with the store's own
 * painter, dilated by one extrusion width; where a unit's layer z overlaps another unit's
 * footprint on the object's layer immediately below z, that unit must be printed up to that
 * layer first. Only units of the same parent object are compared (slicer objects never
 * overlap); a cluster's own members need nothing (it prints them layer by layer). Returns per
 * unit a list of { z, unit, zBelow }.
 */
export function regionDependencies(units, extracted, profile, options = {}) {
  const { segmentsByLine } = extracted;
  const width = 0.45;
  const footprints = new Map();
  const footprint = (ui, parent, z) => {
    const key = `${ui}|${parent}|${z}`;
    let cells = footprints.get(key);
    if (cells) return cells;
    const store = new DepositStore(profile, { grid: options.grid, margin: width });
    for (const sl of units[ui].slices) {
      if (sl.object === parent && sl.z === z) store.paint(sliceMoves(sl, segmentsByLine));
    }
    const list = [];
    for (let i = 0; i < store.top.length; i++) if (store.top[i] > 0) list.push(i);
    cells = Int32Array.from(list);
    footprints.set(key, cells);
    return cells;
  };
  const overlaps = (a, b) => {
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) return true;
      if (a[i] < b[j]) i++; else j++;
    }
    return false;
  };

  const deps = units.map(() => []);
  const parents = new Map(); // parent -> { tops, units: Map(ui -> Set(z)) }
  units.forEach((u, ui) => {
    for (const sl of u.slices) {
      if (!parents.has(sl.object)) parents.set(sl.object, { zs: new Set(), units: new Map() });
      const p = parents.get(sl.object);
      p.zs.add(sl.z);
      if (!p.units.has(ui)) p.units.set(ui, new Set());
      p.units.get(ui).add(sl.z);
    }
  });
  for (const [parent, p] of parents) {
    if (p.units.size < 2) continue;
    const tops = [...p.zs].sort((a, b) => a - b);
    for (const [ui, zs] of p.units) {
      for (const z of zs) {
        const t = tops.indexOf(z);
        if (t <= 0) continue;
        const zBelow = tops[t - 1];
        for (const [ti, tzs] of p.units) {
          if (ti === ui || !tzs.has(zBelow)) continue;
          if (overlaps(footprint(ui, parent, z), footprint(ti, parent, zBelow))) {
            deps[ui].push({ z, unit: ti, zBelow });
          }
        }
      }
    }
  }
  return deps;
}

/**
 * Candidate heights at which a unit may pause so another unit can be printed.
 *
 * Why these heights: each head part above the nozzle starts at some height C above the tip
 * (profile.clearance_levels: on the MK4 the fan shroud and heater block a few mm up, the
 * extruder body at 13 mm, the X gantry at 20 mm). A neighbour standing at height h' within
 * that part's reach therefore blocks printing (and descending onto) this unit exactly while
 * the nozzle is below h' - C. So the heights where feasibility can change are, for every
 * level C:
 *  - mandatory: the unit's top, every colour boundary (a step never crosses one), the
 *    heights other units' layers rest on (support dependencies), and the user's --split-at
 *    heights;
 *  - for every neighbour height h' (its mandatory heights, its ladder and 0):
 *      nextLayer(h') + C  the highest this unit may stand and still let the neighbour resume
 *                         from h' (the band stops exactly where the gantry conflict begins);
 *      h' - C             the lowest pause from which this unit can resume next to h';
 *  - the clearance ladder k * C for the wide parts (C >= profile.clearance_height, the extruder
 *    body and gantry), which links those conditions across more than two units.
 * Everything is snapped down to an actual layer top of the unit and deduplicated. Mandatory
 * heights are always kept; the rest are capped at maxCandidates per unit, preferring the
 * neighbour + C heights, then the ladder, then neighbour - C, thinned evenly when over the cap.
 */
export function computeCandidateHeights(units, profile, options = {}) {
  const C0 = profile.clearance_height ?? 20;
  const levels = profile.clearance_levels?.length ? profile.clearance_levels : [C0];
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const ladderSteps = wideClearanceHeights(profile).map((C) => C / Math.max(1, options.ladderDivisor ?? 1));
  const splitHeights = options.splitHeights || [];
  const extraMandatory = options.extraMandatory || [];

  const mandatory = units.map((u, ui) => {
    const set = new Set([u.top, ...(extraMandatory[ui] || [])]);
    for (let i = 1; i < u.tops.length; i++) {
      if (u.sigAt.get(u.tops[i]) !== u.sigAt.get(u.tops[i - 1])) set.add(u.tops[i - 1]);
    }
    for (const s of splitHeights) {
      const z = snapDown(u.tops, s);
      if (z !== null) set.add(z);
    }
    return set;
  });
  const ladder = units.map((u) => {
    const list = [];
    for (const step of ladderSteps) {
      for (let k = 1; k * step < u.top - EPS; k++) {
        const z = snapDown(u.tops, k * step);
        if (z !== null) list.push(z);
      }
    }
    return [...new Set(list)];
  });

  return units.map((u, idx) => {
    const plus = [];
    const minus = [];
    units.forEach((u2, idx2) => {
      if (idx2 === idx) return;
      for (const h2 of [0, ...mandatory[idx2], ...ladder[idx2]]) {
        for (const C of levels) {
          const up = snapDown(u.tops, nextLayerZ(u2.tops, h2) + C);
          if (up !== null) plus.push(up);
          const down = snapDown(u.tops, h2 - C);
          if (down !== null) minus.push(down);
        }
      }
    });
    const chosen = new Set(mandatory[idx]);
    for (const group of [plus, ladder[idx], minus]) {
      const fresh = [...new Set(group)].filter((z) => !chosen.has(z)).sort((a, b) => a - b);
      for (const z of spread(fresh, maxCandidates - chosen.size)) chosen.add(z);
    }
    return [...chosen].sort((a, b) => a - b);
  });
}

/**
 * Build the planning model: per unit its candidate heights, elementary bands between
 * consecutive candidates, and the feasibility tables.
 *
 * Feasibility is decided by checkMoves only. A step (u, i -> j) is checked as the move list
 * [descent onto band i+1 from above the plate, band i+1, glue, band i+2, ..., band j]; the
 * descent's verdict does not depend on where it starts because every head part is lowest at
 * its end. The store it is checked against is base (skirt) U own layers U every other unit
 * at its current height. DepositStore.paint keeps the per-cell maximum, and checkMoves reports
 * a hit iff some cell under a part is above that part, so a move hits the union iff it hits one
 * of the members. The check therefore decomposes exactly, list by list and unit by unit:
 *  - cross[u2]: the highest candidate index of u2 the list is clean against (feasibility is
 *    monotone: more deposited material never removes a hit, so this one number per (list, u2)
 *    captures every height of u2);
 *  - self: clean against base U own layers up to the band's lower bound (for bands above the
 *    first of a step that is more own material than the composed store has, i.e. conservative,
 *    and closer to what the emitted file deposits).
 * This needs one incrementally painted store per unit instead of one store per state.
 */
export function buildPlanModel(extracted, options = {}, clustering = null) {
  const { profile, segmentsByLine, baseMoves } = extracted;
  const storeOpts = { grid: options.grid, margin: options.margin };
  const zMax = profile.bed.z_max ?? 220;
  const { units, clusters, deps } = clustering || clusterUnits(extracted, profile, options);
  const supportHeights = units.map(() => new Set());
  deps.forEach((list) => { for (const d of list) supportHeights[d.unit].add(d.zBelow); });

  const cands = computeCandidateHeights(units, profile, {
    maxCandidates: options.maxCandidates,
    ladderDivisor: options.ladderDivisor,
    splitHeights: extracted.splitHeights,
    extraMandatory: supportHeights.map((set) => [...set]),
  });

  let plateTop = 0;
  for (const m of baseMoves) if (m.extruding) plateTop = Math.max(plateTop, m.z0, m.z1);
  for (const u of units) plateTop = Math.max(plateTop, u.top);
  const highZ = Math.min(zMax, plateTop + 1.0);

  const N = units.length;
  const colourIds = new Map();
  const colourId = (c) => {
    if (!colourIds.has(c)) colourIds.set(c, colourIds.size);
    return colourIds.get(c);
  };

  for (let oi = 0; oi < N; oi++) {
    const o = units[oi];
    o.baseZ = 0;
    for (const parentName of o.parents) {
      for (const sl of extracted.objectLayerSlices.get(parentName) || []) {
        if (sl.z < o.slices[0].z - EPS && sl.z > o.baseZ) o.baseZ = sl.z;
      }
    }
    o.heights = [0, ...cands[oi]];
    o.K = cands[oi].length;
    o.bands = [null];
    for (let k = 1; k <= o.K; k++) {
      const lo = o.heights[k - 1];
      const hi = o.heights[k];
      const slices = o.slices.filter((s) => s.z > lo + EPS && s.z <= hi + EPS);
      const chunk = buildBandChunk(o.name, slices, segmentsByLine, highZ);
      const firstSlice = slices[0];
      const firstCmd = sliceFirstMotion(firstSlice);
      const colourSeq = [];
      for (const s of slices) {
        const c = colourId(s.colour);
        if (colourSeq[colourSeq.length - 1] !== c) colourSeq.push(c);
      }
      const band = {
        k, lo, hi, slices, chunk, colourSeq,
        sig: o.sigAt.get(firstSlice.z),
        firstColourId: colourSeq[0],
        lastColourId: colourSeq[colourSeq.length - 1],
        start: chunk.startPoint,
        end: chunk.endPoint,
        lists: {},
      };
      band.lists.D = { moves: [descentMove(chunk.startPoint, highZ, { ...firstCmd, object: firstSlice.object })] };
      band.lists.B = { moves: chunk.moves };
      if (k > 1) {
        const prev = o.bands[k - 1];
        const [x, y, z] = prev.end;
        band.lists.G = {
          moves: sliceTransitionMoves({ x, y, z }, prev.chunk.lastColour, firstSlice, firstCmd, highZ),
          switches: prev.lastColourId !== band.firstColourId ? 1 : 0,
        };
      }
      // Support: the height each other unit must have reached first (an index is derived
      // below, once every unit's candidate heights exist).
      band.needZ = new Float64Array(N);
      for (const d of deps[oi]) {
        if (d.z <= lo + EPS || d.z > hi + EPS) continue;
        band.needZ[d.unit] = Math.max(band.needZ[d.unit], d.zBelow);
      }
      for (const list of Object.values(band.lists)) {
        list.cross = new Int32Array(N).fill(0);
        list.crossHit = new Array(N).fill(null);
        list.selfOk = true;
        list.selfHit = null;
      }
      o.bands.push(band);
    }
  }

  // Cross tables: one incrementally painted store per other unit.
  let checks = 0;
  for (let o2i = 0; o2i < N; o2i++) {
    const o2 = units[o2i];
    const full = new DepositStore(profile, storeOpts);
    for (let h = 1; h <= o2.K; h++) full.paint(o2.bands[h].lists.B.moves);
    const pending = [];
    for (let oi = 0; oi < N; oi++) {
      if (oi === o2i) continue;
      for (let k = 1; k <= units[oi].K; k++) {
        for (const list of Object.values(units[oi].bands[k].lists)) {
          if (list.moves.length === 0) { list.cross[o2i] = o2.K; continue; }
          checks++;
          if (clean(profile, full, list.moves).length === 0) list.cross[o2i] = o2.K;
          else pending.push(list);
        }
      }
    }
    if (pending.length === 0) continue;
    const store = new DepositStore(profile, storeOpts);
    let open = pending;
    for (let h = 1; h <= o2.K && open.length > 0; h++) {
      store.paint(o2.bands[h].lists.B.moves);
      const still = [];
      for (const list of open) {
        checks++;
        const hits = clean(profile, store, list.moves);
        if (hits.length > 0) {
          list.cross[o2i] = h - 1;
          list.crossHit[o2i] = hits[0];
        } else {
          still.push(list);
        }
      }
      open = still;
    }
  }

  // Self tables: base (skirt/brim) plus the unit's own lower bands.
  for (const o of units) {
    const store = new DepositStore(profile, storeOpts);
    store.paint(baseMoves);
    for (let k = 1; k <= o.K; k++) {
      for (const list of Object.values(o.bands[k].lists)) {
        if (list.moves.length === 0) continue;
        checks++;
        const hits = clean(profile, store, list.moves);
        if (hits.length > 0) { list.selfOk = false; list.selfHit = hits[0]; }
      }
      store.paint(o.bands[k].lists.B.moves);
    }
  }

  // Step tables: step (i -> j) is feasible iff selfOk and H[u2] <= thr[u2] for all u2;
  // `internal` counts the colour changes the step makes between its own slices.
  const indexAtLeast = (u, z) => {
    if (z <= 0) return 0;
    const idx = u.heights.findIndex((h) => h >= z - EPS);
    return idx === -1 ? u.K + 1 : idx;
  };
  for (const o of units) {
    for (let k = 1; k <= o.K; k++) {
      const band = o.bands[k];
      band.need = new Int32Array(N);
      for (let t = 0; t < N; t++) band.need[t] = indexAtLeast(units[t], band.needZ[t]);
    }
  }
  for (const o of units) {
    o.steps = [];
    for (let i = 0; i < o.K; i++) {
      const row = [];
      const thr = new Int32Array(N).fill(0x7fffffff);
      const need = new Int32Array(N).fill(0);
      let selfOk = true;
      let internal = 0;
      for (let j = i + 1; j <= o.K; j++) {
        const band = o.bands[j];
        const lists = j === i + 1 ? [band.lists.D, band.lists.B] : [band.lists.G, band.lists.B];
        internal += band.chunk.internalChanges + (j > i + 1 ? band.lists.G.switches : 0);
        for (let t = 0; t < N; t++) if (band.need[t] > need[t]) need[t] = band.need[t];
        for (const list of lists) {
          selfOk = selfOk && list.selfOk;
          for (let o2 = 0; o2 < N; o2++) if (list.cross[o2] < thr[o2]) thr[o2] = list.cross[o2];
        }
        row[j] = { selfOk, thr: Int32Array.from(thr), need: Int32Array.from(need), internal };
      }
      o.steps.push(row);
    }
  }

  // Admissible bound on remaining filament changes, per unit and height index: the set of
  // colours still to print, and the run sequence of colours still to print.
  const nColours = colourIds.size;
  for (const o of units) {
    o.remMask = [];
    o.runs = [];
    o.firstRun = [];
    for (let i = 0; i <= o.K; i++) {
      let mask = 0;
      let runs = 0;
      let last = -1;
      let first = -1;
      for (let k = i + 1; k <= o.K; k++) {
        for (const c of o.bands[k].colourSeq) {
          if (c < 30) mask |= (1 << c);
          if (c !== last) { runs++; last = c; if (first === -1) first = c; }
        }
      }
      o.remMask.push(mask);
      o.runs.push(runs);
      o.firstRun.push(first);
    }
  }

  // What is loaded when printing starts (null: nothing known, the first colour is free).
  const initialLoaded = extracted.initialColour === null || extracted.initialColour === undefined
    ? -1 : colourId(extracted.initialColour);
  return {
    profile, objects: units, clusters, deps, highZ, checks, initialLoaded,
    costOptions: { initialColour: extracted.initialColour ?? null, changeCostS: extracted.changeCostS ?? null },
    colours: [...colourIds.keys()],
    colourMaskExact: nColours <= 30,
  };
}

/**
 * Is step (u: i -> j) feasible with the other units at height indices H? Every other unit must
 * stand no higher than the checker allows (thr) and at least as high as the step's layers rest
 * on (need); both are monotone in j.
 */
export function isStepFeasible(model, H, oi, i, j) {
  const info = model.objects[oi].steps[i]?.[j];
  if (!info || !info.selfOk) return false;
  for (let o2 = 0; o2 < H.length; o2++) {
    if (o2 !== oi && (H[o2] > info.thr[o2] || H[o2] < info.need[o2])) return false;
  }
  return true;
}

function popcount(x) {
  let c = 0;
  while (x) { x &= x - 1; c++; }
  return c;
}

function heuristicChanges(model, H, loaded) {
  const { objects } = model;
  let mask = 0;
  let best = 0;
  for (let oi = 0; oi < objects.length; oi++) {
    const o = objects[oi];
    const i = H[oi];
    mask |= o.remMask[i];
    const runs = o.runs[i];
    if (runs > 0) {
      const need = runs - 1 + (loaded !== -1 && o.firstRun[i] !== loaded ? 1 : 0);
      if (need > best) best = need;
    }
  }
  if (model.colourMaskExact && mask) {
    const loadedLeft = loaded !== -1 && loaded < 30 && (mask & (1 << loaded)) !== 0;
    const need = popcount(mask) - (loaded === -1 || loadedLeft ? 1 : 0);
    if (need > best) best = need;
  }
  return best;
}

// Binary min-heap keyed on node.f.
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= x.f) break;
      a[i] = a[p]; i = p;
    }
    a[i] = x;
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      let i = 0;
      const n = a.length;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && a[r].f < a[l].f ? r : l;
        if (a[c].f >= last.f) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

function successors(model, node, sequentialOnly) {
  const { objects } = model;
  const H = node.H;
  const out = [];
  let partial = -1;
  if (sequentialOnly) {
    for (let oi = 0; oi < objects.length; oi++) {
      if (H[oi] > 0 && H[oi] < objects[oi].K) partial = oi;
    }
  }
  for (let oi = 0; oi < objects.length; oi++) {
    const o = objects[oi];
    const i = H[oi];
    if (i >= o.K) continue;
    if (partial !== -1 && partial !== oi) continue;
    const first = o.bands[i + 1];
    const entryChange = node.loaded !== -1 && first.firstColourId !== node.loaded ? 1 : 0;
    const travel = node.end ? Math.hypot(first.start[0] - node.end[0], first.start[1] - node.end[1]) : 0;
    for (let j = i + 1; j <= o.K; j++) {
      if (o.bands[j].sig !== first.sig) break;
      // Feasibility is monotone in j (a longer step only adds moves), so stop at the first miss.
      if (!isStepFeasible(model, H, oi, i, j)) break;
      const changes = entryChange + o.steps[i][j].internal;
      const H2 = H.slice();
      H2[oi] = j;
      out.push({
        H: H2, loaded: o.bands[j].lastColourId, end: o.bands[j].end,
        step: { o: oi, i, j },
        dg: changes * CHANGE_WEIGHT + travel + STEP_TIEBREAK,
        changes, travel,
      });
    }
  }
  return out;
}

const keyOf = (H, loaded) => H.join(',') + '|' + loaded;

function isGoal(model, H) {
  for (let oi = 0; oi < H.length; oi++) if (H[oi] !== model.objects[oi].K) return false;
  return true;
}

function reconstruct(node) {
  const steps = [];
  for (let n = node; n && n.step; n = n.parent) steps.push(n.step);
  return steps.reverse();
}

function makeNode(parent, succ, model) {
  const g = parent.g + succ.dg;
  const h = heuristicChanges(model, succ.H, succ.loaded) * CHANGE_WEIGHT;
  return {
    H: succ.H, loaded: succ.loaded, end: succ.end, step: succ.step, parent,
    g, f: g + h, changes: parent.changes + succ.changes, travel: parent.travel + succ.travel,
  };
}

function startNode(model) {
  const H = new Array(model.objects.length).fill(0);
  const loaded = model.initialLoaded ?? -1;
  const h = heuristicChanges(model, H, loaded) * CHANGE_WEIGHT;
  return { H, loaded, end: null, step: null, parent: null, g: 0, f: h, changes: 0, travel: 0 };
}

function astar(model, { maxStates, sequentialOnly }) {
  const heap = new Heap();
  const bestG = new Map();
  const s = startNode(model);
  heap.push(s);
  bestG.set(keyOf(s.H, s.loaded), 0);
  let expanded = 0;
  while (heap.size > 0) {
    const node = heap.pop();
    const key = keyOf(node.H, node.loaded);
    if (node.g > bestG.get(key) + 1e-9) continue;
    if (isGoal(model, node.H)) return { node, expanded, complete: true };
    if (++expanded > maxStates) return { node: null, expanded, complete: false };
    for (const succ of successors(model, node, sequentialOnly)) {
      const child = makeNode(node, succ, model);
      const k = keyOf(child.H, child.loaded);
      const prev = bestG.get(k);
      if (prev === undefined || child.g < prev - 1e-9) {
        bestG.set(k, child.g);
        heap.push(child);
      }
    }
  }
  return { node: null, expanded, complete: true };
}

function beamSearch(model, { beam, sequentialOnly }) {
  let frontier = [startNode(model)];
  let best = null;
  let expanded = 0;
  while (frontier.length > 0) {
    const next = new Map();
    for (const node of frontier) {
      expanded++;
      for (const succ of successors(model, node, sequentialOnly)) {
        const child = makeNode(node, succ, model);
        if (isGoal(model, child.H)) {
          if (!best || child.g < best.g) best = child;
          continue;
        }
        if (best && child.f >= best.g) continue;
        const k = keyOf(child.H, child.loaded);
        const prev = next.get(k);
        if (!prev || child.g < prev.g) next.set(k, child);
      }
    }
    frontier = [...next.values()].sort((a, b) => a.f - b.f).slice(0, beam);
  }
  return { node: best, expanded };
}

// Depth-first search for any feasible plan (greedy order, visited set), within a node limit;
// used when the beam lost every feasible branch.
function dfsAny(model, { limit, sequentialOnly }) {
  const visited = new Set();
  const stack = [startNode(model)];
  let expanded = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    const key = keyOf(node.H, node.loaded);
    if (visited.has(key)) continue;
    visited.add(key);
    if (isGoal(model, node.H)) return { node, expanded };
    if (++expanded > limit) break;
    const kids = successors(model, node, sequentialOnly).map((s) => makeNode(node, s, model));
    kids.sort((a, b) => b.f - a.f); // best last, so it is popped first
    for (const k of kids) stack.push(k);
  }
  return { node: null, expanded };
}

/**
 * Search the schedule graph. State = per-unit candidate height index + loaded colour; a
 * transition is one feasible step; cost = CHANGE_WEIGHT per filament change (on entry and
 * inside the step) + XY glue travel (from the path's previous step end, so travel is exact
 * along each path but the state does not remember it; changes, the primary objective, are
 * exact). A* with an admissible bound on remaining changes runs while it stays under maxStates
 * expansions; otherwise a beam search, then a depth-first search for any feasible plan, which
 * gives up at its node budget.
 */
export function searchPlan(model, options = {}) {
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const beam = options.beam ?? DEFAULT_BEAM;
  const sequentialOnly = options.sequentialOnly === true;
  let explored = 0;
  let method = 'astar';
  let res = astar(model, { maxStates, sequentialOnly });
  explored += res.expanded;
  const optimal = res.complete && res.node !== null;
  if (!res.complete) {
    method = 'beam';
    res = beamSearch(model, { beam, sequentialOnly });
    explored += res.expanded;
    if (!res.node) {
      method = 'dfs';
      // Its own budget: a small --max-states caps the optimising search, not this one.
      const limit = options.dfsLimit ?? Math.max(maxStates, DEFAULT_MAX_STATES) * 4;
      res = dfsAny(model, { limit, sequentialOnly });
      explored += res.expanded;
    }
  }
  if (!res.node) return { feasible: false, method, statesExplored: explored, optimal: false };
  return {
    feasible: true,
    method,
    optimal,
    statesExplored: explored,
    steps: mergeSteps(model, reconstruct(res.node)),
  };
}

/**
 * Join back-to-back steps of one unit with the same colour signature when the joined step is
 * feasible in the same state (the heuristic searches can leave such splits; joining never adds
 * a change and removes a lift, a descent and their travel).
 */
export function mergeSteps(model, steps) {
  const out = [];
  const H = new Array(model.objects.length).fill(0);
  const before = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    const bands = model.objects[s.o].bands;
    if (prev && prev.o === s.o && prev.j === s.i && bands[prev.i + 1].sig === bands[s.i + 1].sig &&
        isStepFeasible(model, before[before.length - 1], s.o, prev.i, s.j)) {
      out[out.length - 1] = { o: s.o, i: prev.i, j: s.j };
    } else {
      before.push(H.slice());
      out.push({ ...s });
    }
    H[s.o] = s.j;
  }
  return out;
}

/** Turn a plan's (u, i, j) steps into emitter chunks, reusing the bands' move lists. */
export function planChunks(model, steps) {
  const counts = new Map();
  for (const s of steps) counts.set(s.o, (counts.get(s.o) || 0) + 1);
  return steps.map((s, index) => {
    const o = model.objects[s.o];
    const first = o.bands[s.i + 1];
    const last = o.bands[s.j];
    const slices = [];
    const moves = [];
    let moveCount = 0;
    let extrusionLength = 0;
    for (let k = s.i + 1; k <= s.j; k++) {
      const band = o.bands[k];
      if (k > s.i + 1) moves.push(...band.lists.G.moves);
      moves.push(...band.chunk.moves);
      slices.push(...band.slices);
      moveCount += band.chunk.moveCount;
      extrusionLength += band.chunk.extrusionLength;
    }
    // The unit's previous layer top (where the last step stopped), or for its first step the
    // top of the parent object's layer it starts on (0 on the bed): a colour region on top of
    // its body starts there. Never from ;HEIGHT comments, which a file may lack.
    const zLo = s.i > 0 ? o.heights[s.i] : o.baseZ;
    const zHi = o.heights[s.j];
    return {
      index,
      id: counts.get(s.o) === 1 ? o.name : `${o.name} [Z${r3(zLo)}-${r3(zHi)}]`,
      object: o.name,
      members: o.members,
      parents: o.parents,
      zLo: r3(zLo),
      zHi: r3(zHi),
      top: last.chunk.top,
      colour: first.chunk.colour,
      lastColour: last.chunk.lastColour,
      internalChanges: o.steps[s.i][s.j].internal,
      startPoint: first.start,
      endPoint: last.end,
      moveCount,
      extrusionLength: +extrusionLength.toFixed(5),
      slices,
      moves,
    };
  });
}

/** The one step record both planners report. */
function stepRecord(c) {
  const rec = {
    id: c.id,
    object: c.object,
    z_lo: c.zLo,
    z_hi: c.zHi ?? c.top,
    colour: c.colour,
    layers: new Set(c.slices.map((s) => s.z)).size,
    moves: c.moveCount,
    extrusion_mm: c.extrusionLength,
  };
  if (c.members && c.members.length > 1) rec.members = c.members;
  if (c.parents && c.parents.length === 1 && c.parents[0] !== c.object) rec.parent = c.parents[0];
  if (c.internalChanges) {
    rec.end_colour = c.lastColour;
    rec.colour_changes_within = c.internalChanges;
  }
  return rec;
}

function planCostSummary(model, plan) {
  const chunks = planChunks(model, plan.steps);
  const cost = evaluateOrderCost(chunks, chunks.map((_, i) => i), model.profile, model.costOptions);
  return {
    chunks,
    cost,
    estimatedTimeS: +(movesPrintTime(chunks.flatMap((c) => c.moves)) + cost.totalAddedTimeS).toFixed(1),
  };
}

/** Pairwise conflict summary for an infeasible plate (what blocks what, and from which height). */
function conflictDiagnostics(model) {
  const out = [];
  const { objects, profile } = model;
  for (let oi = 0; oi < objects.length; oi++) {
    const o = objects[oi];
    for (let o2 = 0; o2 < objects.length; o2++) {
      if (o2 === oi) continue;
      let worst = null;
      for (let k = 1; k <= o.K; k++) {
        for (const list of Object.values(o.bands[k].lists)) {
          if (list.cross[o2] < objects[o2].K && (!worst || list.cross[o2] < worst.thr)) {
            worst = { k, thr: list.cross[o2], hit: list.crossHit[o2] };
          }
        }
      }
      if (!worst) continue;
      const band = o.bands[worst.k];
      const blockerH = r3(objects[o2].heights[worst.thr]);
      out.push({
        object: o.name,
        band: [r3(band.lo), r3(band.hi)],
        blocked_by: objects[o2].name,
        blocker_max_height_mm: blockerH,
        part: worst.hit?.part || 'unknown',
        penetration_mm: worst.hit?.penetration_mm || 0,
        suggestion: `'${o.name}' cannot print Z ${r3(band.lo)}-${r3(band.hi)} once '${objects[o2].name}' is above ${blockerH} mm (${worst.hit?.part || 'head'}); move the objects apart or add --split-at heights (clearance ${wideClearanceHeights(profile).join(', ')} mm).`,
      });
    }
  }
  return out;
}

/**
 * Plan, emit and verify. Attempts the default candidate set first, then a finer one (twice
 * the cap, half-clearance ladder) if the search finds nothing or the emitted file does not
 * verify. Returns the accepted plan, or why none was accepted.
 */
export function planToolpath(extracted, options = {}) {
  const { profile } = extracted;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const variants = [
    { name: 'default', maxCandidates, ladderDivisor: 1 },
    { name: 'finer', maxCandidates: maxCandidates * 2, ladderDivisor: 2 },
  ];
  const clustering = clusterUnits(extracted, profile, options);
  const attempts = [];
  let firstModel = null;
  let accepted = null;

  for (const variant of variants) {
    const model = buildPlanModel(extracted, { ...options, ...variant }, clustering);
    if (!firstModel) firstModel = model;
    if (model.objects.length === 0) {
      attempts.push({ candidates: variant.name, outcome: 'no printable object layers in the input' });
      break;
    }
    const plan = searchPlan(model, options);
    const attempt = {
      candidates: variant.name,
      method: plan.method,
      states_explored: plan.statesExplored,
      checks: model.checks,
    };
    attempts.push(attempt);
    if (!plan.feasible) {
      attempt.outcome = 'no feasible plan over the candidate heights';
      continue;
    }
    const { chunks, cost, estimatedTimeS } = planCostSummary(model, plan);
    const gcode = emitResequencedGcode({ ...extracted, chunks }, chunks.map((_, i) => i));
    const verification = checkToolpath(gcode, profile, { ...options, isText: true });
    if (verification.collides) {
      const ev = verification.events[0];
      attempt.outcome = `emitted plan failed verification: ${ev.part} hits '${ev.hit_object}' at line ${ev.line} (z ${ev.z}, ${ev.penetration_mm} mm) while printing '${ev.printing_object}'`;
      continue;
    }
    attempt.outcome = 'accepted';
    accepted = { model, plan, chunks, cost, estimatedTimeS, gcode, verification };
    break;
  }

  const model = accepted ? accepted.model : firstModel;
  const candidates = model.objects.map((o) => ({ object: o.name, heights: o.heights.slice(1).map(r3) }));
  const clusters = clustering.clusters;

  if (!accepted) {
    return {
      feasible: false,
      reason: attempts.map((a) => `${a.candidates} candidates: ${a.outcome}`).join('; '),
      attempts,
      candidates,
      clusters,
      diagnostics: conflictDiagnostics(firstModel),
    };
  }

  // Baseline: whole units one after another. Judged by the tables only, never emitted or
  // verified, so it is reported as unverified.
  const seqPlan = searchPlan(model, { ...options, sequentialOnly: true });
  let sequential = { feasible: false, verified: false };
  if (seqPlan.feasible) {
    const s = planCostSummary(model, seqPlan);
    sequential = {
      feasible: true,
      verified: false,
      filament_changes: s.cost.filamentChanges,
      travel_distance_mm: s.cost.travelDistMm,
      estimated_time_s: s.estimatedTimeS,
      order: s.chunks.map((c) => c.id),
    };
  }
  return {
    feasible: true,
    attempts,
    candidates,
    clusters,
    sequential,
    method: accepted.plan.method,
    optimal: accepted.plan.optimal,
    statesExplored: accepted.plan.statesExplored,
    model: accepted.model,
    chunks: accepted.chunks,
    filamentChanges: accepted.cost.filamentChanges,
    travelDistMm: accepted.cost.travelDistMm,
    estimatedTimeS: accepted.estimatedTimeS,
    gcode: accepted.gcode,
    verification: accepted.verification,
  };
}

/** The fixed-split solver over chunks cut at --split-at heights and colour boundaries. */
function sequenceFixed(extracted, options, { fallback = false } = {}) {
  let withChunks;
  try {
    withChunks = extracted.chunks ? extracted : { ...extracted, chunks: buildFixedChunks(extracted) };
  } catch (err) {
    // As a fallback, an input this solver cannot cut (colour regions) is just "no plan".
    if (fallback && err instanceof InputError) return { feasible: false, reason: err.message, diagnostics: [], internals: { extracted } };
    throw err;
  }
  const matrixInfo = buildPairwiseMatrix(withChunks, options);
  const solved = solveChunkOrder(withChunks, matrixInfo, options);
  if (!solved.feasible) {
    return { feasible: false, reason: solved.reason, diagnostics: solved.diagnostics, internals: { extracted: withChunks, matrixInfo } };
  }
  return {
    feasible: true,
    verified: !solved.verification.collides,
    chunks: solved.order.map((idx) => withChunks.chunks[idx]),
    filamentChanges: solved.filamentChanges,
    travelDistMm: solved.travelDistMm,
    estimatedTimeS: solved.estimatedTimeS,
    gcode: solved.gcode,
    verification: solved.verification,
    internals: { extracted: withChunks, matrixInfo },
  };
}

// Where a pass-through result's G-code comes from: the caller's text (when the input was text,
// decided like loadToolpath: options.isText, else a string containing a newline), or the input
// file, which the caller copies byte for byte (never read back here).
function inputSource(input, options) {
  if (typeof input !== 'string') return { text: null, path: null };
  const isText = options.isText ?? input.includes('\n');
  return isText ? { text: input, path: null } : { text: null, path: input };
}

/**
 * Entry point for Phase 2 sequencing. Accepts sequenceToolpath(toolpathOrFile, options) or
 * sequenceToolpath(toolpathOrFile, profileInput, options).
 *
 * options.planner: 'adaptive' (default) runs the step planner; 'fixed' runs the earlier solver
 * over chunks cut at the --split-at heights and colour boundaries (also the adaptive planner's
 * last fallback). With either planner the file's own order is a candidate too: unless a plan
 * needs fewer filament changes (or the file collides), the result is a pass-through of the
 * input (pass_through: true, planner.name 'file-order'; gcode is the input text when the input
 * was text, else null with source_path set, and the caller copies the file). A file without
 * colour changes is only checked, not planned, unless it collides.
 * options.internals: true attaches the extracted slices and the planning model as
 * result.internals (large: band move lists and tables; for tests and debugging).
 */
export function sequenceToolpath(toolpathOrFile, profileOrOptions = {}, maybeOptions = null) {
  let options;
  if (
    maybeOptions !== null ||
    typeof profileOrOptions === 'string' ||
    (profileOrOptions && typeof profileOrOptions === 'object' && Array.isArray(profileOrOptions.parts))
  ) {
    options = { ...(maybeOptions || {}), profile: profileOrOptions };
  } else {
    options = { ...(profileOrOptions || {}) };
  }
  const profile = loadProfile(options.profile || options.printer || 'mk4');
  const extracted = extractSlices(toolpathOrFile, { ...options, profile });

  const warnings = [];
  if (unmeasuredWarning(profile)) warnings.push(unmeasuredWarning(profile));
  // Warnings about what an emitted plan leaves out; not needed when the file passes through.
  const emitWarnings = () => {
    const out = [];
    const dropped = extracted.droppedNonObject;
    if (dropped.moves > 0) {
      out.push(
        `${dropped.moves} extruding move(s) outside any object label (${dropped.types.join(', ')}; up to Z=${dropped.maxZ.toFixed(2)} mm, ${dropped.extrusion_mm} mm filament) are not emitted: only first-layer skirt/brim is kept. The verification covers the emitted file only.`
      );
    }
    if (extracted.colourChangeBy === 'T') {
      out.push(
        'The file changes colour with tool changes (T<n>, MMU) rather than M600: the plan emits T<n> at its colour changes, but purging is not regenerated (the wipe tower is dropped), so the output is for analysis only.'
      );
    }
    return out;
  };
  const changeCost = { change_cost_s: extracted.changeCostS, source: extracted.changeCostSource };

  const finish = (fields, internals) => {
    const res = { printer: profile.name, warnings, ...fields };
    if (options.internals) res.internals = internals;
    return res;
  };
  const accept = (best) => {
    const steps = best.solved.chunks.map(stepRecord);
    warnings.push(...emitWarnings());
    return finish({
      feasible: true,
      verified: best.solved.verified ?? !best.solved.verification.collides,
      pass_through: false,
      order: steps.map((s) => s.id),
      filament_changes: best.solved.filamentChanges,
      travel_distance_mm: best.solved.travelDistMm,
      estimated_time_s: best.solved.estimatedTimeS,
      change_cost: changeCost,
      steps,
      clusters: best.clusters,
      planner: best.planner,
      comparison: best.comparison,
      gcode: best.solved.gcode,
      verification: best.solved.verification,
    }, { ...best.internals, chunks: best.solved.chunks });
  };

  // The file's own order: its change count and estimate, and (lazily) its checker verdict.
  const changeCostS = extracted.changeCostS ?? profile.change_cost_s ?? 120;
  const fileTime = () => {
    let t = 0;
    for (const list of extracted.objectLayerSlices.values()) {
      for (const sl of list) t += movesPrintTime(sliceMoves(sl, extracted.segmentsByLine));
    }
    return +(t + extracted.originalColourChanges * changeCostS).toFixed(1);
  };
  let original = null;
  const originalInfo = () => (original ??= { filament_changes: extracted.originalColourChanges, estimated_time_s: fileTime() });
  let fileCheck = null;
  const checkFile = () => (fileCheck ??= checkToolpath(extracted.toolpath, profile, options));

  // Keep the file unless a plan needs fewer changes or the file itself collides.
  const passThrough = (reason, considered) => {
    const src = inputSource(toolpathOrFile, options);
    return finish({
      feasible: true,
      verified: !checkFile().collides,
      pass_through: true,
      order: [],
      filament_changes: originalInfo().filament_changes,
      travel_distance_mm: null, // not estimated for the file's own order
      estimated_time_s: originalInfo().estimated_time_s,
      change_cost: changeCost,
      steps: [],
      clusters: [],
      planner: { name: 'file-order', reason, ...(considered ? { considered } : {}) },
      comparison: { original_file: originalInfo() },
      gcode: src.text,
      source_path: src.path,
      verification: checkFile(),
    }, { extracted, ...(considered?.internals || {}) });
  };
  const decide = (best, failure) => {
    if (best && best.solved.filamentChanges < originalInfo().filament_changes) {
      if (best.note) warnings.push(best.note);
      return accept(best);
    }
    if (checkFile().collides) {
      if (best) {
        warnings.push(`The file's own order collides (line ${checkFile().events[0].line}); using the plan although it needs ${best.solved.filamentChanges} change(s) vs ${originalInfo().filament_changes}.`);
        if (best.note) warnings.push(best.note);
        return accept(best);
      }
      return finish({
        feasible: false,
        reason: `${failure.reason}; the file's own order collides too`,
        diagnostics: failure.diagnostics,
        planner: failure.planner,
        comparison: { original_file: originalInfo() },
      }, { extracted });
    }
    const considered = best
      ? {
          planner: best.planner,
          clusters: best.clusters,
          filament_changes: best.solved.filamentChanges,
          travel_distance_mm: best.solved.travelDistMm,
          estimated_time_s: best.solved.estimatedTimeS,
          internals: { model: best.internals.model, chunks: best.solved.chunks },
        }
      : { planner: failure.planner, reason: failure.reason, diagnostics: failure.diagnostics };
    const reason = best
      ? `the best plan (${best.planner.name}) needs ${best.solved.filamentChanges} filament change(s), the file's own order ${originalInfo().filament_changes}`
      : `no plan found (${failure.reason}); the file's own order is collision-free`;
    const res = passThrough(reason, considered);
    if (res.planner.considered) delete res.planner.considered.internals;
    return res;
  };

  // Nothing to improve: a file without colour changes is only checked.
  if (extracted.originalColourChanges === 0 && !checkFile().collides) {
    return passThrough('the file has no colour changes and is collision-free; nothing to plan', null);
  }

  if (options.planner === 'fixed') {
    const fixed = sequenceFixed(extracted, options);
    if (!fixed.feasible) return decide(null, { reason: fixed.reason, diagnostics: fixed.diagnostics, planner: { name: 'fixed' } });
    return decide({ solved: fixed, planner: { name: 'fixed' }, comparison: { original_file: originalInfo() }, clusters: [], internals: fixed.internals }, null);
  }

  const planned = planToolpath(extracted, options);
  const adaptive = { name: 'adaptive', candidates: planned.candidates, attempts: planned.attempts };
  if (planned.feasible) {
    return decide({
      solved: planned,
      planner: {
        ...adaptive,
        method: planned.method,
        // A* finished: fewest filament changes over the candidate heights (travel is a
        // tie-break that is exact along each path but not across paths merged into one state).
        changes_optimal: planned.optimal,
        states_explored: planned.statesExplored,
      },
      comparison: {
        original_file: originalInfo(),
        sequential_objects: planned.sequential,
        plan: { filament_changes: planned.filamentChanges, travel_distance_mm: planned.travelDistMm, estimated_time_s: planned.estimatedTimeS },
      },
      clusters: planned.clusters,
      internals: { extracted, model: planned.model },
    }, null);
  }
  // The fixed-split solver works on a different decomposition and verifies what it emits.
  const fixed = sequenceFixed(extracted, options, { fallback: true });
  if (fixed.feasible) {
    return decide({
      solved: fixed,
      planner: { name: 'fixed', fallback_from: adaptive },
      comparison: { original_file: originalInfo() },
      clusters: [],
      internals: fixed.internals,
      note: `Adaptive planner found no verified plan (${planned.reason}); using the fixed-split solver.`,
    }, null);
  }
  return decide(null, {
    reason: `adaptive planner: ${planned.reason}; fixed-split solver: ${fixed.reason}`,
    diagnostics: planned.diagnostics.length > 0 ? planned.diagnostics : fixed.diagnostics,
    planner: adaptive,
  });
}

/**
 * Test hook: the store the step would really be checked against (base, own layers up to zLo,
 * every other unit at its height in H, composed with DepositStore.clone/paint) and the step's
 * full check moves (descent, layers and glue, lift). Lets tests confirm that the decomposed
 * tables predict exactly what checkMoves says on the composed store.
 */
export function composeStepCheck(model, extracted, H, oi, i, j, options = {}) {
  const { profile, objects, highZ } = model;
  const base = new DepositStore(profile, { grid: options.grid, margin: options.margin });
  base.paint(extracted.baseMoves);
  const store = base.clone();
  for (let o2 = 0; o2 < objects.length; o2++) {
    const upto = o2 === oi ? i : H[o2];
    for (let k = 1; k <= upto; k++) store.paint(objects[o2].bands[k].lists.B.moves);
  }
  const o = objects[oi];
  const moves = [...o.bands[i + 1].lists.D.moves];
  for (let k = i + 1; k <= j; k++) {
    if (k > i + 1) moves.push(...o.bands[k].lists.G.moves);
    moves.push(...o.bands[k].lists.B.moves);
  }
  const lastSlice = o.bands[j].slices.at(-1);
  moves.push(liftMove(o.bands[j].end, highZ, { layer: lastSlice.layer, object: lastSlice.object }));
  return { store, moves, hits: checkMoves(profile, store, moves, { stopOnFirst: true }) };
}
