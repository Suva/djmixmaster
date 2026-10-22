// Runs the Record view's input and its recordings. The input is captured in a
// hidden page (capture.ts) as soon as a device is chosen, so that its level
// can be set before anything is written: that is monitoring. Recording hands
// the same samples to an ffmpeg process that writes the parts (see
// recording.ts). A lock file says a recording is being made, so that the next
// start of the app finds one a crash cut short.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, probe } from '../audio-io.ts';
import {
  bytesPerSecond, isPartOf, measureStereo, packArgs, PART_SECONDS, repairWav, stereoOf, wavFinished, writerArgs,
  type Levels, type RecordInput, type RecordPlan,
} from './recording.ts';

export interface RecordStatus {
  /**
   * Nothing open; an input open for its level only; recording it; stopping,
   * while the last part is finished and packed; or a recording stopped by a
   * crash, whose parts are waiting to be opened.
   */
  state: 'idle' | 'monitoring' | 'recording' | 'stopping' | 'interrupted';
  /** The input open, and what it gives. */
  device?: string;
  input?: RecordInput;
  plan?: RecordPlan;
  /** How long it has been recording. */
  seconds: number;
  /** What has been written, and in how many parts. */
  bytes: number;
  parts: number;
  /** Room left on the drive, and how long that lasts at this rate; null where it cannot be told. */
  freeBytes: number | null;
  secondsLeft: number | null;
  /** Whether the parts are being packed into FLAC, after the recording has stopped. */
  packing?: boolean;
  /** Something to know about: no sound coming in, or why the recording stopped. */
  problem?: string;
  /** The parts of an interrupted recording. */
  files?: string[];
}

/** What opens an input and closes it again: the hidden capture page. */
export interface Capture {
  start(device: string): Promise<RecordInput>;
  stop(): Promise<void>;
}

/** What a recording's lock file says. */
interface Lock {
  pid: number;
  plan: RecordPlan;
  input: RecordInput;
  started: number;
}

/** The meters are sent this often, in milliseconds. */
const LEVELS_EVERY_MS = 100;
/** The status, with the files' sizes and the drive's room, this often. */
const STATUS_EVERY_MS = 1000;
/** An input that sends no sound for this long has stopped working. */
const SILENT_INPUT_MS = 3000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs ffmpeg to its end. */
function run(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((done) => {
    const child = spawn(ffmpeg(), args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
    child.on('error', () => done());
  });
}

const IDLE: RecordStatus = { state: 'idle', seconds: 0, bytes: 0, parts: 0, freeBytes: null, secondsLeft: null };

export class Recorder {
  readonly #lockFile: string;
  readonly #logFile: string;
  readonly #partSeconds: number;
  readonly #capture: Capture;
  readonly #send: (channel: 'record-status' | 'record-levels', value: unknown) => void;
  readonly #awake: { start(): number; stop(id: number): void };

  #status: RecordStatus = IDLE;
  /** The input open, and which two of its channels are left and right. */
  #device: string | null = null;
  #input: RecordInput | null = null;
  #channels: [number, number] = [0, 1];
  #lock: Lock | null = null;
  #writer: ChildProcess | null = null;
  #frames = 0;
  #gathered: Levels = { peak: [0, 0], meanSquare: [0, 0], frames: 0 };
  #lastSound = 0;
  #timers: ReturnType<typeof setInterval>[] = [];
  #awakeId: number | null = null;
  /** Parts being packed into FLAC, one after another, and those handed over to be. */
  #packing: Promise<void> = Promise.resolve();
  #queued = new Set<string>();

  constructor(options: {
    folder: string;
    partSeconds?: number;
    capture: Capture;
    send: (channel: 'record-status' | 'record-levels', value: unknown) => void;
    awake: { start(): number; stop(id: number): void };
  }) {
    this.#lockFile = join(options.folder, 'recording.json');
    this.#logFile = join(options.folder, 'recording.log');
    this.#partSeconds = options.partSeconds ?? PART_SECONDS;
    this.#capture = options.capture;
    this.#send = options.send;
    this.#awake = options.awake;
  }

  get status(): RecordStatus {
    return this.#status;
  }

  get recording(): boolean {
    return this.#status.state === 'recording' || this.#status.state === 'stopping';
  }

  /** Opens an input for its level, closing the one open before; null closes it. Not while recording. */
  async monitor(device: string | null): Promise<RecordStatus> {
    if (this.recording) throw new Error('A recording is running.');
    if (device === this.#device && this.#input) return this.#status;
    await this.#capture.stop();
    this.#device = null;
    this.#input = null;
    this.#stopTimers();
    if (!device) return this.#set(this.#status.state === 'interrupted' ? { ...this.#status, device: undefined, input: undefined } : { ...IDLE });
    try {
      this.#input = await this.#capture.start(device);
    } catch (error) {
      this.#set({ ...IDLE });
      throw error;
    }
    this.#device = device;
    this.#lastSound = Date.now();
    this.#timers.push(setInterval(() => this.#sendLevels(), LEVELS_EVERY_MS));
    this.#timers.push(setInterval(() => void this.#update(), STATUS_EVERY_MS));
    // A recording a crash cut short is still offered while the input is listened to.
    if (this.#status.state === 'interrupted') return this.#set({ ...this.#status, device, input: this.#input });
    return this.#set({ ...IDLE, state: 'monitoring', device, input: this.#input });
  }

  /** Which two of the input's channels are heard, and recorded, as left and right. */
  setChannels(channels: [number, number]) {
    if (!this.recording) this.#channels = channels;
  }

  /** What the capture page sends: the input's samples, its channels interleaved. */
  samples(samples: Float32Array) {
    if (!this.#input) return;
    const stereo = stereoOf(samples, this.#input.channels, this.#channels);
    const levels = measureStereo(stereo);
    const g = this.#gathered;
    const total = g.frames + levels.frames;
    if (total === 0) return;
    for (const c of [0, 1]) {
      g.peak[c] = Math.max(g.peak[c], levels.peak[c]);
      g.meanSquare[c] = (g.meanSquare[c] * g.frames + levels.meanSquare[c] * levels.frames) / total;
    }
    g.frames = total;
    this.#lastSound = Date.now();
    if (this.#writer && this.#status.state === 'recording') {
      this.#writer.stdin!.write(Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength));
      this.#frames += levels.frames;
    }
  }

  /** The input went away: unplugged, or taken by the system. A recording ends there, with what it has. */
  async inputEnded(reason: string) {
    const lock = this.#lock;
    const wasRecording = this.recording;
    if (wasRecording) await this.#endWriter();
    const files = wasRecording && lock ? await this.#finish(lock) : [];
    await this.#capture.stop();
    this.#device = null;
    this.#input = null;
    this.#stopTimers();
    if (wasRecording) {
      this.#set({ ...IDLE, state: files.length ? 'interrupted' : 'idle', files, plan: lock?.plan, problem: `${reason} The recording stopped there; what was recorded until then is kept.` });
    } else {
      this.#set({ ...IDLE, problem: reason });
    }
  }

  async start(plan: RecordPlan): Promise<RecordStatus> {
    if (this.recording) throw new Error('A recording is running already.');
    this.#channels = plan.channels;
    await this.monitor(plan.device);
    const input = this.#input!;
    const taken = (await readdir(plan.folder).catch(() => [] as string[])).some((file) => isPartOf(file, plan));
    if (taken) throw new Error(`There is a recording called “${plan.name}” in that folder already.`);
    const log = openSync(this.#logFile, 'w');
    let writer: ChildProcess;
    try {
      writer = spawn(ffmpeg(), writerArgs(plan, input.sampleRate, this.#partSeconds), { stdio: ['pipe', 'ignore', log] });
    } finally {
      closeSync(log);
    }
    writer.stdin!.on('error', () => {});
    this.#writer = writer;
    this.#frames = 0;
    this.#lock = { pid: writer.pid!, plan, input, started: Date.now() };
    await writeFile(this.#lockFile, JSON.stringify(this.#lock));
    this.#awakeId = this.#awake.start();
    writer.on('exit', () => {
      this.#writer = null;
      // Ended without being asked to: the drive is full, or ffmpeg failed.
      if (this.#status.state === 'recording' && this.#lock) void this.#writerFailed(this.#lock);
    });
    this.#set({ ...this.#status, state: 'recording', plan, problem: undefined });
    void this.#update();
    return this.#status;
  }

  /** Stops the recording, and gives its parts in order, each put right to be read. The input stays open. */
  async stop(): Promise<string[]> {
    const lock = this.#lock;
    if (!lock || this.#status.state !== 'recording') return [];
    this.#set({ ...this.#status, state: 'stopping' });
    await this.#endWriter();
    const files = await this.#finish(lock);
    this.#set(this.#monitoring());
    return files;
  }

  /** Closes the input, unless a recording needs it. */
  async close() {
    if (!this.recording) await this.monitor(null);
  }

  /**
   * At the start of the app: a recording the last run left. Its ffmpeg has
   * ended with the app, as its stdin closed; should it still be going, it is
   * ended. Its parts are put right and offered to be opened.
   */
  async adopt(): Promise<RecordStatus> {
    const lock = await readFile(this.#lockFile, 'utf8').then((text) => JSON.parse(text) as Lock, () => null);
    if (!lock || typeof lock.pid !== 'number' || !lock.plan) return this.#status;
    if (alive(lock.pid)) {
      try {
        process.kill(lock.pid, 'SIGKILL');
      } catch {
        // Gone by now.
      }
    }
    const files = await this.#finish(lock);
    return this.#set({ ...IDLE, state: files.length ? 'interrupted' : 'idle', files, plan: lock.plan, problem: 'The app was closed while recording, and the recording stopped with it.' });
  }

  /** Forgets an interrupted recording, once it has been opened or put aside. */
  dismiss() {
    if (this.#status.state === 'interrupted') this.#set(this.#monitoring());
  }

  /** The status of the input open for its level, or of nothing open. */
  #monitoring(): RecordStatus {
    return this.#input && this.#device ? { ...IDLE, state: 'monitoring', device: this.#device, input: this.#input } : { ...IDLE };
  }

  #set(status: RecordStatus): RecordStatus {
    this.#status = status;
    this.#send('record-status', status);
    return status;
  }

  /** Lets ffmpeg finish: its stdin closed, it writes out the part it is on. */
  async #endWriter() {
    const writer = this.#writer;
    if (!writer) return;
    const ended = new Promise((done) => writer.once('exit', done));
    writer.stdin!.end();
    const timer = setTimeout(() => writer.kill('SIGKILL'), 15_000);
    await ended;
    clearTimeout(timer);
  }

  async #writerFailed(lock: Lock) {
    const log = await readFile(this.#logFile, 'utf8').catch(() => '');
    const said = log.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
    const files = await this.#finish(lock);
    this.#set({
      ...this.#monitoring(), ...(files.length ? { state: 'interrupted' as const, files, plan: lock.plan } : {}),
      problem: `The recording stopped by itself${said ? `: ${said}` : ''}. What was recorded until then is kept.`,
    });
  }

  #sendLevels() {
    const g = this.#gathered;
    if (g.frames === 0) return;
    this.#send('record-levels', { peak: g.peak, meanSquare: g.meanSquare, frames: g.frames } satisfies Levels);
    this.#gathered = { peak: [0, 0], meanSquare: [0, 0], frames: 0 };
  }

  async #update() {
    const state = this.#status.state;
    if (state !== 'monitoring' && state !== 'recording') return;
    const quiet = Date.now() - this.#lastSound > SILENT_INPUT_MS;
    const problem = quiet ? `No sound has come from “${this.#device}” for ${Math.round((Date.now() - this.#lastSound) / 1000)} seconds. Is it still connected?` : undefined;
    const lock = this.#lock;
    if (state === 'monitoring' || !lock) {
      if (problem !== this.#status.problem) this.#set({ ...this.#status, problem });
      return;
    }
    const { plan, input } = lock;
    const files = await this.#parts(plan);
    // Every part but the one being written is finished, and packed into FLAC if that is what was asked for.
    if (plan.format === 'flac') {
      for (const file of files.filter((f) => f.endsWith('.wav')).slice(0, -1)) if (wavFinished(file)) this.#pack(file);
    }
    const sizes = await Promise.all(files.map((file) => stat(file).then((s) => s.size, () => 0)));
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
    const room = await statfs(plan.folder).then((s) => s.bavail * s.bsize, () => null);
    if (this.#status.state !== 'recording') return;
    this.#set({
      ...this.#status, seconds: this.#frames / input.sampleRate, bytes, parts: files.length, freeBytes: room,
      secondsLeft: room === null ? null : room / bytesPerSecond(input.sampleRate, plan.format),
      problem,
    });
  }

  async #parts(plan: RecordPlan): Promise<string[]> {
    const names = await readdir(plan.folder).catch(() => [] as string[]);
    return names.filter((name) => isPartOf(name, plan)).sort().map((name) => join(plan.folder, name));
  }

  /**
   * Packs a finished part into FLAC, after those before it. The WAV goes only
   * once the FLAC holds as much sound; one that does not is left as WAV, and
   * a crash on the way leaves the WAV and a half-written file that is ignored.
   */
  #pack(wav: string) {
    if (this.#queued.has(wav)) return;
    this.#queued.add(wav);
    this.#packing = this.#packing.then(async () => {
      const flac = wav.replace(/\.wav$/, '.flac');
      const packing = wav.replace(/\.wav$/, '.packing');
      await run(packArgs(wav, packing), 10 * 60_000);
      const [was, now] = await Promise.all([probe(wav).catch(() => null), probe(packing).catch(() => null)]);
      if (was && now && Math.abs(was.duration - now.duration) < 0.05) {
        await rename(packing, flac);
        await rm(wav, { force: true });
      } else {
        // Tried again next time round, and once more as the recording ends.
        await rm(packing, { force: true });
        this.#queued.delete(wav);
      }
    });
  }

  /**
   * After a recording: its parts, each with its header put right and packed
   * into FLAC if that was asked for, and the lock let go. Packing takes a few
   * seconds a part, so there may be a wait for those not done yet.
   */
  async #finish(lock: Lock): Promise<string[]> {
    const { plan } = lock;
    const names = await readdir(plan.folder).catch(() => [] as string[]);
    for (const name of names) {
      // Left by a crash while packing: the part is still there as WAV.
      if (name.startsWith(`${plan.name} part `) && name.endsWith('.packing')) await rm(join(plan.folder, name), { force: true });
    }
    let files = await this.#parts(plan);
    for (const file of files) if (file.endsWith('.wav')) repairWav(file);
    let problem: string | undefined;
    if (plan.format === 'flac') {
      this.#set({ ...this.#status, state: 'stopping', packing: true });
      // Twice over: a part that would not pack while recording, as it was not finished yet, is done after.
      for (let round = 0; round < 2; round++) {
        await this.#packing;
        files = await this.#parts(plan);
        for (const file of files) {
          // Packed already, but the WAV not yet taken away: the FLAC was checked before it was named so.
          if (file.endsWith('.wav') && files.includes(file.replace(/\.wav$/, '.flac'))) await rm(file, { force: true });
          else if (file.endsWith('.wav')) this.#pack(file);
        }
      }
      await this.#packing;
      files = await this.#parts(plan);
      // A part that could not be packed would keep the recording from opening as one: say so.
      const unpacked = files.filter((file) => file.endsWith('.wav')).length;
      if (unpacked) problem = `${unpacked === 1 ? 'One part' : `${unpacked} parts`} could not be packed into FLAC and ${unpacked === 1 ? 'is' : 'are'} kept as WAV.`;
    }
    this.#queued.clear();
    await rm(this.#lockFile, { force: true });
    if (this.#awakeId !== null) this.#awake.stop(this.#awakeId);
    this.#awakeId = null;
    this.#lock = null;
    if (problem) this.#set({ ...this.#status, problem });
    return files;
  }

  #stopTimers() {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
  }
}
