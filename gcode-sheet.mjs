#!/usr/bin/env node
// gcode-sheet.mjs: render a G-code or .bgcode file into a multi-view PNG contact sheet.
// Uses Three.js + webgl-node (native EGL/GLES on Mesa llvmpipe) with a streaming G-code
// parser and direct compact tube geometry builder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const SLOTS = '#F67910,#F2F2F2,#8C8C8C,#7B2FBE,#9A9A9A'; // MMU slots T0..T4 (black lifted to grey)
// Feature groups -> virtual tool index (max 8: T0..T7)
const FEATURE_GROUPS = [
  ['External perimeter', ['External perimeter'], '#F59E0B'],
  ['Perimeter', ['Perimeter'], '#FCD34D'],
  ['Overhang / bridge', ['Overhang perimeter', 'Bridge infill'], '#2563EB'],
  ['Sparse infill', ['Internal infill'], '#B91C1C'],
  ['Solid / top infill', ['Solid infill', 'Top solid infill', 'Gap fill', 'Ironing'], '#A855F7'],
  ['Support', ['Support material', 'Support material interface'], '#16A34A'],
  ['Skirt / brim', ['Skirt/Brim', 'Skirt', 'Brim'], '#0D9488'],
  ['Wipe tower / other', ['Wipe tower', 'Custom'], '#6B7280'],
];
const INTERIOR = new Set(['Perimeter', 'Internal infill', 'Solid infill', 'Gap fill']);
const TYPE_TO_TOOL = new Map();
FEATURE_GROUPS.forEach(([, types], i) => types.forEach(t => TYPE_TO_TOOL.set(t, i)));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    size: { type: 'string', default: '800' },          // each panel is size x size*0.8
    views: { type: 'string', default: 'iso,top,front,first' },
    'color-by': { type: 'string', default: 'tool' },   // tool | feature
    'tool-colors': { type: 'string', default: SLOTS },
    background: { type: 'string', default: '#DCDFE4' },
    'include-start': { type: 'boolean', default: false },
    'include-wipe-tower': { type: 'boolean', default: false },
    'no-labels': { type: 'boolean', default: false },
    detail: { type: 'string', default: 'auto' },       // full | shell | auto (shell for files > 9 MB)
    'arc-tol': { type: 'string' },                     // G2/G3 chord tolerance in mm (default 0.05)
    lines: { type: 'boolean', default: false },
    light: { type: 'string', default: '0.6,1.2,1.5' }, // ambient,directional,brightness
    'end-layer': { type: 'string' },                   // render the 3D views cut at this layer
    'extrusion-width': { type: 'string', default: '0.45' },
    'layer-height': { type: 'string', default: '0.2' },
  },
});

if (values.help || positionals.length !== 2) {
  console.log(`Usage: gcode-sheet INPUT.(gcode|bgcode) OUTPUT.png [options]
  --views iso,top,front,first,right   Panels, left to right / top to bottom (default iso,top,front,first)
  --color-by tool|feature             Colour by MMU tool (default) or by feature type
  --tool-colors '#hex,...'            T0..T7 colours (default: the MMU slot colours)
  --size N                            Panel width in px (height = 0.8 * N, default 800)
  --end-layer N                       Cut the 3D views at layer N (1-based)
  --include-start                     Keep the start-gcode purge line in view
  --include-wipe-tower                Include the MMU wipe tower in camera fit (excluded by default)
  --detail full|shell|auto            shell hides interior features above layer 1 (auto = shell over 9 MB)
  --light amb,dir,brightness          Lighting (default 0.6,1.2,1.5)
  --background '#hex'                 Background colour (default #DCDFE4)
  --extrusion-width MM                Fallback extrusion width in mm (default 0.45)
  --layer-height MM                   Fallback layer height in mm (default 0.2)
  --arc-tol MM                        G2/G3 arc chord tolerance in mm (default 0.05)
  --lines                             Render flat line segments instead of 3D tubes
  --no-labels                         Omit panel view labels and colour legend overlay
  views: iso top front right bottom first
Accepts plain .gcode or binary .bgcode (decoded via libbgcode). Prints a JSON summary to stdout.`);
  process.exit(values.help ? 0 : 2);
}

const panelW = parseInt(values.size, 10), panelH = Math.round(panelW * 0.8);
const views = values.views.split(',').map(s => s.trim()).filter(Boolean);
const byFeature = values['color-by'] === 'feature';
const useInt8Normals = process.env.INT8_NORM !== '0';

const VERTEX_SHADER = `
uniform float clipMinY;
uniform float clipMaxY;
varying vec3 vNormal;
varying float vWorldY;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vWorldY = (modelMatrix * vec4(position, 1.0)).y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float ambient;
uniform float directional;
uniform float brightness;
uniform float clipMinY;
uniform float clipMaxY;
varying vec3 vNormal;
varying float vWorldY;

void main() {
  if (vWorldY < clipMinY || vWorldY > clipMaxY) {
    discard;
  }
  vec3 lightDir = normalize(vec3(-0.8, -0.2, -0.8));
  float diff = max(dot(vNormal, -lightDir), 0.0) * directional;
  vec3 finalColor = uColor * (diff + ambient);
  finalColor = min(finalColor * brightness, 1.0);
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

// Max points per BufferGeometry chunk so vertex count (pts * 4) <= 65520 (fits in Uint16 index)
const MAX_CHUNK_PTS = 16380;
const MAX_CHUNK_VERTS = MAX_CHUNK_PTS * 4;
const MAX_CHUNK_INDICES = (MAX_CHUNK_PTS - 1) * 24;
const EMPTY_F32 = new Float32Array(0);
const EMPTY_I8 = new Int8Array(0);
const EMPTY_U16 = new Uint16Array(0);

const POW10 = [
  1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9,
  1e-10, 1e-11, 1e-12, 1e-13, 1e-14, 1e-15
];

function parseFastFloat(str, start, end) {
  while (start < end && str.charCodeAt(start) <= 32) start++;
  if (start >= end) return NaN;
  let sign = 1;
  let c = str.charCodeAt(start);
  if (c === 45) { sign = -1; start++; }
  else if (c === 43) { start++; }
  let intPart = 0;
  let hasDigits = false;
  while (start < end) {
    c = str.charCodeAt(start);
    if (c >= 48 && c <= 57) {
      intPart = intPart * 10 + (c - 48);
      hasDigits = true;
      start++;
    } else break;
  }
  let fracPart = 0;
  let fracLen = 0;
  if (start < end && str.charCodeAt(start) === 46) {
    start++;
    while (start < end) {
      c = str.charCodeAt(start);
      if (c >= 48 && c <= 57) {
        if (fracLen < 15) {
          fracPart = fracPart * 10 + (c - 48);
          fracLen++;
        }
        hasDigits = true;
        start++;
      } else break;
    }
  }
  if (!hasDigits) return NaN;
  if (start < end) {
    c = str.charCodeAt(start) | 32;
    if (c === 101) return parseFloat(str.slice(start, end));
  }
  return sign * (intPart + (fracLen > 0 ? fracPart * POW10[fracLen] : 0));
}

// Visit slices of one bounded read buffer at a time. Returning false stops early.
function visitGcodeLines(file, visit) {
  const fd = fs.openSync(file, 'r');
  const readBuf = Buffer.allocUnsafe(256 * 1024);
  let leftover = '';
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, readBuf, 0, readBuf.length, null)) > 0) {
      const chunk = leftover + readBuf.toString('latin1', 0, bytesRead);
      let start = 0;
      let nl = chunk.indexOf('\n');
      while (nl !== -1) {
        let end = nl;
        if (end > start && chunk.charCodeAt(end - 1) === 13) end--;
        if (visit(chunk, start, end) === false) return;
        start = nl + 1;
        nl = chunk.indexOf('\n', start);
      }
      leftover = chunk.slice(start);
    }
    if (leftover.length) visit(leftover, 0, leftover.length);
  } finally {
    fs.closeSync(fd);
  }
}

function isLayerMarker(str, start, end) {
  return (str.startsWith(';LAYER_CHANGE', start) &&
      str.slice(start + 13, end).trim() === '') ||
    (str.startsWith(';LAYER:', start) &&
      /^\d+\s*$/.test(str.slice(start + 7, end)));
}

// A short preflight normally stops at the first layer. Markerless files need a
// full streaming scan so their extrusion is never mistaken for a startup purge.
function hasLayerMarkers(file) {
  let found = false;
  visitGcodeLines(file, (str, start, end) => {
    while (start < end && str.charCodeAt(start) <= 32) start++;
    if (isLayerMarker(str, start, end)) {
      found = true;
      return false;
    }
  });
  return found;
}

class ToolChunkBuilder {
  constructor(tool, material, isLines, uploadChunk) {
    this.tool = tool;
    this.material = material;
    this.isLines = isLines;
    this.uploadChunk = uploadChunk;
    this.vertCount = 0;
    this.idxCount = 0;
    this.minZ = 1e9;
    this.maxZ = -1e9;
    this.pos = null;
    this.norm = null;
    this.idx = null;
  }

  ensureAllocated() {
    if (!this.pos) {
      this.pos = new Float32Array(MAX_CHUNK_VERTS * 3);
      this.norm = useInt8Normals ? new Int8Array(MAX_CHUNK_VERTS * 3) : new Float32Array(MAX_CHUNK_VERTS * 3);
      this.idx = new Uint16Array(MAX_CHUNK_INDICES);
    }
  }

  addPath(pts, nPts, width, height) {
    if (nPts < 2) return;
    const ptsPerVert = this.isLines ? 1 : 4;
    const maxPts = this.isLines ? (MAX_CHUNK_VERTS - 1) : MAX_CHUNK_PTS;
    let offset = 0;
    while (offset < nPts - 1) {
      const usedPts = this.isLines ? this.vertCount : (this.vertCount >> 2);
      const remPts = maxPts - usedPts;
      if (remPts < 2) {
        this.flush();
        continue;
      }
      const take = Math.min(nPts - offset, remPts);
      if (this.isLines) {
        this._appendLineSubPath(pts, offset, take, height);
      } else {
        this._appendTubeSubPath(pts, offset, take, width, height);
      }
      offset += take - 1;
      const newUsedPts = this.isLines ? this.vertCount : (this.vertCount >> 2);
      if (newUsedPts >= maxPts - 1) {
        this.flush();
      }
    }
  }

  _appendLineSubPath(pts, startPt, countPt, height) {
    this.ensureAllocated();
    const pos = this.pos, norm = this.norm, idx = this.idx;
    const vBase = this.vertCount;
    let pOff = vBase * 3;
    let iOff = this.idxCount;
    const halfH = height * 0.5;
    const nz = useInt8Normals ? 127 : 1;

    for (let c = 0; c < countPt; c++) {
      const idx3 = (startPt + c) * 3;
      const tx = pts[idx3], ty = pts[idx3 + 1], tz = pts[idx3 + 2];
      if (tz - height < this.minZ) this.minZ = tz - height;
      if (tz > this.maxZ) this.maxZ = tz;
      pos[pOff] = tx; pos[pOff + 1] = ty - 0.1; pos[pOff + 2] = tz - halfH;
      norm[pOff] = 0; norm[pOff + 1] = 0; norm[pOff + 2] = nz;
      pOff += 3;
    }
    for (let c = 1; c < countPt; c++) {
      idx[iOff++] = vBase + c - 1;
      idx[iOff++] = vBase + c;
    }
    this.vertCount = vBase + countPt;
    this.idxCount = iOff;
  }

  _appendTubeSubPath(pts, startPt, countPt, e, i) {
    this.ensureAllocated();
    const pos = this.pos;
    const norm = this.norm;
    const idx = this.idx;
    const vBase = this.vertCount;
    let pOff = vBase * 3;
    let iOff = this.idxCount;
    const halfW = e * 0.5;
    const halfH = i * 0.5;

    for (let c = 0; c < countPt; c++) {
      const idx3 = (startPt + c) * 3;
      const tx = pts[idx3], ty = pts[idx3 + 1], tz = pts[idx3 + 2];
      if (tz - i < this.minZ) this.minZ = tz - i;
      if (tz > this.maxZ) this.maxZ = tz;

      let d1x = 0, d1y = 0, d1z = 0;
      if (c > 0) {
        const p3 = idx3 - 3;
        d1x = tx - pts[p3]; d1y = ty - pts[p3 + 1]; d1z = tz - pts[p3 + 2];
        const l1 = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z);
        if (l1 > 0) { const inv = 1 / l1; d1x *= inv; d1y *= inv; d1z *= inv; }
      }
      let d2x = 0, d2y = 0, d2z = 0;
      if (c < countPt - 1) {
        const n3 = idx3 + 3;
        d2x = pts[n3] - tx; d2y = pts[n3 + 1] - ty; d2z = pts[n3 + 2] - tz;
        const l2 = Math.sqrt(d2x * d2x + d2y * d2y + d2z * d2z);
        if (l2 > 0) { const inv = 1 / l2; d2x *= inv; d2y *= inv; d2z *= inv; }
      }
      let ox = d1x + d2x, oy = d1y + d2y, oz = d1z + d2z;
      const tzShift = tz - halfH;

      // Fast path for planar horizontal moves (oz === 0)
      if (oz === 0 && (ox !== 0 || oy !== 0)) {
        const inv = 1 / Math.sqrt(ox * ox + oy * oy);
        ox *= inv; oy *= inv;
        const wx = halfW * oy, wy = halfW * ox;
        pos[pOff]     = tx;      pos[pOff + 1] = ty;      pos[pOff + 2] = tz;
        pos[pOff + 3] = tx - wx; pos[pOff + 4] = ty + wy; pos[pOff + 5] = tzShift;
        pos[pOff + 6] = tx;      pos[pOff + 7] = ty;      pos[pOff + 8] = tz - i;
        pos[pOff + 9] = tx + wx; pos[pOff + 10] = ty - wy; pos[pOff + 11] = tzShift;

        if (useInt8Normals) {
          const nx = Math.round(-oy * 127), ny = Math.round(ox * 127);
          norm[pOff]     = 0;   norm[pOff + 1] = 0;   norm[pOff + 2] = 127;
          norm[pOff + 3] = nx;  norm[pOff + 4] = ny;  norm[pOff + 5] = 0;
          norm[pOff + 6] = 0;   norm[pOff + 7] = 0;   norm[pOff + 8] = -127;
          norm[pOff + 9] = -nx; norm[pOff + 10] = -ny; norm[pOff + 11] = 0;
        } else {
          norm[pOff]     = 0;   norm[pOff + 1] = 0;   norm[pOff + 2] = 1;
          norm[pOff + 3] = -oy; norm[pOff + 4] = ox;  norm[pOff + 5] = 0;
          norm[pOff + 6] = 0;   norm[pOff + 7] = 0;   norm[pOff + 8] = -1;
          norm[pOff + 9] = oy;  norm[pOff + 10] = -ox; norm[pOff + 11] = 0;
        }
        pOff += 12;
        continue;
      }

      const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (ol > 0) { const inv = 1 / ol; ox *= inv; oy *= inv; oz *= inv; }

      let fx = 0, fy = 0, fz = 0;
      let minComp = Number.MAX_VALUE;
      const ax = Math.abs(ox), ay = Math.abs(oy), az = Math.abs(oz);
      if (ax <= minComp) { minComp = ax; fx = 1; fy = 0; fz = 0; }
      if (ay <= minComp) { minComp = ay; fx = 0; fy = 1; fz = 0; }
      if (az <= minComp) { fx = 0; fy = 0; fz = 1; }

      let xx = oy * fz - oz * fy;
      let xy = oz * fx - ox * fz;
      let xz = ox * fy - oy * fx;
      const xl = Math.sqrt(xx * xx + xy * xy + xz * xz);
      if (xl > 0) { const inv = 1 / xl; xx *= inv; xy *= inv; xz *= inv; }

      fx = oy * xz - oz * xy;
      fy = oz * xx - ox * xz;
      fz = ox * xy - oy * xx;

      const qx = oy * fz - oz * fy;
      const qy = oz * fx - ox * fz;
      const qz = ox * fy - oy * fx;

      const r0x = -fx, r0y = -fy, r0z = -fz;
      const r1x = qx,  r1y = qy,  r1z = qz;
      const r2x = fx,  r2y = fy,  r2z = fz;
      const r3x = -qx, r3y = -qy, r3z = -qz;

      pos[pOff]     = tx + halfW * r0x; pos[pOff + 1] = ty + halfW * r0y; pos[pOff + 2] = tzShift + halfH * r0z;
      pos[pOff + 3] = tx + halfW * r1x; pos[pOff + 4] = ty + halfW * r1y; pos[pOff + 5] = tzShift + halfH * r1z;
      pos[pOff + 6] = tx + halfW * r2x; pos[pOff + 7] = ty + halfW * r2y; pos[pOff + 8] = tzShift + halfH * r2z;
      pos[pOff + 9] = tx + halfW * r3x; pos[pOff + 10] = ty + halfW * r3y; pos[pOff + 11] = tzShift + halfH * r3z;

      if (useInt8Normals) {
        norm[pOff]     = Math.round(r0x * 127); norm[pOff + 1] = Math.round(r0y * 127); norm[pOff + 2] = Math.round(r0z * 127);
        norm[pOff + 3] = Math.round(r1x * 127); norm[pOff + 4] = Math.round(r1y * 127); norm[pOff + 5] = Math.round(r1z * 127);
        norm[pOff + 6] = Math.round(r2x * 127); norm[pOff + 7] = Math.round(r2y * 127); norm[pOff + 8] = Math.round(r2z * 127);
        norm[pOff + 9] = Math.round(r3x * 127); norm[pOff + 10] = Math.round(r3y * 127); norm[pOff + 11] = Math.round(r3z * 127);
      } else {
        norm[pOff]     = r0x; norm[pOff + 1] = r0y; norm[pOff + 2] = r0z;
        norm[pOff + 3] = r1x; norm[pOff + 4] = r1y; norm[pOff + 5] = r1z;
        norm[pOff + 6] = r2x; norm[pOff + 7] = r2y; norm[pOff + 8] = r2z;
        norm[pOff + 9] = r3x; norm[pOff + 10] = r3y; norm[pOff + 11] = r3z;
      }
      pOff += 12;
    }

    for (let c = 1; c < countPt; c++) {
      const ring0 = vBase + (c - 1) * 4;
      const ring1 = vBase + c * 4;
      for (let t = 0; t < 4; t++) {
        const tn = (t + 1) & 3;
        const F = ring0 + t;
        const q = ring1 + t;
        const X = ring1 + tn;
        const O = ring0 + tn;
        idx[iOff++] = F; idx[iOff++] = q; idx[iOff++] = O;
        idx[iOff++] = q; idx[iOff++] = X; idx[iOff++] = O;
      }
    }

    this.vertCount = vBase + countPt * 4;
    this.idxCount = iOff;
  }

  flush() {
    if (this.vertCount === 0) return;
    this.uploadChunk(this);
    this.vertCount = 0;
    this.idxCount = 0;
    this.minZ = 1e9;
    this.maxZ = -1e9;
  }

  releaseScratch() {
    this.pos = null;
    this.norm = null;
    this.idx = null;
  }
}

// 5x8 ASCII bitmap font (rows 0..6 above/on baseline, row 7 descender)
const FONT_5X8 = {
  ' ': [0,0,0,0,0,0,0,0], '!': [4,4,4,4,4,0,4,0], '"': [10,10,10,0,0,0,0,0], '#': [10,10,31,10,31,10,10,0],
  '$': [4,15,20,14,5,30,4,0], '%': [24,25,2,4,8,19,3,0], '&': [12,18,20,8,21,18,13,0], "'": [4,4,8,0,0,0,0,0],
  '(': [2,4,8,8,8,4,2,0], ')': [8,4,2,2,2,4,8,0], '*': [0,4,21,14,21,4,0,0], '+': [0,4,4,31,4,4,0,0],
  ',': [0,0,0,0,0,4,4,8], '-': [0,0,0,31,0,0,0,0], '.': [0,0,0,0,0,4,4,0], '/': [1,1,2,4,8,16,16,0],
  '0': [14,17,19,21,25,17,14,0], '1': [4,12,4,4,4,4,14,0], '2': [14,17,1,6,8,16,31,0], '3': [31,2,4,6,1,17,14,0],
  '4': [2,6,10,18,31,2,2,0], '5': [31,16,30,1,1,17,14,0], '6': [6,8,16,30,17,17,14,0], '7': [31,1,2,4,8,8,8,0],
  '8': [14,17,17,14,17,17,14,0], '9': [14,17,17,15,1,2,12,0], ':': [0,4,4,0,4,4,0,0], ';': [0,4,4,0,4,4,8,0],
  '<': [2,4,8,16,8,4,2,0], '=': [0,0,31,0,31,0,0,0], '>': [8,4,2,1,2,4,8,0], '?': [14,17,1,2,4,0,4,0],
  '@': [14,17,23,21,23,16,14,0], 'A': [14,17,17,31,17,17,17,0], 'B': [30,17,17,30,17,17,30,0], 'C': [14,17,16,16,16,17,14,0],
  'D': [30,17,17,17,17,17,30,0], 'E': [31,16,16,30,16,16,31,0], 'F': [31,16,16,30,16,16,16,0], 'G': [14,17,16,23,17,17,15,0],
  'H': [17,17,17,31,17,17,17,0], 'I': [14,4,4,4,4,4,14,0], 'J': [7,2,2,2,2,18,12,0], 'K': [17,18,20,24,20,18,17,0],
  'L': [16,16,16,16,16,16,31,0], 'M': [17,27,21,21,17,17,17,0], 'N': [17,25,21,19,17,17,17,0], 'O': [14,17,17,17,17,17,14,0],
  'P': [30,17,17,30,16,16,16,0], 'Q': [14,17,17,17,21,18,13,0], 'R': [30,17,17,30,20,18,17,0], 'S': [15,16,16,14,1,1,30,0],
  'T': [31,4,4,4,4,4,4,0], 'U': [17,17,17,17,17,17,14,0], 'V': [17,17,17,17,17,10,4,0], 'W': [17,17,17,21,21,27,17,0],
  'X': [17,17,10,4,10,17,17,0], 'Y': [17,17,10,4,4,4,4,0], 'Z': [31,1,2,4,8,16,31,0], '_': [0,0,0,0,0,0,31,0],
  'a': [0,0,14,1,15,17,15,0], 'b': [16,16,22,25,17,17,30,0], 'c': [0,0,14,16,16,17,14,0], 'd': [1,1,13,19,17,17,15,0],
  'e': [0,0,14,17,31,16,14,0], 'f': [6,9,8,28,8,8,8,0], 'g': [0,0,15,17,17,15,1,14], 'h': [16,16,22,25,17,17,17,0],
  'i': [4,0,12,4,4,4,14,0], 'j': [2,0,6,2,2,2,18,12], 'k': [16,16,18,20,24,20,18,0], 'l': [12,4,4,4,4,4,14,0],
  'm': [0,0,26,21,21,17,17,0], 'n': [0,0,22,25,17,17,17,0], 'o': [0,0,14,17,17,17,14,0], 'p': [0,0,30,17,17,30,16,16],
  'q': [0,0,13,19,19,15,1,1], 'r': [0,0,22,25,16,16,16,0], 's': [0,0,15,16,14,1,30,0], 't': [8,8,28,8,8,9,6,0],
  'u': [0,0,17,17,17,19,13,0], 'v': [0,0,17,17,17,10,4,0], 'w': [0,0,17,17,21,21,10,0], 'x': [0,0,17,10,4,10,17,0],
  'y': [0,0,17,17,17,15,1,14], 'z': [0,0,31,2,4,8,31,0],
};

function parseHexRGB(hex) {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = parseInt(s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blendRect(sheet, x0, y0, w, h, r, g, b, alpha, radius = 0) {
  const sw = sheet.width, sh = sheet.height, data = sheet.data;
  const xStart = Math.max(0, x0 | 0), yStart = Math.max(0, y0 | 0);
  const xEnd = Math.min(sw, (x0 + w) | 0), yEnd = Math.min(sh, (y0 + h) | 0);
  const invA = 1 - alpha;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      if (radius > 0) {
        const dx = x < x0 + radius ? (x0 + radius - x - 0.5) : (x >= x0 + w - radius ? (x - (x0 + w - radius) + 0.5) : 0);
        const dy = y < y0 + radius ? (y0 + radius - y - 0.5) : (y >= y0 + h - radius ? (y - (y0 + h - radius) + 0.5) : 0);
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      const i = (y * sw + x) * 4;
      data[i]     = (data[i] * invA + r * alpha) | 0;
      data[i + 1] = (data[i + 1] * invA + g * alpha) | 0;
      data[i + 2] = (data[i + 2] * invA + b * alpha) | 0;
    }
  }
}

function drawText(sheet, text, x0, y0, scale, r, g, b) {
  const sw = sheet.width, sh = sheet.height, data = sheet.data;
  let cx = x0 | 0;
  const cy = y0 | 0;
  for (let i = 0; i < text.length; i++) {
    const glyph = FONT_5X8[text[i]] || FONT_5X8['?'];
    for (let row = 0; row < 8; row++) {
      const bits = glyph[row];
      if (!bits) continue;
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          for (let sy = 0; sy < scale; sy++) {
            const py = cy + row * scale + sy;
            if (py < 0 || py >= sh) continue;
            for (let sx = 0; sx < scale; sx++) {
              const px = cx + col * scale + sx;
              if (px < 0 || px >= sw) continue;
              const idx = (py * sw + px) * 4;
              data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function drawAnnotations(sheet, views, panelW, panelH, sheetCols, legendItems) {
  const scale = Math.max(1, Math.round(panelW / 400));
  const charW = 6 * scale, charH = 8 * scale;
  const padX = 5 * scale, padY = 4 * scale;
  const margin = 6 * scale;
  const pillH = charH + 2 * padY;
  const radius = 3 * scale;

  // 1) View name badge in top-left of each panel
  views.forEach((view, vi) => {
    const ox = (vi % sheetCols) * panelW, oy = Math.floor(vi / sheetCols) * panelH;
    const label = view.toUpperCase();
    const tw = label.length * charW - scale;
    const pw = tw + 2 * padX;
    blendRect(sheet, ox + margin, oy + margin, pw, pillH, 24, 28, 36, 0.78, radius);
    drawText(sheet, label, ox + margin + padX, oy + margin + padY, scale, 248, 250, 252);
  });

  // 2) Colour mode legend pills at bottom-left of the sheet
  if (legendItems.length > 0) {
    const swatchSize = 6 * scale;
    const swatchGap = 3 * scale;
    const itemPadX = 4 * scale;
    const itemGap = 3 * scale;
    const rows = [[]];
    let curX = margin;
    const maxW = sheet.width - margin;
    for (const item of legendItems) {
      const tw = item.label.length * charW - scale;
      const iw = itemPadX + swatchSize + swatchGap + tw + itemPadX;
      if (curX + iw > maxW && rows[rows.length - 1].length > 0) {
        rows.push([]);
        curX = margin;
      }
      rows[rows.length - 1].push({ ...item, iw });
      curX += iw + itemGap;
    }
    const totalRows = rows.length;
    rows.forEach((row, ri) => {
      const ry = sheet.height - margin - (totalRows - ri) * pillH - (totalRows - 1 - ri) * itemGap;
      let rx = margin;
      for (const item of row) {
        blendRect(sheet, rx, ry, item.iw, pillH, 24, 28, 36, 0.78, radius);
        const [cr, cg, cb] = parseHexRGB(item.color);
        const sx = rx + itemPadX, sy = ry + Math.round((pillH - swatchSize) / 2);
        blendRect(sheet, sx - 1, sy - 1, swatchSize + 2, swatchSize + 2, 240, 240, 245, 0.9, scale);
        blendRect(sheet, sx, sy, swatchSize, swatchSize, cr, cg, cb, 1.0, Math.max(0, scale - 1));
        drawText(sheet, item.label, sx + swatchSize + swatchGap, ry + padY, scale, 248, 250, 252);
        rx += item.iw + itemGap;
      }
    });
  }
}

async function main() {
  const [input, output] = positionals;

  // Detect .bgcode ('GCDE' magic) and decode via libbgcode CLI if needed
  const magicBuf = Buffer.alloc(4);
  const checkFd = fs.openSync(input, 'r');
  try {
    fs.readSync(checkFd, magicBuf, 0, 4, 0);
  } finally {
    fs.closeSync(checkFd);
  }

  let tmpDir = null;
  let gcodePath = input;
  if (magicBuf.toString('ascii') === 'GCDE') {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-sheet-'));
    const tmpBgcode = path.join(tmpDir, 'part.bgcode');
    const tmpGcode = path.join(tmpDir, 'part.gcode');
    fs.symlinkSync(path.resolve(input), tmpBgcode);
    const bgcodeBin = process.env.BGCODE_BIN || 'bgcode';
    try {
      execFileSync(bgcodeBin, [tmpBgcode], { stdio: 'pipe' });
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Failed to decode .bgcode using '${bgcodeBin}': ${err.stderr?.toString() || err.message}`);
    }
    try { fs.unlinkSync(tmpBgcode); } catch {}
    gcodePath = tmpGcode;
  }

  const stat = fs.statSync(gcodePath);
  const shell = values.detail === 'shell' || (values.detail === 'auto' && stat.size > 9e6);
  const arcTol = values['arc-tol'] ? Number(values['arc-tol']) : 0.05;
  const defaultWidth = Number(values['extrusion-width']);
  const defaultHeight = Number(values['layer-height']);
  const [amb, dirL, bri] = values.light.split(',').map(Number);
  const rawToolColors = values['tool-colors'].split(',').map(s => s.trim()).filter(Boolean);
  const numUserToolColors = Math.max(1, rawToolColors.length);
  const palette = byFeature ? FEATURE_GROUPS.map(g => g[2]) : [...rawToolColors];
  while (palette.length < 8) palette.push('#888888');

  const documentStub = { addEventListener() {}, removeEventListener() {} };
  globalThis.self = globalThis;
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = documentStub;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: { getItem() { return null; }, setItem() {}, removeItem() {} } });
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  console.debug = () => {};
  console.info = (...a) => console.error(...a);
  const _warn = console.warn; console.warn = (...a) => { if (!String(a[0]).includes('WEBGL_multi_draw')) _warn(...a); };

  const nativeGL = await import('webgl-node');
  for (const [k, v] of Object.entries(nativeGL)) if (k.startsWith('WebGL')) globalThis[k] = v;
  const {
    Vector3, BufferGeometry, BufferAttribute, Mesh, LineSegments, Scene, Group, Color,
    ShaderMaterial, WebGLRenderer, OrthographicCamera, Euler, Sphere, Box3
  } = await import('three');
  const { PNG } = await import('pngjs');

  const context = nativeGL.createWebGL2Context(panelW, panelH);
  const { canvas, gl } = context;
  Object.assign(canvas, { offsetWidth: panelW, offsetHeight: panelH, ownerDocument: documentStub,
    getRootNode() { return documentStub; } });

  const mem = (tag) => { if (process.env.DBG) { const m = process.memoryUsage(); console.error('MEM', tag, 'rss', (m.rss/1e6)|0, 'heap', (m.heapUsed/1e6)|0, 'ab', (m.arrayBuffers/1e6)|0); } };

  const renderer = new WebGLRenderer({ canvas, preserveDrawingBuffer: false });
  renderer.setPixelRatio(1);
  renderer.setSize(panelW, panelH, false);
  renderer.debug.onShaderError = (c, p) => { throw new Error('shader: ' + c.getProgramInfoLog(p)); };

  const scene = new Scene();
  scene.background = new Color(values.background);
  const extrusionsGroup = new Group();
  extrusionsGroup.quaternion.setFromEuler(new Euler(-Math.PI / 2, 0, 0));
  scene.add(extrusionsGroup);

  const camera = new OrthographicCamera(1e8, 1e8 + 1, 1e8 + 1, 1e8, 0.01, 10);
  const DIRS = { iso: [1, 0.85, 1], top: [0, 1, 0.0001], front: [0, 0.35, 1], right: [1, 0.35, 0], first: [0, 1, 0.0001], bottom: [0, -1, 0.0001] };

  const makeViewTracker = (view) => {
    const dir = DIRS[view]; if (!dir) throw new Error('unknown view ' + view);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, 0).addScaledVector(new Vector3(...dir).normalize(), 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const m = camera.matrixWorldInverse.elements;
    return {
      view,
      isFirst: view === 'first',
      ux0: m[0], ux1: m[4], ux2: m[8],
      uy0: m[1], uy1: m[5], uy2: m[9],
      minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9,
      pts: new Float32Array(12),
      hasPoints: false,
    };
  };
  const viewTrackers = views.map(makeViewTracker);
  const fallbackTrackers = views.map(makeViewTracker);

  camera.position.set(0, 400, 400);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  const materials = [];
  const getMaterial = (toolIdx) => {
    if (!materials[toolIdx]) {
      const col = new Color(palette[toolIdx] ?? palette[palette.length - 1]);
      materials[toolIdx] = new ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: {
          uColor: { value: col },
          ambient: { value: values.lines ? 1.0 : amb },
          directional: { value: values.lines ? 0.0 : dirL },
          brightness: { value: values.lines ? 1.0 : bri },
          clipMinY: { value: -1e9 },
          clipMaxY: { value: 1e9 },
        },
      });
    }
    return materials[toolIdx];
  };

  const meshes = [];
  const dummyBox = new Box3(new Vector3(-1e4, -1e4, -1e4), new Vector3(1e4, 1e4, 1e4));
  const dummySphere = new Sphere(new Vector3(0, 0, 0), 1e5);

  const uploadChunk = (builder) => {
    const vc = builder.vertCount;
    const ic = builder.idxCount;
    const geom = new BufferGeometry();
    const posSub = builder.pos.subarray(0, vc * 3);
    const normSub = builder.norm.subarray(0, vc * 3);
    const idxSub = builder.idx.subarray(0, ic);

    const posAttr = new BufferAttribute(posSub, 3);
    const normAttr = new BufferAttribute(normSub, 3, useInt8Normals);
    const idxAttr = new BufferAttribute(idxSub, 1);

    geom.setAttribute('position', posAttr);
    geom.setAttribute('normal', normAttr);
    geom.setIndex(idxAttr);
    geom.boundingBox = dummyBox;
    geom.boundingSphere = dummySphere;

    const obj = builder.isLines ? new LineSegments(geom, builder.material) : new Mesh(geom, builder.material);
    obj.frustumCulled = false;
    obj.userData.minZ = builder.minZ;
    obj.userData.maxZ = builder.maxZ;
    extrusionsGroup.add(obj);
    meshes.push(obj);

    for (let i = 0; i < meshes.length - 1; i++) meshes[i].visible = false;
    obj.visible = true;
    geom.setDrawRange(0, builder.isLines ? 2 : 3);
    renderer.render(scene, camera);
    geom.setDrawRange(0, Infinity);
    if (process.env.NO_FREE !== '1') {
      posAttr.array = EMPTY_F32; posAttr.count = vc;
      normAttr.array = useInt8Normals ? EMPTY_I8 : EMPTY_F32; normAttr.count = vc;
      idxAttr.array = EMPTY_U16; idxAttr.count = ic;
    }
  };

  const builders = new Map();
  const getBuilder = (toolIdx) => {
    let b = builders.get(toolIdx);
    if (!b) {
      b = new ToolChunkBuilder(toolIdx, getMaterial(toolIdx), values.lines, uploadChunk);
      builders.set(toolIdx, b);
    }
    return b;
  };

  try {
    mem('before-parse');

    let stateX = 0, stateY = 0, stateZ = 0, stateE = 0;
    let shiftX = 0, shiftY = 0, shiftZ = 0;
    let relE = false;
    let relXYZ = false;
    let unitScale = 1;
    let physTool = 0;
    let featureIdx = 0;
    let extWidth = defaultWidth;
    let lineHeight = defaultHeight;
    let inStart = !values['include-start'] && hasLayerMarkers(gcodePath);
    let inInterior = false;
    let inWipeTower = false;
    let layer = 0;
    let inLayerChangeHeader = false;
    const layerZs = [];
    const featuresSeen = new Set();
    const toolsSeen = new Set();

    let pathCap = 8192;
    let pathPts = new Float64Array(pathCap * 3);
    let pathLen = 0;
    let pathColorIdx = 0;
    let pathPhysTool = 0;
    let pathWidth = defaultWidth;
    let pathHeight = defaultHeight;
    let inExtrusionPath = false;

    let mnX = 1e9, mnY = 1e9, mnZ = 1e9;
    let mxX = -1e9, mxY = -1e9, mxZ = -1e9;
    let allMnX = 1e9, allMnY = 1e9, allMnZ = 1e9;
    let allMxX = -1e9, allMxY = -1e9, allMxZ = -1e9;

    const updateTrackers = (trackers, X, Y, Z, zMaxFirst) => {
      for (let i = 0; i < trackers.length; i++) {
        const tr = trackers[i];
        if (tr.isFirst && Y > zMaxFirst) continue;
        const dx = tr.ux0 * X + tr.ux1 * Y + tr.ux2 * Z;
        const dy = tr.uy0 * X + tr.uy1 * Y + tr.uy2 * Z;
        const p = tr.pts;
        tr.hasPoints = true;
        if (dx < tr.minX) { tr.minX = dx; p[0] = X; p[1] = Y; p[2] = Z; }
        if (dx > tr.maxX) { tr.maxX = dx; p[3] = X; p[4] = Y; p[5] = Z; }
        if (dy < tr.minY) { tr.minY = dy; p[6] = X; p[7] = Y; p[8] = Z; }
        if (dy > tr.maxY) { tr.maxY = dy; p[9] = X; p[10] = Y; p[11] = Z; }
      }
    };

    const recordFitPoint = (gx, gy, gz) => {
      if (gx < allMnX) allMnX = gx; if (gx > allMxX) allMxX = gx;
      if (gy < allMnY) allMnY = gy; if (gy > allMxY) allMxY = gy;
      if (gz < allMnZ) allMnZ = gz; if (gz > allMxZ) allMxZ = gz;

      const X = Math.fround(gx), Y = Math.fround(gz), Z = Math.fround(-gy);
      const zFirst = (layerZs.length > 0 && Number.isFinite(layerZs[0]) ? layerZs[0] : allMnZ) + 1e-3;
      updateTrackers(fallbackTrackers, X, Y, Z, zFirst);

      if (inWipeTower && !values['include-wipe-tower']) return;
      if (gx < mnX) mnX = gx; if (gx > mxX) mxX = gx;
      if (gy < mnY) mnY = gy; if (gy > mxY) mxY = gy;
      if (gz < mnZ) mnZ = gz; if (gz > mxZ) mxZ = gz;

      updateTrackers(viewTrackers, X, Y, Z, zFirst);
    };

    const pushPathPoint = (gx, gy, gz) => {
      if (pathLen >= pathCap) {
        pathCap <<= 1;
        const next = new Float64Array(pathCap * 3);
        next.set(pathPts);
        pathPts = next;
      }
      const i3 = pathLen * 3;
      pathPts[i3] = gx; pathPts[i3 + 1] = gy; pathPts[i3 + 2] = gz;
      pathLen++;
      recordFitPoint(gx, gy, gz);
    };

    const finishExtrusionPath = () => {
      if (inExtrusionPath && pathLen >= 2) {
        toolsSeen.add(pathPhysTool);
        if (byFeature) featuresSeen.add(pathColorIdx);
        getBuilder(pathColorIdx).addPath(pathPts, pathLen, pathWidth, pathHeight);
      }
      inExtrusionPath = false;
      pathLen = 0;
    };

    const ensureExtrusionPath = () => {
      const colorIdx = byFeature ? featureIdx : physTool;
      // Slot changes must be recorded even when the feature colour stays the same.
      if (!inExtrusionPath || pathColorIdx !== colorIdx || pathPhysTool !== physTool || pathWidth !== extWidth || pathHeight !== lineHeight) {
        finishExtrusionPath();
        inExtrusionPath = true;
        pathColorIdx = colorIdx;
        pathPhysTool = physTool;
        pathWidth = extWidth;
        pathHeight = lineHeight;
        pushPathPoint(stateX, stateY, stateZ);
      }
      if (layer > 0 && Number.isNaN(layerZs[layer - 1])) {
        layerZs[layer - 1] = stateZ;
      }
    };

    const applyExtrusion = (eVal) => {
      if (eVal !== eVal) return 0;
      if (relE) {
        stateE += eVal;
        return eVal;
      }
      const d = eVal - stateE;
      stateE = eVal;
      return d;
    };

    const MAX_ARC_ANGLE = Math.PI / 8;
    const tessellateArc = (cw, tx, ty, tz, iOff, jOff, rVal) => {
      const sx = stateX, sy = stateY, sz = stateZ;
      let r = iOff !== iOff ? 0 : iOff;
      let a = jOff !== jOff ? 0 : jOff;
      let u = false;
      if (rVal === rVal && rVal !== 0) {
        const D = tx - sx, Y = ty - sy;
        const A = Math.sqrt((D * D + Y * Y) * 0.25);
        const rad = Math.max(Math.abs(rVal), A);
        const C = D * D + Y * Y;
        const T = rad * rad - C * 0.25;
        if (C === 0) u = true;
        else {
          let F = Math.sqrt(Math.max(0, T / C));
          if (!cw) F = -F;
          if (rVal < 0) F = -F;
          r = D * 0.5 + Y * F;
          a = Y * 0.5 - D * F;
        }
      }
      const fullCircle = (sx === tx && sy === ty);
      const cx = sx + r, cy = sy + a;
      const g = Math.sqrt(r * r + a * a);
      const y = Math.atan2(-a, -r);
      const b = Math.atan2(ty - cy, tx - cx);
      let x;
      if (fullCircle) x = 2 * Math.PI;
      else {
        x = cw ? y - b : b - y;
        if (x < 0) x += 2 * Math.PI;
      }
      const S = 2 * Math.acos(Math.max(1 - arcTol / g, -1));
      const w = Math.min(S, MAX_ARC_ANGLE);
      let steps = x / w;
      if (steps < 1) steps = 1;
      let P = (x / steps) * (cw ? -1 : 1);
      const Z = (tz - sz) / steps;
      let L = sz, W = y;
      if (!u && g > 0 && Number.isFinite(steps)) {
        for (let D = 0; D < steps - 1; D++) {
          W += P;
          L += Z;
          pushPathPoint(cx + g * Math.cos(W), cy + g * Math.sin(W), L);
        }
      }
      pushPathPoint(tx, ty, tz);
    };

    const parseLineSlice = (str, start, end) => {
      while (start < end && str.charCodeAt(start) <= 32) start++;
      if (start >= end) return;
      const c0 = str.charCodeAt(start);

      if (c0 === 59) {
        const len = end - start;
        if (isLayerMarker(str, start, end)) {
          finishExtrusionPath();
          inStart = false;
          inWipeTower = false;
          layer++;
          layerZs.push(NaN);
          inLayerChangeHeader = true;
          return;
        }
        if (inLayerChangeHeader && len > 3 && str.startsWith(';Z:', start)) {
          const z = parseFastFloat(str, start + 3, end);
          if (z === z && layerZs.length > 0) layerZs[layerZs.length - 1] = z;
          return;
        }
        if (len > 8 && str.startsWith(';HEIGHT:', start)) {
          const h = parseFastFloat(str, start + 8, end);
          if (h > 0) lineHeight = h;
          return;
        }
        if (len > 7 && str.startsWith(';WIDTH:', start)) {
          const w = parseFastFloat(str, start + 7, end);
          if (w > 0) extWidth = w;
          return;
        }
        if (len > 6 && str.startsWith(';TYPE:', start)) {
          inLayerChangeHeader = false;
          const t = str.slice(start + 6, end).trim();
          inInterior = shell && layer > 1 && INTERIOR.has(t);
          inWipeTower = (t === 'Wipe tower');
          if (byFeature) {
            featureIdx = TYPE_TO_TOOL.has(t) ? TYPE_TO_TOOL.get(t) : 7;
          }
          return;
        }
        return;
      }

      if (c0 === 77 && end - start >= 4 && str.charCodeAt(start + 1) === 55 && str.charCodeAt(start + 2) === 51 && str.charCodeAt(start + 3) === 32) {
        return;
      }

      let cmdEnd = end;
      for (let i = start; i < end; i++) {
        if (str.charCodeAt(i) === 59) { cmdEnd = i; break; }
      }
      let pos = start;
      while (pos < cmdEnd && str.charCodeAt(pos) <= 32) pos++;
      if (pos >= cmdEnd) return;

      const firstChar = str.charCodeAt(pos) | 32;
      pos++;
      const numStart = pos;
      while (pos < cmdEnd) {
        const ch = str.charCodeAt(pos);
        if ((ch >= 48 && ch <= 57) || ch === 46) pos++;
        else break;
      }
      if (pos === numStart) return;
      const cmdNum = parseFastFloat(str, numStart, pos);

      if (firstChar === 103 && (cmdNum === 0 || cmdNum === 1 || cmdNum === 2 || cmdNum === 3)) {
        inLayerChangeHeader = false;
        let px = NaN, py = NaN, pz = NaN, pe = NaN, pi = NaN, pj = NaN, pr = NaN;
        while (pos < cmdEnd) {
          const ch = str.charCodeAt(pos) | 32;
          if (ch >= 97 && ch <= 122) {
            pos++;
            const vStart = pos;
            while (pos < cmdEnd) {
              const vc = str.charCodeAt(pos);
              if ((vc >= 97 && vc <= 122) || (vc >= 65 && vc <= 90)) break;
              pos++;
            }
            if (ch === 120) px = parseFastFloat(str, vStart, pos);
            else if (ch === 121) py = parseFastFloat(str, vStart, pos);
            else if (ch === 122) pz = parseFastFloat(str, vStart, pos);
            else if (ch === 101) pe = parseFastFloat(str, vStart, pos);
            else if (ch === 105) pi = parseFastFloat(str, vStart, pos);
            else if (ch === 106) pj = parseFastFloat(str, vStart, pos);
            else if (ch === 114) pr = parseFastFloat(str, vStart, pos);
          } else {
            pos++;
          }
        }

        // Keep machine/extruder state even when the path is hidden.
        const dE = applyExtrusion(pe * unitScale);
        const isArc = cmdNum === 2 || cmdNum === 3;
        const hasArc = isArc && (pi === pi || pj === pj || pr === pr);
        if (px !== px && py !== py && pz !== pz && !hasArc) {
          finishExtrusionPath();
          return;
        }

        const nx = px !== px ? stateX : px * unitScale + (relXYZ ? stateX : shiftX);
        const ny = py !== py ? stateY : py * unitScale + (relXYZ ? stateY : shiftY);
        const nz = pz !== pz ? stateZ : pz * unitScale + (relXYZ ? stateZ : shiftZ);
        const isExt = dE > 0 && !inStart && !inInterior;

        if (cmdNum === 0 || cmdNum === 1) {
          if (isExt) {
            ensureExtrusionPath();
            stateX = nx; stateY = ny; stateZ = nz;
            pushPathPoint(nx, ny, nz);
          } else {
            finishExtrusionPath();
            stateX = nx; stateY = ny; stateZ = nz;
          }
        } else {
          if (isExt) {
            ensureExtrusionPath();
            tessellateArc(cmdNum === 2, nx, ny, nz, pi * unitScale, pj * unitScale, pr * unitScale);
            stateX = nx; stateY = ny; stateZ = nz;
          } else {
            finishExtrusionPath();
            stateX = nx; stateY = ny; stateZ = nz;
          }
        }
        return;
      }

      if (firstChar === 116) {
        if (cmdNum >= 0 && cmdNum <= 7) {
          physTool = cmdNum | 0;
        }
        return;
      }

      if (firstChar === 109) {
        if (cmdNum === 82) relE = false;
        else if (cmdNum === 83) relE = true;
        else if (cmdNum === 600 && !inStart) {
          let explicitT = NaN;
          while (pos < cmdEnd) {
            const ch = str.charCodeAt(pos) | 32;
            if (ch >= 97 && ch <= 122) {
              pos++;
              const vStart = pos;
              while (pos < cmdEnd) {
                const vc = str.charCodeAt(pos);
                if ((vc >= 97 && vc <= 122) || (vc >= 65 && vc <= 90)) break;
                pos++;
              }
              if (ch === 116) explicitT = parseFastFloat(str, vStart, pos);
            } else pos++;
          }
          if (explicitT >= 0 && explicitT <= 7) physTool = explicitT | 0;
          else physTool = (physTool + 1) % numUserToolColors;
        }
        return;
      }

      if (firstChar === 103) {
        if (cmdNum === 20) unitScale = 25.4;
        else if (cmdNum === 21) unitScale = 1;
        else if (cmdNum === 90) relXYZ = false;
        else if (cmdNum === 91) relXYZ = true;
        else if (cmdNum === 28) {
          finishExtrusionPath();
          stateX = 0; stateY = 0; stateZ = 0;
        } else if (cmdNum === 92) {
          let px = NaN, py = NaN, pz = NaN, pe = NaN, anyParam = false;
          while (pos < cmdEnd) {
            const ch = str.charCodeAt(pos) | 32;
            if (ch >= 97 && ch <= 122) {
              pos++;
              const vStart = pos;
              while (pos < cmdEnd) {
                const vc = str.charCodeAt(pos);
                if ((vc >= 97 && vc <= 122) || (vc >= 65 && vc <= 90)) break;
                pos++;
              }
              const val = parseFastFloat(str, vStart, pos);
              if (val === val) {
                anyParam = true;
                if (ch === 120) px = val;
                else if (ch === 121) py = val;
                else if (ch === 122) pz = val;
                else if (ch === 101) pe = val;
              }
            } else pos++;
          }
          if (!anyParam) {
            shiftX = stateX; shiftY = stateY; shiftZ = stateZ; stateE = 0;
          } else {
            if (px === px) shiftX = stateX - px * unitScale;
            if (py === py) shiftY = stateY - py * unitScale;
            if (pz === pz) shiftZ = stateZ - pz * unitScale;
            if (pe === pe) stateE = pe * unitScale;
          }
        } else if (cmdNum === 92.1) {
          shiftX = 0; shiftY = 0; shiftZ = 0;
        }
      }
    };

    try {
      visitGcodeLines(gcodePath, parseLineSlice);
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        tmpDir = null;
      }
    }

    finishExtrusionPath();
    pathPts = null;
    for (const b of builders.values()) {
      b.flush();
      b.releaseScratch();
    }

    mem('after-build');

    if (meshes.length === 0) throw new Error('No extrusion paths found.');
    let activeTrackers = viewTrackers;
    if (mnX > mxX) {
      mnX = allMnX; mnY = allMnY; mnZ = allMnZ;
      mxX = allMxX; mxY = allMxY; mxZ = allMxZ;
      activeTrackers = fallbackTrackers;
    }

    const tools = [...toolsSeen].sort((a, b) => a - b);
    const nLayers = layerZs.length || 1;
    const firstLayerZ = Number.isFinite(layerZs[0]) ? layerZs[0] : mnZ;
    const mn = [mnX, mnY, mnZ], mx = [mxX, mxY, mxZ];

    const sheetCols = Math.min(views.length, 2), sheetRows = Math.ceil(views.length / sheetCols);
    const sheet = new PNG({ width: panelW * sheetCols, height: panelH * sheetRows });
    sheet.data.fill(255);
    const cut = values['end-layer'] ? parseInt(values['end-layer'], 10) : undefined;
    const rgba = new Uint8Array(panelW * panelH * 4);

    views.forEach((view, vi) => {
      const dir = DIRS[view]; if (!dir) throw new Error('unknown view ' + view);
      const isFirst = view === 'first';
      const endL = isFirst ? 1 : cut;
      const clipMaxY = (endL !== undefined && endL < nLayers && Number.isFinite(layerZs[endL - 1]))
        ? layerZs[endL - 1]
        : 1e9;
      for (const mat of materials) {
        if (mat) mat.uniforms.clipMaxY.value = clipMaxY;
      }
      for (const m of meshes) {
        m.visible = m.userData.minZ <= clipMaxY + 1e-3;
      }

      const zTop = isFirst ? firstLayerZ : mx[2];
      const lo = [mn[0], mn[2], -mx[1]], hi = [mx[0], zTop, -mn[1]];
      const center = new Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      const pad = 1;
      const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 4 * pad;
      camera.up.set(0, 1, 0);
      camera.position.copy(center).addScaledVector(new Vector3(...dir).normalize(), 2 * diag);
      camera.lookAt(center);
      camera.near = 0.01; camera.far = 4 * diag; camera.updateMatrixWorld(true);

      const m = camera.matrixWorldInverse.elements;
      let tr = activeTrackers[vi];
      if (!tr.hasPoints) tr = fallbackTrackers[vi];
      const p = tr.pts;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < 12; i += 3) {
        const X = p[i], Y = p[i + 1], Z = p[i + 2];
        const cx = m[0] * X + m[4] * Y + m[8] * Z + m[12], cy = m[1] * X + m[5] * Y + m[9] * Z + m[13];
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      }
      const aspect = panelW / panelH;
      const mx_ = (x0 + x1) / 2, my_ = (y0 + y1) / 2;
      const half = Math.max((y1 - y0) / 2 + pad, ((x1 - x0) / 2 + pad) / aspect) * 1.06;
      camera.left = mx_ - half * aspect; camera.right = mx_ + half * aspect; camera.top = my_ + half; camera.bottom = my_ - half;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);

      gl.readPixels(0, 0, panelW, panelH, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      const err = gl.getError(); if (err) throw new Error('GL error 0x' + err.toString(16));
      const ox = (vi % sheetCols) * panelW, oy = Math.floor(vi / sheetCols) * panelH;
      for (let y = 0; y < panelH; y++) {
        const src = rgba.subarray((panelH - 1 - y) * panelW * 4, (panelH - y) * panelW * 4);
        sheet.data.set(src, ((oy + y) * sheet.width + ox) * 4);
      }
    });

    const sortedFeatures = [...featuresSeen].sort((a, b) => a - b);
    const legendItems = byFeature
      ? sortedFeatures.map(i => ({ label: FEATURE_GROUPS[i][0], color: FEATURE_GROUPS[i][2] }))
      : tools.map(t => ({ label: `T${t}`, color: palette[t] }));

    if (!values['no-labels']) {
      drawAnnotations(sheet, views, panelW, panelH, sheetCols, legendItems);
    }

    fs.writeFileSync(output, PNG.sync.write(sheet));
    console.log(JSON.stringify({
      output,
      views,
      layers: nLayers,
      tools,
      detail: shell ? 'shell (interior features hidden above layer 1)' : 'full',
      colorBy: byFeature ? 'feature' : 'tool',
      legend: legendItems.map(item => `${item.label}=${item.color}`),
      bbox_mm: {
        x: [mn[0], mx[0]].map(n => +n.toFixed(2)),
        y: [mn[1], mx[1]].map(n => +n.toFixed(2)),
        z: [mn[2], mx[2]].map(n => +n.toFixed(2)),
      },
    }));
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    try {
      for (const m of meshes) m.geometry.dispose();
      for (const mat of materials) if (mat) mat.dispose();
      renderer.dispose();
    } finally {
      context.destroy();
    }
  }
}
main().catch(e => { console.error('gcode-sheet: ' + (e.stack || e.message)); process.exitCode = 1; });
