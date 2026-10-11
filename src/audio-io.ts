import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

/** Everything downstream works on interleaved stereo float32. */
export const CHANNELS = 2;
const BYTES_PER_FRAME = CHANNELS * 4;

export interface Region {
  /** Seconds from the start of the file. */
  start?: number;
  end?: number;
}

export interface AudioInfo {
  sampleRate: number;
  duration: number;
}

/** Where Homebrew and friends put ffmpeg; shells started outside a login session often lack these. */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
let ffmpegPath: string | undefined;

/**
 * Full path of ffmpeg: the one named by DJMASTER_FFMPEG (the packaged app
 * points this at its own copy), else the first on PATH or in the usual
 * install folders.
 */
export function ffmpeg(): string {
  if (!ffmpegPath) {
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...FALLBACK_DIRS];
    const candidates = [process.env.DJMASTER_FFMPEG, ...dirs.map((dir) => join(dir, exe))];
    ffmpegPath = candidates.find((path) => path && existsSync(path));
    if (!ffmpegPath) throw new Error('ffmpeg not found. Install it (for example "brew install ffmpeg") or add it to PATH');
  }
  return ffmpegPath;
}

/** Reads the sample rate and length from what ffmpeg reports about a file. */
export function probe(file: string): Promise<AudioInfo> {
  return new Promise((resolve, reject) => {
    // With no output named, ffmpeg describes the input on stderr and stops.
    const child = spawn(ffmpeg(), ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let described = '';
    child.stderr.on('data', (d) => (described += d));
    child.on('error', reject);
    child.on('close', () => {
      const sampleRate = Number(/Stream #.*: Audio: .*?(\d+) Hz/.exec(described)?.[1]);
      if (!sampleRate) {
        const reason = described.trim().split('\n').pop();
        reject(new Error(`No audio found in ${file}${reason ? ` (${reason})` : ''}`));
        return;
      }
      const length = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(described);
      const duration = length ? Number(length[1]) * 3600 + Number(length[2]) * 60 + Number(length[3]) : 0;
      resolve({ sampleRate, duration });
    });
  });
}

/** Streams the region as interleaved stereo float32 chunks at the file's own sample rate. */
export async function* decode(file: string, region: Region = {}): AsyncGenerator<Float32Array> {
  const args = ['-v', 'error', '-nostdin'];
  if (region.start !== undefined) args.push('-ss', String(region.start));
  if (region.end !== undefined) args.push('-to', String(region.end));
  args.push('-i', file, '-map', 'a:0', '-ac', String(CHANNELS), '-f', 'f32le', '-');

  const child = spawn(ffmpeg(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const closed = once(child, 'close');

  try {
    let carry: Buffer = Buffer.alloc(0);
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      // Pipe chunks are not frame aligned, so hold back the partial frame.
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % BYTES_PER_FRAME);
      carry = buf.subarray(usable);
      if (usable === 0) continue;
      const samples = new Float32Array(usable / 4);
      new Uint8Array(samples.buffer).set(buf.subarray(0, usable));
      yield samples;
    }
  } finally {
    child.kill();
  }
  const [code] = await closed;
  if (code !== 0) throw new Error(`ffmpeg decode failed: ${err.trim() || `exit code ${code}`}`);
}

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
}

export const DEFAULT_BIT_DEPTH = 16;
export const DEFAULT_MP3_KBPS = 320;
export const DEFAULT_AAC_KBPS = 256;

function codecArgs(output: string, sampleRate: number, options: EncodeOptions): string[] {
  const extension = extname(output).toLowerCase();
  const lossless = extension === '.wav' || extension === '.flac';
  const sixteen = lossless && (options.bitDepth ?? DEFAULT_BIT_DEPTH) === 16;

  // Converting the rate and reducing to 16 bits happen in one step, in that
  // order, so the dither is the last thing done to the audio. Without dither,
  // cutting to 16 bits leaves distortion on quiet passages and fades.
  const convert: string[] = [];
  if (options.sampleRate && options.sampleRate !== sampleRate) convert.push(String(options.sampleRate));
  if (sixteen) convert.push('osf=s16', 'dither_method=triangular');
  const filter = convert.length ? ['-af', `aresample=${convert.join(':')}`] : [];

  switch (extension) {
    case '.wav':
      return [...filter, '-c:a', sixteen ? 'pcm_s16le' : 'pcm_s24le', '-rf64', 'auto'];
    case '.flac':
      return [...filter, '-c:a', 'flac', ...(sixteen ? ['-sample_fmt', 's16'] : ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'])];
    case '.mp3':
      return [...filter, '-c:a', 'libmp3lame', '-b:a', `${options.bitrateKbps ?? DEFAULT_MP3_KBPS}k`];
    case '.m4a':
      return [...filter, '-c:a', 'aac', '-b:a', `${options.bitrateKbps ?? DEFAULT_AAC_KBPS}k`];
    default:
      throw new Error(`Unsupported output format "${extname(output)}" (use .wav, .flac, .mp3 or .m4a)`);
  }
}

export interface Encoder {
  write(samples: Float32Array): Promise<void>;
  close(): Promise<void>;
}

/** Encodes interleaved stereo float32 at `sampleRate` to a file, picking the codec from the extension. */
export function encode(output: string, sampleRate: number, options: EncodeOptions = {}): Encoder {
  const args = [
    '-v', 'error', '-y',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(CHANNELS), '-i', '-',
    ...codecArgs(output, sampleRate, options),
    ...(options.title ? ['-metadata', `title=${options.title}`] : []),
    output,
  ];
  const child = spawn(ffmpeg(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  // A dying encoder surfaces through its exit code; don't crash on the broken pipe first.
  child.stdin.on('error', () => {});
  const closed = once(child, 'close');
  let exited = false;
  closed.then(() => (exited = true));

  const fail = (code: unknown) => new Error(`ffmpeg encode failed: ${err.trim() || `exit code ${code}`}`);

  return {
    async write(samples) {
      if (exited) throw fail((await closed)[0]);
      const buf = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
      if (!child.stdin.write(buf)) await Promise.race([once(child.stdin, 'drain'), closed]);
    },
    async close() {
      child.stdin.end();
      const [code] = await closed;
      if (code !== 0) throw fail(code);
    },
  };
}
