import { CHANNELS, encode } from '../src/audio-io.ts';

export const SAMPLE_RATE = 44100;
export const TRACK_SECONDS = 180;
/** Each track drops its kick and most of its level for this stretch. */
export const BREAKDOWN = { start: 60, end: 100 };
export const BREAKDOWN_DB = -12;
/** Level of each track relative to full scale; deliberately uneven. */
export const TRACK_LEVELS_DB = [-3, -13, -8];

/**
 * Writes a stand-in for a DJ mix: three "tracks" of kick plus noise at
 * different levels, each with a quiet breakdown, joined by short crossfades.
 */
export async function writeSyntheticMix(file: string): Promise<void> {
  const encoder = encode(file, SAMPLE_RATE);
  const total = TRACK_LEVELS_DB.length * TRACK_SECONDS * SAMPLE_RATE;
  const chunkFrames = 16384;
  const beat = Math.round(SAMPLE_RATE * 0.48);
  const fade = 5 * SAMPLE_RATE;
  const trackFrames = TRACK_SECONDS * SAMPLE_RATE;
  const linear = (decibels: number) => Math.pow(10, decibels / 20);

  let seed = 1;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  let lowpassed = 0;

  // Level of a track at a position inside it, and whether its kick is playing.
  const section = (track: number, frame: number) => {
    const seconds = frame / SAMPLE_RATE;
    const inBreakdown = seconds >= BREAKDOWN.start && seconds < BREAKDOWN.end;
    return { level: linear(TRACK_LEVELS_DB[track] + (inBreakdown ? BREAKDOWN_DB : 0)), kick: !inBreakdown };
  };

  for (let start = 0; start < total; start += chunkFrames) {
    const frames = Math.min(chunkFrames, total - start);
    const chunk = new Float32Array(frames * CHANNELS);
    for (let f = 0; f < frames; f++) {
      const frame = start + f;
      const track = Math.floor(frame / trackFrames);
      const inTrack = frame - track * trackFrames;
      let { level, kick } = section(track, inTrack);
      // Crossfade the level into the next track over the last seconds.
      if (track + 1 < TRACK_LEVELS_DB.length && inTrack >= trackFrames - fade) {
        const mix = (inTrack - (trackFrames - fade)) / fade;
        level += (section(track + 1, 0).level - level) * mix;
      }
      const sinceBeat = (frame % beat) / SAMPLE_RATE;
      const kickSample = kick ? Math.sin(2 * Math.PI * 55 * sinceBeat) * Math.exp(-sinceBeat * 12) : 0;
      lowpassed += 0.2 * (noise() - lowpassed);
      const sample = level * (0.7 * kickSample + 0.3 * lowpassed);
      chunk[f * CHANNELS] = sample;
      chunk[f * CHANNELS + 1] = sample;
    }
    await encoder.write(chunk);
  }
  await encoder.close();
}
