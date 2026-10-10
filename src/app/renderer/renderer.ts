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
/** Closest zoom of the detail view. */
const MIN_VIEW_BLOCKS = Math.round(10 / HOP_SECONDS);
const DEFAULT_CEILING_DB = -1;
/** Closest zoom of the recording overview. */
const MIN_OVERVIEW_BLOCKS = Math.round(120 / HOP_SECONDS);

interface Recording {
  path: string;
  name: string;
  measured: Measurement;
  /** Average level per block for the waveform displays, linear. */
  body: Float32Array;
}

/** One stretch of the recording that is levelled and exported on its own. */
interface Mix {
  name: string;
  region: Region;
  options: LevelOptions;
  ceilingDb: number;
}

let recording: Recording | null = null;
/** Every marked mix, in the order they occur in the recording. They never overlap. */
let mixes: Mix[] = [];
/** The selected mix: the one the detail view, the settings and playback apply to. */
let mix: Mix = { name: 'Mix 1', region: { start: 0, end: 0 }, options: { ...DEFAULT_LEVEL_OPTIONS }, ceilingDb: DEFAULT_CEILING_DB };
let mixesCreated = 0;
/** Part of the selected mix the detail view shows, in blocks of the recording. */
let view: Region = { start: 0, end: 0 };
/** Part of the recording the overview shows, in blocks. */
let overviewShown: Region = { start: 0, end: 0 };
let detail: Detail | null = null;
let hoverX: number | null = null;
let busy = false;

const player = new Player(location.search.includes('silent'));
/** Whether playback is heard with the levelling applied or as recorded. */
let hearLevelled = true;

const db = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
const lufs = (value: number) => `${value.toFixed(1)} LUFS`;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    drawOverview(overview, { peaks: recording.measured.peaks, body: recording.body }, overviewShown, mixes.map((m) => m.region), mixes.indexOf(mix), view, playhead);
    if (!detail) return;
    // The curves can be one frame behind the region while it is being dragged.
    const length = detail.gainDb.length;
    const shown = {
      start: clamp(view.start - mix.region.start, 0, length - 1),
      end: clamp(view.end - mix.region.start, 1, length),
    };
    drawDetail(detailCanvas, detail, shown, hoverX, playhead - mix.region.start);
  });
}

interface Stats {
  loudnessIn: number;
  loudnessOut: number;
  minGain: number;
  maxGain: number;
  limitedShare: number;
  deepestLimit: number;
}

/** Derives the gain curves of a mix from its region and settings, and everything shown from them. */
function compute(m: Mix): { detail: Detail; stats: Stats } {
  const { measured } = recording!;
  const { start, end } = m.region;
  const shortTerm = measured.shortTerm.subarray(start, end);
  const restShortTerm = measured.restShortTerm.subarray(start, end);
  const peaksIn = measured.peaks.subarray(start, end);
  const blocksIn = measured.blocks.subarray(start, end);
  const n = end - start;

  const levelling = level(
    { shortTerm, lowShortTerm: measured.lowShortTerm.subarray(start, end), restShortTerm },
    m.options,
    { peaks: peaksIn, ceilingDb: m.ceilingDb },
  );
  const { gainDb, targetLufs } = levelling;
  const bassDb = m.options.bassCorrection > 0 ? levelling.bassDb : null;
  const ceiling = Math.pow(10, m.ceilingDb / 20);
  const peaksOut = new Float32Array(n);
  const bodyOut = new Float32Array(n);
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
    bodyOut[i] = Math.sqrt(blocksOut[i] / 2);
    minGain = Math.min(minGain, g);
    maxGain = Math.max(maxGain, g);
    if (peaksOut[i] > ceiling) {
      limitedBlocks++;
      deepestLimit = Math.max(deepestLimit, 20 * Math.log10(peaksOut[i] / ceiling));
    }
  }

  return {
    detail: { startBlock: start, peaksIn, peaksOut, bodyOut, loudnessIn: shortTerm, loudnessOut, gainDb, bassDb, targetLufs, ceiling },
    stats: {
      loudnessIn: integratedLoudness(blocksIn),
      loudnessOut: integratedLoudness(blocksOut),
      minGain,
      maxGain,
      limitedShare: limitedBlocks / n,
      deepestLimit,
    },
  };
}

/** Brings the detail view and the numbers up to date with the selected mix. */
function recompute() {
  if (!recording) return;
  try {
    const computed = compute(mix);
    detail = computed.detail;
    setStats(computed.stats);
    if (mix.options.targetLufs === undefined) {
      $('target-value').textContent = `${lufs(detail.targetLufs)} (auto)`;
      $<HTMLInputElement>('target').value = String(Math.round(detail.targetLufs * 2) / 2);
    }
  } catch (error) {
    detail = null;
    $('readout').textContent = message(error);
    setStats(null);
  }
  scheduleDraw();
}

function share(fraction: number): string {
  if (fraction < 0.001) return 'under 0.1%';
  return `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;
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
// Mixes and their regions

function parseTime(text: string): number | null {
  const parts = text.trim().split(':').map(Number);
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** The free stretch of the recording around `block`, between the neighbouring mixes other than `except`. */
function freeSpace(block: number, except: Mix | null): Region {
  const space = { start: 0, end: recording!.measured.peaks.length };
  for (const other of mixes) {
    if (other === except) continue;
    if (other.region.end <= block) space.start = Math.max(space.start, other.region.end);
    else if (other.region.start >= block) space.end = Math.min(space.end, other.region.start);
  }
  return space;
}

/** Shows the selected mix's name, times and place among the others. */
function showMix() {
  mixes.sort((a, b) => a.region.start - b.region.start);
  const { start, end } = mix.region;
  $<HTMLInputElement>('region-start').value = clock(start * HOP_SECONDS);
  $<HTMLInputElement>('region-end').value = clock(end * HOP_SECONDS);
  $('region-length').textContent = clock((end - start) * HOP_SECONDS);
  const nameInput = $<HTMLInputElement>('mix-name');
  if (document.activeElement !== nameInput) nameInput.value = mix.name;

  const tabs = $('mix-tabs');
  tabs.replaceChildren(
    ...mixes.map((m, index) => {
      const tab = document.createElement('button');
      tab.className = m === mix ? 'mix-tab on' : 'mix-tab';
      const number = document.createElement('b');
      number.textContent = String(index + 1);
      tab.append(number, `${m.name}  ·  ${clock((m.region.end - m.region.start) * HOP_SECONDS)}`);
      tab.addEventListener('click', () => select(m));
      return tab;
    }),
  );
  const several = mixes.length > 1;
  $('settings-for').textContent = several ? `Settings for ${mix.name}` : '';
  $('export-all-group').hidden = !several;
  $('export-all').textContent = `Export all ${mixes.length}…`;
  $<HTMLButtonElement>('delete-mix').disabled = !several;
  scheduleDraw();
}

/** Moves the selected mix, keeping it inside the free space around it. */
function setRegion(start: number, end: number) {
  if (!recording) return;
  const space = freeSpace((mix.region.start + mix.region.end) / 2, mix);
  const minimum = Math.min(MIN_REGION_BLOCKS, space.end - space.start);
  start = clamp(Math.round(start), space.start, space.end - minimum);
  end = clamp(Math.round(end), start + minimum, space.end);
  mix.region = { start, end };
  view = { start, end };
  showMix();
  scheduleRecompute();
}

function select(m: Mix) {
  mix = m;
  view = { ...m.region };
  detail = null;
  syncControls();
  showMix();
  recompute();
}

/** Adds a mix with the settings of the selected one and selects it. */
function addMix(region: Region) {
  mixesCreated++;
  const added: Mix = {
    name: `Mix ${mixesCreated}`,
    region,
    options: { ...mix.options },
    ceilingDb: mix.ceilingDb,
  };
  mixes.push(added);
  select(added);
}

type Drag = { kind: 'start' | 'end' } | { kind: 'move'; offset: number } | { kind: 'new'; anchor: number; added: boolean };
let drag: Drag | null = null;
/** Whether the pointer has moved since the press, which tells a drag from a click. */
let dragged = false;
const HANDLE_PX = 6;

function overviewBlock(event: MouseEvent): number {
  const rect = overview.getBoundingClientRect();
  const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  return overviewShown.start + fraction * (overviewShown.end - overviewShown.start);
}

/** Shows `start` to `end` of the recording in the overview, clamped to the recording and the closest zoom. */
function setOverview(start: number, end: number) {
  const total = recording!.measured.peaks.length;
  const span = clamp(Math.round(end - start), Math.min(MIN_OVERVIEW_BLOCKS, total), total);
  const from = clamp(Math.round(start), 0, total - span);
  overviewShown = { start: from, end: from + span };
  scheduleDraw();
}

function zoomOverview(factor: number, around: number) {
  const span = overviewShown.end - overviewShown.start;
  const anchor = (around - overviewShown.start) / span;
  const zoomed = span * factor;
  setOverview(around - anchor * zoomed, around - anchor * zoomed + zoomed);
}

overview.addEventListener(
  'wheel',
  (event) => {
    if (!recording) return;
    event.preventDefault();
    if (event.ctrlKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      zoomOverview(Math.exp(event.deltaY * (event.ctrlKey ? 0.012 : 0.004)), overviewBlock(event));
    } else {
      const move = (event.deltaX / overview.clientWidth) * (overviewShown.end - overviewShown.start);
      setOverview(overviewShown.start + move, overviewShown.end + move);
    }
  },
  { passive: false },
);

const overviewCentre = () => (overviewShown.start + overviewShown.end) / 2;
$('overview-in').addEventListener('click', () => recording && zoomOverview(0.5, overviewCentre()));
$('overview-out').addEventListener('click', () => recording && zoomOverview(2, overviewCentre()));
$('overview-fit').addEventListener('click', () => recording && setOverview(0, recording.measured.peaks.length));
$('overview-mix').addEventListener('click', () => {
  if (!recording) return;
  // Leave some of the surroundings in sight on both sides.
  const margin = (mix.region.end - mix.region.start) * 0.15;
  setOverview(mix.region.start - margin, mix.region.end + margin);
});

/** What a press at this position would grab, and on which mix. The selected mix wins where two meet. */
function hit(event: MouseEvent): { kind: Drag['kind']; mix: Mix | null } {
  const rect = overview.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const span = overviewShown.end - overviewShown.start;
  const toX = (at: number) => ((at - overviewShown.start) / span) * rect.width;
  const ordered = [mix, ...mixes.filter((m) => m !== mix)];
  for (const m of ordered) {
    if (Math.abs(x - toX(m.region.start)) <= HANDLE_PX) return { kind: 'start', mix: m };
    if (Math.abs(x - toX(m.region.end)) <= HANDLE_PX) return { kind: 'end', mix: m };
  }
  const block = overviewShown.start + (x / rect.width) * span;
  const inside = mixes.find((m) => block > m.region.start && block < m.region.end);
  return inside ? { kind: 'move', mix: inside } : { kind: 'new', mix: null };
}

overview.addEventListener('mousedown', (event) => {
  if (!recording || busy) return;
  const block = overviewBlock(event);
  const grabbed = hit(event);
  if (grabbed.mix && grabbed.mix !== mix) select(grabbed.mix);
  if (grabbed.kind === 'move') drag = { kind: 'move', offset: block - mix.region.start };
  else if (grabbed.kind === 'new') drag = { kind: 'new', anchor: block, added: false };
  else drag = { kind: grabbed.kind };
  dragged = false;
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!recording) return;
  if (!drag) {
    if (event.target === overview) {
      const { kind } = hit(event);
      overview.style.cursor = kind === 'move' ? 'pointer' : kind === 'new' ? 'crosshair' : 'ew-resize';
    }
    return;
  }
  dragged = true;
  const block = overviewBlock(event);
  const { start, end } = mix.region;
  if (drag.kind === 'start') setRegion(Math.min(block, end - MIN_REGION_BLOCKS), end);
  else if (drag.kind === 'end') setRegion(start, Math.max(block, start + MIN_REGION_BLOCKS));
  else if (drag.kind === 'move') {
    const space = freeSpace((start + end) / 2, mix);
    const moved = clamp(block - drag.offset, space.start, space.end - (end - start));
    setRegion(moved, moved + (end - start));
  } else if (drag.kind === 'new') {
    const from = Math.min(block, drag.anchor);
    const to = Math.max(block, drag.anchor);
    if (drag.added) {
      setRegion(from, to);
    } else if (to - from >= MIN_REGION_BLOCKS) {
      // Dragging across free space marks a new mix there.
      const space = freeSpace(drag.anchor, null);
      if (space.end - space.start < MIN_REGION_BLOCKS) return;
      drag.added = true;
      addMix({
        start: Math.round(clamp(from, space.start, space.end - MIN_REGION_BLOCKS)),
        end: Math.round(clamp(to, space.start + MIN_REGION_BLOCKS, space.end)),
      });
    }
  }
});

window.addEventListener('mouseup', (event) => {
  // A plain click inside a mix moves the playhead there.
  if (drag?.kind === 'move' && !dragged) seek(overviewBlock(event) * HOP_SECONDS);
  drag = null;
});

for (const id of ['region-start', 'region-end']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('change', () => {
    const start = parseTime($<HTMLInputElement>('region-start').value);
    const end = parseTime($<HTMLInputElement>('region-end').value);
    if (start === null || end === null || end <= start) showMix();
    else setRegion(start / HOP_SECONDS, end / HOP_SECONDS);
  });
}
for (const id of ['region-start', 'region-end', 'mix-name']) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });
}

$<HTMLInputElement>('mix-name').addEventListener('input', (event) => {
  mix.name = (event.target as HTMLInputElement).value.trim() || 'Untitled mix';
  showMix();
});
$<HTMLInputElement>('mix-name').addEventListener('blur', showMix);

$('select-all').addEventListener('click', () => {
  if (!recording) return;
  const space = freeSpace((mix.region.start + mix.region.end) / 2, mix);
  setRegion(space.start, space.end);
});

$('delete-mix').addEventListener('click', () => {
  if (mixes.length < 2) return;
  const index = mixes.indexOf(mix);
  mixes.splice(index, 1);
  select(mixes[Math.min(index, mixes.length - 1)]);
});

// ---------------------------------------------------------------------------
// Zooming and reading the detail view

/** Shows `start` to `end` of the selected mix, clamped to the mix and the closest zoom. */
function setView(start: number, end: number) {
  const region = mix.region;
  const span = clamp(Math.round(end - start), Math.min(MIN_VIEW_BLOCKS, region.end - region.start), region.end - region.start);
  const from = clamp(Math.round(start), region.start, region.end - span);
  view = { start: from, end: from + span };
  scheduleDraw();
}

/** Zooms by `factor` (below 1 zooms in), keeping `around` where it is on screen. */
function zoom(factor: number, around: number) {
  const span = view.end - view.start;
  const anchor = (around - view.start) / span;
  const zoomed = span * factor;
  setView(around - anchor * zoomed, around - anchor * zoomed + zoomed);
}

/** Block of the recording under a pointer position on the detail view. */
function detailBlock(event: MouseEvent): number | null {
  const rect = detailCanvas.getBoundingClientRect();
  const fraction = (event.clientX - rect.left - GUTTER) / (rect.width - GUTTER);
  return fraction >= 0 && fraction <= 1 ? view.start + fraction * (view.end - view.start) : null;
}

/** Zoom buttons work around the playhead when it is in view, otherwise around the middle. */
function zoomCentre(): number {
  const playhead = player.audio.currentTime / HOP_SECONDS;
  return playhead > view.start && playhead < view.end ? playhead : (view.start + view.end) / 2;
}

detailCanvas.addEventListener(
  'wheel',
  (event) => {
    if (!recording) return;
    event.preventDefault();
    const span = view.end - view.start;
    if (event.ctrlKey || Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
      // Scrolling up or down, or pinching, zooms on the pointer.
      zoom(Math.exp(event.deltaY * (event.ctrlKey ? 0.012 : 0.004)), detailBlock(event) ?? zoomCentre());
    } else {
      const move = (event.deltaX / (detailCanvas.clientWidth - GUTTER)) * span;
      setView(view.start + move, view.end + move);
    }
  },
  { passive: false },
);

$('zoom-in').addEventListener('click', () => zoom(0.5, zoomCentre()));
$('zoom-out').addEventListener('click', () => zoom(2, zoomCentre()));
$('zoom-fit').addEventListener('click', () => setView(mix.region.start, mix.region.end));

detailCanvas.addEventListener('mousemove', (event) => {
  hoverX = event.clientX - detailCanvas.getBoundingClientRect().left;
  const block = detailBlock(event);
  if (detail && block !== null) {
    const i = clamp(Math.floor(block - mix.region.start), 0, detail.gainDb.length - 1);
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
  const block = detailBlock(event);
  if (block !== null) seek(block * HOP_SECONDS);
});

// ---------------------------------------------------------------------------
// Live preview

/** Value in dB of a per-block curve of the selected mix at a time in the recording. */
function curveAt(curve: Float32Array, seconds: number): number {
  // Each value sits at the centre of its block, as in the export.
  const position = clamp(seconds / HOP_SECONDS - mix.region.start - 0.5, 0, curve.length - 1);
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
  const { start, end } = mix.region;
  if (time >= end * HOP_SECONDS) {
    // Playback covers the selected mix only.
    player.audio.pause();
    player.audio.currentTime = start * HOP_SECONDS;
  } else if (time < start * HOP_SECONDS) {
    player.audio.currentTime = start * HOP_SECONDS;
  }
  // When zoomed in, turn the page as the playhead runs off the edge.
  const playhead = player.audio.currentTime / HOP_SECONDS;
  const span = view.end - view.start;
  if (span < end - start && (playhead < view.start || playhead >= view.end)) {
    setView(playhead - span * 0.05, playhead + span * 0.95);
  }
  player.apply(hearLevelled ? gainAt(time) : 1, hearLevelled ? bassAt(time) : 0, {
    ceilingDb: mix.ceilingDb,
    bypass: !hearLevelled,
  });
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
  if (time < mix.region.start * HOP_SECONDS || time >= mix.region.end * HOP_SECONDS - 0.5) {
    player.audio.currentTime = mix.region.start * HOP_SECONDS;
  }
  try {
    await player.play();
  } catch (error) {
    $('meter').textContent = `Cannot play this recording here (${message(error)}). Export still works.`;
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
    get: () => mix.options.windowSeconds,
    set: (v) => (mix.options.windowSeconds = v),
    // Dips up to this share of the window are filled in; see fullEnergyEnvelope.
    format: (v) => `up to ${Math.round(v * mix.options.percentile)} s`,
  },
  { id: 'smooth', get: () => mix.options.smoothSeconds, set: (v) => (mix.options.smoothSeconds = v), format: (v) => `${v * 2} s` },
  { id: 'bass', get: () => mix.options.bassCorrection, set: (v) => (mix.options.bassCorrection = v), format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`) },
  { id: 'bass-max', get: () => mix.options.maxBassDb, set: (v) => (mix.options.maxBassDb = v), format: (v) => `±${v.toFixed(1)} dB` },
  { id: 'boost', get: () => mix.options.maxBoostDb, set: (v) => (mix.options.maxBoostDb = v), format: (v) => db(v) },
  { id: 'cut', get: () => mix.options.maxCutDb, set: (v) => (mix.options.maxCutDb = v), format: (v) => db(-v) },
  { id: 'ceiling', get: () => mix.ceilingDb, set: (v) => (mix.ceilingDb = v), format: (v) => `${v.toFixed(1)} dBFS` },
];

function syncControls() {
  for (const slider of sliders) {
    $<HTMLInputElement>(slider.id).value = String(slider.get());
    $(`${slider.id}-value`).textContent = slider.format(slider.get());
  }
  const auto = mix.options.targetLufs === undefined;
  $<HTMLInputElement>('target-auto').checked = auto;
  $<HTMLInputElement>('target').disabled = auto;
  if (!auto) {
    $<HTMLInputElement>('target').value = String(mix.options.targetLufs);
    $('target-value').textContent = lufs(mix.options.targetLufs!);
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
  mix.options.targetLufs = Number((event.target as HTMLInputElement).value);
  $('target-value').textContent = lufs(mix.options.targetLufs);
  scheduleRecompute();
});

$<HTMLInputElement>('target-auto').addEventListener('change', (event) => {
  const auto = (event.target as HTMLInputElement).checked;
  // Leaving auto starts from the level it had chosen.
  mix.options.targetLufs = auto ? undefined : Number($<HTMLInputElement>('target').value);
  syncControls();
  scheduleRecompute();
});

$('reset').addEventListener('click', () => {
  mix.options = { ...DEFAULT_LEVEL_OPTIONS };
  mix.ceilingDb = DEFAULT_CEILING_DB;
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
  $<HTMLButtonElement>('export-all').disabled = busy || !recording;
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
    recording = { path, name, measured, body: Float32Array.from(measured.blocks, (energy) => Math.sqrt(energy / 2)) };
    overviewShown = { start: 0, end: measured.peaks.length };
    player.load(await api.mediaUrl(path));
    $('file-name').textContent = name;
    $('file-name').classList.add('loaded');
    $('empty').hidden = true;
    $('views').hidden = false;
    // A new recording starts as one mix covering all of it, keeping the settings in use.
    const whole: Mix = {
      name: 'Mix 1',
      region: { start: 0, end: measured.peaks.length },
      options: { ...mix.options },
      ceilingDb: mix.ceilingDb,
    };
    mixes = [whole];
    mixesCreated = 1;
    select(whole);
    requestAnimationFrame(() => requestAnimationFrame(() => api.painted()));
  } catch (error) {
    $('export-status').textContent = `Could not open ${name}: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

$('open').addEventListener('click', async () => {
  const path = await api.pickFile();
  if (path) open(path);
});

/** File-name-safe version of a mix name. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'mix';

function renderMix(m: Mix, output: string) {
  const { gainDb, bassDb } = compute(m).detail;
  return api.render({
    input: recording!.path,
    output,
    start: m.region.start * HOP_SECONDS,
    end: m.region.end * HOP_SECONDS,
    gainDb,
    bassDb: bassDb ?? new Float32Array(gainDb.length),
    ceilingDb: m.ceilingDb,
  });
}

function showExported(text: string, reveal: string) {
  const status = $('export-status');
  status.textContent = `${text} `;
  const link = document.createElement('a');
  link.textContent = 'Show in Finder';
  link.addEventListener('click', () => api.reveal(reveal));
  status.append(link);
}

async function exportMix() {
  if (!recording || busy) return;
  player.audio.pause();
  const base = recording.path.replace(/\.[^./\\]+$/, '');
  const suggested = mixes.length > 1 ? `${base} - ${fileName(mix.name)}.wav` : `${base} mastered.wav`;
  const output = await api.pickOutput(suggested);
  if (!output) return;
  $('export-status').textContent = '';
  progressLabel = `Exporting ${mix.name}`;
  setBusy(progressLabel);
  try {
    const result = await renderMix(mix, output);
    const peakDb = 20 * Math.log10(Math.max(result.peak, 1e-9));
    showExported(`Exported at ${lufs(result.integratedLufs)}, peak ${peakDb.toFixed(1)} dBFS.`, output);
  } catch (error) {
    $('export-status').textContent = `Export failed: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

/** Exports every mix into one folder, numbered in the order they occur in the recording. */
async function exportAll() {
  if (!recording || busy) return;
  player.audio.pause();
  const folder = await api.pickFolder();
  if (!folder) return;
  const extension = $<HTMLSelectElement>('format').value;
  const stem = recording.name.replace(/\.[^.]+$/, '');
  const outputs = mixes.map(
    (m, index) => `${folder}/${stem} - ${String(index + 1).padStart(2, '0')} ${fileName(m.name)}.${extension}`,
  );
  const existing = await api.existing(outputs);
  if (existing.length > 0) {
    const names = existing.map((path) => path.split(/[\\/]/).pop()).join('\n');
    const question = existing.length === 1 ? 'Replace the existing file?' : `Replace ${existing.length} existing files?`;
    if (!(await api.confirm(question, names, 'Replace'))) return;
  }

  $('export-status').textContent = '';
  setBusy('Exporting');
  let done = 0;
  try {
    for (const [index, m] of mixes.entries()) {
      progressLabel = `Exporting ${index + 1} of ${mixes.length}: ${m.name}`;
      $('progress-bar').style.width = '0';
      await renderMix(m, outputs[index]);
      done++;
    }
    showExported(`Exported ${done} mixes.`, outputs[0]);
  } catch (error) {
    $('export-status').textContent = `Export stopped at "${mixes[done].name}" after ${done} of ${mixes.length}: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

$('export').addEventListener('click', exportMix);
$('export-all').addEventListener('click', exportAll);

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
