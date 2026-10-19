import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendOklch, mixColours, parseHex, toLch, toOklab, type Colour } from '../src/visuals/colour.ts';
import { canvasStops, gradientAt, gradientMapTable, stopsOf } from '../src/visuals/gradient-map.ts';

const hex = (text: string) => parseHex(text)!;
const near = (a: Colour, b: Colour, within = 1e-9) => ['r', 'g', 'b', 'a'].every((k) => Math.abs(a[k as keyof Colour] - b[k as keyof Colour]) < within);
const options = { shift: 0, hueShift: 0, low: 0, high: 1 };

test('the stops in use are those with a colour, in order along the gradient', () => {
  const colours = ['#ff0000', '', '#0000ff', '', '#00ff00'];
  const positions = [0.9, 0.5, 0.1, 0.3, 0.5];
  const stops = stopsOf((n) => (colours[n - 1] ? hex(colours[n - 1]) : null), (n) => positions[n - 1]);
  assert.deepEqual(stops.map((s) => s.position), [0.1, 0.5, 0.9]);
  assert.ok(near(stops[0].colour, hex('#0000ff')));
});

test('a gradient holds its end colours past its ends, and blends between stops in OKLab', () => {
  const stops = [{ colour: hex('#000000'), position: 0.2 }, { colour: hex('#ffffff'), position: 0.8 }];
  assert.ok(near(gradientAt(stops, 0), hex('#000000')));
  assert.ok(near(gradientAt(stops, 1), hex('#ffffff')));
  assert.ok(Math.abs(toOklab(gradientAt(stops, 0.5))[0] - 0.5) < 1e-6, 'half way, half as light');
  // Blue to yellow passes through no grey, as blending red, green and blue would.
  const vivid = gradientAt([{ colour: hex('#0000ff'), position: 0 }, { colour: hex('#ffff00'), position: 1 }], 0.5);
  assert.ok(toLch(vivid).c > 0.05, `the middle keeps some colour: ${JSON.stringify(vivid)}`);
  // Fading to nothing keeps the colour rather than going through black.
  const fading = [{ colour: hex('#ff0000'), position: 0 }, { colour: hex('#00000000'), position: 1 }];
  const half = gradientAt(fading, 0.5);
  assert.ok(Math.abs(half.r - 1) < 1e-9 && Math.abs(half.a - 0.5) < 1e-9, `${JSON.stringify(half)}`);
});

test('the table maps brightness to the gradient, within the range given', () => {
  const stops = [{ colour: hex('#000000'), position: 0 }, { colour: hex('#ffffff'), position: 1 }];
  const plain = gradientMapTable(stops, options)!;
  assert.equal(plain[0], 0);
  assert.equal(plain[255 * 4], 255);
  for (let i = 1; i < 256; i++) assert.ok(plain[i * 4] >= plain[(i - 1) * 4], 'brighter is never darker');
  const ranged = gradientMapTable(stops, { ...options, low: 0.25, high: 0.75 })!;
  assert.equal(ranged[50 * 4], 0, 'below the range, the first colour');
  assert.equal(ranged[200 * 4], 255, 'above it, the last');
  assert.equal(ranged[128 * 4], plain[128 * 4], 'its middle, the gradient\'s middle');
  assert.equal(gradientMapTable([], options), null, 'without stops, nothing to do');
});

test('shifting slides the colours along and back, without a jump', () => {
  const stops = [{ colour: hex('#000000'), position: 0 }, { colour: hex('#ffffff'), position: 1 }];
  for (const shift of [0.3, 0.9, 1.4, 7.25]) {
    const table = gradientMapTable(stops, { ...options, shift })!;
    for (let i = 1; i < 256; i++) assert.ok(Math.abs(table[i * 4] - table[(i - 1) * 4]) <= 3, `shift ${shift} jumps at ${i}`);
  }
  assert.ok(Math.abs(gradientMapTable(stops, { ...options, shift: 0.5 })![0] - gradientAt(stops, 0.5).r * 255) <= 0.5, 'black now shows the middle of the gradient');
});

test('a hue shift turns every colour', () => {
  const stops = [{ colour: hex('#ff0000'), position: 0 }, { colour: hex('#ff0000'), position: 1 }];
  const turned = gradientMapTable(stops, { ...options, hueShift: 120 })!;
  assert.ok(turned[1] > turned[0], `red turned towards green: ${[...turned.slice(0, 3)]}`);
});

test('a canvas is given stops that follow OKLab, going round for a conic gradient, and hard edges stay hard', () => {
  const two = [{ colour: hex('#0000ff'), position: 0.2 }, { colour: hex('#ffff00'), position: 0.8 }];
  const given = canvasStops(two);
  assert.ok(given.length > 2 && given.every(([at], i) => i === 0 || at >= given[i - 1][0]), 'in order, with stops between');
  // As the gradient has them, but for what going to OKLab and back costs.
  for (const [at, colour] of given) assert.ok(near(colour, gradientAt(two, at), 1e-6), `at ${at}`);
  const round = canvasStops(two, true);
  assert.equal(round[0][0], 0);
  assert.equal(round[round.length - 1][0], 1);
  assert.ok(near(round[0][1], round[round.length - 1][1], 1e-6), 'it meets itself where it goes round');
  assert.ok(round.every(([at], i) => i === 0 || at >= round[i - 1][0]));
  const hard = canvasStops([{ colour: hex('#ff0000'), position: 0 }, { colour: hex('#ff0000'), position: 0.5 }, { colour: hex('#0000ff'), position: 0.5 }, { colour: hex('#0000ff'), position: 1 }]);
  const atHalf = hard.filter(([at]) => at === 0.5).map(([, c]) => c);
  assert.ok(atHalf.some((c) => near(c, hex('#ff0000'), 1e-6)) && atHalf.some((c) => near(c, hex('#0000ff'), 1e-6)), 'red and blue both at the half');
});

test('round the colour wheel, opposite colours stay rich through the hues between, where blending evenly greys them', () => {
  const [green, pink] = [hex('#3ddc97'), hex('#ff4fa0')];
  const stops = [{ colour: green, position: 0 }, { colour: pink, position: 1 }];
  const [even, wheel] = [gradientAt(stops, 0.5), gradientAt(stops, 0.5, true)];
  assert.ok(toLch(wheel).c > toLch(even).c * 1.5, `round the wheel ${toLch(wheel).c}, evenly ${toLch(even).c}`);
  // Opaque, it is what spectrums blended with before, so that they look as they did.
  for (const t of [0.1, 0.5, 0.9]) assert.ok(near(blendOklch(green, pink, t), mixColours(green, pink, t), 1e-9));
  // A see-through end lends no hue of its own and does not darken.
  const fading = blendOklch(pink, hex('#00000000'), 0.5);
  // As near as going to OKLCH and back allows, for a colour at the edge of what a screen shows.
  assert.ok(Math.abs(toLch(fading).h - toLch(pink).h) < 1e-4 && Math.abs(toLch(fading).l - toLch(pink).l) < 1e-4 && Math.abs(fading.a - 0.5) < 1e-9);
  // The table and a canvas's stops follow it too.
  const table = gradientMapTable(stops, { ...options, wheel: true })!;
  const middle = Math.round(wheel.r * 255);
  assert.ok(Math.abs(table[128 * 4] - Math.round(gradientAt(stops, 128 / 255, true).r * 255)) <= 1 && Math.abs(middle - table[127 * 4]) <= 3);
  for (const [at, colour] of canvasStops(stops, false, true)) assert.ok(near(colour, gradientAt(stops, at, true), 1e-6), `at ${at}`);
});
