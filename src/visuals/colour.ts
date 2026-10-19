// Colours in templates. A colour is red, green, blue and alpha, each 0 to 1,
// as written in a hex code; arithmetic on colours works on those, the way a
// shader treats a vec4. Changing hue, lightness or saturation is done in
// OKLCH, a colour space built so that equal steps look equal (Björn Ottosson,
// 2020; CSS uses it too): turning the hue of a yellow and of a blue keeps
// them looking equally light, which HSL does not.

export interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const isColour = (value: unknown): value is Colour =>
  typeof value === 'object' && value !== null && 'r' in value && 'g' in value && 'b' in value;

/** `#rgb`, `#rrggbb` or `#rrggbbaa`, or null if the text is none of them. */
export function parseHex(text: string): Colour | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const part = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: part(0), g: part(2), b: part(4), a: full.length === 8 ? part(6) : 1 };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** The colour as `#rrggbb`, or `#rrggbbaa` when it is not opaque; values past 0 to 1 are clamped. */
export function toHex(colour: Colour): string {
  const two = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');
  return `#${two(colour.r)}${two(colour.g)}${two(colour.b)}${colour.a < 1 ? two(colour.a) : ''}`;
}

// sRGB <-> linear light <-> OKLab <-> OKLCH

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const fromLinear = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

/** Lightness 0 to 1, chroma (about 0 to 0.37 within sRGB) and hue in degrees. */
export interface Lch {
  l: number;
  c: number;
  h: number;
}

export function toLch({ r, g, b }: Colour): Lch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

function lchToRgb({ l: L, c, h }: Lch): [number, number, number] {
  const A = c * Math.cos((h * Math.PI) / 180);
  const B = c * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const fits = (rgb: number[]) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/**
 * The colour of these lightness, chroma and hue. One a screen cannot show is
 * brought within reach by lowering its chroma, keeping its lightness and hue,
 * so a computed colour never comes out as something else entirely.
 */
export function fromLch(lch: Lch, a = 1): Colour {
  const l = clamp01(lch.l);
  let c = Math.max(0, lch.c);
  let rgb = lchToRgb({ l, c, h: lch.h });
  if (!fits(rgb)) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 24; i++) {
      c = (low + high) / 2;
      if (fits(lchToRgb({ l, c, h: lch.h }))) low = c;
      else high = c;
    }
    rgb = lchToRgb({ l, c: low, h: lch.h });
  }
  return { r: clamp01(rgb[0]), g: clamp01(rgb[1]), b: clamp01(rgb[2]), a };
}

/** From hue in degrees, saturation and lightness 0 to 1, as in CSS. */
export function fromHsl(h: number, s: number, l: number): Colour {
  const k = (n: number) => (n + h / 30) % 12;
  const amount = s * Math.min(l, 1 - l);
  const f = (n: number) => l - amount * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4), a: 1 };
}

/** Between two colours, blended so that the steps between look even. */
export function mixColours(from: Colour, to: Colour, t: number): Colour {
  const a = toLch(from);
  const b = toLch(to);
  // A grey has no hue of its own: blending from it takes the other colour's.
  const ha = a.c < 1e-4 ? b.h : a.h;
  const hb = b.c < 1e-4 ? ha : b.h;
  let turn = hb - ha;
  if (turn > 180) turn -= 360;
  if (turn < -180) turn += 360;
  return fromLch({ l: a.l + (b.l - a.l) * t, c: a.c + (b.c - a.c) * t, h: ha + turn * t }, from.a + (to.a - from.a) * t);
}

const withLch = (colour: Colour, change: (lch: Lch) => Lch) => fromLch(change(toLch(colour)), colour.a);

export const turnHue = (colour: Colour, degrees: number) => withLch(colour, (c) => ({ ...c, h: (((c.h + degrees) % 360) + 360) % 360 }));
export const lighten = (colour: Colour, amount: number) => withLch(colour, (c) => ({ ...c, l: c.l + amount }));
export const saturate = (colour: Colour, amount: number) => withLch(colour, (c) => ({ ...c, c: c.c * (1 + amount) }));

/**
 * How much to scale red, green and blue by to warm or cool a picture and
 * move it towards green or magenta, as a photo editor's white balance does.
 * `temperature` goes from -1 (cooler, towards blue) to 1 (warmer, towards
 * amber); `tint` from -1 (towards green) to 1 (towards magenta). The three
 * are scaled together so that a grey keeps its lightness: the colour moves,
 * the picture does not get brighter or darker.
 */
export function whiteBalance(temperature: number, tint: number): [number, number, number] {
  // At the ends of the sliders, a fair correction for a photo taken under the wrong light, no further.
  const reach = 0.3;
  const t = Math.max(-1, Math.min(1, temperature)) * reach;
  const m = Math.max(-1, Math.min(1, tint)) * reach;
  const [r, g, b] = [1 + t, 1 - m, 1 - t];
  // The lightness of grey, as sRGB weighs the three.
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / light, g / light, b / light];
}
