import { DEFAULT_LEVEL_OPTIONS, type LevelOptions } from '../../gain-curve.ts';
import { level } from '../../level.ts';
import { HOP_SECONDS, integratedLoudness } from '../../loudness.ts';
import type { Measurement } from '../../master.ts';
import type { Api } from '../api.ts';
import { clock, drawDetail, drawOverview, GUTTER, type Detail, type Region } from './draw.ts';
import { Player } from './player.ts';

declare global {
  interface Window {
    api: Api;
  }
}
const api = window.api;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const overview = $<HTMLCanvasElement>('overview');
const detailCanvas = $<HTMLCanvasElement>('detail');

const MIN_REGION_BLOCKS = Math.round(10 / HOP_SECONDS);
const DEFAULT_CEILING_DB = -1;

interface Recording {
  path: string;
  name: string;
  measured: Measurement;
}

let recording: Recording | null = null;
let region: Region = { start: 0, end: 0 };
let options: LevelOptions = { ...DEFAULT_LEVEL_OPTIONS };
let ceilingDb = DEFAULT_CEILING_DB;
let detail: Detail | null = null;
let hoverX: number | null = null;
let busy = false;

const player = new Player(location.search.includes('silent'));
/** Whether playback is heard with the levelling applied or as recorded. */
let hearLevelled = true;

const db = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
const lufs = (value: number) => `${value.toFixed(1)} LUFS`;

// ---------------------------------------------------------------------------
// Levelling and drawing

let recomputeQueued = false;
let drawQueued = false;

function scheduleRecompute() {
  if (recomputeQueued) return;
  recomputeQueued = true;
  requestAnimationFrame(() => {
    recomputeQueued = false;
    recompute();
  });
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (!recording) return;
    const playhead = player.audio.currentTime / HOP_SECONDS;
    drawOverview(overview, recording.measured.peaks, region, playhead);
    if (detail) drawDetail(detailCanvas, detail, hoverX, playhead - region.start);
  });
}

/** Re-derives the gain curve for the current region and settings, and everything shown from it. */
function recompute() {
  if (!recording) return;
  const { measured } = recording;
  const { start, end } = region;
  const shortTerm = measured.shortTerm.subarray(start, end);
  const restShortTerm = measured.restShortTerm.subarray(start, end);
  const peaksIn = measured.peaks.subarray(start, end);
  const blocksIn = measured.blocks.subarray(start, end);
  const n = end - start;

  let levelling;
  try {
    levelling = level(
      {
        shortTerm,
        lowShortTerm: measured.lowShortTerm.subarray(start, end),
        restShortTerm,
      },
      options,
    );
  } catch (error) {
    detail = null;
    $('readout').textContent = error instanceof Error ? error.message : String(error);
    setStats(null);
    scheduleDraw();
    return;
  }

  const { gainDb, targetLufs } = levelling;
  const bassDb = options.bassCorrection > 0 ? levelling.bassDb : null;
  const ceiling = Math.pow(10, ceilingDb / 20);
  const peaksOut = new Float32Array(n);
  const loudnessOut = new Float32Array(n);
  const blocksOut = new Float64Array(n);
  let minGain = Infinity;
  let maxGain = -Infinity;
  let limitedBlocks = 0;
  let deepestLimit = 0;
  for (let i = 0; i < n; i++) {
    const g = gainDb[i];
    const linear = Math.pow(10, g / 20);
    // Bass carries much of the peak level, so count half of its change as an estimate.
    peaksOut[i] = peaksIn[i] * linear * Math.pow(10, (bassDb?.[i] ?? 0) / 40);
    // The bass shelf only moves the share of the loudness that sits in the low band.
    let shelved = 0;
    if (bassDb && bassDb[i] !== 0) {
      const lowShare = Math.max(0, 1 - Math.pow(10, (restShortTerm[i] - shortTerm[i]) / 10));
      shelved = 10 * Math.log10(1 + lowShare * (Math.pow(10, bassDb[i] / 10) - 1));
    }
    loudnessOut[i] = shortTerm[i] + g + shelved;
    blocksOut[i] = blocksIn[i] * linear * linear * Math.pow(10, shelved / 10);
    minGain = Math.min(minGain, g);
    maxGain = Math.max(maxGain, g);
    if (peaksOut[i] > ceiling) {
      limitedBlocks++;
      deepestLimit = Math.max(deepestLimit, 20 * Math.log10(peaksOut[i] / ceiling));
    }
  }

  detail = { startBlock: start, peaksIn, peaksOut, loudnessIn: shortTerm, loudnessOut, gainDb, bassDb, targetLufs, ceiling };
  setStats({
    loudnessIn: integratedLoudness(blocksIn),
    loudnessOut: integratedLoudness(blocksOut),
    minGain,
    maxGain,
    limitedShare: limitedBlocks / n,
    deepestLimit,
  });
  if (options.targetLufs === undefined) {
    $('target-value').textContent = `${lufs(targetLufs)} (auto)`;
    $<HTMLInputElement>('target').value = String(Math.round(targetLufs * 2) / 2);
  }
  scheduleDraw();
}

function share(fraction: number): string {
  if (fraction < 0.001) return 'under 0.1%';
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;
}

interface Stats {
  loudnessIn: number;
  loudnessOut: number;
  minGain: number;
  maxGain: number;
  limitedShare: number;
  deepestLimit: number;
}

function setStats(stats: Stats | null) {
  $('stat-in').textContent = stats ? lufs(stats.loudnessIn) : '–';
  $('stat-out').textContent = stats ? lufs(stats.loudnessOut) : '–';
  $('stat-gain').textContent = stats ? `${db(stats.minGain)} to ${db(stats.maxGain)}` : '–';
  let limiter = '–';
  if (stats) {
    limiter =
      stats.limitedShare === 0
        ? 'not needed'
        : `up to ${stats.deepestLimit.toFixed(1)} dB on ${share(stats.limitedShare)}`;
  }
  $('stat-limiter').textContent = limiter;
}

// ---------------------------------------------------------------------------
// Region selection

function parseTime(text: string): number | null {
  const parts = text.trim().split(':').map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function setRegion(start: number, end: number) {
  if (!recording) return;
  const total = recording.measured.peaks.length;
  const minimum = Math.min(MIN_REGION_BLOCKS, total);
  start = Math.max(0, Math.min(total - minimum, Math.round(start)));
  end = Math.max(start + minimum, Math.min(total, Math.round(end)));
  region = { start, end };
  $<HTMLInputElement>('region-start').value = clock(start * HOP_SECONDS);
  $<HTMLInputElement>('region-end').value = clock(end * HOP_SECONDS);
  $('region-length').textContent = clock((end - start) * HOP_SECONDS);
  scheduleDraw();
  scheduleRecompute();
}

type Drag = { kind: 'start' | 'end' } | { kind: 'move'; offset: number } | { kind: 'new'; anchor: number };
let drag: Drag | null = null;
/** Whether the pointer has moved since the press, which tells a drag from a click. */
let dragged = false;
const HANDLE_PX = 6;

function overviewBlock(event: MouseEvent): number {
  const rect = overview.getBoundingClientRect();
  const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return fraction * recording!.measured.peaks.length;
}

/** What a press at this position would grab. */
function hit(event: MouseEvent): Drag['kind'] {
  const rect = overview.getBoundingClientRect();
  const total = recording!.measured.peaks.length;
  const x = event.clientX - rect.left;
  const x0 = (region.start / total) * rect.width;
  const x1 = (region.end / total) * rect.width;
  if (Math.abs(x - x0) <= HANDLE_PX) return 'start';
  if (Math.abs(x - x1) <= HANDLE_PX) return 'end';
  return x > x0 && x < x1 ? 'move' : 'new';
}

overview.addEventListener('mousedown', (event) => {
  if (!recording || busy) return;
  const block = overviewBlock(event);
  const kind = hit(event);
  if (kind === 'move') drag = { kind, offset: block - region.start };
  else if (kind === 'new') drag = { kind, anchor: block };
  else drag = { kind };
  dragged = false;
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!recording) return;
  if (!drag) {
    if (event.target === overview) {
      const kind = hit(event);
      overview.style.cursor = kind === 'move' ? 'grab' : kind === 'new' ? 'crosshair' : 'ew-resize';
    }
    return;
  }
  dragged = true;
  const block = overviewBlock(event);
  if (drag.kind === 'start') setRegion(Math.min(block, region.end - MIN_REGION_BLOCKS), region.end);
  else if (drag.kind === 'end') setRegion(region.start, Math.max(block, region.start + MIN_REGION_BLOCKS));
  else if (drag.kind === 'move') {
    const length = region.end - region.start;
    const start = Math.max(0, Math.min(recording.measured.peaks.length - length, block - drag.offset));
    setRegion(start, start + length);
  } else if (drag.kind === 'new' && Math.abs(block - drag.anchor) >= MIN_REGION_BLOCKS) {
    setRegion(Math.min(block, drag.anchor), Math.max(block, drag.anchor));
  }
});

window.addEventListener('mouseup', (event) => {
  // A plain click inside the mix moves the playhead there.
  if (drag?.kind === 'move' && !dragged) seek(overviewBlock(event) * HOP_SECONDS);
  drag = null;
});

for (const id of ['region-start', 'region-end']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const start = parseTime($<HTMLInputElement>('region-start').value);
    const end = parseTime($<HTMLInputElement>('region-end').value);
    if (start === null || end === null || end <= start) setRegion(region.start, region.end);
    else setRegion(start / HOP_SECONDS, end / HOP_SECONDS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
}

$('select-all').addEventListener('click', () => {
  if (recording) setRegion(0, recording.measured.peaks.length);
});

// ---------------------------------------------------------------------------
// Readout under the detail view

detailCanvas.addEventListener('mousemove', (event) => {
  const rect = detailCanvas.getBoundingClientRect();
  hoverX = event.clientX - rect.left;
  if (detail && hoverX >= GUTTER) {
    const n = detail.gainDb.length;
    const i = Math.min(n - 1, Math.floor(((hoverX - GUTTER) / (rect.width - GUTTER)) * n));
    $('readout').textContent =
      `${clock((detail.startBlock + i) * HOP_SECONDS)}    original ${lufs(detail.loudnessIn[i])}` +
      `    gain ${db(detail.gainDb[i])}${detail.bassDb ? `    bass ${db(detail.bassDb[i])}` : ''}` +
      `    levelled ${lufs(detail.loudnessOut[i])}`;
  }
  scheduleDraw();
});

detailCanvas.addEventListener('mouseleave', () => {
  hoverX = null;
  $('readout').textContent = ' ';
  scheduleDraw();
});

detailCanvas.addEventListener('click', (event) => {
  const rect = detailCanvas.getBoundingClientRect();
  const fraction = (event.clientX - rect.left - GUTTER) / (rect.width - GUTTER);
  if (fraction >= 0) seek((region.start + fraction * (region.end - region.start)) * HOP_SECONDS);
});

// ---------------------------------------------------------------------------
// Live preview

/** Value in dB of a per-block curve of the mix at a time in the recording. */
function curveAt(curve: Float32Array, seconds: number): number {
  // Each value sits at the centre of its block, as in the export.
  const position = Math.max(0, Math.min(curve.length - 1, seconds / HOP_SECONDS - region.start - 0.5));
  const i = Math.min(curve.length - 2, Math.floor(position));
  return i < 0 ? curve[0] : curve[i] + (curve[i + 1] - curve[i]) * (position - i);
}

/** Linear gain the levelling applies at a time in the recording. */
function gainAt(seconds: number): number {
  return detail ? Math.pow(10, curveAt(detail.gainDb, seconds) / 20) : 1;
}

function bassAt(seconds: number): number {
  return detail?.bassDb ? curveAt(detail.bassDb, seconds) : 0;
}

function seek(seconds: number) {
  if (!recording) return;
  player.audio.currentTime = seconds;
  showPlayback();
}

function showPlayback() {
  $('play-time').textContent = clock(player.audio.currentTime);
  scheduleDraw();
}

/** Keeps the sound and the playhead in step with the audio while it plays. */
function follow() {
  if (!recording || player.audio.paused) return;
  const time = player.audio.currentTime;
  if (time >= region.end * HOP_SECONDS) {
    // Playback covers the marked mix only.
    player.audio.pause();
    player.audio.currentTime = region.start * HOP_SECONDS;
  } else if (time < region.start * HOP_SECONDS) {
    player.audio.currentTime = region.start * HOP_SECONDS;
  }
  player.apply(hearLevelled ? gainAt(time) : 1, hearLevelled ? bassAt(time) : 0, { ceilingDb, bypass: !hearLevelled });
  showPlayback();
  requestAnimationFrame(follow);
}

async function togglePlay() {
  if (!recording || busy) return;
  if (!player.audio.paused) {
    player.audio.pause();
    return;
  }
  const time = player.audio.currentTime;
  if (time < region.start * HOP_SECONDS || time >= region.end * HOP_SECONDS - 0.5) {
    player.audio.currentTime = region.start * HOP_SECONDS;
  }
  try {
    await player.play();
  } catch (error) {
    $('meter').textContent = `Cannot play this recording here (${error instanceof Error ? error.message : error}). Export still works.`;
  }
}

function setHearLevelled(levelled: boolean) {
  hearLevelled = levelled;
  $('hear-levelled').classList.toggle('on', levelled);
  $('hear-original').classList.toggle('on', !levelled);
}

player.audio.addEventListener('play', () => {
  $('play').textContent = 'Pause';
  follow();
});
player.audio.addEventListener('pause', () => {
  $('play').textContent = 'Play';
  $('meter').textContent = '';
  showPlayback();
});
player.audio.addEventListener('seeked', showPlayback);

// Hold the readings briefly so the numbers can be read.
let held = { peak: 0, gain: 1, since: 0 };
player.onReport = ({ peak, gain }) => {
  if (player.audio.paused) return;
  const now = performance.now();
  if (now - held.since > 600) held = { peak: 0, gain: 1, since: now };
  held.peak = Math.max(held.peak, peak);
  held.gain = Math.min(held.gain, gain);
  const peakDb = 20 * Math.log10(Math.max(held.peak, 1e-6));
  const limiting = -20 * Math.log10(held.gain);
  $('meter').textContent =
    `gain ${hearLevelled ? db(20 * Math.log10(gainAt(player.audio.currentTime))) : 'off'}` +
    (hearLevelled && detail?.bassDb ? `    bass ${db(bassAt(player.audio.currentTime))}` : '') +
    `    peak ${peakDb.toFixed(1)} dBFS    limiter ${limiting < 0.05 ? 'idle' : `-${limiting.toFixed(1)} dB`}`;
};

$('play').addEventListener('click', togglePlay);
$('hear-original').addEventListener('click', () => setHearLevelled(false));
$('hear-levelled').addEventListener('click', () => setHearLevelled(true));

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'text') return;
  if (event.code === 'Space') {
    event.preventDefault();
    // Otherwise a focused button would also act on the same key press.
    if (event.target instanceof HTMLButtonElement) event.target.blur();
    togglePlay();
  } else if (event.code === 'KeyA' && !event.metaKey && !event.ctrlKey) {
    setHearLevelled(!hearLevelled);
  }
});

// ---------------------------------------------------------------------------
// Settings

interface Slider {
  id: string;
  get: () => number;
  set: (value: number) => void;
  format: (value: number) => string;
}

const sliders: Slider[] = [
  {
    id: 'window',
    get: () => options.windowSeconds,
    set: (v) => (options.windowSeconds = v),
    // Dips up to this share of the window are filled in; see fullEnergyEnvelope.
    format: (v) => `up to ${Math.round(v * options.percentile)} s`,
  },
  { id: 'smooth', get: () => options.smoothSeconds, set: (v) => (options.smoothSeconds = v), format: (v) => `${v * 2} s` },
  { id: 'bass', get: () => options.bassCorrection, set: (v) => (options.bassCorrection = v), format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`) },
  { id: 'bass-max', get: () => options.maxBassDb, set: (v) => (options.maxBassDb = v), format: (v) => `±${v.toFixed(1)} dB` },
  { id: 'boost', get: () => options.maxBoostDb, set: (v) => (options.maxBoostDb = v), format: (v) => db(v) },
  { id: 'cut', get: () => options.maxCutDb, set: (v) => (options.maxCutDb = v), format: (v) => db(-v) },
  { id: 'ceiling', get: () => ceilingDb, set: (v) => (ceilingDb = v), format: (v) => `${v.toFixed(1)} dBFS` },
];

function syncControls() {
  for (const slider of sliders) {
    $<HTMLInputElement>(slider.id).value = String(slider.get());
    $(`${slider.id}-value`).textContent = slider.format(slider.get());
  }
  const auto = options.targetLufs === undefined;
  $<HTMLInputElement>('target-auto').checked = auto;
  $<HTMLInputElement>('target').disabled = auto;
  if (!auto) {
    $<HTMLInputElement>('target').value = String(options.targetLufs);
    $('target-value').textContent = lufs(options.targetLufs!);
  }
}

for (const slider of sliders) {
  $<HTMLInputElement>(slider.id).addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    slider.set(value);
    $(`${slider.id}-value`).textContent = slider.format(value);
    scheduleRecompute();
  });
}

$<HTMLInputElement>('target').addEventListener('input', (event) => {
  options.targetLufs = Number((event.target as HTMLInputElement).value);
  $('target-value').textContent = lufs(options.targetLufs);
  scheduleRecompute();
});

$<HTMLInputElement>('target-auto').addEventListener('change', (event) => {
  const auto = (event.target as HTMLInputElement).checked;
  // Leaving auto starts from the level the mix already has.
  options.targetLufs = auto ? undefined : Number($<HTMLInputElement>('target').value);
  syncControls();
  scheduleRecompute();
});

$('reset').addEventListener('click', () => {
  options = { ...DEFAULT_LEVEL_OPTIONS };
  ceilingDb = DEFAULT_CEILING_DB;
  syncControls();
  scheduleRecompute();
});

// ---------------------------------------------------------------------------
// Opening and exporting

function setBusy(label: string | null) {
  busy = label !== null;
  $('progress').hidden = !busy;
  $('progress-label').textContent = label ?? '';
  $('progress-bar').style.width = '0';
  $<HTMLButtonElement>('open').disabled = busy;
  $<HTMLButtonElement>('export').disabled = busy || !recording;
  $<HTMLButtonElement>('play').disabled = busy || !recording;
}

let progressLabel = '';
api.onProgress((fraction) => {
  $('progress-bar').style.width = `${(fraction * 100).toFixed(1)}%`;
  $('progress-label').textContent = `${progressLabel} ${Math.floor(fraction * 100)}%`;
});

async function open(path: string) {
  if (busy) return;
  const name = path.split(/[\\/]/).pop()!;
  progressLabel = `Analysing ${name}`;
  setBusy(progressLabel);
  $('export-status').textContent = '';
  try {
    const measured = await api.measure(path);
    if (measured.peaks.length === 0) throw new Error('The recording is too short to analyse');
    recording = { path, name, measured };
    player.load(await api.mediaUrl(path));
    $('file-name').textContent = name;
    $('file-name').classList.add('loaded');
    $('empty').hidden = true;
    $('views').hidden = false;
    setRegion(0, measured.peaks.length);
    requestAnimationFrame(() => requestAnimationFrame(() => api.painted()));
  } catch (error) {
    $('export-status').textContent = `Could not open ${name}: ${error instanceof Error ? error.message : error}`;
  } finally {
    setBusy(null);
  }
}

$('open').addEventListener('click', async () => {
  const path = await api.pickFile();
  if (path) open(path);
});

async function exportMix() {
  if (!recording || !detail || busy) return;
  player.audio.pause();
  const base = recording.path.replace(/\.[^./\\]+$/, '');
  const output = await api.pickOutput(`${base} mastered.wav`);
  if (!output) return;
  const status = $('export-status');
  status.textContent = '';
  progressLabel = 'Exporting';
  setBusy(progressLabel);
  try {
    const result = await api.render({
      input: recording.path,
      output,
      start: region.start * HOP_SECONDS,
      end: region.end * HOP_SECONDS,
      gainDb: detail.gainDb,
      bassDb: detail.bassDb ?? new Float32Array(detail.gainDb.length),
      ceilingDb,
    });
    const peakDb = 20 * Math.log10(Math.max(result.peak, 1e-9));
    status.textContent = `Exported at ${lufs(result.integratedLufs)}, peak ${peakDb.toFixed(1)} dBFS. `;
    const link = document.createElement('a');
    link.textContent = 'Show in Finder';
    link.addEventListener('click', () => api.reveal(output));
    status.append(link);
  } catch (error) {
    status.textContent = `Export failed: ${error instanceof Error ? error.message : error}`;
  } finally {
    setBusy(null);
  }
}

$('export').addEventListener('click', exportMix);

// Dropping a file anywhere on the window opens it.
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  $('empty').classList.add('dragging');
});
window.addEventListener('dragleave', () => $('empty').classList.remove('dragging'));
window.addEventListener('drop', (event) => {
  event.preventDefault();
  $('empty').classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) open(api.pathForFile(file));
});

new ResizeObserver(scheduleDraw).observe(detailCanvas);
new ResizeObserver(scheduleDraw).observe(overview);

syncControls();
api.initialFile().then((path) => {
  if (path) open(path);
});
