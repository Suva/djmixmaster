// The values a frame of a video gets from the music, worked out from what
// features.ts stored: the four bands, the level, the beat and where it is in
// the bar, the tempo and a slow sense of energy. Read for any moment of a mix,
// at any frame rate, the same in the preview and in the export.

import { BAND_COUNT, FLOOR_DB, HIGHEST_HZ, LOWEST_HZ, type Features } from '../features.ts';
import type { Values } from './expression.ts';

/** The names a frame of a mix provides to expressions, besides the template's own fields. */
export const MUSIC_NAMES = [
  'bass', 'lowMids', 'mids', 'highs', 'level',
  'beat', 'beatPhase', 'barPhase', 'beats', 'tempo', 'energy',
  'time', 'progress', 'length', 'dt', 'hasVideo',
] as const;

/** Where each group of bands starts, in Hz; it ends where the next starts. */
const GROUPS: [string, number][] = [['bass', LOWEST_HZ], ['lowMids', 150], ['mids', 600], ['highs', 2500]];
/** Seconds the energy is averaged over: long enough to tell a drop from a breakdown, not a beat from the next. */
const ENERGY_SECONDS = 8;

const centreOf = (band: number) => LOWEST_HZ * Math.pow(HIGHEST_HZ / LOWEST_HZ, (band + 0.5) / BAND_COUNT);

/** A value at a fraction through a sorted list. */
function percentile(sorted: Float32Array, fraction: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] : 0;
}

/**
 * Reads the music of one mix. The bands, the level and the energy are scaled
 * to the mix's own range, so a quiet mix moves the picture as much as a loud
 * one: 0 is the quiet end of what the mix does, 1 the loud end.
 */
export class MusicReader {
  readonly #features: Features;
  readonly #start: number;
  readonly #length: number;
  /** Per group: the band values summed into one curve, in dB, one per step. */
  readonly #groups = new Map<string, Float32Array>();
  readonly #range = new Map<string, [number, number]>();
  readonly #energy: Float32Array;
  readonly #energyRange: [number, number];
  /** The bytes of the spectrum that the quiet and the loud end of the mix come to. */
  readonly #spectrumRange: [number, number];
  /** The first beat at or after the mix's start, from which `beats` counts. */
  readonly #firstBeat: number;

  /** `start` and `end` are the mix's edges in the recording, in seconds. */
  constructor(features: Features, start: number, end: number) {
    this.#features = features;
    this.#start = start;
    this.#length = Math.max(0, end - start);
    const steps = features.level.length;
    const firstStep = Math.max(0, Math.floor(start * features.rate));
    const lastStep = Math.min(steps, Math.ceil(end * features.rate));
    const toDb = (byte: number) => FLOOR_DB + (byte / 255) * -FLOOR_DB;

    for (let g = 0; g < GROUPS.length; g++) {
      const [name, low] = GROUPS[g];
      const high = GROUPS[g + 1]?.[1] ?? Infinity;
      const bands = [...Array(BAND_COUNT).keys()].filter((b) => centreOf(b) >= low && centreOf(b) < high);
      const curve = new Float32Array(steps);
      for (let s = 0; s < steps; s++) {
        let power = 0;
        for (const b of bands) power += Math.pow(10, toDb(features.bands[s * BAND_COUNT + b]) / 10);
        curve[s] = 10 * Math.log10(power / bands.length + 1e-12);
      }
      this.#groups.set(name, curve);
      this.#range.set(name, this.#rangeOf(curve, firstStep, lastStep));
    }
    const level = Float32Array.from(features.level, toDb);
    this.#groups.set('level', level);
    this.#range.set('level', this.#rangeOf(level, firstStep, lastStep));

    // Energy: the level, averaged over several seconds either side.
    this.#energy = new Float32Array(steps);
    const half = Math.round((ENERGY_SECONDS / 2) * features.rate);
    let sum = 0;
    let count = 0;
    for (let s = 0; s < Math.min(steps, half); s++) (sum += level[s], count++);
    for (let s = 0; s < steps; s++) {
      if (s + half < steps) (sum += level[s + half], count++);
      if (s - half - 1 >= 0) (sum -= level[s - half - 1], count--);
      this.#energy[s] = sum / Math.max(1, count);
    }
    this.#energyRange = this.#rangeOf(this.#energy, firstStep, lastStep);
    const all = features.bands.slice(firstStep * BAND_COUNT, Math.max(firstStep + 1, lastStep) * BAND_COUNT).sort();
    const quiet = all[Math.floor(all.length * 0.05)] ?? 0;
    this.#spectrumRange = [quiet, Math.max(quiet + 20, all[Math.floor(all.length * 0.995)] ?? 255)];
    const firstBeat = features.beats.findIndex((time) => time >= start);
    this.#firstBeat = firstBeat < 0 ? features.beats.length : firstBeat;
  }

  /** The quiet and the loud end of a curve within the mix: most of the time it is between. */
  #rangeOf(curve: Float32Array, first: number, last: number): [number, number] {
    const inside = curve.slice(first, Math.max(first + 1, last)).sort();
    const low = percentile(inside, 0.1);
    const high = percentile(inside, 0.98);
    return [low, Math.max(high, low + 6)];
  }

  /** A curve's value at `step`, a fraction allowed, scaled to its range and kept within 0 to 1. */
  #read(curve: Float32Array, [low, high]: [number, number], step: number): number {
    const i = Math.max(0, Math.min(curve.length - 1, Math.floor(step)));
    const next = Math.min(curve.length - 1, i + 1);
    const value = curve[i] + (curve[next] - curve[i]) * Math.max(0, Math.min(1, step - i));
    return Math.max(0, Math.min(1, (value - low) / (high - low)));
  }

  /**
   * The spectrum at the moment `seconds` into the mix: each band from 0 to 1,
   * all on one scale (the range of the whole spectrum within the mix), so
   * that the shape of the sound shows, bass louder than treble.
   */
  spectrum(seconds: number): Float32Array {
    const features = this.#features;
    const step = (this.#start + seconds) * features.rate;
    const i = Math.max(0, Math.min(features.level.length - 1, Math.floor(step)));
    const next = Math.min(features.level.length - 1, i + 1);
    const t = Math.max(0, Math.min(1, step - i));
    const [low, high] = this.#spectrumRange;
    const out = new Float32Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const byte = features.bands[i * BAND_COUNT + b] + (features.bands[next * BAND_COUNT + b] - features.bands[i * BAND_COUNT + b]) * t;
      out[b] = Math.max(0, Math.min(1, (byte - low) / (high - low)));
    }
    return out;
  }

  /** The level over the `span` seconds up to the moment `seconds` into the mix, at `points` evenly spaced times, 0 to 1. */
  levelHistory(seconds: number, span: number, points: number): Float32Array {
    const out = new Float32Array(points);
    const level = this.#groups.get('level')!;
    const range = this.#range.get('level')!;
    for (let p = 0; p < points; p++) {
      const at = this.#start + seconds - span + (span * (p + 1)) / points;
      out[p] = at < this.#start ? 0 : this.#read(level, range, at * this.#features.rate);
    }
    return out;
  }

  /**
   * When the last beat at or before the moment `seconds` into the mix fell,
   * in seconds into the mix, counting only every `every`th beat from the
   * first of the mix: so every 4 is the first beat of each bar. -Infinity
   * before the first.
   */
  lastBeat(seconds: number, every: number): number {
    const beats = this.#features.beats;
    const inRecording = this.#start + seconds;
    let low = this.#firstBeat;
    let high = beats.length - 1;
    if (low > high || beats[low] > inRecording) return -Infinity;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (beats[middle] <= inRecording) low = middle;
      else high = middle - 1;
    }
    const counted = low - this.#firstBeat;
    const index = this.#firstBeat + counted - (counted % Math.max(1, Math.round(every)));
    return beats[index] - this.#start;
  }

  /** The values for the moment `seconds` into the mix. `dt` is the time since the frame before. */
  at(seconds: number, dt: number): Values {
    const features = this.#features;
    const inRecording = this.#start + seconds;
    // A spectrum describes the moment at its centre; frames between two are interpolated.
    const step = inRecording * features.rate;
    const values: Values = {
      time: seconds, length: this.#length, dt, progress: this.#length ? Math.min(1, Math.max(0, seconds / this.#length)) : 0,
      // Whether the recording is a video is no matter of the music: whoever draws, and knows, sets it.
      hasVideo: 0,
    };
    for (const [name, curve] of this.#groups) values[name] = this.#read(curve, this.#range.get(name)!, step);
    values.energy = this.#read(this.#energy, this.#energyRange, step);

    // The beat: the last one at or before this moment, and the next.
    const beats = features.beats;
    let low = 0;
    let high = beats.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (beats[middle] <= inRecording) low = middle;
      else high = middle - 1;
    }
    if (beats.length < 2 || inRecording < beats[0]) {
      Object.assign(values, { beat: 0, beatPhase: 0, barPhase: 0, beats: 0, tempo: 0 });
      return values;
    }
    const last = low;
    const next = Math.min(beats.length - 1, last + 1);
    const period = next > last ? beats[next] - beats[last] : beats[last] - beats[last - 1];
    const phase = Math.min(1, (inRecording - beats[last]) / period);
    // Counted from the first beat of the mix, so `beats / 4` starts a bar at the mix's start.
    values.beats = last - this.#firstBeat + phase;
    values.beatPhase = phase;
    values.barPhase = (values.beats / 4) % 1;
    values.tempo = 60 / period;
    // A flash on the kick, gone by the next, as strong as the kick was.
    values.beat = features.beatStrength[last] * Math.pow(1 - phase, 3);
    return values;
  }
}
