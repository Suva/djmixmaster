// Keying: making part of a picture or a video clip see-through, what is near
// a key colour (a green screen) or what is dark (a clip made on black).
// Within the tolerance of the way to the furthest colour it goes entirely;
// over the softness after that it fades back in, so edges stay smooth.
//
// Written twice, as the same steps, as the noise layer's patterns are (see
// noise.ts): KEY_SHADER for the graphics card, and keyAmount for a computer
// without one and for the tests. A change to one must be made to the other.
//
// Kept free of Node imports: the window draws with it.

export const KEY_KINDS = ['colour', 'dark'] as const;

/** What decides how much of each pixel stays. */
export interface Key {
  /** One of KEY_KINDS. */
  kind: string;
  /** The colour keyed out, 0 to 1 a channel; for the colour key. */
  colour: [number, number, number];
  /** Gone entirely up to this far from the key, as a fraction of the way to the furthest colour. */
  tolerance: number;
  /** Then fading back in over this much further. */
  softness: number;
}

/** Each kind's number in the shader. */
export const keyNumber = (kind: string) => Math.max(0, KEY_KINDS.indexOf(kind as (typeof KEY_KINDS)[number]));

/** Where fading starts and ends: never the same, so that a softness of 0 still has an edge to divide by. */
export function keyRange(key: Key): [number, number] {
  const low = Math.max(0, key.tolerance);
  return [low, low + Math.max(1e-3, key.softness)];
}

/**
 * How much of a pixel of this colour stays, 0 to 1, its channels 0 to 1 and
 * not premultiplied: how far it is from the key colour, corner to corner of
 * the colour cube being 1, or for the dark key how bright it is.
 */
export function keyAmount(r: number, g: number, b: number, key: Key, range = keyRange(key)): number {
  const [low, high] = range;
  let distance: number;
  if (keyNumber(key.kind) === 1) distance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  else {
    const [dr, dg, db] = [r - key.colour[0], g - key.colour[1], b - key.colour[2]];
    distance = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
  }
  if (distance >= high) return 1;
  return distance <= low ? 0 : (distance - low) / (high - low);
}

/**
 * The same steps for the graphics card, over a picture the size of the
 * output, read from the texture `picture` as it is, not premultiplied, and
 * written premultiplied, as a canvas keeps it. Uniforms: `size`, the
 * output's in pixels, `kind` (keyNumber), `key` the colour, and `low` and
 * `high` from keyRange.
 */
export const KEY_SHADER = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform vec2 size;
uniform int kind;
uniform vec3 key;
uniform float low;
uniform float high;
out vec4 colour;
void main() {
  vec2 at = gl_FragCoord.xy;
  at.y = size.y - at.y;
  vec4 c = texture(picture, at / size);
  float distance = kind == 1 ? dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)) : length(c.rgb - key) / sqrt(3.0);
  float stays = distance >= high ? 1.0 : distance <= low ? 0.0 : (distance - low) / (high - low);
  float a = c.a * stays;
  colour = vec4(c.rgb * a, a);
}`;
