import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { deserialize, serialize } from 'node:v8';
import {
  CHANNELS, decode, ffmpeg, inputArgs, isJoined, JOINED_EXTENSION, joinedFiles, joinedList, joinedListHasLengths, joinedName, probe, probeVideo,
} from '../audio-io.ts';
import { ANALYSIS_VERSION } from '../loudness.ts';
import { Worker } from 'node:worker_threads';
import { FEATURES_VERSION, type Features } from '../features.ts';
import type { Examination } from '../master.ts';
import type { AppSettings, AppView, FineWave, FolderKind, Job, JobMessage, MediaSource, MenuCommand, PreviewPart, RecentRecording, Remembered, RenderRequest } from './api.ts';
import type { MediaFile } from '../visuals/template.ts';
import { nameForParts, orderParts } from './parts.ts';
import { VIDEO_EXTENSIONS } from './video-files.ts';
import { PING_PONG_MOST_SECONDS } from '../visuals/clip.ts';
import { extractZipEntry, isZip, readZip, readZipEntry, writeZip } from './zip.ts';
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
const APP_FILES = ['index.html', 'styles.css', 'renderer.js', 'limiter-worklet.js', 'exporter.html', 'exporter.js'];
const MEDIA_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/** The one recording the window may play, and the id in its address. */
let media = { id: 0, path: '', sampleRate: 0 };

/** Serves a file with byte ranges, which is what lets a player seek: the open recording, or a template's video. */
async function serveMedia(request: Request, path = media.path): Promise<Response> {
  const { size } = await stat(path);
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
    'Content-Type': MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
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

/** Whether the window may be served this file as a video: one of the kinds a template can show, and there. */
const servableVideo = (path: string) => VIDEO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase()) && existsSync(path);

/**
 * Serves the frames of a video decoded, for a video export: from `from`
 * seconds into it, `fps` frames a second, each `w` × `h` pixels in I420
 * (a plane of brightness, then two of colour at half the size each way), one
 * after the other with nothing between. The export reads as many as it
 * needs, and the decoding stops when it stops reading.
 */
function serveFrames(request: Request): Response {
  const query = new URL(request.url).searchParams;
  const path = query.get('path') ?? '';
  const even = (value: string | null) => Math.max(2, Math.min(4096, Math.round((Number(value) || 2) / 2) * 2));
  const [width, height] = [even(query.get('w')), even(query.get('h'))];
  const fps = Math.max(1, Math.min(120, Number(query.get('fps')) || 30));
  const from = Math.max(0, Number(query.get('from')) || 0);
  if (!servableVideo(path) && !(isJoined(path) && existsSync(path))) return new Response(null, { status: 404 });
  const decoder = spawn(ffmpeg(), [
    '-v', 'error', '-nostdin', '-ss', String(from), ...inputArgs(path), '-map', '0:v:0', '-an',
    // Frames on an even grid from the start, so frame k is at `from + k / fps`, whatever the file's own timing.
    // In BT.709, which the export page tells the browser the frames are in.
    '-vf', `fps=${fps},scale=${width}:${height}:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-f', 'rawvideo', '-',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const frames = Readable.from(
    (async function* () {
      try {
        yield* decoder.stdout;
      } finally {
        decoder.kill();
      }
    })(),
  );
  return new Response(Readable.toWeb(frames) as ReadableStream, { headers: { 'Content-Type': 'application/octet-stream' } });
}

function serve(request: Request): Promise<Response> | Response {
  const { pathname, searchParams } = new URL(request.url);
  if (pathname === `/media/${media.id}` && media.path) return serveMedia(request);
  if (pathname === `/stream/${media.id}` && media.path) return serveStream(request);
  // A template's video, for the Video view to play, and its frames, for an export to draw.
  if (pathname === '/video' && servableVideo(searchParams.get('path') ?? '')) return serveMedia(request, searchParams.get('path')!);
  if (pathname === '/frames') return serveFrames(request);
  const file = pathname.slice(1);
  if (APP_FILES.includes(file)) return net.fetch(pathToFileURL(join(__dirname, file)).toString());
  // The fonts that come with the app, for a video's text.
  const font = /^fonts\/([^/\\]+\.ttf)$/.exec(decodeURIComponent(file));
  if (font && existsSync(join(__dirname, 'fonts', font[1]))) return net.fetch(pathToFileURL(join(__dirname, 'fonts', font[1])).toString());
  return new Response(null, { status: 404 });
}

let window: BrowserWindow | null = null;
let running: Worker | null = null;

/** What a job fails with when it is stopped before finishing. */
const CANCELLED = 'Cancelled';

/**
 * Runs a job in a worker; starting another job abandons the one in flight.
 * Its progress goes to the window, through `progress` if given.
 */
function runJob(job: Job, progress = (fraction: number) => window?.webContents.send('progress', fraction)): Promise<unknown> {
  running?.terminate();
  const worker = new Worker(join(__dirname, 'worker.cjs'), { workerData: job });
  running = worker;
  return new Promise((resolvePromise, reject) => {
    worker.on('message', (message: JobMessage) => {
      if (message.type === 'progress') progress(message.fraction);
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

/**
 * macOS and Windows put a file opened from Finder or Explorer in the app's
 * recent documents (the Dock menu, the jump list) by themselves. A template
 * is imported once and has no place there, and they offer no way to take
 * one item out, so the list is made again from the recordings in ours.
 */
function forgetSystemRecent() {
  if (SCREENSHOT) return;
  app.clearRecentDocuments();
  // Added oldest first, so that the newest ends up on top.
  for (const path of [...recent].reverse()) if (existsSync(path)) app.addRecentDocument(path);
}

/** A video template to import, rather than a recording to open: from Finder, the command line or a drop. */
const isTemplateFile = (path: string) => /\.djmtemplate$/i.test(path);

async function initialFile(): Promise<string[] | null> {
  // Several files named on the command line are parts of one recording.
  const named = process.argv.slice(app.isPackaged ? 1 : 2).filter((arg) => !arg.startsWith('-') && existsSync(arg)).map((arg) => resolve(arg));
  const given = openedFromFinder.length > 0 ? openedFromFinder : named;
  if (given.some((path) => !isTemplateFile(path))) return given;
  // Nothing but templates, or nothing: the last recording opens as usual, and the templates are imported.
  const last = await lastRecording();
  // A scripted check of the empty window has no recording to wait for.
  if (!last && SCREENSHOT) setTimeout(runCheck, 300);
  const files = [...(last ? [last] : []), ...given];
  return files.length ? files : null;
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
    filters: [
      { name: 'Audio and video', extensions: [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS] },
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
      { name: 'Video', extensions: VIDEO_EXTENSIONS },
    ],
  });
  return result.canceled ? null : result.filePaths;
});

ipcMain.handle('pick-output', async (_event, suggested: string) => {
  // Automated checks cannot answer a dialog: the file goes into their folder, under the name suggested.
  if (SCREENSHOT && process.env.DJMASTER_SHOT_FOLDER) return join(process.env.DJMASTER_SHOT_FOLDER, basename(suggested));
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
  const info = await probe(path);
  const streamed = await needsStreaming(path, info.codec);
  media = { id: media.id + 1, path, sampleRate: info.sampleRate };
  return { url: `${ORIGIN}/${streamed ? 'stream' : 'media'}/${media.id}`, streamed, video: info.video };
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
  if (request.video) return renderVideo(request);
  if (request.originalPicture) return renderOriginalPicture(request);
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

ipcMain.on('cancel', () => {
  running?.terminate();
  videoExport?.finish(CANCELLED);
  cancelPacking?.();
});

// ---------------------------------------------------------------------------
// Video exports. The sound is exported first, as for any other format, to a
// file of its own. Then a hidden window draws every frame with the Video
// view's code and encodes it (exporter.ts); the encoded picture comes here in
// batches and goes straight into ffmpeg, which packs it with the sound into
// the MP4 without encoding either again. The sound takes a tenth of the time.

const SOUND_SHARE = 0.1;

interface VideoExport {
  /** Where the picture goes: ffmpeg's input. */
  write(bytes: Uint8Array): Promise<void>;
  /** Ends the export: finished when `failure` is null, given up otherwise. */
  finish(failure: string | null): void;
}
let videoExport: VideoExport | null = null;

ipcMain.handle('video-chunk', (_event, bytes: Uint8Array) => videoExport?.write(bytes));
ipcMain.on('video-progress', (_event, fraction: number) => window?.webContents.send('progress', SOUND_SHARE + (1 - SOUND_SHARE) * fraction));
ipcMain.on('video-done', (_event, failure: string | null) => videoExport?.finish(failure));

async function renderVideo(request: RenderRequest): Promise<unknown> {
  const video = request.video!;
  const sound = join(app.getPath('temp'), `djmaster-${process.pid}-${Date.now()}.m4a`);
  try {
    const result = await runJob(
      { kind: 'render', ...request, video: undefined, output: sound },
      (fraction) => window?.webContents.send('progress', SOUND_SHARE * fraction),
    );
    await new Promise<void>((done, fail) => {
      const packer = spawn(ffmpeg(), [
        '-y', '-v', 'error',
        // A raw H.264 stream carries no timing: -r before it gives each frame its time.
        // (-framerate, the option documented for raw input, is ignored when copying.)
        '-f', 'h264', '-r', String(video.fps), '-i', 'pipe:0',
        '-i', sound,
        '-map', '0:v', '-map', '1:a', '-c', 'copy',
        // The tags (title, artist, album) were written into the sound; they carry over.
        '-map_metadata', '1',
        // The index at the front, so that players and YouTube can start before the whole file is read.
        '-movflags', '+faststart',
        request.output,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let complaint = '';
      packer.stderr.on('data', (data) => (complaint += data));
      packer.stdin.on('error', () => {}); // ffmpeg gone; its exit says why.
      const drawer = new BrowserWindow({
        show: false,
        webPreferences: { preload: join(__dirname, 'preload.cjs'), backgroundThrottling: false },
      });
      if (SCREENSHOT) drawer.webContents.on('console-message', (event) => console.log(`[exporter] ${event.message}`));
      let finished = false;
      const finish = (failure: string | null) => {
        if (finished) return;
        finished = true;
        videoExport = null;
        drawer.destroy();
        if (failure) {
          packer.kill();
          fail(new Error(failure));
          return;
        }
        packer.on('close', (code) => (code === 0 ? done() : fail(new Error(`Packing the video failed: ${complaint.trim() || `exit code ${code}`}`))));
        packer.stdin.end();
      };
      videoExport = {
        write: (bytes) => new Promise((written) => (packer.stdin.write(bytes) ? written() : packer.stdin.once('drain', written))),
        finish,
      };
      packer.on('error', (error) => finish(error.message));
      packer.on('close', (code) => {
        if (!finished) finish(`Packing the video failed: ${complaint.trim() || `exit code ${code}`}`);
      });
      drawer.webContents.once('did-finish-load', () => drawer.webContents.send('video-job', video));
      drawer.loadURL(`${ORIGIN}/exporter.html`);
    });
    return result;
  } catch (error) {
    await rm(request.output, { force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    throw error;
  } finally {
    await rm(sound, { force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
  }
}

/**
 * A video export that keeps the recording's own picture: the sound is
 * exported as for any other format, then the picture of the same stretch is
 * copied from the recording and packed with it, without being encoded again.
 * That takes little longer than the sound alone.
 *
 * A copied picture can only begin on a keyframe, which may be seconds before
 * the mix. ffmpeg copies from there and marks the frames before the mix to be
 * skipped (an edit list), so players start on the right frame, in time with
 * the sound. The end is not cut as finely: the picture may run a few frames
 * past the sound.
 */
async function renderOriginalPicture(request: RenderRequest): Promise<unknown> {
  const sound = join(app.getPath('temp'), `djmaster-${process.pid}-${Date.now()}.m4a`);
  try {
    const result = await runJob(
      { kind: 'render', ...request, originalPicture: undefined, output: sound },
      (fraction) => window?.webContents.send('progress', 0.9 * fraction),
    );
    const picture = (await probe(request.input)).video;
    const pictureFrom = request.start - (request.pictureDelay ?? 0);
    if (!picture) throw new Error('The recording has no picture');
    await new Promise<void>((done, fail) => {
      const packer = spawn(ffmpeg(), [
        '-y', '-v', 'error', '-nostdin',
        // A picture shown later than its sound starts earlier in the recording; before its start, it starts late.
        ...(pictureFrom >= 0 ? ['-ss', String(pictureFrom)] : ['-itsoffset', String(-pictureFrom)]),
        ...inputArgs(request.input),
        '-i', sound,
        '-map', '0:v:0', '-map', '1:a', '-c', 'copy', '-t', String(request.end - request.start),
        // The tags and the chapters were written into the sound; they carry over.
        '-map_metadata', '1', '-map_chapters', '1',
        // Apple's players and QuickTime show HEVC in an MP4 only under this name.
        ...(picture.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
        '-movflags', '+faststart',
        request.output,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let complaint = '';
      let cancelled = false;
      packer.stderr.on('data', (data) => (complaint += data));
      packer.on('error', fail);
      packer.on('close', (code) => {
        if (cancelled) fail(new Error(CANCELLED));
        else if (code === 0) done();
        else fail(new Error(`Packing the video failed: ${complaint.trim() || `exit code ${code}`}`));
      });
      cancelPacking = () => {
        cancelled = true;
        packer.kill();
      };
    });
    window?.webContents.send('progress', 1);
    return result;
  } catch (error) {
    await rm(request.output, { force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
    throw error;
  } finally {
    cancelPacking = null;
    await rm(sound, { force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
  }
}
/** Stops the packing of a video that keeps the recording's picture, while it runs. */
let cancelPacking: (() => void) | null = null;

ipcMain.on('reveal', (_event, path: string) => shell.showItemInFolder(path));

// ---------------------------------------------------------------------------
// Pictures for a video's template: a logo, a photo.

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
/** Pictures larger than this are not read; a logo or a photo is far smaller. */
const IMAGE_MOST_BYTES = 40 * 1024 * 1024;

// Templates of the user's own, one JSON file each in templates/, by an id the
// window gives. A template file to share (.djmtemplate) is a ZIP of that
// JSON, as template.json, with the videos it shows beside it in media/; its
// pictures are inside the JSON. Template files from before videos are the
// JSON alone, and still open.
const templatesFolder = () => join(app.getPath('userData'), 'templates');
const TEMPLATE_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A template with pictures packed in can be large, but not without end. */
const TEMPLATE_MOST_BYTES = 100 * 1024 * 1024;
const templateFile = (id: string) => {
  if (!TEMPLATE_ID.test(id)) throw new Error('Not a template id');
  return join(templatesFolder(), `${id}.json`);
};
ipcMain.handle('templates', async () => {
  const files = await readdir(templatesFolder()).catch(() => [] as string[]);
  const found: { id: string; template: unknown }[] = [];
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    // One damaged file must not keep the others from showing.
    try {
      found.push({ id: file.slice(0, -5), template: JSON.parse(await readFile(join(templatesFolder(), file), 'utf8')) });
    } catch {}
  }
  return found;
});
ipcMain.handle('save-template', async (_event, id: string, template: unknown) => {
  await mkdir(templatesFolder(), { recursive: true });
  await writeFile(templateFile(id), JSON.stringify(template, null, 2));
});
ipcMain.handle('delete-template', async (_event, id: string) => {
  // To the Trash, where it can be got back; checks remove theirs outright.
  if (SCREENSHOT) await rm(templateFile(id), { force: true });
  else await shell.trashItem(templateFile(id));
});
/** The name of the JSON in a template file. */
const TEMPLATE_ENTRY = 'template.json';

/**
 * What is in a template file: the JSON, and for a ZIP the videos packed
 * with it, taken out into the media folder and named in the JSON by where
 * they now are.
 */
async function readTemplateFile(path: string): Promise<unknown> {
  if (!(await isZip(path))) {
    if ((await stat(path)).size > TEMPLATE_MOST_BYTES) throw new Error('That file is too large to be a template');
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('That file is not a template');
    }
  }
  const items = await readZip(path);
  const json = items.find((item) => item.name === TEMPLATE_ENTRY);
  if (!json || json.size > TEMPLATE_MOST_BYTES) throw new Error('That file is not a template');
  let template: { media?: Record<string, Partial<MediaFile>> };
  try {
    template = JSON.parse((await readZipEntry(path, json)).toString('utf8'));
  } catch {
    throw new Error('That file is not a template');
  }
  // Taken out under a name of the app's own, never one from the file, so nothing lands outside the folder.
  for (const file of Object.values(template.media ?? {})) {
    const item = items.find((entry) => entry.name === file?.path);
    if (!file || !item) continue;
    await mkdir(mediaFolder(), { recursive: true });
    const unpacked = join(mediaFolder(), `unpacking-${process.pid}-${Date.now()}${extname(item.name).toLowerCase()}`);
    try {
      await extractZipEntry(path, item, unpacked);
      Object.assign(file, await keepMedia(unpacked, true));
    } finally {
      await rm(unpacked, { force: true });
    }
  }
  return template;
}

ipcMain.handle('import-template', async () => {
  const chosen = SCREENSHOT && process.env.DJMASTER_SHOT_TEMPLATE
    ? process.env.DJMASTER_SHOT_TEMPLATE
    : (await dialog.showOpenDialog(window!, {
        properties: ['openFile'],
        filters: [{ name: 'Video templates', extensions: ['djmtemplate', 'json'] }],
      })).filePaths[0];
  if (!chosen) return null;
  return readTemplateFile(chosen);
});
// A template file opened from Finder or dropped on the window, by its path.
ipcMain.handle('read-template-file', async (_event, path: string) => {
  if (!isTemplateFile(String(path)) && !/\.json$/i.test(String(path))) throw new Error('Not a template file');
  forgetSystemRecent();
  return readTemplateFile(path);
});
ipcMain.handle('export-template', async (_event, template: unknown, name: string) => {
  const fileName = `${String(name).replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Template'}.djmtemplate`;
  const chosen = SCREENSHOT && process.env.DJMASTER_SHOT_FOLDER
    ? join(process.env.DJMASTER_SHOT_FOLDER, fileName)
    : (await dialog.showSaveDialog(window!, {
        defaultPath: join(app.getPath('documents'), fileName),
        filters: [{ name: 'Video templates', extensions: ['djmtemplate'] }],
      })).filePath;
  if (!chosen) return null;
  // Each video goes in under media/, named after the name it has in the template, and the JSON says so.
  const shared = structuredClone(template) as { media?: Record<string, MediaFile> };
  const videos: { name: string; path: string }[] = [];
  for (const [key, file] of Object.entries(shared.media ?? {})) {
    if (!existsSync(file.path)) throw new Error(`The video ${key} is not where the template says it is: ${file.path}`);
    let entry = `media/${key.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video'}${extname(file.path).toLowerCase()}`;
    for (let n = 2; videos.some((video) => video.name === entry); n++) entry = entry.replace(/( \d+)?(\.[^.]*)$/, ` ${n}$2`);
    videos.push({ name: entry, path: file.path });
    file.path = entry;
  }
  await writeZip(chosen, [{ name: TEMPLATE_ENTRY, data: Buffer.from(JSON.stringify(shared, null, 2)) }, ...videos]);
  return chosen;
});

// A track list: from DJ software, which writes UTF-16 as often as UTF-8, or typed.
ipcMain.handle('open-tracklist', async () => {
  const chosen = SCREENSHOT && process.env.DJMASTER_SHOT_TRACKLIST
    ? process.env.DJMASTER_SHOT_TRACKLIST
    : (await dialog.showOpenDialog(window!, {
        properties: ['openFile'],
        filters: [{ name: 'Track lists', extensions: ['txt', 'm3u', 'm3u8', 'csv', 'cue'] }, { name: 'All files', extensions: ['*'] }],
      })).filePaths[0];
  if (!chosen) return null;
  if ((await stat(chosen)).size > 5_000_000) throw new Error('That file is too large to be a track list');
  const bytes = await readFile(chosen);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
});
ipcMain.handle('read-clipboard', () => clipboard.readText());
ipcMain.on('write-clipboard', (_event, text: string) => clipboard.writeText(String(text)));

ipcMain.handle('pick-image', async () => {
  if (SCREENSHOT && process.env.DJMASTER_SHOT_IMAGE) return process.env.DJMASTER_SHOT_IMAGE;
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

// LUTs for a video's template: .cube files, read as text and turned into a table by the window.
/** A 65-point cube, the largest the window takes, is about 8 MB of text. */
const LUT_MOST_BYTES = 32 * 1024 * 1024;
ipcMain.handle('pick-lut', async () => {
  if (SCREENSHOT && process.env.DJMASTER_SHOT_LUT) return process.env.DJMASTER_SHOT_LUT;
  const result = await dialog.showOpenDialog(window!, {
    properties: ['openFile'],
    filters: [{ name: 'LUTs', extensions: ['cube'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});
// As with pictures: only .cube files of a sensible size.
ipcMain.handle('read-lut', async (_event, path: string) => {
  if (extname(path).toLowerCase() !== '.cube') throw new Error('Not a .cube LUT');
  if ((await stat(path)).size > LUT_MOST_BYTES) throw new Error('The LUT is too large');
  return readFile(path, 'utf8');
});

// The LUT folder: .cube files put there are offered wherever a LUT is chosen,
// so that a collection of looks is at hand without a file dialog each time.
// In the app's data folder unless chosen otherwise, as a collection may
// already live somewhere else.
const defaultLutFolder = () => join(app.getPath('userData'), 'luts');
const lutFolder = () => preferences.lutFolder ?? defaultLutFolder();
/** LUT packs come as folders of looks; this deep in the LUT folder they are still found. */
const LUT_FOLDER_DEPTH = 2;

/** The .cube files in a folder and the folders in it, each named by where it is in it, without the extension: "Film/Warm". */
async function lutsIn(folder: string, within = '', depth = 0): Promise<{ name: string; path: string }[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const found: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory() && depth < LUT_FOLDER_DEPTH) found.push(...(await lutsIn(path, `${within}${entry.name}/`, depth + 1)));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.cube') found.push({ name: within + entry.name.slice(0, -5), path });
  }
  return found;
}
// A LUT of the folder, by its name there: so a template names it the same wherever the folder is, and on another computer with the same LUTs.
ipcMain.handle('read-folder-lut', async (_event, name: string) => {
  const folder = resolve(lutFolder());
  const path = resolve(folder, `${name}.cube`);
  // Only what is in the folder: a template's name for a LUT must not lead out of it.
  if (!path.startsWith(folder + sep)) throw new Error('Not a LUT in the LUT folder');
  if ((await stat(path).catch(() => null)) === null) throw new Error(`There is no ${name}.cube in the LUT folder`);
  if ((await stat(path)).size > LUT_MOST_BYTES) throw new Error('The LUT is too large');
  return readFile(path, 'utf8');
});
ipcMain.handle('folder-luts', async () =>
  (await lutsIn(lutFolder())).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));

/** Settings > Show the LUT folder: made if it is not there yet, so there is somewhere to put them. */
async function showLutFolder() {
  await mkdir(lutFolder(), { recursive: true });
  await shell.openPath(lutFolder());
}

/** Settings > the LUT folder's Change…: where the LUTs offered come from. */
async function chooseLutFolder() {
  if (!window) return;
  const result = SCREENSHOT && process.env.DJMASTER_SHOT_FOLDER ? { canceled: false, filePaths: [process.env.DJMASTER_SHOT_FOLDER] } : await dialog.showOpenDialog(window, {
    title: 'Folder for LUTs',
    message: 'The .cube files in this folder, and in the folders in it, are offered wherever a LUT is chosen.',
    defaultPath: lutFolder(),
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  preferences = { ...preferences, lutFolder: result.filePaths[0] };
  await writeStored(preferencesFile(), JSON.stringify(preferences));
  window?.webContents.send('luts-changed');
}

// ---------------------------------------------------------------------------
// Videos for a video's template: a loop behind the music, a clip of the club.
// A small one is copied into the app's media folder, so that it stays with
// the template whatever happens to the file chosen; a large one is used
// where it is, as copying it would take time and space for nothing.

/** Videos up to this size are copied into the media folder. */
const MEDIA_COPY_MOST_BYTES = 25 * 1024 * 1024;
const defaultMediaFolder = () => join(app.getPath('userData'), 'media');
/**
 * Where videos added to templates are kept: in the app's data folder unless
 * chosen otherwise, as a larger drive may be wanted for them.
 */
const mediaFolder = () => preferences.mediaFolder ?? defaultMediaFolder();

// Choices that belong to the app rather than to a recording: the folders, and the view the window was left in.
interface Preferences {
  mediaFolder?: string;
  lutFolder?: string;
  view?: AppView;
}
const VIEWS: AppView[] = ['mastering', 'video', 'editing'];
let preferences: Preferences = {};
const preferencesFile = () => join(app.getPath('userData'), 'preferences.json');

async function loadPreferences() {
  const saved = (await readJson(preferencesFile())) as Record<string, unknown> | null;
  preferences = {};
  if (typeof saved?.mediaFolder === 'string' && saved.mediaFolder) preferences.mediaFolder = saved.mediaFolder;
  if (typeof saved?.lutFolder === 'string' && saved.lutFolder) preferences.lutFolder = saved.lutFolder;
  if (VIEWS.includes(saved?.view as AppView)) preferences.view = saved!.view as AppView;
}

const savePreferences = () => writeStored(preferencesFile(), JSON.stringify(preferences));

/** What the Settings dialog shows. */
const settingsNow = (): AppSettings => ({
  mediaFolder: mediaFolder(),
  mediaFolderChosen: preferences.mediaFolder !== undefined,
  lutFolder: lutFolder(),
  lutFolderChosen: preferences.lutFolder !== undefined,
  checkUpdates: checksAutomatically,
  version: app.getVersion(),
});
ipcMain.handle('settings', () => settingsNow());
ipcMain.handle('choose-folder', async (_event, which: FolderKind) => {
  await (which === 'luts' ? chooseLutFolder() : chooseMediaFolder());
  return settingsNow();
});
ipcMain.handle('default-folder', async (_event, which: FolderKind) => {
  const { [which === 'luts' ? 'lutFolder' : 'mediaFolder']: _gone, ...kept } = preferences;
  preferences = kept;
  await savePreferences();
  if (which === 'luts') window?.webContents.send('luts-changed');
  return settingsNow();
});
ipcMain.on('show-folder', (_event, which: FolderKind) => {
  // In check mode nothing opens on the screen.
  if (SCREENSHOT) return;
  if (which === 'luts') showLutFolder();
  else mkdir(mediaFolder(), { recursive: true }).then(() => shell.openPath(mediaFolder()));
});
ipcMain.handle('set-check-updates', async (_event, on: boolean) => {
  checksAutomatically = on === true;
  await setAutomatic(checksAutomatically);
  return settingsNow();
});
ipcMain.on('check-updates-now', () => checkForUpdatesNow());
ipcMain.handle('view', () => preferences.view ?? 'mastering');
ipcMain.on('set-view', (_event, view: AppView) => {
  if (!VIEWS.includes(view) || preferences.view === view) return;
  preferences = { ...preferences, view };
  savePreferences();
});

/** Settings > the template videos folder's Change…: where videos added from now on are kept. Those kept already stay where they are. */
async function chooseMediaFolder() {
  if (!window) return;
  const result = SCREENSHOT && process.env.DJMASTER_SHOT_FOLDER ? { canceled: false, filePaths: [process.env.DJMASTER_SHOT_FOLDER] } : await dialog.showOpenDialog(window, {
    title: 'Folder for Template Videos',
    message: 'Videos up to 25 MB added to templates, and those in template files imported, are kept here. Videos already kept stay where they are.',
    defaultPath: mediaFolder(),
    buttonLabel: 'Use This Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return;
  preferences = { ...preferences, mediaFolder: result.filePaths[0] };
  await writeStored(preferencesFile(), JSON.stringify(preferences));
}

/**
 * Makes a video one a template can keep: a small one copied into the media
 * folder, named by what is in it so that the same video is kept once; a
 * large one where it is. Either way with its fingerprint, to find it by.
 */
async function keepMedia(path: string, copyAnyway = false): Promise<MediaFile> {
  const { size } = await stat(path);
  const known = await fingerprint(path);
  if (size > MEDIA_COPY_MOST_BYTES && !copyAnyway) return { path, bytes: size, fingerprint: known };
  const copy = join(mediaFolder(), `${known}${extname(path).toLowerCase()}`);
  if (!existsSync(copy)) {
    await mkdir(mediaFolder(), { recursive: true });
    await copyFile(path, `${copy}.part`);
    await rename(`${copy}.part`, copy);
  }
  return { path: copy, bytes: size, fingerprint: known };
}

/**
 * Looks for videos of a template that are no longer where it says: in the
 * media folders by their kept names, and in `near`, a folder where another
 * was just found, by their own names. One found must be the same video, by
 * its fingerprint. Gives each where it is now, or null.
 */
async function findMedia(files: MediaFile[], near?: string): Promise<(MediaFile | null)[]> {
  return Promise.all(files.map(async (file) => {
    if (existsSync(file.path)) return file;
    const name = basename(file.path.replace(/\\/g, '/'));
    const candidates = [mediaFolder(), defaultMediaFolder(), ...(near ? [near] : [])].map((folder) => join(folder, name));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (file.fingerprint && (await fingerprint(candidate).catch(() => '')) !== file.fingerprint) continue;
      return { ...file, path: candidate };
    }
    return null;
  }));
}
ipcMain.handle('find-media', (_event, files: MediaFile[], near?: string) => findMedia(files, near));

ipcMain.handle('pick-video', async () => {
  if (SCREENSHOT && process.env.DJMASTER_SHOT_VIDEO) return process.env.DJMASTER_SHOT_VIDEO;
  const result = await dialog.showOpenDialog(window!, {
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('video-info', (_event, path: string) => probeVideo(String(path)));
/**
 * The files the Video view plays a video from, each with its length, one
 * after the other: the video itself, or the parts of a recording in several
 * files, which a video element cannot join; each a playable copy if the
 * window cannot play it as it is.
 */
const previewParts = new Map<string, Promise<PreviewPart[]>>();
ipcMain.handle('preview-parts', (_event, path: string) => {
  let parts = previewParts.get(path);
  if (!parts) {
    parts = Promise.all(partsOf(String(path)).map(async (part) => ({ path: await playable(part), duration: (await probeVideo(part)).duration })));
    previewParts.set(path, parts);
    parts.catch(() => previewParts.delete(path));
  }
  return parts;
});
ipcMain.handle('ping-pong-clip', (_event, path: string, inPoint: number, outPoint: number) => pingPongClip(String(path), Number(inPoint) || 0, Number(outPoint) || 0));

// Copies of videos made for the app's own use, kept like the analyses: one
// the window can play, for a video in a codec or a file it does not know;
// and the part of a clip that plays ping-pong, followed by itself reversed,
// so that it can be played forwards all the way round.
const clipsFolder = () => join(app.getPath('userData'), 'video-clips');
/** Codecs and files the window plays as they are. */
const PLAYED_PICTURES = ['h264', 'vp8', 'vp9', 'av1'];
const PLAYED_FILES = ['.mp4', '.m4v', '.mov', '.webm'];
/** Reversed in pieces of this length: ffmpeg holds a whole piece decoded while it reverses it. */
const REVERSED_SECONDS = 2;
/** Copies being made, so that asking twice waits for the same one. */
const making = new Map<string, Promise<string>>();

/** Runs ffmpeg to its end; fails with what it said. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(ffmpeg(), ['-v', 'error', '-y', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let complaint = '';
    child.stderr.on('data', (data) => (complaint += data));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done() : fail(new Error(complaint.trim() || `ffmpeg exit code ${code}`))));
  });
}

/** Makes a copy once, under a name made from `key`, or finds it made before; `make` writes the file it is given. */
async function madeCopy(key: string, make: (output: string) => Promise<void>): Promise<string> {
  const output = stored('video-clips', key, 'mp4');
  if (existsSync(output)) {
    await utimes(output, new Date(), new Date()).catch(() => {});
    return output;
  }
  let made = making.get(output);
  if (!made) {
    made = (async () => {
      await mkdir(clipsFolder(), { recursive: true });
      const partial = `${output}.part.mp4`;
      try {
        await make(partial);
        await rename(partial, output);
      } finally {
        await rm(partial, { force: true }).catch(() => {});
      }
      await pruneAnalyses(clipsFolder()).catch(() => {});
      return output;
    })().finally(() => making.delete(output));
    making.set(output, made);
  }
  return made;
}

/** H.264 that any part of the app plays and cuts cleanly, a keyframe every second; `crf` 18 is as good as the eye can tell. */
const H264 = (fps: number, crf = 18) => ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps))];
/** No larger than this, with the even sides H.264 wants, on an even grid of frames. */
const fitted = (fps: number, width = 1920, height = 1080) =>
  `fps=${fps},scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;

/** A file the window can play for this video: the video itself if it can, or a copy. */
async function playable(path: string): Promise<string> {
  const { video } = await probeVideo(path);
  const knownCodec = PLAYED_PICTURES.includes(video.codec);
  if (knownCodec && PLAYED_FILES.includes(extname(path).toLowerCase())) return path;
  const fps = Math.min(60, video.fps || 30);
  return madeCopy(`preview|${await fingerprint(path)}`, (output) =>
    // In a file the window knows, the picture as it is; else made again, smaller, which takes longer.
    runFfmpeg(knownCodec
      ? ['-i', path, '-map', '0:v:0', '-an', '-c:v', 'copy', output]
      : ['-i', path, '-map', '0:v:0', '-vf', fitted(fps, 1280, 720), ...H264(fps, 23), output]),
  );
}

/**
 * The part of a clip from `inPoint` to `outPoint` (0 for its end), followed
 * by itself reversed: ping-pong, played forwards. The reversed half is made
 * in short pieces, each reversed on its own and put in the opposite order,
 * so that only a piece is ever held decoded.
 */
async function pingPongClip(path: string, inPoint: number, outPoint: number): Promise<string> {
  const { duration, video } = await probeVideo(path);
  const from = Math.max(0, Math.min(duration, inPoint));
  const to = outPoint > 0 ? Math.max(from, Math.min(duration, outPoint)) : duration;
  const length = to - from;
  if (length > PING_PONG_MOST_SECONDS) throw new Error(`Ping-pong is for clips of up to ${PING_PONG_MOST_SECONDS} seconds`);
  const fps = Math.min(60, video.fps || 30);
  return madeCopy(`ping-pong|${await fingerprint(path)}|${from}|${to}`, async (output) => {
    const work = `${output}.pieces`;
    await mkdir(work, { recursive: true });
    try {
      const forwards = join(work, 'forwards.mp4');
      await runFfmpeg(['-ss', String(from), '-t', String(length), '-i', path, '-map', '0:v:0', '-vf', fitted(fps), ...H264(fps), forwards]);
      const pieces: string[] = [];
      for (let start = 0; start < length; start += REVERSED_SECONDS) {
        const piece = join(work, `${pieces.length}.mp4`);
        await runFfmpeg(['-ss', String(start), '-t', String(REVERSED_SECONDS), '-i', forwards, '-vf', 'reverse', ...H264(fps), piece]);
        pieces.push(piece);
      }
      const list = join(work, 'list.txt');
      await writeFile(list, [forwards, ...pieces.reverse()].map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output]);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}
ipcMain.handle('add-media', async (_event, path: string): Promise<MediaFile> => {
  if (!servableVideo(String(path))) throw new Error('Not a video');
  await probeVideo(path);
  return keepMedia(path);
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
/** Whether the automatic check is on, as the Settings dialog shows it. */
let checksAutomatically = true;
/** How long after the window appears the quiet check starts, so it never competes with start-up. */
const QUIET_CHECK_DELAY_MS = 4000;

/** "Check for Updates…" in the Help menu, and Check now in Settings: asks now and always answers. */
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
// A template's website or email, on a click: given to the browser or the mail program, and nothing else
// is, as a template from anywhere could name anything.
ipcMain.on('open-link', (_event, url: string) => {
  try {
    if (['https:', 'http:', 'mailto:'].includes(new URL(String(url)).protocol)) shell.openExternal(String(url));
  } catch {}
});
ipcMain.on('skip-version', (_event, version: string) => skipVersion(String(version)));

function buildMenu() {
  const command = (label: string, accelerator: string, name: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => window?.webContents.send('menu', name),
  });
  // Settings… where each system has it: in the app's menu on the Mac, in File elsewhere.
  const settings = command('Settings…', 'CmdOrCtrl+,', 'settings');
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' }, { type: 'separator' }, settings, { type: 'separator' },
            { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
          ],
        } as MenuItemConstructorOptions]
      : []),
    {
      label: 'File',
      submenu: [
        command('Open Recording…', 'CmdOrCtrl+O', 'open'),
        { label: 'Open Recent', submenu: recentMenu() },
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, settings]),
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
  await loadPreferences();
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
