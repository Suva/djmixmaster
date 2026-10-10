import { fullEnergyEnvelope, gainCurve, median, type LevelOptions } from './gain-curve.ts';

export interface LoudnessCurves {
  /** Short-term loudness in LUFS per 100 ms block. */
  shortTerm: Float32Array;
  /** Short-term level of the low band alone, in dB on the same scale. */
  lowShortTerm: Float32Array;
  /** Short-term loudness of everything above the low band, in LUFS. */
  restShortTerm: Float32Array;
}

export interface Levelling {
  envelope: Float32Array;
  targetLufs: number;
  /** Gain in dB per 100 ms block. */
  gainDb: Float32Array;
  /** Gain of the bass shelf in dB per 100 ms block; all zero when bass correction is off. */
  bassDb: Float32Array;
}

/** Derives the gain curves from measured loudness. Cheap, so it can be re-run on every settings change. */
export function level(curves: LoudnessCurves, options: LevelOptions): Levelling {
  const envelope = fullEnergyEnvelope(curves.shortTerm, options);
  const typicalLufs = median(envelope);
  const bass =
    options.bassWeight > 0 || options.bassCorrection > 0 ? fullEnergyEnvelope(curves.lowShortTerm, options) : null;

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
  const reference = median(envelope);
  const targetLufs = options.targetLufs ?? typicalLufs;
  const gainDb = gainCurve(envelope, reference, options).map((db) => db + targetLufs - typicalLufs);
  return { envelope, targetLufs, gainDb, bassDb };
}
