// Where a displace layer reads each pixel of the picture beneath from: the
// offset that wobbles it with noise, waves it, ripples it out from a point,
// swirls it round one or bulges it as a lens does. Worked out from the
// pixel's place and the moment alone, so any frame comes out the same
// whatever was drawn before it.
//
// Written twice, as the same steps, as the noise layer's patterns are (see
// noise.ts): DISPLACE_SHADER for the graphics card, and displacementAt for
// a computer without one and for the tests. A change to one must be made to
// the other.
//
// Kept free of Node imports: the window draws with it.

import { NOISE_GLSL, noiseValue, type NoiseOptions } from './noise.ts';

export const DISPLACE_MODES = ['noise', 'waves', 'ripples', 'swirl', 'bulge'] as const;

/** What decides the offsets, in the picture's pixels. */
export interface Displacement {
  /** One of DISPLACE_MODES. */
  mode: string;
  /** How far pixels move at most, in pixels; below zero, the other way (a bulge pinches). */
  amount: number;
  /** How far a swirl turns at its middle, in radians. */
  twist: number;
  /** A wave's length, or the size of the noise's features, in pixels. */
  size: number;
  /** How far ripples, a swirl or a bulge reach from the middle, in pixels. */
  radius: number;
  /** The way waves travel, in radians: 0 across to the right, a quarter turn down. */
  direction: number;
  /** How far it has moved: waves and ripples in whole waves, noise in its own time. */
  time: number;
  /** The noise, for that mode. */
  noise: NoiseOptions;
  /**
   * Held at the edges of a picture this size: the movement eased away to
   * nothing over `margin` pixels from them, and nothing read from past them.
   */
  hold?: { width: number; height: number; margin: number };
}

/** Each mode's number in the shader. */
export const modeNumber = (mode: string) => Math.max(0, DISPLACE_MODES.indexOf(mode as (typeof DISPLACE_MODES)[number]));

/**
 * How far from the pixel at (x, y) the picture is read for it, given the
 * layer's middle (cx, cy): all in pixels. The pixel shows what is at
 * (x + dx, y + dy).
 */
export function displacementAt(x: number, y: number, cx: number, cy: number, d: Displacement): [number, number] {
  const [dx, dy] = moved(x, y, cx, cy, d);
  if (!d.hold) return [dx, dy];
  const { width, height, margin } = d.hold;
  // Measured from the middles of the outermost pixels, which stay exactly where they are.
  const near = Math.min(x - 0.5, y - 0.5, width - 0.5 - x, height - 0.5 - y);
  const t = margin > 0 ? Math.min(1, Math.max(0, near / margin)) : 1;
  const eased = t * t * (3 - 2 * t);
  // Eased, a large amount could still reach past the edge; it is kept to the picture's outermost pixels.
  const keep = (v: number, size: number) => Math.min(size - 0.5, Math.max(0.5, v));
  return [keep(x + dx * eased, width) - x, keep(y + dy * eased, height) - y];
}

/** The offset as the mode makes it, before the edges are held. */
function moved(x: number, y: number, cx: number, cy: number, d: Displacement): [number, number] {
  const [vx, vy] = [x - cx, y - cy];
  const r = Math.hypot(vx, vy);
  switch (modeNumber(d.mode)) {
    case 0: {
      // Two patterns, one for across and one for down, taken from places far apart; centred on 0.
      const [px, py] = [vx / d.size, vy / d.size];
      return [
        d.amount * 2 * (noiseValue(px, py, d.time, d.noise) - 0.5),
        d.amount * 2 * (noiseValue(px + 31.4, py + 17.9, d.time, d.noise) - 0.5),
      ];
    }
    case 1: {
      // Moved sideways to the way the waves travel, as a flag is.
      const [ux, uy] = [Math.cos(d.direction), Math.sin(d.direction)];
      const s = d.amount * Math.sin(6.2831853 * ((vx * ux + vy * uy) / d.size - d.time));
      return [-uy * s, ux * s];
    }
    case 2: {
      // Towards and away from the middle, fading out to the radius.
      if (r < 1e-6) return [0, 0];
      const s = d.amount * Math.sin(6.2831853 * (r / d.size - d.time)) * Math.max(0, 1 - r / d.radius);
      return [(vx / r) * s, (vy / r) * s];
    }
    case 3: {
      // Turned most at the middle, easing to none at the radius.
      const f = Math.max(0, 1 - r / d.radius);
      const a = d.twist * f * f;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      return [c * vx - s * vy - vx, s * vx + c * vy - vy];
    }
    default: {
      // Read nearer the middle, most half way out: what is there looks larger. Below zero, it pinches.
      // Held short of where the picture would fold over itself: at most ten times larger in the middle.
      if (r < 1e-6 || r >= d.radius) return [0, 0];
      const limit = (0.9 * d.radius) / Math.PI;
      const s = -Math.max(-limit, Math.min(limit, d.amount)) * Math.sin(Math.PI * (r / d.radius));
      return [(vx / r) * s, (vy / r) * s];
    }
  }
}

/**
 * The same steps for the graphics card, reading the picture beneath from the
 * texture `picture` (premultiplied, as the canvas keeps it). Uniforms: the
 * picture's size in pixels, `middle` (in pixels), those of Displacement,
 * `direction` as a vector, the noise's (see NOISE_GLSL), `split` (red read
 * that much further, blue that much less far), `edges` (0 nothing past
 * them; the texture's own wrapping does the rest) and `hold` (the margin in
 * pixels the edges are held over; below zero, not held).
 */
export const DISPLACE_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D picture;
uniform vec2 size;
uniform vec2 middle;
uniform int mode;
uniform float amount;
uniform float twist;
uniform float scale;
uniform float radius;
uniform vec2 direction;
uniform float time;
uniform float split;
uniform int edges;
uniform float hold;
out vec4 colour;
${NOISE_GLSL}
vec2 displacementAt(vec2 v) {
  float r = length(v);
  if (mode == 0) {
    vec2 p = v / scale;
    return amount * 2.0 * (vec2(pattern(p, time), pattern(p + vec2(31.4, 17.9), time)) - 0.5);
  }
  if (mode == 1) {
    float s = amount * sin(6.2831853 * (dot(v, direction) / scale - time));
    return vec2(-direction.y, direction.x) * s;
  }
  if (mode == 2) {
    if (r < 1e-6) return vec2(0.0);
    float s = amount * sin(6.2831853 * (r / scale - time)) * max(0.0, 1.0 - r / radius);
    return v / r * s;
  }
  if (mode == 3) {
    float f = max(0.0, 1.0 - r / radius);
    float a = twist * f * f;
    float c = cos(a), s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y) - v;
  }
  if (r < 1e-6 || r >= radius) return vec2(0.0);
  float limit = 0.9 * radius / 3.14159265;
  return v / r * (-clamp(amount, -limit, limit) * sin(3.14159265 * (r / radius)));
}
vec4 read(vec2 at) {
  if (edges == 0 && (at.x < 0.0 || at.y < 0.0 || at.x >= size.x || at.y >= size.y)) return vec4(0.0);
  return texture(picture, at / size);
}
void main() {
  // The canvas counts down from the top, as the texture's rows do; the card, up from the bottom.
  vec2 pixel = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 offset = displacementAt(pixel - middle);
  if (hold >= 0.0) {
    float near = min(min(pixel.x, pixel.y), min(size.x - pixel.x, size.y - pixel.y)) - 0.5;
    offset = clamp(pixel + offset * (hold > 0.0 ? smoothstep(0.0, hold, near) : 1.0), vec2(0.5), size - 0.5) - pixel;
  }
  vec4 c = read(pixel + offset);
  if (split > 0.0) {
    vec4 red = read(pixel + offset * (1.0 + split));
    vec4 blue = read(pixel + offset * (1.0 - split));
    c = vec4(red.r, c.g, blue.b, max(c.a, max(red.a, blue.a)));
  }
  colour = c;
}
`;
