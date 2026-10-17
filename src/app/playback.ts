// Decides how a recording can be played in the window. The built-in player
// seeks exactly in most formats, but in a variable-bitrate MP3 it lands tens of
// seconds off, and some formats it cannot play at all. Those are decoded by
// ffmpeg from the playhead instead and streamed to the player.

import { open, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';

/** Formats the built-in player both plays and seeks exactly. */
const EXACT = new Set(['.wav', '.flac', '.m4a', '.ogg', '.opus']);

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = [44100, 48000, 32000];

interface Frame {
  bitrate: number;
  length: number;
}

/** Reads an MPEG layer III frame header at `at`, or returns null if there is none. */
function frameAt(bytes: Uint8Array, at: number): Frame | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (bytes[at + 1] >> 1) & 3; // 1 = layer III
  const bitrateIndex = bytes[at + 2] >> 4;
  const rateIndex = (bytes[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const padding = (bytes[at + 2] >> 1) & 1;
  return { bitrate, length: Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding };
}

/** Finds the first frame in `bytes` that is followed by another, which rules out chance matches. */
function firstFrame(bytes: Uint8Array): { at: number; frame: Frame } | null {
  for (let at = 0; at + 4 <= bytes.length; at++) {
    const frame = frameAt(bytes, at);
    if (frame && frameAt(bytes, at + frame.length)) return { at, frame };
  }
  return null;
}

async function read(file: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buffer = new Uint8Array(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text, 0, 'latin1');

/** Whether every part of an MP3 uses the same bitrate, which is what makes byte positions map to times. */
async function isConstantBitrate(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    // Skip a leading ID3v2 tag, which can be large when it holds cover art.
    const head = await read(file, 0, 10);
    let audioStart = 0;
    if (contains(head.subarray(0, 3), 'ID3')) {
      audioStart = 10 + ((head[6] & 0x7f) << 21) + ((head[7] & 0x7f) << 14) + ((head[8] & 0x7f) << 7) + (head[9] & 0x7f);
    }
    const start = await read(file, audioStart, 16384);
    const first = firstFrame(start);
    if (!first) return false;
    // Encoders label the first frame: "Info" for constant bitrate, "Xing" or "VBRI" for variable.
    const label = start.subarray(first.at, first.at + first.frame.length);
    if (contains(label, 'Xing') || contains(label, 'VBRI')) return false;
    if (contains(label, 'Info')) return true;

    // Unlabelled: look at the bitrate in a spread of places through the file.
    const SAMPLES = 24;
    for (let i = 1; i < SAMPLES; i++) {
      const position = audioStart + Math.floor(((size - audioStart - 16384) * i) / SAMPLES);
      const found = firstFrame(await read(file, position, 16384));
      if (!found || found.frame.bitrate !== first.frame.bitrate) return false;
    }
    return true;
  } finally {
    await file.close();
  }
}

/**
 * Videos the built-in player plays the sound of, when it is in one of these
 * codecs. A camera's MOV often holds PCM, which it does not play, and
 * Matroska it does not know; those are streamed.
 */
const EXACT_VIDEO = new Set(['.mp4', '.m4v', '.webm']);
const PLAYED_CODECS = new Set(['aac', 'opus', 'vorbis', 'mp3', 'flac']);

/**
 * Whether a recording has to be decoded by ffmpeg for playback instead of
 * handed to the built-in player. `codec` is its sound's, as ffmpeg names it.
 */
export async function needsStreaming(path: string, codec?: string): Promise<boolean> {
  const extension = extname(path).toLowerCase();
  if (EXACT.has(extension)) return false;
  if (EXACT_VIDEO.has(extension)) return !PLAYED_CODECS.has(codec ?? '');
  if (extension !== '.mp3') return true;
  try {
    return !(await isConstantBitrate(path));
  } catch {
    return true;
  }
}

/** Header of a WAV file of unknown length holding 32-bit float samples. */
export function streamingWavHeader(sampleRate: number, channels: number): Uint8Array {
  const header = Buffer.alloc(44);
  const blockAlign = channels * 4;
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(0xffffffff, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}
