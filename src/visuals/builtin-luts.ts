// The LUTs that come with the app, offered in every list of LUTs beside the
// template's own and the LUT folder's. A setting names one as
// `lutbuiltin:Kodak Portra 400`: by its name alone, not its group, so that
// regrouping the list never breaks a template.
//
// The film looks are Pat David's film emulation HaldCLUTs (CC BY-SA 4.0),
// turned into tables of 33 points a side; the others were made for this app.
// Each is a file in assets/luts, made by scripts/make-luts.mjs, which reads
// this list. There are some fifty and the app carries them all, so they are
// stored small (`encodeBuiltinLut`): six megabytes rather than sixteen. The names of films are there only to say which film a look
// imitates; see assets/luts/LICENSE.txt.
//
// Kept free of Node imports: the window reads it.

import type { Lut } from './lut.ts';

export interface BuiltinLut {
  /** What it is called in the list, and in a setting after the prefix. Never changed once released: templates name it. */
  name: string;
  /** The heading it is listed under. */
  group: string;
  /** For scripts/make-luts.mjs: the HaldCLUT it is made from, in Pat David's collection; none for the app's own looks. */
  hald?: string;
}

/** What a LUT setting names to use a LUT that comes with the app. */
export const BUILTIN_LUT_PREFIX = 'lutbuiltin:';

const LOOKS = 'Looks';
const BW = 'Film: black & white';
const NEGATIVE = 'Film: colour negative';
const SLIDE = 'Film: slide';
const INSTANT = 'Film: instant';

export const BUILTIN_LUTS: BuiltinLut[] = [
  // Made for the app: scripts/make-luts.mjs has how.
  { name: 'Teal & Orange', group: LOOKS },
  { name: 'Bleach Bypass', group: LOOKS },
  { name: 'Cross Process', group: LOOKS },
  { name: 'Neon Duotone', group: LOOKS },
  { name: 'Sunset', group: LOOKS },
  { name: 'Night Blue', group: LOOKS },
  { name: 'Green Haze', group: LOOKS },
  { name: 'Warm', group: LOOKS },
  { name: 'Cool', group: LOOKS },
  { name: 'Faded', group: LOOKS },
  { name: 'Punchy', group: LOOKS },
  { name: 'Vivid', group: LOOKS },
  { name: 'Noir', group: LOOKS },
  { name: 'Sepia', group: LOOKS },

  { name: 'Agfa APX 100', group: BW, hald: 'bw/agfa_apx_100.png' },
  { name: 'Fuji Neopan Acros 100', group: BW, hald: 'bw/fuji_neopan_acros_100.png' },
  { name: 'Ilford Delta 3200', group: BW, hald: 'bw/ilford_delta_3200.png' },
  { name: 'Ilford FP4 Plus 125', group: BW, hald: 'bw/ilford_fp4_plus_125.png' },
  { name: 'Ilford HP5 Plus 400', group: BW, hald: 'bw/ilford_hp5_plus_400.png' },
  { name: 'Ilford Pan F Plus 50', group: BW, hald: 'bw/ilford_pan_f_plus_50.png' },
  { name: 'Kodak HIE Infrared', group: BW, hald: 'bw/kodak_hie_(hs_infra).png' },
  { name: 'Kodak T-Max 400', group: BW, hald: 'bw/kodak_t-max_400.png' },
  { name: 'Kodak Tri-X 400', group: BW, hald: 'bw/kodak_tri-x_400.png' },
  { name: 'Rollei Ortho 25', group: BW, hald: 'bw/rollei_ortho_25.png' },

  { name: 'Agfa Ultra Color 100', group: NEGATIVE, hald: 'negative_color/agfa_ultra_color_100.png' },
  { name: 'Agfa Vista 200', group: NEGATIVE, hald: 'negative_color/agfa_vista_200.png' },
  { name: 'Fuji 160C', group: NEGATIVE, hald: 'negative_new/fuji_160c.png' },
  { name: 'Fuji 400H', group: NEGATIVE, hald: 'negative_new/fuji_400h.png' },
  { name: 'Fuji 800Z', group: NEGATIVE, hald: 'negative_new/fuji_800z.png' },
  { name: 'Fuji Superia 200', group: NEGATIVE, hald: 'negative_color/fuji_superia_200.png' },
  { name: 'Fuji Superia HG 1600', group: NEGATIVE, hald: 'negative_color/fuji_superia_hg_1600.png' },
  { name: 'Fuji Superia Reala 100', group: NEGATIVE, hald: 'negative_color/fuji_superia_reala_100.png' },
  { name: 'Fuji Superia X-Tra 800', group: NEGATIVE, hald: 'negative_color/fuji_superia_x-tra_800.png' },
  { name: 'Kodak Elite Color 400', group: NEGATIVE, hald: 'negative_color/kodak_elite_color_400.png' },
  { name: 'Kodak Portra 160', group: NEGATIVE, hald: 'negative_new/kodak_portra_160.png' },
  { name: 'Kodak Portra 400', group: NEGATIVE, hald: 'negative_new/kodak_portra_400.png' },
  { name: 'Kodak Portra 800', group: NEGATIVE, hald: 'negative_new/kodak_portra_800.png' },
  { name: 'Lomography Redscale 100', group: NEGATIVE, hald: 'negative_color/lomography_redscale_100.png' },

  { name: 'Agfa Precisa 100', group: SLIDE, hald: 'colorslide/agfa_precisa_100.png' },
  { name: 'Fuji Astia 100F', group: SLIDE, hald: 'colorslide/fuji_astia_100f.png' },
  { name: 'Fuji Provia 100F', group: SLIDE, hald: 'colorslide/fuji_provia_100f.png' },
  { name: 'Fuji Superia 200 Cross Processed', group: SLIDE, hald: 'colorslide/fuji_superia_200_xpro.png' },
  { name: 'Fuji Velvia 50', group: SLIDE, hald: 'colorslide/fuji_velvia_50.png' },
  { name: 'Kodak Ektachrome 100 VS', group: SLIDE, hald: 'colorslide/kodak_ektachrome_100_vs.png' },
  { name: 'Kodak Elite Chrome 400', group: SLIDE, hald: 'colorslide/kodak_elite_chrome_400.png' },
  { name: 'Kodak Kodachrome 64', group: SLIDE, hald: 'colorslide/kodak_kodachrome_64.png' },
  { name: 'Lomography X-Pro Slide 200', group: SLIDE, hald: 'colorslide/lomography_x-pro_slide_200.png' },
  { name: 'Polaroid Polachrome', group: SLIDE, hald: 'colorslide/polaroid_polachrome.png' },

  { name: 'Fuji FP-100C', group: INSTANT, hald: 'instant_pro/fuji_fp-100c.png' },
  { name: 'Fuji FP-100C Cool', group: INSTANT, hald: 'instant_pro/fuji_fp-100c_cool.png' },
  { name: 'Fuji FP-3000B', group: INSTANT, hald: 'instant_pro/fuji_fp-3000b.png' },
  { name: 'Polaroid 690', group: INSTANT, hald: 'instant_pro/polaroid_690.png' },
  { name: 'Polaroid PX-70', group: INSTANT, hald: 'instant_consumer/polaroid_px-70.png' },
  { name: 'Polaroid PX-70 Cold', group: INSTANT, hald: 'instant_consumer/polaroid_px-70_cold.png' },
  { name: 'Polaroid PX-100UV+ Cold', group: INSTANT, hald: 'instant_consumer/polaroid_px-100uv+_cold.png' },
  { name: 'Polaroid PX-680 Warm', group: INSTANT, hald: 'instant_consumer/polaroid_px-680_warm.png' },
  { name: 'Polaroid Time Zero Expired', group: INSTANT, hald: 'instant_consumer/polaroid_time_zero_(expired).png' },
];

/** The file a built-in LUT is kept in, in assets/luts and in the app's luts/: its name in lower case, with dashes. */
export function builtinLutFile(name: string): string {
  return `${name.toLowerCase().replace(/&/g, 'and').replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.bin`;
}

/**
 * A table as a built-in LUT's file holds it before it is compressed (with
 * deflate, raw): its size in a byte, then each value as 16 bits from 0 to 1
 * less the value one point before it in red, the high bytes of all of them
 * first and then the low ones. Neighbouring points differ little, so the
 * differences are small numbers whose high bytes are nearly all alike, and
 * that is what compresses well.
 */
export function encodeBuiltinLut(lut: Lut): Uint8Array {
  const n = lut.data.length;
  const bytes = new Uint8Array(1 + n * 2);
  bytes[0] = lut.size;
  const previous = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const value = Math.round(Math.min(1, Math.max(0, lut.data[i])) * 65535);
    const difference = (value - previous[i % 3]) & 0xffff;
    previous[i % 3] = value;
    bytes[1 + i] = difference >> 8;
    bytes[1 + n + i] = difference & 0xff;
  }
  return bytes;
}

/** A built-in LUT from its file, once that is decompressed. */
export function decodeBuiltinLut(bytes: Uint8Array): Lut {
  const size = bytes[0];
  const n = size ** 3 * 3;
  if (!(size >= 2) || bytes.length !== 1 + n * 2) throw new Error('The LUT file is damaged');
  const data = new Float32Array(n);
  const previous = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const value = (previous[i % 3] + ((bytes[1 + i] << 8) | bytes[1 + n + i])) & 0xffff;
    previous[i % 3] = value;
    data[i] = value / 65535;
  }
  return { size, data, min: [0, 0, 0], max: [1, 1, 1] };
}

export function builtinLut(name: string): BuiltinLut | undefined {
  return BUILTIN_LUTS.find((lut) => lut.name === name);
}
