import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isPartOf, measureStereo, NAME_FORBIDDEN, repairWav, stereoOf, wavFinished, writerArgs } from '../src/app/recording.ts';

test('the parts are written by ffmpeg from what it is given, as 24-bit WAV, half an hour each', () => {
  const args = writerArgs({ folder: '/rec', name: 'Night' }, 48000, 1800);
  assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-i') + 2), ['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0']);
  assert.equal(args[args.indexOf('-segment_time') + 1], '1800');
  assert.equal(args.at(-1), join('/rec', 'Night part %03d.wav'));
  // A name with % in would be numbered by ffmpeg in its own way.
  assert.ok(NAME_FORBIDDEN.test('100% night') && !NAME_FORBIDDEN.test('Friday (main room)'));
});

test('the two channels recorded are taken from what the input gives', () => {
  const stereo = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual([...stereoOf(stereo, 2, [1, 0])].map((v) => +v.toFixed(2)), [0.2, 0.1, 0.4, 0.3]);
  assert.deepEqual([...stereoOf(stereo, 2, [1, 1])].map((v) => +v.toFixed(2)), [0.2, 0.2, 0.4, 0.4]);
  // A mono input goes to both sides, whatever was asked for.
  const mono = Float32Array.from([0.5, -0.5]);
  assert.deepEqual([...stereoOf(mono, 1, [0, 1])], [0.5, 0.5, -0.5, -0.5]);
});

test('a recording\'s parts are told from other files, as WAV and as FLAC', () => {
  const plan = { name: 'Friday (main room)' };
  assert.ok(isPartOf('/x/Friday (main room) part 001.wav', plan));
  assert.ok(isPartOf('Friday (main room) part 012.flac', plan));
  assert.ok(!isPartOf('Friday (main room) part 001.packing', plan));
  assert.ok(!isPartOf('Friday part 001.wav', plan));
  assert.ok(!isPartOf('Friday (main room) part 1.wav', plan));
});

test('the meters read the highest sample and the mean square of each side', () => {
  const levels = measureStereo(Float32Array.from([1, -0.5, 0, 0.5]));
  assert.equal(levels.frames, 2);
  assert.deepEqual(levels.peak, [1, 0.5]);
  assert.deepEqual(levels.meanSquare, [0.5, 0.25]);
});

test('a WAV header left as a crash leaves it is put right, and a sound one left alone', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'djmaster-wav-'));
  try {
    const file = join(folder, 'part.wav');
    const data = Buffer.alloc(600);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(0xffffffff, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(48000, 24);
    header.writeUInt32LE(48000 * 6, 28);
    header.writeUInt16LE(6, 32);
    header.writeUInt16LE(24, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(0xffffffff, 40);
    await writeFile(file, Buffer.concat([header, data]));
    assert.equal(wavFinished(file), false, 'not finished while its header says so');
    assert.equal(repairWav(file), true);
    assert.equal(wavFinished(file), true);
    const fixed = await readFile(file);
    assert.equal(fixed.readUInt32LE(4), 644 - 8);
    assert.equal(fixed.readUInt32LE(40), 600);
    assert.equal(repairWav(file), false, 'nothing more to put right');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
