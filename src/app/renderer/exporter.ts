// The page that draws a video export, in a hidden window. Every frame is drawn
// with the Video view's own code, encoded to H.264 by the browser's video
// encoder (the hardware one where there is one), and passed to the main
// process, which packs the picture with the exported sound into an MP4.
// Nothing is kept in memory beyond a few frames, and nothing is written but
// the video itself.

import type { Api, VideoRequest } from '../api.ts';
import { FrameDrawer } from '../../visuals/draw.ts';
import { MUSIC_NAMES, MusicReader } from '../../visuals/music.ts';
import { loadFonts } from '../../visuals/fonts.ts';
import { fontsOf, prepare } from '../../visuals/template.ts';
import { drawVideoFrame, templateOf } from './video-frame.ts';

declare global {
  interface Window {
    api: Api;
  }
}
const api = window.api;

/** Encoded frames are sent on in batches of about this size, so as not to send each one alone. */
const BATCH_BYTES = 1_000_000;
/** A keyframe every this many seconds, so that a player can start anywhere quickly. */
const KEYFRAME_SECONDS = 2;

async function encoderConfig(job: VideoRequest): Promise<VideoEncoderConfig> {
  // H.264 High profile at a level that covers 1080p at 60 frames a second.
  const base = {
    codec: 'avc1.640032',
    width: job.width,
    height: job.height,
    bitrate: job.kbps * 1000,
    framerate: job.fps,
    avc: { format: 'annexb' },
    latencyMode: 'quality',
  } as VideoEncoderConfig;
  for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software'] as const) {
    const config = { ...base, hardwareAcceleration };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
  }
  throw new Error('This computer offers no H.264 encoder for video');
}

async function run(job: VideoRequest) {
  const { mix } = job;
  const features = await api.features(mix.path);
  const reader = new MusicReader(features, mix.start, mix.end);
  const template = templateOf(mix.visuals);
  const fields = mix.visuals?.fields ?? {};
  const layers = prepare(template, fields, MUSIC_NAMES);
  // Every font in before the first frame: a canvas would draw text in a plain face meanwhile, without a word.
  await loadFonts(fontsOf(template, fields));
  const images = new Map<string, ImageBitmap>();
  for (const field of template.fields) {
    const value = fields[field.key];
    if (field.kind === 'image' && typeof value === 'string' && value) {
      images.set(value, await createImageBitmap(new Blob([(await api.readImage(value)) as BlobPart])));
    }
  }

  const canvas = new OffscreenCanvas(job.width, job.height);
  const drawer = new FrameDrawer(canvas);
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let failure: string | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
    },
    error: (error) => (failure = String(error)),
  });
  encoder.configure(await encoderConfig(job));
  const send = async () => {
    if (pendingBytes === 0) return;
    const batch = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const bytes of pending) {
      batch.set(bytes, offset);
      offset += bytes.byteLength;
    }
    pending = [];
    pendingBytes = 0;
    await api.videoChunk(batch);
  };

  // As many frames as fit the sound, which is the mix's exact length.
  const frames = Math.round((mix.end - mix.start) * job.fps);
  const dt = 1 / job.fps;
  const keyframeEvery = Math.round(KEYFRAME_SECONDS * job.fps);
  for (let i = 0; i < frames; i++) {
    if (failure) throw new Error(failure);
    drawVideoFrame(drawer, layers, reader, mix, i / job.fps, dt, images);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / job.fps), duration: Math.round(1e6 / job.fps) });
    encoder.encode(frame, { keyFrame: i % keyframeEvery === 0 });
    frame.close();
    // Wait for the encoder rather than queue up frames: memory stays flat however long the mix.
    while (encoder.encodeQueueSize > 4) await new Promise((done) => encoder.addEventListener('dequeue', done, { once: true }));
    if (pendingBytes >= BATCH_BYTES) await send();
    if (i % job.fps === 0) api.videoProgress(i / frames);
  }
  await encoder.flush();
  if (failure) throw new Error(failure);
  await send();
  encoder.close();
}

api.onVideoJob((job) => {
  run(job).then(
    () => api.videoDone(null),
    (error) => api.videoDone(error instanceof Error ? error.message : String(error)),
  );
});
