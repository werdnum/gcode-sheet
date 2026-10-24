// lib/collide.mjs: Phase 1 print-head collision checking library (fast DepositStore +
// checkMoves, plus naive swept-volume voxel reference implementation and event collapsing).
import { loadToolpath } from './toolpath.mjs';
import { loadProfile } from './profiles.mjs';

export { loadToolpath, loadProfile };

const EPS = 1e-5;
const TILE_SHIFT = 3; // 8x8 cells per coarse tile
const TILE_SIZE = 1 << TILE_SHIFT;

/**
 * Liang-Barsky 2D segment clipping against closed axis-aligned rectangle [minX, maxX] x [minY, maxY].
 * Returns [t0, t1] subset of [0, 1], or null if no intersection.
 */
export function clipSegmentAABB(x0, y0, x1, y1, minX, maxX, minY, maxY) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  if (dx === 0) {
    if (x0 < minX || x0 > maxX) return null;
  } else {
    const inv = 1 / dx;
    let ta = (minX - x0) * inv;
    let tb = (maxX - x0) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }

  const dy = y1 - y0;
  if (dy === 0) {
    if (y0 < minY || y0 > maxY) return null;
  } else {
    const inv = 1 / dy;
    let ta = (minY - y0) * inv;
    let tb = (maxY - y0) * inv;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }

  return [t0, t1];
}

/**
 * Exact parameter interval [t0, t1] in [0, 1] where a 2D segment (x0, y0)->(x1, y1)
 * is within Euclidean distance <= r of the closed rectangle [xa, xb] x [ya, yb].
 * Since the Minkowski sum of a rectangle and a disc is convex, the intersection with
 * a line segment is always empty or a single connected interval [t0, t1].
 */
export function segmentCellIntervalCylinder(x0, y0, x1, y1, xa, xb, ya, yb, r) {
  // Fast outer bounding-box rejection
  if (!clipSegmentAABB(x0, y0, x1, y1, xa - r, xb + r, ya - r, yb + r)) {
    return null;
  }

  let tMin = 2;
  let tMax = -1;

  // 1) Vertically expanded rectangle [xa, xb] x [ya - r, yb + r]
  const vClip = clipSegmentAABB(x0, y0, x1, y1, xa, xb, ya - r, yb + r);
  if (vClip) {
    if (vClip[0] < tMin) tMin = vClip[0];
    if (vClip[1] > tMax) tMax = vClip[1];
  }

  // 2) Horizontally expanded rectangle [xa - r, xb + r] x [ya, yb]
  const hClip = clipSegmentAABB(x0, y0, x1, y1, xa - r, xb + r, ya, yb);
  if (hClip) {
    if (hClip[0] < tMin) tMin = hClip[0];
    if (hClip[1] > tMax) tMax = hClip[1];
  }

  // If the full [0, 1] interval is already covered, return immediately
  if (tMin <= 0 && tMax >= 1) return [0, 1];

  // 3) Four corner discs of radius r at (xa, ya), (xa, yb), (xb, ya), (xb, yb)
  const dx = x1 - x0;
  const dy = y1 - y0;
  const a = dx * dx + dy * dy;
  const r2 = r * r;

  const cornersX = [xa, xa, xb, xb];
  const cornersY = [ya, yb, ya, yb];

  if (a === 0) {
    for (let k = 0; k < 4; k++) {
      const ux = x0 - cornersX[k];
      const uy = y0 - cornersY[k];
      if (ux * ux + uy * uy <= r2) return [0, 1];
    }
  } else {
    const invA = 1 / a;
    for (let k = 0; k < 4; k++) {
      const ux = x0 - cornersX[k];
      const uy = y0 - cornersY[k];
      const b = ux * dx + uy * dy;
      const c = ux * ux + uy * uy - r2;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const sqrtDisc = Math.sqrt(disc);
        const tc0 = Math.max(0, (-b - sqrtDisc) * invA);
        const tc1 = Math.min(1, (-b + sqrtDisc) * invA);
        if (tc0 <= tc1) {
          if (tc0 < tMin) tMin = tc0;
          if (tc1 > tMax) tMax = tc1;
        }
      }
    }
  }

  return tMin <= tMax ? [tMin, tMax] : null;
}

/**
 * Exact parameter interval [t0, t1] in [0, 1] where a box [bx0, bx1] x [by0, by1]
 * centered at (x(t), y(t)) intersects the closed cell rectangle [xa, xb] x [ya, yb].
 */
export function segmentCellIntervalBox(x0, y0, x1, y1, xa, xb, ya, yb, bx0, bx1, by0, by1) {
  return clipSegmentAABB(x0, y0, x1, y1, xa - bx1, xb - bx0, ya - by1, yb - by0);
}

/**
 * Compute grid bounds aligned to integer coordinates so halving grid (g -> g/2)
 * always forms an exact nested 2x2 refinement of every cell.
 */
export function computeGridGeometry(profile, grid = 1.0) {
  if (!(grid > 0 && Number.isFinite(grid))) {
    throw new Error(`Invalid grid size: ${grid}`);
  }
  const pad = 16;
  const originX = Math.floor(profile.bed.x[0] - pad);
  const originY = Math.floor(profile.bed.y[0] - pad);
  const maxX = Math.ceil(profile.bed.x[1] + pad);
  const maxY = Math.ceil(profile.bed.y[1] + pad);
  const cols = Math.ceil((maxX - originX) / grid);
  const rows = Math.ceil((maxY - originY) / grid);
  return { originX, originY, cols, rows, grid };
}

/**
 * Fast deposited-material height store with 2D cell grid, per-row maxima (for X-spanning
 * gantry queries), and 8x8 coarse tile maxima (for cylinder/box queries).
 */
export class DepositStore {
  constructor(profile, options = {}) {
    this.profile = loadProfile(profile);
    this.grid = Number(options.grid ?? 1.0);
    this.margin = Number(options.margin ?? 0.5);
    const geom = computeGridGeometry(this.profile, this.grid);
    this.originX = geom.originX;
    this.originY = geom.originY;
    this.cols = geom.cols;
    this.rows = geom.rows;

    const totalCells = this.cols * this.rows;
    this.top = new Float64Array(totalCells);
    this.obj = new Int32Array(totalCells).fill(-1);

    this.rowMaxTop = new Float64Array(this.rows);
    this.rowMaxCx = new Int32Array(this.rows).fill(-1);
    this.rowMaxObj = new Int32Array(this.rows).fill(-1);

    this.tileCols = Math.ceil(this.cols / TILE_SIZE);
    this.tileRows = Math.ceil(this.rows / TILE_SIZE);
    this.tileMaxTop = new Float64Array(this.tileCols * this.tileRows);

    this.maxTop = 0;
    this.objectNames = [];
    this.objectNameToId = new Map();
  }

  clone() {
    const copy = Object.create(DepositStore.prototype);
    copy.profile = this.profile;
    copy.grid = this.grid;
    copy.margin = this.margin;
    copy.originX = this.originX;
    copy.originY = this.originY;
    copy.cols = this.cols;
    copy.rows = this.rows;
    copy.top = new Float64Array(this.top);
    copy.obj = new Int32Array(this.obj);
    copy.rowMaxTop = new Float64Array(this.rowMaxTop);
    copy.rowMaxCx = new Int32Array(this.rowMaxCx);
    copy.rowMaxObj = new Int32Array(this.rowMaxObj);
    copy.tileCols = this.tileCols;
    copy.tileRows = this.tileRows;
    copy.tileMaxTop = new Float64Array(this.tileMaxTop);
    copy.maxTop = this.maxTop;
    copy.objectNames = [...this.objectNames];
    copy.objectNameToId = new Map(this.objectNameToId);
    return copy;
  }

  _internObject(name) {
    if (!name) return -1;
    let id = this.objectNameToId.get(name);
    if (id === undefined) {
      id = this.objectNames.length;
      this.objectNames.push(name);
      this.objectNameToId.set(name, id);
    }
    return id;
  }

  objectName(id) {
    return id >= 0 && id < this.objectNames.length ? this.objectNames[id] : null;
  }

  paintMove(move) {
    if (!move || !move.extruding || move.inStart) return;
    const { x0, y0, z0, x1, y1, z1 } = move;
    const width = move.width > 0 ? move.width : 0.45;
    const r = width * 0.5 + this.margin;
    const objId = this._internObject(move.object);

    const minX = Math.min(x0, x1) - r;
    const maxX = Math.max(x0, x1) + r;
    const minY = Math.min(y0, y1) - r;
    const maxY = Math.max(y0, y1) + r;

    const g = this.grid;
    const invG = 1 / g;
    const cx0 = Math.max(0, Math.floor((minX - this.originX) * invG));
    const cx1 = Math.min(this.cols - 1, Math.floor((maxX - this.originX) * invG));
    const cy0 = Math.max(0, Math.floor((minY - this.originY) * invG));
    const cy1 = Math.min(this.rows - 1, Math.floor((maxY - this.originY) * invG));

    const flatZ = (z0 === z1);
    const dz = z1 - z0;

    for (let cy = cy0; cy <= cy1; cy++) {
      const ya = this.originY + cy * g;
      const yb = ya + g;
      const rowOff = cy * this.cols;
      const tyOff = (cy >> TILE_SHIFT) * this.tileCols;

      for (let cx = cx0; cx <= cx1; cx++) {
        const xa = this.originX + cx * g;
        const xb = xa + g;
        const interval = segmentCellIntervalCylinder(x0, y0, x1, y1, xa, xb, ya, yb, r);
        if (!interval) continue;

        const zTop = flatZ
          ? z0
          : Math.max(z0 + interval[0] * dz, z0 + interval[1] * dz);

        if (zTop <= 0) continue;
        const idx = rowOff + cx;
        if (zTop > this.top[idx] || (zTop === this.top[idx] && this.obj[idx] === -1)) {
          this.top[idx] = zTop;
          this.obj[idx] = objId;
          if (zTop > this.rowMaxTop[cy]) {
            this.rowMaxTop[cy] = zTop;
            this.rowMaxCx[cy] = cx;
            this.rowMaxObj[cy] = objId;
          }
          const tIdx = tyOff + (cx >> TILE_SHIFT);
          if (zTop > this.tileMaxTop[tIdx]) {
            this.tileMaxTop[tIdx] = zTop;
          }
          if (zTop > this.maxTop) {
            this.maxTop = zTop;
          }
        }
      }
    }
  }

  paint(moves) {
    if (!moves) return this;
    for (let i = 0; i < moves.length; i++) {
      this.paintMove(moves[i]);
    }
    return this;
  }
}

/**
 * Check a list of moves against an existing DepositStore without mutating the store.
 * Returns an array of collision hit events (one per (move, part) that collides, recording
 * the maximum penetration cell for that move and part).
 */
export function checkMoves(profileInput, store, moves, options = {}) {
  const profile = store.profile || loadProfile(profileInput);
  const stopOnFirst = options.stopOnFirst === true;
  const hits = [];
  if (!moves || moves.length === 0 || store.maxTop <= 0) return hits;

  const parts = profile.parts;
  let minPartZLo = Infinity;
  for (let p = 0; p < parts.length; p++) {
    if (parts[p].z[0] < minPartZLo) minPartZLo = parts[p].z[0];
  }

  const g = store.grid;
  const invG = 1 / g;
  const cols = store.cols;
  const rows = store.rows;
  const originX = store.originX;
  const originY = store.originY;
  const maxGridX = originX + cols * g;

  for (let mIdx = 0; mIdx < moves.length; mIdx++) {
    const move = moves[mIdx];
    if (!move || move.inStart) continue;
    const { x0, y0, z0, x1, y1, z1 } = move;
    const minNozzleZ = Math.min(z0, z1);

    // Quick global exit: if the highest deposited material on the entire bed is at or
    // below minNozzleZ + minPartZLo, no head part can possibly collide on this move.
    if (store.maxTop <= minNozzleZ + minPartZLo + EPS) continue;

    const flatZ = (z0 === z1);
    const dz = z1 - z0;

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx];
      const zLo = part.z[0];
      if (store.maxTop <= minNozzleZ + zLo + EPS) continue;

      let minX, maxX, minY, maxY;
      const isCyl = part.shape === 'cylinder';
      if (isCyl) {
        const r = part.r;
        minX = Math.min(x0, x1) - r;
        maxX = Math.max(x0, x1) + r;
        minY = Math.min(y0, y1) - r;
        maxY = Math.max(y0, y1) + r;
      } else {
        minX = Math.min(x0, x1) + part.x[0];
        maxX = Math.max(x0, x1) + part.x[1];
        minY = Math.min(y0, y1) + part.y[0];
        maxY = Math.max(y0, y1) + part.y[1];
      }

      const cx0 = Math.max(0, Math.floor((minX - originX) * invG));
      const cx1 = Math.min(cols - 1, Math.floor((maxX - originX) * invG));
      const cy0 = Math.max(0, Math.floor((minY - originY) * invG));
      const cy1 = Math.min(rows - 1, Math.floor((maxY - originY) * invG));
      if (cx0 > cx1 || cy0 > cy1) continue;

      // Fast path for a box that spans the full grid X width at every point along the move
      // (e.g. X gantry with x: [-1000, 1000]) on constant-Z moves:
      // Every X cell in row cy has the exact same Y interval, so we can check rowMaxTop[cy] in O(1)!
      const spansFullX = !isCyl &&
        (Math.max(x0, x1) + part.x[0] <= originX) &&
        (Math.min(x0, x1) + part.x[1] >= maxGridX);

      let bestPen = 0;
      let bestCx = -1;
      let bestCy = -1;
      let bestTop = 0;
      let bestObjId = -1;
      let bestT = 0;

      if (spansFullX && flatZ) {
        const partBottom = z0 + zLo;
        for (let cy = cy0; cy <= cy1; cy++) {
          const rTop = store.rowMaxTop[cy];
          const pen = rTop - partBottom;
          if (pen > EPS && pen > bestPen) {
            const ya = originY + cy * g;
            const yb = ya + g;
            const cx = store.rowMaxCx[cy];
            const xa = originX + cx * g;
            const xb = xa + g;
            const interval = segmentCellIntervalBox(x0, y0, x1, y1, xa, xb, ya, yb, part.x[0], part.x[1], part.y[0], part.y[1]);
            if (!interval) continue;
            bestPen = pen;
            bestCx = cx;
            bestCy = cy;
            bestTop = rTop;
            bestObjId = store.rowMaxObj[cy];
            bestT = interval[0];
          }
        }
      } else {
        // Tile-accelerated exact swept-volume check
        const tx0 = cx0 >> TILE_SHIFT;
        const tx1 = cx1 >> TILE_SHIFT;
        const ty0 = cy0 >> TILE_SHIFT;
        const ty1 = cy1 >> TILE_SHIFT;
        const threshold = minNozzleZ + zLo + EPS;

        for (let ty = ty0; ty <= ty1; ty++) {
          const tyOff = ty * store.tileCols;
          const subCy0 = Math.max(cy0, ty << TILE_SHIFT);
          const subCy1 = Math.min(cy1, ((ty + 1) << TILE_SHIFT) - 1);

          for (let tx = tx0; tx <= tx1; tx++) {
            if (store.tileMaxTop[tyOff + tx] <= threshold) continue;
            const subCx0 = Math.max(cx0, tx << TILE_SHIFT);
            const subCx1 = Math.min(cx1, ((tx + 1) << TILE_SHIFT) - 1);

            for (let cy = subCy0; cy <= subCy1; cy++) {
              if (store.rowMaxTop[cy] <= threshold) continue;
              const ya = originY + cy * g;
              const yb = ya + g;
              const rowOff = cy * cols;

              for (let cx = subCx0; cx <= subCx1; cx++) {
                const idx = rowOff + cx;
                const cellTop = store.top[idx];
                if (cellTop <= threshold) continue;

                const xa = originX + cx * g;
                const xb = xa + g;
                const interval = isCyl
                  ? segmentCellIntervalCylinder(x0, y0, x1, y1, xa, xb, ya, yb, part.r)
                  : segmentCellIntervalBox(x0, y0, x1, y1, xa, xb, ya, yb, part.x[0], part.x[1], part.y[0], part.y[1]);
                if (!interval) continue;

                // Minimum nozzle Z during the sub-interval [t0, t1] when the part overlaps this cell
                let tHit = interval[0];
                let zAtHit = z0;
                if (!flatZ) {
                  const zEnter = z0 + interval[0] * dz;
                  const zExit = z0 + interval[1] * dz;
                  if (zEnter <= zExit) {
                    tHit = interval[0];
                    zAtHit = zEnter;
                  } else {
                    tHit = interval[1];
                    zAtHit = zExit;
                  }
                }

                const pen = cellTop - (zAtHit + zLo);
                if (pen > EPS && pen > bestPen) {
                  bestPen = pen;
                  bestCx = cx;
                  bestCy = cy;
                  bestTop = cellTop;
                  bestObjId = store.obj[idx];
                  bestT = tHit;
                }
              }
            }
          }
        }
      }

      if (bestPen > EPS) {
        const hitNozzleX = +(x0 + bestT * (x1 - x0)).toFixed(3);
        const hitNozzleY = +(y0 + bestT * (y1 - y0)).toFixed(3);
        const hitNozzleZ = +(z0 + bestT * dz).toFixed(3);
        hits.push({
          line: move.line,
          layer: move.layer,
          z: hitNozzleZ,
          nozzle: [hitNozzleX, hitNozzleY],
          part: part.id,
          printing_object: move.object || null,
          hit_object: store.objectName(bestObjId),
          hit_cell: [
            +(originX + bestCx * g).toFixed(3),
            +(originY + bestCy * g).toFixed(3),
          ],
          deposited_top: +bestTop.toFixed(3),
          penetration_mm: +bestPen.toFixed(3),
          move: move.raw || `${move.kind} X${x1} Y${y1} Z${z1}`,
        });
        if (stopOnFirst) return hits;
      }
    }
  }

  return hits;
}

/**
 * Independent swept-volume intersection helpers used ONLY by the naive reference checker,
 * implemented via direct point-to-rectangle distance minimization and bisection on t in [0, 1]
 * so the reference checker shares zero geometric clipping code with the fast checker.
 */
function rectDistSq(px, py, xa, xb, ya, yb) {
  const dx = px < xa ? xa - px : (px > xb ? px - xb : 0);
  const dy = py < ya ? ya - py : (py > yb ? py - yb : 0);
  return dx * dx + dy * dy;
}

function referenceIntervalCylinder(x0, y0, x1, y1, xa, xb, ya, yb, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const r2 = r * r + 1e-11;
  const f = (t) => rectDistSq(x0 + t * dx, y0 + t * dy, xa, xb, ya, yb);

  // Since rectDistSq(x(t), y(t)) is convex in t on [0, 1], find its minimum on [0, 1] by ternary search
  let lo = 0, hi = 1;
  for (let iter = 0; iter < 28; iter++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2;
    else lo = m1;
  }
  const tStar = 0.5 * (lo + hi);
  if (f(tStar) > r2) {
    if (f(0) <= r2) return [0, 0];
    if (f(1) <= r2) return [1, 1];
    return null;
  }

  // Bisect entry in [0, tStar]
  let tEnter = 0;
  if (f(0) > r2) {
    let a = 0, b = tStar;
    for (let iter = 0; iter < 28; iter++) {
      const mid = 0.5 * (a + b);
      if (f(mid) <= r2) b = mid;
      else a = mid;
    }
    tEnter = 0.5 * (a + b);
  }

  // Bisect exit in [tStar, 1]
  let tExit = 1;
  if (f(1) > r2) {
    let a = tStar, b = 1;
    for (let iter = 0; iter < 28; iter++) {
      const mid = 0.5 * (a + b);
      if (f(mid) <= r2) a = mid;
      else b = mid;
    }
    tExit = 0.5 * (a + b);
  }

  return [tEnter, tExit];
}

function referenceIntervalBox(x0, y0, x1, y1, xa, xb, ya, yb, bx0, bx1, by0, by1) {
  const rx0 = xa - bx1, rx1 = xb - bx0;
  const ry0 = ya - by1, ry1 = yb - by0;
  const dx = x1 - x0, dy = y1 - y0;
  const f = (t) => rectDistSq(x0 + t * dx, y0 + t * dy, rx0, rx1, ry0, ry1);

  let lo = 0, hi = 1;
  for (let iter = 0; iter < 28; iter++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2;
    else lo = m1;
  }
  const tStar = 0.5 * (lo + hi);
  if (f(tStar) > 1e-11) {
    if (f(0) <= 1e-11) return [0, 0];
    if (f(1) <= 1e-11) return [1, 1];
    return null;
  }

  let tEnter = 0;
  if (f(0) > 1e-11) {
    let a = 0, b = tStar;
    for (let iter = 0; iter < 28; iter++) {
      const mid = 0.5 * (a + b);
      if (f(mid) <= 1e-11) b = mid;
      else a = mid;
    }
    tEnter = 0.5 * (a + b);
  }

  let tExit = 1;
  if (f(1) > 1e-11) {
    let a = tStar, b = 1;
    for (let iter = 0; iter < 28; iter++) {
      const mid = 0.5 * (a + b);
      if (f(mid) <= 1e-11) a = mid;
      else b = mid;
    }
    tExit = 0.5 * (a + b);
  }

  return [tEnter, tExit];
}

/**
 * Deliberately naive brute-force reference checker:
 * Stores deposited voxels in a flat list/map of occupied (cx, cy) cells without
 * any row-maxima, tile-maxima, or global-max pruning, and brute-force intersects
 * the swept volume of each head part along each move with every occupied voxel.
 */
export class ReferenceVoxelStore {
  constructor(profile, options = {}) {
    this.profile = loadProfile(profile);
    this.grid = Number(options.grid ?? 1.0);
    this.margin = Number(options.margin ?? 0.5);
    const geom = computeGridGeometry(this.profile, this.grid);
    this.originX = geom.originX;
    this.originY = geom.originY;
    this.cols = geom.cols;
    this.rows = geom.rows;
    this.voxels = new Map(); // key: cy * cols + cx -> { cx, cy, xa, xb, ya, yb, top, object }
  }

  paintMove(move) {
    if (!move || !move.extruding || move.inStart) return;
    const { x0, y0, z0, x1, y1, z1 } = move;
    const width = move.width > 0 ? move.width : 0.45;
    const r = width * 0.5 + this.margin;
    const g = this.grid;
    const dz = z1 - z0;

    const minX = Math.min(x0, x1) - r;
    const maxX = Math.max(x0, x1) + r;
    const minY = Math.min(y0, y1) - r;
    const maxY = Math.max(y0, y1) + r;

    const cx0 = Math.max(0, Math.floor((minX - this.originX) / g));
    const cx1 = Math.min(this.cols - 1, Math.floor((maxX - this.originX) / g));
    const cy0 = Math.max(0, Math.floor((minY - this.originY) / g));
    const cy1 = Math.min(this.rows - 1, Math.floor((maxY - this.originY) / g));

    for (let cy = cy0; cy <= cy1; cy++) {
      const ya = this.originY + cy * g;
      const yb = ya + g;
      for (let cx = cx0; cx <= cx1; cx++) {
        const xa = this.originX + cx * g;
        const xb = xa + g;
        const interval = referenceIntervalCylinder(x0, y0, x1, y1, xa, xb, ya, yb, r);
        if (!interval) continue;
        const zTop = Math.max(z0 + interval[0] * dz, z0 + interval[1] * dz);
        if (zTop <= 0) continue;
        const key = cy * this.cols + cx;
        const prev = this.voxels.get(key);
        if (!prev || zTop > prev.top) {
          this.voxels.set(key, {
            cx, cy, xa, xb, ya, yb,
            top: zTop,
            object: move.object || null,
          });
        }
      }
    }
  }

  paint(moves) {
    if (!moves) return this;
    for (const m of moves) this.paintMove(m);
    return this;
  }
}

export function checkMovesReference(profileInput, refStore, moves) {
  const profile = refStore.profile || loadProfile(profileInput);
  const hits = [];
  if (!moves || moves.length === 0 || refStore.voxels.size === 0) return hits;

  const voxelList = [...refStore.voxels.values()];

  for (let mIdx = 0; mIdx < moves.length; mIdx++) {
    const move = moves[mIdx];
    if (!move || move.inStart) continue;
    const { x0, y0, z0, x1, y1, z1 } = move;
    const dz = z1 - z0;

    for (let pIdx = 0; pIdx < profile.parts.length; pIdx++) {
      const part = profile.parts[pIdx];
      const zLo = part.z[0];
      const isCyl = part.shape === 'cylinder';

      let bestPen = 0;
      let bestVoxel = null;
      let bestT = 0;

      for (let vIdx = 0; vIdx < voxelList.length; vIdx++) {
        const v = voxelList[vIdx];
        const interval = isCyl
          ? referenceIntervalCylinder(x0, y0, x1, y1, v.xa, v.xb, v.ya, v.yb, part.r)
          : referenceIntervalBox(x0, y0, x1, y1, v.xa, v.xb, v.ya, v.yb, part.x[0], part.x[1], part.y[0], part.y[1]);
        if (!interval) continue;

        const zEnter = z0 + interval[0] * dz;
        const zExit = z0 + interval[1] * dz;
        const tHit = zEnter <= zExit ? interval[0] : interval[1];
        const zAtHit = Math.min(zEnter, zExit);
        const pen = v.top - (zAtHit + zLo);

        if (pen > EPS && pen > bestPen) {
          bestPen = pen;
          bestVoxel = v;
          bestT = tHit;
        }
      }

      if (bestPen > EPS && bestVoxel) {
        hits.push({
          line: move.line,
          layer: move.layer,
          z: +(z0 + bestT * dz).toFixed(3),
          nozzle: [
            +(x0 + bestT * (x1 - x0)).toFixed(3),
            +(y0 + bestT * (y1 - y0)).toFixed(3),
          ],
          part: part.id,
          printing_object: move.object || null,
          hit_object: bestVoxel.object,
          hit_cell: [+bestVoxel.xa.toFixed(3), +bestVoxel.ya.toFixed(3)],
          deposited_top: +bestVoxel.top.toFixed(3),
          penetration_mm: +bestPen.toFixed(3),
          move: move.raw || `${move.kind} X${x1} Y${y1} Z${z1}`,
        });
      }
    }
  }

  return hits;
}

/**
 * Collapse consecutive collision events per head part with the same (part, hit_object, printing_object)
 * into one range event, even when multiple parts (e.g. extruder + gantry) hit on the same move,
 * while preserving the exact set of flagged line numbers.
 */
export function collapseEvents(rawEvents) {
  if (!rawEvents || rawEvents.length === 0) return [];
  const collapsed = [];
  const activeByPart = new Map();

  for (let i = 0; i < rawEvents.length; i++) {
    const ev = rawEvents[i];
    const prev = activeByPart.get(ev.part);
    if (prev && prev.hit_object === ev.hit_object && prev.printing_object === ev.printing_object) {
      prev.last_line = ev.line;
      prev.count++;
      if (!prev._lineSet.has(ev.line)) {
        prev._lineSet.add(ev.line);
        prev.lines.push(ev.line);
      }
      if (ev.penetration_mm > prev.penetration_mm) {
        // `line` is the representative (deepest) hit, consistent with z/layer/move below;
        // `first_line`/`last_line`/`lines` keep the range.
        prev.line = ev.line;
        prev.penetration_mm = ev.penetration_mm;
        prev.deposited_top = ev.deposited_top;
        prev.z = ev.z;
        prev.layer = ev.layer;
        prev.nozzle = ev.nozzle;
        prev.hit_cell = ev.hit_cell;
        prev.move = ev.move;
      }
    } else {
      const lineSet = new Set([ev.line]);
      const item = {
        line: ev.line,
        first_line: ev.line,
        last_line: ev.line,
        count: 1,
        layer: ev.layer,
        z: ev.z,
        nozzle: ev.nozzle,
        part: ev.part,
        printing_object: ev.printing_object,
        hit_object: ev.hit_object,
        hit_cell: ev.hit_cell,
        deposited_top: ev.deposited_top,
        penetration_mm: ev.penetration_mm,
        move: ev.move,
        lines: [ev.line],
        _lineSet: lineSet,
      };
      collapsed.push(item);
      activeByPart.set(ev.part, item);
    }
  }

  for (const c of collapsed) {
    delete c._lineSet;
  }
  return collapsed;
}

/**
 * Run a full sequential collision check over a loaded toolpath (fast checker).
 */
export function checkToolpath(toolpathOrFile, profileInput = 'mk4', options = {}) {
  const profile = loadProfile(profileInput);
  const pathObj = (toolpathOrFile && Array.isArray(toolpathOrFile.moves))
    ? toolpathOrFile
    : loadToolpath(toolpathOrFile, { ...options, profile });

  const store = new DepositStore(profile, options);
  const rawEvents = [];

  for (let i = 0; i < pathObj.moves.length; i++) {
    const move = pathObj.moves[i];
    if (move.inStart) continue;
    const hits = checkMoves(profile, store, [move]);
    for (let h = 0; h < hits.length; h++) rawEvents.push(hits[h]);
    if (move.extruding) {
      store.paintMove(move);
    }
  }

  const events = collapseEvents(rawEvents);
  const partsHit = [...new Set(rawEvents.map(e => e.part))];
  const maxPen = rawEvents.reduce((m, e) => Math.max(m, e.penetration_mm), 0);

  const warnings = [];
  if (profile.unmeasuredParts && profile.unmeasuredParts.length > 0) {
    warnings.push(
      `Printer profile '${profile.name}' has unmeasured parts (${profile.unmeasuredParts.join(', ')}); results use conservative estimates.`
    );
  }
  if (!pathObj.hasObjectLabels) {
    warnings.push(
      'Input file has no PrusaSlicer object labels (; printing object ...); enable Label objects for per-object attribution and phase-2 sequencing.'
    );
  }

  return {
    collides: rawEvents.length > 0,
    printer: profile.name,
    unmeasured_parts: profile.unmeasuredParts || [],
    warnings,
    events,
    rawEvents,
    objects: pathObj.objects,
    summary: {
      events: rawEvents.length,
      collapsed_events: events.length,
      first_line: rawEvents.length > 0 ? rawEvents[0].line : null,
      max_penetration_mm: +maxPen.toFixed(3),
      parts_hit: partsHit,
    },
  };
}

/**
 * Run a full sequential collision check over a loaded toolpath using the naive
 * brute-force reference checker.
 */
export function checkToolpathReference(toolpathOrFile, profileInput = 'mk4', options = {}) {
  const profile = loadProfile(profileInput);
  const pathObj = (toolpathOrFile && Array.isArray(toolpathOrFile.moves))
    ? toolpathOrFile
    : loadToolpath(toolpathOrFile, { ...options, profile });

  const refStore = new ReferenceVoxelStore(profile, options);
  const rawEvents = [];

  for (let i = 0; i < pathObj.moves.length; i++) {
    const move = pathObj.moves[i];
    if (move.inStart) continue;
    const hits = checkMovesReference(profile, refStore, [move]);
    for (let h = 0; h < hits.length; h++) rawEvents.push(hits[h]);
    if (move.extruding) {
      refStore.paintMove(move);
    }
  }

  const events = collapseEvents(rawEvents);
  const partsHit = [...new Set(rawEvents.map(e => e.part))];
  const maxPen = rawEvents.reduce((m, e) => Math.max(m, e.penetration_mm), 0);

  return {
    collides: rawEvents.length > 0,
    events,
    rawEvents,
    objects: pathObj.objects,
    summary: {
      events: rawEvents.length,
      collapsed_events: events.length,
      first_line: rawEvents.length > 0 ? rawEvents[0].line : null,
      max_penetration_mm: +maxPen.toFixed(3),
      parts_hit: partsHit,
    },
  };
}

/**
 * PrusaSlicer's conservative sequential-print validation rule for cross-checking:
 * 1) Only the last printed object may exceed extruder_clearance_height (20 mm on MK4),
 *    because PrusaSlicer assumes an infinite X gantry at extruder_clearance_height
 *    with no Y-extent model.
 * 2) Every pair of objects must be separated in XY by at least extruder_clearance_radius
 *    (45 mm on MK4, or more generally their 2D bounding boxes / hulls must not approach
 *    closer than extruder_clearance_radius if printed sequentially).
 */
export function checkPrusaSlicerSequential(toolpathOrFile, profileInput = 'mk4') {
  const profile = loadProfile(profileInput);
  const pathObj = (toolpathOrFile && Array.isArray(toolpathOrFile.moves))
    ? toolpathOrFile
    : loadToolpath(toolpathOrFile, { profile });

  const clearanceH = profile.clearance_height ?? 20;
  const clearanceR = profile.clearance_radius ?? 45;

  // Determine whether the file prints objects sequentially or interleaved
  // by checking if any object appears again after another object has started.
  const objOrder = [];
  const finishedObjs = new Set();
  let currentObj = null;
  let isSequential = pathObj.objects.length > 1;
  for (const m of pathObj.moves) {
    if (!m.extruding || !m.object) continue;
    if (m.object !== currentObj) {
      if (currentObj) finishedObjs.add(currentObj);
      if (finishedObjs.has(m.object)) {
        isSequential = false;
        break;
      }
      if (!objOrder.includes(m.object)) objOrder.push(m.object);
      currentObj = m.object;
    }
  }

  if (!isSequential) {
    return { collides: false, reason: 'interleaved' };
  }

  const orderedObjects = objOrder.map(name => pathObj.objects.find(o => o.name === name)).filter(Boolean);

  // Rule 1: Any object before the last that exceeds clearance_height is rejected by PrusaSlicer's height check
  for (let i = 0; i < orderedObjects.length - 1; i++) {
    if (orderedObjects[i].top > clearanceH + EPS) {
      return {
        collides: true,
        reason: `Object '${orderedObjects[i].name}' (top ${orderedObjects[i].top} mm) exceeds clearance_height (${clearanceH} mm) before later objects`,
      };
    }
  }

  // Rule 2: XY bounding-box distance < clearance_radius
  for (let i = 0; i < orderedObjects.length; i++) {
    for (let j = i + 1; j < orderedObjects.length; j++) {
      const a = orderedObjects[i].bbox;
      const b = orderedObjects[j].bbox;
      const dx = Math.max(0, a.x[0] - b.x[1], b.x[0] - a.x[1]);
      const dy = Math.max(0, a.y[0] - b.y[1], b.y[0] - a.y[1]);
      const dist = Math.hypot(dx, dy);
      if (dist < clearanceR - EPS) {
        return {
          collides: true,
          reason: `Objects '${orderedObjects[i].name}' and '${orderedObjects[j].name}' are ${dist.toFixed(1)} mm apart (< clearance_radius ${clearanceR} mm)`,
        };
      }
    }
  }

  return { collides: false, reason: 'ok' };
}
