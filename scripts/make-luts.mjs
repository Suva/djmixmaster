// Makes the LUTs that come with the app, into assets/luts, from the list in
// src/visuals/builtin-luts.ts: 33 points a side, 16 bits a value, stored
// small (`encodeBuiltinLut`) and compressed.
//
//   node scripts/make-luts.mjs [folder of the HaldCLUT collection]
//
// The app's own looks are worked out here, from the recipes below. The film
// looks are read from Pat David's HaldCLUTs, as published in
// https://github.com/NatronGitHub/clut (CC BY-SA 4.0): a folder with its
// bw/, colorslide/ and the rest. Without it, only the app's own looks are
// made again and the film looks already in assets/luts are left as they are.
import { deflateRawSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILTIN_LUTS, builtinLutFile, encodeBuiltinLut } from '../src/visuals/builtin-luts.ts';
import { sampleLut } from '../src/visuals/lut.ts';

const SIZE = 33;
const OUT = 'assets/luts';
const haldFolder = process.argv[2];

// ---------------------------------------------------------------------------
// The app's own looks. Each turns a colour, red, green and blue from 0 to 1
// as the picture has them (sRGB), into another. Kept simple on purpose: a
// look is a starting point, and the layer's opacity says how much of it.

const clamp = (x) => Math.min(1, Math.max(0, x));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** An S-curve about the middle: above 1, more contrast; below, less. */
const contrast = (x, amount) => (x < 0.5 ? 0.5 * (2 * x) ** amount : 1 - 0.5 * (2 * (1 - x)) ** amount);
const saturate = (rgb, amount) => {
  const l = luma(rgb);
  return rgb.map((x) => l + (x - l) * amount);
};
/** Moves a colour towards a tint without changing its brightness much: the tint less its own grey. */
const tint = (rgb, [tr, tg, tb], amount) => {
  const l = (0.2126 * tr + 0.7152 * tg + 0.0722 * tb);
  return [rgb[0] + (tr - l) * amount, rgb[1] + (tg - l) * amount, rgb[2] + (tb - l) * amount];
};
/** A colour from a gradient of stops through brightness, for duotones and toning. */
const gradient = (stops, t) => {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0] || i === stops.length - 1) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const f = clamp((t - a) / (b - a));
      return ca.map((x, c) => mix(x, cb[c], f));
    }
  }
};
const hex = (code) => [0, 2, 4].map((i) => parseInt(code.slice(i + 1, i + 3), 16) / 255);

const RECIPES = {
  // Cool shadows, warm highlights: the blockbuster grade, that keeps skin warm against everything else.
  'Teal & Orange': (rgb) => {
    const l = luma(rgb);
    const high = smoothstep(0.15, 0.85, l);
    let out = tint(rgb, hex('#008c9e'), 0.28 * (1 - high));
    out = tint(out, hex('#ff8a2b'), 0.22 * high);
    return saturate(out.map((x) => contrast(clamp(x), 1.15)), 1.1);
  },
  // As if the silver were left in the print: little colour, hard contrast.
  'Bleach Bypass': (rgb) => saturate(rgb, 0.4).map((x) => contrast(clamp(x), 1.55)),
  // Slide film developed as negative: hard reds, lifted blue shadows, yellow-green highlights.
  'Cross Process': ([r, g, b]) => [contrast(r, 1.45), mix(0.03, 0.97, contrast(g, 1.2)), mix(0.18, 0.82, b)],
  // The picture's light as a gradient from deep indigo through magenta to pale pink: for the club.
  'Neon Duotone': (rgb) => gradient([[0, hex('#0a0430')], [0.45, hex('#8a10a8')], [0.75, hex('#ff3fa0')], [1, hex('#ffe3f4')]], contrast(luma(rgb), 1.15)),
  // Golden highlights over purple shadows.
  'Sunset': (rgb) => {
    const high = smoothstep(0.2, 0.9, luma(rgb));
    let out = tint(rgb, hex('#6a2c91'), 0.3 * (1 - high));
    out = tint(out, hex('#ffb347'), 0.3 * high);
    return saturate(out, 1.15);
  },
  // Day for night: darker, bluer, little colour left.
  'Night Blue': (rgb) => {
    const dark = saturate(rgb, 0.45).map((x) => clamp(x) ** 1.35 * 0.75);
    return tint(dark, hex('#2050ff'), 0.32).map((x) => x + 0.015);
  },
  // Green in the middle tones and the shadows, the colour of a monitor at night.
  'Green Haze': (rgb) => {
    const l = luma(rgb);
    const out = tint(saturate(rgb, 0.7), hex('#3cff6e'), 0.22 * (1 - smoothstep(0.6, 1, l)));
    return out.map((x) => mix(0.04, 0.96, contrast(clamp(x), 1.2)));
  },
  'Warm': ([r, g, b]) => [r * 1.06 + 0.01, g * 1.01, b * 0.88].map((x) => contrast(clamp(x), 1.05)),
  'Cool': ([r, g, b]) => [r * 0.9, g * 1.0, b * 1.08 + 0.02].map((x) => contrast(clamp(x), 1.05)),
  // Lifted blacks and lowered whites, a little colour gone, the shadows warm: an old print.
  'Faded': (rgb) => tint(saturate(rgb, 0.8).map((x) => mix(0.09, 0.9, clamp(x))), hex('#c08850'), 0.06 * (1 - luma(rgb))),
  'Punchy': (rgb) => saturate(rgb.map((x) => contrast(x, 1.35)), 1.15),
  'Vivid': (rgb) => saturate(rgb, 1.45).map((x) => contrast(clamp(x), 1.08)),
  // Black and white with deep blacks and bright whites.
  'Noir': (rgb) => {
    const l = contrast(clamp((luma(rgb) - 0.04) / 0.92), 1.75);
    return [l, l, l];
  },
  // Black and white toned brown, in the shadows more than the highlights.
  'Sepia': (rgb) => gradient([[0, hex('#1a0f08')], [0.5, hex('#8a6440')], [1, hex('#fff2dc')]], contrast(luma(rgb), 1.1)),
};

function fromRecipe(recipe) {
  const data = new Float32Array(SIZE ** 3 * 3);
  let i = 0;
  for (let b = 0; b < SIZE; b++) for (let g = 0; g < SIZE; g++) for (let r = 0; r < SIZE; r++) {
    for (const x of recipe([r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1)])) data[i++] = clamp(x);
  }
  return { size: SIZE, data, min: [0, 0, 0], max: [1, 1, 1] };
}

// ---------------------------------------------------------------------------
// HaldCLUTs: a picture whose pixels, read in rows, are the points of a 3D
// table, red changing fastest. Of level L the picture is L³ pixels square and
// the table L² points a side. These are 16-bit PNGs, read here without a
// library: the chunks, the compressed rows, and each row's filter undone.

function readPng(bytes) {
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  const parts = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      type = body[9];
      if (body[12] !== 0) throw new Error('Interlaced PNGs are not read');
    } else if (kind === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const channels = { 2: 3, 6: 4 }[type];
  if (!channels || (depth !== 8 && depth !== 16)) throw new Error(`PNG of colour type ${type} at ${depth} bits is not read`);
  const step = (channels * depth) / 8;
  const stride = width * step;
  const raw = inflateSync(Buffer.concat(parts));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= step ? out[x - step] : 0;
      const b = up[x];
      const c = x >= step ? up[x - step] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = (line[x] + predicted) & 0xff;
    }
  }
  const pixels = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      pixels[i * 3 + c] = depth === 16 ? rows.readUInt16BE(i * step + c * 2) / 65535 : rows[i * step + c] / 255;
    }
  }
  return { width, height, pixels };
}

function fromHald(png) {
  const level = Math.round(Math.cbrt(png.width));
  if (level ** 3 !== png.width || png.width !== png.height) throw new Error('Not a HaldCLUT: it should be a square of a cube a side');
  const full = { size: level * level, data: png.pixels, min: [0, 0, 0], max: [1, 1, 1] };
  // Read off at the points of a smaller table, between the HaldCLUT's own points as the card would.
  const data = new Float32Array(SIZE ** 3 * 3);
  const into = new Float32Array(3);
  let i = 0;
  for (let b = 0; b < SIZE; b++) for (let g = 0; g < SIZE; g++) for (let r = 0; r < SIZE; r++) {
    sampleLut(full, r / (SIZE - 1), g / (SIZE - 1), b / (SIZE - 1), into);
    data[i++] = into[0];
    data[i++] = into[1];
    data[i++] = into[2];
  }
  return { size: SIZE, data, min: [0, 0, 0], max: [1, 1, 1] };
}

await mkdir(OUT, { recursive: true });
let made = 0;
for (const look of BUILTIN_LUTS) {
  let lut;
  if (look.hald) {
    if (!haldFolder) continue;
    lut = fromHald(readPng(await readFile(join(haldFolder, look.hald))));
  } else {
    const recipe = RECIPES[look.name];
    if (!recipe) throw new Error(`No recipe for ${look.name}`);
    lut = fromRecipe(recipe);
  }
  await writeFile(join(OUT, builtinLutFile(look.name)), deflateRawSync(encodeBuiltinLut(lut), { level: 9 }));
  made++;
}
console.log(`Made ${made} LUTs in ${OUT}${haldFolder ? '' : ' (the film looks were left as they were: no HaldCLUT folder given)'}`);
