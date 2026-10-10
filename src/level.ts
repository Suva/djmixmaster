import { fullEnergyEnvelope, gainCurve, median, type LevelOptions } from './gain-curve.ts';

export interface LoudnessCurves {
  /** Short-term loudness in LUFS per 100 ms block. */
  shortTerm: Float32Array;
  /** Short-term level of the low band alone, in dB on the same scale. */
  lowShortTerm: Float32Array;
}

export interface Levelling {
  envelope: Float32Array;
  targetLufs: number;
  /** Gain in dB per 100 ms block. */
  gainDb: Float32Array;
}

/** Derives the gain curve from measured loudness. Cheap, so it can be re-run on every settings change. */
export function level(curves: LoudnessCurves, options: LevelOptions): Levelling {
  const envelope = fullEnergyEnvelope(curves.shortTerm, options);
  if (options.bassWeight > 0) {
    // Mix in how heavy each track's low end is, shifted so that a track with
    // the mix's typical bass-to-loudness balance is judged exactly as before.
    const bass = fullEnergyEnvelope(curves.lowShortTerm, options);
    const offset = median(envelope) - median(bass);
    for (let i = 0; i < envelope.length; i++) {
      envelope[i] += options.bassWeight * (bass[i] + offset - envelope[i]);
    }
  }
  // Tracks are levelled against the mix's own typical level, so the boost and
  // cut limits bound the correction between tracks; the target then moves the
  // whole mix by one fixed amount.
  const typicalLufs = median(envelope);
  const targetLufs = options.targetLufs ?? typicalLufs;
  const gainDb = gainCurve(envelope, typicalLufs, options).map((db) => db + targetLufs - typicalLufs);
  return { envelope, targetLufs, gainDb };
}
