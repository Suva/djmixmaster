// A gradient map: each pixel's brightness looked up in a gradient of colours,
// so that dark parts take the first colours and bright parts the last, as a
// photo editor's gradient map does. The gradient is up to STOP_COUNT stops,
// each an ordinary colour setting and an ordinary position setting, so that
// any of them can follow the music; the editor's stop bar is only a way of
// setting them.
//
// Each frame the gradient is made into a table of 256 colours, by brightness,
// with the shift, hue shift and range already in it; drawing then only looks
// pixels up in it.
//
// Kept free of Node imports: the window draws with it.

import { turnHue, type Colour } from './colour.ts';

/** How many stops a gradient of settings has, as colour1…colour5 and position1…position5. */
export const STOP_COUNT = 5;

export interface Stop {
  colour: Colour;
  /** Where along the gradient, 0 to 1. */
  position: number;
}

/** How bright a colour is, as sRGB weighs red, green and blue: 0 to 1. */
export const brightnessOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * The stops of a layer's settings that are in use, those with a colour, in
 * order along the gradient. `colour` and `position` read a stop's setting,
 * counting from 1.
 */
export function stopsOf(colour: (n: number) => Colour | null, position: (n: number) => number): Stop[] {
  const stops: Stop[] = [];
  for (let n = 1; n <= STOP_COUNT; n++) {
    const c = colour(n);
    if (c) stops.push({ colour: c, position: Math.min(1, Math.max(0, position(n))) });
  }
  // Stops at the same place keep their numbered order, so that one can be dragged past another.
  return stops.map((stop, i) => ({ stop, i })).sort((a, b) => a.stop.position - b.stop.position || a.i - b.i).map(({ stop }) => stop);
}

/**
 * The gradient's colour at `t`, 0 to 1: the first stop's colour before it,
 * the last's after it, and in between blended in straight lines, as the
 * canvas blends a gradient. Transparency blends as well, without darkening.
 */
export function gradientAt(stops: Stop[], t: number): Colour {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= stops[0].position) return stops[0].colour;
  const last = stops[stops.length - 1];
  if (t >= last.position) return last.colour;
  let i = 1;
  while (stops[i].position < t) i++;
  const [from, to] = [stops[i - 1], stops[i]];
  const span = to.position - from.position;
  const f = span > 0 ? (t - from.position) / span : 1;
  const a = from.colour.a + (to.colour.a - from.colour.a) * f;
  // Mixed with each colour weighed by how much of it shows, so that fading to nothing does not fade through black.
  const mix = (key: 'r' | 'g' | 'b') => (a > 0 ? (from.colour[key] * from.colour.a * (1 - f) + to.colour[key] * to.colour.a * f) / a : 0);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a };
}

export interface GradientMapOptions {
  /** Slides the gradient along: past its end it comes back the other way, so that it can keep sliding without a jump. */
  shift: number;
  /** Turns every colour round the colour wheel, in degrees. */
  hueShift: number;
  /** The brightnesses that take the gradient's two ends; below and above them, its end colours. */
  low: number;
  high: number;
}

/**
 * The table a frame is drawn with: for each brightness 0 to 255, the colour
 * it becomes, as red, green, blue and alpha 0 to 255, not premultiplied.
 * Null when no stop has a colour, and the picture is left as it is.
 */
export function gradientMapTable(stops: Stop[], options: GradientMapOptions): Uint8ClampedArray | null {
  if (stops.length === 0) return null;
  const turned = options.hueShift ? stops.map((stop) => ({ ...stop, colour: turnHue(stop.colour, options.hueShift) })) : stops;
  const table = new Uint8ClampedArray(256 * 4);
  const { low, high, shift } = options;
  for (let i = 0; i < 256; i++) {
    const b = i / 255;
    let t = high > low ? (b - low) / (high - low) : b >= low ? 1 : 0;
    t = Math.min(1, Math.max(0, t));
    if (shift) {
      // There and back: 0 to 1, then 1 to 2 runs back down, so the colours keep flowing without a seam.
      const u = (((t + shift) % 2) + 2) % 2;
      t = u <= 1 ? u : 2 - u;
    }
    const c = gradientAt(turned, t);
    table[i * 4] = c.r * 255;
    table[i * 4 + 1] = c.g * 255;
    table[i * 4 + 2] = c.b * 255;
    table[i * 4 + 3] = c.a * 255;
  }
  return table;
}
