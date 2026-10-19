// Takes the manual's pictures with the app's check mode:
// `node scripts/manual-pictures.mjs <recording>`, the same recording of about
// an hour as scripts/screenshot.mjs takes, shown as "Saturday night.wav".
//
// One run of the app (manual-pictures/pictures.js) photographs the window in
// each view, its dialogs and the template editor's panels, then each kind of
// layer drawn on its own, from a template made here with one group per kind,
// shown by turns. A kind of layer added to the app needs a picture of its
// own: add it to LAYERS below, or the manual will not build. The pictures go
// into site/manual/pictures/; look at them before committing.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const recording = process.argv[2];
if (!recording || !existsSync(recording)) {
  console.error('Usage: node scripts/manual-pictures.mjs <recording of about an hour>');
  process.exit(1);
}
const root = resolve(import.meta.dirname, '..');
const here = join(root, 'scripts', 'manual-pictures');
const out = join(root, 'site', 'manual', 'pictures');
const work = mkdtempSync(join(tmpdir(), 'djm-manual-'));
const shown = join(work, 'Saturday night.wav');
symlinkSync(resolve(recording), shown);
const data = join(work, 'data');
mkdirSync(join(data, 'luts'), { recursive: true });

const ffmpeg = process.env.DJMASTER_FFMPEG ?? 'ffmpeg';
// A clip for the video layer: a slow journey into the Mandelbrot set.
const clip = join(work, 'Clip.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'mandelbrot=s=960x540:rate=30', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
// A LUT for the LUT layer: warm highlights, teal shadows.
const size = 17;
const cube = ['LUT_3D_SIZE 17'];
for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
  const [R, G, B] = [r, g, b].map((v) => v / (size - 1));
  const light = 0.3 * R + 0.6 * G + 0.1 * B;
  const c = (v) => Math.min(1, Math.max(0, v)).toFixed(5);
  cube.push(`${c(R + 0.45 * light - 0.15)} ${c(G + 0.05 * light)} ${c(B - 0.5 * light + 0.22)}`);
}
writeFileSync(join(data, 'luts', 'Teal and orange.cube'), `${cube.join('\n')}\n`);
const logo = `data:image/png;base64,${readFileSync(join(root, 'site', 'icon.png')).toString('base64')}`;

// A gradient's five stops: these colours spread evenly from 0 to 1, the rest not used (see src/visuals/templates.ts).
const stops = (...colours) => Object.fromEntries([1, 2, 3, 4, 5].flatMap((n) => [
  [`colour${n}`, colours[n - 1] ?? ''],
  [`position${n}`, n > colours.length ? 1 : colours.length < 2 ? 0 : (n - 1) / (colours.length - 1)],
]));

// What each kind of layer is shown with. Effects are shown changing a scene of glitter, the spectrum and a title.
const dark = { type: 'gradient', params: { kind: 'radial', ...stops('#2a1c5a', '#0b0a18') } };
const scene = [
  { type: 'gradient', params: { kind: 'linear', angle: 120, ...stops('#3a1c71', '#d76d77', '#ffaf7b') } },
  { type: 'particles', params: { count: 500, colour1: '#ffffff', colour2: '#ffe6a8' } },
  { type: 'spectrum', params: { ...stops('#ffffff'), y: 82, height: 16, opacity: 0.85 } },
  { type: 'text', params: { text: 'NIGHTSHIFT', size: 13, weight: 800, colour: '#ffffff', y: 40 } },
];
/** Entries of LAYERS that show something other than a kind of layer: their pictures go beside the others, not in layers/. */
const NOT_KINDS = new Set(['mask']);
const LAYERS = {
  solid: [...scene, { type: 'solid', params: { colour: '#1e6cff', blend: 'colour' } }],
  gradient: [{ type: 'gradient', params: { kind: 'linear', angle: 120, ...stops('#3a1c71', '#d76d77', '#ffaf7b') } }],
  particles: [dark, { type: 'particles', params: { count: 1200, shape: 'sparkle', colour1: '#ffffff', colour2: '#ffd27a', colour3: '#8fd3ff', sizeLow: 0.5, sizeHigh: 2 } }],
  image: [dark, { type: 'image', params: { image: 'asset:Logo', width: 28, height: 28 } }],
  video: [dark, { type: 'video', params: { video: clip, fit: 'cover', width: 70, height: 70, rounding: 3 } }],
  text: [dark, { type: 'text', params: { text: '%artist%\nLive at Saturday night', size: 9, weight: 700, colour: '#ffffff' } }],
  spectrum: [dark, { type: 'spectrum', params: { ...stops('#3ddc97', '#ff4fa0'), stopBlend: 'round the colour wheel' } }],
  waveform: [dark, { type: 'waveform', params: { colour: '#8fd3ff' } }],
  // Smoky clouds, bent by a second noise, in three colours over the dark background.
  noise: [dark, { type: 'noise', params: { kind: 'clouds', warp: 0.6, size: 45, seed: 4, ...stops('#00000000', '#7a4fd0', '#ffd27a'), coverage: 0.8, softness: 0.8, blend: 'screen' } }],
  // A few shapes, a ring that fills round and a progress bar that fills across.
  shape: [
    dark,
    { type: 'shape', params: { shape: 'hexagon', square: true, width: 16, x: 20, y: 40, rounding: 6, fill: 'linear gradient', ...stops('#ff4fa0', '#ffd27a'), gradientAngle: 135 } },
    { type: 'shape', params: { shape: 'star', square: true, width: 17, x: 40, y: 40, sides: 5, inner: 45, rounding: 4, ...stops(), outlineWidth: 0.8, outlineColour: '#ffd27a' } },
    { type: 'shape', params: { shape: 'ring', square: true, width: 15, x: 60, y: 40, thickness: 22, ...stops('#3ddc97'), restColour: '#ffffff26', amount: 0.65, reveal: 'clockwise' } },
    { type: 'shape', params: { shape: 'heart', square: true, width: 13, x: 80, y: 41, fill: 'radial gradient', ...stops('#ff8fb8', '#d0205a') } },
    { type: 'shape', params: { shape: 'rectangle', width: 70, height: 2.4, y: 80, rounding: 50, ...stops('#6aa9ff'), restColour: '#ffffff26', amount: 0.4, reveal: 'left, keeping its shape' } },
  ],
  glow: [...scene, { type: 'glow', params: { threshold: 0.45, strength: 1.5, radius: 3 } }],
  group: scene,
  split: [...scene, { type: 'split', params: { amount: 1.2 } }],
  glitch: [...scene, { type: 'glitch', params: { amount: 1, shift: 10 } }],
  adjust: [...scene, { type: 'adjust', params: { brightness: 1.25, contrast: 1.7 } }],
  hue: [...scene, { type: 'hue', params: { hue: 140, saturation: 1.6 } }],
  // A synthwave floor under a dusk sky, its horizon a little above the middle.
  grid: [
    // Top to bottom; the gradient reaches past the picture, so the horizon at 43% of its height is at 0.466 along it.
    { type: 'gradient', params: { kind: 'linear', angle: 90, ...stops('#120a2e', '#5b1a6e', '#ff6a8f', '#120a2e'), position1: 0.25, position2: 0.38, position3: 0.466, position4: 0.466 } },
    { type: 'grid', params: { kind: 'floor', y: 43, cell: 9, lineWidth: 0.35, lineColour: '#ff4fa0', fade: 0.85 } },
  ],
  // Not a kind of layer: the title used as a mask, for the page on masks, with smoky noise through its letters.
  mask: [
    dark,
    { type: 'group', size: 2, params: {} },
    { type: 'text', params: { text: 'NIGHTSHIFT', size: 19, weight: 900, colour: '#ffffff', mask: 'by its shape' } },
    { type: 'noise', params: { kind: 'clouds', warp: 0.7, size: 30, seed: 2, ...stops('#3a1c71', '#ff4fa0', '#ffd27a') } },
  ],
  mosaic: [...scene, { type: 'mosaic', params: { cells: 'hexagons', size: 3.5 } }],
  gradientMap: [...scene, { type: 'gradientMap', params: { ...stops('#0b1a3a', '#2fbfa8', '#fff3c4') } }],
  displace: [...scene, { type: 'displace', params: { mode: 'swirl', twist: 160, radius: 55, y: 45 } }],
  whiteBalance: [...scene, { type: 'whiteBalance', params: { temperature: -0.8, tint: -0.3 } }],
  kaleidoscope: [...scene, { type: 'kaleidoscope', params: { segments: 8 } }],
  transform: [...scene, { type: 'transform', params: { scale: 45, rotation: 15, edges: 'mirror' } }],
  trails: [...scene, { type: 'trails', params: { length: 1.5, mode: 'bright parts', zoom: 25 } }],
  vignette: [...scene, { type: 'vignette', params: { size: 30 } }],
  blur: [...scene, { type: 'blur', params: { radius: 1.2 } }],
  lut: [...scene, { type: 'lut', params: { lut: 'lutfolder:Teal and orange' } }],
};
// One group per kind, shown when the field n is its number; up to 100 so that the field's slider lands on each.
const layers = Object.entries(LAYERS).flatMap(([type, inside], index) => [
  { type: 'group', name: type, size: inside.length, params: { visible: `n == ${index + 1}` } },
  ...inside.map((layer) => structuredClone(layer)),
]);
const template = join(work, 'Manual pictures.djmtemplate');
writeFileSync(template, JSON.stringify({
  format: 3,
  name: 'Manual pictures',
  fields: [{ key: 'n', label: 'Which', kind: 'number', default: 1, min: 0, max: 100 }],
  assets: { Logo: logo },
  layers,
}));

const script = readFileSync(join(here, 'pictures.js'), 'utf8')
  .replace('await SETUP;', `await ${readFileSync(join(root, 'scripts', 'screenshot', 'setup.js'), 'utf8').trim().replace(/;$/, '')};`)
  .replace('LAYERS.entries()', `${JSON.stringify(Object.keys(LAYERS))}.entries()`);

execFileSync('node', ['scripts/build.mjs'], { stdio: 'inherit', cwd: root });
const picture = join(work, 'last.png');
const app = spawn('npx', ['electron', '.', shown], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    DJMASTER_SHOT: picture,
    DJMASTER_SHOT_SCALE: '2',
    DJMASTER_SHOT_DATA: data,
    DJMASTER_SHOT_TRACKLIST: join(root, 'scripts', 'screenshot', 'tracks.txt'),
    DJMASTER_SHOT_TEMPLATE: template,
    DJMASTER_SHOT_SCRIPT: script,
  },
});
app.stdout.on('data', (chunk) => process.stdout.write(chunk));
const limit = setTimeout(() => app.kill(), 10 * 60_000);
app.on('close', () => {
  clearTimeout(limit);
  mkdirSync(join(out, 'layers'), { recursive: true });
  let copied = 0;
  for (const file of readdirSync(work)) {
    if (file === 'last.png' || !/\.(png|jpg)$/.test(file)) continue;
    // A kind of layer's picture goes with the others in layers/; one of LAYERS that is not a kind of layer (a mask), beside the rest.
    const layer = file.match(/^layer-(.+)\.jpg$/);
    const kind = layer && !NOT_KINDS.has(layer[1]);
    copyFileSync(join(work, file), kind ? join(out, 'layers', `${layer[1]}.jpg`) : join(out, layer ? `${layer[1]}.jpg` : file));
    copied++;
  }
  const missing = Object.keys(LAYERS).filter((type) => !existsSync(join(work, `layer-${type}.jpg`)));
  console.log(`Saved ${copied} pictures in site/manual/pictures/.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''} Look at them before committing.`);
  if (missing.length || copied === 0) process.exitCode = 1;
  rmSync(work, { recursive: true, force: true });
});
