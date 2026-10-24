// lib/sequence.mjs: Phase 2 building blocks: per-layer slice extraction from labelled files,
// the normalised G-code emitter, and the fixed-split solver (pairwise feasibility matrix +
// Held-Karp / local search over chunks cut at --split-at and colour boundaries). The entry
// point sequenceToolpath and the adaptive planner live in lib/plan.mjs, which builds on this.
import {
  loadToolpath,
  loadProfile,
  DepositStore,
  checkMoves,
  checkToolpath,
} from './collide.mjs';

export const EPS = 1e-5;
export const DEFAULT_TRAVEL_FEEDRATE = 7800; // mm/min (130 mm/s)
export const DEFAULT_Z_FEEDRATE = 7800;      // mm/min

/** A problem with the user's input (file, options), as opposed to a bug. */
export class InputError extends Error {}

/**
 * Parse a colour assignment specification:
 * - Array: ["red", "blue"] -> 0="red", 1="blue"
 * - Object map: { "cube1": "red", "cube2": "blue" }
 * - String: "cube1=red,cube2=blue" or "0=red,1=blue" or "red,blue"
 */
export function parseColourSpec(spec) {
  if (!spec) return new Map();
  if (spec instanceof Map) return spec;
  if (Array.isArray(spec)) {
    const map = new Map();
    spec.forEach((c, idx) => {
      if (c !== undefined && c !== null && String(c).trim() !== '') {
        map.set(String(idx), String(c).trim());
      }
    });
    return map;
  }
  if (typeof spec === 'object') {
    return new Map(Object.entries(spec));
  }
  const str = String(spec).trim();
  if (!str) return new Map();
  if (str.startsWith('{')) {
    return new Map(Object.entries(JSON.parse(str)));
  }
  const map = new Map();
  const parts = str.split(',');
  let positionalIdx = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      map.set(String(positionalIdx++), trimmed);
    } else {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!key || !val) {
        throw new InputError(`Invalid colour assignment '${trimmed}' (expected 'object=colour')`);
      }
      map.set(key, val);
      positionalIdx++;
    }
  }
  return map;
}

/** The colour a --colours map assigns to this object, or null when it names none. */
export function mapColourFor(obj, idx, colourMap, toolpath) {
  if (colourMap && colourMap.size > 0) {
    if (colourMap.has(obj.name)) return colourMap.get(obj.name);
    const baseName = obj.name.split(' id:')[0].trim();
    if (colourMap.has(baseName)) return colourMap.get(baseName);
    if (colourMap.has(String(idx))) return colourMap.get(String(idx));
    if (colourMap.has(`id:${obj.id}`)) return colourMap.get(`id:${obj.id}`);
    for (const [k, v] of colourMap.entries()) {
      if (/^\d+$/.test(k) || k.startsWith('id:')) continue;
      const matches = (toolpath?.objects || [obj]).filter(
        o => o.name === k || o.name.split(' id:')[0].trim() === k || o.name.startsWith(k)
      );
      if (matches.length > 1) {
        throw new InputError(`Ambiguous colour assignment key '${k}' matches multiple objects: ${matches.map(m => m.name).join(', ')}`);
      }
      if (matches.length === 1 && matches[0].name === obj.name) {
        return v;
      }
    }
  }
  return null;
}

export function resolveObjectColour(obj, idx, colourMap, toolpath, sliceTool = null) {
  const mapped = mapColourFor(obj, idx, colourMap, toolpath);
  if (mapped !== null) return mapped;
  const toolIdx = sliceTool !== null && sliceTool !== undefined
    ? sliceTool
    : (obj.tools && obj.tools.length > 0 ? obj.tools[0] : 0);
  if (toolpath?.filamentColours && toolpath.filamentColours[toolIdx]) {
    return toolpath.filamentColours[toolIdx];
  }
  return `T${toolIdx}`;
}

export function parseSplitHeights(splitSpec) {
  if (splitSpec === undefined || splitSpec === null || splitSpec === '') return [];
  if (Array.isArray(splitSpec)) {
    return [...new Set(splitSpec.map(Number).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  }
  return [...new Set(
    String(splitSpec)
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0)
  )].sort((a, b) => a - b);
}

/**
 * Map each G2/G3 command's source line to its tessellated segments in toolpath.moves, built
 * once (resolving arcs with moves.filter per command was quadratic in the arc count).
 */
export function buildArcSegmentIndex(toolpath) {
  const arcLines = new Set();
  for (const c of toolpath.commands) {
    if (c.kind === 'arc') arcLines.add(c.line);
  }
  const map = new Map();
  if (arcLines.size === 0) return map;
  for (const m of toolpath.moves) {
    if (!arcLines.has(m.line)) continue;
    let list = map.get(m.line);
    if (!list) map.set(m.line, (list = []));
    list.push(m);
  }
  return map;
}

function makeGlueMove(firstCmd, slice, objName, from, to, feedrate, raw) {
  return {
    line: firstCmd.line,
    kind: 'G0',
    x0: from[0], y0: from[1], z0: from[2],
    x1: to[0], y1: to[1], z1: to[2],
    extruding: false, dE: 0, feedrate,
    width: firstCmd.width, height: firstCmd.height,
    layer: slice.layer, layerZ: slice.z, object: objName,
    type: firstCmd.type, tool: firstCmd.tool, inStart: false,
    state: firstCmd.state,
    raw,
  };
}

/**
 * The glue the emitter inserts between two consecutive layer slices of one object printed in
 * the same chunk: a Z move at the previous slice's last XY, then an XY travel at the new layer Z.
 */
export function layerGlueMoves(prevEnd, firstCmd, slice, objName) {
  const out = [];
  if (!prevEnd || (prevEnd.x === firstCmd.x0 && prevEnd.y === firstCmd.y0 && prevEnd.z === firstCmd.z0)) return out;
  if (firstCmd.z0 !== prevEnd.z) {
    out.push(makeGlueMove(firstCmd, slice, objName,
      [prevEnd.x, prevEnd.y, prevEnd.z], [prevEnd.x, prevEnd.y, firstCmd.z0],
      DEFAULT_Z_FEEDRATE, `G0 Z${firstCmd.z0.toFixed(3)} F${DEFAULT_Z_FEEDRATE}`));
  }
  if (firstCmd.x0 !== prevEnd.x || firstCmd.y0 !== prevEnd.y) {
    out.push(makeGlueMove(firstCmd, slice, objName,
      [prevEnd.x, prevEnd.y, firstCmd.z0], [firstCmd.x0, firstCmd.y0, firstCmd.z0],
      DEFAULT_TRAVEL_FEEDRATE, `G0 X${firstCmd.x0.toFixed(3)} Y${firstCmd.y0.toFixed(3)} F${DEFAULT_TRAVEL_FEEDRATE}`));
  }
  return out;
}

/**
 * Append one layer slice's motion (arcs expanded to their tessellated segments) to `moves`.
 * Slice commands are never start G-code, so they are shared, not copied. Returns the slice's
 * end point and its extruding command count / extrusion.
 */
export function appendSliceMoves(moves, slice, segmentsByLine) {
  let moveCount = 0;
  let extrusionLength = 0;
  let end = null;
  for (const cmd of slice.commands) {
    if (cmd.kind === 'move') {
      moves.push(cmd);
    } else if (cmd.kind === 'arc') {
      for (const seg of segmentsByLine.get(cmd.line) || []) moves.push(seg);
    } else {
      continue;
    }
    if (cmd.extruding) {
      moveCount++;
      extrusionLength += cmd.dE;
    }
    end = { x: cmd.x1, y: cmd.y1, z: cmd.z1 };
  }
  return { end, moveCount, extrusionLength };
}

export function sliceFirstMotion(slice) {
  return slice.commands.find(c => c.kind === 'move' || c.kind === 'arc');
}

/**
 * Vertical descent from fromZ onto `point` (the first point of a chunk / slice) and vertical
 * lift from `point` to toZ, as the emitter performs them. Every head part is lowest at the
 * descent's end and at the lift's start, so their checker verdict does not depend on the
 * safe-plane height.
 */
export function descentMove(point, fromZ, ref) {
  const [x, y, z] = point;
  return {
    line: ref.line || 1, kind: 'G0',
    x0: x, y0: y, z0: Math.max(fromZ, z), x1: x, y1: y, z1: z,
    extruding: false, dE: 0, feedrate: DEFAULT_Z_FEEDRATE,
    width: 0.45, height: 0.2, layer: ref.layer || 1, layerZ: z, object: ref.object,
    type: 'Custom', tool: ref.state?.tool || 0, inStart: false, state: ref.state,
    raw: `G0 Z${z.toFixed(3)} F${DEFAULT_Z_FEEDRATE}`,
  };
}

export function liftMove(point, toZ, ref) {
  const [x, y, z] = point;
  const top = Math.max(toZ, z);
  return {
    line: ref.line || 1, kind: 'G0',
    x0: x, y0: y, z0: z, x1: x, y1: y, z1: top,
    extruding: false, dE: 0, feedrate: DEFAULT_Z_FEEDRATE,
    width: 0.45, height: 0.2, layer: ref.layer || 1, layerZ: z, object: ref.object,
    type: 'Custom', tool: ref.state?.tool || 0, inStart: false, state: ref.state,
    raw: `G0 Z${top.toFixed(3)} F${DEFAULT_Z_FEEDRATE}`,
  };
}

/**
 * Moves between two consecutive slices of one chunk: the layer glue, or, when the colour
 * changes between them (a cluster whose members differ in colour), the emitter's lift to the
 * safe plane for the M600 and the descent onto the next slice.
 */
export function sliceTransitionMoves(prevEnd, prevColour, slice, firstCmd, highZ) {
  if (prevColour !== null && slice.colour !== prevColour) {
    return [
      liftMove([prevEnd.x, prevEnd.y, prevEnd.z], highZ, { ...firstCmd, object: slice.object }),
      descentMove([firstCmd.x0, firstCmd.y0, firstCmd.z0], highZ, { ...firstCmd, object: slice.object }),
    ];
  }
  return layerGlueMoves(prevEnd, firstCmd, slice, slice.object);
}

/** Estimated time to execute moves at their feedrates (1800 mm/min where none is set). */
export function movesPrintTime(moves) {
  let t = 0;
  for (const m of moves) {
    const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0, m.z1 - m.z0);
    t += len / ((m.feedrate > 0 ? m.feedrate : 1800) / 60);
  }
  return t;
}

/**
 * Build a printable chunk (the unit emitResequencedGcode consumes) from consecutive layer
 * slices: its check moves including the glue between slices, start/end points, top,
 * extrusion totals, and its colours (first, last, and changes between its own slices, which
 * only clusters of differently coloured objects have). highZ is the safe plane used for the
 * lift/descent around such internal colour changes.
 */
export function buildBandChunk(name, bandSlices, segmentsByLine, highZ = 0) {
  const chunkMoves = [];
  let moveCount = 0;
  let extrusionLength = 0;
  let prevEnd = null;
  let prevColour = null;
  let internalChanges = 0;
  for (const slice of bandSlices) {
    const firstCmd = sliceFirstMotion(slice);
    if (!firstCmd) continue;
    if (prevEnd) {
      for (const g of sliceTransitionMoves(prevEnd, prevColour, slice, firstCmd, highZ)) chunkMoves.push(g);
    }
    if (prevColour !== null && slice.colour !== prevColour) internalChanges++;
    prevColour = slice.colour;
    const res = appendSliceMoves(chunkMoves, slice, segmentsByLine);
    moveCount += res.moveCount;
    extrusionLength += res.extrusionLength;
    if (res.end) prevEnd = res.end;
  }
  if (chunkMoves.length === 0) return null;
  const firstMove = chunkMoves[0];
  const lastMove = chunkMoves[chunkMoves.length - 1];
  const zMin = bandSlices[0].z;
  const zMax = bandSlices[bandSlices.length - 1].z;
  return {
    object: name,
    z_band: [+zMin.toFixed(3), +zMax.toFixed(3)],
    top: +zMax.toFixed(3),
    colour: bandSlices[0].colour,
    lastColour: bandSlices[bandSlices.length - 1].colour,
    internalChanges,
    startPoint: [firstMove.x0, firstMove.y0, firstMove.z0],
    endPoint: [lastMove.x1, lastMove.y1, lastMove.z1],
    moveCount,
    extrusionLength: +extrusionLength.toFixed(5),
    slices: bandSlices,
    moves: chunkMoves,
  };
}

function midLayerChangeMessage(object, layer) {
  return `Object '${object}' has a mid-layer colour/tool change on layer ${layer}; each object layer must be monochrome here.`;
}

/**
 * Extract header/start G-code, unlabelled base layer commands (skirt/brim), every object's
 * layer slices (objectLayerSlices) and end G-code from a labelled toolpath.
 */
export function extractSlices(toolpathOrFile, options = {}) {
  const profile = loadProfile(options.profile || 'mk4');
  const toolpath = (toolpathOrFile && Array.isArray(toolpathOrFile.commands))
    ? toolpathOrFile
    : loadToolpath(toolpathOrFile, { ...options, profile });

  if (!toolpath.hasObjectLabels || toolpath.objects.length === 0) {
    throw new InputError(
      "Input file has no PrusaSlicer object labels ('; printing object ...'). Enable 'Label objects' in PrusaSlicer to use gcode-sequence."
    );
  }

  // How the file changes colour: M600 (single extruder), or only tool changes T<n> (MMU), in
  // which case the emitter writes T<n> and the purge/wipe tower is not regenerated.
  let sawTool = false;
  let sawM600 = false;
  for (const c of toolpath.commands) {
    if (c.inStart) continue;
    if (c.kind === 'tool') sawTool = true;
    else if (c.kind === 'm600') sawM600 = true;
  }
  const colourChangeBy = sawTool && !sawM600 ? 'T' : 'M600';

  // Check for wipe tower taller than clearance height (an MMU file's tower is dropped instead)
  const clearanceH = profile.clearance_height ?? 20;
  for (const m of colourChangeBy === 'T' ? [] : toolpath.moves) {
    if (m.extruding && m.type === 'Wipe tower' && Math.max(m.z0, m.z1) > clearanceH + EPS) {
      throw new InputError(
        `Input file has a wipe tower reaching Z=${Math.max(m.z0, m.z1).toFixed(2)} mm, above clearance height ${clearanceH} mm; unsuitable for gcode-sequence.`
      );
    }
  }

  const colourMap = parseColourSpec(options.colours ?? options.colors);
  const splitHeights = parseSplitHeights(options.splitAt);
  const segmentsByLine = buildArcSegmentIndex(toolpath);

  // Detect standard retraction distance and speed from the file if present.
  // Prefer positive unretraction (cmd.kind === 'retract' && cmd.dE > EPS) because when PrusaSlicer
  // has --wipe enabled, retraction is split across an XY wipe move + a small remainder E move,
  // whereas the unretraction is a single pure E move with the full retraction length.
  let retractLength = 0;
  let retractFeedrate = 2400;
  for (const cmd of toolpath.commands) {
    if (cmd.kind === 'retract' && cmd.dE > EPS && !cmd.inStart) {
      retractLength = cmd.dE;
      if (cmd.feedrate > 0) retractFeedrate = cmd.feedrate;
      break;
    }
  }
  if (retractLength === 0) {
    for (const cmd of toolpath.commands) {
      if (cmd.kind === 'retract' && cmd.dE < -EPS && !cmd.inStart) {
        retractLength = Math.abs(cmd.dE);
        if (cmd.feedrate > 0) retractFeedrate = cmd.feedrate;
        break;
      }
    }
  }

  // Partition commands into:
  // 1) startCommands (inStart === true)
  // 2) object layer blocks: contiguous sequences of commands inside `; printing object <name>`
  // 3) baseCommands: extruding blocks outside any object (e.g. Skirt/Brim on layer 1)
  // 4) endCommands: commands after the last extruding object block closes (or after last extruding move if unclosed)
  let lastExtrudingCmdIdx = -1;
  for (let i = toolpath.commands.length - 1; i >= 0; i--) {
    const c = toolpath.commands[i];
    if ((c.kind === 'move' || c.kind === 'arc') && c.extruding) {
      lastExtrudingCmdIdx = i;
      break;
    }
  }

  // Find the object_stop (if any) that closes the final extruding object block
  let footerStartIdx = lastExtrudingCmdIdx + 1;
  if (lastExtrudingCmdIdx >= 0 && toolpath.commands[lastExtrudingCmdIdx].object) {
    for (let i = lastExtrudingCmdIdx + 1; i < toolpath.commands.length; i++) {
      const c = toolpath.commands[i];
      if (c.kind === 'object_stop') {
        footerStartIdx = i + 1;
        break;
      }
      if (c.kind === 'object_start' || c.kind === 'layer_change') {
        footerStartIdx = i;
        break;
      }
    }
  }

  const startCommands = [];
  const endCommands = [];
  const baseCommands = [];
  const rawObjectBlocks = [];
  let currentBlock = null;

  for (let i = 0; i < toolpath.commands.length; i++) {
    const cmd = toolpath.commands[i];
    if (cmd.inStart) {
      startCommands.push(cmd);
      continue;
    }
    if (i >= footerStartIdx) {
      if (cmd.kind !== 'object_stop' && cmd.kind !== 'object_start') {
        endCommands.push(cmd);
      }
      continue;
    }

    if (cmd.kind === 'object_start') {
      currentBlock = {
        object: cmd.object,
        layer: cmd.layer,
        commands: [],
      };
      rawObjectBlocks.push(currentBlock);
      continue;
    }
    if (cmd.kind === 'object_stop') {
      currentBlock = null;
      continue;
    }
    if (cmd.kind === 'layer_change' && currentBlock) {
      // Sequential ("complete objects") slices keep one label block open across many layers;
      // cut it per layer so every object is a stack of layer slices whatever the input order.
      currentBlock = { object: currentBlock.object, layer: cmd.layer, commands: [] };
      rawObjectBlocks.push(currentBlock);
      continue;
    }

    if (currentBlock) {
      currentBlock.commands.push(cmd);
    } else {
      baseCommands.push(cmd);
    }
  }

  // Detect whether startCommands ends in a retracted state
  let startEndsRetracted = false;
  for (const cmd of startCommands) {
    if (cmd.kind === 'retract' && cmd.dE < -EPS) {
      startEndsRetracted = true;
    } else if ((cmd.kind === 'move' || cmd.kind === 'arc') && cmd.dE < -EPS) {
      startEndsRetracted = true;
    } else if ((cmd.kind === 'move' || cmd.kind === 'arc' || cmd.kind === 'retract') && cmd.dE > EPS) {
      startEndsRetracted = false;
    }
  }

  // Filter baseCommands to keep only first-layer non-object extruding blocks (like Skirt/Brim)
  // so multi-layer skirts do not tower above layer 1 before objects begin printing.
  const firstLayerZ = toolpath.layerZs.find(z => Number.isFinite(z) && z > 0) ?? 0.4;
  const baseMotionCommands = [];
  let firstBaseExt = -1;
  let lastBaseExt = -1;
  for (let i = 0; i < baseCommands.length; i++) {
    const c = baseCommands[i];
    if ((c.kind === 'move' || c.kind === 'arc') && c.extruding && Math.max(c.z0, c.z1) <= firstLayerZ + EPS) {
      if (firstBaseExt === -1) firstBaseExt = i;
      lastBaseExt = i;
    }
  }
  if (firstBaseExt !== -1) {
    for (let i = firstBaseExt; i <= lastBaseExt; i++) {
      const c = baseCommands[i];
      if ((c.kind === 'move' || c.kind === 'arc') && Math.max(c.z0, c.z1) > firstLayerZ + EPS) continue;
      if (c.kind === 'move' || c.kind === 'arc' || c.kind === 'retract' || c.kind === 'other') {
        baseMotionCommands.push(c);
      }
    }
  }
  // Everything else that extrudes outside an object label (upper skirt layers, a wipe tower
  // under the clearance height, sacrificial towers) is NOT emitted. Count it so the caller can
  // warn: "verified" only covers what was emitted.
  const keptBase = new Set(baseMotionCommands);
  const droppedNonObject = { moves: 0, extrusion_mm: 0, maxZ: 0, types: [] };
  const droppedTypes = new Set();
  for (const c of baseCommands) {
    if ((c.kind === 'move' || c.kind === 'arc') && c.extruding && !keptBase.has(c)) {
      droppedNonObject.moves++;
      droppedNonObject.extrusion_mm += c.dE;
      droppedNonObject.maxZ = Math.max(droppedNonObject.maxZ, c.z0, c.z1);
      droppedTypes.add(c.type || 'unknown');
    }
  }
  droppedNonObject.extrusion_mm = +droppedNonObject.extrusion_mm.toFixed(5);
  droppedNonObject.types = [...droppedTypes];

  // Extract clean layer slices [firstExt .. lastExt] for each non-empty object block
  const objectLayerSlices = new Map();
  const objectIndexByName = new Map();
  toolpath.objects.forEach((obj, idx) => {
    objectLayerSlices.set(obj.name, []);
    objectIndexByName.set(obj.name, idx);
  });

  // A label block is cut into sub-blocks at every tool change / M600 inside it: an object made
  // of parts on different extruders (a raised inscription on another filament) prints each part
  // as its own sub-block, and each becomes a slice with its own colour.
  let sliceOrder = 0;
  const addSlice = (block, cmds) => {
    let firstExt = -1;
    let lastExt = -1;
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      if ((c.kind === 'move' || c.kind === 'arc') && c.extruding) {
        if (firstExt === -1) firstExt = i;
        lastExt = i;
      }
    }
    if (firstExt === -1) return; // no extrusion in this (sub-)block

    // Collect any auxiliary commands (e.g. M900 K..., G4) that appeared inside `; printing object`
    // before the entry travel (0 .. firstExt - 1) so they are preserved at the start of the slice.
    let internalRetractSum = 0;
    const sliceCmds = [];
    for (let i = 0; i < firstExt; i++) {
      if (cmds[i].kind === 'other') sliceCmds.push(cmds[i]);
    }
    const sliceTools = new Set();
    for (let i = firstExt; i <= lastExt; i++) {
      const c = cmds[i];
      if (c.kind === 'retract') {
        internalRetractSum += c.dE;
        sliceCmds.push(c);
      } else if (c.kind === 'move' || c.kind === 'arc') {
        if (c.dE < -EPS) internalRetractSum += c.dE; // negative-E wipe move
        if (c.extruding) sliceTools.add(c.tool ?? 0);
        sliceCmds.push(c);
      } else if (c.kind === 'other') {
        sliceCmds.push(c);
      }
    }
    // Defensive: the tool only changes at T / M600, which cut sub-blocks above.
    if (sliceTools.size > 1) {
      throw new InputError(midLayerChangeMessage(block.object, cmds[firstExt].layer));
    }
    if (Math.abs(internalRetractSum) > 1e-2) {
      throw new InputError(
        `Object boundary for '${block.object}' on layer ${cmds[firstExt].layer} has unbalanced internal retraction (${internalRetractSum.toFixed(4)} mm); refusing to cut mid-extrusion.`
      );
    }

    const firstMoveCmd = cmds[firstExt];
    const sliceZ = Number.isFinite(firstMoveCmd.layerZ) && firstMoveCmd.layerZ > 0
      ? firstMoveCmd.layerZ
      : Math.max(firstMoveCmd.z0, firstMoveCmd.z1);
    const list = objectLayerSlices.get(block.object);
    if (!list) return;
    const objIdx = objectIndexByName.get(block.object);
    const tool = firstMoveCmd.tool ?? 0;
    list.push({
      object: block.object,
      layer: firstMoveCmd.layer,
      z: sliceZ,
      height: firstMoveCmd.height || 0.2,
      tool,
      colour: resolveObjectColour(toolpath.objects[objIdx], objIdx, colourMap, toolpath, tool),
      fileOrder: sliceOrder++,
      commands: sliceCmds,
    });
  };

  for (const block of rawObjectBlocks) {
    let start = 0;
    for (let i = 0; i < block.commands.length; i++) {
      const k = block.commands[i].kind;
      if (k === 'm600' || k === 'tool') {
        addSlice(block, block.commands.slice(start, i));
        start = i + 1;
      }
    }
    addSlice(block, block.commands.slice(start));
  }
  for (const slices of objectLayerSlices.values()) {
    slices.sort((a, b) => a.z - b.z || a.fileOrder - b.fileOrder);
  }
  // A --colours entry gives an object one colour, so it cannot also follow tool changes the file
  // makes on that object's layers (an M600 or T between its parts or layers): refuse rather than
  // merge the parts into one colour and drop the change.
  toolpath.objects.forEach((obj, idx) => {
    const mapped = mapColourFor(obj, idx, colourMap, toolpath);
    if (mapped === null) return;
    const tools = [...new Set((objectLayerSlices.get(obj.name) || []).map(sl => sl.tool))];
    if (tools.length > 1) {
      throw new InputError(
        `--colours assigns '${mapped}' to all of '${obj.name}', but the file changes tool/colour on its layers (T${tools.join(', T')}); leave it out of --colours to use the file's colours.`
      );
    }
  });

  // Build base (skirt/brim) moves for collision store painting
  const baseMoves = [];
  for (const cmd of baseMotionCommands) {
    if (cmd.kind === 'move') baseMoves.push({ ...cmd, inStart: false });
    else if (cmd.kind === 'arc') {
      for (const seg of segmentsByLine.get(cmd.line) || []) {
        baseMoves.push({ ...seg, inStart: false });
      }
    }
  }

  // Colour transitions if the file were printed in its own (layer-interleaved) order with the
  // resolved colours: the baseline the planner's filament-change count is compared against.
  const fileOrderSlices = [];
  for (const list of objectLayerSlices.values()) fileOrderSlices.push(...list);
  fileOrderSlices.sort((a, b) => a.fileOrder - b.fileOrder);
  let originalColourChanges = 0;
  for (let i = 1; i < fileOrderSlices.length; i++) {
    if (fileOrderSlices[i].colour !== fileOrderSlices[i - 1].colour) originalColourChanges++;
  }

  return {
    profile,
    toolpath,
    objectLayerSlices,
    segmentsByLine,
    splitHeights,
    colourChangeBy,
    originalColourChanges,
    droppedNonObject,
    startCommands,
    startEndsRetracted,
    baseMotionCommands,
    baseMoves,
    endCommands,
    retractLength,
    retractFeedrate,
  };
}

/**
 * The fixed-split solver's chunks: each object's slices cut at the --split-at heights and at
 * every layer where its colour changes.
 */
export function buildFixedChunks(extracted) {
  const { toolpath, objectLayerSlices, segmentsByLine, splitHeights } = extracted;
  const chunks = [];
  for (const obj of toolpath.objects) {
    const slices = objectLayerSlices.get(obj.name) || [];
    // This solver cuts objects only between layers, so each object layer must be one colour.
    for (let i = 1; i < slices.length; i++) {
      if (Math.abs(slices[i].z - slices[i - 1].z) < EPS && slices[i].colour !== slices[i - 1].colour) {
        throw new InputError(`${midLayerChangeMessage(obj.name, slices[i].layer)} (fixed-split solver; the adaptive planner prints colour regions separately)`);
      }
    }
    const objSplits = new Set(splitHeights);
    for (let i = 1; i < slices.length; i++) {
      if (slices[i].tool !== slices[i - 1].tool || slices[i].colour !== slices[i - 1].colour) {
        objSplits.add(slices[i - 1].z);
      }
    }
    const sortedSplits = [...objSplits].sort((a, b) => a - b);
    const bandBounds = [0, ...sortedSplits, Infinity];
    let prevTop = 0;
    for (let b = 0; b < bandBounds.length - 1; b++) {
      const zLo = bandBounds[b];
      const zHi = bandBounds[b + 1];
      const bandSlices = slices.filter(s => s.z > zLo + EPS && s.z <= zHi + EPS);
      if (bandSlices.length === 0) continue;
      const band = buildBandChunk(obj.name, bandSlices, segmentsByLine);
      if (!band) continue;
      chunks.push({
        index: chunks.length,
        id: sortedSplits.length > 0 ? `${obj.name} [Z<=${Number.isFinite(zHi) ? zHi : 'top'}]` : obj.name,
        objectId: obj.id,
        bandIndex: b,
        zLo: prevTop,
        ...band,
      });
      prevTop = band.top;
    }
  }
  return chunks;
}

/** extractSlices plus the fixed-split chunks (the input of buildPairwiseMatrix / solveChunkOrder). */
export function extractChunks(toolpathOrFile, options = {}) {
  const extracted = extractSlices(toolpathOrFile, options);
  extracted.chunks = buildFixedChunks(extracted);
  return extracted;
}

/**
 * Build the vertical descent + chunk moves + vertical lift for chunk j at safe height H.
 */
export function buildChunkCheckMoves(chunk, safeZ) {
  const first = chunk.moves[0] || {};
  const last = chunk.moves[chunk.moves.length - 1] || {};
  const liftZ = Math.max(safeZ, chunk.startPoint[2], chunk.endPoint[2]);
  return [
    descentMove(chunk.startPoint, liftZ, { ...first, layer: chunk.slices[0]?.layer, object: chunk.object }),
    ...chunk.moves,
    liftMove(chunk.endPoint, liftZ, { ...last, layer: chunk.slices[chunk.slices.length - 1]?.layer, object: chunk.object }),
  ];
}

/**
 * Compute the pairwise feasibility matrix ok[i][j] ("chunk j can be printed when chunk i
 * is already on the bed") and prerequisite bitmasks.
 */
export function buildPairwiseMatrix(extracted, options = {}) {
  const { profile, chunks, baseMoves } = extracted;
  const n = chunks.length;
  const zMax = profile.bed.z_max ?? 220;

  const stores = chunks.map(c => {
    const s = new DepositStore(profile, options);
    s.paint(baseMoves);
    s.paint(c.moves);
    return s;
  });

  const baseStore = new DepositStore(profile, options);
  baseStore.paint(baseMoves);

  const ok = Array.from({ length: n }, () => new Array(n).fill(true));
  const conflicts = [];

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (chunks[i].object === chunks[j].object) {
        if (chunks[i].bandIndex > chunks[j].bandIndex) {
          ok[i][j] = false;
        }
        continue;
      }

      const safeZ = Math.min(zMax, Math.max(chunks[i].top, chunks[j].top) + 1.0);
      const testMoves = buildChunkCheckMoves(chunks[j], safeZ);
      const hits = checkMoves(profile, stores[i], testMoves, { stopOnFirst: true });
      if (hits.length > 0) {
        ok[i][j] = false;
        conflicts.push({
          first: chunks[i].id,
          second: chunks[j].id,
          firstIndex: i,
          secondIndex: j,
          hit: hits[0],
        });
      }
    }
  }

  return { ok, conflicts, stores, baseStore };
}

function fmtNum(n, digits = 5) {
  const s = Number(n).toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * Emit a complete, normalised (G21 mm, G90 absolute XYZ, M83 relative E) G-code string
 * for a given chunk ordering, preserving all non-motion printer state (fan, temperatures,
 * acceleration, flow, feature type, width, height) and auxiliary commands.
 */
export function emitResequencedGcode(extracted, order) {
  const {
    profile,
    chunks,
    startCommands,
    startEndsRetracted,
    baseMotionCommands,
    endCommands,
    retractLength,
    retractFeedrate,
  } = extracted;

  const zMax = profile.bed.z_max ?? 220;
  const out = [];

  // 1) Emit original start G-code / header and track where it leaves the head & printer state
  let curX = 0, curY = 0, curZ = 0;
  let activeState = {
    fan: 0,
    hotendTemp: null,
    hotendWait: false,
    bedTemp: null,
    bedWait: false,
    accel: '',
    flow: 100,
    width: -1,
    height: -1,
    type: null,
    feedrate: -1,
  };

  for (const cmd of startCommands) {
    out.push(cmd.raw);
    if (cmd.x1 !== undefined) {
      curX = cmd.x1;
      curY = cmd.y1;
      curZ = cmd.z1;
    } else if (cmd.x !== undefined) {
      curX = cmd.x;
      curY = cmd.y;
      curZ = cmd.z;
    }
    if (cmd.state) {
      activeState.fan = cmd.state.fan;
      activeState.hotendTemp = cmd.state.hotendTemp;
      activeState.hotendWait = cmd.state.hotendWait;
      activeState.bedTemp = cmd.state.bedTemp;
      activeState.bedWait = cmd.state.bedWait;
      activeState.accel = cmd.state.accel;
      activeState.flow = cmd.state.flow;
    }
  }

  // Ensure normalised coordinate and extrusion state after start G-code:
  // G21 (millimetres), G90 (absolute XYZ), M83 (relative E), and G92 X/Y/Z/E0
  // so any G92 coordinate shift inside start_gcode is reset to true physical coordinates.
  out.push('; --- gcode-sequence normalised state ---');
  out.push('G21');
  out.push('G90');
  out.push('M83');
  out.push(`G92 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(curZ, 4)} E0`);

  const syncCommandState = (cmd) => {
    const st = cmd.state;
    if (st) {
      if (st.hotendTemp !== null && (st.hotendTemp !== activeState.hotendTemp || st.hotendWait !== activeState.hotendWait)) {
        const mCode = st.hotendWait ? 'M109' : 'M104';
        out.push(`${mCode} S${fmtNum(st.hotendTemp, 1)}`);
        activeState.hotendTemp = st.hotendTemp;
        activeState.hotendWait = st.hotendWait;
      }
      if (st.bedTemp !== null && (st.bedTemp !== activeState.bedTemp || st.bedWait !== activeState.bedWait)) {
        const mCode = st.bedWait ? 'M190' : 'M140';
        out.push(`${mCode} S${fmtNum(st.bedTemp, 1)}`);
        activeState.bedTemp = st.bedTemp;
        activeState.bedWait = st.bedWait;
      }
      if (st.fan !== activeState.fan) {
        if (st.fan <= 0) out.push('M107');
        else out.push(`M106 S${fmtNum(st.fan, 2)}`);
        activeState.fan = st.fan;
      }
      if (st.accel !== activeState.accel && st.accel) {
        out.push(`M204 ${st.accel}`);
        activeState.accel = st.accel;
      }
      if (st.flow !== activeState.flow && st.flow !== null) {
        out.push(`M221 S${fmtNum(st.flow, 2)}`);
        activeState.flow = st.flow;
      }
    }
    if (cmd.height > 0 && cmd.height !== activeState.height) {
      out.push(`;HEIGHT:${fmtNum(cmd.height, 4)}`);
      activeState.height = cmd.height;
    }
    if (cmd.width > 0 && cmd.width !== activeState.width) {
      out.push(`;WIDTH:${fmtNum(cmd.width, 6)}`);
      activeState.width = cmd.width;
    }
    if (cmd.type && cmd.type !== activeState.type) {
      out.push(`;TYPE:${cmd.type}`);
      activeState.type = cmd.type;
    }
  };

  const emitMotionCmd = (cmd) => {
    if (cmd.kind === 'other') {
      out.push(cmd.raw);
      return;
    }
    syncCommandState(cmd);
    if (cmd.kind === 'retract') {
      if (cmd.dE !== 0) {
        const fPart = cmd.feedrate > 0 ? ` F${fmtNum(cmd.feedrate, 1)}` : '';
        out.push(`G1 E${fmtNum(cmd.dE, 5)}${fPart}`);
        if (cmd.feedrate > 0) activeState.feedrate = cmd.feedrate;
      }
      return;
    }
    if (cmd.kind === 'move') {
      const fPart = cmd.feedrate > 0 && cmd.feedrate !== activeState.feedrate
        ? ` F${fmtNum(cmd.feedrate, 1)}`
        : '';
      if (cmd.feedrate > 0) activeState.feedrate = cmd.feedrate;
      const ePart = cmd.dE !== 0 ? ` E${fmtNum(cmd.dE, 5)}` : '';
      out.push(`${cmd.cmd || 'G1'} X${fmtNum(cmd.x1, 4)} Y${fmtNum(cmd.y1, 4)} Z${fmtNum(cmd.z1, 4)}${ePart}${fPart}`);
      return;
    }
    if (cmd.kind === 'arc') {
      const fPart = cmd.feedrate > 0 && cmd.feedrate !== activeState.feedrate
        ? ` F${fmtNum(cmd.feedrate, 1)}`
        : '';
      if (cmd.feedrate > 0) activeState.feedrate = cmd.feedrate;
      const iPart = cmd.i === cmd.i ? ` I${fmtNum(cmd.i, 4)}` : '';
      const jPart = cmd.j === cmd.j ? ` J${fmtNum(cmd.j, 4)}` : '';
      const rPart = cmd.r === cmd.r ? ` R${fmtNum(cmd.r, 4)}` : '';
      const ePart = cmd.dE !== 0 ? ` E${fmtNum(cmd.dE, 5)}` : '';
      out.push(`${cmd.cmd} X${fmtNum(cmd.x1, 4)} Y${fmtNum(cmd.y1, 4)} Z${fmtNum(cmd.z1, 4)}${iPart}${jPart}${rPart}${ePart}${fPart}`);
    }
  };

  let maxDepositedTop = 0;
  let isRetracted = Boolean(startEndsRetracted);
  const colourChangeCmd = (slice) => (extracted.colourChangeBy === 'T' ? `T${slice?.tool ?? 0}` : 'M600');

  const emitRetract = () => {
    if (retractLength > 0 && !isRetracted) {
      out.push(`G1 E-${fmtNum(retractLength, 5)} F${fmtNum(retractFeedrate, 1)}`);
      activeState.feedrate = retractFeedrate;
      isRetracted = true;
    }
  };

  const emitUnretract = () => {
    if (retractLength > 0 && isRetracted) {
      out.push(`G1 E${fmtNum(retractLength, 5)} F${fmtNum(retractFeedrate, 1)}`);
      activeState.feedrate = retractFeedrate;
      isRetracted = false;
    }
  };

  // 2) Emit unlabelled base layer commands (e.g. Skirt/Brim) if present
  if (baseMotionCommands.length > 0) {
    const firstBase = baseMotionCommands.find(c => c.kind === 'move' || c.kind === 'arc');
    if (firstBase) {
      const baseZ = Number.isFinite(firstBase.layerZ) && firstBase.layerZ > 0 ? firstBase.layerZ : firstBase.z0;
      out.push(';LAYER_CHANGE');
      out.push(`;Z:${fmtNum(baseZ, 3)}`);
      out.push(`;HEIGHT:${fmtNum(firstBase.height || 0.2, 3)}`);
      emitRetract();
      out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(firstBase.z0, 4)} F${DEFAULT_Z_FEEDRATE}`);
      out.push(`G0 X${fmtNum(firstBase.x0, 4)} Y${fmtNum(firstBase.y0, 4)} Z${fmtNum(firstBase.z0, 4)} F${DEFAULT_TRAVEL_FEEDRATE}`);
      activeState.feedrate = DEFAULT_TRAVEL_FEEDRATE;
      emitUnretract();
      for (const cmd of baseMotionCommands) {
        emitMotionCmd(cmd);
        if (cmd.x1 !== undefined) {
          curX = cmd.x1; curY = cmd.y1; curZ = cmd.z1;
          if (cmd.extruding && curZ > maxDepositedTop) maxDepositedTop = curZ;
        }
      }
      emitRetract();
    }
  }

  // 3) Emit each chunk in the chosen sequence
  let prevColour = null;
  for (let pos = 0; pos < order.length; pos++) {
    const chunkIdx = order[pos];
    const chunk = chunks[chunkIdx];
    const [sx, sy, sz] = chunk.startPoint;
    const safeZ = Math.min(zMax, Math.max(maxDepositedTop, sz, chunk.top) + 1.0);

    emitRetract();

    // Lift to safe plane when transitioning between chunks (or if M600 is needed, or if moving XY above deposited material)
    const needsSafeLift = pos > 0 || maxDepositedTop > 0 || (prevColour !== null && chunk.colour !== prevColour);
    if (needsSafeLift && curZ < safeZ - EPS) {
      out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(safeZ, 4)} F${DEFAULT_Z_FEEDRATE}`);
      activeState.feedrate = DEFAULT_Z_FEEDRATE;
      curZ = safeZ;
    }

    // Issue M600 (or the tool change, for an MMU file) at safe height when colour changes between chunks
    if (prevColour !== null && chunk.colour !== prevColour) {
      out.push(`; colour change: ${prevColour} -> ${chunk.colour}`);
      out.push(colourChangeCmd(chunk.slices[0]));
    }
    prevColour = chunk.colour;

    // Horizontal travel to above chunk's first point
    if (curX !== sx || curY !== sy) {
      const travelZ = needsSafeLift ? curZ : Math.max(curZ, sz);
      if (travelZ !== curZ) {
        out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(travelZ, 4)} F${DEFAULT_Z_FEEDRATE}`);
        curZ = travelZ;
      }
      out.push(`G0 X${fmtNum(sx, 4)} Y${fmtNum(sy, 4)} Z${fmtNum(curZ, 4)} F${DEFAULT_TRAVEL_FEEDRATE}`);
      activeState.feedrate = DEFAULT_TRAVEL_FEEDRATE;
      curX = sx;
      curY = sy;
    }

    // Vertical descent to chunk's first point
    if (curZ !== sz) {
      out.push(`G0 X${fmtNum(sx, 4)} Y${fmtNum(sy, 4)} Z${fmtNum(sz, 4)} F${DEFAULT_Z_FEEDRATE}`);
      activeState.feedrate = DEFAULT_Z_FEEDRATE;
      curZ = sz;
    }

    // Emit chunk slices inside `; printing object` markers (per slice: a cluster chunk
    // alternates between its member objects), one ;LAYER_CHANGE per height.
    let openObject = null;
    let prevSliceZ = null;
    for (let sIdx = 0; sIdx < chunk.slices.length; sIdx++) {
      const slice = chunk.slices[sIdx];
      const firstCmd = slice.commands.find(c => c.kind === 'move' || c.kind === 'arc');
      if (!firstCmd) continue;
      const sliceColour = slice.colour ?? chunk.colour;
      const switching = sIdx > 0 && sliceColour !== prevColour;

      if (switching) {
        // Colour change inside a chunk (a cluster of differently coloured objects): as
        // between chunks, M600 at the safe plane, then travel and descend onto the slice.
        emitRetract();
        if (openObject !== null) out.push(`; stop printing object ${openObject}`);
        openObject = null;
        const midSafeZ = Math.min(zMax, Math.max(maxDepositedTop, curZ) + 1.0);
        if (curZ < midSafeZ - EPS) {
          out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(midSafeZ, 4)} F${DEFAULT_Z_FEEDRATE}`);
          curZ = midSafeZ;
        }
        out.push(`; colour change: ${prevColour} -> ${sliceColour}`);
        out.push(colourChangeCmd(slice));
        out.push(`G0 X${fmtNum(firstCmd.x0, 4)} Y${fmtNum(firstCmd.y0, 4)} Z${fmtNum(curZ, 4)} F${DEFAULT_TRAVEL_FEEDRATE}`);
        out.push(`G0 X${fmtNum(firstCmd.x0, 4)} Y${fmtNum(firstCmd.y0, 4)} Z${fmtNum(firstCmd.z0, 4)} F${DEFAULT_Z_FEEDRATE}`);
        activeState.feedrate = DEFAULT_Z_FEEDRATE;
        curX = firstCmd.x0;
        curY = firstCmd.y0;
        curZ = firstCmd.z0;
      }
      prevColour = sliceColour;

      if (slice.object !== openObject) {
        if (openObject !== null) out.push(`; stop printing object ${openObject}`);
        out.push(`; printing object ${slice.object}`);
        openObject = slice.object;
      }
      if (slice.z !== prevSliceZ) {
        out.push(';LAYER_CHANGE');
        out.push(`;Z:${fmtNum(slice.z, 3)}`);
        out.push(`;HEIGHT:${fmtNum(slice.height || 0.2, 3)}`);
        prevSliceZ = slice.z;
      }
      activeState.height = slice.height || 0.2;
      activeState.type = null;

      if (sIdx > 0 && !switching && (curX !== firstCmd.x0 || curY !== firstCmd.y0 || curZ !== firstCmd.z0)) {
        emitRetract();
        if (curZ !== firstCmd.z0) {
          out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(firstCmd.z0, 4)} F${DEFAULT_Z_FEEDRATE}`);
          activeState.feedrate = DEFAULT_Z_FEEDRATE;
          curZ = firstCmd.z0;
        }
        if (curX !== firstCmd.x0 || curY !== firstCmd.y0) {
          out.push(`G0 X${fmtNum(firstCmd.x0, 4)} Y${fmtNum(firstCmd.y0, 4)} Z${fmtNum(curZ, 4)} F${DEFAULT_TRAVEL_FEEDRATE}`);
          activeState.feedrate = DEFAULT_TRAVEL_FEEDRATE;
          curX = firstCmd.x0;
          curY = firstCmd.y0;
        }
      }

      emitUnretract();
      for (const cmd of slice.commands) {
        emitMotionCmd(cmd);
        if (cmd.x1 !== undefined) {
          curX = cmd.x1;
          curY = cmd.y1;
          curZ = cmd.z1;
        }
      }
      emitRetract();
    }
    if (openObject !== null) out.push(`; stop printing object ${openObject}`);

    if (chunk.top > maxDepositedTop) {
      maxDepositedTop = chunk.top;
    }

    // Only lift after the chunk if there is another chunk to print OR if the final curZ is below maxDepositedTop
    if (pos + 1 < order.length || curZ < maxDepositedTop - EPS) {
      const postSafeZ = Math.min(zMax, Math.max(maxDepositedTop, curZ) + 1.0);
      if (curZ < postSafeZ - EPS) {
        out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(postSafeZ, 4)} F${DEFAULT_Z_FEEDRATE}`);
        activeState.feedrate = DEFAULT_Z_FEEDRATE;
        curZ = postSafeZ;
      }
    }
  }

  // 4) Balance chunk-glue retraction before emitting endCommands (unless start_gcode ended retracted)
  if (!startEndsRetracted) {
    emitUnretract();
  }

  // 5) Emit End G-code in normalised (G21 / G90 / M83) form so footer moves in G91, G20, or M82
  // execute with their exact resolved coordinates and extrusion deltas, and clamp any horizontal
  // park travel Z to at least maxDepositedTop so the head clears all printed objects.
  for (const cmd of endCommands) {
    if (cmd.kind === 'mode' || cmd.kind === 'g92' || cmd.kind === 'g92.1') {
      // Coordinate/extrusion modes are kept normalised (G21/G90/M83)
      continue;
    }
    if (cmd.kind === 'retract') {
      emitMotionCmd(cmd);
      continue;
    }
    if (cmd.kind === 'move' || cmd.kind === 'arc') {
      // Ensure non-extruding footer park/lift moves do not drop below maxDepositedTop
      const targetZ = !cmd.extruding && maxDepositedTop > curZ
        ? Math.min(zMax, Math.max(cmd.z1, maxDepositedTop + 1.0))
        : cmd.z1;
      if (!cmd.extruding && (cmd.x1 !== curX || cmd.y1 !== curY) && curZ < maxDepositedTop - EPS) {
        const safeParkZ = Math.min(zMax, maxDepositedTop + 1.0);
        out.push(`G0 X${fmtNum(curX, 4)} Y${fmtNum(curY, 4)} Z${fmtNum(safeParkZ, 4)} F${DEFAULT_Z_FEEDRATE}`);
        curZ = safeParkZ;
      }
      emitMotionCmd({ ...cmd, z1: Math.max(targetZ, !cmd.extruding ? curZ : targetZ) });
      curX = cmd.x1;
      curY = cmd.y1;
      curZ = Math.max(targetZ, !cmd.extruding ? curZ : targetZ);
      continue;
    }
    if (cmd.kind === 'state' || cmd.kind === 'other' || cmd.kind === 'comment' || cmd.kind === 'g28' || cmd.kind === 'm600') {
      out.push(cmd.raw);
    }
  }

  return out.join('\n') + '\n';
}

/**
 * Evaluate transition cost and filament changes for an order of chunks.
 */
export function evaluateOrderCost(chunks, order, profile) {
  let filamentChanges = 0;
  let travelDistMm = 0;
  for (let i = 0; i < order.length; i++) {
    const next = chunks[order[i]];
    filamentChanges += next.internalChanges || 0;
    if (i === 0) continue;
    const prev = chunks[order[i - 1]];
    if ((prev.lastColour ?? prev.colour) !== next.colour) filamentChanges++;
    const dx = next.startPoint[0] - prev.endPoint[0];
    const dy = next.startPoint[1] - prev.endPoint[1];
    travelDistMm += Math.hypot(dx, dy);
  }
  const travelTimeS = travelDistMm / (DEFAULT_TRAVEL_FEEDRATE / 60);
  const changeCostS = profile.change_cost_s ?? 120;
  const totalAddedTimeS = filamentChanges * changeCostS + travelTimeS;
  return {
    filamentChanges,
    travelDistMm: +travelDistMm.toFixed(2),
    travelTimeS: +travelTimeS.toFixed(2),
    totalAddedTimeS: +totalAddedTimeS.toFixed(2),
  };
}

/**
 * Check if an order [c0, c1, ..., c_{n-1}] satisfies all pairwise ok[i][j] and same-object Z-order constraints.
 */
export function isOrderPairwiseFeasible(chunks, ok, order) {
  for (let a = 0; a < order.length; a++) {
    const i = order[a];
    for (let b = a + 1; b < order.length; b++) {
      const j = order[b];
      if (!ok[i][j]) return false;
    }
  }
  return true;
}

/**
 * Constructive + backtracking search for n > 15 chunks (or fallback):
 * Note that ok[i][j] = false means "if i is printed BEFORE j, j hits i" -> so j MUST be printed BEFORE i!
 * Equivalently, j can be placed at the current prefix iff for every unplaced chunk u, ok[j][u] is true
 * OR wait: in a complete order, for every pair (a < b), we need ok[order[a]][order[b]] === true!
 * That means when we place `next` into prefix `placed`, we need:
 * 1) For every `prev` already in `placed`, `ok[prev][next] === true` (next does not hit already-placed prev), AND
 * 2) `next` does not prevent any remaining unplaced chunk from ever being placed (i.e., in the directed graph
 *    where edge u -> v means ok[u][v] === false so v must precede u, `next` must have no unplaced predecessor v with !ok[next][v]!).
 */
function findHeuristicCandidateOrders(chunks, ok, transitionScore) {
  const n = chunks.length;
  // Note: If !ok[a][b], then a cannot precede b, which means b MUST precede a in any valid total order!
  // Also if chunks[a].object === chunks[b].object && chunks[a].bandIndex < chunks[b].bandIndex, then a MUST precede b!
  const mustPrecede = Array.from({ length: n }, () => new Set());
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      if (!ok[a][b]) {
        // a cannot be before b => b must be before a
        mustPrecede[a].add(b);
      }
      if (chunks[a].object === chunks[b].object && chunks[a].bandIndex < chunks[b].bandIndex) {
        mustPrecede[b].add(a);
      }
    }
  }

  const candidates = [];
  const seenKeys = new Set();

  for (let attempt = 0; attempt < 32; attempt++) {
    const placed = [];
    const placedSet = new Set();
    let possible = true;

    while (placed.length < n) {
      const eligible = [];
      for (let j = 0; j < n; j++) {
        if (placedSet.has(j)) continue;
        let ready = true;
        for (const req of mustPrecede[j]) {
          if (!placedSet.has(req)) {
            ready = false;
            break;
          }
        }
        if (!ready) continue;
        // Also verify ok[prev][j] for all already placed
        for (const prev of placed) {
          if (!ok[prev][j]) {
            ready = false;
            break;
          }
        }
        if (ready) eligible.push(j);
      }

      if (eligible.length === 0) {
        possible = false;
        break;
      }

      const last = placed.length > 0 ? placed[placed.length - 1] : -1;
      eligible.sort((a, b) => {
        if (last !== -1) {
          const sameColA = chunks[a].colour === chunks[last].colour ? 0 : 1;
          const sameColB = chunks[b].colour === chunks[last].colour ? 0 : 1;
          if (sameColA !== sameColB) return sameColA - sameColB;
        }
        if (attempt % 2 === 0 && chunks[a].bandIndex !== chunks[b].bandIndex) {
          return chunks[a].bandIndex - chunks[b].bandIndex;
        }
        if (chunks[a].top !== chunks[b].top) return chunks[a].top - chunks[b].top;
        return last !== -1 ? transitionScore(last, a) - transitionScore(last, b) : a - b;
      });

      const pickIdx = attempt === 0 ? 0 : Math.min(eligible.length - 1, Math.floor(((attempt * 7 + placed.length * 13) % 100) / 100 * Math.min(3, eligible.length)));
      const pick = eligible[pickIdx];
      placed.push(pick);
      placedSet.add(pick);
    }

    if (possible && isOrderPairwiseFeasible(chunks, ok, placed)) {
      // Improve with 1-opt relocate local search
      let best = placed;
      let bestScore = 0;
      for (let i = 1; i < n; i++) bestScore += transitionScore(best[i - 1], best[i]);

      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const nextOrder = [...best];
            const [item] = nextOrder.splice(i, 1);
            nextOrder.splice(j, 0, item);
            if (!isOrderPairwiseFeasible(chunks, ok, nextOrder)) continue;
            let score = 0;
            for (let k = 1; k < n; k++) score += transitionScore(nextOrder[k - 1], nextOrder[k]);
            if (score + EPS < bestScore) {
              best = nextOrder;
              bestScore = score;
              improved = true;
            }
          }
        }
      }

      const key = best.join(',');
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        candidates.push({ order: best, cost: bestScore });
      }
    }
  }

  candidates.sort((a, b) => a.cost - b.cost);
  return candidates.map(c => c.order);
}

/**
 * Solve for the minimum-cost collision-free chunk order:
 * - For n <= 15: exact Held-Karp dynamic programming over subsets O(2^n * n^2).
 * - For n > 15: multi-start topological greedy + 1-opt relocate local search.
 * Every candidate returned by the solver is verified end-to-end by running Phase 1 checkToolpath
 * on the emitted G-code.
 */
export function solveChunkOrder(extracted, matrixInfo, options = {}) {
  const { profile, chunks } = extracted;
  const { ok, conflicts } = matrixInfo;
  const n = chunks.length;

  if (n === 0) {
    return { feasible: false, reason: 'No print chunks found in input', diagnostics: [] };
  }

  // Estimate base print time from extruding & internal moves
  const basePrintTimeS = movesPrintTime(chunks.flatMap(c => c.moves));

  if (n === 1) {
    const order = [0];
    const gcode = emitResequencedGcode(extracted, order);
    const verification = checkToolpath(gcode, profile, { ...options, isText: true });
    if (!verification.collides) {
      const costInfo = evaluateOrderCost(chunks, order, profile);
      return {
        feasible: true,
        order,
        gcode,
        verification,
        ...costInfo,
        estimatedTimeS: +(basePrintTimeS + costInfo.totalAddedTimeS).toFixed(1),
      };
    }
    return { feasible: false, reason: 'Single chunk collided during verification', diagnostics: verification.events };
  }

  const changeWeight = 1e6; // Lexicographic priority: filament changes first, then travel distance
  const transitionScore = (u, v) => {
    const change = chunks[u].colour !== chunks[v].colour ? changeWeight : 0;
    const dist = Math.hypot(
      chunks[v].startPoint[0] - chunks[u].endPoint[0],
      chunks[v].startPoint[1] - chunks[u].endPoint[1]
    );
    return change + dist;
  };

  let candidateOrders = [];

  if (n <= 15) {
    const forbiddenBefore = new Int32Array(n);
    const prereqMask = new Int32Array(n);
    for (let j = 0; j < n; j++) {
      let fb = 0;
      let pr = 0;
      for (let i = 0; i < n; i++) {
        if (i === j) continue;
        if (!ok[i][j]) fb |= (1 << i);
        if (chunks[i].object === chunks[j].object && chunks[i].bandIndex < chunks[j].bandIndex) {
          pr |= (1 << i);
        }
      }
      forbiddenBefore[j] = fb;
      prereqMask[j] = pr;
    }

    const numStates = 1 << n;
    const dp = new Float64Array(numStates * n).fill(Infinity);
    const parent = new Int32Array(numStates * n).fill(-1);

    for (let i = 0; i < n; i++) {
      if (prereqMask[i] === 0) {
        dp[(1 << i) * n + i] = 0;
      }
    }

    for (let mask = 1; mask < numStates; mask++) {
      const baseOff = mask * n;
      for (let last = 0; last < n; last++) {
        const curCost = dp[baseOff + last];
        if (curCost === Infinity) continue;

        for (let next = 0; next < n; next++) {
          const bit = 1 << next;
          if (mask & bit) continue;
          if (mask & forbiddenBefore[next]) continue;
          if ((mask & prereqMask[next]) !== prereqMask[next]) continue;

          const nextMask = mask | bit;
          const nextIdx = nextMask * n + next;
          const candCost = curCost + transitionScore(last, next);
          if (candCost < dp[nextIdx]) {
            dp[nextIdx] = candCost;
            parent[nextIdx] = last;
          }
        }
      }
    }

    const fullMask = numStates - 1;
    const fullOff = fullMask * n;
    const endCandidates = [];
    for (let last = 0; last < n; last++) {
      if (dp[fullOff + last] < Infinity) {
        endCandidates.push({ last, cost: dp[fullOff + last] });
      }
    }
    endCandidates.sort((a, b) => a.cost - b.cost);

    for (const cand of endCandidates) {
      const order = new Array(n);
      let mask = fullMask;
      let cur = cand.last;
      for (let p = n - 1; p >= 0; p--) {
        order[p] = cur;
        const prev = parent[mask * n + cur];
        mask ^= (1 << cur);
        cur = prev;
      }
      candidateOrders.push(order);
    }
  } else {
    candidateOrders = findHeuristicCandidateOrders(chunks, ok, transitionScore);
  }

  // Verify candidates with the Phase 1 oracle (checkToolpath on emitted G-code)
  let lastVerificationFailure = null;
  for (const order of candidateOrders) {
    const gcode = emitResequencedGcode(extracted, order);
    const verification = checkToolpath(gcode, profile, { ...options, isText: true });
    if (!verification.collides) {
      const costInfo = evaluateOrderCost(chunks, order, profile);
      return {
        feasible: true,
        order,
        gcode,
        verification,
        ...costInfo,
        estimatedTimeS: +(basePrintTimeS + costInfo.totalAddedTimeS).toFixed(1),
      };
    }
    lastVerificationFailure = verification;
  }

  // Build diagnostics explaining why no collision-free order exists
  const mutualConflicts = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!ok[i][j] && !ok[j][i]) {
        const hitIJ = conflicts.find(c => c.firstIndex === i && c.secondIndex === j)?.hit;
        const hitJI = conflicts.find(c => c.firstIndex === j && c.secondIndex === i)?.hit;
        mutualConflicts.push({
          chunkA: chunks[i].id,
          chunkB: chunks[j].id,
          objectA: chunks[i].object,
          objectB: chunks[j].object,
          partAtoB: hitIJ?.part || 'unknown',
          penetrationAtoB_mm: hitIJ?.penetration_mm || 0,
          partBtoA: hitJI?.part || 'unknown',
          penetrationBtoA_mm: hitJI?.penetration_mm || 0,
          suggestion: `Chunks '${chunks[i].id}' (top ${chunks[i].top} mm) and '${chunks[j].id}' (top ${chunks[j].top} mm) collide in both orders; try --split-at ${profile.clearance_height || 20} or move the objects apart on the plate.`,
        });
      }
    }
  }

  return {
    feasible: false,
    reason: mutualConflicts.length > 0
      ? `Infeasible plate: ${mutualConflicts.length} mutually colliding chunk pair(s)`
      : (lastVerificationFailure ? 'Candidate orders failed full toolpath verification' : 'No collision-free topological ordering exists'),
    diagnostics: mutualConflicts.length > 0 ? mutualConflicts : conflicts,
    verification: lastVerificationFailure,
  };
}
