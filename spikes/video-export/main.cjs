// A proof of the video export pipeline, not part of the app: a hidden window
// draws frames with WebGL and encodes them with WebCodecs; the encoded stream
// is piped into ffmpeg, which packs it with the audio into an MP4.
//
//   SPIKE_AUDIO=mix.wav SPIKE_OUT=out.mp4 SPIKE_SECONDS=60 npx electron spikes/video-export/main.cjs
//
// Optional: SPIKE_SIZE=1920x1080, SPIKE_FPS=30, SPIKE_ACCEL=prefer-hardware|prefer-software
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const [width, height] = (process.env.SPIKE_SIZE ?? '1920x1080').split('x').map(Number);
const config = {
  seconds: Number(process.env.SPIKE_SECONDS ?? 60),
  width,
  height,
  fps: Number(process.env.SPIKE_FPS ?? 30),
  accel: process.env.SPIKE_ACCEL ?? 'prefer-hardware',
};
const ffmpegPath = process.env.DJMASTER_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';

app.whenReady().then(() => {
  const ffmpeg = spawn(ffmpegPath, [
    '-y', '-v', 'error',
    // A raw H.264 stream carries no timing; -r before it gives each frame its time.
    // (-framerate, the documented option for raw input, is ignored when copying.)
    '-f', 'h264', '-r', String(config.fps), '-i', 'pipe:0',
    '-t', String(config.seconds), '-i', process.env.SPIKE_AUDIO,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
    process.env.SPIKE_OUT,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const closed = once(ffmpeg, 'close');
  let written = 0;

  ipcMain.handle('config', () => config);
  ipcMain.on('log', (_event, text) => console.log(text));
  ipcMain.handle('chunk', (_event, data) => {
    written += data.byteLength;
    return new Promise((done) => (ffmpeg.stdin.write(Buffer.from(data)) ? done() : ffmpeg.stdin.once('drain', done)));
  });
  ipcMain.handle('done', async (_event, summary) => {
    ffmpeg.stdin.end();
    const [code] = await closed;
    const memory = process.memoryUsage();
    console.log(JSON.stringify({ ...summary, ffmpegExit: code, videoMB: +(written / 1e6).toFixed(1), mainRssMB: Math.round(memory.rss / 1e6) }));
    app.quit();
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  });
  window.loadFile(path.join(__dirname, 'page.html'));
});
