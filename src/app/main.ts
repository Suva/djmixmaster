import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import {
  CHANNELS, decode, ffmpeg, inputArgs, isJoined, JOINED_EXTENSION, joinedFiles, joinedList, joinedListHasLengths, joinedName, probe,
} from '../audio-io.ts';
import { ANALYSIS_VERSION } from '../loudness.ts';
import { Worker } from 'node:worker_threads';
import { FEATURES_VERSION, type Features } from '../features.ts';
import type { Examination } from '../master.ts';
import type { FineWave, Job, JobMessage, MediaSource, MenuCommand, RecentRecording, Remembered, RenderRequest } from './api.ts';
import { nameForParts, orderParts } from './parts.ts';
import { needsStreaming, streamingWavHeader } from './playback.ts';
import { checkNow, checkQuietly, DOWNLOAD_PAGE, loadUpdateSettings, setAutomatic, skipVersion } from './updates.ts';

// The same name, and so the same data folder, whether run from the project or as the packaged app.
app.setName('DJ Mix Master');

// An AppImage cannot carry Chromium's sandbox helper in the form it needs, and
// recent Ubuntu also blocks the other way the sandbox starts, so without this
// the app would not open there. The window only ever shows the app's own
// pages, served from inside it, never anything from the internet.
if (process.platform === 'linux' && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

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
  const args = ['-v', 'error', '-nostdin', '-ss', String(from), ...inputArgs(media.path), '-map', 'a:0', '-ac', String(CHANNELS), '-f', 'f32le', '-'];
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

/** Recordings dropped on the app's icon or chosen with "Open With" before the window was ready. */
let openedFromFinder: string[] = [];
/** Files handed over from outside while the window is up arrive one by one; they are gathered and opened together. */
let handedOver: string[] = [];
let handOverTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------------------
// Recordings in several files. A recorder whose file system holds no file
// over 2 or 4 GB splits a long recording; the parts are opened as one. The
// app keeps a list of them in its data folder (see audio-io.ts), and that
// list stands for the recording everywhere a path does: in the window, in
// the stored analyses and mixes, in the recent list.

/** The parts of a recording, or just the recording when it is one file. */
const partsOf = (path: string): string[] => (isJoined(path) ? joinedFiles(path) : [path]);

/** Whether a recording can be opened: the file is there, and so is every part. */
function available(path: string): boolean {
  try {
    return existsSync(path) && partsOf(path).every((part) => existsSync(part));
  } catch {
    return false;
  }
}

/** The name to show for a recording. */
const displayName = (path: string): string => (isJoined(path) ? joinedName(path) : null) ?? basename(path);

/**
 * Turns the files chosen into one recording to open. One file is itself;
 * several are put in the order they were recorded in and listed, and must be
 * alike enough to be read as one stream.
 */
async function recordingOf(chosen: string[]): Promise<{ path: string; name: string }> {
  const unique = [...new Set(chosen.map((path) => resolve(path)))];
  const files = orderParts(await Promise.all(unique.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs }))));
  if (files.length === 1) return { path: files[0], name: displayName(files[0]) };
  const infos = await Promise.all(files.map((file) => probe(file)));
  infos.forEach((info, index) => {
    const unlike =
      info.sampleRate !== infos[0].sampleRate ? `${info.sampleRate / 1000} kHz, not ${infos[0].sampleRate / 1000} kHz`
      : info.codec !== infos[0].codec ? `${info.codec}, not ${infos[0].codec}`
      : info.channels !== infos[0].channels ? `${info.channels}, not ${infos[0].channels}`
      : null;
    if (unlike) throw new Error(`${basename(files[index])} does not match ${basename(files[0])} (${unlike}), so they cannot be joined`);
  });
  const name = nameForParts(files.map((file) => basename(file)));
  const list = stored('recordings', files.join('\n'), JOINED_EXTENSION.slice(1));
  await writeStored(list, joinedList(files, name));
  return { path: list, name };
}

ipcMain.handle('recording-of', (_event, chosen: string[]) => recordingOf(chosen));

const lastRecordingFile = () => join(app.getPath('userData'), 'last-recording.json');

/**
 * The recording worked on last time, if it is still there. A file that has
 * been moved or sits on a drive that is not plugged in gives nothing, and the
 * app starts empty without a word.
 */
async function lastRecording(): Promise<string | null> {
  const last = (await readJson(lastRecordingFile())) as { path?: unknown } | null;
  if (typeof last?.path !== 'string' || !available(last.path)) return null;
  // Forgotten until it has opened again, so a recording that brings the app
  // down while opening is not tried on every start.
  await rm(lastRecordingFile(), { force: true });
  return last.path;
}

const recentFile = () => join(app.getPath('userData'), 'recent-recordings.json');
const RECENT_KEPT = 10;
/** Recordings opened lately, newest first, for File > Open Recent. */
let recent: string[] = [];
/** Whether the window has a recording open, for File > Close Recording. */
let recordingOpen = false;

async function loadRecent() {
  const saved = await readJson(recentFile());
  recent = Array.isArray(saved) ? saved.filter((path) => typeof path === 'string').slice(0, RECENT_KEPT) : [];
}

function saveRecent() {
  writeStored(recentFile(), JSON.stringify(recent)).catch((error) =>
    console.error('Could not save the list of recent recordings:', error),
  );
}

async function initialFile(): Promise<string[] | null> {
  if (openedFromFinder.length > 0) return openedFromFinder;
  // Several files named on the command line are parts of one recording.
  const named = process.argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith('-') && existsSync(arg));
  if (named.length > 0) return named.map((arg) => resolve(arg));
  const last = await lastRecording();
  // A scripted check of the empty window has no recording to wait for.
  if (!last && SCREENSHOT) setTimeout(runCheck, 300);
  return last ? [last] : null;
}

app.on('open-file', (event, path) => {
  event.preventDefault();
  if (!window) {
    openedFromFinder.push(path);
    return;
  }
  handedOver.push(path);
  clearTimeout(handOverTimer);
  handOverTimer = setTimeout(() => {
    window?.webContents.send('open-files', handedOver);
    handedOver = [];
  }, 200);
});

ipcMain.handle('initial-file', initialFile);

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog(window!, {
    // Several files are the parts of one recording.
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
  });
  return result.canceled ? null : result.filePaths;
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

// The analysis keeps one value per 100 ms, which is too coarse to show a beat.
// When the window is zoomed in far enough it asks for the stretch in view to
// be decoded again and kept as a wave. A stretch is half a minute, so this
// is quick, and it is done here rather than in the worker, which may be busy
// with an export.
async function fineWave(path: string, start: number, end: number, sampleRate: number, perSecond: number): Promise<FineWave> {
  const count = Math.max(0, Math.round((end - start) * perSecond));
  const low = new Float32Array(count);
  const high = new Float32Array(count);
  let frame = 0;
  for await (const chunk of decode(path, { start, end })) {
    for (let i = 0; i + 1 < chunk.length; i += CHANNELS, frame++) {
      const at = Math.floor((frame * perSecond) / sampleRate);
      if (at >= count) break;
      const left = chunk[i];
      const right = chunk[i + 1];
      if (left < low[at]) low[at] = left;
      if (right < low[at]) low[at] = right;
      if (left > high[at]) high[at] = left;
      if (right > high[at]) high[at] = right;
    }
  }
  return { low, high };
}

/** One at a time: scrolling asks for several stretches in a row, and each is a decoder of its own. */
let fineWaves: Promise<unknown> = Promise.resolve();
ipcMain.handle('fine-wave', (_event, path: string, start: number, end: number, sampleRate: number, perSecond: number) => {
  const wave = fineWaves.then(() => fineWave(path, start, end, sampleRate, perSecond));
  fineWaves = wave.catch(() => {});
  return wave;
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

// A recording is known by what is in it, not only by where it is, so that
// its analysis and its mixes are found again after it has been moved or
// renamed. Reading all of a file that is hours long would take far too long;
// its size and a few samples of its content tell recordings apart as well.
const FINGERPRINT_SAMPLES = 16;
const FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
/** Fingerprints already worked out, by path, size and modified time. */
const fingerprints = new Map<string, string>();

async function fingerprint(path: string): Promise<string> {
  // A recording in parts is known by its parts, wherever its list is kept.
  if (isJoined(path)) {
    const parts = await Promise.all(joinedFiles(path).map((part) => fingerprint(part)));
    return createHash('sha1').update(parts.join('|')).digest('hex');
  }
  const info = await stat(path);
  const known = `${path}|${info.size}|${info.mtimeMs}`;
  const before = fingerprints.get(known);
  if (before) return before;
  const hash = createHash('sha1').update(String(info.size));
  const file = await open(path, 'r');
  try {
    const sample = Buffer.alloc(Math.min(FINGERPRINT_SAMPLE_BYTES, info.size));
    const last = info.size - sample.length;
    for (let i = 0; i < FINGERPRINT_SAMPLES && sample.length > 0; i++) {
      const { bytesRead } = await file.read(sample, 0, sample.length, Math.floor((last * i) / (FINGERPRINT_SAMPLES - 1)));
      hash.update(sample.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  const found = hash.digest('hex');
  fingerprints.set(known, found);
  return found;
}

/**
 * Writes the length of each part into the list of a recording in parts, once
 * the analysis has counted them, so that jumping about in it is quick.
 */
async function noteLengths(list: string, measured: Examination) {
  if (!isJoined(list) || !measured.partFrames || joinedListHasLengths(list)) return;
  const name = joinedName(list) ?? basename(list);
  const seconds = measured.partFrames.map((frames) => frames / measured.sampleRate);
  await writeStored(list, joinedList(joinedFiles(list), name, seconds));
}

ipcMain.handle('measure', async (_event, input: string) => {
  const examination = await examine(input);
  await noteLengths(input, examination).catch((error) => console.error('Could not note the lengths of the parts:', error));
  return examination;
});

/** When the recording last changed; for one in parts, the last time any part did. */
async function lastModified(input: string): Promise<number> {
  return Math.max(...(await Promise.all(partsOf(input).map(async (part) => (await stat(part)).mtimeMs))));
}

// What the visuals move to: worked out the first time it is asked for, in a
// worker of its own so that it never holds up an analysis or an export, and
// kept like the analyses. Asking again while it runs waits for the same run.
const listening = new Map<string, Promise<Features>>();

ipcMain.handle('features', (_event, input: string) => {
  let features = listening.get(input);
  if (!features) {
    features = listenTo(input).finally(() => listening.delete(input));
    listening.set(input, features);
  }
  return features;
});

async function listenTo(input: string): Promise<Features> {
  const file = stored('visual-features', `${FEATURES_VERSION}|${await fingerprint(input)}|${await lastModified(input)}`, 'bin');
  try {
    const cached = deserialize(await readFile(file)) as Features;
    await utimes(file, new Date(), new Date());
    return cached;
  } catch {
    // Not worked out before.
  }
  const features = await new Promise<Features>((resolvePromise, reject) => {
    const worker = new Worker(join(__dirname, 'worker.cjs'), { workerData: { kind: 'listen', input } satisfies Job });
    worker.on('message', (message: JobMessage) => {
      if (message.type === 'progress') window?.webContents.send('listening', input, message.fraction);
      else if (message.type === 'done') resolvePromise(message.result as Features);
      else reject(new Error(message.message));
    });
    worker.on('error', reject);
    worker.on('exit', () => reject(new Error(CANCELLED)));
  });
  try {
    await writeStored(file, serialize(features));
    await pruneAnalyses(join(file, '..'));
  } catch (error) {
    console.error('Could not store what the visuals move to:', error);
  }
  return features;
}

/** The recording's analysis: stored from an earlier time, or made now. */
async function examine(input: string): Promise<Examination> {
  // Keyed on the content and the modified time: a moved or renamed file is
  // found again, a changed one is analysed afresh. Analyses stored before
  // recordings had fingerprints are under the file's path, and are moved over.
  const info = await stat(input);
  const file = stored('analyses', `${ANALYSIS_VERSION}|${await fingerprint(input)}|${await lastModified(input)}`, 'bin');
  const byPath = stored('analyses', `${ANALYSIS_VERSION}|${input}|${info.size}|${info.mtimeMs}`, 'bin');
  for (const candidate of [file, byPath]) {
    try {
      const data = await readFile(candidate);
      const cached = deserialize(data) as Examination;
      // A recording in parts analysed before the parts were counted is analysed again, once.
      if (isJoined(input) && !cached.partFrames) continue;
      if (candidate === byPath) {
        await writeStored(file, data);
        await rm(byPath, { force: true });
      } else {
        await utimes(file, new Date(), new Date()); // counts as used, for pruning
      }
      return cached;
    } catch {
      // Not analysed before, or the stored copy is unreadable.
    }
  }
  const measured = (await runJob({ kind: 'measure', input })) as Examination;
  try {
    await writeStored(file, serialize(measured));
    await pruneAnalyses(join(file, '..'));
  } catch (error) {
    console.error('Could not store the analysis:', error);
  }
  return measured;
}

/** Where a recording's mixes are kept by its content, for finding them when it has moved. */
const sessionByContent = async (path: string) => stored('sessions', `content|${await fingerprint(path)}`, 'json');

ipcMain.handle('recall', async (_event, path: string): Promise<Remembered> => {
  // By where the recording is, and failing that by what is in it.
  const byPath = await readJson(stored('sessions', path, 'json'));
  const byContent = await sessionByContent(path).catch(() => null);
  // Mixes saved before recordings had fingerprints get their second copy now,
  // so that opening a recording once is enough for it to be found after a move.
  if (byPath && byContent && !existsSync(byContent)) {
    writeStored(byContent, JSON.stringify(byPath)).catch(() => {});
  }
  return {
    session: byPath ?? (byContent ? await readJson(byContent) : null),
    defaults: await readJson(defaultsFile()),
  };
});

/** Saves follow one another, so an older one can never land on top of a newer one. */
let saving: Promise<unknown> = Promise.resolve();
ipcMain.on('remember', (_event, path: string, remembered: Remembered) => {
  saving = saving
    .then(() => writeStored(stored('sessions', path, 'json'), JSON.stringify(remembered.session)))
    .then(() => writeStored(defaultsFile(), JSON.stringify(remembered.defaults)))
    // Last, and allowed to fail: the recording may be gone by the time its mixes are saved.
    .then(async () => writeStored(await sessionByContent(path), JSON.stringify(remembered.session)))
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

// ---------------------------------------------------------------------------
// Pictures for a video's template: a logo, a photo.

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
/** Pictures larger than this are not read; a logo or a photo is far smaller. */
const IMAGE_MOST_BYTES = 40 * 1024 * 1024;

ipcMain.handle('pick-image', async () => {
  const result = await dialog.showOpenDialog(window!, {
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: IMAGE_EXTENSIONS }],
  });
  return result.canceled ? null : result.filePaths[0];
});
// Only pictures, and only of a sensible size: the window asks by path, and the path comes from a template.
ipcMain.handle('read-image', async (_event, path: string) => {
  if (!IMAGE_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) throw new Error('Not a picture');
  if ((await stat(path)).size > IMAGE_MOST_BYTES) throw new Error('The picture is too large');
  return new Uint8Array(await readFile(path));
});

let checkStarted = false;
/**
 * The scripted check: drives the window as the environment says, saves a
 * picture of it and quits. It runs once, when the first recording is on
 * screen or the window has come up empty; its script may open others.
 */
async function runCheck() {
  if (!SCREENSHOT || !window || checkStarted) return;
  checkStarted = true;
  // Menus cannot be clicked from a script, so a check names the command instead.
  if (process.env.DJMASTER_SHOT_MENU) window.webContents.send('menu', process.env.DJMASTER_SHOT_MENU);
  if (process.env.DJMASTER_SHOT_SCRIPT) {
    console.log('[script]', await window.webContents.executeJavaScript(process.env.DJMASTER_SHOT_SCRIPT, true));
  }
  await new Promise((done) => setTimeout(done, 300));
  const image = await window.webContents.capturePage();
  await writeFile(SCREENSHOT, image.toPNG());
  app.quit();
}

ipcMain.on('painted', async (_event, path: string) => {
  writeStored(lastRecordingFile(), JSON.stringify({ path })).catch((error) =>
    console.error('Could not note the recording for next time:', error),
  );
  recent = [path, ...recent.filter((other) => other !== path)].slice(0, RECENT_KEPT);
  saveRecent();
  // Also puts it in the Dock menu and the taskbar's jump list. Not during a
  // scripted check, whose recordings have no place in the user's own lists.
  if (!SCREENSHOT) app.addRecentDocument(path);
  recordingOpen = true;
  buildMenu();
  runCheck();
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

// A recording closed by hand is not brought back at the next start.
ipcMain.on('closed', () => {
  rm(lastRecordingFile(), { force: true }).catch(() => {});
  recordingOpen = false;
  buildMenu();
});

/**
 * File > Open Recent. Recordings that are not there right now are left out
 * but not forgotten: one on a drive that is unplugged comes back with it.
 */
function presentRecent(): RecentRecording[] {
  return recent
    .filter((path) => available(path))
    .map((path) => ({ path, name: displayName(path), folder: dirname(partsOf(path)[0]).replace(homedir(), '~') }));
}

/** The list has changed: the menu and the start screen both show it. */
function recentChanged() {
  buildMenu();
  window?.webContents.send('recent-changed');
}

ipcMain.handle('recent', presentRecent);

function recentMenu(): MenuItemConstructorOptions[] {
  const present = presentRecent();
  const shared = (name: string) => present.filter((other) => other.name === name).length > 1;
  const items = present.map(({ path, name, folder }): MenuItemConstructorOptions => ({
    // Two recordings of the same name are told apart by their folders.
    label: shared(name) ? `${name} — ${folder}` : name,
    click: () => {
      // Gone since the menu was built: drop it from view rather than complain.
      if (available(path)) window?.webContents.send('open-files', [path]);
      else recentChanged();
    },
  }));
  return [
    ...items,
    ...(items.length > 0 ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
    {
      label: 'Clear Menu',
      enabled: recent.length > 0,
      click: () => {
        recent = [];
        saveRecent();
        if (!SCREENSHOT) app.clearRecentDocuments();
        recentChanged();
      },
    },
  ];
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
    {
      label: 'File',
      submenu: [
        command('Open Recording…', 'CmdOrCtrl+O', 'open'),
        { label: 'Open Recent', submenu: recentMenu() },
        { type: 'separator' },
        { ...command('Close Recording', 'Shift+CmdOrCtrl+W', 'close'), enabled: recordingOpen },
        { role: 'close' },
      ],
    },
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
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Gestures and Shortcuts', accelerator: 'F1', click: () => window?.webContents.send('menu', 'help' satisfies MenuCommand) },
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
  await loadRecent();
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
