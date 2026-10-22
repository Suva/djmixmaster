// Recording from an audio input: what ffmpeg is told, what the files it
// writes are called, and the levels of what comes in. Kept apart from
// recorder.ts, which runs it, so that all of this can be tested without a
// device.
//
// The sound is captured by Chromium in a hidden page (capture.ts) and sent to
// the main process, which measures it for the meters and, while recording,
// hands it to ffmpeg. ffmpeg's own capture is not used: on macOS it drops a
// tenth of the sound. ffmpeg writes the recording in parts of half an hour, so
// that a crash costs the last moments rather than the night and no file
// reaches the size where WAV stops working. Should the app go down, ffmpeg's
// stdin closes and it finishes the part it was writing.
//
// The parts are always written as WAV, whose header can be put right if ffmpeg
// itself is cut short. A FLAC recording has each part packed into FLAC once it
// is finished (recorder.ts): ffmpeg writing FLAC through its segments leaves
// the parts without their length.

import { readSync, openSync, closeSync, fstatSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

export type RecordFormat = 'wav' | 'flac';

/** How long each part of a recording is, in seconds. */
export const PART_SECONDS = 30 * 60;

/** An input to record from, by its name; with how many channels it has, where that is known before it is opened. */
export interface RecordDevice {
  name: string;
  channels?: number;
}

/** What a device gives when it is opened: Chromium gives one channel or two. */
export interface RecordInput {
  channels: number;
  sampleRate: number;
}

/** A recording to start. */
export interface RecordPlan {
  /** The device, by its name; for checks, the generated test signal instead. */
  device: string;
  /** The two channels of the device to record, counted from 0; the same twice records it on both sides. */
  channels: [number, number];
  format: RecordFormat;
  folder: string;
  /** What the parts are called, before " part 001". */
  name: string;
}

/** A device that is not one, for checks: a tone on each side, generated in real time (capture.ts). */
export const TEST_SIGNAL = 'Test signal';
/** The same with one channel, the left's tone, as a microphone gives. */
export const TEST_SIGNAL_MONO = 'Test signal, mono';
/** The level of the test signal on each side, as a fraction of full scale. */
export const TEST_LEVELS = [0.5, 0.25] as const;

/** Whether a file is one of a recording's parts, as written or as packed into FLAC. */
export function isPartOf(file: string, plan: Pick<RecordPlan, 'name'>): boolean {
  const escaped = plan.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped} part \\d{3,}\\.(wav|flac)$`).test(basename(file));
}

/** The arguments that pack a finished part into FLAC, written to `to`, which need not end in .flac. */
export function packArgs(from: string, to: string): string[] {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', from, '-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac', to];
}

/** The bytes a second of the recording takes, as written. FLAC is a guess: music packs to about half. */
export function bytesPerSecond(sampleRate: number, format: RecordFormat): number {
  const wav = sampleRate * 2 * 3;
  return format === 'flac' ? wav * 0.55 : wav;
}

/**
 * The arguments of the run that writes a recording: stereo 32-bit float
 * samples on its stdin, written as 24-bit WAV parts. It ends when its stdin
 * does, finishing the part it is on.
 */
export function writerArgs(plan: Pick<RecordPlan, 'folder' | 'name'>, sampleRate: number, partSeconds = PART_SECONDS): string[] {
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', '2', '-i', 'pipe:0',
    '-c:a', 'pcm_s24le',
    '-f', 'segment', '-segment_time', String(partSeconds), '-segment_format', 'wav', '-segment_start_number', '1', '-reset_timestamps', '1',
    join(plan.folder, `${plan.name} part %03d.wav`),
  ];
}

/** Characters a recording's name may not have, as files cannot, and '%', which would number the parts. */
export const NAME_FORBIDDEN = /[\\/:*?"<>|%]/;

/**
 * The two channels of a recording from what the input gives, its channels
 * interleaved: `channels` says which become left and right.
 */
export function stereoOf(samples: Float32Array, inputChannels: number, channels: [number, number]): Float32Array {
  const frames = Math.floor(samples.length / inputChannels);
  const [a, b] = channels.map((c) => Math.max(0, Math.min(inputChannels - 1, c)));
  const out = new Float32Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    out[f * 2] = samples[f * inputChannels + a];
    out[f * 2 + 1] = samples[f * inputChannels + b];
  }
  return out;
}

/** Level of one stretch of the recording, per channel: the highest sample and the mean square. */
export interface Levels {
  peak: [number, number];
  meanSquare: [number, number];
  frames: number;
}

/** Measures stereo samples, interleaved. */
export function measureStereo(samples: Float32Array): Levels {
  const frames = Math.floor(samples.length / 2);
  const peak: [number, number] = [0, 0];
  const sum = [0, 0];
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < 2; c++) {
      const value = samples[f * 2 + c];
      const abs = Math.abs(value);
      if (abs > peak[c]) peak[c] = abs;
      sum[c] += value * value;
    }
  }
  return { peak, meanSquare: [frames ? sum[0] / frames : 0, frames ? sum[1] / frames : 0], frames };
}

/** The place and length of a WAV file's sound, as its header says, and the size of the file; null if it is not one. */
function wavLayout(path: string): { size: number; riff: number; dataAt: number; data: number } | null {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, head, 0, head.length, 0);
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    for (let at = 12; at + 8 <= head.length; at += 8 + head.readUInt32LE(at + 4) + (head.readUInt32LE(at + 4) % 2)) {
      if (head.toString('ascii', at, at + 4) === 'data') return { size, riff: head.readUInt32LE(4), dataAt: at + 4, data: head.readUInt32LE(at + 4) };
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a part has been finished: ffmpeg writes its header's sizes as it
 * closes it, which may be a moment after the next part has been begun.
 */
export function wavFinished(path: string): boolean {
  const layout = wavLayout(path);
  return layout !== null && layout.riff === layout.size - 8 && layout.data === layout.size - layout.dataAt - 4;
}

/**
 * Puts right the sizes in a WAV file's header that a recording stopped by a
 * crash left as they were when it started, so that every program reads all
 * of it. Returns whether anything was changed.
 */
export function repairWav(path: string): boolean {
  const layout = wavLayout(path);
  if (!layout) return false;
  // Whole frames only would need the format; the readers cope with a last partial one.
  const riff = Math.min(0xffffffff, layout.size - 8);
  const data = Math.min(0xffffffff, layout.size - layout.dataAt - 4);
  if (layout.riff === riff && layout.data === data) return false;
  const fd = openSync(path, 'r+');
  try {
    const fix = Buffer.alloc(4);
    fix.writeUInt32LE(riff);
    writeSync(fd, fix, 0, 4, 4);
    fix.writeUInt32LE(data);
    writeSync(fd, fix, 0, 4, layout.dataAt);
    return true;
  } finally {
    closeSync(fd);
  }
}
