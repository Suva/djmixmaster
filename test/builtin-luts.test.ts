import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { BUILTIN_LUT_PREFIX, BUILTIN_LUTS, builtinLutFile, decodeBuiltinLut, encodeBuiltinLut } from '../src/visuals/builtin-luts.ts';
import { sampleLut, type Lut } from '../src/visuals/lut.ts';
import { checkSetting, LAYER_TYPES, type Template } from '../src/visuals/template.ts';
import { MUSIC_NAMES } from '../src/visuals/music.ts';

test('a built-in LUT comes back from its file as it went in, to 16 bits', () => {
  const size = 5;
  const data = new Float32Array(size ** 3 * 3);
  for (let i = 0; i < data.length; i++) data[i] = ((i * 7919) % 1000) / 999;
  const back = decodeBuiltinLut(encodeBuiltinLut({ size, data, min: [0, 0, 0], max: [1, 1, 1] }));
  assert.equal(back.size, size);
  for (let i = 0; i < data.length; i++) assert.ok(Math.abs(back.data[i] - data[i]) <= 0.5 / 65535);
  assert.throws(() => decodeBuiltinLut(new Uint8Array([5, 1, 2])), /damaged/);
});

test('every LUT that comes with the app has a file of its own, which reads', () => {
  const names = new Set(BUILTIN_LUTS.map((lut) => lut.name));
  const files = new Set(BUILTIN_LUTS.map((lut) => builtinLutFile(lut.name)));
  assert.equal(names.size, BUILTIN_LUTS.length, 'no two of the same name');
  assert.equal(files.size, BUILTIN_LUTS.length, 'no two in the same file');
  assert.deepEqual(readdirSync('assets/luts').filter((file) => file.endsWith('.bin')).sort(), [...files].sort(), 'no file left over');
  const looks = new Map<string, Lut>();
  for (const { name } of BUILTIN_LUTS) {
    const lut = decodeBuiltinLut(new Uint8Array(inflateRawSync(readFileSync(`assets/luts/${builtinLutFile(name)}`))));
    assert.equal(lut.size, 33, name);
    looks.set(name, lut);
  }
  // Read the right way round: red stays reddish in a colour film, and a black and white one is grey.
  const [r, g, b] = sampleLut(looks.get('Fuji Velvia 50')!, 1, 0, 0);
  assert.ok(r > 0.8 && g < 0.2 && b < 0.2);
  const grey = sampleLut(looks.get('Kodak Tri-X 400')!, 0.9, 0.2, 0.4);
  assert.ok(Math.abs(grey[0] - grey[1]) < 0.01 && Math.abs(grey[1] - grey[2]) < 0.01);
});

test('a template may name a LUT that comes with the app, and only one that does', () => {
  const template = { format: 1, name: 'T', fields: [], layers: [] } as unknown as Template;
  const check = (value: string) => checkSetting(template, value, LAYER_TYPES.lut.params.lut, MUSIC_NAMES, []);
  assert.equal(check(BUILTIN_LUT_PREFIX + 'Kodak Portra 400'), null);
  assert.match(check(BUILTIN_LUT_PREFIX + 'Nothing like it')!.message, /No LUT called Nothing like it/);
});
