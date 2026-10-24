import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-sheet-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let serial = 0;

function render(gcode, flags = []) {
  const base = path.join(dir, String(serial++));
  fs.writeFileSync(base + '.gcode', gcode);
  const cli = process.env.GCODE_SHEET_BIN;
  const command = cli || process.execPath;
  const prefix = cli ? [] : [fileURLToPath(new URL('../gcode-sheet.mjs', import.meta.url))];
  const summary = JSON.parse(execFileSync(command, [
    ...prefix, base + '.gcode', base + '.png',
    '--size', '160', '--views', 'top', '--no-labels', '--detail', 'full', ...flags,
  ], { encoding: 'utf8', timeout: 30000 }));
  const png = fs.readFileSync(base + '.png');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 160);
  assert.equal(png.readUInt32BE(20), 128);
  delete summary.output;
  return { summary, png };
}

function sameRender(a, b) {
  assert.deepEqual(a.summary, b.summary);
  assert.deepEqual(a.png, b.png);
}

test('markerless G-code renders by default, including a final unterminated line', () => {
  const code = 'G90\nM83\nG0 X0 Y0 Z0.2\nG1 X10 E1\nG1 Y10 E1';
  const result = render(code);
  assert.deepEqual(result.summary.bbox_mm, { x: [0, 10], y: [0, 10], z: [0.2, 0.2] });
  sameRender(result, render(code, ['--include-start']));
});

for (const marker of [';LAYER_CHANGE', ';LAYER:0']) {
  test(marker + ' excludes purge geometry while preserving absolute extrusion state', () => {
    const code = [
      'G90', 'M82', 'G1 X100 E10', '  ' + marker,
      'G0 X0 Y0 Z0.2', 'G1 X500 E9', // Retraction after the hidden purge.
      'G0 X0', 'G1 X10 E11', 'G1 Y10 E12', '',
    ].join('\r\n');
    const result = render(code);
    assert.deepEqual(result.summary.bbox_mm, { x: [0, 10], y: [0, 10], z: [0.2, 0.2] });
    assert.equal(result.summary.layers, 1);
    assert.equal(render(code, ['--include-start']).summary.bbox_mm.x[1], 100);
  });
}

test('layer markers survive read-buffer boundaries and Cura layers are counted', () => {
  // Split the first marker between the two 256 KiB reads.
  const padding = ';' + 'x'.repeat(256 * 1024 - 5) + '\n';
  const result = render(padding + [
    ';LAYER:0', 'M83', 'G0 Z0.2', 'G1 X10 E1',
    ';LAYER:1', 'G0 Z0.4', 'G1 Y10 E1', '',
  ].join('\n'));
  assert.equal(result.summary.layers, 2);
  assert.deepEqual(result.summary.bbox_mm.z, [0.2, 0.4]);
});

test('G91 moves and G90 targets honor G92 offsets without changing M83 mode', () => {
  const relative = render([
    'G90', 'M83', 'G0 X100 Y100 Z0.2', 'G92 X10 Y20 Z0',
    'G91', 'G1 X1 Y2 E1', 'G90', 'G1 X12 Y24 Z0 E1',
  ].join('\n'));
  const absolute = render('G90\nM83\nG0 X100 Y100 Z0.2\nG1 X101 Y102 E1\nG1 X102 Y104 E1');
  assert.deepEqual(relative.summary.bbox_mm, { x: [100, 102], y: [100, 104], z: [0.2, 0.2] });
  sameRender(relative, absolute);
});

test('inch coordinates, G92 offsets and E values remain consistent across G21', () => {
  const inches = render([
    'G20', 'M82', 'G0 X1 Y1 Z0.01', 'G92 X0 Y0 E0',
    'G1 X1 Y0 E0.1', 'G21', 'G1 X25.4 Y25.4 E5.08',
  ].join('\n'));
  const mm = render([
    'G21', 'M82', 'G0 X25.4 Y25.4 Z0.254', 'G92 X0 Y0 E0',
    'G1 X25.4 Y0 E2.54', 'G1 X25.4 Y25.4 E5.08',
  ].join('\n'));
  sameRender(inches, mm);
  assert.deepEqual(inches.summary.bbox_mm.x, [25.4, 50.8]);
});

for (const arc of ['I-1 J0', 'R1', 'R-1']) {
  test('inch arc ' + arc + ' matches its millimetre equivalent', () => {
    const mmArc = { 'I-1 J0': 'I-25.4 J0', R1: 'R25.4', 'R-1': 'R-25.4' }[arc];
    sameRender(
      render('G20\nM83\nG0 X1 Y0 Z0.01\nG3 X0 Y1 ' + arc + ' E1'),
      render('G21\nM83\nG0 X25.4 Y0 Z0.254\nG3 X0 Y25.4 ' + mmArc + ' E25.4'),
    );
  });
}

for (const command of ['G2', 'G3']) {
  test(command + ' distinguishes minor and major signed-radius arcs', () => {
    const prefix = 'M83\nG0 Z0.2\n' + command + ' X10 Y0 ';
    const minor = render(prefix + 'R10 E1', ['--arc-tol', '0.001']);
    const major = render(prefix + 'R-10 E1', ['--arc-tol', '0.001']);
    assert.deepEqual(minor.summary.bbox_mm.x, [0, 10]);
    assert.deepEqual(major.summary.bbox_mm.x, [-5, 15]);
    const extent = bbox => Math.max(Math.abs(bbox.y[0]), Math.abs(bbox.y[1]));
    assert.ok(extent(minor.summary.bbox_mm) < 1.35);
    assert.ok(extent(major.summary.bbox_mm) > 18.65);
  });
}

test('I/J full circles do not require explicit endpoint coordinates', () => {
  const prefix = 'M83\nG0 X10 Y0 Z0.2\n';
  const implicit = render(prefix + 'G2 I-10 J0 E1', ['--arc-tol', '0.001']);
  const explicit = render(prefix + 'G2 X10 Y0 I-10 J0 E1', ['--arc-tol', '0.001']);
  assert.deepEqual(implicit.summary.bbox_mm.x, [-10, 10]);
  sameRender(implicit, explicit);
});

test('shell filtering preserves absolute extrusion state for the next visible feature', () => {
  const result = render([
    'M82', ';LAYER_CHANGE', 'G0 Z0.2', ';TYPE:External perimeter', 'G1 X10 E1',
    ';LAYER_CHANGE', 'G0 Z0.4', ';TYPE:Internal infill', 'G1 X500 E10',
    ';TYPE:External perimeter', 'G0 X0', 'G1 X400 E9', 'G0 X0', 'G1 X20 E11',
  ].join('\n'), ['--detail', 'shell']);
  assert.deepEqual(result.summary.bbox_mm.x, [0, 20]);
});

test('feature colours report the physical slot across multiple feature groups', () => {
  const code = [
    'T2', 'M83', 'G0 Z0.2', ';TYPE:External perimeter', 'G1 X10 E1',
    ';TYPE:Internal infill', 'G1 Y10 E1', ';TYPE:Top solid infill', 'G1 X0 E1',
  ].join('\n');
  const result = render(code, ['--color-by', 'feature']);
  assert.deepEqual(result.summary.tools, [2]);
  assert.deepEqual(result.summary.legend, [
    'External perimeter=#F59E0B', 'Sparse infill=#B91C1C', 'Solid / top infill=#A855F7',
  ]);
  const otherSlot = render(code.replace('T2', 'T4'), ['--color-by', 'feature']);
  assert.deepEqual(otherSlot.summary.tools, [4]);
  assert.deepEqual(result.png, otherSlot.png);
});

test('a slot change within one feature records both extruding slots', () => {
  const code = [
    'T2', 'M83', 'G0 Z0.2', ';TYPE:External perimeter', 'G1 X10 E1',
    'T4', 'G1 X20 E1', 'T6',
  ].join('\n');
  const result = render(code, ['--color-by', 'feature']);
  assert.deepEqual(result.summary.tools, [2, 4]);
  assert.deepEqual(result.summary.legend, ['External perimeter=#F59E0B']);
  const singleSlot = render(code.replace('T4', 'T2'), ['--color-by', 'feature']);
  assert.deepEqual(result.png, singleSlot.png);
});

for (const mode of ['tool', 'feature']) {
  test(mode + ' mode tracks explicit and implicit M600 slots and ignores startup changes', () => {
    const result = render([
      'T2', 'M83', 'M600 T7', ';LAYER_CHANGE', 'G0 Z0.2',
      ';TYPE:External perimeter', 'G1 X10 E1', 'M600', 'G1 X20 E1',
      'M600 T6', 'G1 X30 E1', 'M600', 'G1 X40 E1',
    ].join('\n'), ['--color-by', mode, '--tool-colors', '#ff0000,#00ff00,#0000ff']);
    assert.deepEqual(result.summary.tools, [0, 1, 2, 6]);
    if (mode === 'feature') {
      assert.deepEqual(result.summary.legend, ['External perimeter=#F59E0B']);
    } else {
      assert.deepEqual(result.summary.legend, ['T0=#ff0000', 'T1=#00ff00', 'T2=#0000ff', 'T6=#888888']);
    }
  });
}

// Pre-refactor gcode-sheet predicate, kept verbatim as the reference for lib/toolpath.mjs.
function referenceIsLayerMarker(str, start, end) {
  while (start < end && str.charCodeAt(start) <= 32) start++;
  return (str.startsWith(';LAYER_CHANGE', start) &&
      str.slice(start + 13, end).trim() === '') ||
    (str.startsWith(';LAYER:', start) &&
      /^\d+\s*$/.test(str.slice(start + 7, end)));
}

test('layer markers: trailing whitespace allowed, only integer Cura layers', async () => {
  const { isLayerMarker, hasLayerMarkersInText, hasLayerMarkers } = await import('../lib/toolpath.mjs');
  const cases = [
    [';LAYER_CHANGE', true],
    [';LAYER_CHANGE ', true],
    [';LAYER_CHANGE\t \t', true],
    ['  ;LAYER_CHANGE', true],
    [';LAYER_CHANGED', false],
    [';LAYER_CHANGE x', false],
    [';LAYER:3', true],
    [';LAYER:3  ', true],
    [';LAYER:0', true],
    [';LAYER:1.5', false],
    [';LAYER:0 ; note', false],
    [';LAYER:-1', false],
    [';LAYER:', false],
    [';LAYER: 3', false],
    [';LAYER:1e3', false],
  ];
  for (const [line, want] of cases) {
    assert.equal(isLayerMarker(line, 0, line.length), want, JSON.stringify(line));
    assert.equal(hasLayerMarkersInText(`G1 X1\n${line}\nG1 X2\n`), want, JSON.stringify(line));
    const file = path.join(dir, `marker-${serial++}.gcode`);
    fs.writeFileSync(file, `G1 X1\r\n${line}\r\nG1 X2\r\n`);
    assert.equal(hasLayerMarkers(file), want, JSON.stringify(line));
  }

  // Property: identical to the pre-refactor predicate on random marker-like lines.
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const pieces = [';LAYER_CHANGE', ';LAYER:', ';LAYER', ' ', '\t', ' ', '0', '7', '42', '.', '5', '-', 'e', ';', 'x', ' note'];
  for (let i = 0; i < 5000; i++) {
    let line = '';
    const n = 1 + rnd(5);
    for (let k = 0; k < n; k++) line += pieces[rnd(pieces.length)];
    const pad = ' '.repeat(rnd(3));
    const str = pad + line + pad;
    const start = pad.length > 0 ? rnd(pad.length + 1) : 0;
    assert.equal(isLayerMarker(str, start, str.length), referenceIsLayerMarker(str, start, str.length), JSON.stringify(str));
  }
});

test('walkGcode skips the layer-marker pre-scan when includeStart is set', async () => {
  const { walkGcode, loadToolpath } = await import('../lib/toolpath.mjs');
  const marked = 'G1 X1 Y1 Z0.2 E1\n;LAYER_CHANGE\n;Z:0.2\nG1 X2 E1\n';
  const markerless = 'G1 X1 Y1 Z0.2 E1\nG1 X2 E1\n';

  assert.equal(walkGcode(marked, { isText: true, includeStart: true }).hasMarkers, null);
  assert.equal(walkGcode(marked, { isText: true }).hasMarkers, true);
  assert.equal(walkGcode(markerless, { isText: true }).hasMarkers, false);

  // loadToolpath still reports the flag correctly either way.
  for (const includeStart of [false, true]) {
    assert.equal(loadToolpath(marked, { isText: true, includeStart }).hasLayerMarkers, true);
    assert.equal(loadToolpath(markerless, { isText: true, includeStart }).hasLayerMarkers, false);
  }
  // The start block is only skipped when markers exist and includeStart is unset.
  assert.equal(loadToolpath(marked, { isText: true }).moves[0].inStart, true);
  assert.equal(loadToolpath(marked, { isText: true, includeStart: true }).moves[0].inStart, false);
});
