// The patterns of a noise layer: clouds, turbulence, ridges, cells, cell
// edges, marble and plasma. Each is a value from 0 to 1 at every point of
// the picture and moment of the mix, worked out from those alone, so any
// frame comes out the same whatever was drawn before it.
//
// Written twice, as the same steps: once as a shader for the graphics card
// (NOISE_SHADER), which draws a whole frame of it in a millisecond, and once
// here, for a computer without one (drawn smaller then, and enlarged) and
// for the tests. Randomness comes from an integer hash, which the card and
// the processor work out exactly alike; a change to one must be made to the
// other.
//
// Kept free of Node imports: the window draws with it.

export const NOISE_KINDS = ['clouds', 'turbulence', 'ridges', 'cells', 'cell edges', 'marble', 'plasma'] as const;

/** What shapes a pattern besides where and when. */
export interface NoiseOptions {
  /** One of NOISE_KINDS. */
  kind: string;
  /** How many layers of finer and finer detail, 1 to 8. */
  detail: number;
  /** How much each finer layer counts against the one before, 0 to 1. */
  roughness: number;
  /** How far the pattern is bent by another noise first, 0 to 1. */
  warp: number;
  /** A whole number: another pattern of the same look for each. */
  seed: number;
}

/** A seed as the patterns use it: its bits mixed, so that seeds 1 and 2 are as unlike as any two. */
export const seedBits = (seed: number) => mixBits(Math.round(seed) >>> 0);

/** Each kind's number in the shader. */
export const kindNumber = (kind: string) => Math.max(0, NOISE_KINDS.indexOf(kind as (typeof NOISE_KINDS)[number]));

// -------------------------------------------------------------------------
// The integer hash, as the shader has it: 32-bit unsigned arithmetic.

function mixBits(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function hash3(i: number, j: number, k: number, seed: number): number {
  return mixBits((Math.imul(i, 73856093) ^ mixBits((Math.imul(j, 19349663) ^ mixBits((Math.imul(k, 83492791) ^ seed) >>> 0)) >>> 0)) >>> 0);
}

/** One of the twelve directions of Perlin's improved noise, picked by a hash, against an offset. */
function grad(h: number, x: number, y: number, z: number): number {
  const c = h & 15;
  const u = c < 8 ? x : y;
  const v = c < 4 ? y : c === 12 || c === 14 ? x : z;
  return ((c & 1) ? -u : u) + ((c & 2) ? -v : v);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Gradient noise in three dimensions (two of the picture, one of time), about -1 to 1. */
export function gradientNoise(x: number, y: number, z: number, seed: number): number {
  const [xi, yi, zi] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [xf, yf, zf] = [x - xi, y - yi, z - zi];
  const [u, v, w] = [fade(xf), fade(yf), fade(zf)];
  const g = (a: number, b: number, c: number) => grad(hash3(xi + a, yi + b, zi + c, seed), xf - a, yf - b, zf - c);
  return lerp(
    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v),
    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v),
    w,
  );
}

/**
 * The nearest and the second nearest of points scattered one to a square,
 * each circling its own place over time: the distances, F1 and F2.
 */
export function cellDistances(x: number, y: number, t: number, layer: number, seed: number): [number, number] {
  const [xi, yi] = [Math.floor(x), Math.floor(y)];
  let f1 = 8;
  let f2 = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = hash3(xi + i, yi + j, layer, seed);
      const a = (h & 0xffff) / 65536;
      const b = (h >>> 16) / 65536;
      const speed = 0.5 + a;
      const px = i + 0.5 + 0.45 * Math.sin(t * speed + 6.2831853 * a);
      const py = j + 0.5 + 0.45 * Math.sin(t * speed * 0.8 + 6.2831853 * b);
      const d = Math.hypot(px - (x - xi), py - (y - yi));
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  return [f1, f2];
}

/** Layers of gradient noise, each twice as fine as the one before: about -1 to 1. */
function clouds(x: number, y: number, t: number, octaves: number, roughness: number, seed: number): number {
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * gradientNoise(x * frequency + i * 13.37, y * frequency + i * 7.91, t + i * 17, seed);
    total += amplitude;
    amplitude *= roughness;
    frequency *= 2;
  }
  return sum / total;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The pattern at (x, y), in the pattern's own units, at time `t` (its evolution so far): 0 to 1. */
export function noiseValue(x: number, y: number, t: number, options: NoiseOptions): number {
  const octaves = Math.max(1, Math.min(8, Math.round(options.detail)));
  const roughness = clamp01(options.roughness);
  const seed = seedBits(options.seed);
  // Bent by noise first: what makes clouds look like smoke rather than blots.
  if (options.warp > 0) {
    const few = Math.min(octaves, 4);
    const wx = clouds(x + 5.2, y + 1.3, t, few, roughness, seed);
    const wy = clouds(x + 9.7, y + 2.8, t, few, roughness, seed);
    x += options.warp * 2 * wx;
    y += options.warp * 2 * wy;
  }
  let sum = 0;
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  switch (kindNumber(options.kind)) {
    case 0: return clamp01(0.5 + 1.2 * clouds(x, y, t, octaves, roughness, seed));
    case 1:
    case 2: {
      const ridged = options.kind === 'ridges';
      for (let i = 0; i < octaves; i++) {
        const n = Math.abs(gradientNoise(x * frequency + i * 13.37, y * frequency + i * 7.91, t + i * 17, seed));
        sum += amplitude * (ridged ? (1 - n) * (1 - n) : n);
        total += amplitude;
        amplitude *= roughness;
        frequency *= 2;
      }
      return clamp01(ridged ? (sum / total - 0.35) * 1.6 : (sum / total) * 2.2);
    }
    case 3:
    case 4: {
      const edges = options.kind === 'cell edges';
      for (let i = 0; i < octaves; i++) {
        const [f1, f2] = cellDistances(x * frequency + i * 13.37, y * frequency + i * 7.91, t, i, seed);
        sum += amplitude * (edges ? 1 - clamp01((f2 - f1) * 4) : f1);
        total += amplitude;
        amplitude *= roughness;
        frequency *= 2;
      }
      return clamp01(edges ? sum / total : (sum / total - 0.1) * 1.8);
    }
    case 5: return 0.5 + 0.5 * Math.sin(6.2831853 * x + 3 * clouds(x, y, t, octaves, roughness, seed));
    default: {
      // Plasma: waves across, down, aslant and round a wandering point, added up.
      const cx = Math.sin(t * 0.7) * 1.5;
      const cy = Math.cos(t * 0.5) * 1.5;
      const s = Math.sin(x * 6 + t) + Math.sin(y * 4.8 + t * 1.3) + Math.sin((x + y) * 3.6 + t * 0.7) + Math.sin(Math.hypot(x - cx, y - cy) * 7 - t);
      return 0.5 + s / 8;
    }
  }
}

/**
 * Cut down to patches: of the values, the top `coverage` shows, rising from
 * nothing to all over `softness` of the rest. Coverage 1 and softness 1
 * leave them as they are.
 */
export function covered(value: number, coverage: number, softness: number): number {
  const threshold = 1 - clamp01(coverage);
  return clamp01((value - threshold) / Math.max(1e-3, clamp01(softness) * (1 - threshold)));
}

/**
 * The patterns' steps for the graphics card, to be put into a shader after
 * its `#version` and precisions: `pattern(p, t)` gives what `noiseValue`
 * does, with the options as the uniforms `kind` (kindNumber), `octaves`,
 * `roughness`, `warp` and `seed` (seedBits). The noise layer's shader and
 * the displace layer's are both made with it.
 */
export const NOISE_GLSL = `
uniform int kind;
uniform int octaves;
uniform float roughness;
uniform float warp;
uniform uint seed;

uint mixBits(uint x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; return x ^ (x >> 16);
}
uint hash3(int i, int j, int k, uint s) {
  return mixBits((uint(i) * 73856093u) ^ mixBits((uint(j) * 19349663u) ^ mixBits((uint(k) * 83492791u) ^ s)));
}
float grad(uint h, float x, float y, float z) {
  uint c = h & 15u;
  float u = c < 8u ? x : y;
  float v = c < 4u ? y : (c == 12u || c == 14u ? x : z);
  return ((c & 1u) != 0u ? -u : u) + ((c & 2u) != 0u ? -v : v);
}
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float gradientNoise(vec3 p, uint s) {
  vec3 i = floor(p);
  vec3 f = p - i;
  ivec3 n = ivec3(i);
  float u = fade(f.x), v = fade(f.y), w = fade(f.z);
  #define G(a, b, c) grad(hash3(n.x + a, n.y + b, n.z + c, s), f.x - float(a), f.y - float(b), f.z - float(c))
  return mix(
    mix(mix(G(0, 0, 0), G(1, 0, 0), u), mix(G(0, 1, 0), G(1, 1, 0), u), v),
    mix(mix(G(0, 0, 1), G(1, 0, 1), u), mix(G(0, 1, 1), G(1, 1, 1), u), v),
    w);
}
vec2 cellDistances(vec2 p, float t, int layer, uint s) {
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0, f2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      uint h = hash3(int(i.x) + x, int(i.y) + y, layer, s);
      float a = float(h & 0xffffu) / 65536.0;
      float b = float(h >> 16) / 65536.0;
      float speed = 0.5 + a;
      vec2 point = vec2(float(x) + 0.5 + 0.45 * sin(t * speed + 6.2831853 * a), float(y) + 0.5 + 0.45 * sin(t * speed * 0.8 + 6.2831853 * b));
      float d = length(point - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2);
}
float clouds(vec2 p, float t, int count, uint s) {
  float sum = 0.0, total = 0.0, amplitude = 1.0, frequency = 1.0;
  for (int i = 0; i < 8; i++) {
    if (i >= count) break;
    float o = float(i);
    sum += amplitude * gradientNoise(vec3(p * frequency + vec2(o * 13.37, o * 7.91), t + o * 17.0), s);
    total += amplitude;
    amplitude *= roughness;
    frequency *= 2.0;
  }
  return sum / total;
}
float pattern(vec2 p, float t) {
  if (warp > 0.0) {
    int few = min(octaves, 4);
    vec2 bend = vec2(clouds(p + vec2(5.2, 1.3), t, few, seed), clouds(p + vec2(9.7, 2.8), t, few, seed));
    p += warp * 2.0 * bend;
  }
  float sum = 0.0, total = 0.0, amplitude = 1.0, frequency = 1.0;
  if (kind == 0) return clamp(0.5 + 1.2 * clouds(p, t, octaves, seed), 0.0, 1.0);
  if (kind == 1 || kind == 2) {
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      float o = float(i);
      float n = abs(gradientNoise(vec3(p * frequency + vec2(o * 13.37, o * 7.91), t + o * 17.0), seed));
      sum += amplitude * (kind == 2 ? (1.0 - n) * (1.0 - n) : n);
      total += amplitude;
      amplitude *= roughness;
      frequency *= 2.0;
    }
    return clamp(kind == 2 ? (sum / total - 0.35) * 1.6 : (sum / total) * 2.2, 0.0, 1.0);
  }
  if (kind == 3 || kind == 4) {
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      float o = float(i);
      vec2 f = cellDistances(p * frequency + vec2(o * 13.37, o * 7.91), t, i, seed);
      sum += amplitude * (kind == 4 ? 1.0 - clamp((f.y - f.x) * 4.0, 0.0, 1.0) : f.x);
      total += amplitude;
      amplitude *= roughness;
      frequency *= 2.0;
    }
    return clamp(kind == 4 ? sum / total : (sum / total - 0.1) * 1.8, 0.0, 1.0);
  }
  if (kind == 5) return 0.5 + 0.5 * sin(6.2831853 * p.x + 3.0 * clouds(p, t, octaves, seed));
  vec2 c = vec2(sin(t * 0.7), cos(t * 0.5)) * 1.5;
  float s = sin(p.x * 6.0 + t) + sin(p.y * 4.8 + t * 1.3) + sin((p.x + p.y) * 3.6 + t * 0.7) + sin(length(p - c) * 7.0 - t);
  return 0.5 + s / 8.0;
}
`;

/**
 * The noise layer's shader. Uniforms: the picture's height in
 * pixels, `origin` (the pattern's middle, in pixels, moved along as it
 * drifts), `axes` (pixels to pattern units: a 2×2 matrix that sizes and
 * turns), `time`, the options, `coverage` and `softness`, and three colours
 * as RGBA, alpha 0 for none.
 */
export const NOISE_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform float height;
uniform vec2 origin;
uniform mat2 axes;
uniform float time;
uniform float coverage;
uniform float softness;
uniform vec4 colour1;
uniform vec4 colour2;
uniform vec4 colour3;
out vec4 colour;
${NOISE_GLSL}
void main() {
  // The canvas counts down from the top; the card, up from the bottom.
  vec2 pixel = vec2(gl_FragCoord.x, height - gl_FragCoord.y);
  vec2 p = axes * (pixel - origin);
  float threshold = 1.0 - clamp(coverage, 0.0, 1.0);
  float v = clamp((pattern(p, time) - threshold) / max(1e-3, clamp(softness, 0.0, 1.0) * (1.0 - threshold)), 0.0, 1.0);
  // Mixed premultiplied, so that a colour left empty fades out rather than towards black.
  vec4 a = vec4(colour1.rgb * colour1.a, colour1.a);
  vec4 b = vec4(colour2.rgb * colour2.a, colour2.a);
  vec4 c3 = vec4(colour3.rgb * colour3.a, colour3.a);
  colour = colour3.a > 0.0 ? (v < 0.5 ? mix(a, b, v * 2.0) : mix(b, c3, v * 2.0 - 1.0)) : mix(a, b, v);
}
`;
