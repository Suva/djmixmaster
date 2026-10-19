// Colour lookup tables: the .cube files that colourists and video editors
// make looks with (Adobe's format, which Resolve, Premiere and the rest read
// and write). A LUT layer sends the picture beneath it through one.
//
// A template keeps its LUTs packed, not as the file's text: sixteen bits a
// value, which is finer than the eight a frame has, at a third of the size
// of the text. A template is held whole in the editor's undo history, so the
// size counts.
//
// Kept free of Node imports: the window reads LUTs and draws with them.

/** A 3D table: `size` points along each of red, green and blue. */
export interface Lut {
  title?: string;
  size: number;
  /** Red, green and blue for each point, red changing fastest, then green, then blue: as the file lists them. */
  data: Float32Array;
  /** The input values that the first and the last point stand for; 0 and 1 for most. */
  min: [number, number, number];
  max: [number, number, number];
}

/** A LUT as a template keeps it. */
export interface PackedLut {
  title?: string;
  size: number;
  /** Red, green and blue at each point, as 16-bit whole numbers little end first from `low` to `high`, in base 64. */
  data: string;
  min?: [number, number, number];
  max?: [number, number, number];
  /** What the values go from and to, where a LUT gives some below 0 or above 1. */
  low?: number;
  high?: number;
}

/** The most points along a side. 65 is the most that is in common use; 129 would be 2 million points. */
export const LUT_MOST_SIZE = 65;
/** A 1D LUT is made into a 3D one of this size, so that one way of applying them serves both. */
const FROM_1D_SIZE = 33;

/**
 * Reads a .cube file. A 1D table is made into a 3D one. What cannot be read
 * is an error saying why, in words for someone who picked the file.
 */
export function parseCube(text: string): Lut {
  let title: string | undefined;
  let size3 = 0;
  let size1 = 0;
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const triple = (words: string[], line: number): [number, number, number] => {
    const numbers = words.slice(1).map(Number);
    if (numbers.length !== 3 || !numbers.every(Number.isFinite)) throw new Error(`Line ${line} should give three numbers`);
    return numbers as [number, number, number];
  };
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[-+.\d]/.test(line)) {
      const numbers = line.split(/\s+/).map(Number);
      if (numbers.length !== 3 || !numbers.every(Number.isFinite)) throw new Error(`Line ${index + 1} should be three numbers`);
      values.push(numbers[0], numbers[1], numbers[2]);
      continue;
    }
    const words = line.split(/\s+/);
    const keyword = words[0].toUpperCase();
    if (keyword === 'TITLE') title = line.slice(5).trim().replace(/^"(.*)"$/, '$1') || undefined;
    else if (keyword === 'LUT_3D_SIZE') size3 = Number(words[1]);
    else if (keyword === 'LUT_1D_SIZE') size1 = Number(words[1]);
    else if (keyword === 'DOMAIN_MIN') min = triple(words, index + 1);
    else if (keyword === 'DOMAIN_MAX') max = triple(words, index + 1);
    else if (keyword === 'LUT_3D_INPUT_RANGE' || keyword === 'LUT_1D_INPUT_RANGE') {
      const [low, high] = words.slice(1).map(Number);
      if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error(`Line ${index + 1} should give two numbers`);
      min = [low, low, low];
      max = [high, high, high];
    }
    // Other keywords (LUT_IN_VIDEO_RANGE and the like) change nothing a frame needs.
  }
  if (size3 && size1) throw new Error('This file has a 1D and a 3D table together, which the app cannot read yet');
  if (!size3 && !size1) throw new Error('Not a .cube LUT: it gives no LUT_3D_SIZE or LUT_1D_SIZE');
  if (min.some((low, i) => !(max[i] > low))) throw new Error('DOMAIN_MAX should be above DOMAIN_MIN');

  if (size3) {
    if (!Number.isInteger(size3) || size3 < 2) throw new Error('LUT_3D_SIZE should be a whole number of 2 or more');
    if (size3 > LUT_MOST_SIZE) throw new Error(`The table has ${size3} points a side; at most ${LUT_MOST_SIZE} are taken`);
    if (values.length !== size3 ** 3 * 3) throw new Error(`The table should have ${size3 ** 3} rows, and has ${values.length / 3}`);
    return { ...(title ? { title } : {}), size: size3, data: Float32Array.from(values), min, max };
  }

  if (!Number.isInteger(size1) || size1 < 2 || size1 > 65536) throw new Error('LUT_1D_SIZE should be a whole number from 2 to 65536');
  if (values.length !== size1 * 3) throw new Error(`The table should have ${size1} rows, and has ${values.length / 3}`);
  // A curve per channel, read off at the points of a 3D table.
  const curve = (channel: number, t: number) => {
    const at = t * (size1 - 1);
    const i = Math.min(size1 - 2, Math.floor(at));
    const f = at - i;
    return values[i * 3 + channel] * (1 - f) + values[(i + 1) * 3 + channel] * f;
  };
  const n = FROM_1D_SIZE;
  const data = new Float32Array(n ** 3 * 3);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const at = ((b * n + g) * n + r) * 3;
        data[at] = curve(0, r / (n - 1));
        data[at + 1] = curve(1, g / (n - 1));
        data[at + 2] = curve(2, b / (n - 1));
      }
    }
  }
  return { ...(title ? { title } : {}), size: n, data, min, max };
}

const isDefaultDomain = (lut: Pick<Lut, 'min' | 'max'>) => lut.min.every((v) => v === 0) && lut.max.every((v) => v === 1);

/** A LUT as a template keeps it. */
export function packLut(lut: Lut): PackedLut {
  let low = 0;
  let high = 1;
  for (const value of lut.data) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  const bytes = new Uint8Array(lut.data.length * 2);
  for (let i = 0; i < lut.data.length; i++) {
    const v = Math.round(((lut.data[i] - low) / (high - low)) * 65535);
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = v >> 8;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    ...(lut.title ? { title: lut.title } : {}),
    size: lut.size,
    data: btoa(binary),
    ...(isDefaultDomain(lut) ? {} : { min: lut.min, max: lut.max }),
    ...(low !== 0 || high !== 1 ? { low, high } : {}),
  };
}

const isTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

/** A LUT a template keeps, ready to use; an error if what is kept is not one. */
export function unpackLut(packed: unknown): Lut {
  const given = (typeof packed === 'object' && packed !== null ? packed : {}) as Partial<PackedLut>;
  const size = given.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 2 || size > LUT_MOST_SIZE) throw new Error('Has no size the app can use');
  if (typeof given.data !== 'string') throw new Error('Has no table');
  let binary: string;
  try {
    binary = atob(given.data);
  } catch {
    throw new Error('Its table is damaged');
  }
  if (binary.length !== size ** 3 * 6) throw new Error('Its table is the wrong length for its size');
  const low = Number.isFinite(given.low) ? Number(given.low) : 0;
  const high = Number.isFinite(given.high) ? Number(given.high) : 1;
  if (!(high > low)) throw new Error('Its range is wrong');
  const data = new Float32Array(size ** 3 * 3);
  for (let i = 0; i < data.length; i++) data[i] = low + ((binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8)) / 65535) * (high - low);
  const min = isTriple(given.min) ? given.min : [0, 0, 0] as [number, number, number];
  const max = isTriple(given.max) ? given.max : [1, 1, 1] as [number, number, number];
  if (min.some((v, i) => !(max[i] > v))) throw new Error('Its range is wrong');
  return { ...(typeof given.title === 'string' && given.title ? { title: given.title } : {}), size, data, min, max };
}

/**
 * What the LUT makes of a colour, each channel 0 to 1: read between its
 * eight nearest points (trilinear), as the graphics card does.
 */
export function sampleLut(lut: Lut, r: number, g: number, b: number, into: Float32Array | number[] = new Float32Array(3)): Float32Array | number[] {
  const n = lut.size;
  const last = n - 1;
  const position = (value: number, channel: number) =>
    Math.min(last, Math.max(0, ((value - lut.min[channel]) / (lut.max[channel] - lut.min[channel])) * last));
  const x = position(r, 0);
  const y = position(g, 1);
  const z = position(b, 2);
  const x0 = Math.min(last - 1, Math.floor(x));
  const y0 = Math.min(last - 1, Math.floor(y));
  const z0 = Math.min(last - 1, Math.floor(z));
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const data = lut.data;
  const at = (i: number, j: number, k: number) => ((k * n + j) * n + i) * 3;
  for (let c = 0; c < 3; c++) {
    const c00 = data[at(x0, y0, z0) + c] * (1 - fx) + data[at(x0 + 1, y0, z0) + c] * fx;
    const c10 = data[at(x0, y0 + 1, z0) + c] * (1 - fx) + data[at(x0 + 1, y0 + 1, z0) + c] * fx;
    const c01 = data[at(x0, y0, z0 + 1) + c] * (1 - fx) + data[at(x0 + 1, y0, z0 + 1) + c] * fx;
    const c11 = data[at(x0, y0 + 1, z0 + 1) + c] * (1 - fx) + data[at(x0 + 1, y0 + 1, z0 + 1) + c] * fx;
    into[c] = (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  return into;
}

/**
 * A LUT that scales red, green and blue by these amounts. Two points a side
 * are enough: a LUT is read in straight lines between its points, and a
 * scaling is a straight line, so it comes out exact, over 1 included until
 * the picture's own 8 bits cut it off.
 */
export function scalingLut([r, g, b]: [number, number, number]): Lut {
  const data = new Float32Array(2 * 2 * 2 * 3);
  let i = 0;
  for (let z = 0; z < 2; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    data[i++] = x * r;
    data[i++] = y * g;
    data[i++] = z * b;
  }
  return { size: 2, data, min: [0, 0, 0], max: [1, 1, 1] };
}

/**
 * Sends pixels (RGBA, 8 bits each, not premultiplied, as `getImageData`
 * gives them) through the LUT in place. For where the graphics card cannot
 * be used: a 1080p frame takes some tens of milliseconds this way.
 */
export function applyLut(lut: Lut, pixels: Uint8ClampedArray) {
  const out = new Float32Array(3);
  // Most frames have far fewer colours than pixels; neighbouring pixels are often the same.
  let lastIn = -1;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    if (key !== lastIn) {
      sampleLut(lut, pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, out);
      r = out[0] * 255;
      g = out[1] * 255;
      b = out[2] * 255;
      lastIn = key;
    }
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}
