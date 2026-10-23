#!/usr/bin/env node
// gcode-sequence.mjs: Phase 2 multicolour chunk sequencer CLI.
import fs from 'node:fs';
import { loadProfile } from './lib/profiles.mjs';
import { sequenceToolpath } from './lib/sequence.mjs';

function printUsage(stream = process.stdout) {
  stream.write(
    `Usage: gcode-sequence INPUT.(gcode|bgcode) [OUTPUT.gcode] [options]\n` +
    `  -o, --output PATH         Write resequenced G-code to PATH\n` +
    `  --printer NAME|PATH       Printer profile name ('mk4') or JSON/YAML file (default: mk4)\n` +
    `  --colours SPEC            Colour assignment: "c1,c2,..." or "ObjA=c1,ObjB=c2"\n` +
    `  --colors SPEC             Alias for --colours\n` +
    `  --split-at HEIGHTS        Z split heights in mm (e.g. "20" or "20,40" or "clearance")\n` +
    `  --grid MM                 Deposited-material grid cell size in mm (default: 1.0)\n` +
    `  --margin MM               Safety clearance margin in mm (default: 0.5)\n` +
    `  --json [PATH]             Also write JSON report to PATH (or stdout if no path / "-")\n` +
    `  -h, --help                Print CLI usage help\n` +
    `\n` +
    `Prints a JSON sequencing report to stdout.\n` +
    `Exit status: 0 = feasible sequence emitted/verified, 1 = infeasible plate, 2 = error.\n`
  );
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

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    printer: 'mk4',
    colours: null,
    splitAtRaw: null,
    grid: 1.0,
    margin: 0.5,
    json: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '-o' || arg === '--output') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a file path`);
      opts.output = argv[++i];
    } else if (arg.startsWith('--output=')) {
      opts.output = arg.slice('--output='.length);
    } else if (arg === '--printer') {
      if (i + 1 >= argv.length) throw new Error('--printer requires a value');
      opts.printer = argv[++i];
    } else if (arg.startsWith('--printer=')) {
      opts.printer = arg.slice('--printer='.length);
    } else if (arg === '--colours' || arg === '--colors') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
      opts.colours = argv[++i];
    } else if (arg.startsWith('--colours=')) {
      opts.colours = arg.slice('--colours='.length);
    } else if (arg.startsWith('--colors=')) {
      opts.colours = arg.slice('--colors='.length);
    } else if (arg === '--split-at') {
      if (i + 1 >= argv.length) throw new Error('--split-at requires height(s) in mm');
      opts.splitAtRaw = argv[++i];
    } else if (arg.startsWith('--split-at=')) {
      opts.splitAtRaw = arg.slice('--split-at='.length);
    } else if (arg === '--grid') {
      if (i + 1 >= argv.length) throw new Error('--grid requires a value');
      opts.grid = Number(argv[++i]);
    } else if (arg.startsWith('--grid=')) {
      opts.grid = Number(arg.slice('--grid='.length));
    } else if (arg === '--margin') {
      if (i + 1 >= argv.length) throw new Error('--margin requires a value');
      opts.margin = Number(argv[++i]);
    } else if (arg.startsWith('--margin=')) {
      opts.margin = Number(arg.slice('--margin='.length));
    } else if (arg === '--json') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        opts.json = argv[++i];
      } else {
        opts.json = '-';
      }
    } else if (arg.startsWith('--json=')) {
      opts.json = arg.slice('--json='.length) || '-';
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.input) {
      opts.input = arg;
    } else if (!opts.output) {
      opts.output = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.grid) || opts.grid <= 0) {
    throw new Error(`Invalid --grid value: ${opts.grid}`);
  }
  if (!Number.isFinite(opts.margin) || opts.margin < 0) {
    throw new Error(`Invalid --margin value: ${opts.margin}`);
  }

  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`gcode-sequence: ${err.message}`);
    printUsage(process.stderr);
    process.exit(2);
  }

  if (opts.help || !opts.input) {
    printUsage(opts.help ? process.stdout : process.stderr);
    process.exit(opts.help ? 0 : 2);
  }

  if (!fs.existsSync(opts.input)) {
    console.error(`gcode-sequence: Input file not found: ${opts.input}`);
    process.exit(2);
  }

  let profile;
  let splitAt;
  try {
    profile = loadProfile(opts.printer);
    splitAt = parseSplitHeightsArg(opts.splitAtRaw, profile);
  } catch (err) {
    console.error(`gcode-sequence: ${err.message}`);
    process.exit(2);
  }

  let result;
  try {
    result = sequenceToolpath(opts.input, {
      profile,
      colours: opts.colours,
      splitAt,
      grid: opts.grid,
      margin: opts.margin,
    });
  } catch (err) {
    console.error(`gcode-sequence: ${err.message}`);
    process.exit(2);
  }

  for (const w of result.warnings || []) {
    console.error(`gcode-sequence warning: ${w}`);
  }

  if (result.feasible && opts.output) {
    fs.writeFileSync(opts.output, result.gcode);
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
        chunks: result.chunks,
        output: opts.output || null,
      }
    : {
        feasible: false,
        printer: result.printer,
        warnings: result.warnings,
        reason: result.reason,
        diagnostics: result.diagnostics,
        chunks: result.chunks,
      };

  const jsonStr = JSON.stringify(report, null, 2);
  if (opts.json && opts.json !== '-') {
    fs.writeFileSync(opts.json, jsonStr + '\n');
  }
  console.log(jsonStr);
  process.exitCode = result.feasible ? 0 : 1;
}

main().catch((err) => {
  console.error('gcode-sequence: ' + (err.stack || err.message));
  process.exitCode = 2;
});
