// lib/plan.mjs: adaptive multicolour print planner. Each object is a stack of layer slices; a
// plan is an ordered list of steps (object, zLo -> zHi, colour). Step feasibility comes from the
// phase-1 checker (checkMoves against DepositStores), the search is A* over per-object heights
// with a beam / depth-first fallback, and the emitted G-code is accepted only if checkToolpath
// verifies it clean.
import { DepositStore, checkMoves, checkToolpath } from './collide.mjs';
import {
  buildBandChunk,
  layerGlueMoves,
  emitResequencedGcode,
  evaluateOrderCost,
} from './sequence.mjs';

const EPS = 1e-5;
const DEFAULT_TRAVEL_FEEDRATE = 7800; // mm/min, same convention as evaluateOrderCost
const CHANGE_WEIGHT = 1e6;            // lexicographic: one filament change outweighs any travel
const STEP_TIEBREAK = 1e-3;           // among equal plans prefer fewer steps (fewer lifts/descents)
export const DEFAULT_MAX_CANDIDATES = 12;
export const DEFAULT_MAX_STATES = 200000;
export const DEFAULT_BEAM = 2000;

const r3 = (z) => +Number(z).toFixed(3);

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

/**
 * Candidate heights at which an object may pause so another object can be printed.
 *
 * Why these heights: on a bed slinger the parts that reach over neighbouring material are the
 * extruder body and the X gantry, and both start C = profile.clearance_height (the lowest
 * non-nozzle part z_lo, 20 mm on the MK4) above the nozzle tip. A neighbour standing at height
 * h' therefore blocks printing (and descending onto) this object exactly while the nozzle is
 * below h' - C. So the heights where feasibility can change are:
 *  - mandatory: the object's top, every colour boundary (a step never crosses one), and the
 *    user's --split-at heights;
 *  - for every neighbour height h' (its mandatory heights, its ladder and 0):
 *      nextLayer(h') + C  the highest this object may stand and still let the neighbour resume
 *                         from h' (the band stops exactly where the gantry conflict begins);
 *      h' - C             the lowest pause from which this object can resume next to h';
 *  - the clearance ladder k * C, which links those conditions across more than two objects.
 * Everything is snapped down to an actual layer top of the object and deduplicated. Mandatory
 * heights are always kept; the rest are capped at maxCandidates per object, preferring the
 * neighbour + C heights, then the ladder, then neighbour - C, thinned evenly when over the cap.
 */
export function computeCandidateHeights(objects, profile, options = {}) {
  const C = profile.clearance_height ?? 20;
  const maxCandidates = Math.max(1, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const ladderStep = C / Math.max(1, options.ladderDivisor ?? 1);
  const splitHeights = options.splitHeights || [];

  const mandatory = objects.map((o) => {
    const set = new Set([o.top]);
    for (let i = 1; i < o.slices.length; i++) {
      if (o.slices[i].colour !== o.slices[i - 1].colour) set.add(o.slices[i - 1].z);
    }
    for (const s of splitHeights) {
      const z = snapDown(o.tops, s);
      if (z !== null) set.add(z);
    }
    return set;
  });
  const ladder = objects.map((o) => {
    const list = [];
    for (let k = 1; k * ladderStep < o.top - EPS; k++) {
      const z = snapDown(o.tops, k * ladderStep);
      if (z !== null) list.push(z);
    }
    return list;
  });

  return objects.map((o, idx) => {
    const plus = [];
    const minus = [];
    objects.forEach((o2, idx2) => {
      if (idx2 === idx) return;
      const base = [0, ...mandatory[idx2], ...ladder[idx2]];
      for (const h2 of base) {
        const up = snapDown(o.tops, nextLayerZ(o2.tops, h2) + C);
        if (up !== null) plus.push(up);
        const down = snapDown(o.tops, h2 - C);
        if (down !== null) minus.push(down);
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

function descentMove(startPoint, highZ, slice, firstCmd, objName) {
  const [sx, sy, sz] = startPoint;
  return {
    line: firstCmd.line, kind: 'G0',
    x0: sx, y0: sy, z0: Math.max(highZ, sz),
    x1: sx, y1: sy, z1: sz,
    extruding: false, dE: 0, feedrate: 7800,
    width: 0.45, height: 0.2, layer: slice.layer, layerZ: sz, object: objName,
    type: 'Custom', tool: firstCmd.tool || 0, inStart: false, state: firstCmd.state,
    raw: `G0 Z${sz.toFixed(3)} (descent)`,
  };
}

function liftMove(endPoint, highZ, slice, objName) {
  const [ex, ey, ez] = endPoint;
  return {
    line: 1, kind: 'G0',
    x0: ex, y0: ey, z0: ez, x1: ex, y1: ey, z1: Math.max(highZ, ez),
    extruding: false, dE: 0, feedrate: 7800,
    width: 0.45, height: 0.2, layer: slice.layer, layerZ: ez, object: objName,
    type: 'Custom', tool: 0, inStart: false, raw: 'G0 (lift)',
  };
}

const clean = (profile, store, moves) => checkMoves(profile, store, moves, { stopOnFirst: true });

/**
 * Build the planning model: per object its candidate heights, elementary bands between
 * consecutive candidates, and the feasibility tables.
 *
 * Feasibility is decided by checkMoves only. A step (o, i -> j) is checked as the move list
 * [descent onto band i+1 from above the plate, band i+1, glue, band i+2, ..., band j]; the
 * descent's verdict does not depend on where it starts because every head part is lowest at
 * its end. The store it is checked against is base (skirt) U own layers U every other object
 * at its current height. DepositStore.paint keeps the per-cell maximum, and checkMoves reports
 * a hit iff some cell under a part is above that part, so a move hits the union iff it hits one
 * of the members. The check therefore decomposes exactly, list by list and object by object:
 *  - cross[o2]: the highest candidate index of o2 the list is clean against (feasibility is
 *    monotone: more deposited material never removes a hit, so this one number per (list, o2)
 *    captures every height of o2);
 *  - self: clean against base U own layers up to the band's lower bound (for bands above the
 *    first of a step that is more own material than the composed store has, i.e. conservative,
 *    and closer to what the emitted file deposits).
 * This needs one incrementally painted store per object instead of one store per state.
 */
export function buildPlanModel(extracted, options = {}) {
  const { profile, toolpath, objectLayerSlices, segmentsByLine, baseMoves } = extracted;
  const storeOpts = { grid: options.grid, margin: options.margin };
  const zMax = profile.bed.z_max ?? 220;

  const objects = [];
  toolpath.objects.forEach((obj, objIdx) => {
    const slices = [...(objectLayerSlices.get(obj.name) || [])].sort((a, b) => a.z - b.z || a.layer - b.layer);
    if (slices.length === 0) return;
    const tops = [...new Set(slices.map((s) => s.z))].sort((a, b) => a - b);
    objects.push({ obj, objIdx, name: obj.name, slices, tops, top: tops[tops.length - 1] });
  });

  const cands = computeCandidateHeights(objects, profile, {
    maxCandidates: options.maxCandidates,
    ladderDivisor: options.ladderDivisor,
    splitHeights: extracted.splitHeights,
  });

  let plateTop = 0;
  for (const m of baseMoves) if (m.extruding) plateTop = Math.max(plateTop, m.z0, m.z1);
  for (const o of objects) plateTop = Math.max(plateTop, o.top);
  const highZ = Math.min(zMax, plateTop + 1.0);

  const N = objects.length;
  const colourIds = new Map();
  const colourId = (c) => {
    if (!colourIds.has(c)) colourIds.set(c, colourIds.size);
    return colourIds.get(c);
  };

  for (let oi = 0; oi < N; oi++) {
    const o = objects[oi];
    o.heights = [0, ...cands[oi]];
    o.K = cands[oi].length;
    o.bands = [null];
    for (let k = 1; k <= o.K; k++) {
      const lo = o.heights[k - 1];
      const hi = o.heights[k];
      const slices = o.slices.filter((s) => s.z > lo + EPS && s.z <= hi + EPS);
      const colours = new Set(slices.map((s) => s.colour));
      if (slices.length === 0 || colours.size !== 1) {
        throw new Error(`internal: band (${lo}, ${hi}] of '${o.name}' is empty or not monochrome`);
      }
      const chunk = buildBandChunk(o.obj, slices, segmentsByLine);
      const firstSlice = slices[0];
      const firstCmd = firstSlice.commands.find((c) => c.kind === 'move' || c.kind === 'arc');
      const band = {
        k, lo, hi, slices, chunk,
        colour: slices[0].colour,
        colourId: colourId(slices[0].colour),
        start: chunk.startPoint,
        end: chunk.endPoint,
        lists: {},
      };
      band.lists.D = { moves: [descentMove(chunk.startPoint, highZ, firstSlice, firstCmd, o.name)] };
      band.lists.B = { moves: chunk.moves };
      if (k > 1) {
        const prev = o.bands[k - 1].end;
        band.lists.G = { moves: layerGlueMoves({ x: prev[0], y: prev[1], z: prev[2] }, firstCmd, firstSlice, o.name) };
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

  // Cross tables: one incrementally painted store per other object.
  let checks = 0;
  for (let o2i = 0; o2i < N; o2i++) {
    const o2 = objects[o2i];
    const full = new DepositStore(profile, storeOpts);
    for (let h = 1; h <= o2.K; h++) full.paint(o2.bands[h].lists.B.moves);
    const pending = [];
    for (let oi = 0; oi < N; oi++) {
      if (oi === o2i) continue;
      for (let k = 1; k <= objects[oi].K; k++) {
        for (const list of Object.values(objects[oi].bands[k].lists)) {
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

  // Self tables: base (skirt/brim) plus the object's own lower bands.
  for (const o of objects) {
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

  // Step tables: step (i -> j) is feasible iff selfOk and H[o2] <= thr[o2] for all o2.
  for (const o of objects) {
    o.steps = [];
    for (let i = 0; i < o.K; i++) {
      const row = [];
      const thr = new Int32Array(N).fill(0x7fffffff);
      let selfOk = true;
      for (let j = i + 1; j <= o.K; j++) {
        const band = o.bands[j];
        const lists = j === i + 1 ? [band.lists.D, band.lists.B] : [band.lists.G, band.lists.B];
        for (const list of lists) {
          if (!list) continue;
          selfOk = selfOk && list.selfOk;
          for (let o2 = 0; o2 < N; o2++) if (list.cross[o2] < thr[o2]) thr[o2] = list.cross[o2];
        }
        row[j] = { selfOk, thr: Int32Array.from(thr) };
      }
      o.steps.push(row);
    }
  }

  // Admissible bound on remaining filament changes, per object and height index:
  // the set of colours still to print, and the run sequence of colours still to print.
  const nColours = colourIds.size;
  for (const o of objects) {
    o.remMask = [];
    o.runs = [];
    o.firstRun = [];
    for (let i = 0; i <= o.K; i++) {
      let mask = 0;
      let runs = 0;
      let last = -1;
      let first = -1;
      for (let k = i + 1; k <= o.K; k++) {
        const c = o.bands[k].colourId;
        if (c < 30) mask |= (1 << c);
        if (c !== last) { runs++; last = c; if (first === -1) first = c; }
      }
      o.remMask.push(mask);
      o.runs.push(runs);
      o.firstRun.push(first);
    }
  }

  return {
    profile, objects, highZ, checks,
    colours: [...colourIds.keys()],
    colourMaskExact: nColours <= 30,
  };
}

/** Is step (o: i -> j) feasible with the other objects at height indices H? */
export function isStepFeasible(model, H, oi, i, j) {
  const info = model.objects[oi].steps[i]?.[j];
  if (!info || !info.selfOk) return false;
  for (let o2 = 0; o2 < H.length; o2++) {
    if (o2 !== oi && H[o2] > info.thr[o2]) return false;
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
    const distinct = popcount(mask) - (loaded !== -1 && loaded < 30 && (mask & (1 << loaded)) ? 1 : 0);
    const need = loaded === -1 ? popcount(mask) - 1 : distinct;
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
    const colour = o.bands[i + 1].colourId;
    const change = node.loaded !== -1 && colour !== node.loaded ? 1 : 0;
    const start = o.bands[i + 1].start;
    const travel = node.end ? Math.hypot(start[0] - node.end[0], start[1] - node.end[1]) : 0;
    for (let j = i + 1; j <= o.K; j++) {
      if (o.bands[j].colourId !== colour) break;
      // Feasibility is monotone in j (a longer step only adds moves), so stop at the first miss.
      if (!isStepFeasible(model, H, oi, i, j)) break;
      const H2 = H.slice();
      H2[oi] = j;
      out.push({
        H: H2, loaded: colour, end: o.bands[j].end,
        step: { o: oi, i, j },
        dg: change * CHANGE_WEIGHT + travel + STEP_TIEBREAK,
        changes: change, travel,
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
  const h = heuristicChanges(model, H, -1) * CHANGE_WEIGHT;
  return { H, loaded: -1, end: null, step: null, parent: null, g: 0, f: h, changes: 0, travel: 0 };
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

// Depth-first search for any feasible plan (greedy order, visited set): complete over the
// candidate graph within the node limit, used when the beam lost every feasible branch.
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
 * Search the schedule graph. State = per-object candidate height index + loaded colour; a
 * transition is one feasible monochrome step; cost = CHANGE_WEIGHT per filament change + XY
 * glue travel (from the path's previous step end, so travel is exact along each path but the
 * state does not remember it; changes, the primary objective, are exact). A* with an
 * admissible bound on remaining changes runs while it stays under maxStates expansions;
 * otherwise a beam search, then a depth-first search for any feasible plan.
 */
export function searchPlan(model, options = {}) {
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES;
  const beam = options.beam ?? DEFAULT_BEAM;
  const sequentialOnly = options.sequentialOnly === true;
  let explored = 0;
  let method = 'astar';
  let res = astar(model, { maxStates, sequentialOnly });
  explored += res.expanded;
  let optimal = res.complete && res.node !== null;
  if (!res.complete) {
    method = 'beam';
    res = beamSearch(model, { beam, sequentialOnly });
    explored += res.expanded;
    if (!res.node) {
      method = 'dfs';
      // Its own budget: a small --max-states only caps the optimising search, not the
      // guarantee of returning some feasible plan when one exists over the candidates.
      const limit = options.dfsLimit ?? Math.max(maxStates, DEFAULT_MAX_STATES) * 4;
      res = dfsAny(model, { limit, sequentialOnly });
      explored += res.expanded;
    }
  }
  if (!res.node) return { feasible: false, method, statesExplored: explored, optimal: false };
  const steps = mergeSteps(model, reconstruct(res.node));
  return {
    feasible: true,
    method,
    optimal,
    statesExplored: explored,
    steps,
    filamentChanges: res.node.changes,
  };
}

/**
 * Join back-to-back steps of one object in one colour when the joined step is feasible in the
 * same state (the heuristic searches can leave such splits; joining never adds a change and
 * removes a lift, a descent and their travel).
 */
export function mergeSteps(model, steps) {
  const out = [];
  const H = new Array(model.objects.length).fill(0);
  const before = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && prev.o === s.o && prev.j === s.i &&
        model.objects[s.o].bands[prev.i + 1].colourId === model.objects[s.o].bands[s.i + 1].colourId &&
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

/** Turn a plan's (o, i, j) steps into emitter chunks. */
export function planChunks(model, extracted, steps) {
  const counts = new Map();
  for (const s of steps) counts.set(s.o, (counts.get(s.o) || 0) + 1);
  const seen = new Map();
  return steps.map((s, index) => {
    const o = model.objects[s.o];
    const slices = [];
    for (let k = s.i + 1; k <= s.j; k++) slices.push(...o.bands[k].slices);
    const chunk = buildBandChunk(o.obj, slices, extracted.segmentsByLine);
    const bandIndex = seen.get(s.o) || 0;
    seen.set(s.o, bandIndex + 1);
    const zLo = o.heights[s.i];
    const zHi = o.heights[s.j];
    return {
      index,
      id: counts.get(s.o) === 1 ? o.name : `${o.name} [Z${r3(zLo)}-${r3(zHi)}]`,
      objectId: o.obj.id,
      bandIndex,
      colour: o.bands[s.i + 1].colour,
      zLo: r3(zLo),
      zHi: r3(zHi),
      layers: slices.length,
      ...chunk,
    };
  });
}

export function basePrintTime(chunks) {
  let t = 0;
  for (const c of chunks) {
    for (const m of c.moves) {
      const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0, m.z1 - m.z0);
      t += len / ((m.feedrate > 0 ? m.feedrate : 1800) / 60);
    }
  }
  return t;
}

function stepSummary(c) {
  return {
    id: c.id,
    object: c.object,
    z_lo: c.zLo,
    z_hi: c.zHi,
    colour: c.colour,
    layers: c.layers,
    moves: c.moveCount,
    extrusion_mm: c.extrusionLength,
  };
}

function planCostSummary(model, extracted, plan) {
  const chunks = planChunks(model, extracted, plan.steps);
  const cost = evaluateOrderCost(chunks, chunks.map((_, i) => i), model.profile);
  return {
    chunks,
    cost,
    estimatedTimeS: +(basePrintTime(chunks) + cost.totalAddedTimeS).toFixed(1),
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
      out.push({
        object: o.name,
        band: [r3(band.lo), r3(band.hi)],
        blocked_by: objects[o2].name,
        blocker_max_height_mm: r3(objects[o2].heights[worst.thr]),
        part: worst.hit?.part || 'unknown',
        penetration_mm: worst.hit?.penetration_mm || 0,
        suggestion: `'${o.name}' cannot print Z ${r3(band.lo)}-${r3(band.hi)} once '${objects[o2].name}' is above ${r3(objects[o2].heights[worst.thr])} mm (${worst.hit?.part || 'head'}); move the objects apart or add --split-at heights (clearance ${profile.clearance_height} mm).`,
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
  const attempts = [];
  let firstModel = null;
  let accepted = null;

  for (const variant of variants) {
    const model = buildPlanModel(extracted, { ...options, ...variant });
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
    const { chunks, cost, estimatedTimeS } = planCostSummary(model, extracted, plan);
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

  // Comparison baselines: the file's own order and a plain sequential-objects plan.
  const model = accepted ? accepted.model : firstModel;
  const seqPlan = searchPlan(model, { ...options, sequentialOnly: true });
  let sequential = { feasible: false };
  if (seqPlan.feasible) {
    const s = planCostSummary(model, extracted, seqPlan);
    sequential = {
      feasible: true,
      filament_changes: s.cost.filamentChanges,
      travel_distance_mm: s.cost.travelDistMm,
      estimated_time_s: s.estimatedTimeS,
      order: s.chunks.map((c) => c.id),
    };
  }
  const changeCost = profile.change_cost_s ?? 120;
  const fileChunks = extracted.chunks;
  const original = {
    filament_changes: extracted.originalColourChanges,
    estimated_time_s: +(basePrintTime(fileChunks) + extracted.originalColourChanges * changeCost).toFixed(1),
  };
  const candidates = model.objects.map((o) => ({ object: o.name, heights: o.heights.slice(1).map(r3) }));

  if (!accepted) {
    return {
      feasible: false,
      attempts,
      candidates,
      original,
      sequential,
      diagnostics: conflictDiagnostics(firstModel),
    };
  }
  return {
    feasible: true,
    attempts,
    candidates,
    original,
    sequential,
    method: accepted.plan.method,
    optimal: accepted.plan.optimal,
    statesExplored: accepted.plan.statesExplored,
    model: accepted.model,
    rawSteps: accepted.plan.steps,
    chunks: accepted.chunks,
    steps: accepted.chunks.map(stepSummary),
    filamentChanges: accepted.cost.filamentChanges,
    travelDistMm: accepted.cost.travelDistMm,
    estimatedTimeS: accepted.estimatedTimeS,
    gcode: accepted.gcode,
    verification: accepted.verification,
  };
}

/**
 * Test hook: the store the step would really be checked against (base, own layers up to zLo,
 * every other object at its height in H, composed with DepositStore.clone/paint) and the
 * step's full check moves (descent, layers and glue, lift). Lets tests confirm that the
 * decomposed tables predict exactly what checkMoves says on the composed store.
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
  moves.push(liftMove(o.bands[j].end, highZ, o.bands[j].slices.at(-1), o.name));
  return { store, moves, hits: checkMoves(profile, store, moves, { stopOnFirst: true }) };
}

export { CHANGE_WEIGHT, DEFAULT_TRAVEL_FEEDRATE };
