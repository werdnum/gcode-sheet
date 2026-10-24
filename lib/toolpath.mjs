// lib/toolpath.mjs: Shared streaming G-code / .bgcode reader and toolpath loader
// consumed by gcode-sheet, gcode-collide, and gcode-sequence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const POW10 = [
  1, 1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9,
  1e-10, 1e-11, 1e-12, 1e-13, 1e-14, 1e-15,
];


// --- Firmware object labels (M486), as PrusaSlicer writes them for "firmware-specific" label
// objects: `M486 S<n>` starts printing object n, `M486 A<name>` names the object of the
// preceding `M486 S<n>`, `M486 S-1` stops. Names come from M486 A, else from the
// `; objects_info = {"objects":[{"name":...}]}` header. They produce the same onObjectStart /
// onObjectStop events as the `; printing object` comments. An `S<n>` whose name is not yet
// known waits for its `A` (the declaration block lists S, A, S-1 per object).
function noteObjectsInfo(json, st) {
  try {
    st.m486.infoNames = (JSON.parse(json).objects || []).map(o => (o && o.name ? String(o.name) : null));
  } catch {
    // malformed header: names then come from M486 A only
  }
}

function m486Start(name, lineNo, rawLine, st, callbacks) {
  st.hasObjectLabels = true;
  st.currentObject = name;
  st.seenExtrusionInObjectBlock = false;
  callbacks.onObjectStart?.(lineNo, name, rawLine, st);
}

function handleM486Label(str, pos, cmdEnd, lineNo, rawLine, st, callbacks) {
  while (pos < cmdEnd && str.charCodeAt(pos) <= 32) pos++;
  const letter = str.charCodeAt(pos) | 32;
  const arg = str.slice(pos + 1, cmdEnd).trim();
  const m = st.m486;
  const nameOf = (n) => m.names.get(n) ?? m.infoNames[n] ?? null;
  if (letter === 97 && arg) { // 'A': the first name seen for an id wins
    const id = m.pending ?? m.last;
    if (id === undefined) return;
    if (!nameOf(id)) m.names.set(id, arg);
    if (m.pending !== null) {
      m.pending = null;
      m486Start(nameOf(id), lineNo, rawLine, st, callbacks);
    }
  } else if (letter === 115) { // 'S'
    const n = parseInt(arg, 10);
    if (!Number.isFinite(n)) return;
    m.pending = null;
    if (st.currentObject !== null) {
      const prev = st.currentObject;
      st.currentObject = null;
      st.seenExtrusionInObjectBlock = false;
      callbacks.onObjectStop?.(lineNo, prev, rawLine, st);
    }
    if (n < 0) return;
    m.last = n;
    if (nameOf(n)) m486Start(nameOf(n), lineNo, rawLine, st, callbacks); else m.pending = n;
  }
}

// An unnamed `M486 S<n>` followed by anything but its `M486 A`: name it 'object <n>'.
function flushM486Pending(lineNo, rawLine, st, callbacks) {
  const n = st.m486.pending;
  st.m486.pending = null;
  st.m486.names.set(n, `object ${n}`);
  m486Start(`object ${n}`, lineNo, rawLine, st, callbacks);
}

export const MAX_ARC_ANGLE = Math.PI / 8;

export function parseFastFloat(str, start, end) {
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
export function visitGcodeLines(file, visit) {
  const fd = fs.openSync(file, 'r');
  const readBuf = Buffer.allocUnsafe(256 * 1024);
  let leftover = '';
  let lineNo = 0;
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, readBuf, 0, readBuf.length, null)) > 0) {
      const chunk = leftover + readBuf.toString('latin1', 0, bytesRead);
      let start = 0;
      let nl = chunk.indexOf('\n');
      while (nl !== -1) {
        let end = nl;
        if (end > start && chunk.charCodeAt(end - 1) === 13) end--;
        lineNo++;
        if (visit(chunk, start, end, lineNo) === false) return;
        start = nl + 1;
        nl = chunk.indexOf('\n', start);
      }
      leftover = chunk.slice(start);
    }
    if (leftover.length) {
      let end = leftover.length;
      if (end > 0 && leftover.charCodeAt(end - 1) === 13) end--;
      lineNo++;
      visit(leftover, 0, end, lineNo);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function visitGcodeTextLines(text, visit) {
  let start = 0;
  let lineNo = 0;
  const len = text.length;
  while (start < len) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = len;
    let end = nl;
    if (end > start && text.charCodeAt(end - 1) === 13) end--;
    lineNo++;
    if (visit(text, start, end, lineNo) === false) return;
    start = nl + 1;
  }
}

// Same semantics as the pre-refactor gcode-sheet predicate: `;LAYER_CHANGE` followed only
// by whitespace, or `;LAYER:<integer>` followed only by whitespace.
export function isLayerMarker(str, start, end) {
  while (start < end && str.charCodeAt(start) <= 32) start++;
  return (str.startsWith(';LAYER_CHANGE', start) &&
      str.slice(start + 13, end).trim() === '') ||
    (str.startsWith(';LAYER:', start) &&
      /^\d+\s*$/.test(str.slice(start + 7, end)));
}

export function hasLayerMarkers(file) {
  let found = false;
  visitGcodeLines(file, (str, start, end) => {
    if (isLayerMarker(str, start, end)) {
      found = true;
      return false;
    }
  });
  return found;
}

export function hasLayerMarkersInText(text) {
  let found = false;
  visitGcodeTextLines(text, (str, start, end) => {
    if (isLayerMarker(str, start, end)) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * Decode a .bgcode file (using libbgcode's `bgcode` CLI) or return a .gcode path directly.
 * Returns `{ gcodePath, cleanup }`.
 */
export function openGcodeFile(input) {
  const fd = fs.openSync(input, 'r');
  const magicBuf = Buffer.alloc(4);
  try {
    fs.readSync(fd, magicBuf, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (magicBuf.toString('ascii') === 'GCDE') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-sheet-'));
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
    return {
      gcodePath: tmpGcode,
      cleanup: () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      },
    };
  }

  return {
    gcodePath: input,
    cleanup: () => {},
  };
}

/**
 * Tessellate a G2/G3 arc from (sx, sy, sz) to (tx, ty, tz) using I/J or signed R,
 * invoking `onPoint(x, y, z)` for each intermediate and final point along the arc.
 */
export function tessellateArcPoints(cw, sx, sy, sz, tx, ty, tz, iOff, jOff, rVal, arcTol, onPoint) {
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
  const P = (x / steps) * (cw ? -1 : 1);
  const Z = (tz - sz) / steps;
  let L = sz, W = y;
  if (!u && g > 0 && Number.isFinite(steps)) {
    for (let D = 0; D < steps - 1; D++) {
      W += P;
      L += Z;
      onPoint(cx + g * Math.cos(W), cy + g * Math.sin(W), L);
    }
  }
  onPoint(tx, ty, tz);
}

/**
 * Shared streaming G-code state machine used by both `gcode-sheet` (for zero-allocation
 * 3D rendering) and `loadToolpath` (for Phase 1 collision checking and Phase 2 sequencing).
 */
export function walkGcode(source, options = {}, callbacks = {}) {
  const {
    isText = false,
    includeStart = false,
    defaultWidth = 0.45,
    defaultHeight = 0.2,
    numUserToolColors = 5,
    endLineLimit = Infinity,
    captureRawLines = false,
  } = options;

  // The pre-scan only matters for skipping the start block; with includeStart it is skipped
  // and `hasMarkers` stays null (unknown) - callers that walk the whole file can derive it
  // from `layerZs.length` instead.
  const hasMarkers = includeStart ? null
    : (isText ? hasLayerMarkersInText(source) : hasLayerMarkers(source));
  const st = {
    hasMarkers,
    inStart: !includeStart && hasMarkers,
    x: 0,
    y: 0,
    z: 0,
    e: 0,
    shiftX: 0,
    shiftY: 0,
    shiftZ: 0,
    relE: false,
    relXYZ: false,
    unitScale: 1,
    physTool: 0,
    extWidth: defaultWidth,
    lineHeight: defaultHeight,
    feedrate: 0,
    featureType: 'Custom',
    currentObject: null,
    seenExtrusionInObjectBlock: false,
    hasObjectLabels: false,
    m486: { names: new Map(), infoNames: [], pending: null }, // see handleM486Label
    layer: 0,
    inLayerChangeHeader: false,
    layerZs: [],
    filamentColours: [],
    fan: 0,
    hotendTemp: null,
    hotendWait: false,
    bedTemp: null,
    bedWait: false,
    accel: '',
    flow: 100,
  };

  let currentStateSnapshot = {
    fan: 0,
    hotendTemp: null,
    hotendWait: false,
    bedTemp: null,
    bedWait: false,
    accel: '',
    flow: 100,
    tool: 0,
  };

  const refreshStateSnapshot = () => {
    currentStateSnapshot = {
      fan: st.fan,
      hotendTemp: st.hotendTemp,
      hotendWait: st.hotendWait,
      bedTemp: st.bedTemp,
      bedWait: st.bedWait,
      accel: st.accel,
      flow: st.flow,
      tool: st.physTool,
    };
  };

  const applyExtrusion = (eVal) => {
    if (eVal !== eVal) return 0;
    if (st.relE) {
      st.e += eVal;
      return eVal;
    }
    const d = eVal - st.e;
    st.e = eVal;
    return d;
  };

  const getLayerZ = () => {
    if (st.layer > 0 && Number.isFinite(st.layerZs[st.layer - 1])) return st.layerZs[st.layer - 1];
    return st.z;
  };

  const parseSParam = (str, pos, cmdEnd) => {
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
        if (ch === 115 || ch === 114) { // 's' or 'r'
          return parseFastFloat(str, vStart, pos);
        }
      } else {
        pos++;
      }
    }
    return NaN;
  };

  const parseLineSlice = (str, start, end, lineNo) => {
    if (lineNo > endLineLimit) return false;
    const rawLine = captureRawLines ? str.slice(start, end) : null;
    while (start < end && str.charCodeAt(start) <= 32) start++;
    if (start >= end) {
      callbacks.onBlank?.(lineNo, rawLine, st);
      return;
    }
    const c0 = str.charCodeAt(start);

    if (c0 === 59) { // ';'
      const len = end - start;
      if (isLayerMarker(str, start, end)) {
        st.inStart = false;
        st.layer++;
        st.layerZs.push(NaN);
        st.inLayerChangeHeader = true;
        callbacks.onLayerChange?.(lineNo, rawLine, st);
        return;
      }
      if (st.inLayerChangeHeader && len > 3 && str.startsWith(';Z:', start)) {
        const z = parseFastFloat(str, start + 3, end);
        if (z === z && st.layerZs.length > 0) st.layerZs[st.layerZs.length - 1] = z;
        callbacks.onLayerZ?.(lineNo, z, rawLine, st);
        return;
      }
      if (len > 8 && str.startsWith(';HEIGHT:', start)) {
        const h = parseFastFloat(str, start + 8, end);
        if (h > 0) st.lineHeight = h;
        callbacks.onHeight?.(lineNo, st.lineHeight, rawLine, st);
        return;
      }
      if (len > 7 && str.startsWith(';WIDTH:', start)) {
        const w = parseFastFloat(str, start + 7, end);
        if (w > 0) st.extWidth = w;
        callbacks.onWidth?.(lineNo, st.extWidth, rawLine, st);
        return;
      }
      if (len > 6 && str.startsWith(';TYPE:', start)) {
        st.inLayerChangeHeader = false;
        st.featureType = str.slice(start + 6, end).trim();
        callbacks.onType?.(lineNo, st.featureType, rawLine, st);
        return;
      }
      if (len > 17 && str.startsWith('; printing object ', start)) {
        const objName = str.slice(start + 18, end).trim();
        if (objName) {
          st.hasObjectLabels = true;
          st.currentObject = objName;
          st.seenExtrusionInObjectBlock = false;
        }
        callbacks.onObjectStart?.(lineNo, objName, rawLine, st);
        return;
      }
      if (len >= 22 && str.startsWith('; stop printing object', start)) {
        const prevObj = st.currentObject;
        st.currentObject = null;
        st.seenExtrusionInObjectBlock = false;
        callbacks.onObjectStop?.(lineNo, prevObj, rawLine, st);
        return;
      }
      if (str.startsWith('; objects_info =', start)) noteObjectsInfo(str.slice(str.indexOf('=', start) + 1, end), st);
      if (str.startsWith('; filament_colour =', start) || str.startsWith('; extruder_colour =', start)) {
        const eq = str.indexOf('=', start);
        const cols = str.slice(eq + 1, end).trim().split(';').map(s => s.trim()).filter(Boolean);
        if (cols.length > 0) {
          st.filamentColours.length = 0;
          st.filamentColours.push(...cols);
        }
      }
      callbacks.onComment?.(lineNo, rawLine, st);
      return;
    }

    if (c0 === 77 && end - start >= 4 && str.charCodeAt(start + 1) === 55 && str.charCodeAt(start + 2) === 51 && str.charCodeAt(start + 3) === 32) {
      callbacks.onM73?.(lineNo, rawLine, st);
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
    if (pos === numStart) {
      callbacks.onOtherCommand?.(lineNo, null, null, rawLine, st, currentStateSnapshot);
      return;
    }
    const cmdNum = parseFastFloat(str, numStart, pos);
    if (st.m486.pending !== null && !(firstChar === 109 && cmdNum === 486)) flushM486Pending(lineNo, rawLine, st, callbacks);

    if (firstChar === 103 && (cmdNum === 0 || cmdNum === 1 || cmdNum === 2 || cmdNum === 3)) {
      st.inLayerChangeHeader = false;
      let px = NaN, py = NaN, pz = NaN, pe = NaN, pf = NaN, pi = NaN, pj = NaN, pr = NaN;
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
          else if (ch === 102) pf = parseFastFloat(str, vStart, pos);
          else if (ch === 105) pi = parseFastFloat(str, vStart, pos);
          else if (ch === 106) pj = parseFastFloat(str, vStart, pos);
          else if (ch === 114) pr = parseFastFloat(str, vStart, pos);
        } else {
          pos++;
        }
      }

      if (pf === pf && pf > 0) st.feedrate = pf * st.unitScale;
      const dE = applyExtrusion(pe * st.unitScale);
      const isArc = cmdNum === 2 || cmdNum === 3;
      const hasArc = isArc && (pi === pi || pj === pj || pr === pr);
      if (px !== px && py !== py && pz !== pz && !hasArc) {
        callbacks.onPureExtrudeOrFeed?.(lineNo, dE, st.feedrate, rawLine, st, currentStateSnapshot);
        return;
      }

      const sx = st.x, sy = st.y, sz = st.z;
      const nx = px !== px ? sx : px * st.unitScale + (st.relXYZ ? sx : st.shiftX);
      const ny = py !== py ? sy : py * st.unitScale + (st.relXYZ ? sy : st.shiftY);
      const nz = pz !== pz ? sz : pz * st.unitScale + (st.relXYZ ? sz : st.shiftZ);
      const isExt = dE > 0 && !st.inStart;
      if (isExt) st.seenExtrusionInObjectBlock = true;
      const isObjectEntryTravel = Boolean(st.currentObject && !st.seenExtrusionInObjectBlock && !isExt);

      if (cmdNum === 0 || cmdNum === 1) {
        callbacks.onLinearMove?.(
          lineNo, cmdNum, sx, sy, sz, nx, ny, nz, dE, isExt, isObjectEntryTravel,
          getLayerZ(), rawLine, st, currentStateSnapshot
        );
        st.x = nx; st.y = ny; st.z = nz;
      } else {
        callbacks.onArcMove?.(
          lineNo, cmdNum, sx, sy, sz, nx, ny, nz,
          pi * st.unitScale, pj * st.unitScale, pr * st.unitScale,
          dE, isExt, isObjectEntryTravel, getLayerZ(), rawLine, st, currentStateSnapshot
        );
        st.x = nx; st.y = ny; st.z = nz;
      }
      return;
    }

    if (firstChar === 116) { // 'T'
      if (cmdNum >= 0 && cmdNum <= 7) {
        st.physTool = cmdNum | 0;
        refreshStateSnapshot();
      }
      callbacks.onToolChange?.(lineNo, st.physTool, rawLine, st, currentStateSnapshot);
      return;
    }

    if (firstChar === 109) { // 'M'
      if (cmdNum === 82) {
        st.relE = false;
        callbacks.onModeChange?.(lineNo, 'M82', rawLine, st);
      } else if (cmdNum === 83) {
        st.relE = true;
        callbacks.onModeChange?.(lineNo, 'M83', rawLine, st);
      } else if (cmdNum === 106) {
        const s = parseSParam(str, pos, cmdEnd);
        if (s === s) { st.fan = s; refreshStateSnapshot(); }
        callbacks.onStateChange?.(lineNo, 'fan', st.fan, false, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 107) {
        st.fan = 0; refreshStateSnapshot();
        callbacks.onStateChange?.(lineNo, 'fan', 0, false, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 104 || cmdNum === 109) {
        const s = parseSParam(str, pos, cmdEnd);
        if (s === s) {
          st.hotendTemp = s;
          st.hotendWait = cmdNum === 109;
          refreshStateSnapshot();
        }
        callbacks.onStateChange?.(lineNo, 'hotendTemp', st.hotendTemp, cmdNum === 109, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 140 || cmdNum === 190) {
        const s = parseSParam(str, pos, cmdEnd);
        if (s === s) {
          st.bedTemp = s;
          st.bedWait = cmdNum === 190;
          refreshStateSnapshot();
        }
        callbacks.onStateChange?.(lineNo, 'bedTemp', st.bedTemp, cmdNum === 190, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 204) {
        st.accel = str.slice(pos, cmdEnd).trim();
        refreshStateSnapshot();
        callbacks.onStateChange?.(lineNo, 'accel', st.accel, false, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 221) {
        const s = parseSParam(str, pos, cmdEnd);
        if (s === s) { st.flow = s; refreshStateSnapshot(); }
        callbacks.onStateChange?.(lineNo, 'flow', st.flow, false, rawLine, st, currentStateSnapshot);
      } else if (cmdNum === 486) {
        handleM486Label(str, pos, cmdEnd, lineNo, rawLine, st, callbacks);
      } else if ((cmdNum === 600 || cmdNum === 601 || cmdNum === 0 || cmdNum === 25) && !st.inStart) {
        if (cmdNum === 600) {
          let explicitT = NaN;
          let p = pos;
          while (p < cmdEnd) {
            const ch = str.charCodeAt(p) | 32;
            if (ch >= 97 && ch <= 122) {
              p++;
              const vStart = p;
              while (p < cmdEnd) {
                const vc = str.charCodeAt(p);
                if ((vc >= 97 && vc <= 122) || (vc >= 65 && vc <= 90)) break;
                p++;
              }
              if (ch === 116) explicitT = parseFastFloat(str, vStart, p);
            } else p++;
          }
          if (explicitT >= 0 && explicitT <= 7) st.physTool = explicitT | 0;
          else st.physTool = (st.physTool + 1) % numUserToolColors;
          refreshStateSnapshot();
        }
        callbacks.onParkOrFilamentChange?.(lineNo, cmdNum, st.physTool, getLayerZ(), rawLine, st, currentStateSnapshot);
      } else {
        callbacks.onOtherCommand?.(lineNo, 'M', cmdNum, rawLine, st, currentStateSnapshot);
      }
      return;
    }

    if (firstChar === 103) { // 'G'
      if (cmdNum === 20) {
        st.unitScale = 25.4;
        callbacks.onModeChange?.(lineNo, 'G20', rawLine, st);
      } else if (cmdNum === 21) {
        st.unitScale = 1;
        callbacks.onModeChange?.(lineNo, 'G21', rawLine, st);
      } else if (cmdNum === 90) {
        st.relXYZ = false;
        callbacks.onModeChange?.(lineNo, 'G90', rawLine, st);
      } else if (cmdNum === 91) {
        st.relXYZ = true;
        callbacks.onModeChange?.(lineNo, 'G91', rawLine, st);
      } else if (cmdNum === 28) {
        let hasX = false, hasY = false, hasZ = false;
        while (pos < cmdEnd) {
          const ch = str.charCodeAt(pos) | 32;
          if (ch >= 97 && ch <= 122) {
            if (ch === 120) hasX = true;
            else if (ch === 121) hasY = true;
            else if (ch === 122) hasZ = true;
            pos++;
            while (pos < cmdEnd) {
              const vc = str.charCodeAt(pos);
              if ((vc >= 97 && vc <= 122) || (vc >= 65 && vc <= 90)) break;
              pos++;
            }
          } else pos++;
        }
        if (!hasX && !hasY && !hasZ) {
          hasX = true; hasY = true; hasZ = true;
        }
        const sx = st.x, sy = st.y, sz = st.z;
        const nx = hasX ? 0 : sx;
        const ny = hasY ? 0 : sy;
        const nz = hasZ ? 0 : sz;
        st.x = nx; st.y = ny; st.z = nz;
        callbacks.onHome?.(lineNo, sx, sy, sz, nx, ny, nz, hasX, hasY, hasZ, getLayerZ(), rawLine, st, currentStateSnapshot);
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
          st.shiftX = st.x; st.shiftY = st.y; st.shiftZ = st.z; st.e = 0;
        } else {
          if (px === px) st.shiftX = st.x - px * st.unitScale;
          if (py === py) st.shiftY = st.y - py * st.unitScale;
          if (pz === pz) st.shiftZ = st.z - pz * st.unitScale;
          if (pe === pe) st.e = pe * st.unitScale;
        }
        callbacks.onG92?.(lineNo, false, rawLine, st);
      } else if (cmdNum === 92.1) {
        st.shiftX = 0; st.shiftY = 0; st.shiftZ = 0;
        callbacks.onG92?.(lineNo, true, rawLine, st);
      } else {
        callbacks.onOtherCommand?.(lineNo, 'G', cmdNum, rawLine, st, currentStateSnapshot);
      }
      return;
    }

    callbacks.onOtherCommand?.(lineNo, String.fromCharCode(firstChar).toUpperCase(), cmdNum, rawLine, st, currentStateSnapshot);
  };

  if (isText) {
    visitGcodeTextLines(source, parseLineSlice);
  } else {
    visitGcodeLines(source, parseLineSlice);
  }

  return st;
}

/**
 * Load a G-code or .bgcode file (or raw G-code text when options.isText is true)
 * into a structured Toolpath object for collision checking and sequencing.
 */
const objectBaseName = (name) => name.replace(/\s+id:\d+(?:\s+copy:\d+)?\s*$/, '');

export function loadToolpath(input, options = {}) {
  const {
    isText = typeof input === 'string' && input.includes('\n'),
    arcTol = 0.05,
    defaultWidth = 0.45,
    defaultHeight = 0.2,
    numUserToolColors = 5,
    includeStart = false,
    profile = null,
  } = options;

  let gcodePath = null;
  let cleanup = () => {};
  if (!isText) {
    const opened = openGcodeFile(input);
    gcodePath = opened.gcodePath;
    cleanup = opened.cleanup;
  }

  try {
    const moves = [];
    const commands = [];
    const objectsMap = new Map();
    const declaredObjects = [];

    const ensureObjectRecord = (name) => {
      let rec = objectsMap.get(name);
      if (!rec) {
        rec = {
          id: objectsMap.size,
          name,
          bbox: { x: [1e9, -1e9], y: [1e9, -1e9], z: [1e9, -1e9] },
          top: 0,
          moveCount: 0,
          extrusionLength: 0,
          tools: new Set(),
        };
        objectsMap.set(name, rec);
      }
      return rec;
    };

    const recordObjectPoint = (rec, x, y, z) => {
      if (x < rec.bbox.x[0]) rec.bbox.x[0] = x;
      if (x > rec.bbox.x[1]) rec.bbox.x[1] = x;
      if (y < rec.bbox.y[0]) rec.bbox.y[0] = y;
      if (y > rec.bbox.y[1]) rec.bbox.y[1] = y;
      if (z < rec.bbox.z[0]) rec.bbox.z[0] = z;
      if (z > rec.bbox.z[1]) rec.bbox.z[1] = z;
      if (z > rec.top) rec.top = z;
    };

    const pushMove = (move) => {
      moves.push(move);
      if (move.extruding && move.object) {
        const rec = ensureObjectRecord(move.object);
        recordObjectPoint(rec, move.x0, move.y0, move.z0);
        recordObjectPoint(rec, move.x1, move.y1, move.z1);
        rec.moveCount++;
        rec.extrusionLength += move.dE;
        rec.tools.add(move.tool);
      }
    };

    const st = walkGcode(isText ? input : gcodePath, {
      isText,
      includeStart,
      defaultWidth,
      defaultHeight,
      numUserToolColors,
      captureRawLines: true,
    }, {
      onBlank(lineNo, rawLine, st) {
        commands.push({ line: lineNo, kind: 'blank', raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject });
      },
      onLayerChange(lineNo, rawLine, st) {
        commands.push({ line: lineNo, kind: 'layer_change', layer: st.layer, raw: rawLine, inStart: st.inStart, object: st.currentObject });
      },
      onLayerZ(lineNo, z, rawLine, st) {
        commands.push({ line: lineNo, kind: 'layer_z', z, layer: st.layer, raw: rawLine, inStart: st.inStart, object: st.currentObject });
      },
      onHeight(lineNo, height, rawLine, st) {
        commands.push({ line: lineNo, kind: 'height', height, layer: st.layer, raw: rawLine, inStart: st.inStart, object: st.currentObject });
      },
      onWidth(lineNo, width, rawLine, st) {
        commands.push({ line: lineNo, kind: 'width', width, layer: st.layer, raw: rawLine, inStart: st.inStart, object: st.currentObject });
      },
      onType(lineNo, type, rawLine, st) {
        commands.push({ line: lineNo, kind: 'type', type, layer: st.layer, raw: rawLine, inStart: st.inStart, object: st.currentObject });
      },
      onObjectStart(lineNo, objName, rawLine, st) {
        if (objName) {
          if (!declaredObjects.includes(objName)) declaredObjects.push(objName);
          ensureObjectRecord(objName);
        }
        commands.push({ line: lineNo, kind: 'object_start', object: objName, layer: st.layer, raw: rawLine, inStart: st.inStart });
      },
      onObjectStop(lineNo, prevObj, rawLine, st) {
        commands.push({ line: lineNo, kind: 'object_stop', object: prevObj, layer: st.layer, raw: rawLine, inStart: st.inStart });
      },
      onComment(lineNo, rawLine, st) {
        commands.push({ line: lineNo, kind: 'comment', raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject });
      },
      onM73(lineNo, rawLine, st) {
        commands.push({ line: lineNo, kind: 'm73', raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject });
      },
      onPureExtrudeOrFeed(lineNo, dE, feedrate, rawLine, st, snap) {
        commands.push({
          line: lineNo,
          kind: dE !== 0 ? 'retract' : 'feedrate',
          dE,
          feedrate,
          x: st.x,
          y: st.y,
          z: st.z,
          layer: st.layer,
          layerZ: st.layer > 0 && Number.isFinite(st.layerZs[st.layer - 1]) ? st.layerZs[st.layer - 1] : st.z,
          object: st.currentObject,
          type: st.featureType,
          width: st.extWidth,
          height: st.lineHeight,
          tool: st.physTool,
          inStart: st.inStart,
          state: snap,
          raw: rawLine,
        });
      },
      onLinearMove(lineNo, cmdNum, sx, sy, sz, nx, ny, nz, dE, isExt, isObjectEntryTravel, curLayerZ, rawLine, st, snap) {
        if (isExt && st.layer > 0 && Number.isNaN(st.layerZs[st.layer - 1])) {
          st.layerZs[st.layer - 1] = sz;
        }
        const move = {
          line: lineNo,
          kind: cmdNum === 0 ? 'G0' : 'G1',
          x0: sx, y0: sy, z0: sz,
          x1: nx, y1: ny, z1: nz,
          extruding: isExt,
          dE,
          feedrate: st.feedrate,
          width: st.extWidth,
          height: st.lineHeight,
          layer: st.layer,
          layerZ: curLayerZ,
          object: st.currentObject,
          isObjectEntryTravel,
          type: st.featureType,
          tool: st.physTool,
          inStart: st.inStart,
          state: snap,
          raw: rawLine,
        };
        pushMove(move);
        commands.push({
          line: lineNo,
          kind: 'move',
          cmd: cmdNum === 0 ? 'G0' : 'G1',
          x0: sx, y0: sy, z0: sz,
          x1: nx, y1: ny, z1: nz,
          extruding: isExt,
          dE,
          feedrate: st.feedrate,
          width: st.extWidth,
          height: st.lineHeight,
          layer: st.layer,
          layerZ: curLayerZ,
          object: st.currentObject,
          isObjectEntryTravel,
          type: st.featureType,
          tool: st.physTool,
          inStart: st.inStart,
          state: snap,
          raw: rawLine,
        });
      },
      onArcMove(lineNo, cmdNum, sx, sy, sz, nx, ny, nz, iScaled, jScaled, rScaled, dE, isExt, isObjectEntryTravel, curLayerZ, rawLine, st, snap) {
        if (isExt && st.layer > 0 && Number.isNaN(st.layerZs[st.layer - 1])) {
          st.layerZs[st.layer - 1] = sz;
        }
        const arcPts = [];
        tessellateArcPoints(cmdNum === 2, sx, sy, sz, nx, ny, nz, iScaled, jScaled, rScaled, arcTol, (ax, ay, az) => {
          arcPts.push([ax, ay, az]);
        });
        const nSegs = arcPts.length || 1;
        const segDE = dE / nSegs;
        let cx = sx, cy = sy, cz = sz;
        for (let s = 0; s < arcPts.length; s++) {
          const [ax, ay, az] = arcPts[s];
          pushMove({
            line: lineNo,
            kind: cmdNum === 2 ? 'G2' : 'G3',
            x0: cx, y0: cy, z0: cz,
            x1: ax, y1: ay, z1: az,
            extruding: isExt,
            dE: segDE,
            feedrate: st.feedrate,
            width: st.extWidth,
            height: st.lineHeight,
            layer: st.layer,
            layerZ: curLayerZ,
            object: st.currentObject,
            type: st.featureType,
            tool: st.physTool,
            inStart: st.inStart,
            state: snap,
            raw: rawLine,
          });
          cx = ax; cy = ay; cz = az;
        }
        if (isExt && st.currentObject) {
          const rec = ensureObjectRecord(st.currentObject);
          rec.moveCount -= (arcPts.length - 1);
        }
        commands.push({
          line: lineNo,
          kind: 'arc',
          cmd: cmdNum === 2 ? 'G2' : 'G3',
          cw: cmdNum === 2,
          x0: sx, y0: sy, z0: sz,
          x1: nx, y1: ny, z1: nz,
          i: iScaled,
          j: jScaled,
          r: rScaled,
          extruding: isExt,
          dE,
          feedrate: st.feedrate,
          width: st.extWidth,
          height: st.lineHeight,
          layer: st.layer,
          layerZ: curLayerZ,
          object: st.currentObject,
          isObjectEntryTravel,
          type: st.featureType,
          tool: st.physTool,
          inStart: st.inStart,
          state: snap,
          raw: rawLine,
        });
      },
      onToolChange(lineNo, tool, rawLine, st, snap) {
        commands.push({ line: lineNo, kind: 'tool', tool, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject, state: snap });
      },
      onModeChange(lineNo, mode, rawLine, st) {
        commands.push({ line: lineNo, kind: 'mode', mode, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject });
      },
      onStateChange(lineNo, stateKind, value, wait, rawLine, st, snap) {
        commands.push({ line: lineNo, kind: 'state', stateKind, value, wait, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject, state: snap });
      },
      onParkOrFilamentChange(lineNo, cmdNum, tool, curLayerZ, rawLine, st, snap) {
        const parkSpec = profile?.park?.m600 || { x: 0, y: 210, z_lift: 0 };
        const zMax = profile?.bed?.z_max ?? 220;
        const sx = st.x, sy = st.y, sz = st.z;
        const parkZ = Math.min(zMax, sz + (parkSpec.z_lift || 0));
        if (parkZ !== sz) {
          pushMove({
            line: lineNo, kind: 'M600_PARK',
            x0: sx, y0: sy, z0: sz, x1: sx, y1: sy, z1: parkZ,
            extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
            layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
            tool, inStart: st.inStart, state: snap, raw: rawLine,
          });
        }
        pushMove({
          line: lineNo, kind: 'M600_PARK',
          x0: sx, y0: sy, z0: parkZ, x1: parkSpec.x, y1: parkSpec.y, z1: parkZ,
          extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
          layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
          tool, inStart: st.inStart, state: snap, raw: rawLine,
        });
        pushMove({
          line: lineNo, kind: 'M600_PARK',
          x0: parkSpec.x, y0: parkSpec.y, z0: parkZ, x1: sx, y1: sy, z1: parkZ,
          extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
          layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
          tool, inStart: st.inStart, state: snap, raw: rawLine,
        });
        if (parkZ !== sz) {
          pushMove({
            line: lineNo, kind: 'M600_PARK',
            x0: sx, y0: sy, z0: parkZ, x1: sx, y1: sy, z1: sz,
            extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
            layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
            tool, inStart: st.inStart, state: snap, raw: rawLine,
          });
        }
        commands.push({ line: lineNo, kind: 'm600', cmdNum, tool, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject, state: snap });
      },
      onHome(lineNo, sx, sy, sz, nx, ny, nz, hasX, hasY, hasZ, curLayerZ, rawLine, st, snap) {
        if (!st.inStart) {
          if (sx !== nx || sy !== ny) {
            pushMove({
              line: lineNo, kind: 'G28',
              x0: sx, y0: sy, z0: sz, x1: nx, y1: ny, z1: sz,
              extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
              layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
              tool: st.physTool, inStart: st.inStart, state: snap, raw: rawLine,
            });
          }
          if (sz !== nz) {
            pushMove({
              line: lineNo, kind: 'G28',
              x0: nx, y0: ny, z0: sz, x1: nx, y1: ny, z1: nz,
              extruding: false, dE: 0, feedrate: st.feedrate, width: st.extWidth, height: st.lineHeight,
              layer: st.layer, layerZ: curLayerZ, object: st.currentObject, type: st.featureType,
              tool: st.physTool, inStart: st.inStart, state: snap, raw: rawLine,
            });
          }
        }
        commands.push({ line: lineNo, kind: 'g28', hasX, hasY, hasZ, x1: nx, y1: ny, z1: nz, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject, state: snap });
      },
      onG92(lineNo, isReset, rawLine, st) {
        commands.push({ line: lineNo, kind: isReset ? 'g92.1' : 'g92', raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject });
      },
      onOtherCommand(lineNo, letter, cmdNum, rawLine, st, snap) {
        commands.push({ line: lineNo, kind: 'other', letter, cmdNum, raw: rawLine, layer: st.layer, inStart: st.inStart, object: st.currentObject, state: snap });
      },
    });

    const objects = [...objectsMap.values()]
      .filter(rec => rec.moveCount > 0)
      .map((rec, idx) => ({
        id: idx,
        name: rec.name,
        bbox: {
          x: [+(rec.bbox.x[0]).toFixed(3), +(rec.bbox.x[1]).toFixed(3)],
          y: [+(rec.bbox.y[0]).toFixed(3), +(rec.bbox.y[1]).toFixed(3)],
          z: [+(rec.bbox.z[0]).toFixed(3), +(rec.bbox.z[1]).toFixed(3)],
        },
        top: +rec.top.toFixed(3),
        moveCount: rec.moveCount,
        extrusionLength: +rec.extrusionLength.toFixed(5),
        tools: [...rec.tools].sort((a, b) => a - b),
      }));

    const resolveObjectName = (target) => {
      if (!target && target !== 0) return null;
      if (typeof target === 'object' && target.name) return target.name;
      if (typeof target === 'number') return objects[target]?.name ?? null;
      const str = String(target);
      if (objectsMap.has(str)) return str;
      // Exact base name (without PrusaSlicer's ` id:N copy:M` suffix) or numeric index only;
      // never substring matching, which silently picks the wrong object ('Cube' vs 'BigCube').
      const candidates = new Set();
      for (const name of objectsMap.keys()) {
        if (objectBaseName(name) === str) candidates.add(name);
      }
      const idx = /^\d+$/.test(str) ? Number(str) : NaN;
      if (Number.isInteger(idx) && objects[idx]) candidates.add(objects[idx].name);
      if (candidates.size > 1) {
        throw new Error(`Ambiguous object '${str}': matches ${[...candidates].map(n => `'${n}'`).join(', ')}`);
      }
      if (candidates.size === 1) return candidates.values().next().value;
      return str;
    };

    return {
      moves,
      commands,
      objects,
      declaredObjects,
      hasObjectLabels: st.hasObjectLabels,
      // The walk covers the whole file here, so a marker was seen iff a layer was started.
      hasLayerMarkers: st.hasMarkers ?? st.layerZs.length > 0,
      layers: st.layerZs.length || (moves.length > 0 ? 1 : 0),
      layerZs: st.layerZs,
      filamentColours: st.filamentColours,
      movesOf(target) {
        if (Array.isArray(target)) return target;
        if (target && typeof target === 'object' && Array.isArray(target.moves)) return target.moves;
        const name = resolveObjectName(target);
        const objMoves = [];
        let prevEnd = null;
        for (let i = 0; i < moves.length; i++) {
          const m = moves[i];
          if (m.object !== name || m.inStart) continue;
          if (m.isObjectEntryTravel) continue;
          if (prevEnd && (prevEnd.x !== m.x0 || prevEnd.y !== m.y0 || prevEnd.z !== m.z0)) {
            objMoves.push({
              line: m.line,
              kind: 'G0',
              x0: prevEnd.x, y0: prevEnd.y, z0: prevEnd.z,
              x1: m.x0, y1: m.y0, z1: m.z0,
              extruding: false,
              dE: 0,
              feedrate: m.feedrate,
              width: m.width,
              height: m.height,
              layer: m.layer,
              layerZ: m.layerZ,
              object: name,
              type: m.type,
              tool: m.tool,
              inStart: false,
              state: m.state,
              raw: `G0 X${m.x0.toFixed(3)} Y${m.y0.toFixed(3)} Z${m.z0.toFixed(3)}`,
            });
          }
          objMoves.push(m);
          prevEnd = { x: m.x1, y: m.y1, z: m.z1 };
        }
        return objMoves;
      },
    };
  } finally {
    cleanup();
  }
}
