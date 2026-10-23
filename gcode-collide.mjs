#!/usr/bin/env node
// gcode-collide.mjs: Phase 1 print-head collision checker CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadProfile, checkToolpath } from './lib/collide.mjs';

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      printer: { type: 'string', default: 'mk4' },
      grid: { type: 'string', default: '1.0' },
      margin: { type: 'string', default: '0.5' },
      json: { type: 'string' },
      png: { type: 'string' },
    },
  });
} catch (err) {
  console.error(`gcode-collide: ${err.message}`);
  process.exit(2);
}

const { values, positionals } = parsed;

if (values.help || positionals.length !== 1) {
  console.log(`Usage: gcode-collide INPUT.(gcode|bgcode) [options]
  --printer NAME|PATH   Printer profile name ('mk4') or JSON/YAML file (default: mk4)
  --grid MM             Deposited-material grid cell size in mm (default: 1.0)
  --margin MM           Horizontal safety margin added to deposited widths in mm (default: 0.5)
  --json PATH           Also write JSON collision report to PATH
  --png PATH            Render deposited geometry with offending head position overlaid to PATH
  -h, --help            Print CLI usage help

Prints a JSON collision report to stdout.
Exit status: 0 = no collision, 1 = collision detected, 2 = error.`);
  process.exit(values.help ? 0 : 2);
}

async function main() {
  const input = positionals[0];
  if (!fs.existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  const grid = Number(values.grid);
  const margin = Number(values.margin);
  if (!(grid > 0 && Number.isFinite(grid))) {
    throw new Error(`Invalid --grid value: ${values.grid}`);
  }
  if (!(margin >= 0 && Number.isFinite(margin))) {
    throw new Error(`Invalid --margin value: ${values.margin}`);
  }

  const profile = loadProfile(values.printer);
  const result = checkToolpath(input, profile, { grid, margin });

  for (const w of result.warnings) {
    console.error(`gcode-collide warning: ${w}`);
  }

  // Strip rawEvents from serialized JSON output to keep report compact (events has collapsed ranges)
  const report = {
    collides: result.collides,
    printer: result.printer,
    unmeasured_parts: result.unmeasured_parts,
    warnings: result.warnings,
    events: result.events.map(({ lines, ...rest }) => rest),
    objects: result.objects,
    summary: result.summary,
  };

  if (values.png) {
    const sheetBin = process.env.GCODE_SHEET_BIN;
    const cmd = sheetBin || process.execPath;
    const prefix = sheetBin ? [] : [fileURLToPath(new URL('./gcode-sheet.mjs', import.meta.url))];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-collide-png-'));
    try {
      const args = [...prefix, input, values.png];
      if (result.events.length > 0) {
        const firstEv = result.events[0];
        const overlayFile = path.join(tmpDir, 'overlay.json');
        fs.writeFileSync(overlayFile, JSON.stringify({
          profile,
          event: firstEv,
          grid,
        }));
        args.push('--overlay', overlayFile, '--end-line', String(firstEv.line));
      }
      execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
      report.png = values.png;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const jsonStr = JSON.stringify(report, null, 2);
  if (values.json) {
    fs.writeFileSync(values.json, jsonStr + '\n');
  }
  console.log(jsonStr);
  process.exitCode = result.collides ? 1 : 0;
}

main().catch(err => {
  console.error('gcode-collide: ' + (err.stack || err.message));
  process.exitCode = 2;
});
