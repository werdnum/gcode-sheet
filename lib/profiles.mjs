// lib/profiles.mjs: Printer profile schema, built-in MK4 profile, and JSON/YAML loader.
import fs from 'node:fs';

const MK4_JSON_URL = new URL('../profiles/mk4.json', import.meta.url);
export const MK4_PROFILE = JSON.parse(fs.readFileSync(MK4_JSON_URL, 'utf8'));

const BUILTIN_PROFILES = new Map([
  ['mk4', MK4_PROFILE],
  ['prusa-mk4', MK4_PROFILE],
  ['prusa mk4', MK4_PROFILE],
  ['mk4s', { ...MK4_PROFILE, name: 'Prusa MK4S' }],
]);

function stripComment(line) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let inSingle = false, inDouble = false;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      else if (ch === sep && depth === 0) {
        parts.push(str.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const tail = str.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function parseScalarOrFlow(valStr) {
  const s = valStr.trim();
  if (!s) return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ',').map(parseScalarOrFlow);
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const entry of splitTopLevel(inner, ',')) {
      const colon = entry.indexOf(':');
      if (colon === -1) throw new Error(`Invalid flow mapping entry: ${entry}`);
      const k = entry.slice(0, colon).trim();
      const v = entry.slice(colon + 1).trim();
      obj[parseScalarOrFlow(k)] = parseScalarOrFlow(v);
    }
    return obj;
  }
  const num = Number(s);
  if (!Number.isNaN(num) && s !== '') return num;
  return s;
}

export function parseProfileYaml(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const lines = text.split(/\r?\n/).map(raw => {
    const clean = stripComment(raw).trimEnd();
    const indent = clean.match(/^\s*/)[0].length;
    return { indent, content: clean.trim() };
  }).filter(l => l.content.length > 0);

  let idx = 0;
  function parseBlock(baseIndent) {
    if (idx >= lines.length) return {};
    if (lines[idx].content.startsWith('- ')) {
      const arr = [];
      while (idx < lines.length && lines[idx].indent === baseIndent && lines[idx].content.startsWith('- ')) {
        const itemRest = lines[idx].content.slice(2).trim();
        idx++;
        if (!itemRest) {
          arr.push(idx < lines.length && lines[idx].indent > baseIndent ? parseBlock(lines[idx].indent) : null);
        } else if (itemRest.includes(':')) {
          const itemObj = {};
          const colon = itemRest.indexOf(':');
          const k = itemRest.slice(0, colon).trim();
          const v = itemRest.slice(colon + 1).trim();
          itemObj[k] = v ? parseScalarOrFlow(v) : (idx < lines.length && lines[idx].indent > baseIndent ? parseBlock(lines[idx].indent) : null);
          while (idx < lines.length && lines[idx].indent > baseIndent) {
            const subLine = lines[idx];
            const sc = subLine.content.indexOf(':');
            if (sc === -1) throw new Error(`Invalid YAML line: ${subLine.content}`);
            const sk = subLine.content.slice(0, sc).trim();
            const sv = subLine.content.slice(sc + 1).trim();
            idx++;
            if (sv) {
              itemObj[sk] = parseScalarOrFlow(sv);
            } else if (idx < lines.length && lines[idx].indent > subLine.indent) {
              itemObj[sk] = parseBlock(lines[idx].indent);
            } else {
              itemObj[sk] = null;
            }
          }
          arr.push(itemObj);
        } else {
          arr.push(parseScalarOrFlow(itemRest));
        }
      }
      return arr;
    }

    const obj = {};
    while (idx < lines.length && lines[idx].indent === baseIndent && !lines[idx].content.startsWith('- ')) {
      const line = lines[idx];
      const colon = line.content.indexOf(':');
      if (colon === -1) throw new Error(`Invalid YAML line: ${line.content}`);
      const k = line.content.slice(0, colon).trim();
      const v = line.content.slice(colon + 1).trim();
      idx++;
      if (v) {
        obj[k] = parseScalarOrFlow(v);
      } else if (idx < lines.length && lines[idx].indent > baseIndent) {
        obj[k] = parseBlock(lines[idx].indent);
      } else {
        obj[k] = null;
      }
    }
    return obj;
  }

  return parseBlock(lines[0]?.indent ?? 0);
}

export function validateProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Printer profile must be an object');
  }
  const name = String(raw.name || 'Custom Printer');
  if (!raw.bed || !Array.isArray(raw.bed.x) || !Array.isArray(raw.bed.y) || typeof raw.bed.z_max !== 'number') {
    throw new Error(`Invalid bed specification in profile '${name}'`);
  }
  const bed = {
    x: [Number(raw.bed.x[0]), Number(raw.bed.x[1])],
    y: [Number(raw.bed.y[0]), Number(raw.bed.y[1])],
    z_max: Number(raw.bed.z_max),
  };
  if (!(bed.x[0] < bed.x[1] && bed.y[0] < bed.y[1] && bed.z_max > 0)) {
    throw new Error(`Invalid bed dimensions in profile '${name}'`);
  }
  if (!Array.isArray(raw.parts) || raw.parts.length === 0) {
    throw new Error(`Profile '${name}' must define at least one head part`);
  }

  const parts = raw.parts.map((p, idx) => {
    if (!p || typeof p !== 'object' || !p.id) {
      throw new Error(`Part #${idx} in profile '${name}' is missing an 'id'`);
    }
    if (!Array.isArray(p.z) || p.z.length !== 2) {
      throw new Error(`Part '${p.id}' in profile '${name}' must specify z: [z_lo, z_hi]`);
    }
    const z0 = Number(p.z[0]), z1 = Number(p.z[1]);
    if (!(Number.isFinite(z0) && Number.isFinite(z1) && z1 >= z0 && z0 >= 0)) {
      throw new Error(`Part '${p.id}' in profile '${name}' has invalid z range [${p.z}]`);
    }
    const measured = p.measured === true;
    if (p.shape === 'cylinder') {
      const r = Number(p.r);
      if (!(Number.isFinite(r) && r > 0)) {
        throw new Error(`Cylinder part '${p.id}' must have positive radius 'r'`);
      }
      return { id: String(p.id), shape: 'cylinder', r, z: [z0, z1], measured };
    }
    if (p.shape === 'box') {
      if (!Array.isArray(p.x) || p.x.length !== 2 || !Array.isArray(p.y) || p.y.length !== 2) {
        throw new Error(`Box part '${p.id}' must specify x: [x_lo, x_hi] and y: [y_lo, y_hi]`);
      }
      const x0 = Number(p.x[0]), x1 = Number(p.x[1]);
      const y0 = Number(p.y[0]), y1 = Number(p.y[1]);
      if (!(Number.isFinite(x0) && Number.isFinite(x1) && x1 >= x0 && Number.isFinite(y0) && Number.isFinite(y1) && y1 >= y0)) {
        throw new Error(`Box part '${p.id}' has invalid x/y bounds`);
      }
      return { id: String(p.id), shape: 'box', x: [x0, x1], y: [y0, y1], z: [z0, z1], measured };
    }
    throw new Error(`Unsupported part shape '${p.shape}' on part '${p.id}' (expected 'cylinder' or 'box')`);
  });

  const m600Raw = raw.park?.m600 || { x: 0, y: bed.y[1], z_lift: 0 };
  const park = {
    m600: {
      x: Number(m600Raw.x ?? 0),
      y: Number(m600Raw.y ?? bed.y[1]),
      z_lift: Number(m600Raw.z_lift ?? 0),
    },
  };
  const change_cost_s = Number(raw.change_cost_s ?? 120);
  const unmeasuredParts = parts.filter(p => !p.measured).map(p => p.id);

  // Clearance height is the lowest z_lo among non-nozzle parts (or 20mm fallback)
  const nonNozzleZLo = parts.filter(p => p.id !== 'nozzle' && p.z[0] > 0).map(p => p.z[0]);
  const clearance_height = nonNozzleZLo.length > 0 ? Math.min(...nonNozzleZLo) : 20;
  const extruderPart = parts.find(p => p.id === 'extruder' && p.shape === 'cylinder');
  const clearance_radius = extruderPart ? extruderPart.r : 45;

  return {
    name,
    bed,
    parts,
    park,
    change_cost_s,
    unmeasuredParts,
    clearance_height,
    clearance_radius,
  };
}

export function loadProfile(spec = 'mk4') {
  if (!spec) return validateProfile(MK4_PROFILE);
  if (typeof spec === 'object') return validateProfile(spec);
  const key = String(spec).trim().toLowerCase();
  if (BUILTIN_PROFILES.has(key)) {
    return validateProfile(BUILTIN_PROFILES.get(key));
  }
  if (fs.existsSync(spec)) {
    const content = fs.readFileSync(spec, 'utf8');
    return validateProfile(parseProfileYaml(content));
  }
  throw new Error(`Unknown printer profile '${spec}' (expected 'mk4' or a path to a JSON/YAML profile file)`);
}
