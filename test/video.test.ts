// Tests of the parts of video handling that need no window.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoOf } from '../src/audio-io.ts';
import { originalPictureExtension } from '../src/app/video-files.ts';
import { clipTime, pingPongTime } from '../src/visuals/clip.ts';
import { MusicReader } from '../src/visuals/music.ts';
import { BAND_COUNT } from '../src/features.ts';
import { restartedAt } from '../src/app/renderer/video-frame.ts';

test('a video\'s picture is read from what ffmpeg says, and cover art is not a picture', () => {
  const camera = `
  Duration: 01:02:03.04, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4999 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 317 kb/s (default)`;
  assert.deepEqual(videoOf(camera), { codec: 'h264', width: 1920, height: 1080, fps: 29.97, bitrateKbps: 4999, rotation: 0 });

  const prores = '  Stream #0:0[0x1]: Video: prores (HQ) (apch / 0x68637061), yuv422p10le(progressive), 3840x2160, 9111 kb/s, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 15360 tbn (default)';
  assert.equal(videoOf(prores)?.codec, 'prores');
  assert.equal(videoOf(prores)?.width, 3840);

  const phone = `
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 9000 kb/s, 30 fps, 30 tbr, 600 tbn (default)
      Metadata:
        handler_name    : Core Media Video
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 160 kb/s (default)`;
  assert.equal(videoOf(phone)?.rotation, 90, 'upright, as the phone was held');

  const withCover = `
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`;
  assert.equal(videoOf(withCover), null);
});

test('a copied picture goes into an MP4 where one holds it, and a MOV where not', () => {
  assert.equal(originalPictureExtension('h264'), 'mp4');
  assert.equal(originalPictureExtension('hevc'), 'mp4');
  assert.equal(originalPictureExtension('prores'), 'mov');
});

test('a clip loops, plays once, ping-pongs and keeps to its part, at its speed', () => {
  const timing = { seconds: 0, started: 0, playback: 'loop' as const, speed: 1, inPoint: 0, outPoint: 0, offset: 0 };
  const at = (changes: Partial<typeof timing> | Record<string, unknown>, duration = 3) => clipTime({ ...timing, ...changes } as typeof timing, duration, 0.04);
  assert.equal(at({ seconds: 1.5 }), 1.5);
  assert.equal(at({ seconds: 4.5 }), 1.5, 'round again after three seconds');
  assert.equal(at({ seconds: 4.5, started: 2 }), 2.5, 'counted from when the layer appeared');
  assert.equal(at({ seconds: 1, speed: 2 }), 2);
  assert.equal(at({ seconds: 0.5, offset: 1 }), 1.5);
  assert.equal(at({ seconds: 0.5, inPoint: 1, outPoint: 2 }), 1.5);
  assert.equal(at({ seconds: 1.5, inPoint: 1, outPoint: 2 }), 1.5, 'the part used loops');
  assert.equal(at({ seconds: 5, playback: 'once, then hold' }), 2.96, 'its last frame stays');
  assert.equal(at({ seconds: 5, playback: 'once, then hide' }), null);
  assert.equal(at({ seconds: 2, playback: 'once, then hide' }), 2);
  assert.equal(at({ seconds: 4, playback: 'ping-pong' }), 2, 'on its way back');
  assert.equal(at({ seconds: 7, playback: 'ping-pong' }), 1, 'and forwards again');
  assert.equal(pingPongTime({ ...timing, seconds: 4, playback: 'ping-pong' }, 3), 4, 'in the copy that runs there and back');
  assert.equal(at({ seconds: 1 }, 0), 0, 'a clip with no length is a still');
});

test('a clip starts again on every so many beats of the mix, counted from its first, or on each track', () => {
  const rate = 10;
  const steps = 200;
  const features = {
    rate,
    bands: new Uint8Array(steps * BAND_COUNT),
    level: new Uint8Array(steps),
    // A beat every half second from 1 s into the recording.
    beats: Float64Array.from({ length: 30 }, (_, i) => 1 + i / 2),
    beatStrength: new Float32Array(30).fill(1),
  };
  // The mix starts at 2.2 s, so its first beat is at 2.5 s, 0.3 s in.
  const reader = new MusicReader(features, 2.2, 20);
  assert.equal(reader.lastBeat(0.2, 1), -Infinity, 'before the first beat of the mix');
  assert.ok(Math.abs(reader.lastBeat(0.3, 1) - 0.3) < 1e-9);
  assert.ok(Math.abs(reader.lastBeat(1.0, 1) - 0.8) < 1e-9);
  assert.ok(Math.abs(reader.lastBeat(2.2, 4) - 0.3) < 1e-9, 'still in the first bar');
  assert.ok(Math.abs(reader.lastBeat(2.4, 4) - 2.3) < 1e-9, 'the fifth beat of the mix starts the second bar');
  assert.ok(Math.abs(reader.lastBeat(2.2, 2) - 1.3) < 1e-9);
  const mix = { tracks: [{ at: 0, name: 'One' }, { at: 30, name: 'Two' }] } as unknown as Parameters<typeof restartedAt>[0];
  assert.equal(restartedAt(mix, reader, 'each track', 45), 30);
  assert.equal(restartedAt(mix, reader, 'each track', 10), 0);
  assert.equal(restartedAt(mix, reader, 'never', 10), -Infinity);
  assert.ok(Math.abs(restartedAt(mix, reader, 'every 4 beats', 2.4) - 2.3) < 1e-9);
});
