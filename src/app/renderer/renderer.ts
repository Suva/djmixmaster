import { DEFAULT_LEVEL_OPTIONS, type Adjustment, type LevelOptions } from '../../gain-curve.ts';
import { isLossy, LOSSY_HEADROOM_DB, type EncodeOptions } from '../../encode-options.ts';
import { fadeGain } from '../../fade.ts';
import { findGaps, soundBetween } from '../../gaps.ts';
import { level } from '../../level.ts';
import { HOP_SECONDS, integratedLoudness } from '../../loudness.ts';
import { checkup, type Checkup } from '../../checkup.ts';
import type { Examination } from '../../master.ts';
import type { Api } from '../api.ts';
import { clock, detailLanes, drawDetail, drawOverview, FADE_HANDLE_Y, GUTTER, type Detail, type Region } from './draw.ts';
import { LevelMeter, type MeterFigure } from './meter.ts';
import { Player } from './player.ts';
import { initTooltips } from './tooltip.ts';

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
  measured: Examination;
  /** What is worth knowing about the recording as it is. */
  checkup: Checkup;
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
  /** Who played it, for the exported file's tags. */
  artist?: string;
  /** Length in blocks of the fade at the start and at the end; absent means none. */
  fadeIn?: number;
  fadeOut?: number;
  /** A loudness preset in use, by id. It decides the target in place of the one in `options`. */
  loudness?: string;
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
/** Album name written into every export of this recording, typically the event. */
let album = '';
/** Part of the selected mix the detail view shows, in blocks of the recording. */
let view: Region = { start: 0, end: 0 };
/** Part of the recording the overview shows, in blocks. */
let overviewShown: Region = { start: 0, end: 0 };
let detail: Detail | null = null;
let hoverX: number | null = null;
let hoverY: number | null = null;
let busy = false;

const player = new Player(location.search.includes('silent'));
const levelMeter = new LevelMeter($<HTMLCanvasElement>('level-meter'));
/** How much the limiter last said it was taking off, in dB. */
let limiterReductionDb = 0;
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
    drawOverview(overview, overviewData(recording), overviewShown, mixes.map((m) => ({ ...m.region, name: m.name })), mixes.indexOf(mix), view, playhead);
    // The switch for what dragging adjusts lives in the corner of the gain lane.
    $('adjust-switch').style.top = `${detailLanes(detailCanvas.clientHeight).gain.top + 1}px`;
    if (!detail) return;
    // The curves can be one frame behind the region while it is being dragged.
    const length = detail.gainDb.length;
    const shown = {
      start: clamp(view.start - mix.region.start, 0, length - 1),
      end: clamp(view.end - mix.region.start, 1, length),
    };
    const active = grab && 'adjustment' in grab ? grab.adjustment : grab?.made ?? hoveredAdjustment;
    drawDetail(
      detailCanvas, detail, shown, hoverX, playhead - mix.region.start, hoverY,
      active ? mix.adjustments.indexOf(active) : null, fadeDrag ?? hoveredFade,
    );
    showFigures();
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

/** A mix's fades in blocks. Together they can never be longer than the mix. */
function fades(m: Mix): { in: number; out: number } {
  const half = Math.floor((m.region.end - m.region.start) / 2);
  return { in: clamp(m.fadeIn ?? 0, 0, half), out: clamp(m.fadeOut ?? 0, 0, half) };
}

/**
 * Named loudness levels for where a mix is going. Each is a loudness for the
 * whole mix, breakdowns included, which is how platforms and broadcasters
 * measure it; that is a decibel or two below the full-energy target the
 * slider sets. Platform names are examples and should be easy to change.
 */
const LOUDNESS_PRESETS = [
  {
    id: 'loud',
    name: 'Loud',
    lufs: -9,
    note: 'For places that play the file as it is, next to mastered tracks: SoundCloud, Mixcloud, a club system. Leans on the limiter.',
  },
  {
    id: 'streaming',
    name: 'Streaming',
    lufs: -14,
    note: 'The level services such as YouTube and Spotify turn louder uploads down to. Going louder gains nothing there.',
  },
  { id: 'podcast', name: 'Podcast or radio show', lufs: -16, note: 'What podcast platforms and most stations that take pre-recorded shows ask for.' },
  { id: 'broadcast', name: 'Broadcast, EBU R128', lufs: -23, note: 'For broadcasters that require the European broadcast standard.' },
];
const AUTO_NOTE = 'As loud as the mix gets while staying clear of the limiter.';
const CUSTOM_NOTE = 'You set how loud the full-energy parts are. A higher level leans on the limiter.';

const presetOf = (m: Mix) => LOUDNESS_PRESETS.find((preset) => preset.id === m.loudness);

/**
 * Derives the gain curves of a mix from its region and settings, and everything
 * shown from them. With a loudness preset, the target is whatever puts the
 * whole mix on the preset's level.
 */
function compute(m: Mix): { detail: Detail; stats: Stats } {
  const preset = presetOf(m);
  if (!preset) return computeWith(m, m.options);
  // The loudness of the whole mix moves decibel for decibel with the target,
  // so one trial run shows how far off it is and a second lands on it.
  const trial = computeWith(m, { ...m.options, targetLufs: preset.lufs });
  const off = preset.lufs - trial.stats.loudnessOut;
  return Math.abs(off) < 0.05 ? trial : computeWith(m, { ...m.options, targetLufs: preset.lufs + off });
}

function computeWith(m: Mix, options: LevelOptions): { detail: Detail; stats: Stats } {
  const { measured } = recording!;
  const { start, end } = m.region;
  const shortTerm = measured.shortTerm.subarray(start, end);
  const restShortTerm = measured.restShortTerm.subarray(start, end);
  const peaksIn = measured.peaks.subarray(start, end);
  const blocksIn = measured.blocks.subarray(start, end);
  const n = end - start;
  const adjustments = m.adjustments.map((a) => ({ ...a, start: a.start - start, end: a.end - start }));

  const levelling = level(
    { shortTerm, lowShortTerm: measured.lowShortTerm.subarray(start, end), restShortTerm },
    options,
    { peaks: peaksIn, ceilingDb: m.ceilingDb },
    adjustments,
  );
  const { gainDb, targetLufs } = levelling;
  // The bass curve is shown and applied when anything moves the bass: the correction or a hand adjustment.
  const bassDb = options.bassCorrection > 0 || m.adjustments.some((a) => a.bass) ? levelling.bassDb : null;
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

  // The fades shape what is shown, but not the numbers above: the levelling
  // and the limiter estimate describe the music as if it were not faded.
  const fade = fades(m);
  for (let i = 0; i < n; i++) {
    const held = fadeGain(i + 0.5, n, fade.in, fade.out);
    if (held === 1) continue;
    peaksOut[i] *= held;
    bodyOut[i] *= held;
    loudnessOut[i] += 20 * Math.log10(Math.max(held, 1e-6));
  }

  return {
    detail: {
      startBlock: start, peaksIn, peaksOut, bodyOut, loudnessIn: shortTerm, loudnessOut, gainDb, bassDb, adjustments,
      fadeIn: fade.in, fadeOut: fade.out, targetLufs, ceiling,
    },
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

function overviewData(r: Recording) {
  const marks = (id: string) => r.checkup.findings.find((finding) => finding.id === id)?.marks ?? [];
  return { peaks: r.measured.peaks, body: r.body, gaps: r.gaps, clipping: marks('clipping'), dropouts: marks('dropouts') };
}

// ---------------------------------------------------------------------------
// The check-up: what the analysis noticed about the recording itself

const checkupDialog = $<HTMLDialogElement>('checkup-dialog');

/** Says in the header how much there is to know, and fills the panel behind it. */
function showCheckup() {
  const { findings, facts } = recording!.checkup;
  const button = $('checkup');
  button.hidden = false;
  button.classList.toggle('faults', findings.some((finding) => finding.kind === 'fault'));
  button.textContent =
    findings.length === 0 ? 'Nothing unusual found' : findings.length === 1 ? '1 thing to know' : `${findings.length} things to know`;
  button.title = 'What the analysis noticed about this recording';

  $('checkup-title').textContent = `About ${recording!.name}`;
  const list = $('checkup-findings');
  if (findings.length === 0) {
    const none = document.createElement('p');
    none.className = 'note';
    none.textContent = 'Nothing unusual found: no clipping, both channels present and in step, no gaps in the music.';
    list.replaceChildren(none);
  } else {
    list.replaceChildren(
      ...findings.map((finding) => {
        const item = document.createElement('div');
        item.className = `finding ${finding.kind}`;
        const title = document.createElement('b');
        title.textContent = finding.title;
        const detail = document.createElement('p');
        detail.textContent = finding.detail;
        item.append(title, detail);
        return item;
      }),
    );
  }
  $('checkup-facts').replaceChildren(
    ...facts.flatMap(([label, value]) => {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      return [term, description];
    }),
  );
}

$('checkup').addEventListener('click', () => checkupDialog.showModal());
$('checkup-close').addEventListener('click', () => checkupDialog.close());

/** Brings the detail view and the numbers up to date with the selected mix. */
function recompute() {
  if (!recording) return;
  try {
    const computed = compute(mix);
    detail = computed.detail;
    setStats(computed.stats);
    // Unless it was set by hand, the slider shows where the target ended up.
    if (mix.loudness || mix.options.targetLufs === undefined) {
      $('target-value').textContent = lufs(detail.targetLufs);
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
  $<HTMLButtonElement>('apply-all').disabled = !several;
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
    ...(mix.loudness ? { loudness: mix.loudness } : {}),
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
      ...(original.loudness ? { loudness: original.loudness } : {}),
    });
  }
  // The fade out belongs to the end of the music, which is now the last piece.
  if (regions.length > 1 && original.fadeOut) {
    mixes[mixes.length - 1].fadeOut = original.fadeOut;
    delete original.fadeOut;
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

/** Removes the selected mix, unless it is the only one. */
function deleteMix() {
  if (!recording || busy || mixes.length < 2) return;
  const index = mixes.indexOf(mix);
  const [removed] = mixes.splice(index, 1);
  select(mixes[Math.min(index, mixes.length - 1)]);
  // A key press can do this by accident, so say what happened and how to get it back.
  $('export-status').textContent = `Deleted ${removed.name}. ${COMMAND}Z brings it back.`;
}

$('delete-mix').addEventListener('click', deleteMix);

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
  hoverY = event.clientY - detailCanvas.getBoundingClientRect().top;
  const block = detailBlock(event);
  const found = grab ? null : adjustmentAt(event);
  hoveredAdjustment = found?.adjustment ?? null;
  hoveredFade = grab || fadeDrag ? null : fadeHandleAt(event);
  if (fadeDrag || hoveredFade) {
    detailCanvas.style.cursor = 'ew-resize';
    if (hoveredFade) $('readout').textContent = describeFade(hoveredFade);
    scheduleDraw();
    return;
  }
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
      (shownAdjustment
        ? `    ${shownAdjustment.bass ? 'bass ' : ''}adjusted by hand ${db(shownAdjustment.db)}: drag up or down, drag an edge to resize, double-click to remove`
        : '');
  }
  scheduleDraw();
});

detailCanvas.addEventListener('mouseleave', () => {
  hoverX = null;
  hoverY = null;
  hoveredAdjustment = null;
  hoveredFade = null;
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
/** The bass shelf is a tone control; it gets a narrower range than the overall gain. */
const MAX_BASS_ADJUSTMENT_DB = 6;
/** Whether a new adjustment drawn in the gain lane changes the bass only. */
let adjustBass = false;
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
  if (!recording || busy || !detail) return;
  fadeDrag = fadeHandleAt(event);
  if (fadeDrag) {
    event.preventDefault();
    return;
  }
  if (!inGainLane(event)) return;
  const found = adjustmentAt(event);
  if (!found) grab = { kind: 'create', anchor: detailBlock(event)!, x: event.clientX, made: null };
  else if (found.part === 'level') grab = { kind: 'level', adjustment: found.adjustment, y: event.clientY, db: found.adjustment.db };
  else grab = { kind: found.part, adjustment: found.adjustment };
  event.preventDefault();
});

// ---------------------------------------------------------------------------
// Fades: a handle near each top corner of the mix in the waveform lane,
// dragged inwards to set how long the fade is

let fadeDrag: 'in' | 'out' | null = null;
let hoveredFade: 'in' | 'out' | null = null;
const FADE_GRAB_PX = 9;

/** Where the fade handles are drawn, in pixels from the left of the detail view. */
function fadeHandleX(which: 'in' | 'out'): number | null {
  const fade = fades(mix);
  const block = which === 'in' ? mix.region.start + fade.in : mix.region.end - fade.out;
  if (block < view.start || block > view.end) return null;
  const plot = detailCanvas.clientWidth - GUTTER;
  return clamp(GUTTER + ((block - view.start) / (view.end - view.start)) * plot, GUTTER + 5, detailCanvas.clientWidth - 5);
}

function fadeHandleAt(event: MouseEvent): 'in' | 'out' | null {
  const rect = detailCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top - detailLanes(rect.height).wave.top;
  if (Math.abs(y - FADE_HANDLE_Y) > FADE_GRAB_PX) return null;
  // Where the two meet, in a very short mix, the nearer one wins.
  const reach = (which: 'in' | 'out') => {
    const at = fadeHandleX(which);
    return at === null ? Infinity : Math.abs(x - at);
  };
  const nearest = reach('in') <= reach('out') ? 'in' : 'out';
  return reach(nearest) <= FADE_GRAB_PX ? nearest : null;
}

function describeFade(which: 'in' | 'out'): string {
  const length = fades(mix)[which] * HOP_SECONDS;
  const name = which === 'in' ? 'Fade in' : 'Fade out';
  return length > 0
    ? `${name} ${length.toFixed(1)} s: drag to change, drag back to the corner to remove`
    : `${name}: drag inwards to add one`;
}

window.addEventListener('mousemove', (event) => {
  if (!fadeDrag) return;
  if (!grabMoved && Math.abs(event.clientX - grabX) < DRAG_START_PX) return;
  grabMoved = true;
  const rect = detailCanvas.getBoundingClientRect();
  const plot = rect.width - GUTTER;
  const x = clamp(event.clientX - rect.left - GUTTER, 0, plot);
  const block = view.start + (x / plot) * (view.end - view.start);
  const { start, end } = mix.region;
  const half = Math.floor((end - start) / 2);
  // Within a few pixels of the corner counts as no fade at all.
  const snap = (FADE_GRAB_PX / 2 / plot) * (view.end - view.start);
  const length = fadeDrag === 'in' ? block - start : end - block;
  const blocks = length <= snap ? 0 : clamp(Math.round(length), 0, half);
  if (fadeDrag === 'in') mix.fadeIn = blocks;
  else mix.fadeOut = blocks;
  if (!mix.fadeIn) delete mix.fadeIn;
  if (!mix.fadeOut) delete mix.fadeOut;
  $('readout').textContent = describeFade(fadeDrag);
  scheduleRecompute();
});

window.addEventListener('mouseup', () => {
  if (!fadeDrag) return;
  fadeDrag = null;
  scheduleDraw();
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
      grab.made = adjustBass ? { start: block, end: block, db: 0, bass: true } : { start: block, end: block, db: 0 };
      mix.adjustments.push(grab.made);
    }
    grab.made.start = Math.round(Math.min(block, grab.anchor));
    grab.made.end = Math.round(Math.max(block, grab.anchor));
  } else if (grab.kind === 'level') {
    const moved = grab.db - (event.clientY - grab.y) / PIXELS_PER_DB;
    const limit = grab.adjustment.bass ? MAX_BASS_ADJUSTMENT_DB : MAX_ADJUSTMENT_DB;
    grab.adjustment.db = clamp(Math.round(moved * 10) / 10, -limit, limit);
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

function setAdjustBass(bass: boolean) {
  adjustBass = bass;
  $('adjust-bass').classList.toggle('on', bass);
  $('adjust-level').classList.toggle('on', !bass);
}

$('adjust-level').addEventListener('click', () => setAdjustBass(false));
$('adjust-bass').addEventListener('click', () => setAdjustBass(true));

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

/** A change in dB as it reads in the narrow column under the meter. */
function signed(value: number): string {
  // Rounded first, so that a hair under zero does not read as "−0.0".
  const rounded = Math.round(value * 10) / 10;
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}`;
}

/**
 * The figures under the meter: the loudness at the playhead and what the
 * levelling does there. They come from the same curves as the lanes, so the
 * two always agree; the loudness does not know what the limiter takes off.
 */
function showFigures() {
  if (!recording || !detail) {
    levelMeter.setFigures([]);
    return;
  }
  const seconds = player.time;
  const inside = seconds >= mix.region.start * HOP_SECONDS && seconds < mix.region.end * HOP_SECONDS;
  const loudness = inside ? curveAt(hearLevelled ? detail.loudnessOut : detail.loudnessIn, seconds) : NaN;
  const applied = inside && hearLevelled;
  levelMeter.setFigures([
    ['LUFS', loudness > -60 ? loudness.toFixed(1).replace('-', '−') : '–', hearLevelled ? '#3ddc97' : '#e6e8ec'],
    ['gain', applied ? signed(curveAt(detail.gainDb, seconds)) : '–', '#f2a83b'],
    ...(detail.bassDb ? [['bass', applied ? signed(bassAt(seconds)) : '–', '#6aa9ff'] as MeterFigure] : []),
  ]);
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
  const fade = fades(mix);
  const held = hearLevelled ? fadeGain(time / HOP_SECONDS - start, end - start, fade.in, fade.out) : 1;
  player.apply(hearLevelled ? gainAt(time) : 1, hearLevelled ? bassAt(time) : 0, held, {
    ceilingDb: mix.ceilingDb,
    bypass: !hearLevelled,
  });
  const [left, right] = player.outputPeaks();
  const block = clamp(Math.floor(time / HOP_SECONDS), 0, recording.measured.peaks.length - 1);
  levelMeter.update({
    left,
    right,
    reductionDb: hearLevelled ? limiterReductionDb : 0,
    sourceClipped: recording.measured.diagnostics.clipped[block] >= 3,
    ceilingDb: mix.ceilingDb,
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
    $('export-status').textContent = `Cannot play this recording here (${message(error)}). Export still works.`;
  }
}

function setHearLevelled(levelled: boolean) {
  hearLevelled = levelled;
  $('hear-levelled').classList.toggle('on', levelled);
  $('hear-original').classList.toggle('on', !levelled);
  scheduleDraw();
}

player.onPlay = () => {
  showPlaying(true);
  follow();
};
player.onPause = () => {
  showPlaying(false);
  limiterReductionDb = 0;
  levelMeter.release();
  showPlayback();
};
player.onSeek = showPlayback;

// The limiter reports how hard it worked many times a second, for the meter.
player.onReport = ({ gain }) => {
  if (player.paused) return;
  limiterReductionDb = -20 * Math.log10(gain);
};

/** Shows the play button as play or pause, to match what pressing it would do. */
function showPlaying(playing: boolean) {
  const button = $('play');
  button.classList.toggle('playing', playing);
  button.title = playing ? 'Pause (Space)' : 'Play (Space)';
  button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

$('play').addEventListener('click', togglePlay);
$('hear-original').addEventListener('click', () => setHearLevelled(false));
$('hear-levelled').addEventListener('click', () => setHearLevelled(true));

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'text') return;
  // While a dialog is up, the keys belong to it.
  if (exportDialog.open || checkupDialog.open || helpDialog.open) return;
  if (event.code === 'Space') {
    event.preventDefault();
    // Otherwise a focused button would also act on the same key press.
    if (event.target instanceof HTMLButtonElement) event.target.blur();
    togglePlay();
  } else if (event.key === '?') {
    // F1 does the same, through the Help menu.
    showHelp();
  } else if (event.code === 'KeyA' && !event.metaKey && !event.ctrlKey) {
    setHearLevelled(!hearLevelled);
  } else if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    // Arrow keys on a slider or a list belong to it.
  } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault();
    const step = event.altKey ? STEP_FINE_SECONDS : event.shiftKey ? STEP_COARSE_SECONDS : STEP_SECONDS;
    stepPlayhead(event.code === 'ArrowLeft' ? -step : step);
  } else if (event.code === 'Backspace' || event.code === 'Delete') {
    event.preventDefault();
    // The stretch under the pointer, if there is one; otherwise the mix.
    if (hoveredAdjustment) removeAdjustment(hoveredAdjustment);
    else deleteMix();
  } else if (event.code === 'Home' || event.code === 'Enter') {
    event.preventDefault();
    toStart();
  } else if (event.code === 'End') {
    event.preventDefault();
    toEnd();
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

function toEnd() {
  if (recording) seek(Math.max(mix.region.start, mix.region.end - END_PREVIEW_BLOCKS) * HOP_SECONDS);
}

$('to-start').addEventListener('click', toStart);
$('to-end').addEventListener('click', toEnd);

// Back and forward step once on a press and keep stepping while held, like the arrow keys do.
const HOLD_DELAY_MS = 350;
const HOLD_EVERY_MS = 110;
for (const [id, direction] of [['rewind', -1], ['forward', 1]] as const) {
  const button = $(id);
  let holding: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(holding);
    clearInterval(holding);
    holding = undefined;
  };
  const step = (event: MouseEvent) => {
    stepPlayhead(direction * (event.altKey ? STEP_FINE_SECONDS : event.shiftKey ? STEP_COARSE_SECONDS : STEP_SECONDS));
  };
  button.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !recording || busy) return;
    step(event);
    stop();
    holding = setTimeout(() => {
      holding = setInterval(() => step(event), HOLD_EVERY_MS);
    }, HOLD_DELAY_MS);
  });
  button.addEventListener('mouseup', stop);
  button.addEventListener('mouseleave', stop);
  // A press of the mouse has already stepped; this is for the button being worked from the keyboard.
  button.addEventListener('click', (event) => {
    if (event.detail === 0 && recording && !busy) step(event);
  });
}

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
  const preset = presetOf(mix);
  const choice = preset ? preset.id : mix.options.targetLufs === undefined ? 'auto' : 'custom';
  $<HTMLSelectElement>('loudness').value = choice;
  $('loudness-note').textContent = preset ? preset.note : choice === 'auto' ? AUTO_NOTE : CUSTOM_NOTE;
  if (choice === 'custom') {
    $<HTMLInputElement>('target').value = String(mix.options.targetLufs);
    $('target-value').textContent = lufs(mix.options.targetLufs!);
  }
}

$<HTMLSelectElement>('loudness').replaceChildren(
  new Option('As loud as fits', 'auto'),
  ...LOUDNESS_PRESETS.map((preset) => new Option(`${preset.name} (${preset.lufs} LUFS)`, preset.id)),
  new Option('Custom', 'custom'),
);

for (const slider of sliders) {
  $<HTMLInputElement>(slider.id).addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    slider.set(value);
    $(`${slider.id}-value`).textContent = slider.format(value);
    scheduleRecompute();
  });
}

// Moving the slider is choosing a level by hand.
$<HTMLInputElement>('target').addEventListener('input', (event) => {
  delete mix.loudness;
  mix.options.targetLufs = Number((event.target as HTMLInputElement).value);
  syncControls();
  scheduleRecompute();
});

$<HTMLSelectElement>('loudness').addEventListener('change', (event) => {
  const choice = (event.target as HTMLSelectElement).value;
  if (choice === 'auto' || choice === 'custom') delete mix.loudness;
  else mix.loudness = choice;
  // Custom starts from the level in use; everything else works its own out.
  mix.options.targetLufs = choice === 'custom' ? Number($<HTMLInputElement>('target').value) : undefined;
  syncControls();
  scheduleRecompute();
});

$('reset').addEventListener('click', () => {
  mix.options = { ...DEFAULT_LEVEL_OPTIONS };
  mix.ceilingDb = DEFAULT_CEILING_DB;
  delete mix.loudness;
  syncControls();
  scheduleRecompute();
});

// Gives every other mix the settings of this one. Fades and hand adjustments
// belong to a particular place in a particular mix, so they are left alone.
$('apply-all').addEventListener('click', () => {
  if (!recording || busy || mixes.length < 2) return;
  for (const other of mixes) {
    if (other === mix) continue;
    other.options = { ...mix.options };
    other.ceilingDb = mix.ceilingDb;
    if (mix.loudness) other.loudness = mix.loudness;
    else delete other.loudness;
  }
  const others = mixes.length - 1;
  $('readout').textContent = `These settings now apply to the other ${others === 1 ? 'mix' : `${others} mixes`} too. Undo takes it back.`;
  scheduleSave();
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
  $<HTMLButtonElement>('empty-open').disabled = busy;
  $<HTMLButtonElement>('export').disabled = busy || !recording;
  $<HTMLButtonElement>('export-all').disabled = busy || !recording;
  $<HTMLButtonElement>('play').disabled = busy || !recording;
  for (const id of ['to-start', 'rewind', 'forward', 'to-end']) $<HTMLButtonElement>(id).disabled = busy || !recording;
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
      checkup: checkup(measured),
    };
    showCheckup();
    overviewShown = { start: 0, end: measured.peaks.length };
    player.load(await api.mediaUrl(path));
    $('file-name').textContent = name;
    $('file-name').classList.add('loaded');
    $('empty').hidden = true;
    $('settings').inert = false;
    $('views').hidden = false;
    const restored = restore(await api.recall(path), measured.peaks.length);
    select(mixes[restored.selected]);
    undoSteps = [];
    redoSteps = [];
    settled = snapshot();
    showHistory();
    if (restored.fromLastTime) $('export-status').textContent = 'Picked up where you left off.';
    requestAnimationFrame(() => requestAnimationFrame(() => api.painted(path)));
  } catch (error) {
    $('export-status').textContent = wasCancelled(error) ? 'Analysis cancelled.' : `Could not open ${name}: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

/** The recordings opened lately, on the start screen. One click opens one. */
async function showRecent() {
  const recent = await api.recent();
  $('recent').hidden = recent.length === 0;
  $('recent-list').replaceChildren(
    ...recent.map(({ path, name, folder }) => {
      const item = document.createElement('button');
      item.className = 'recent-item';
      for (const [kind, text] of [['name', name], ['folder', folder]]) {
        const line = document.createElement('span');
        line.className = kind;
        // The mark keeps the leading slash in place where the folder is cut from the left.
        line.textContent = kind === 'folder' ? `\u200e${text}` : text;
        item.append(line);
      }
      item.title = `Open ${name}`;
      item.addEventListener('click', async () => {
        // Gone since the list was drawn: take it off the list rather than complain.
        if ((await api.existing([path])).length > 0) open(path);
        else showRecent();
      });
      return item;
    }),
  );
}
api.onRecentChanged(showRecent);

/** Back to the empty window. The work on the recording is saved, as always. */
function closeRecording() {
  if (!recording || busy) return;
  if (saveTimer !== undefined) saveNow();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  player.unload();
  levelMeter.release();
  recording = null;
  mixes = [];
  detail = null;
  drag = null;
  grab = null;
  undoSteps = [];
  redoSteps = [];
  settled = null;
  $('file-name').textContent = 'No recording open';
  $('file-name').classList.remove('loaded');
  $('checkup').hidden = true;
  $('export-all-group').hidden = true;
  $('export-status').textContent = '';
  $('views').hidden = true;
  $('empty').hidden = false;
  // The settings shown were that recording's; they mean nothing now.
  $('settings').inert = true;
  $('settings-for').textContent = '';
  $('target-value').textContent = '';
  $('stat-adjustments').textContent = '–';
  setStats(null);
  setBusy(null);
  api.closed();
  showRecent();
}

for (const id of ['open', 'empty-open']) {
  $(id).addEventListener('click', async () => {
    const path = await api.pickFile();
    if (path) open(path);
  });
}

// ---------------------------------------------------------------------------
// Remembering the work on a recording between sessions

interface Session {
  version: 1;
  /** Length of the recording in blocks when saved; a different length means a different file. */
  blocks: number;
  selected: number;
  mixesCreated: number;
  mixes: Mix[];
  album?: string;
}

interface Defaults {
  options: LevelOptions;
  ceilingDb: number;
  loudness?: string;
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
    album,
  };
  const defaults: Defaults = { options: mix.options, ceilingDb: mix.ceilingDb, ...(mix.loudness ? { loudness: mix.loudness } : {}) };
  api.remember(recording.path, { session, defaults: { ...defaults, export: exportSettings } });
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
const isPreset = (value: unknown): value is string => LOUDNESS_PRESETS.some((preset) => preset.id === value);

/**
 * Sets up the mixes for a newly opened recording: the ones marked in it last
 * time, or else a single mix covering all of it with the settings last in use.
 * What comes back from disk is checked, since it may be old or damaged.
 */
function restore(remembered: { session: unknown; defaults: unknown }, total: number) {
  const savedDefaults = remembered.defaults as (Partial<Defaults> & { export?: Partial<ExportSettings> }) | null;
  const saved = savedDefaults?.export ?? {};
  exportSettings = {
    format: (['wav', 'flac', 'mp3', 'm4a'] as const).find((format) => format === saved.format) ?? DEFAULT_EXPORT_SETTINGS.format,
    bitDepth: saved.bitDepth === 24 ? 24 : 16,
    mp3Kbps: BITRATES.mp3.find((kbps) => kbps === saved.mp3Kbps) ?? DEFAULT_EXPORT_SETTINGS.mp3Kbps,
    aacKbps: BITRATES.m4a.find((kbps) => kbps === saved.aacKbps) ?? DEFAULT_EXPORT_SETTINGS.aacKbps,
    sampleRate: SAMPLE_RATES.find((rate) => rate === saved.sampleRate) ?? null,
    lossyHeadroom: saved.lossyHeadroom !== false,
  };
  const defaults: Defaults = {
    options: { ...DEFAULT_LEVEL_OPTIONS, ...(savedDefaults?.options ?? {}) },
    ceilingDb: isNumber(savedDefaults?.ceilingDb) ? savedDefaults.ceilingDb : DEFAULT_CEILING_DB,
    ...(isPreset(savedDefaults?.loudness) ? { loudness: savedDefaults.loudness } : {}),
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
      ).map((a) => (a.bass === true ? { start: a.start, end: a.end, db: a.db, bass: true } : { start: a.start, end: a.end, db: a.db })),
      ...(typeof m.artist === 'string' && m.artist ? { artist: m.artist } : {}),
      ...(isPreset(m.loudness) ? { loudness: m.loudness } : {}),
      ...(isNumber(m.fadeIn) && m.fadeIn > 0 ? { fadeIn: Math.round(m.fadeIn) } : {}),
      ...(isNumber(m.fadeOut) && m.fadeOut > 0 ? { fadeOut: Math.round(m.fadeOut) } : {}),
    }));
    album = typeof session!.album === 'string' ? session!.album : '';
    mixesCreated = Math.max(mixes.length, isNumber(session!.mixesCreated) ? session!.mixesCreated : 0);
    const selected = isNumber(session!.selected) ? clamp(session!.selected, 0, mixes.length - 1) : 0;
    return { selected, fromLastTime: true };
  }

  mixes = [{ name: 'Mix 1', region: { start: 0, end: total }, ...defaults, adjustments: [] }];
  album = '';
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
  $('export-status').textContent = '';
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

// A newer version is mentioned in the header and nowhere else: no dialog, nothing to dismiss.
api.onUpdateAvailable((version) => {
  const note = $('update-note');
  const link = (text: string, title: string, action: () => void) => {
    const a = document.createElement('a');
    a.textContent = text;
    a.title = title;
    a.addEventListener('click', action);
    return a;
  };
  note.replaceChildren(
    `Version ${version} is available. `,
    link('Download', 'Opens the download page in your browser', () => api.openDownloadPage()),
    ' · ',
    link('Skip', 'Do not mention this version again', () => {
      api.skipVersion(version);
      note.hidden = true;
    }),
  );
  note.hidden = false;
});

// ---------------------------------------------------------------------------
// Help: everything the window responds to, on one page, in place of hints
// printed permanently under each view

const helpDialog = $<HTMLDialogElement>('help-dialog');
const onMac = navigator.userAgent.includes('Mac');
const COMMAND = onMac ? '⌘' : 'Ctrl+';
const OPTION = onMac ? 'Option' : 'Alt';
$('undo').title = `Undo the last change (${COMMAND}Z)`;
$('redo').title = `Redo the change just undone (Shift+${COMMAND}Z)`;

const HELP: [string, [string, string][]][] = [
  ['The recording, at the top', [
    ['Drag across a free part', 'Mark a new mix'],
    ['Drag a mix\'s edge', 'Move where it starts or ends'],
    ['Drag the middle of a mix', 'Move it'],
    ['Click inside a mix', 'Select it and put the playhead there'],
    ['Click a mix\'s edge', 'Jump to its start, or just before its end'],
    ['Scroll, or pinch', 'Zoom in and out'],
    ['Swipe sideways', 'Move along the recording'],
    ['Orange, red and white marks', 'Silences, clipping and possible dropouts'],
  ]],
  ['The mix, below it', [
    ['Click', 'Put the playhead there'],
    ['Scroll, or pinch', 'Zoom in and out'],
    ['Swipe sideways', 'Move along the mix'],
    ['Drag a square handle inwards', 'Fade in or out; back to the corner removes it'],
    ['Drag across the gain lane', 'Mark a stretch to adjust by hand'],
    ['Drag a marked stretch up or down', 'Raise or lower it'],
    ['Drag a stretch\'s edge', 'Make it longer or shorter'],
    ['Double-click a stretch', 'Remove it (or point at it and press Backspace)'],
  ]],
  ['Playback', [
    ['Space', 'Play or pause'],
    ['A', 'Switch between original and levelled'],
    ['← →', 'Back or forward 5 seconds'],
    [`Shift+← →, ${OPTION}+← →`, '30 seconds, 1 second'],
    ['Return', 'Jump to the start of the mix'],
    ['End', 'Jump to just before its end'],
  ]],
  ['Everything else', [
    [`${COMMAND}Z, Shift+${COMMAND}Z`, 'Undo, redo'],
    ['Backspace', 'Delete the selected mix'],
    [`${COMMAND}O`, 'Open a recording'],
    [`Shift+${COMMAND}W`, 'Close the recording'],
    ['Esc', 'Cancel an analysis or an export'],
    ['? or F1', 'Show this sheet'],
    ['Double-click a mix\'s tab', 'Rename it'],
    ['Rest the pointer on a control', 'See what it does'],
  ]],
];

$('help-content').replaceChildren(
  ...HELP.map(([title, rows]) => {
    const section = document.createElement('section');
    const heading = document.createElement('h4');
    heading.textContent = title;
    section.append(
      heading,
      ...rows.map(([what, does]) => {
        const row = document.createElement('div');
        row.className = 'how';
        const left = document.createElement('span');
        left.textContent = what;
        const right = document.createElement('span');
        right.textContent = does;
        row.append(left, right);
        return row;
      }),
    );
    return section;
  }),
);

function showHelp() {
  if (!helpDialog.open) helpDialog.showModal();
}

$('help').addEventListener('click', showHelp);
$('help-close').addEventListener('click', () => helpDialog.close());

api.onMenu(async (command) => {
  if (command === 'help') {
    showHelp();
    return;
  }
  if (command === 'close') {
    closeRecording();
    return;
  }
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

// ---------------------------------------------------------------------------
// Export settings and the dialog that asks for them

type ExportFormat = 'wav' | 'flac' | 'mp3' | 'm4a';

interface ExportSettings {
  format: ExportFormat;
  bitDepth: 16 | 24;
  mp3Kbps: number;
  aacKbps: number;
  /** Sample rate of the exported file, or null to keep the recording's. */
  sampleRate: number | null;
  /** Whether MP3 and AAC exports are made a little quieter to leave room for the encoding. */
  lossyHeadroom: boolean;
}

const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  format: 'wav', bitDepth: 16, mp3Kbps: 320, aacKbps: 256, sampleRate: null, lossyHeadroom: true,
};
const BITRATES: Record<'mp3' | 'm4a', number[]> = { mp3: [320, 256, 192, 128], m4a: [320, 256, 192, 128] };
const SAMPLE_RATES = [44100, 48000];
/** Above this a WAV has to be written in an extended form that not every player reads. */
const WAV_LIMIT_BYTES = 4 * 1024 ** 3;

/** The settings last used, kept between sessions with the other defaults. */
let exportSettings: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS };
const exportDialog = $<HTMLDialogElement>('export-dialog');
/** The mixes the open dialog is about, for its size estimate. */
let exportingMixes: Mix[] = [];

const kHz = (rate: number) => `${rate / 1000} kHz`;

/** Roughly how large one exported mix will be, in bytes. */
function estimatedBytes(m: Mix, settings: ExportSettings): number {
  const seconds = (m.region.end - m.region.start) * HOP_SECONDS;
  if (settings.format === 'mp3') return (seconds * settings.mp3Kbps * 1000) / 8;
  if (settings.format === 'm4a') return (seconds * settings.aacKbps * 1000) / 8;
  const rate = settings.sampleRate ?? recording!.measured.sampleRate;
  const pcm = seconds * rate * 2 * (settings.bitDepth / 8);
  // FLAC typically packs dense dance music to around two thirds.
  return settings.format === 'flac' ? pcm * 0.65 : pcm;
}

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Shows the dialog's controls for the current settings. */
function showExportSettings() {
  const settings = exportSettings;
  const lossless = settings.format === 'wav' || settings.format === 'flac';
  for (const button of $('export-format').querySelectorAll('button')) {
    button.classList.toggle('on', button.dataset.format === settings.format);
  }
  for (const button of $('export-depth').querySelectorAll('button')) {
    button.classList.toggle('on', Number(button.dataset.depth) === settings.bitDepth);
  }
  $('export-depth-field').hidden = !lossless;
  $('export-bitrate-field').hidden = lossless;
  $('export-headroom-field').hidden = lossless;
  $<HTMLInputElement>('export-headroom').checked = settings.lossyHeadroom;
  if (!lossless) {
    const format = settings.format as 'mp3' | 'm4a';
    const chosen = format === 'mp3' ? settings.mp3Kbps : settings.aacKbps;
    $('export-bitrate').replaceChildren(
      ...BITRATES[format].map((kbps) => new Option(`${kbps} kbps`, String(kbps), false, kbps === chosen)),
    );
  }
  const own = recording!.measured.sampleRate;
  $('export-rate').replaceChildren(
    new Option(`Same as the recording (${kHz(own)})`, '', false, settings.sampleRate === null),
    ...SAMPLE_RATES.filter((rate) => rate !== own).map(
      (rate) => new Option(kHz(rate), String(rate), false, rate === settings.sampleRate),
    ),
  );

  const sizes = exportingMixes.map((m) => estimatedBytes(m, settings));
  const total = sizes.reduce((a, b) => a + b, 0);
  let note = exportingMixes.length > 1 ? `About ${size(total)} in ${exportingMixes.length} files.` : `About ${size(total)}.`;
  if (settings.format === 'wav' && sizes.some((bytes) => bytes > WAV_LIMIT_BYTES)) {
    note += ' Over 4 GB, a WAV is written in an extended form that some players and DJ gear cannot read. FLAC avoids this.';
  } else if (lossless && settings.bitDepth === 16) {
    note += ' 16-bit is dithered, so quiet passages and fades stay clean.';
  }
  $('export-note').textContent = note;
}

for (const button of $('export-format').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    exportSettings.format = button.dataset.format as ExportFormat;
    showExportSettings();
  });
}
for (const button of $('export-depth').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    exportSettings.bitDepth = Number(button.dataset.depth) as 16 | 24;
    showExportSettings();
  });
}
$<HTMLSelectElement>('export-bitrate').addEventListener('change', (event) => {
  const kbps = Number((event.target as HTMLSelectElement).value);
  if (exportSettings.format === 'mp3') exportSettings.mp3Kbps = kbps;
  else exportSettings.aacKbps = kbps;
  showExportSettings();
});
$<HTMLSelectElement>('export-rate').addEventListener('change', (event) => {
  const value = (event.target as HTMLSelectElement).value;
  exportSettings.sampleRate = value ? Number(value) : null;
  showExportSettings();
});
$<HTMLInputElement>('export-headroom').addEventListener('change', (event) => {
  exportSettings.lossyHeadroom = (event.target as HTMLInputElement).checked;
});
$('export-cancel').addEventListener('click', () => exportDialog.close('cancel'));

/** One row of the dialog's tag list per mix being exported: its title and who played it. */
function showExportTags(forMixes: Mix[]) {
  const head = (text: string) => {
    const cell = document.createElement('span');
    cell.className = 'head';
    cell.textContent = text;
    return cell;
  };
  const field = (value: string, placeholder: string) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value;
    input.placeholder = placeholder;
    return input;
  };
  const rows = forMixes.flatMap((m) => {
    const number = document.createElement('span');
    number.className = 'number';
    number.textContent = String(mixes.indexOf(m) + 1);
    // An unnamed mix shows what it would be called, as a hint, not as text to keep.
    const title = field(hasDefaultName(m) ? '' : m.name, exportName(m));
    title.dataset.tag = 'title';
    const artist = field(m.artist ?? '', 'Artist');
    artist.dataset.tag = 'artist';
    return [number, title, artist];
  });
  $('export-tags').replaceChildren(head(''), head('Title'), head('Artist'), ...rows);
  $<HTMLInputElement>('export-album').value = album;
}

/** Takes the titles, artists and album typed into the dialog over into the mixes. */
function applyExportTags(forMixes: Mix[]) {
  const inputs = [...$('export-tags').querySelectorAll('input')];
  forMixes.forEach((m, index) => {
    const title = inputs[index * 2].value.trim();
    const artist = inputs[index * 2 + 1].value.trim();
    if (title) m.name = title;
    if (artist) m.artist = artist;
    else delete m.artist;
  });
  album = $<HTMLInputElement>('export-album').value.trim();
  showMix();
}

/** Asks how to export the given mixes. Resolves to false if the dialog is cancelled. */
function askExportSettings(title: string, forMixes: Mix[]): Promise<boolean> {
  exportingMixes = forMixes;
  $('export-title').textContent = title;
  $('export-go').textContent = forMixes.length > 1 ? 'Choose a folder…' : 'Choose where to save…';
  // If the recording's own rate was chosen explicitly before, that is the same as keeping it.
  if (exportSettings.sampleRate === recording!.measured.sampleRate) exportSettings.sampleRate = null;
  showExportSettings();
  showExportTags(forMixes);
  const before = { ...exportSettings };
  exportDialog.returnValue = '';
  exportDialog.showModal();
  return new Promise((resolve) => {
    exportDialog.addEventListener(
      'close',
      () => {
        // Only the dialog's own button goes ahead; Esc and Cancel do not, and
        // they leave the settings as they were.
        const go = exportDialog.returnValue === 'go';
        if (go) {
          applyExportTags(forMixes);
          scheduleSave();
        } else {
          exportSettings = before;
        }
        resolve(go);
      },
      { once: true },
    );
  });
}

/** The encoder's view of the export settings and of a mix's tags. `track` is its place among several. */
function encodeOptions(m: Mix, track?: string): EncodeOptions {
  const { format, bitDepth, mp3Kbps, aacKbps, sampleRate } = exportSettings;
  return {
    title: exportName(m),
    artist: m.artist,
    album: album || undefined,
    track,
    sampleRate: sampleRate ?? undefined,
    bitDepth: format === 'wav' || format === 'flac' ? bitDepth : undefined,
    bitrateKbps: format === 'mp3' ? mp3Kbps : format === 'm4a' ? aacKbps : undefined,
  };
}

function renderMix(m: Mix, output: string, track?: string) {
  const { gainDb, bassDb } = compute(m).detail;
  return api.render({
    input: recording!.path,
    output,
    start: m.region.start * HOP_SECONDS,
    end: m.region.end * HOP_SECONDS,
    gainDb,
    bassDb: bassDb ?? new Float32Array(gainDb.length),
    ceilingDb: m.ceilingDb,
    encode: encodeOptions(m, track),
    headroomDb: isLossy(output) && exportSettings.lossyHeadroom ? LOSSY_HEADROOM_DB : 0,
    fadeInSeconds: fades(m).in * HOP_SECONDS,
    fadeOutSeconds: fades(m).out * HOP_SECONDS,
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
  if (!(await askExportSettings(`Export “${exportName(mix)}”`, [mix]))) return;
  const folder = recording.path.replace(/[^\\/]+$/, '');
  const output = await api.pickOutput(`${folder}${fileName(exportName(mix))}.${exportSettings.format}`);
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
  if (!(await askExportSettings(`Export all ${mixes.length} mixes`, mixes))) return;
  const folder = await api.pickFolder();
  if (!folder) return;
  const extension = exportSettings.format;
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
      await renderMix(m, outputs[index], `${index + 1}/${mixes.length}`);
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
initTooltips();
api.onOpenFile(open);
showRecent();
api.initialFile().then((path) => {
  if (path) open(path);
});
