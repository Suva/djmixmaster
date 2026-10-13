import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import { CHANNELS, ffmpeg, probe } from '../audio-io.ts';
import { ANALYSIS_VERSION } from '../loudness.ts';
import { Worker } from 'node:worker_threads';
import type { Job, JobMessage, MediaSource, MenuCommand, Remembered, RenderRequest } from './api.ts';
import { needsStreaming, streamingWavHeader } from './playback.ts';
import { checkNow, checkQuietly, DOWNLOAD_PAGE, loadUpdateSettings, setAutomatic, skipVersion } from './updates.ts';

// The same name, and so the same data folder, whether run from the project or as the packaged app.
app.setName('DJ Mix Master');

// The packaged app carries its own ffmpeg; workers inherit this when they start.
const bundledFfmpeg = join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (app.isPackaged && existsSync(bundledFfmpeg)) process.env.DJMASTER_FFMPEG = bundledFfmpeg;

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'aif', 'aiff', 'ogg', 'opus'];
/** Development aid: save a picture of the window here once a file is drawn, then quit. */
const SCREENSHOT = process.env.DJMASTER_SHOT;
// Automated checks keep their own memory, so they never touch the user's saved work.
if (SCREENSHOT) app.setPath('userData', process.env.DJMASTER_SHOT_DATA ?? join(tmpdir(), 'djmaster-check'));

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
let media = { id: 0, path: '', sampleRate: 0 };

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

/**
 * Serves the open recording decoded from `?t=<seconds>` onwards, as a WAV file
 * of unknown length. ffmpeg lands exactly where asked in every format, which
 * the window's own player does not.
 */
function serveStream(request: Request): Response {
  const from = Math.max(0, Number(new URL(request.url).searchParams.get('t')) || 0);
  const args = ['-v', 'error', '-nostdin', '-ss', String(from), '-i', media.path, '-map', 'a:0', '-ac', String(CHANNELS), '-f', 'f32le', '-'];
  const decoder = spawn(ffmpeg(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const header = streamingWavHeader(media.sampleRate, CHANNELS);
  const audio = Readable.from(
    (async function* () {
      try {
        yield header;
        yield* decoder.stdout;
      } finally {
        // The player moved on or went away; stop decoding.
        decoder.kill();
      }
    })(),
  );
  return new Response(Readable.toWeb(audio) as ReadableStream, { headers: { 'Content-Type': 'audio/wav' } });
}

function serve(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  if (pathname === `/media/${media.id}` && media.path) return serveMedia(request);
  if (pathname === `/stream/${media.id}` && media.path) return serveStream(request);
  const file = pathname.slice(1);
  if (APP_FILES.includes(file)) return net.fetch(pathToFileURL(join(__dirname, file)).toString());
  return new Response(null, { status: 404 });
}

let window: BrowserWindow | null = null;
let running: Worker | null = null;

/** What a job fails with when it is stopped before finishing. */
const CANCELLED = 'Cancelled';

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
      reject(new Error(CANCELLED));
    });
  });
}

/** A recording dropped on the app's icon or chosen with "Open With" before the window was ready. */
let openedFromFinder: string | null = null;

function initialFile(): string | null {
  if (openedFromFinder) return openedFromFinder;
  const argument = process.argv.slice(app.isPackaged ? 1 : 2).find((arg) => !arg.startsWith('-'));
  return argument && existsSync(argument) ? resolve(argument) : null;
}

app.on('open-file', (event, path) => {
  event.preventDefault();
  if (window) window.webContents.send('open-file', path);
  else openedFromFinder = path;
});

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
    // The format was chosen in the export dialog; the suggested name carries it.
    filters: [{ name: extname(suggested).slice(1).toUpperCase(), extensions: [extname(suggested).slice(1)] }],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('pick-folder', async () => {
  // Automated checks cannot answer a dialog.
  if (SCREENSHOT && process.env.DJMASTER_SHOT_FOLDER) return process.env.DJMASTER_SHOT_FOLDER;
  const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('existing', (_event, paths: string[]) => paths.filter((path) => existsSync(path)));

ipcMain.handle('confirm', async (_event, message: string, detail: string, action: string) => {
  const result = await dialog.showMessageBox(window!, {
    type: 'warning', message, detail, buttons: [action, 'Cancel'], defaultId: 1, cancelId: 1,
  });
  return result.response === 0;
});

ipcMain.handle('media-url', async (_event, path: string): Promise<MediaSource> => {
  const [streamed, info] = await Promise.all([needsStreaming(path), probe(path)]);
  media = { id: media.id + 1, path, sampleRate: info.sampleRate };
  return { url: `${ORIGIN}/${streamed ? 'stream' : 'media'}/${media.id}`, streamed };
});

// ---------------------------------------------------------------------------
// What is kept between sessions, all under the app's own data folder:
// analyses (so a long recording is only analysed once), the mixes marked in
// each recording, and the settings last in use.

const ANALYSES_KEPT = 20;
const stored = (folder: string, key: string, extension: string) =>
  join(app.getPath('userData'), folder, `${createHash('sha1').update(key).digest('hex')}.${extension}`);
const defaultsFile = () => join(app.getPath('userData'), 'last-settings.json');

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeStored(file: string, data: string | Uint8Array) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, data);
}

/** Drops the analyses that have gone unused the longest. */
async function pruneAnalyses(folder: string) {
  const files = await Promise.all(
    (await readdir(folder)).map(async (name) => ({ path: join(folder, name), used: (await stat(join(folder, name))).mtimeMs })),
  );
  files.sort((a, b) => b.used - a.used);
  await Promise.all(files.slice(ANALYSES_KEPT).map((file) => rm(file.path, { force: true })));
}

ipcMain.handle('measure', async (_event, input: string) => {
  // A changed file gets a different key and is analysed afresh.
  const info = await stat(input);
  const file = stored('analyses', `${ANALYSIS_VERSION}|${input}|${info.size}|${info.mtimeMs}`, 'bin');
  try {
    const cached = deserialize(await readFile(file));
    await utimes(file, new Date(), new Date()); // counts as used, for pruning
    return cached;
  } catch {
    // Not analysed before, or the stored copy is unreadable.
  }
  const measured = await runJob({ kind: 'measure', input });
  try {
    await writeStored(file, serialize(measured));
    await pruneAnalyses(join(file, '..'));
  } catch (error) {
    console.error('Could not store the analysis:', error);
  }
  return measured;
});

ipcMain.handle('recall', async (_event, path: string): Promise<Remembered> => ({
  session: await readJson(stored('sessions', path, 'json')),
  defaults: await readJson(defaultsFile()),
}));

/** Saves follow one another, so an older one can never land on top of a newer one. */
let saving: Promise<unknown> = Promise.resolve();
ipcMain.on('remember', (_event, path: string, remembered: Remembered) => {
  saving = saving
    .then(() => writeStored(stored('sessions', path, 'json'), JSON.stringify(remembered.session)))
    .then(() => writeStored(defaultsFile(), JSON.stringify(remembered.defaults)))
    .catch((error) => console.error('Could not save the session:', error));
});

ipcMain.handle('render', async (_event, request: RenderRequest) => {
  if (resolve(request.output) === resolve(request.input)) {
    throw new Error('Choose a different name: this would overwrite the recording itself');
  }
  try {
    return await runJob({ kind: 'render', ...request });
  } catch (error) {
    // A cancelled export leaves half a file behind; nobody wants that. On Windows
    // the file cannot go until the encoder has let go of it, hence the retries.
    if (error instanceof Error && error.message === CANCELLED) {
      await rm(request.output, { force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    }
    throw error;
  }
});

ipcMain.on('cancel', () => running?.terminate());

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
    // Automated checks draw off screen, so they also run while the display is asleep.
    show: !SCREENSHOT,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // Pictures for the website are drawn at twice the size, so they stay sharp.
      offscreen: SCREENSHOT ? { deviceScaleFactor: Number(process.env.DJMASTER_SHOT_SCALE) || 1 } : false,
    },
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

/**
 * The menu bar. Undo and Redo go to the window instead of using the built-in
 * roles, which only know about text fields; the window decides whether a text
 * field or the mixes should take them.
 */
/** Whether the automatic check is on, for the tick in the Help menu. */
let checksAutomatically = true;
/** How long after the window appears the quiet check starts, so it never competes with start-up. */
const QUIET_CHECK_DELAY_MS = 4000;

/** "Check for Updates…" in the Help menu: asks now and always answers. */
async function checkForUpdatesNow() {
  if (!window) return;
  const result = await checkNow();
  if (!window) return;
  if (result.state === 'newer') {
    const choice = await dialog.showMessageBox(window, {
      type: 'info',
      message: `Version ${result.version} is available.`,
      detail: `You have version ${app.getVersion()}. The new one can be downloaded from the website.`,
      buttons: ['Open the Download Page', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response === 0) shell.openExternal(DOWNLOAD_PAGE);
  } else if (result.state === 'current') {
    dialog.showMessageBox(window, { type: 'info', message: 'You have the newest version.', detail: `Version ${app.getVersion()}.` });
  } else {
    dialog.showMessageBox(window, {
      type: 'info',
      message: 'Could not check for updates.',
      detail: 'There may be no internet connection. Nothing else is affected.',
    });
  }
}

ipcMain.on('open-download-page', () => shell.openExternal(DOWNLOAD_PAGE));
ipcMain.on('skip-version', (_event, version: string) => skipVersion(String(version)));

function buildMenu() {
  const command = (label: string, accelerator: string, name: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => window?.webContents.send('menu', name),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { label: 'File', submenu: [command('Open Recording…', 'CmdOrCtrl+O', 'open'), { type: 'separator' }, { role: 'close' }] },
    {
      label: 'Edit',
      submenu: [
        command('Undo', 'CmdOrCtrl+Z', 'undo'),
        command('Redo', 'Shift+CmdOrCtrl+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Gestures and Shortcuts', click: () => window?.webContents.send('menu', 'help' satisfies MenuCommand) },
        { type: 'separator' },
        { label: 'Check for Updates…', click: checkForUpdatesNow },
        {
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: checksAutomatically,
          click: (item) => setAutomatic(item.checked),
        },
        { type: 'separator' },
        { label: 'DJ Mix Master Website', click: () => shell.openExternal(DOWNLOAD_PAGE) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  protocol.handle(SCHEME, serve);
  // Reading a small local file; the network is not touched before the window is up.
  checksAutomatically = (await loadUpdateSettings()).automatic;
  buildMenu();
  createWindow();
  window?.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const version = await checkQuietly();
      if (version) window?.webContents.send('update-available', version);
    }, QUIET_CHECK_DELAY_MS);
  });
});
app.on('window-all-closed', () => app.quit());
