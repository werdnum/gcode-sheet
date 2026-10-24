#!/usr/bin/env node
// gcode-sequence.mjs: Phase 2 multicolour print planner CLI.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadProfile } from './lib/profiles.mjs';
import { InputError } from './lib/sequence.mjs';
import { sequenceToolpath, DEFAULT_MAX_CANDIDATES, DEFAULT_MAX_STATES, DEFAULT_BEAM } from './lib/plan.mjs';

const USAGE = `Usage: gcode-sequence INPUT.(gcode|bgcode) [OUTPUT.gcode] [options]
  -o, --output PATH         Write resequenced G-code to PATH
  --printer NAME|PATH       Printer profile name ('mk4') or JSON/YAML file (default: mk4)
  --colours SPEC            Colour assignment: "c1,c2,..." or "ObjA=c1,ObjB=c2"
  --colors SPEC             Alias for --colours
  --split-at HEIGHTS        Extra candidate split heights in mm (e.g. "20", "20,40" or "clearance")
  --grid MM                 Deposited-material grid cell size in mm (default: 1.0)
  --margin MM               Safety clearance margin in mm (default: 0.5)
  --max-candidates N        Candidate pause heights per object (default: ${DEFAULT_MAX_CANDIDATES})
  --max-states N            A* expansion limit before falling back to beam search (default: ${DEFAULT_MAX_STATES})
  --beam N                  Beam width of the fallback search (default: ${DEFAULT_BEAM})
  --planner adaptive|fixed  'fixed' = old solver over --split-at chunks only (default: adaptive)
  --json PATH               Write the JSON report to PATH ('-' = stdout instead of the text report)
  -h, --help                Print CLI usage help

Prints a human-readable plan to stdout (or JSON with --json -).
Exit status: 0 = feasible plan emitted/verified, 1 = infeasible plate, 2 = error.
`;

function fail(msg) {
  console.error(`gcode-sequence: ${msg}`);
  process.exit(2);
}

function parseSplitHeightsArg(raw, profile) {
  if (!raw) return [];
  const heights = [];
  for (const token of String(raw).split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (trimmed === 'clearance' || trimmed === 'auto') {
      heights.push(profile?.clearance_height ?? 20);
    } else {
      const val = Number(trimmed);
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error(`Invalid --split-at height: ${trimmed}`);
      }
      heights.push(val);
    }
  }
  return heights;
}

function positiveNumber(name, raw, { integer = false, allowZero = false } = {}) {
  const v = Number(raw);
  const ok = Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) && (!integer || Number.isInteger(v));
  if (!ok) throw new Error(`Invalid --${name} value: ${raw}`);
  return v;
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return '-';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}

function plannerLine(p) {
  if (!p) return '';
  if (p.name === 'fixed') {
    return p.fallback_from ? ' (fixed-split solver; the adaptive planner found no verified plan)' : ' (fixed-split solver)';
  }
  if (!p.method) return '';
  return ` (${p.method === 'astar' ? 'A*' : p.method}${p.changes_optimal ? ', fewest changes over the candidate heights' : ''}, ${p.states_explored} states)`;
}

function textReport(input, report) {
  const out = [];
  out.push(`gcode-sequence: ${input} (${report.printer})`);
  for (const c of report.clusters || []) {
    out.push(`Printed layer by layer (too close to print apart): ${c.objects.join(' + ')}`);
  }
  if (!report.feasible) {
    out.push(`INFEASIBLE: ${report.reason}`);
    for (const d of report.diagnostics || []) {
      out.push(`  - ${d.suggestion || JSON.stringify(d)}`);
    }
    return out.join('\n');
  }
  if (report.pass_through) {
    out.push(`No improvement: keeping the file's own order (${report.filament_changes} filament change(s), est. ${fmtTime(report.estimated_time_s)}); ${report.planner.reason}.`);
    out.push(`Verified collision-free: ${report.verified ? 'yes' : 'NO'}`);
    if (report.output) out.push(`Output: ${report.output} (a copy of the input)`);
    return out.join('\n');
  }
  out.push(`Plan: ${report.steps.length} step(s), ${report.filament_changes} filament change(s), est. ${fmtTime(report.estimated_time_s)}${plannerLine(report.planner)}`);
  const nameW = Math.max(6, ...report.steps.map(s => s.object.length));
  out.push(`   #  ${'object'.padEnd(nameW)}  ${'Z from'.padStart(7)}  ${'Z to'.padStart(7)}  colour`);
  let prev = null;
  report.steps.forEach((s, i) => {
    if (prev !== null && s.colour !== prev) out.push(`      -- M600: ${prev} -> ${s.colour}`);
    prev = s.end_colour ?? s.colour;
    const zl = Number(s.z_lo).toFixed(2).padStart(7);
    const zh = Number(s.z_hi).toFixed(2).padStart(7);
    const colour = s.colour_changes_within
      ? `${s.colour} ... ${s.end_colour} (${s.colour_changes_within} M600 within, per layer)`
      : s.colour;
    out.push(`  ${String(i + 1).padStart(2)}  ${s.object.padEnd(nameW)}  ${zl}  ${zh}  ${colour}`);
  });
  const c = report.comparison;
  if (c) {
    out.push('Compared with:');
    out.push(`  file order          ${c.original_file.filament_changes} change(s), ${fmtTime(c.original_file.estimated_time_s)}`);
    if (c.sequential_objects) {
      const seq = c.sequential_objects.feasible
        ? `${c.sequential_objects.filament_changes} change(s), ${fmtTime(c.sequential_objects.estimated_time_s)} (not verified)`
        : 'infeasible (not verified)';
      out.push(`  sequential objects  ${seq}`);
    }
  }
  out.push(`Verified collision-free: ${report.verified ? 'yes' : 'NO'}`);
  if (report.output) out.push(`Output: ${report.output}`);
  return out.join('\n');
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      output: { type: 'string', short: 'o' },
      printer: { type: 'string', default: 'mk4' },
      colours: { type: 'string' },
      colors: { type: 'string' },
      'split-at': { type: 'string' },
      grid: { type: 'string', default: '1.0' },
      margin: { type: 'string', default: '0.5' },
      'max-candidates': { type: 'string' },
      'max-states': { type: 'string' },
      beam: { type: 'string' },
      planner: { type: 'string', default: 'adaptive' },
      json: { type: 'string' },
    },
  });
} catch (err) {
  console.error(`gcode-sequence: ${err.message}`);
  process.stderr.write(USAGE);
  process.exit(2);
}

const { values, positionals } = parsed;
if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (positionals.length < 1 || positionals.length > 2) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const input = positionals[0];
const output = values.output ?? positionals[1] ?? null;
if (values.output && positionals[1]) fail('give the output either as -o PATH or as the second positional, not both');
if (values.json && values.json !== '-') {
  const same = (a, b) => a && b && path.resolve(a) === path.resolve(b);
  if (same(values.json, input) || same(values.json, output)) {
    fail(`--json ${values.json} would overwrite the ${same(values.json, input) ? 'input' : 'output'} file`);
  }
}

let profile;
let options;
// Everything in this block validates user input, so a one-line message is enough.
try {
  if (!fs.existsSync(input)) throw new Error(`Input file not found: ${input}`);
  if (!['adaptive', 'fixed'].includes(values.planner)) throw new Error(`Invalid --planner value: ${values.planner}`);
  profile = loadProfile(values.printer);
  options = {
    profile,
    colours: values.colours ?? values.colors ?? null,
    splitAt: parseSplitHeightsArg(values['split-at'], profile),
    grid: positiveNumber('grid', values.grid),
    margin: positiveNumber('margin', values.margin, { allowZero: true }),
    planner: values.planner,
  };
  if (values['max-candidates'] !== undefined) options.maxCandidates = positiveNumber('max-candidates', values['max-candidates'], { integer: true });
  if (values['max-states'] !== undefined) options.maxStates = positiveNumber('max-states', values['max-states'], { integer: true });
  if (values.beam !== undefined) options.beam = positiveNumber('beam', values.beam, { integer: true });
} catch (err) {
  fail(err.message);
}

let result;
try {
  result = sequenceToolpath(input, options);
} catch (err) {
  // Problems with the input file get a one-line message; anything else is a bug: keep the stack.
  if (err instanceof InputError) fail(err.message);
  console.error(`gcode-sequence: ${err.stack || err.message}`);
  process.exit(2);
}

for (const w of result.warnings || []) {
  console.error(`gcode-sequence warning: ${w}`);
}

if (result.feasible && output) {
  // A pass-through of a .bgcode input has no text: copy the input file as is.
  if (result.gcode === null && result.pass_through) fs.copyFileSync(input, output);
  else fs.writeFileSync(output, result.gcode);
}

const report = result.feasible
  ? {
      feasible: true,
      verified: result.verified,
      printer: result.printer,
      warnings: result.warnings,
      order: result.order,
      filament_changes: result.filament_changes,
      travel_distance_mm: result.travel_distance_mm,
      estimated_time_s: result.estimated_time_s,
      pass_through: result.pass_through || false,
      steps: result.steps,
      clusters: result.clusters,
      planner: result.planner,
      comparison: result.comparison,
      output,
    }
  : {
      feasible: false,
      printer: result.printer,
      warnings: result.warnings,
      reason: result.reason,
      diagnostics: result.diagnostics,
      clusters: result.clusters,
      planner: result.planner,
      comparison: result.comparison,
    };

const jsonStr = JSON.stringify(report, null, 2);
if (values.json === '-') {
  console.log(jsonStr);
} else {
  if (values.json) fs.writeFileSync(values.json, jsonStr + '\n');
  console.log(textReport(input, report));
}
process.exitCode = result.feasible ? 0 : 1;
