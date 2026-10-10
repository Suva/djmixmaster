import { CHANNELS, decode, encode, probe, type Region } from './audio-io.ts';
import type { LoudnessCurves } from './level.ts';
import { Limiter } from './limiter.ts';
import { BlockEnergyMeter, HOP_SECONDS, integratedLoudness, shortTermLoudness } from './loudness.ts';

export type Progress = (fraction: number) => void;

export { level, type Levelling } from './level.ts';

export interface Measurement extends LoudnessCurves {
  sampleRate: number;
  /** K-weighted energy per 100 ms block. */
  blocks: Float64Array;
  /** Highest absolute sample value per 100 ms block, linear. */
  peaks: Float32Array;
  integratedLufs: number;
  /** Highest absolute sample value, linear. */
  peak: number;
}

export interface RenderOptions {
  /** Limiter ceiling in dBFS, or null to leave peaks alone. */
  ceilingDb: number | null;
}

export interface RenderResult extends Measurement {
  /** Deepest limiter gain reduction in dB (0 when it never engaged). */
  limiterReductionDb: number;
}

function measurement(sampleRate: number, meter: BlockEnergyMeter): Measurement {
  const blocks = meter.blocks();
  return {
    sampleRate,
    blocks,
    peaks: meter.peaks(),
    shortTerm: shortTermLoudness(blocks),
    lowShortTerm: shortTermLoudness(meter.lowBlocks()),
    integratedLufs: integratedLoudness(blocks),
    peak: meter.peak,
  };
}

async function regionFrames(input: string, region: Region) {
  const info = await probe(input);
  const start = region.start ?? 0;
  const end = Math.min(region.end ?? info.duration, info.duration || Infinity);
  if (!(end > start)) throw new Error('The region is empty: its end must be after its start');
  return { sampleRate: info.sampleRate, totalFrames: (end - start) * info.sampleRate };
}

/** Pass 1: decode the region once and measure its loudness over time. */
export async function measure(input: string, region: Region = {}, onProgress?: Progress): Promise<Measurement> {
  const { sampleRate, totalFrames } = await regionFrames(input, region);
  const meter = new BlockEnergyMeter(sampleRate, CHANNELS);
  let frames = 0;
  for await (const chunk of decode(input, region)) {
    meter.push(chunk);
    frames += chunk.length / CHANNELS;
    onProgress?.(Math.min(1, frames / totalFrames));
  }
  return measurement(sampleRate, meter);
}

/** Pass 2: decode again, apply the gain curve and the limiter, and encode to `output`. */
export async function render(
  input: string,
  region: Region,
  gainDb: Float32Array,
  output: string,
  options: RenderOptions,
  onProgress?: Progress,
): Promise<RenderResult> {
  const { sampleRate, totalFrames } = await regionFrames(input, region);
  const hopFrames = Math.round(sampleRate * HOP_SECONDS);
  const gain = Float32Array.from(gainDb, (db) => Math.pow(10, db / 20));
  const lastBlock = gain.length - 1;

  const limiter = options.ceilingDb === null ? null : new Limiter(sampleRate, CHANNELS, options.ceilingDb);
  const meter = new BlockEnergyMeter(sampleRate, CHANNELS);
  const encoder = encode(output, sampleRate);

  const emit = async (samples: Float32Array) => {
    if (samples.length === 0) return;
    meter.push(samples);
    await encoder.write(samples);
  };

  let frame = 0;
  for await (const chunk of decode(input, region)) {
    const frames = chunk.length / CHANNELS;
    for (let f = 0; f < frames; f++, frame++) {
      // Each gain value sits at the centre of its block; interpolate between them.
      const pos = Math.min(lastBlock, Math.max(0, (frame + 0.5) / hopFrames - 0.5));
      const i = Math.min(lastBlock - 1, Math.floor(pos));
      const g = lastBlock === 0 ? gain[0] : gain[i] + (gain[i + 1] - gain[i]) * (pos - i);
      for (let c = 0; c < CHANNELS; c++) chunk[f * CHANNELS + c] *= g;
    }
    await emit(limiter ? limiter.process(chunk) : chunk);
    onProgress?.(Math.min(1, frame / totalFrames));
  }
  if (limiter) await emit(limiter.flush());
  await encoder.close();

  return {
    ...measurement(sampleRate, meter),
    limiterReductionDb: limiter ? -20 * Math.log10(limiter.minGain) : 0,
  };
}
