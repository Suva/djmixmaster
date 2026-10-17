import { adjustmentCurve, fullEnergyEnvelope, gainCurve, median, type Adjustment, type LevelOptions } from './gain-curve.ts';

export interface LoudnessCurves {
  /** Short-term loudness in LUFS per 100 ms block. */
  shortTerm: Float32Array;
  /** Short-term level of the low band alone, in dB on the same scale. */
  lowShortTerm: Float32Array;
  /** Short-term loudness of everything above the low band, in LUFS. */
  restShortTerm: Float32Array;
}

/** What decides how loud the result can be when no target is asked for. */
export interface Headroom {
  /** Highest absolute sample value per 100 ms block, linear. */
  peaks: Float32Array;
  /** Level in dBFS that peaks should stay under. */
  ceilingDb: number;
}

/** Share of the music allowed to reach past the ceiling, where the limiter catches it. */
const HEADROOM_OUTLIERS = 0.01;
/** Most an automatic target raises a quiet recording. */
const MAX_AUTO_RAISE_DB = 20;

export interface Levelling {
  envelope: Float32Array;
  targetLufs: number;
  /** Gain in dB per 100 ms block. */
  gainDb: Float32Array;
  /** Gain of the bass shelf in dB per 100 ms block; all zero when bass correction is off. */
  bassDb: Float32Array;
  /** The part of the gain that is the same all through the mix, which the target or a fixed gain decides. */
  offsetDb: number;
}

/**
 * Derives the gain curves from measured loudness. Cheap, so it can be re-run on
 * every settings change. Without a target in `options`, the result keeps the
 * mix's own level, or, when `headroom` is given, is made as loud as fits under
 * the ceiling without leaning on the limiter. `adjustments` are manual changes
 * to the overall gain or to the bass alone, laid on top of the automatic curves.
 * With `levelTracks` off there are no automatic curves, only the hand
 * adjustments and one gain for the whole mix.
 */
export function level(
  curves: LoudnessCurves, options: LevelOptions, headroom?: Headroom, adjustments: Adjustment[] = [],
): Levelling {
  const envelope = fullEnergyEnvelope(curves.shortTerm, options);
  const typicalLufs = median(envelope);
  const { levelTracks } = options;
  const bass =
    levelTracks && (options.bassWeight > 0 || options.bassCorrection > 0)
      ? fullEnergyEnvelope(curves.lowShortTerm, options)
      : null;

  let bassDb: Float32Array = new Float32Array(envelope.length);
  if (bass && options.bassCorrection > 0) {
    // Two-band levelling. The overall gain evens out everything above the bass,
    // and a shelf then moves the bass by whatever it still needs on top of that.
    // With both bands even from track to track, so is the loudness as a whole.
    const amount = options.bassCorrection;
    const rest = fullEnergyEnvelope(curves.restShortTerm, options);
    const typicalRest = median(rest);
    const typicalBass = median(bass);
    const shelfLimits = { ...options, maxBoostDb: options.maxBassDb, maxCutDb: options.maxBassDb };
    const apart = bass.map((low, i) => amount * (low - typicalBass - (rest[i] - typicalRest)));
    bassDb = gainCurve(apart, 0, shelfLimits);
    for (let i = 0; i < envelope.length; i++) {
      envelope[i] += amount * (rest[i] - typicalRest + typicalLufs - envelope[i]);
    }
  }

  if (bass && options.bassWeight > 0) {
    // Mix in how heavy each track's low end is, shifted so that a track with
    // the mix's typical bass-to-loudness balance is judged exactly as before.
    const offset = typicalLufs - median(bass);
    for (let i = 0; i < envelope.length; i++) {
      envelope[i] += options.bassWeight * (bass[i] + offset - envelope[i]);
    }
  }
  // Tracks are levelled against the mix's own typical level, so the boost and
  // cut limits bound the correction between tracks; the target then moves the
  // whole mix by one fixed amount.
  const gainDb = levelTracks ? gainCurve(envelope, median(envelope), options) : new Float32Array(envelope.length);
  const manual = adjustmentCurve(adjustments.filter((a) => !a.bass), gainDb.length, options);
  const manualBass = adjustmentCurve(adjustments.filter((a) => a.bass), gainDb.length, options);
  for (let i = 0; i < gainDb.length; i++) {
    gainDb[i] += manual[i];
    bassDb[i] += manualBass[i];
  }
  const fixed = levelTracks ? undefined : options.fixedGainDb;
  let targetLufs = fixed !== undefined ? typicalLufs + fixed : (options.targetLufs ?? typicalLufs);
  if (fixed === undefined && options.targetLufs === undefined && headroom) {
    // Where the peaks of the music would land after levelling. A recording made
    // too hot peaks at full scale all the way through, so raising any of its
    // tracks would only feed the limiter; turn the whole mix down by that much.
    // A typed array: sorting this many plain numbers takes a tenth of a second on a whole night.
    const landed = new Float64Array(gainDb.length);
    let count = 0;
    for (let i = 0; i < gainDb.length; i++) {
      if (headroom.peaks[i] > 0 && curves.shortTerm[i] > typicalLufs - 20) {
        landed[count++] = 20 * Math.log10(headroom.peaks[i]) + gainDb[i] + bassDb[i] / 2;
      }
    }
    if (count > 0) {
      const sorted = landed.subarray(0, count).sort();
      const reach = sorted[Math.floor((count - 1) * (1 - HEADROOM_OUTLIERS))];
      targetLufs = typicalLufs + Math.min(MAX_AUTO_RAISE_DB, headroom.ceilingDb - reach);
    }
  }
  const offsetDb = targetLufs - typicalLufs;
  for (let i = 0; i < gainDb.length; i++) gainDb[i] += offsetDb;
  return { envelope, targetLufs, gainDb, bassDb, offsetDb };
}
