// Gradients of stops, as every layer with a gradient has them: up to
// STOP_COUNT stops, each an ordinary colour setting and an ordinary position
// setting, so that any of them can follow the music; the editor's stop bar is
// only a way of setting them. Between stops, colours blend evenly, in OKLab,
// which is true to colours near each other; or round the colour wheel, in
// OKLCH, which keeps colours far apart rich through the hues between them,
// where OKLab would pass close to grey.
//
// And the gradient map: each pixel's brightness looked up in such a gradient,
// so that dark parts take the first colours and bright parts the last. Each
// frame the gradient is made into a table of 256 colours, with the shift, hue
// shift and range already in it; drawing then only looks pixels up in it. The
// noise layer colours its patterns the same way.
//
// Kept free of Node imports: the window draws with it.

import { blendOklab, blendOklch, turnHue, type Colour } from './colour.ts';

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

/** The two ways a gradient blends between its stops, as its Blend setting names them. */
export const STOP_BLENDS = ['even', 'round the colour wheel'] as const;

/** How two stops' colours blend: evenly, or round the colour wheel. */
const blender = (wheel: boolean) => (wheel ? blendOklch : blendOklab);

/**
 * The gradient's colour at `t`, 0 to 1: the first stop's colour before it,
 * the last's after it, and in between blended in OKLab, or round the colour
 * wheel. Transparency blends as well, without darkening.
 */
export function gradientAt(stops: Stop[], t: number, wheel = false): Colour {
  if (stops.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  if (t <= stops[0].position) return stops[0].colour;
  const last = stops[stops.length - 1];
  if (t >= last.position) return last.colour;
  let i = 1;
  while (stops[i].position < t) i++;
  const [from, to] = [stops[i - 1], stops[i]];
  const span = to.position - from.position;
  return blender(wheel)(from.colour, to.colour, span > 0 ? (t - from.position) / span : 1);
}

/** Stops with every colour turned round the colour wheel, in degrees. */
export const turnStops = (stops: Stop[], degrees: number): Stop[] =>
  degrees ? stops.map((stop) => ({ ...stop, colour: turnHue(stop.colour, degrees) })) : stops;

/**
 * The stops a canvas gradient is given for these, which blends between its
 * stops in red, green and blue: several between each two, so that it follows
 * OKLab, or the colour wheel, closely. A gradient that goes round (`wrap`, a conic one) blends from
 * its last stop back to its first. A stop's place held by two (a hard edge)
 * stays hard.
 */
export function canvasStops(stops: Stop[], wrap = false, wheel = false): [number, Colour][] {
  const blend = blender(wheel);
  if (stops.length === 0) return [];
  if (stops.length === 1) return [[0, stops[0].colour], [1, stops[0].colour]];
  const pieces = 8;
  const out: [number, Colour][] = [];
  const segment = (from: Stop, to: Stop, start: number, end: number) => {
    for (let k = 0; k <= pieces; k++) out.push([start + ((end - start) * k) / pieces, blend(from.colour, to.colour, k / pieces)]);
  };
  for (let i = 0; i + 1 < stops.length; i++) segment(stops[i], stops[i + 1], stops[i].position, stops[i + 1].position);
  if (wrap) {
    const [first, last] = [stops[0], stops[stops.length - 1]];
    const span = first.position + 1 - last.position;
    if (span > 0) {
      // Round past 1 and on from 0: the part past 1 goes to the start, and the colour where it crosses ends one and starts the other.
      const crossing = blend(last.colour, first.colour, (1 - last.position) / span);
      const before = out.length;
      segment(last, first, last.position, first.position + 1);
      const round = out.splice(before);
      out.push(...round.filter(([at]) => at <= 1), [1, crossing]);
      out.unshift([0, crossing], ...round.filter(([at]) => at > 1).map(([at, c]) => [at - 1, c] as [number, Colour]));
    }
  }
  return out.map(([at, c]) => [Math.min(1, Math.max(0, at)), c] as [number, Colour]);
}

export interface GradientMapOptions {
  /** Slides the gradient along: past its end it comes back the other way, so that it can keep sliding without a jump. */
  shift: number;
  /** Turns every colour round the colour wheel, in degrees. */
  hueShift: number;
  /** The brightnesses that take the gradient's two ends; below and above them, its end colours. */
  low: number;
  high: number;
  /** Blended round the colour wheel rather than evenly. */
  wheel?: boolean;
}

/**
 * The table a frame is drawn with: for each brightness 0 to 255, the colour
 * it becomes, as red, green, blue and alpha 0 to 255, not premultiplied.
 * Null when no stop has a colour, and the picture is left as it is.
 */
export function gradientMapTable(stops: Stop[], options: GradientMapOptions): Uint8ClampedArray | null {
  if (stops.length === 0) return null;
  const turned = turnStops(stops, options.hueShift);
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
    const c = gradientAt(turned, t, options.wheel);
    table[i * 4] = c.r * 255;
    table[i * 4 + 1] = c.g * 255;
    table[i * 4 + 2] = c.b * 255;
    table[i * 4 + 3] = c.a * 255;
  }
  return table;
}
