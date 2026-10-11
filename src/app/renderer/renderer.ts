import { DEFAULT_LEVEL_OPTIONS, type Adjustment, type LevelOptions } from '../../gain-curve.ts';
import { findGaps, soundBetween } from '../../gaps.ts';
import { level } from '../../level.ts';
import { HOP_SECONDS, integratedLoudness } from '../../loudness.ts';
import type { Measurement } from '../../master.ts';
import type { Api } from '../api.ts';
import { clock, detailLanes, drawDetail, drawOverview, GUTTER, type Detail, type Region } from './draw.ts';
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
  /** Silences between sets, in blocks. */
  gaps: Region[];
}

/** One stretch of the recording that is levelled and exported on its own. */
interface Mix {
  name: string;
  region: Region;
  options: LevelOptions;
  ceilingDb: number;
  /** Manual gain changes, in blocks of the recording. */
  adjustments: Adjustment[];
}

let recording: Recording | null = null;
/** Every marked mix, in the order they occur in the recording. They never overlap. */
let mixes: Mix[] = [];
/** The selected mix: the one the detail view, the settings and playback apply to. */
let mix: Mix = {
  name: 'Mix 1',
  region: { start: 0, end: 0 },
  options: { ...DEFAULT_LEVEL_OPTIONS },
  ceilingDb: DEFAULT_CEILING_DB,
  adjustments: [],
};
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
/** Whether a failed analysis or export was stopped with Cancel. */
const wasCancelled = (error: unknown) => message(error).includes('Cancelled');

// ---------------------------------------------------------------------------
// Levelling and drawing

let recomputeQueued = false;
let drawQueued = false;

function scheduleRecompute() {
  scheduleSave();
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
    const playhead = player.time / HOP_SECONDS;
    drawOverview(overview, { peaks: recording.measured.peaks, body: recording.body, gaps: recording.gaps }, overviewShown, mixes.map((m) => ({ ...m.region, name: m.name })), mixes.indexOf(mix), view, playhead);
    if (!detail) return;
    // The curves can be one frame behind the region while it is being dragged.
    const length = detail.gainDb.length;
    const shown = {
      start: clamp(view.start - mix.region.start, 0, length - 1),
      end: clamp(view.end - mix.region.start, 1, length),
    };
    const active = grab && 'adjustment' in grab ? grab.adjustment : grab?.made ?? hoveredAdjustment;
    drawDetail(detailCanvas, detail, shown, hoverX, playhead - mix.region.start, active ? mix.adjustments.indexOf(active) : null);
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
  const adjustments = m.adjustments.map((a) => ({ start: a.start - start, end: a.end - start, db: a.db }));

  const levelling = level(
    { shortTerm, lowShortTerm: measured.lowShortTerm.subarray(start, end), restShortTerm },
    m.options,
    { peaks: peaksIn, ceilingDb: m.ceilingDb },
    adjustments,
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
    detail: { startBlock: start, peaksIn, peaksOut, bodyOut, loudnessIn: shortTerm, loudnessOut, gainDb, bassDb, adjustments, targetLufs, ceiling },
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
  showAdjustments();
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
  // Mixes that were never named are numbered by where they are in the recording.
  mixes.forEach((m, index) => {
    if (hasDefaultName(m)) m.name = `Mix ${index + 1}`;
  });
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
      tab.title = 'Double-click to rename';
      tab.addEventListener('click', () => select(m));
      tab.addEventListener('dblclick', () => {
        const name = $<HTMLInputElement>('mix-name');
        name.focus();
        name.select();
      });
      return tab;
    }),
  );
  const several = mixes.length > 1;
  $('settings-for').textContent = several ? `Settings for ${mix.name}` : '';
  $('export-all-group').hidden = !several;
  $('export-all').textContent = `Export all ${mixes.length}…`;
  $<HTMLButtonElement>('delete-mix').disabled = !several;
  $<HTMLButtonElement>('split-gaps').disabled = !recording || piecesBetweenGaps(mix) === null;
  scheduleSave();
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
    adjustments: [],
  };
  mixes.push(added);
  select(added);
}

type Drag = { kind: 'start' | 'end' } | { kind: 'move'; offset: number } | { kind: 'new'; anchor: number; added: boolean };
let drag: Drag | null = null;
/** Whether the pointer has moved since the press, which tells a drag from a click. */
let dragged = false;
/** Where the press landed, and how far the pointer must travel before it counts as a drag. */
let pressX = 0;
const DRAG_START_PX = 4;
const HANDLE_PX = 6;
/** Clicking the end of a mix puts the playhead this far before it, to hear how it ends. */
const END_PREVIEW_BLOCKS = Math.round(10 / HOP_SECONDS);

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
  pressX = event.clientX;
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
  // A hand is never perfectly still during a click; ignore the wobble.
  if (!dragged && Math.abs(event.clientX - pressX) < DRAG_START_PX) return;
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
  // A plain click moves the playhead: to that spot inside a mix, to the very
  // start of the mix on its left edge, and to just before the end on its right.
  if (drag && !dragged) {
    if (drag.kind === 'move') seek(overviewBlock(event) * HOP_SECONDS);
    else if (drag.kind === 'start') seek(mix.region.start * HOP_SECONDS);
    else if (drag.kind === 'end') seek(Math.max(mix.region.start, mix.region.end - END_PREVIEW_BLOCKS) * HOP_SECONDS);
  }
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

// Leave a little air around the music when cutting at a silence.
const LEAD_IN_BLOCKS = Math.round(0.5 / HOP_SECONDS);
const TAIL_BLOCKS = Math.round(1.5 / HOP_SECONDS);

/**
 * The stretches of a mix with music in them, if cutting at the silences would
 * change anything: more than one stretch, or silence to trim from the ends.
 */
function piecesBetweenGaps(m: Mix): Region[] | null {
  const pieces = soundBetween(recording!.gaps, m.region)
    .filter((piece) => piece.end - piece.start >= MIN_REGION_BLOCKS)
    .map((piece) => ({
      start: Math.max(m.region.start, piece.start - LEAD_IN_BLOCKS),
      end: Math.min(m.region.end, piece.end + TAIL_BLOCKS),
    }));
  if (pieces.length === 0) return null;
  const unchanged = pieces.length === 1 && pieces[0].start === m.region.start && pieces[0].end === m.region.end;
  return unchanged ? null : pieces;
}

/** Replaces the selected mix by one mix per region, all with its settings. The first keeps its name. */
function splitInto(regions: Region[]) {
  const original = mix;
  original.region = regions[0];
  for (const region of regions.slice(1)) {
    mixesCreated++;
    mixes.push({
      name: `Mix ${mixesCreated}`,
      region,
      options: { ...original.options },
      ceilingDb: original.ceilingDb,
      adjustments: original.adjustments.map((a) => ({ ...a })),
    });
  }
  select(original);
}

$('split-gaps').addEventListener('click', () => {
  const pieces = recording && !busy ? piecesBetweenGaps(mix) : null;
  if (pieces) splitInto(pieces);
});

$('split-here').addEventListener('click', () => {
  if (!recording || busy) return;
  const at = Math.round(player.time / HOP_SECONDS);
  const { start, end } = mix.region;
  if (at - start < MIN_REGION_BLOCKS || end - at < MIN_REGION_BLOCKS) {
    $('readout').textContent = 'Put the playhead inside this mix, at least 10 seconds from either end, to split there.';
    return;
  }
  splitInto([{ start, end: at }, { start: at, end }]);
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
  const playhead = player.time / HOP_SECONDS;
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
  const found = grab ? null : adjustmentAt(event);
  hoveredAdjustment = found?.adjustment ?? null;
  if (!grab) {
    detailCanvas.style.cursor = found ? (found.part === 'level' ? 'ns-resize' : 'ew-resize') : inGainLane(event) ? 'col-resize' : 'pointer';
  }
  if (detail && block !== null) {
    const i = clamp(Math.floor(block - mix.region.start), 0, detail.gainDb.length - 1);
    const shownAdjustment = grab && 'adjustment' in grab ? grab.adjustment : grab?.made ?? hoveredAdjustment;
    $('readout').textContent =
      `${clock((detail.startBlock + i) * HOP_SECONDS)}    original ${lufs(detail.loudnessIn[i])}` +
      `    gain ${db(detail.gainDb[i])}${detail.bassDb ? `    bass ${db(detail.bassDb[i])}` : ''}` +
      `    levelled ${lufs(detail.loudnessOut[i])}` +
      (shownAdjustment ? `    adjusted by hand ${db(shownAdjustment.db)}: drag up or down, drag an edge to resize, double-click to remove` : '');
  }
  scheduleDraw();
});

detailCanvas.addEventListener('mouseleave', () => {
  hoverX = null;
  hoveredAdjustment = null;
  $('readout').textContent = ' ';
  scheduleDraw();
});

detailCanvas.addEventListener('click', (event) => {
  // The end of a drag is not a click.
  if (grabMoved) return;
  const block = detailBlock(event);
  if (block !== null) seek(block * HOP_SECONDS);
  // The margin left of the curves stands for the very start of what is shown.
  else if (event.clientX - detailCanvas.getBoundingClientRect().left < GUTTER) seek(view.start * HOP_SECONDS);
});

// ---------------------------------------------------------------------------
// Manual adjustments: stretches of the gain lane raised or lowered by hand

const MIN_ADJUSTMENT_BLOCKS = Math.round(5 / HOP_SECONDS);
const MAX_ADJUSTMENT_DB = 12;
/** How far the pointer travels for one decibel when dragging an adjustment up or down. */
const PIXELS_PER_DB = 20;
const GRAB_PX = 5;

type Grab =
  | { kind: 'create'; anchor: number; x: number; made: Adjustment | null }
  | { kind: 'level'; adjustment: Adjustment; y: number; db: number; made?: undefined }
  | { kind: 'start' | 'end'; adjustment: Adjustment; made?: undefined };
let grab: Grab | null = null;
let grabMoved = false;
let grabX = 0;
let grabY = 0;
let hoveredAdjustment: Adjustment | null = null;

function inGainLane(event: MouseEvent): boolean {
  const rect = detailCanvas.getBoundingClientRect();
  const lane = detailLanes(rect.height).gain;
  const y = event.clientY - rect.top;
  return event.clientX - rect.left >= GUTTER && y >= lane.top && y <= lane.top + lane.height;
}

/** The adjustment under the pointer and which part of it: an edge, or the middle that sets its level. */
function adjustmentAt(event: MouseEvent): { adjustment: Adjustment; part: 'start' | 'end' | 'level' } | null {
  const block = detailBlock(event);
  if (block === null || !inGainLane(event)) return null;
  const reach = (GRAB_PX * (view.end - view.start)) / (detailCanvas.clientWidth - GUTTER);
  for (const adjustment of mix.adjustments) {
    if (Math.abs(block - adjustment.start) <= reach) return { adjustment, part: 'start' };
    if (Math.abs(block - adjustment.end) <= reach) return { adjustment, part: 'end' };
  }
  const inside = mix.adjustments.find((a) => block > a.start && block < a.end);
  return inside ? { adjustment: inside, part: 'level' } : null;
}

detailCanvas.addEventListener('mousedown', (event) => {
  grabMoved = false;
  grabX = event.clientX;
  grabY = event.clientY;
  if (!recording || busy || !detail || !inGainLane(event)) return;
  const found = adjustmentAt(event);
  if (!found) grab = { kind: 'create', anchor: detailBlock(event)!, x: event.clientX, made: null };
  else if (found.part === 'level') grab = { kind: 'level', adjustment: found.adjustment, y: event.clientY, db: found.adjustment.db };
  else grab = { kind: found.part, adjustment: found.adjustment };
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!grab) return;
  if (!grabMoved && Math.hypot(event.clientX - grabX, event.clientY - grabY) < DRAG_START_PX) return;
  const rect = detailCanvas.getBoundingClientRect();
  const fraction = clamp((event.clientX - rect.left - GUTTER) / (rect.width - GUTTER), 0, 1);
  const block = Math.round(view.start + fraction * (view.end - view.start));
  if (grab.kind === 'create') {
    // Dragging sideways across the lane marks a new stretch.
    if (!grab.made) {
      grab.made = { start: block, end: block, db: 0 };
      mix.adjustments.push(grab.made);
    }
    grab.made.start = Math.round(Math.min(block, grab.anchor));
    grab.made.end = Math.round(Math.max(block, grab.anchor));
  } else if (grab.kind === 'level') {
    const moved = grab.db - (event.clientY - grab.y) / PIXELS_PER_DB;
    grab.adjustment.db = clamp(Math.round(moved * 10) / 10, -MAX_ADJUSTMENT_DB, MAX_ADJUSTMENT_DB);
  } else if (grab.kind === 'start') {
    grab.adjustment.start = Math.min(block, grab.adjustment.end - MIN_ADJUSTMENT_BLOCKS);
  } else {
    grab.adjustment.end = Math.max(block, grab.adjustment.start + MIN_ADJUSTMENT_BLOCKS);
  }
  grabMoved = true;
  scheduleRecompute();
});

window.addEventListener('mouseup', () => {
  if (!grab) return;
  // A stretch too short to hear as a change of level is taken as a slip.
  const made = grab.kind === 'create' ? grab.made : null;
  if (made && made.end - made.start < MIN_ADJUSTMENT_BLOCKS) removeAdjustment(made);
  grab = null;
  scheduleRecompute();
});

detailCanvas.addEventListener('dblclick', (event) => {
  const found = adjustmentAt(event);
  if (found) removeAdjustment(found.adjustment);
});

function removeAdjustment(adjustment: Adjustment) {
  mix.adjustments = mix.adjustments.filter((a) => a !== adjustment);
  if (hoveredAdjustment === adjustment) hoveredAdjustment = null;
  scheduleRecompute();
}

function showAdjustments() {
  const stat = $('stat-adjustments');
  const count = mix.adjustments.length;
  if (count === 0) {
    stat.textContent = 'none';
    return;
  }
  const clear = document.createElement('a');
  clear.textContent = 'clear';
  clear.addEventListener('click', () => {
    mix.adjustments = [];
    scheduleRecompute();
  });
  stat.replaceChildren(`${count} by hand · `, clear);
}

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
  player.seek(seconds);
  // Keep the playhead in sight when the detail view is zoomed in.
  const at = seconds / HOP_SECONDS;
  const span = view.end - view.start;
  if (at < view.start || at >= view.end) setView(at - span * 0.2, at + span * 0.8);
  showPlayback();
}

function showPlayback() {
  $('play-time').textContent = clock(player.time);
  scheduleDraw();
}

/** Keeps the sound and the playhead in step with the audio while it plays. */
function follow() {
  if (!recording || player.paused) return;
  const time = player.time;
  const { start, end } = mix.region;
  if (time >= end * HOP_SECONDS) {
    // Playback covers the selected mix only.
    player.pause();
    player.seek(start * HOP_SECONDS);
  } else if (time < start * HOP_SECONDS) {
    player.seek(start * HOP_SECONDS);
  }
  // When zoomed in, turn the page as the playhead runs off the edge.
  const playhead = player.time / HOP_SECONDS;
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
  if (!player.paused) {
    player.pause();
    return;
  }
  const time = player.time;
  if (time < mix.region.start * HOP_SECONDS || time >= mix.region.end * HOP_SECONDS - 0.5) {
    player.seek(mix.region.start * HOP_SECONDS);
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

player.onPlay = () => {
  $('play').textContent = 'Pause';
  follow();
};
player.onPause = () => {
  $('play').textContent = 'Play';
  $('meter').textContent = '';
  showPlayback();
};
player.onSeek = showPlayback;

// Hold the readings briefly so the numbers can be read.
let held = { peak: 0, gain: 1, since: 0 };
player.onReport = ({ peak, gain }) => {
  if (player.paused) return;
  const now = performance.now();
  if (now - held.since > 600) held = { peak: 0, gain: 1, since: now };
  held.peak = Math.max(held.peak, peak);
  held.gain = Math.min(held.gain, gain);
  const peakDb = 20 * Math.log10(Math.max(held.peak, 1e-6));
  const limiting = -20 * Math.log10(held.gain);
  $('meter').textContent =
    `gain ${hearLevelled ? db(20 * Math.log10(gainAt(player.time))) : 'off'}` +
    (hearLevelled && detail?.bassDb ? `    bass ${db(bassAt(player.time))}` : '') +
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
  } else if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    // Arrow keys on a slider or a list belong to it.
  } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault();
    const step = event.altKey ? STEP_FINE_SECONDS : event.shiftKey ? STEP_COARSE_SECONDS : STEP_SECONDS;
    stepPlayhead(event.code === 'ArrowLeft' ? -step : step);
  } else if (event.code === 'Home' || event.code === 'Enter') {
    event.preventDefault();
    toStart();
  } else if (event.code === 'End') {
    event.preventDefault();
    seek(Math.max(mix.region.start, mix.region.end - END_PREVIEW_BLOCKS) * HOP_SECONDS);
  }
});

const STEP_SECONDS = 5;
const STEP_COARSE_SECONDS = 30;
const STEP_FINE_SECONDS = 1;

/** Moves the playhead by a number of seconds, staying inside the selected mix. */
function stepPlayhead(seconds: number) {
  if (!recording) return;
  const { start, end } = mix.region;
  // From outside the mix, the first step lands on its nearest edge.
  const from = clamp(player.time, start * HOP_SECONDS, end * HOP_SECONDS);
  seek(clamp(from + seconds, start * HOP_SECONDS, end * HOP_SECONDS - 0.5));
}

function toStart() {
  if (recording) seek(mix.region.start * HOP_SECONDS);
}

$('to-start').addEventListener('click', toStart);

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
  { id: 'ceiling', get: () => mix.ceilingDb, set: (v) => (mix.ceilingDb = v), format: (v) => `${v.toFixed(1)} dBTP` },
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
  $<HTMLButtonElement>('cancel').disabled = false;
  $<HTMLButtonElement>('open').disabled = busy;
  $<HTMLButtonElement>('export').disabled = busy || !recording;
  $<HTMLButtonElement>('export-all').disabled = busy || !recording;
  $<HTMLButtonElement>('play').disabled = busy || !recording;
  $<HTMLButtonElement>('to-start').disabled = busy || !recording;
  showHistory();
}

let progressLabel = '';
/** Set by Cancel, so that an export of several mixes stops instead of moving on to the next. */
let cancelRequested = false;

function cancel() {
  if (!busy) return;
  cancelRequested = true;
  $<HTMLButtonElement>('cancel').disabled = true;
  api.cancel();
}

$('cancel').addEventListener('click', cancel);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && busy) cancel();
});

api.onProgress((fraction) => {
  $('progress-bar').style.width = `${(fraction * 100).toFixed(1)}%`;
  $('progress-label').textContent = `${progressLabel} ${Math.floor(fraction * 100)}%`;
});

async function open(path: string) {
  if (busy) return;
  const name = path.split(/[\\/]/).pop()!;
  progressLabel = `Analysing ${name}`;
  cancelRequested = false;
  setBusy(progressLabel);
  $('export-status').textContent = '';
  try {
    const measured = await api.measure(path);
    if (measured.peaks.length === 0) throw new Error('The recording is too short to analyse');
    recording = {
      path,
      name,
      measured,
      body: Float32Array.from(measured.blocks, (energy) => Math.sqrt(energy / 2)),
      gaps: findGaps(measured.blocks),
    };
    overviewShown = { start: 0, end: measured.peaks.length };
    player.load(await api.mediaUrl(path));
    $('file-name').textContent = name;
    $('file-name').classList.add('loaded');
    $('empty').hidden = true;
    $('views').hidden = false;
    const restored = restore(await api.recall(path), measured.peaks.length);
    select(mixes[restored.selected]);
    undoSteps = [];
    redoSteps = [];
    settled = snapshot();
    showHistory();
    if (restored.fromLastTime) $('export-status').textContent = 'Picked up where you left off.';
    requestAnimationFrame(() => requestAnimationFrame(() => api.painted()));
  } catch (error) {
    $('export-status').textContent = wasCancelled(error) ? 'Analysis cancelled.' : `Could not open ${name}: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

$('open').addEventListener('click', async () => {
  const path = await api.pickFile();
  if (path) open(path);
});

// ---------------------------------------------------------------------------
// Remembering the work on a recording between sessions

interface Session {
  version: 1;
  /** Length of the recording in blocks when saved; a different length means a different file. */
  blocks: number;
  selected: number;
  mixesCreated: number;
  mixes: Mix[];
}

interface Defaults {
  options: LevelOptions;
  ceilingDb: number;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!recording || mixes.length === 0) return;
  const session: Session = {
    version: 1,
    blocks: recording.measured.peaks.length,
    selected: Math.max(0, mixes.indexOf(mix)),
    mixesCreated,
    mixes,
  };
  const defaults: Defaults = { options: mix.options, ceilingDb: mix.ceilingDb };
  api.remember(recording.path, { session, defaults });
  settleHistory();
}

/** Saves shortly after the last change, so dragging does not write on every frame. */
function scheduleSave() {
  if (!recording) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

window.addEventListener('beforeunload', () => {
  if (saveTimer !== undefined) saveNow();
});

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Sets up the mixes for a newly opened recording: the ones marked in it last
 * time, or else a single mix covering all of it with the settings last in use.
 * What comes back from disk is checked, since it may be old or damaged.
 */
function restore(remembered: { session: unknown; defaults: unknown }, total: number) {
  const savedDefaults = remembered.defaults as Partial<Defaults> | null;
  const defaults: Defaults = {
    options: { ...DEFAULT_LEVEL_OPTIONS, ...(savedDefaults?.options ?? {}) },
    ceilingDb: isNumber(savedDefaults?.ceilingDb) ? savedDefaults.ceilingDb : DEFAULT_CEILING_DB,
  };

  const session = remembered.session as Partial<Session> | null;
  const usable =
    session?.version === 1 && session.blocks === total && Array.isArray(session.mixes)
      ? session.mixes.filter((m) => isNumber(m?.region?.start) && isNumber(m?.region?.end) && m.region.start >= 0 && m.region.end <= total && m.region.end > m.region.start)
      : [];
  if (usable.length > 0) {
    mixes = usable.map((m, index) => ({
      name: typeof m.name === 'string' && m.name ? m.name : `Mix ${index + 1}`,
      region: { start: Math.round(m.region.start), end: Math.round(m.region.end) },
      options: { ...DEFAULT_LEVEL_OPTIONS, ...(m.options ?? {}) },
      ceilingDb: isNumber(m.ceilingDb) ? m.ceilingDb : DEFAULT_CEILING_DB,
      adjustments: (Array.isArray(m.adjustments) ? m.adjustments : []).filter(
        (a) => isNumber(a?.start) && isNumber(a?.end) && isNumber(a?.db) && a.end > a.start,
      ),
    }));
    mixesCreated = Math.max(mixes.length, isNumber(session!.mixesCreated) ? session!.mixesCreated : 0);
    const selected = isNumber(session!.selected) ? clamp(session!.selected, 0, mixes.length - 1) : 0;
    return { selected, fromLastTime: true };
  }

  mixes = [{ name: 'Mix 1', region: { start: 0, end: total }, ...defaults, adjustments: [] }];
  mixesCreated = 1;
  return { selected: 0, fromLastTime: false };
}

// ---------------------------------------------------------------------------
// Undo and redo
//
// Each step is a copy of all the mixes. Changes are gathered into steps the
// same way they are saved: once nothing has changed for a moment, so a whole
// drag or slider movement undoes in one go.

interface Step {
  /** The mixes as JSON, which is also what tells two states apart. */
  mixes: string;
  selected: number;
  mixesCreated: number;
}

const MAX_UNDO_STEPS = 100;
let undoSteps: Step[] = [];
let redoSteps: Step[] = [];
/** The state as of the last settled change. */
let settled: Step | null = null;

function snapshot(): Step {
  return { mixes: JSON.stringify(mixes), selected: Math.max(0, mixes.indexOf(mix)), mixesCreated };
}

/** Records the changes since the last settled state, if any, as one undo step. */
function settleHistory() {
  if (!settled) return;
  const now = snapshot();
  if (now.mixes === settled.mixes) {
    // Selecting another mix is not a change worth a step, but is remembered.
    settled = now;
    return;
  }
  undoSteps.push(settled);
  if (undoSteps.length > MAX_UNDO_STEPS) undoSteps.shift();
  redoSteps = [];
  settled = now;
  showHistory();
}

function showHistory() {
  $<HTMLButtonElement>('undo').disabled = busy || undoSteps.length === 0;
  $<HTMLButtonElement>('redo').disabled = busy || redoSteps.length === 0;
}

function applyStep(step: Step) {
  mixes = JSON.parse(step.mixes);
  mixesCreated = step.mixesCreated;
  settled = step;
  grab = null;
  drag = null;
  hoveredAdjustment = null;
  select(mixes[clamp(step.selected, 0, mixes.length - 1)]);
  showHistory();
}

function stepHistory(direction: 'undo' | 'redo') {
  if (!recording || busy) return;
  // Count a change still in progress as done, so that it is what gets undone.
  if (saveTimer !== undefined) saveNow();
  const [from, to] = direction === 'undo' ? [undoSteps, redoSteps] : [redoSteps, undoSteps];
  const step = from.pop();
  if (!step || !settled) return;
  to.push(settled);
  applyStep(step);
}

const undo = () => stepHistory('undo');
const redo = () => stepHistory('redo');

$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);

api.onMenu(async (command) => {
  if (command === 'open') {
    const path = busy ? null : await api.pickFile();
    if (path) open(path);
    return;
  }
  // While typing in a field, undo belongs to the text.
  const field = document.activeElement;
  if (field instanceof HTMLInputElement && field.type === 'text') document.execCommand(command);
  else if (command === 'undo') undo();
  else redo();
});

/** File-name-safe version of a mix name. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'mix';
/** Whether a mix still has the name it was given automatically. */
const hasDefaultName = (m: Mix) => /^Mix \d+$/.test(m.name);
const recordingStem = () => recording!.name.replace(/\.[^.]+$/, '');

/**
 * What an exported mix is called, as a file and in its tags. A mix the user
 * named goes by exactly that name; otherwise the recording's name is used.
 */
function exportName(m: Mix): string {
  if (!hasDefaultName(m)) return m.name;
  return mixes.length > 1 ? `${recordingStem()} - ${m.name}` : `${recordingStem()} mastered`;
}

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
    title: exportName(m),
  });
}

function showExported(text: string, reveal: string) {
  const status = $('export-status');
  status.textContent = `${text} `;
  const link = document.createElement('a');
  link.textContent = navigator.userAgent.includes('Mac') ? 'Show in Finder' : 'Show in folder';
  link.addEventListener('click', () => api.reveal(reveal));
  status.append(link);
}

async function exportMix() {
  if (!recording || busy) return;
  player.pause();
  const folder = recording.path.replace(/[^\\/]+$/, '');
  const output = await api.pickOutput(`${folder}${fileName(exportName(mix))}.wav`);
  if (!output) return;
  $('export-status').textContent = '';
  progressLabel = `Exporting ${mix.name}`;
  cancelRequested = false;
  setBusy(progressLabel);
  try {
    const result = await renderMix(mix, output);
    const peakDb = 20 * Math.log10(Math.max(result.peak, 1e-9));
    showExported(`Exported at ${lufs(result.integratedLufs)}, peak ${peakDb.toFixed(1)} dBFS.`, output);
  } catch (error) {
    $('export-status').textContent = wasCancelled(error) ? 'Export cancelled.' : `Export failed: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

/** Exports every mix into one folder, numbered in the order they occur in the recording. */
async function exportAll() {
  if (!recording || busy) return;
  player.pause();
  const folder = await api.pickFolder();
  if (!folder) return;
  const extension = $<HTMLSelectElement>('format').value;
  // Named mixes become files of that name; the rest are numbered in order.
  const taken = new Set<string>();
  const outputs = mixes.map((m, index) => {
    const wanted = hasDefaultName(m)
      ? `${recordingStem()} - ${String(index + 1).padStart(2, '0')} ${m.name}`
      : fileName(m.name);
    let name = wanted;
    for (let copy = 2; taken.has(name.toLowerCase()); copy++) name = `${wanted} (${copy})`;
    taken.add(name.toLowerCase());
    return `${folder}/${name}.${extension}`;
  });
  const existing = await api.existing(outputs);
  if (existing.length > 0) {
    const names = existing.map((path) => path.split(/[\\/]/).pop()).join('\n');
    const question = existing.length === 1 ? 'Replace the existing file?' : `Replace ${existing.length} existing files?`;
    if (!(await api.confirm(question, names, 'Replace'))) return;
  }

  $('export-status').textContent = '';
  cancelRequested = false;
  setBusy('Exporting');
  let done = 0;
  try {
    for (const [index, m] of mixes.entries()) {
      if (cancelRequested) throw new Error('Cancelled');
      progressLabel = `Exporting ${index + 1} of ${mixes.length}: ${m.name}`;
      $('progress-bar').style.width = '0';
      await renderMix(m, outputs[index]);
      done++;
    }
    showExported(`Exported ${done} mixes.`, outputs[0]);
  } catch (error) {
    $('export-status').textContent = wasCancelled(error)
      ? `Export cancelled after ${done} of ${mixes.length} mixes.`
      : `Export stopped at "${mixes[done].name}" after ${done} of ${mixes.length}: ${message(error)}`;
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
api.onOpenFile(open);
api.initialFile().then((path) => {
  if (path) open(path);
});
