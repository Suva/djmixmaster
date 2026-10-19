import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLut, packLut, parseCube, sampleLut, scalingLut, unpackLut } from '../src/visuals/lut.ts';
import { whiteBalance } from '../src/visuals/colour.ts';
import { checkTemplate, folderLutsOf, keepFolderLuts, lutsOf, prepare } from '../src/visuals/template.ts';
import { MUSIC_NAMES } from '../src/visuals/music.ts';

/** A 3D cube of `size` points a side, each point given by `f`, red changing fastest. */
function cube(size: number, f: (r: number, g: number, b: number) => number[], head = ''): string {
  const rows: string[] = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    rows.push(f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' '));
  }
  return `${head}LUT_3D_SIZE ${size}\n${rows.join('\n')}\n`;
}

const close = (actual: ArrayLike<number>, expected: number[], within = 1e-4) =>
  expected.forEach((value, i) => assert.ok(Math.abs(actual[i] - value) < within, `${[...Array.from(actual)]} should be ${expected}`));

test('a 3D cube is read, red changing fastest, and read between its points', () => {
  const lut = parseCube(cube(5, (r, g, b) => [1 - r, g * g, b * 0.5], '# made for a test\nTITLE "Test look"\n\n'));
  assert.equal(lut.title, 'Test look');
  assert.equal(lut.size, 5);
  close(sampleLut(lut, 0, 0, 0), [1, 0, 0]);
  close(sampleLut(lut, 1, 1, 1), [0, 1, 0.5]);
  close(sampleLut(lut, 0.25, 0.5, 1), [0.75, 0.25, 0.5]);
  // Between points it is linear: g² at 0.375 lies between 0.25² and 0.5².
  close(sampleLut(lut, 0, 0.375, 0), [1, (0.0625 + 0.25) / 2, 0]);
  // Past the ends, the end.
  close(sampleLut(lut, 2, -1, 0), [0, 0, 0]);
});

test('a 1D cube becomes a 3D one with each channel its own curve', () => {
  const rows = Array.from({ length: 11 }, (_, i) => `${(i / 10) ** 2} ${i / 10} ${1 - i / 10}`).join('\n');
  const lut = parseCube(`LUT_1D_SIZE 11\n${rows}\n`);
  close(sampleLut(lut, 0.5, 0.3, 0.2), [0.25, 0.3, 0.8], 0.01);
});

test('a domain other than 0 to 1 is kept', () => {
  const lut = parseCube(cube(2, (r, g, b) => [r, g, b], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n'));
  close(sampleLut(lut, 1, 0.5, 0), [0.5, 0.25, 0]);
});

test('what is not a cube is refused, saying why', () => {
  assert.throws(() => parseCube('hello'), /no LUT_3D_SIZE/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n'), /should have 8 rows, and has 2/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0\n'), /Line 2 should be three numbers/);
  assert.throws(() => parseCube('LUT_3D_SIZE 99\n'), /at most 65/);
});

test('a LUT packed into a template comes back as it was, to sixteen bits', () => {
  const lut = parseCube(cube(9, (r, g, b) => [r * 1.2 - 0.1, Math.sqrt(g), b], 'TITLE "Wide"\n'));
  const packed = packLut(lut);
  assert.equal(packed.title, 'Wide');
  assert.ok(packed.low! < 0 && packed.high! > 1, 'values past 0 to 1 are kept');
  const back = unpackLut(JSON.parse(JSON.stringify(packed)));
  assert.equal(back.size, 9);
  for (let i = 0; i < lut.data.length; i++) assert.ok(Math.abs(back.data[i] - lut.data[i]) < 3e-5);
  assert.throws(() => unpackLut({ ...packed, data: packed.data.slice(8) }), /wrong length/);
});

test('pixels are sent through a LUT, and their alpha left alone', () => {
  const lut = parseCube(cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b]));
  const pixels = new Uint8ClampedArray([200, 50, 20, 255, 200, 50, 20, 128, 0, 0, 0, 0]);
  applyLut(lut, pixels);
  assert.deepEqual([...pixels], [55, 205, 235, 255, 55, 205, 235, 128, 255, 255, 255, 0]);
});

test('a template keeps its LUTs, checks what names them, and lists the ones it uses', () => {
  const kept = packLut(parseCube(cube(2, (r, g, b) => [b, g, r])));
  const { template, problems } = checkTemplate({
    format: 1, name: 'Looks',
    fields: [{ key: 'look', label: 'Look', kind: 'lut', default: 'lut:Swap' }],
    luts: { Swap: kept, Broken: { size: 2, data: 'AAAA' } },
    layers: [
      { type: 'lut', params: { lut: 'lut:Swap', opacity: 50 } },
      { type: 'lut', params: { lut: '%look%' } },
      { type: 'lut', params: { lut: 'lut:Missing' } },
      { type: 'lut', params: { lut: '%nothing%', x: 20 } },
    ],
  }, MUSIC_NAMES, []);
  assert.deepEqual(Object.keys(template.luts!), ['Swap']);
  assert.deepEqual(problems.map((p) => `${p.where}: ${p.message}`), [
    'LUT Broken: Its table is the wrong length for its size',
    'Layer 3 (LUT), LUT: This template keeps no LUT called Missing',
    'Layer 4 (LUT): LUT has no setting called x',
    'Layer 4 (LUT), LUT: nothing is not a LUT field of this template',
  ]);
  assert.deepEqual(lutsOf(template, {}), ['lut:Swap']);
  assert.deepEqual(lutsOf(template, { look: '/looks/Film.cube' }), ['/looks/Film.cube', 'lut:Swap']);
  // A field's value reaches the layer as it was filled in.
  const layers = prepare(template, { look: '/looks/Film.cube' }, MUSIC_NAMES);
  assert.equal(layers[1].resolve({}, {}).lut, '/looks/Film.cube');
});

test('a template exported keeps the LUT folder\'s LUTs it names, once each, and names them as kept', () => {
  const invert = packLut(parseCube(cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b])));
  const swap = packLut(parseCube(cube(2, (r, g, b) => [b, g, r])));
  const warm = packLut(parseCube(cube(2, (r, g, b) => [r, g, b * 0.8])));
  const { template } = checkTemplate({
    format: 1, name: 'Looks',
    fields: [{ key: 'look', label: 'Look', kind: 'lut', default: 'lutfolder:Film/Warm' }],
    luts: { Invert: invert, Warm: swap },
    layers: [
      { type: 'lut', params: { lut: 'lutfolder:Film/Warm' } },
      { type: 'lut', params: { lut: 'lutfolder:Other/Invert' } },
      { type: 'lut', params: { lut: 'lut:Invert' } },
    ],
  }, MUSIC_NAMES, []);
  assert.deepEqual(folderLutsOf(template), ['Film/Warm', 'Other/Invert']);
  const shared = keepFolderLuts(template, { 'Film/Warm': warm, 'Other/Invert': invert });
  // Warm is taken by another table; the folder's Invert is the one kept already.
  assert.deepEqual(Object.keys(shared.luts!), ['Invert', 'Warm', 'Warm 2']);
  assert.equal(shared.luts!['Warm 2'], warm);
  assert.deepEqual(shared.layers.map((layer) => layer.params.lut), ['lut:Warm 2', 'lut:Invert', 'lut:Invert']);
  assert.equal(shared.fields[0].default, 'lut:Warm 2');
  assert.deepEqual(folderLutsOf(shared), []);
  assert.equal(template.layers[0].params.lut, 'lutfolder:Film/Warm', 'the template itself is left as it was');
});

test('a white balance warms, cools and tints, and leaves a grey as light as it was', () => {
  const lightness = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.deepEqual(whiteBalance(0, 0), [1, 1, 1]);
  const warm = whiteBalance(1, 0);
  assert.ok(warm[0] > 1 && warm[2] < 1 && warm[0] > warm[1] && warm[1] > warm[2], `warmer is more red and less blue: ${warm}`);
  const cool = whiteBalance(-1, 0);
  assert.ok(cool[2] > cool[1] && cool[1] > cool[0], `cooler is more blue: ${cool}`);
  const magenta = whiteBalance(0, 1);
  assert.ok(magenta[1] < magenta[0] && Math.abs(magenta[0] - magenta[2]) < 1e-12, `magenta is less green: ${magenta}`);
  for (const gains of [warm, cool, magenta, whiteBalance(0, -1), whiteBalance(0.4, -0.7)]) assert.ok(Math.abs(lightness(gains) - 1) < 1e-12);
  assert.deepEqual(whiteBalance(5, -5), whiteBalance(1, -1), 'past the ends of the sliders it goes no further');
});

test('a LUT of two points a side scales each channel exactly, cut off only at full', () => {
  const lut = scalingLut([1.2, 1, 0.5]);
  for (const [r, g, b] of [[0, 0, 0], [0.5, 0.25, 1], [0.8, 0.9, 0.3], [1, 1, 1]]) {
    const [or, og, ob] = sampleLut(lut, r, g, b);
    assert.ok(Math.abs(or - r * 1.2) < 1e-6 && Math.abs(og - g) < 1e-6 && Math.abs(ob - b * 0.5) < 1e-6, `${r} ${g} ${b} gave ${or} ${og} ${ob}`);
  }
  const pixels = new Uint8ClampedArray([100, 100, 100, 255, 250, 10, 200, 128]);
  applyLut(lut, pixels);
  assert.deepEqual([...pixels], [120, 100, 50, 255, 255, 10, 100, 128], 'red past full stops at 255, and alpha is left alone');
});
