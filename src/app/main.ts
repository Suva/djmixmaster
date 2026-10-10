import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { createReadStream, existsSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Job, JobMessage, RenderRequest } from './api.ts';

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'aif', 'aiff', 'ogg', 'opus'];
/** Development aid: save a picture of the window here once a file is drawn, then quit. */
const SCREENSHOT = process.env.DJMASTER_SHOT;

/**
 * The window and the recording it plays are served from one origin, so the
 * audio can be routed through Web Audio for the live preview.
 */
const SCHEME = 'djm';
const ORIGIN = `${SCHEME}://app`;
const APP_FILES = ['index.html', 'styles.css', 'renderer.js', 'limiter-worklet.js'];
const MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** The one recording the window may play, and the id in its address. */
let media = { id: 0, path: '' };

/** Serves the open recording with byte ranges, which is what lets the player seek. */
async function serveMedia(request: Request): Promise<Response> {
  const { size } = await stat(media.path);
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers: Record<string, string> = {
    'Content-Type': MEDIA_TYPES[extname(media.path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = Readable.toWeb(createReadStream(media.path, { start, end })) as ReadableStream;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function serve(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  if (pathname === `/media/${media.id}` && media.path) return serveMedia(request);
  const file = pathname.slice(1);
  if (APP_FILES.includes(file)) return net.fetch(pathToFileURL(join(__dirname, file)).toString());
  return new Response(null, { status: 404 });
}

let window: BrowserWindow | null = null;
let running: Worker | null = null;

/** Runs a job in a worker; starting another job abandons the one in flight. */
function runJob(job: Job): Promise<unknown> {
  running?.terminate();
  const worker = new Worker(join(__dirname, 'worker.cjs'), { workerData: job });
  running = worker;
  return new Promise((resolvePromise, reject) => {
    worker.on('message', (message: JobMessage) => {
      if (message.type === 'progress') window?.webContents.send('progress', message.fraction);
      else if (message.type === 'done') resolvePromise(message.result);
      else reject(new Error(message.message));
    });
    worker.on('error', reject);
    worker.on('exit', () => {
      if (running === worker) running = null;
      reject(new Error('Cancelled'));
    });
  });
}

function initialFile(): string | null {
  const argument = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith('-'));
  return argument && existsSync(argument) ? resolve(argument) : null;
}

ipcMain.handle('initial-file', initialFile);

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(window!, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('pick-output', async (_event, suggested: string) => {
  const result = await dialog.showSaveDialog(window!, {
    defaultPath: suggested,
    filters: [
      { name: 'WAV (24-bit)', extensions: ['wav'] },
      { name: 'FLAC (24-bit)', extensions: ['flac'] },
      { name: 'MP3 (320 kbps)', extensions: ['mp3'] },
      { name: 'AAC (256 kbps)', extensions: ['m4a'] },
    ],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('media-url', (_event, path: string) => {
  media = { id: media.id + 1, path };
  return `${ORIGIN}/media/${media.id}`;
});

ipcMain.handle('measure', (_event, input: string) => runJob({ kind: 'measure', input }));

ipcMain.handle('render', (_event, request: RenderRequest) => {
  if (resolve(request.output) === resolve(request.input)) {
    throw new Error('Choose a different name: this would overwrite the recording itself');
  }
  return runJob({ kind: 'render', ...request });
});

ipcMain.on('reveal', (_event, path: string) => shell.showItemInFolder(path));

ipcMain.on('painted', async () => {
  if (!SCREENSHOT || !window) return;
  // Optionally drive the window first, to capture a state other than "just opened".
  if (process.env.DJMASTER_SHOT_SCRIPT) {
    console.log('[script]', await window.webContents.executeJavaScript(process.env.DJMASTER_SHOT_SCRIPT, true));
  }
  await new Promise((done) => setTimeout(done, 300));
  const image = await window.webContents.capturePage();
  await writeFile(SCREENSHOT, image.toPNG());
  app.quit();
});

function createWindow() {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'DJ Mix Master',
    webPreferences: { preload: join(__dirname, 'preload.cjs') },
  });
  if (SCREENSHOT) {
    window.webContents.on('console-message', (event) => console.log(`[window] ${event.message}`));
  }
  // Automated checks run the audio chain without making any sound.
  window.loadURL(`${ORIGIN}/index.html${SCREENSHOT ? '?silent' : ''}`);
  window.on('closed', () => {
    window = null;
    running?.terminate();
  });
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serve);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
