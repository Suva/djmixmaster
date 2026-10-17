// Tests of the parts of video handling that need no window.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoOf } from '../src/audio-io.ts';
import { originalPictureExtension } from '../src/app/video-files.ts';

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
