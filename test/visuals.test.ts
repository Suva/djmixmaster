import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHex, toHex, toLch, type Colour } from '../src/visuals/colour.ts';
import { compile, type Value } from '../src/visuals/expression.ts';
import { parseMotion } from '../src/visuals/motion.ts';
import { MUSIC_NAMES, MusicReader } from '../src/visuals/music.ts';
import { checkTemplate, fieldNameProblem, fillText, imagesOf, prepare, renameField, TEXT_VARIABLES, TEMPLATE_FORMAT, upgradeTemplate } from '../src/visuals/template.ts';
import { BAND_COUNT, FEATURE_RATE, type Features } from '../src/features.ts';

const value = (text: string, values: Record<string, number> = {}) => {
  const result = compile(text, Object.keys(values));
  if (!result.ok) throw new Error(result.problem.message);
  return result.compiled.evaluate({ dt: 0, ...values }) as number;
};
const colour = (text: string, values: Record<string, Value> = {}) => {
  const kinds = Object.fromEntries(Object.entries(values).map(([name, v]) => [name, typeof v === 'number' ? 'number' : 'colour'] as const));
  const result = compile(text, kinds, 'colour');
  if (!result.ok) throw new Error(result.problem.message);
  return toHex(result.compiled.evaluate({ dt: 0, ...values }) as Colour);
};
const problem = (text: string, known: string[] = []) => {
  const result = compile(text, known);
  assert.ok(!result.ok, `${text} should not compile`);
  return result.problem;
};

test('expressions follow the usual rules of arithmetic', () => {
  assert.equal(value('1 + 2 * 3'), 7);
  assert.equal(value('(1 + 2) * 3'), 9);
  assert.equal(value('-2^2'), -4);
  assert.equal(value('2^-1'), 0.5);
  assert.equal(value('2^3^2'), 512);
  assert.equal(value('7 % 3'), 1);
  assert.equal(value('-1 % 3'), 2);
  assert.equal(value('1 / 0'), 0, 'what cannot be worked out is 0, never infinite');
  assert.equal(value('bass > 0.5 ? 10 : 20', { bass: 0.7 }), 10);
  assert.equal(value('bass > 0.5 ? 10 : 20', { bass: 0.2 }), 20);
  assert.equal(value('1 + 0.5 * bass', { bass: 0.4 }), 1.2);
  assert.equal(value('.25e1'), 2.5);
});

test('waves give 0 to 1 over one cycle, and noise is the same every time', () => {
  assert.equal(value('sine(0)'), 0);
  assert.equal(value('sine(0.5)'), 1);
  assert.equal(value('triangle(0.25)'), 0.5);
  assert.equal(value('saw(1.75)'), 0.75);
  assert.equal(value('square(0.2)'), 1);
  assert.equal(value('square(0.7)'), 0);
  assert.equal(value('noise(3.3)'), value('noise(3.3)'));
  assert.ok(value('noise(3.3)') >= 0 && value('noise(3.3)') <= 1);
  assert.equal(value('clamp(5, 0, 1) + mix(10, 20, 0.5) + smoothstep(0, 1, 0.5)'), 1 + 15 + 0.5);
});

test('smooth rises and falls at its own speeds, and forgets on reset', () => {
  const result = compile('smooth(x, 0.1, 1)', ['x']);
  assert.ok(result.ok);
  const smooth = result.compiled;
  assert.equal(smooth.evaluate({ x: 0, dt: 0 }), 0);
  const risen = smooth.evaluate({ x: 1, dt: 0.1 }) as number;
  assert.ok(Math.abs(risen - (1 - Math.exp(-1))) < 1e-9, 'a rise time later it is most of the way up');
  for (let i = 0; i < 20; i++) smooth.evaluate({ x: 1, dt: 0.1 });
  const fallen = smooth.evaluate({ x: 0, dt: 0.1 }) as number;
  assert.ok(fallen > 0.85, 'it falls ten times slower');
  smooth.reset();
  assert.equal(smooth.evaluate({ x: 0.3, dt: 0.1 }), 0.3, 'after a reset it starts where the value is');
  // Two smooths in one expression keep apart.
  const pair = compile('smooth(x, 0, 0) + smooth(x * 2, 1, 1)', ['x']);
  assert.ok(pair.ok);
  assert.equal(pair.compiled.evaluate({ x: 1, dt: 0 }), 3);
});

test('mistakes are reported where they are, with a guess at what was meant', () => {
  const unknown = problem('1 + bas * 2', ['bass', 'beat']);
  assert.match(unknown.message, /Unknown name bas; did you mean bass\?/);
  assert.deepEqual([unknown.start, unknown.end], [4, 7]);
  assert.match(problem('sin(1, 2)').message, /sin takes 1 value: sin\(radians\)/);
  assert.match(problem('smoth(x, 1, 1)', ['x']).message, /did you mean smooth\?/);
  assert.match(problem('sine').message, /it is a function: sine\(phase\)/);
  assert.match(problem('(1 + 2').message, /Expected a closing "\)"/);
  assert.match(problem('1 +').message, /missing at the end/);
  assert.match(problem('2 $ 3').message, /"\$" has no meaning/);
  assert.match(problem('').message, /Empty/);
});

test('text variables are filled in, and unknown ones left to be pointed out', () => {
  const filled = fillText('%artist% at %venue% – 100%% %tempo% BPM %nope%', { artist: 'Suva', venue: 'Vaba Pult', tempo: 162.4 });
  assert.equal(filled.text, 'Suva at Vaba Pult – 100% 162 BPM %nope%');
  assert.deepEqual(filled.unknown, ['nope']);
});

const music = [...MUSIC_NAMES];
const textNames = [...TEXT_VARIABLES];

test('a good template is taken as it is', () => {
  const { template, problems } = checkTemplate({
    format: 1,
    name: 'Glitter night',
    fields: [
      { key: 'artistName', label: 'Artist name', kind: 'text', default: 'DJ' },
      { key: 'colour1', label: 'Colour 1', kind: 'colour', default: '#ff00aa' },
      { key: 'sparkle', label: 'Sparkle', kind: 'number', default: 1, min: 0, max: 2 },
    ],
    layers: [
      { type: 'gradient', params: { colour1: 'colour1', colour2: 'complement(darken(colour1, 0.3))', drift: 'sine(time / 30) * 10' } },
      { type: 'particles', params: { count: '200 * sparkle', burst: '40 * beat' } },
      { type: 'text', params: { text: '%artistName% · %currentTrack%', size: '6 + 0.5 * smooth(bass, 0.01, 0.2)' } },
    ],
  }, music, textNames);
  assert.deepEqual(problems, []);
  assert.equal(template.layers.length, 3);
  assert.equal(template.layers[0].params.angle, 90, 'what is not given takes its default');
});

test('a broken template still loads, with each problem said and placed', () => {
  const { template, problems } = checkTemplate({
    fields: [
      { key: 'name', label: 'Name', kind: 'text', default: '' },
      { key: 'name', label: 'Again', kind: 'text', default: '' },
      { key: 'bass', label: 'Bass', kind: 'number', default: 0 },
    ],
    layers: [
      { type: 'hologram', params: {} },
      { type: 'gradient', params: { colour1: 'pink', colour2: '%name%', sparkle: 3 } },
      { type: 'text', params: { size: '6 + bas', text: 'Hi %nmae%' } },
    ],
  }, music, textNames);
  const said = problems.map((p) => `${p.where}: ${p.message}`);
  assert.deepEqual(said, [
    'Field 2 (name): The name name is already taken',
    'Field 3 (bass): The name bass is already taken',
    'Layer 1: Unknown kind of layer: hologram',
    'Layer 2 (Gradient): Gradient has no setting called sparkle',
    'Layer 2 (Gradient), Stop 1: Unknown name pink',
    'Layer 2 (Gradient), Stop 2: Use the field by its name, without percent signs: name',
    'Layer 3 (Text), Text: There is no variable called nmae',
    'Layer 3 (Text), Size: Unknown name bas; did you mean bass?',
  ]);
  const text = problems.find((p) => p.where === 'Layer 3 (Text), Text')!;
  assert.deepEqual([text.start, text.end], [3, 9]);
  assert.equal(template.layers.length, 2, 'the unknown layer is left out, the others kept');
  assert.equal(template.layers[0].params.colour1, '#101830', 'a bad value falls back to the default');
});

test('a prepared template works out each frame from the music and the fields', () => {
  const { template } = checkTemplate({
    fields: [
      { key: 'colour1', label: 'Colour 1', kind: 'colour', default: '#000000' },
      { key: 'artistName', label: 'Artist', kind: 'text', default: 'Nobody' },
      { key: 'amount', label: 'Amount', kind: 'number', default: 2 },
    ],
    layers: [
      { type: 'text', params: { text: '%artistName% – %mixName% %colour1%', size: 'amount + bass', colour: 'colour1 * 0.5', visible: 'progress < 0.5' } },
    ],
  }, music, textNames);
  const [layer] = prepare(template, { colour1: '#ff0000', artistName: 'Suva' }, music);
  const early = layer.resolve({ bass: 0.5, progress: 0.2, dt: 0 }, { mixName: 'Opening set' });
  assert.equal(early.text, 'Suva – Opening set #ff0000');
  assert.equal(early.size, 2.5);
  assert.equal(toHex(early.colour as Colour), '#800000');
  assert.equal(early.visible, true);
  assert.equal(layer.resolve({ bass: 0, progress: 0.8, dt: 0 }, {}).visible, false);
});

test('the music values follow the beats and keep to 0 to 1', () => {
  // Two minutes at 120 BPM with the low bands loud on each beat.
  const seconds = 120;
  const steps = seconds * FEATURE_RATE;
  const bands = new Uint8Array(steps * BAND_COUNT);
  const level = new Uint8Array(steps).fill(180);
  for (let s = 0; s < steps; s++) {
    const onBeat = (s / FEATURE_RATE) % 0.5 < 0.1;
    for (let b = 0; b < BAND_COUNT; b++) bands[s * BAND_COUNT + b] = b < 5 ? (onBeat ? 230 : 120) : 140 + (s % 7);
  }
  const beats = Float64Array.from({ length: seconds * 2 }, (_, i) => i * 0.5);
  const features: Features = { rate: FEATURE_RATE, bands, level, beats, beatStrength: new Float32Array(beats.length).fill(1) };
  const reader = new MusicReader(features, 10, 70);

  const onBeat = reader.at(20, 1 / 30) as Record<string, number>; // 30 s into the recording, on a beat
  assert.equal(onBeat.time, 20);
  assert.ok(Math.abs(onBeat.progress - 1 / 3) < 1e-9);
  assert.equal(onBeat.tempo, 120);
  assert.equal(onBeat.beatPhase, 0);
  assert.equal(onBeat.beat, 1);
  assert.equal(onBeat.beats, 40, 'counted from the first beat of the mix');
  assert.equal(onBeat.barPhase, 0);
  const between = reader.at(20.25, 1 / 30) as Record<string, number>;
  assert.equal(between.beatPhase, 0.5);
  assert.equal(between.beat, 0.125);
  assert.ok(onBeat.bass > 0.9 && between.bass < 0.1, `bass ${onBeat.bass} on the beat, ${between.bass} between`);
  for (const name of ['bass', 'lowMids', 'mids', 'highs', 'level', 'energy']) {
    for (const v of [onBeat[name], between[name]]) assert.ok(v >= 0 && v <= 1, `${name} is ${v}`);
  }
  for (const name of MUSIC_NAMES) assert.ok(name in onBeat, `${name} is given`);
});

test('colours do arithmetic part by part, like a shader', () => {
  assert.equal(colour('#ff3366 * 0.5'), '#801a33');
  assert.equal(colour('0.5 * #ff3366'), '#801a33');
  assert.equal(colour('#ff8000 * #8080ff'), '#804000', 'a colour times a colour tints');
  assert.equal(colour('#204060 + #102030'), '#306090');
  assert.equal(colour('#ff8000 / 2'), '#804000');
  assert.equal(colour('c * (0.5 + 0.5 * beat)', { c: parseHex('#ffffff')!, beat: 0 }), '#808080');
  assert.equal(colour('bass > 0.5 ? #ffffff : #000000', { bass: 0.8 }), '#ffffff');
  assert.equal(colour('rgb(1, 0.5, 0)'), '#ff8000');
  assert.equal(colour('hsl(120, 1, 0.5)'), '#00ff00');
  assert.equal(colour('alpha(#ffffff, 0.5)'), '#ffffff80');
  assert.equal(value('red(#ff8000) + green(#ff8000)'), 1 + 128 / 255);
});

test('hue, lightness and saturation change the way the eye sees them', () => {
  const base = parseHex('#e0a020')!;
  const turned = parseHex(colour('complement(c)', { c: base }))!;
  assert.ok(Math.abs(toLch(turned).l - toLch(base).l) < 0.01, 'the complement looks just as light');
  assert.ok(Math.abs(((toLch(turned).h - toLch(base).h + 360) % 360) - 180) < 2, 'and sits opposite on the colour wheel');
  assert.ok(toLch(parseHex(colour('darken(c, 0.2)', { c: base }))!).l < toLch(base).l - 0.15);
  assert.ok(toLch(parseHex(colour('gray(c)', { c: base }))!).c < 0.001);
  // Halfway from red to blue is a clear purple, not the dull one plain averaging gives.
  const middle = toLch(parseHex(colour('mix(#ff0000, #0000ff, 0.5)'))!);
  const averaged = toLch(parseHex('#800080')!);
  assert.ok(middle.c > averaged.c && middle.l > averaged.l, 'brighter and richer than #800080');
  // A colour no screen can show is brought within reach, not turned into another.
  const vivid = parseHex(colour('saturate(#30e080, 5)'))!;
  for (const part of [vivid.r, vivid.g, vivid.b]) assert.ok(part >= 0 && part <= 1);
  assert.ok(Math.abs(toLch(vivid).h - toLch(parseHex('#30e080')!).h) < 3, 'its hue stays');
  assert.equal(value('lightness(#ffffff)').toFixed(3), '1.000');
  assert.equal(colour('lightness(c) > 0.6 ? #000000 : #ffffff', { c: parseHex('#ffee88')! }), '#000000', 'readable text on a light colour');
});

test('mixing numbers and colours wrongly is caught, with a way out', () => {
  const plus = compile('colour1 + 0.2', { colour1: 'colour' });
  assert.ok(!plus.ok);
  assert.match(plus.problem.message, /Cannot add a number to a colour; .*colour1 \* 1\.2.*lighten\(colour1, 0\.1\)/);
  const wanted = compile('bass * 2', { bass: 'number' }, 'colour');
  assert.ok(!wanted.ok && wanted.problem.message === 'This gives a number; a colour is needed here');
  const other = compile('#ffffff', {}, 'number');
  assert.ok(!other.ok && other.problem.message === 'This gives a colour; a number is needed here');
  const sides = compile('bass > 0 ? #ffffff : 1', { bass: 'number' });
  assert.ok(!sides.ok && /Both sides of ":"/.test(sides.problem.message));
  const mixed = compile('mix(#ffffff, 1, 0.5)', {});
  assert.ok(!mixed.ok && /not one of each/.test(mixed.problem.message));
  const hex = compile('#ff00z0', {});
  assert.ok(!hex.ok && /#ff00z0 is not a colour/.test(hex.problem.message));
  const compared = compile('#ffffff > #000000', {});
  assert.ok(!compared.ok && /compare lightness/.test(compared.problem.message));
});

test('smooth follows a colour as well as a number', () => {
  const result = compile('smooth(c, 0, 1)', { c: 'colour' });
  assert.ok(result.ok);
  const at = (hex: string, dt: number) => toHex(result.compiled.evaluate({ c: parseHex(hex)!, dt }) as Colour);
  assert.equal(at('#000000', 0), '#000000');
  assert.equal(at('#ffffff', 0.1), '#ffffff', 'rising is instant here');
  assert.notEqual(at('#000000', 0.1), '#000000', 'falling takes its time');
});


test('the built-in templates are free of problems', async () => {
  const { BUILT_IN_TEMPLATES } = await import('../src/visuals/templates.ts');
  for (const builtIn of BUILT_IN_TEMPLATES) {
    const { template, problems } = checkTemplate(builtIn.template, music, textNames);
    assert.deepEqual(problems.map((p) => `${p.where}: ${p.message}`), [], builtIn.id);
    assert.ok(template.layers.length >= 4, builtIn.id);
    const layers = prepare(template, {}, music);
    for (const layer of layers) layer.resolve({ bass: 0.5, beat: 1, energy: 0.5, highs: 0.3, dt: 1 / 30 }, {});
  }
});

test('pictures packed into a template are checked, and named by asset:', () => {
  const { template, problems } = checkTemplate({
    format: 1,
    name: 'Packed',
    fields: [{ key: 'logo', kind: 'image', default: '' }],
    layers: [
      { type: 'image', params: { image: 'asset:wall' } },
      { type: 'image', params: { image: 'asset:missing' } },
      { type: 'image', params: { image: '%logo%' } },
    ],
    assets: { wall: 'data:image/png;base64,iVBORw0KGgo=', script: 'data:text/html;base64,PHA+' },
  }, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(Object.keys(template.assets ?? {}), ['wall']);
  assert.deepEqual(problems.map((p) => p.where), ['Picture script', 'Layer 2 (Image), Image']);
  assert.deepEqual(imagesOf(template, { logo: '/pictures/logo.png' }), ['/pictures/logo.png', 'asset:wall']);
});

test('renaming a field renames it wherever a setting uses it', () => {
  const { template } = checkTemplate({
    format: 1,
    fields: [{ key: 'colour1', kind: 'colour', default: '#ff0000' }, { key: 'colour10', kind: 'colour', default: '#0000ff' }, { key: 'font', kind: 'font', default: 'Inter' }, { key: 'tag', kind: 'text', default: '' }],
    layers: [
      { type: 'gradient', params: { colour1: 'darken(colour1, 0.2)', colour2: 'mix(colour1, colour10, 0.5)' } },
      { type: 'text', params: { text: '%tag% by %artist%', font: '%font%', colour: 'colour1' } },
    ],
  }, MUSIC_NAMES, TEXT_VARIABLES);
  renameField(template, 'colour1', 'accent');
  renameField(template, 'font', 'face');
  renameField(template, 'tag', 'label');
  assert.deepEqual(template.fields.map((field) => field.key), ['accent', 'colour10', 'face', 'label']);
  assert.equal(template.layers[0].params.colour1, 'darken(accent, 0.2)');
  // colour10 is another name, and the setting called colour1 is not the field.
  assert.equal(template.layers[0].params.colour2, 'mix(accent, colour10, 0.5)');
  assert.deepEqual([template.layers[1].params.text, template.layers[1].params.font, template.layers[1].params.colour], ['%label% by %artist%', '%face%', 'accent']);
  assert.equal(fieldNameProblem(template, 'bass', MUSIC_NAMES, TEXT_VARIABLES), 'The name bass is already taken');
  assert.equal(fieldNameProblem(template, '2nd', MUSIC_NAMES, TEXT_VARIABLES), 'Letters and digits only, starting with a letter');
  assert.equal(fieldNameProblem(template, 'accent', MUSIC_NAMES, TEXT_VARIABLES, 'accent'), null);
});

test('a template with groups is checked layer by layer, and a layer that cannot be used leaves the groups right', () => {
  const { template, problems } = checkTemplate({
    format: 2,
    layers: [
      { type: 'gradient', params: {} },
      { type: 'group', name: 'G', size: 3, params: { opacity: 0.5, x: 10 } },
      { type: 'text', params: {} },
      { type: 'sparkler', params: {} },
      { type: 'text', name: 'last in G', params: {} },
      { type: 'text', name: 'top', params: {} },
    ],
  }, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(template.layers.map((layer) => `${layer.name ?? layer.type}${layer.size === undefined ? '' : `[${layer.size}]`}`), ['gradient', 'G[2]', 'text', 'last in G', 'top']);
  // A group has no place of its own: its x is not one of its settings.
  assert.deepEqual(problems.map((p) => p.where), ['Layer 2 (G)', 'Layer 4']);
  assert.equal(template.layers[1].params.opacity, 0.5);
  assert.equal('x' in template.layers[1].params, false);
});

test('a template says who made it and what it is, and what will not do is left out', () => {
  const { template, problems } = checkTemplate({
    format: 1,
    about: { author: ' Suva ', email: 'not an address', website: 'javascript:alert(1)', description: 'Glitter for acid techno.' },
    layers: [],
  }, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(template.about, { author: 'Suva', description: 'Glitter for acid techno.' });
  assert.deepEqual(problems.map((p) => p.where), ['About, email', 'About, website']);
  const fine = checkTemplate({ format: 1, about: { email: 'a@b.ee', website: 'https://example.com/x' }, layers: [] }, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(fine.template.about, { email: 'a@b.ee', website: 'https://example.com/x' });
});

test('a template of format 1 has its amounts made fractions, and its sizes left in percent', () => {
  const old = {
    format: 1, name: 'Old', fields: [{ key: 'how', label: 'How much', kind: 'number', default: 80 }],
    layers: [
      { type: 'image', params: { opacity: 50, tintAmount: '40', brightness: 'how', width: 30, dropShadow: true, dropOpacity: 60, dropDistance: 0.8 } },
      { type: 'glow', params: { threshold: 55, strength: '50 + 40 * smooth(beat, 0, 0.3)', radius: 1.5 } },
      { type: 'video', params: { speed: 200, keyTolerance: 30, inPoint: 2 } },
      { type: 'split', params: { amount: 0.4 } },
      { type: 'glitch', params: { amount: 30, split: 0.6 } },
      { type: 'hue', params: { lightness: -20, saturation: 'bass * 200' } },
    ],
  };
  const upgraded = upgradeTemplate(old) as typeof old;
  assert.equal(upgraded.format, 3);
  assert.equal(old.layers[0].params.opacity, 50, 'what was given is left alone');
  const [image, glow, video, split, glitch, hue] = upgraded.layers.map((layer) => layer.params as Record<string, unknown>);
  assert.deepEqual(image, { opacity: 0.5, tintAmount: '0.4', brightness: '(how) / 100', width: 30, dropShadow: true, dropOpacity: 0.6, dropDistance: 0.8 });
  assert.equal(glow.threshold, 0.55);
  assert.deepEqual(parseMotion(String(glow.strength)), { base: 0.5, amount: 0.4, source: 'beat', speed: 'smooth', period: 8 }, 'a "Moves with…" can still be read back');
  assert.deepEqual(video, { speed: 2, keyTolerance: 0.3, inPoint: 2 });
  assert.equal(split.amount, 0.4, 'a colour split\'s amount is a distance, and stays in percent');
  assert.deepEqual(glitch, { amount: 0.3, split: 0.6 });
  assert.deepEqual(hue, { lightness: -0.2, saturation: '(bass * 200) / 100' });

  // Checked, it draws as it did: the expressions work, and the field is still 0 to 100.
  const { template, problems } = checkTemplate(old, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(problems, []);
  assert.equal(template.format, TEMPLATE_FORMAT);
  const [imageLayer, , , , , hueLayer] = prepare(template, {}, MUSIC_NAMES);
  assert.equal(imageLayer.resolve({}, {}).brightness, 0.8);
  assert.equal(hueLayer.resolve({ bass: 0.5 }, {}).saturation, 1);
});

test('a template of the current format, or a newer one, is not changed again', () => {
  const now = { format: TEMPLATE_FORMAT, layers: [{ type: 'solid', params: { opacity: 0.5 } }] };
  assert.equal(upgradeTemplate(now), now);
  const { problems } = checkTemplate({ format: TEMPLATE_FORMAT + 1, layers: [] }, MUSIC_NAMES, TEXT_VARIABLES);
  assert.match(problems[0].message, /newer version/);
  assert.equal((checkTemplate(now, MUSIC_NAMES, TEXT_VARIABLES)).template.layers[0].params.opacity, 0.5);
});

test('a template of format 2 has its gradients\' colours made stops, where they fell before', () => {
  const old = {
    format: 2, name: 'Old', fields: [],
    layers: [
      { type: 'gradient', params: { colour1: '#ff0000' } },
      { type: 'gradient', params: { kind: 'conic', colour1: '#ff0000', colour2: 'complement(#ff0000)', colour3: '#0000ff' } },
      { type: 'noise', params: { colour2: '#ff0000', colour3: '#ffffff' } },
      { type: 'spectrum', params: { colourHigh: '' } },
      { type: 'shape', params: { fillColour2: '#000000' } },
    ],
  };
  const layers = (upgradeTemplate(old) as typeof old).layers.map((layer) => layer.params as Record<string, unknown>);
  const stops = (params: Record<string, unknown>) => [1, 2, 3, 4, 5].filter((n) => params[`colour${n}`] !== '').map((n) => [params[`colour${n}`], params[`position${n}`]]);
  assert.deepEqual(stops(layers[0]), [['#ff0000', 0], ['#2a0f3c', 1]], 'the second colour left out was the old default, and sat at the end');
  assert.deepEqual(stops(layers[1]), [['#ff0000', 0], ['complement(#ff0000)', 1 / 3], ['#0000ff', 2 / 3]], 'a conic gradient came round to its first colour');
  assert.deepEqual(stops(layers[2]), [['#00000000', 0], ['#ff0000', 0.5], ['#ffffff', 1]], 'noise\'s empty low colour was see-through');
  assert.deepEqual(stops(layers[3]), [['#3ddc97', 0]], 'an empty high colour was the low one');
  assert.ok(!('colourLow' in layers[3]) && !('colourHigh' in layers[3]));
  assert.equal(layers[3].stopBlend, 'round the colour wheel', 'a spectrum blended round the colour wheel');
  assert.ok(!('stopBlend' in layers[0]), 'the others evenly, as is the default');
  assert.deepEqual(stops(layers[4]), [['#3ddc97', 0], ['#000000', 1]]);
  assert.ok(!('fillColour' in layers[4]));
  const { problems } = checkTemplate(old, MUSIC_NAMES, TEXT_VARIABLES);
  assert.deepEqual(problems, [], 'nothing left over that the layers no longer have');
});
