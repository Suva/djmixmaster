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
const tools = new Map<string, string>();

/** Full path of `ffmpeg` or `ffprobe`, looked up on PATH first and then in the usual install folders. */
function tool(name: 'ffmpeg' | 'ffprobe'): string {
  let found = tools.get(name);
  if (!found) {
    const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...FALLBACK_DIRS];
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    found = dirs.map((dir) => join(dir, exe)).find((path) => existsSync(path));
    if (!found) throw new Error(`${name} not found. Install ffmpeg (for example "brew install ffmpeg") or add it to PATH`);
    tools.set(name, found);
  }
  return found;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed: ${err.trim() || `exit code ${code}`}`));
    });
  });
}

export async function probe(file: string): Promise<AudioInfo> {
  const out = await run(tool('ffprobe'), [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  const json = JSON.parse(out);
  const sampleRate = Number(json.streams?.[0]?.sample_rate);
  if (!sampleRate) throw new Error(`No audio stream found in ${file}`);
  return { sampleRate, duration: Number(json.format?.duration) || 0 };
}

/** Streams the region as interleaved stereo float32 chunks at the file's own sample rate. */
export async function* decode(file: string, region: Region = {}): AsyncGenerator<Float32Array> {
  const args = ['-v', 'error', '-nostdin'];
  if (region.start !== undefined) args.push('-ss', String(region.start));
  if (region.end !== undefined) args.push('-to', String(region.end));
  args.push('-i', file, '-map', 'a:0', '-ac', String(CHANNELS), '-f', 'f32le', '-');

  const child = spawn(tool('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

function codecArgs(output: string): string[] {
  switch (extname(output).toLowerCase()) {
    case '.wav':
      return ['-c:a', 'pcm_s24le', '-rf64', 'auto'];
    case '.flac':
      return ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24'];
    case '.mp3':
      return ['-c:a', 'libmp3lame', '-b:a', '320k'];
    case '.m4a':
      return ['-c:a', 'aac', '-b:a', '256k'];
    default:
      throw new Error(`Unsupported output format "${extname(output)}" (use .wav, .flac, .mp3 or .m4a)`);
  }
}

export interface Encoder {
  write(samples: Float32Array): Promise<void>;
  close(): Promise<void>;
}

/** Encodes interleaved stereo float32 to a file, picking the codec from the extension. */
export function encode(output: string, sampleRate: number): Encoder {
  const args = [
    '-v', 'error', '-y',
    '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(CHANNELS), '-i', '-',
    ...codecArgs(output),
    output,
  ];
  const child = spawn(tool('ffmpeg'), args, { stdio: ['pipe', 'ignore', 'pipe'] });
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
