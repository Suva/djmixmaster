// Tests of reading a clip's compressed frames as ffmpeg copies them for an
// export (clipStreamArgs, and the reader in mp4-packets.ts), against what
// ffmpeg itself says the frames' times are.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpeg } from '../src/audio-io.ts';
import { clipStreamArgs } from '../src/app/video-files.ts';
import { codecString, Mp4Reader, type Mp4Packet, type Mp4Track } from '../src/app/renderer/mp4-packets.ts';

let work: string;
/** Six seconds at 25 fps with B-frames, a keyframe every second. */
let clip: string;

before(async () => {
  work = await mkdtemp(join(tmpdir(), 'djmaster-mp4-'));
  clip = join(work, 'clip.mp4');
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25', '-t', '6',
    '-c:v', 'libx264', '-g', '25', '-bf', '2', '-pix_fmt', 'yuv420p', clip,
  ]);
});

after(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

/** What the reader makes of ffmpeg's copy of the clip, given to it in pieces of `piece` bytes. */
function read(args: string[], piece = 1 << 20): { tracks: Mp4Track[]; packets: Mp4Packet[] } {
  const bytes = execFileSync(ffmpeg(), args, { maxBuffer: 64 << 20 });
  const reader = new Mp4Reader();
  const tracks: Mp4Track[] = [];
  const packets: Mp4Packet[] = [];
  for (let at = 0; at < bytes.length; at += piece) {
    reader.push(bytes.subarray(at, at + piece));
    for (const item of reader.take()) ('codec' in item ? tracks : packets).push(item as never);
  }
  return { tracks, packets };
}

/** The times ffmpeg gives the clip's frames, in microseconds, in the order they are stored. */
function storedTimes(file: string): number[] {
  const lines = execFileSync(ffmpeg(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-']).toString().split('\n');
  // "#tb 0: 1/12800", then a line a frame: stream, dts, pts, duration, size, checksum.
  const [units, second] = /^#tb 0: (\d+)\/(\d+)/m.exec(lines.join('\n'))!.slice(1).map(Number);
  return lines.filter((line) => /^0,/.test(line)).map((line) => Math.round((Number(line.split(',')[2]) * units * 1e6) / second));
}

test('a clip is copied from the keyframe before where it is asked for, each frame at its own time', () => {
  const { tracks, packets } = read(clipStreamArgs(clip, 2.5), 4096);
  assert.equal(tracks.length, 1);
  assert.match(tracks[0].codec, /^avc1\.64/, 'H.264 High profile');
  assert.equal(tracks[0].codedWidth, 320);
  assert.equal(tracks[0].codedHeight, 180);
  assert.ok(tracks[0].description && tracks[0].description[0] === 1, 'the avcC box, to set the decoder up');
  assert.equal(packets[0].timestamp, 2_000_000, 'from the keyframe at 2 s');
  assert.ok(packets[0].key);
  assert.deepEqual(packets.filter((packet) => packet.key).map((packet) => packet.timestamp), [2, 3, 4, 5].map((s) => s * 1e6));
  // Every frame from there on, in the order stored (B-frames before the frames they come after), at ffmpeg's times.
  const stored = storedTimes(clip);
  assert.equal(packets.length, 100);
  assert.deepEqual(packets.map((packet) => packet.timestamp), stored.slice(stored.indexOf(2_000_000)));
  assert.ok(packets.every((packet) => packet.duration === 40_000 && packet.data.length > 0));
});

test('a part of a recording in several files has its times moved on to where it starts', () => {
  const { packets } = read(clipStreamArgs(clip, 0, 20.01));
  assert.equal(packets[0].timestamp, 20_010_000);
  assert.equal(packets.length, 150);
  assert.equal(Math.max(...packets.map((packet) => packet.timestamp)), 20_010_000 + 149 * 40_000);
});

test('two MP4s one after the other are read as two tracks, as when a recording in several files goes on to the next', () => {
  const first = execFileSync(ffmpeg(), clipStreamArgs(clip, 5));
  const second = execFileSync(ffmpeg(), clipStreamArgs(clip, 0, 6));
  const reader = new Mp4Reader();
  reader.push(first);
  reader.push(second);
  const items = reader.take();
  const tracks = items.filter((item) => 'codec' in item);
  const times = items.filter((item): item is Mp4Packet => !('codec' in item)).map((packet) => packet.timestamp);
  assert.equal(tracks.length, 2);
  assert.equal(times[0], 5_000_000);
  assert.equal(times[25], 6_000_000, 'the second starts where the first ends');
});

test('codec strings are made as WebCodecs names them, from the box that sets each codec up', () => {
  // avcC: version 1, High profile (100), no constraints, level 4.0.
  assert.equal(codecString('avc1', Uint8Array.of(1, 0x64, 0x00, 0x28)), 'avc1.640028');
  // hvcC of a phone's HEVC: Main profile, compatible with Main and Main 10, Main tier, level 4.1 (123), progressive and so on.
  const hvcc = Uint8Array.of(1, 0x01, 0x60, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 123);
  assert.equal(codecString('hvc1', hvcc), 'hvc1.1.6.L123.B0');
  // vpcC: a full box (four bytes of version and flags), profile 0, level 3.1, 8 bits.
  assert.equal(codecString('vp09', Uint8Array.of(1, 0, 0, 0, 0, 31, 0x80)), 'vp09.00.31.08');
  // av1C: profile 0 and level 8 (4.0), Main tier, 10 bits.
  assert.equal(codecString('av01', Uint8Array.of(0x81, 0x08, 0x40)), 'av01.0.08M.10');
  assert.equal(codecString('mp4v', Uint8Array.of(0)), null);
});
