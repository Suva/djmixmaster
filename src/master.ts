import { extname } from 'node:path';
import { FeatureExtractor, type Features } from './features.ts';
import { CHANNELS, decode, decodeParts, encode, isJoined, joinedFiles, probe, type EncodeOptions, type Region } from './audio-io.ts';
import type { SourceInfo } from './checkup.ts';
import { RecordingExaminer, type Diagnostics } from './diagnostics.ts';
import type { LoudnessCurves } from './level.ts';
import { Limiter } from './limiter.ts';
import { fadeGain } from './fade.ts';
import { LowShelf } from './shelf.ts';
import { BlockEnergyMeter, HOP_SECONDS, integratedLoudness, shortTermLoudness } from './loudness.ts';

/** How often the bass shelf is re-tuned while rendering. */
const SHELF_STEP_FRAMES = 256;

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

/** A measurement of a recording as it is, with what the check-up needs on top. */
export interface Examination extends Measurement {
  diagnostics: Diagnostics;
  source: SourceInfo;
  /** For a recording that came in several files: how many frames each one holds. */
  partFrames?: number[];
}

export interface RenderOptions {
  /** Limiter ceiling in dBFS, or null to leave peaks alone. */
  ceilingDb: number | null;
  /** Gain of the bass shelf in dB per 100 ms block; omit to leave the tone alone. */
  bassDb?: Float32Array;
  /** Format details of the exported file. */
  encode?: EncodeOptions;
  /**
   * Makes the result this many dB quieter, ceiling included. Used to leave
   * room for what a lossy encoder adds to the peaks.
   */
  headroomDb?: number;
  /** Length in seconds of the fade at the start and at the end of the result. */
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
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
    restShortTerm: shortTermLoudness(meter.restBlocks()),
    integratedLufs: integratedLoudness(blocks),
    peak: meter.peak,
  };
}

async function regionFrames(input: string, region: Region) {
  const info = await probe(input);
  const start = region.start ?? 0;
  const end = Math.min(region.end ?? info.duration, info.duration || Infinity);
  if (!(end > start)) throw new Error('The region is empty: its end must be after its start');
  return { info, sampleRate: info.sampleRate, totalFrames: (end - start) * info.sampleRate };
}

/** Pass 1: decode the region once and measure its loudness over time. */
export async function measure(input: string, region: Region = {}, onProgress?: Progress): Promise<Examination> {
  const { info, sampleRate, totalFrames } = await regionFrames(input, region);
  const meter = new BlockEnergyMeter(sampleRate, CHANNELS);
  const examiner = new RecordingExaminer(sampleRate);
  let frames = 0;
  // A whole recording in parts is read part by part, counting each.
  const whole = region.start === undefined && region.end === undefined;
  const partFrames: number[] = [];
  const source = isJoined(input) && whole ? decodeParts(input, partFrames) : decode(input, region);
  for await (const chunk of source) {
    meter.push(chunk);
    examiner.push(chunk);
    frames += chunk.length / CHANNELS;
    onProgress?.(Math.min(1, frames / totalFrames));
  }
  return {
    ...measurement(sampleRate, meter),
    diagnostics: examiner.finish(),
    source: {
      codec: info.codec,
      channels: info.channels,
      bitrateKbps: info.bitrateKbps,
      extension: extname(isJoined(input) ? joinedFiles(input)[0] : input).slice(1).toLowerCase(),
    },
    ...(partFrames.length > 0 ? { partFrames } : {}),
  };
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
  const headroomDb = options.headroomDb ?? 0;
  const gain = Float32Array.from(gainDb, (db) => Math.pow(10, (db - headroomDb) / 20));
  const lastBlock = gain.length - 1;

  // The shelf is left out entirely when there is nothing for it to do.
  const bassDb = options.bassDb?.some((db) => db !== 0) ? options.bassDb : null;
  const shelf = bassDb ? new LowShelf(sampleRate, CHANNELS) : null;
  // Block positions, with each curve value sitting at the centre of its block.
  const blockAt = (atFrame: number) => Math.min(lastBlock, Math.max(0, (atFrame + 0.5) / hopFrames - 0.5));

  const limiter = options.ceilingDb === null ? null : new Limiter(sampleRate, CHANNELS, options.ceilingDb - headroomDb);
  const meter = new BlockEnergyMeter(sampleRate, CHANNELS);
  const encoder = encode(output, sampleRate, options.encode, totalFrames);

  // The fades come last, after the limiter, so nothing downstream works against them.
  const fadeIn = Math.round((options.fadeInSeconds ?? 0) * sampleRate);
  const fadeOut = Math.round((options.fadeOutSeconds ?? 0) * sampleRate);
  // The region can be a little shorter than the curve: it is given to the
  // millisecond, the curve in whole blocks. The fade out has to end with the sound.
  const expectedFrames =
    region.start !== undefined && region.end !== undefined
      ? Math.round((region.end - region.start) * sampleRate)
      : gain.length * hopFrames;
  let emitted = 0;

  const emit = async (samples: Float32Array) => {
    if (samples.length === 0) return;
    const count = samples.length / CHANNELS;
    if (emitted < fadeIn || emitted + count > expectedFrames - fadeOut) {
      for (let f = 0; f < count; f++) {
        const fade = fadeGain(emitted + f, expectedFrames, fadeIn, fadeOut);
        if (fade !== 1) for (let c = 0; c < CHANNELS; c++) samples[f * CHANNELS + c] *= fade;
      }
    }
    emitted += count;
    meter.push(samples);
    await encoder.write(samples);
  };

  let frame = 0;
  for await (const chunk of decode(input, region)) {
    const frames = chunk.length / CHANNELS;
    if (shelf && bassDb) {
      // The shelf moves far too slowly to need per-sample updates.
      for (let from = 0; from < frames; from += SHELF_STEP_FRAMES) {
        const to = Math.min(frames, from + SHELF_STEP_FRAMES);
        const pos = blockAt(frame + (from + to) / 2);
        const i = Math.max(0, Math.min(lastBlock - 1, Math.floor(pos)));
        shelf.setGain(lastBlock === 0 ? bassDb[0] : bassDb[i] + (bassDb[i + 1] - bassDb[i]) * (pos - i));
        shelf.process(chunk, from, to);
      }
    }
    for (let f = 0; f < frames; f++, frame++) {
      const pos = blockAt(frame);
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

/**
 * The values the visuals of a video export move to (see features.ts), from a
 * pass of their own over the whole recording. Run in the background, at a
 * lower priority, so it never competes with what someone is waiting for.
 */
export async function listen(input: string, onProgress?: Progress): Promise<Features> {
  const { sampleRate, totalFrames } = await regionFrames(input, {});
  const extractor = new FeatureExtractor(sampleRate);
  let frames = 0;
  for await (const chunk of decode(input, {}, true)) {
    extractor.push(chunk);
    frames += chunk.length / CHANNELS;
    onProgress?.(Math.min(1, frames / totalFrames));
  }
  return extractor.finish();
}
