// What can be chosen about an exported file. Kept free of Node imports so the
// window can use it too.

/** How an exported file is written. Anything left out takes the default for its format. */
export interface EncodeOptions {
  /** Bits per sample for WAV and FLAC. 16-bit output is dithered. */
  bitDepth?: 16 | 24;
  /** Bitrate for MP3 and AAC, in kbps. */
  bitrateKbps?: number;
  /** Sample rate of the file, if it should differ from the audio's own. */
  sampleRate?: number;
  /** Written into the file's tags. */
  title?: string;
  artist?: string;
  album?: string;
  /** Position in the album, as a number or as "3/8". */
  track?: string;
}

export const DEFAULT_BIT_DEPTH = 16;
export const DEFAULT_MP3_KBPS = 320;
export const DEFAULT_AAC_KBPS = 256;
/**
 * How much quieter MP3 and AAC exports are made by default. Encoding to them
 * reshapes the waveform after the limiter, and peaks land above the ceiling
 * (0.7 dB over in one measured case) unless room is left.
 */
export const LOSSY_HEADROOM_DB = 1;

/** Whether a file of this name is written in a format that loses information. */
export function isLossy(output: string): boolean {
  return /\.(mp3|m4a)$/i.test(output);
}
