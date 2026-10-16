import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '../src/audio-io.ts';

/** The chunks of a WAV file, by name, in order. */
async function chunks(path: string): Promise<string[]> {
  const bytes = await readFile(path);
  const names: string[] = [];
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    names.push(bytes.toString('latin1', at, at + 4));
    at += 8 + size + (size & 1);
  }
  return names;
}

/** One second of quiet tone, written to a WAV said to be `frames` long (or of unknown length). */
async function wav(folder: string, name: string, frames?: number, bitDepth: 16 | 24 = 24): Promise<string> {
  const path = join(folder, name);
  const encoder = encode(path, 48000, { bitDepth }, frames);
  const second = new Float32Array(48000 * 2).map((_, i) => 0.1 * Math.sin(i / 20));
  await encoder.write(second);
  await encoder.close();
  return path;
}

test('a WAV that will stay under 4 GB is a plain one; one that may not keeps room to become RF64', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'djm-wav-'));
  try {
    // An hour at 48 kHz, 24-bit: some 1 GB.
    // (ffmpeg names itself in a LIST chunk, as in the file SoundCloud took; what matters is the format first, and no JUNK.)
    const hour = await chunks(await wav(folder, 'hour.wav', 48000 * 3600));
    assert.equal(hour[0], 'fmt ', 'the format first');
    assert.ok(!hour.includes('JUNK'), 'no JUNK in a file that cannot need it');
    // Nine hours at 48 kHz, 24-bit is over 4 GB: room is kept for RF64 (only a second is written here).
    assert.deepEqual((await chunks(await wav(folder, 'night.wav', 48000 * 3600 * 9)))[0], 'JUNK');
    // Not knowing how long, as before: room is kept.
    assert.deepEqual((await chunks(await wav(folder, 'unknown.wav')))[0], 'JUNK');
    // The same hour in 16 bits is plain too.
    assert.ok(!(await chunks(await wav(folder, 'hour16.wav', 48000 * 3600, 16))).includes('JUNK'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
