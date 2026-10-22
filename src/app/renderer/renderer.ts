import { shortcuts } from '../shortcuts.ts';
import { settingsDialog } from './settings.ts';
import { DEFAULT_LEVEL_OPTIONS, type Adjustment, type LevelOptions } from '../../gain-curve.ts';
import { isLossy, LOSSY_HEADROOM_DB, type EncodeOptions } from '../../encode-options.ts';
import { fadeGain } from '../../fade.ts';
import { findGaps, soundBetween } from '../../gaps.ts';
import { level } from '../../level.ts';
import { HOP_SECONDS, integratedLoudness } from '../../loudness.ts';
import { checkup, type Checkup } from '../../checkup.ts';
import type { Examination } from '../../master.ts';
import type { VideoInfo } from '../../audio-io.ts';
import type { Api, FineWave, VideoMixInfo, VisualsChoice } from '../api.ts';
import { clock, detailLanes, displayGain, drawDetail, drawEq, drawOverview, type EqBackdrop, FADE_HANDLE_Y, GUTTER, type Detail, type MarkerBox, type Region } from './draw.ts';
import { LevelMeter, type MeterFigure } from './meter.ts';
import { colours, onThemeChange } from './theme.ts';
import { VideoView } from './video-view.ts';
import { templateOf, VIDEO_RECORDING_TEMPLATE } from './video-frame.ts';
import { Player } from './player.ts';
import { isUnmixed, loudnessChangeDb, then, UNMIXED, type ChannelMix } from '../../channels.ts';
import { bandShares, bandSpectrum, checkedEq, EQ_RANGES_HZ, FLAT_EQ, isFlat, withEq, type Eq, type EqOutput } from '../../eq.ts';
import { BANDS } from '../../bands.ts';
import { Rta } from './rta.ts';
import { chaptersOf, listTime, parseTime, parseTracklist, shownName, splitName, spreadEvenly, youtubeList, type ListedTrack, type MixTrack, type Track } from '../../tracks.ts';
import { initTooltips } from './tooltip.ts';
import { initFaderReset, resetsTo } from './fader-reset.ts';
import { cancelSave, saveDue, saveLater } from './saving.ts';
import { SHAPES, shapeOf } from '../../visuals/shape.ts';
import { originalPictureExtension } from '../video-files.ts';

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
const MIN_VIEW_BLOCKS = Math.round(0.5 / HOP_SECONDS);
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
  /** The picture, when the recording is a video. */
  video: VideoInfo | null;
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
  /**
   * The mix's edges to the millisecond. `region` is in whole blocks, as the
   * curves need it, and always covers the mix. These say how far into its
   * first block the mix really starts, and how far short of the end of its
   * last block it stops, as fractions of a block. Absent means none. Two
   * mixes cut apart inside a block therefore share that block.
   */
  trimStart?: number;
  trimEnd?: number;
  /** Length in blocks of the fade at the start and at the end; absent means none. */
  fadeIn?: number;
  fadeOut?: number;
  /** A loudness preset in use, by id. It decides the target in place of the one in `options`. */
  loudness?: string;
  /** The template of the mix's video and what was filled in for it, set in the visuals window. */
  visuals?: VisualsChoice;
  /**
   * A corrective EQ for how this stretch was recorded; absent means flat. It
   * belongs to the mix rather than the recording, as one DJ of a night may
   * have played records through a faulty phono stage and the next a CDJ.
   */
  eq?: Eq;
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
/** For a recording that is a video: how much later than its sound its picture is shown, to put the two in step. */
let pictureDelayMs = 0;
/** As much as a recorder's picture and sound are ever likely to be apart. */
const MOST_PICTURE_DELAY_MS = 10_000;
/**
 * Where each track played starts, in order. They belong to the recording, not
 * to a mix, so moving a mix's edges or splitting it never moves one; each mix
 * has the ones inside it.
 */
let tracks: Track[] = [];
/** The track marker last clicked, which Backspace removes. */
let selectedTrack: Track | null = null;
/**
 * The check-up's findings whose fix is in use, by their ids: the recording's
 * channels put right (see channels.ts), in playback, the levelling and every
 * export. They belong to the recording, as the fault does.
 */
let channelFixes: string[] = [];
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

// The Video view: the selected mix's video in place of the curves, its
// template in place of the levelling settings. See video-view.ts.
/** A mix as its video sees it: name, place, length, and the template chosen for it. */
/**
 * The template chosen for a mix's video and what was filled in, or, where
 * nobody chose one and the recording is a video, its own picture.
 */
function visualsOf(m: Mix): VisualsChoice | undefined {
  return m.visuals ?? (recording?.video ? { template: VIDEO_RECORDING_TEMPLATE, fields: {} } : undefined);
}

function videoMixOf(m: Mix): VideoMixInfo {
  const at = edges(m);
  const visuals = visualsOf(m);
  return {
    path: recording!.path,
    recordingName: recording!.name.replace(/\.[^.]+$/, ''),
    name: m.name,
    number: mixes.indexOf(m) + 1,
    count: mixes.length,
    start: at.start * HOP_SECONDS,
    end: at.end * HOP_SECONDS,
    artist: m.artist ?? '',
    album,
    visuals,
    shape: shapeOf(visuals?.shape),
    template: templateOf(visuals),
    tracks: mixTracks(m),
    fadeIn: fades(m).in * HOP_SECONDS,
    fadeOut: fades(m).out * HOP_SECONDS,
    video: recording!.video,
    pictureDelay: pictureDelayMs / 1000,
  };
}

const videoView = new VideoView({
  api,
  mix: () => (recording ? videoMixOf(mix) : null),
  playhead: () => player.time,
  playing: () => !player.paused,
  rate: () => player.rate,
  seek: (seconds) => seek(clamp(seconds, edges(mix).start * HOP_SECONDS, edges(mix).end * HOP_SECONDS)),
  levels: (points) => {
    // The loudest moment in each step of the mix, as the recording timeline
    // draws it, made larger when the mix was recorded quietly.
    const out = new Float32Array(points);
    if (!recording) return out;
    const { start, end } = mix.region;
    const peaks = recording.measured.peaks;
    const gain = displayGain(peaks.subarray(start, end));
    for (let p = 0; p < points; p++) {
      const from = Math.floor(start + ((end - start) * p) / points);
      const to = Math.max(from + 1, Math.floor(start + ((end - start) * (p + 1)) / points));
      let peak = 0;
      for (let b = from; b < to && b < peaks.length; b++) peak = Math.max(peak, peaks[b]);
      out[p] = Math.min(1, peak * gain);
    }
    return out;
  },
  choose: (choice) => {
    if (!recording) return;
    mix.visuals = choice;
    scheduleSave();
  },
  say: (text) => {
    $('readout').textContent = text || ' ';
  },
  history: () => showHistory(),
  editingChanged: () => rememberView(),
});

/** Switches between the Mastering and the Video view. */
function showVideo(on: boolean) {
  document.body.classList.toggle('video', on);
  $('view-video').classList.toggle('on', on);
  $('view-mastering').classList.toggle('on', !on);
  videoView.show(on);
  if (!on) scheduleDraw();
  rememberView();
}

/** Whether the view the window starts in has been put back yet: until then, the one shown is not a choice to keep. */
let viewRestored = false;

/** Keeps the view the window is in, editor and all, to start in next time. */
function rememberView() {
  if (!viewRestored || !recording) return;
  api.setView(!document.body.classList.contains('video') ? 'mastering' : videoView.editing ? 'editing' : 'video');
}

/** Puts back the view the window was left in, once the recording it starts with is open. */
async function restoreView() {
  const view = await api.view();
  if (recording && view !== 'mastering') {
    showVideo(true);
    if (view === 'editing') await videoView.reopenEditor();
  }
  viewRestored = true;
}
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

// The waveform close up. The analysis has one value per block, too coarse to
// show a beat, so once the view is short enough the stretch in sight is
// decoded again and drawn as a wave, in pieces that are kept for a while.
/** A slice of a millisecond: a bass note's swing is several of them wide. */
const FINE_PER_BLOCK = 100;
/** Views up to this long are drawn as a wave; in a longer one it would look no different from the levels. */
const FINE_BELOW_BLOCKS = Math.round(20 / HOP_SECONDS);
const FINE_PIECE_BLOCKS = Math.round(30 / HOP_SECONDS);
const FINE_PIECES_KEPT = 20;
/** Pieces by their number along the recording; null while one is on its way, or could not be had. */
const finePieces = new Map<number, FineWave | null>();

/** Asks for a piece of the wave, unless it is here, on its way, or outside the recording. */
function fetchFinePiece(piece: number) {
  const of = recording;
  if (!of || finePieces.has(piece)) return;
  if (piece < 0 || piece * FINE_PIECE_BLOCKS >= of.measured.peaks.length) return;
  finePieces.set(piece, null);
  const from = piece * FINE_PIECE_BLOCKS * HOP_SECONDS;
  api
    .fineWave(of.path, from, from + FINE_PIECE_BLOCKS * HOP_SECONDS, of.measured.sampleRate, FINE_PER_BLOCK / HOP_SECONDS)
    .then((wave) => {
      if (recording !== of) return;
      finePieces.set(piece, wave);
      for (const oldest of finePieces.keys()) {
        if (finePieces.size <= FINE_PIECES_KEPT) break;
        finePieces.delete(oldest);
      }
      scheduleDraw();
    })
    // Left as "on its way": the view stays as coarse as it was, which is no worse than before.
    .catch((error) => console.error('Could not read the waveform finely:', error));
}

/** The wave across blocks `start` to `end` of the recording, or null until all of it has arrived. */
function fineWave(start: number, end: number): FineWave | null {
  if (!recording || end - start > FINE_BELOW_BLOCKS) return null;
  const first = Math.floor(start / FINE_PIECE_BLOCKS);
  const last = Math.floor((end - 1 / FINE_PER_BLOCK) / FINE_PIECE_BLOCKS);
  let complete = true;
  for (let piece = first; piece <= last; piece++) {
    const have = finePieces.get(piece);
    if (have) {
      // Used again, so it is the last to be dropped.
      finePieces.delete(piece);
      finePieces.set(piece, have);
    } else {
      complete = false;
      fetchFinePiece(piece);
    }
  }
  if (!complete) return null;
  // The pieces on either side as well: in a long MP3 one can take a couple of
  // seconds to read, and playing or scrolling on should not wait for it.
  fetchFinePiece(last + 1);
  fetchFinePiece(first - 1);
  const length = Math.round((end - start) * FINE_PER_BLOCK);
  const low = new Float32Array(length);
  const high = new Float32Array(length);
  for (let piece = first; piece <= last; piece++) {
    const wave = finePieces.get(piece)!;
    const offset = Math.round((piece * FINE_PIECE_BLOCKS - start) * FINE_PER_BLOCK);
    const from = Math.max(0, -offset);
    const to = Math.min(wave.low.length, length - offset);
    if (to <= from) continue;
    low.set(wave.low.subarray(from, to), offset + from);
    high.set(wave.high.subarray(from, to), offset + from);
  }
  return { low, high };
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (!recording) return;
    const playhead = player.time / HOP_SECONDS;
    drawOverview(overview, overviewData(recording), overviewShown, mixes.map((m) => ({ ...edges(m), name: m.name })), mixes.indexOf(mix), view, playhead);
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
    const fine = fineWave(mix.region.start + shown.start, mix.region.start + shown.end);
    const inMix = tracksIn(mix);
    markerBoxes = drawDetail(
      detailCanvas, detail, shown, hoverX, playhead - mix.region.start, hoverY,
      active ? mix.adjustments.indexOf(active) : null, fadeDrag ?? hoveredFade,
      fine,
      inMix.map((track, index) => ({
        block: track.at / HOP_SECONDS - mix.region.start,
        label: shownName(track, index),
        selected: track === selectedTrack,
        guessed: track.guessed === true,
      })),
    );
    // For scripted checks: the tracks of the mix as drawn.
    detailCanvas.dataset.tracks = JSON.stringify(inMix.map((track) => [Math.round(track.at * 10) / 10, track.name, track.guessed === true]));
    // For scripted checks, which cannot see what the canvas shows.
    detailCanvas.dataset.wave = fine ? 'fine' : 'blocks';
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

/** Edges are kept to a hundredth of a block, which is a millisecond. */
const fine = (blocks: number) => Math.round(blocks * 100) / 100;

/** Where a mix really starts and ends, in blocks and fractions of one. Use `region` for anything that indexes the curves. */
function edges(m: Mix): Region {
  return { start: m.region.start + (m.trimStart ?? 0), end: m.region.end - (m.trimEnd ?? 0) };
}

/** Puts a mix's edges at these positions, in blocks and fractions of one. */
function setEdges(m: Mix, start: number, end: number) {
  start = fine(start);
  end = fine(end);
  m.region = { start: Math.floor(start), end: Math.ceil(end) };
  const trimStart = fine(start - m.region.start);
  const trimEnd = fine(m.region.end - end);
  if (trimStart > 0) m.trimStart = trimStart;
  else delete m.trimStart;
  if (trimEnd > 0) m.trimEnd = trimEnd;
  else delete m.trimEnd;
}

/** A position in the recording as a time, with the fraction of a second only where there is one. */
function stamp(blocks: number): string {
  const milliseconds = Math.round(blocks * HOP_SECONDS * 1000);
  const whole = clock(Math.floor(milliseconds / 1000));
  const rest = milliseconds % 1000;
  return rest === 0 ? whole : `${whole}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/** A mix's fades in blocks. Together they can never be longer than the mix. */
function fades(m: Mix): { in: number; out: number } {
  const { start, end } = edges(m);
  const half = Math.floor((end - start) / 2);
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
const FIXED_CUSTOM_NOTE = 'You set how much the whole mix is turned up or down. Turning it far up leans on the limiter.';

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

/** A mix's measurements as its EQ makes it sound, by its stretch and its EQ; a handful are kept, for exports of several mixes. */
const heardWithEq = new Map<string, EqOutput>();
let heardFrom: Examination | null = null;

/** The measurements of a mix's stretch of the recording, as its channel fix and its EQ make it sound. */
function heard(m: Mix): EqOutput {
  const measured = measuredAsFixed();
  const { start, end } = m.region;
  const slices: EqOutput = {
    blocks: measured.blocks.subarray(start, end),
    peaks: measured.peaks.subarray(start, end),
    shortTerm: measured.shortTerm.subarray(start, end),
    lowShortTerm: measured.lowShortTerm.subarray(start, end),
    restShortTerm: measured.restShortTerm.subarray(start, end),
  };
  if (isFlat(m.eq)) return slices;
  if (heardFrom !== measured) heardWithEq.clear();
  heardFrom = measured;
  const key = `${start}|${end}|${JSON.stringify(m.eq)}`;
  let result = heardWithEq.get(key);
  if (!result) {
    result = withEq({ ...slices, sampleRate: measured.sampleRate, bands: measured.bands, firstBlock: start }, m.eq);
    if (heardWithEq.size >= 16) heardWithEq.delete(heardWithEq.keys().next().value!);
    heardWithEq.set(key, result);
  }
  return result;
}

function computeWith(m: Mix, options: LevelOptions): { detail: Detail; stats: Stats } {
  const { start, end } = m.region;
  const { shortTerm, restShortTerm, lowShortTerm, peaks: peaksIn, blocks: blocksIn } = heard(m);
  const n = end - start;
  const adjustments = m.adjustments.map((a) => ({ ...a, start: a.start - start, end: a.end - start }));

  const levelling = level(
    { shortTerm, lowShortTerm, restShortTerm },
    options,
    { peaks: peaksIn, ceilingDb: m.ceilingDb },
    adjustments,
  );
  const { gainDb, targetLufs, offsetDb } = levelling;
  // The bass curve is shown and applied when anything moves the bass: the correction or a hand adjustment.
  const correcting = options.levelTracks && options.bassCorrection > 0;
  const bassDb = correcting || m.adjustments.some((a) => a.bass) ? levelling.bassDb : null;
  const ceiling = Math.pow(10, m.ceilingDb / 20);
  const peaksOut = new Float32Array(n);
  const peakGain = new Float32Array(n);
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
    peakGain[i] = linear * Math.pow(10, (bassDb?.[i] ?? 0) / 40);
    peaksOut[i] = peaksIn[i] * peakGain[i];
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
  // Counted from the mix's real edges, which may lie inside the first and last block.
  const from = m.trimStart ?? 0;
  const to = n - (m.trimEnd ?? 0);
  for (let i = 0; i < n; i++) {
    const held = fadeGain(i + 0.5 - from, to - from, fade.in, fade.out);
    if (held === 1) continue;
    peaksOut[i] *= held;
    peakGain[i] *= held;
    bodyOut[i] *= held;
    loudnessOut[i] += 20 * Math.log10(Math.max(held, 1e-6));
  }

  return {
    detail: {
      startBlock: start, peaksIn, peaksOut, bodyOut, peakGain, loudnessIn: shortTerm, loudnessOut, gainDb, bassDb, adjustments,
      fadeIn: fade.in, fadeOut: fade.out, from, to, targetLufs, offsetDb, ceiling,
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

/** How much larger each recording's timeline is drawn, worked out once: it means sorting every block. */
const overviewGains = new WeakMap<Float32Array, number>();

function overviewData(r: Recording) {
  const marks = (id: string) => r.checkup.findings.find((finding) => finding.id === id)?.marks ?? [];
  let gain = overviewGains.get(r.measured.peaks);
  if (gain === undefined) overviewGains.set(r.measured.peaks, (gain = displayGain(r.measured.peaks)));
  return {
    peaks: r.measured.peaks, body: r.body, gain, gaps: r.gaps, clipping: marks('clipping'), dropouts: marks('dropouts'),
    tracks: tracks.map((track) => track.at / HOP_SECONDS),
  };
}

// ---------------------------------------------------------------------------
// The check-up: what the analysis noticed about the recording itself

const checkupDialog = $<HTMLDialogElement>('checkup-dialog');

/** Says in the header how much there is to know, and fills the panel behind it. */
/** What putting each fixable fault right does, on its button. */
const FIX_LABELS: Record<string, string> = {
  'dead-channel': 'Fill it from the other',
  'quieter-channel': 'Even them out',
  'out-of-phase': 'Flip one channel',
};

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
        if (finding.fix) {
          // One click to put it right, and one to take that back.
          const fixed = channelFixes.includes(finding.id);
          item.classList.toggle('fixed', fixed);
          const row = document.createElement('div');
          row.className = 'finding-fix';
          const button = document.createElement('button');
          button.dataset.fix = finding.id;
          button.textContent = fixed ? 'Undo the fix' : FIX_LABELS[finding.id] ?? 'Fix it';
          button.className = fixed ? '' : 'primary';
          button.addEventListener('click', () => setChannelFix(finding.id, !fixed));
          const note = document.createElement('span');
          note.textContent = fixed ? 'Fixed: playback, the levelling and every export hear it put right.' : 'Playback, the levelling and every export would hear it put right.';
          row.append(button, note);
          item.append(row);
        }
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
    // Unless it was set by hand, the slider shows where the target, or the fixed gain, ended up.
    if (choiceOf(mix) !== 'custom') {
      const fixed = !mix.options.levelTracks;
      const value = fixed ? detail.offsetDb : detail.targetLufs;
      $('target-value').textContent = fixed ? db(value) : lufs(value);
      $<HTMLInputElement>(fixed ? 'gain' : 'target').value = String(Math.round(value * 2) / 2);
    }
  } catch (error) {
    detail = null;
    $('readout').textContent = message(error);
    setStats(null);
  }
  showAdjustments();
  // The spectra behind the EQ follow the mix's edges and the other mixes; worked out again only when they change.
  drawEqPanel();
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


/** The free stretch of the recording around `block`, between the neighbouring mixes other than `except`. */
function freeSpace(block: number, except: Mix | null): Region {
  const space = { start: 0, end: recording!.measured.peaks.length };
  for (const other of mixes) {
    if (other === except) continue;
    const taken = edges(other);
    if (taken.end <= block) space.start = Math.max(space.start, taken.end);
    else if (taken.start >= block) space.end = Math.min(space.end, taken.start);
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
  const { start, end } = edges(mix);
  // Where the mix lies, to the millisecond, for scripted checks; on screen it is the timeline that shows it.
  Object.assign($('play-time').dataset, { start: stamp(start), end: stamp(end), length: stamp(end - start) });
  showPlayback();
  const nameInput = $<HTMLInputElement>('mix-name');
  if (document.activeElement !== nameInput) nameInput.value = mix.name;
  const artistInput = $<HTMLInputElement>('mix-artist');
  if (document.activeElement !== artistInput) artistInput.value = mix.artist ?? '';
  showTrackCount();

  const tabs = $('mix-tabs');
  tabs.replaceChildren(
    ...mixes.map((m, index) => {
      const tab = document.createElement('button');
      tab.className = m === mix ? 'mix-tab on' : 'mix-tab';
      const number = document.createElement('b');
      number.textContent = String(index + 1);
      tab.append(number, `${m.name}  ·  ${clock((edges(m).end - edges(m).start) * HOP_SECONDS)}`);
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
  $<HTMLButtonElement>('apply-all').disabled = !several;
  $<HTMLButtonElement>('split-gaps').disabled = !recording || piecesBetweenGaps(mix) === null;
  scheduleSave();
  scheduleDraw();
  videoView.refresh();
}

/**
 * Puts the start or the end of the selected mix at the playhead, so that a
 * set can be picked out of a long recording by ear, without zooming out to
 * reach the handles.
 */
function markEdge(edge: 'start' | 'end') {
  if (!recording || busy) return;
  const at = fine(player.time / HOP_SECONDS);
  const { start, end } = edges(mix);
  const length = edge === 'start' ? end - at : at - start;
  if (length < MIN_REGION_BLOCKS) {
    $('readout').textContent =
      edge === 'start'
        ? 'The start has to be at least 10 seconds before the end of the mix.'
        : 'The end has to be at least 10 seconds after the start of the mix.';
    return;
  }
  // The mark is placed while looking closely at the spot, so the view stays
  // on it rather than drawing back to show the whole mix.
  const looking = { ...view };
  if (edge === 'start') setRegion(at, end);
  else setRegion(start, at);
  setView(looking.start, looking.end);
}

$('mark-start').addEventListener('click', () => markEdge('start'));
$('mark-end').addEventListener('click', () => markEdge('end'));

/** Moves the selected mix, keeping it inside the free space around it. */
function setRegion(start: number, end: number) {
  if (!recording) return;
  const now = edges(mix);
  const space = freeSpace((now.start + now.end) / 2, mix);
  const minimum = Math.min(MIN_REGION_BLOCKS, space.end - space.start);
  start = clamp(fine(start), space.start, space.end - minimum);
  end = clamp(fine(end), start + minimum, space.end);
  setEdges(mix, start, end);
  view = { ...mix.region };
  showMix();
  scheduleRecompute();
}

function select(m: Mix) {
  if (m !== mix) rta.reset();
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
  setEdges(added, region.start, region.end);
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
    if (Math.abs(x - toX(edges(m).start)) <= HANDLE_PX) return { kind: 'start', mix: m };
    if (Math.abs(x - toX(edges(m).end)) <= HANDLE_PX) return { kind: 'end', mix: m };
  }
  const block = overviewShown.start + (x / rect.width) * span;
  const inside = mixes.find((m) => block > edges(m).start && block < edges(m).end);
  return inside ? { kind: 'move', mix: inside } : { kind: 'new', mix: null };
}

overview.addEventListener('mousedown', (event) => {
  if (!recording || busy) return;
  const block = overviewBlock(event);
  const grabbed = hit(event);
  if (grabbed.mix && grabbed.mix !== mix) select(grabbed.mix);
  if (grabbed.kind === 'move') drag = { kind: 'move', offset: block - edges(mix).start };
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
  const { start, end } = edges(mix);
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

// A double click on a part no mix covers fills it with a new one, from the
// mix before it to the mix after it.
overview.addEventListener('dblclick', (event) => {
  if (!recording || busy || hit(event).kind !== 'new') return;
  const space = freeSpace(overviewBlock(event), null);
  if (space.end - space.start >= MIN_REGION_BLOCKS) addMix(space);
});

window.addEventListener('mouseup', (event) => {
  // A plain click moves the playhead: to that spot inside a mix, to the very
  // start of the mix on its left edge, and to just before the end on its right.
  if (drag && !dragged) {
    if (drag.kind === 'move') seek(overviewBlock(event) * HOP_SECONDS);
    else if (drag.kind === 'start') seek(edges(mix).start * HOP_SECONDS);
    else if (drag.kind === 'end') seek(Math.max(edges(mix).start, edges(mix).end - END_PREVIEW_BLOCKS) * HOP_SECONDS);
  }
  drag = null;
});

for (const id of ['mix-name', 'mix-artist']) {
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
$<HTMLInputElement>('mix-artist').addEventListener('input', (event) => {
  const artist = (event.target as HTMLInputElement).value.trim();
  if (artist) mix.artist = artist;
  else delete mix.artist;
  scheduleSave();
});

/** Stretches the selected mix over all the free space around it. */
function expandMix() {
  if (!recording || busy) return;
  const now = edges(mix);
  const space = freeSpace((now.start + now.end) / 2, mix);
  setRegion(space.start, space.end);
}

$('select-all').addEventListener('click', expandMix);

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
      start: Math.max(edges(m).start, piece.start - LEAD_IN_BLOCKS),
      end: Math.min(edges(m).end, piece.end + TAIL_BLOCKS),
    }));
  if (pieces.length === 0) return null;
  const unchanged = pieces.length === 1 && pieces[0].start === edges(m).start && pieces[0].end === edges(m).end;
  return unchanged ? null : pieces;
}

/** Replaces the selected mix by one mix per region, all with its settings. The first keeps its name. */
function splitInto(regions: Region[]) {
  const original = mix;
  setEdges(original, regions[0].start, regions[0].end);
  for (const region of regions.slice(1)) {
    mixesCreated++;
    const piece: Mix = {
      name: `Mix ${mixesCreated}`,
      region,
      options: { ...original.options },
      ceilingDb: original.ceilingDb,
      adjustments: original.adjustments.map((a) => ({ ...a })),
      ...(original.loudness ? { loudness: original.loudness } : {}),
      ...(original.eq ? { eq: { ...original.eq } } : {}),
    };
    setEdges(piece, region.start, region.end);
    mixes.push(piece);
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

function splitAtPlayhead() {
  if (!recording || busy) return;
  const at = fine(player.time / HOP_SECONDS);
  const { start, end } = edges(mix);
  if (at - start < MIN_REGION_BLOCKS || end - at < MIN_REGION_BLOCKS) {
    $('readout').textContent = 'Put the playhead inside this mix, at least 10 seconds from either end, to split there.';
    return;
  }
  // The piece before the cut stays selected, with the playhead resting at its
  // new end and the view still on the spot: the cut is usually made to finish
  // that piece, and its ending is what gets worked on next.
  const looking = { ...view };
  splitInto([{ start, end: at }, { start: at, end }]);
  setView(looking.start, looking.end);
}

$('split-here').addEventListener('click', splitAtPlayhead);

/**
 * Removes the selected mix. A recording always has one, so deleting the only
 * mix takes away what was marked instead: it covers the whole recording again.
 */
function deleteMix() {
  if (!recording || busy) return;
  if (mixes.length < 2) {
    expandMix();
    return;
  }
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
  // Kept to the millisecond rather than the block: close up, a view that
  // moved a block at a time would scroll and zoom in jumps.
  const span = clamp(fine(end - start), Math.min(MIN_VIEW_BLOCKS, region.end - region.start), region.end - region.start);
  const from = clamp(fine(start), region.start, region.end - span);
  view = { start: from, end: fine(from + span) };
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
// Tracks: a marker where each track played starts, with its name. M puts one
// at the playhead; they are dragged, named and removed on the mix timeline,
// and listed, imported and copied in the Tracks dialog.

/** Where the markers' names were last drawn, for pointing at them. */
let markerBoxes: MarkerBox[] = [];
let trackDrag: Track | null = null;
/** How far, in seconds, the pointer was from the marker it took hold of, which it keeps while dragging. */
let trackDragOffset = 0;

/** The time under the pointer in the detail view, in seconds of the recording. */
function detailSeconds(event: MouseEvent): number {
  const rect = detailCanvas.getBoundingClientRect();
  const fraction = clamp((event.clientX - rect.left - GUTTER) / (rect.width - GUTTER), 0, 1);
  return (view.start + fraction * (view.end - view.start)) * HOP_SECONDS;
}

/** The mix's edges in seconds. */
function mixSeconds(m: Mix): { start: number; end: number } {
  const { start, end } = edges(m);
  return { start: start * HOP_SECONDS, end: end * HOP_SECONDS };
}

/** The tracks that start inside a mix. */
function tracksIn(m: Mix): Track[] {
  const { start, end } = mixSeconds(m);
  return tracks.filter((track) => track.at >= start && track.at < end);
}

/** The tracks of a mix, timed from its start, as its video and its exports see them. */
function mixTracks(m: Mix): MixTrack[] {
  const { start } = mixSeconds(m);
  return tracksIn(m).map((track) => ({ at: track.at - start, name: track.name }));
}

function tracksChanged() {
  tracks.sort((a, b) => a.at - b.at);
  if (selectedTrack && !tracks.includes(selectedTrack)) selectedTrack = null;
  showTrackCount();
  if (tracksDialog.open) showTrackList();
  scheduleSave();
  scheduleDraw();
}

function showTrackCount() {
  const count = recording ? tracksIn(mix).length : 0;
  $('tracks-button').textContent = count ? `${count} track${count === 1 ? '' : 's'}` : 'Tracks';
}

/** Marks a track starting at the playhead; on an existing marker, selects that one instead. */
function addTrack() {
  if (!recording) return;
  const { start, end } = mixSeconds(mix);
  const at = Math.round(clamp(player.time, start, end - 0.1) * 1000) / 1000;
  const near = tracksIn(mix).find((track) => Math.abs(track.at - at) < 1);
  if (near) {
    selectedTrack = near;
  } else {
    selectedTrack = { at, name: '' };
    tracks.push(selectedTrack);
  }
  tracksChanged();
  $('readout').textContent = `Track ${tracksIn(mix).indexOf(selectedTrack) + 1} starts at ${listTime(at - start)}. Double-click its name to type one.`;
}

function removeTrack(track: Track) {
  tracks = tracks.filter((t) => t !== track);
  tracksChanged();
}

/** The marker under the pointer in the detail view: on its name, or on its line in the waveform lane. */
function markerAt(event: MouseEvent): Track | null {
  const rect = detailCanvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const inMix = tracksIn(mix);
  const onTab = markerBoxes.find((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  if (onTab) return inMix[onTab.index] ?? null;
  if (y > detailLanes(rect.height).wave.height) return null;
  const onLine = markerBoxes.find((box) => Math.abs(x - box.x) <= 3);
  return onLine ? inMix[onLine.index] ?? null : null;
}

function describeTrack(track: Track): string {
  const index = tracksIn(mix).indexOf(track);
  const where = listTime(track.at - mixSeconds(mix).start);
  return `${shownName(track, index)} at ${where}${track.guessed ? ', a guess' : ''}: drag to move, double-click to name, Backspace removes`;
}

detailCanvas.addEventListener('mousedown', (event) => {
  if (!recording || busy || fadeDrag) return;
  const track = markerAt(event);
  if (!track) return;
  trackDrag = track;
  trackDragOffset = detailSeconds(event) - track.at;
  selectedTrack = track;
  event.preventDefault();
  scheduleDraw();
});

window.addEventListener('mousemove', (event) => {
  if (!trackDrag) return;
  if (!grabMoved && Math.abs(event.clientX - grabX) < DRAG_START_PX) return;
  grabMoved = true;
  const { start, end } = mixSeconds(mix);
  const at = detailSeconds(event) - trackDragOffset;
  trackDrag.at = Math.round(clamp(at, start, end - 0.1) * 1000) / 1000;
  // Put where it belongs by hand: no longer a guess.
  delete trackDrag.guessed;
  $('readout').textContent = describeTrack(trackDrag);
  tracksChanged();
});

window.addEventListener('mouseup', () => {
  trackDrag = null;
});

detailCanvas.addEventListener('mousemove', (event) => {
  if (grab || fadeDrag || hoveredFade) return;
  const track = trackDrag ?? markerAt(event);
  if (!track) return;
  detailCanvas.style.cursor = 'ew-resize';
  $('readout').textContent = describeTrack(track);
});

detailCanvas.addEventListener('click', (event) => {
  if (grabMoved) return;
  // A click on a marker plays from where its track starts; anywhere else lets go of it.
  const track = markerAt(event);
  if (track) seek(track.at);
  else if (selectedTrack) {
    selectedTrack = null;
    scheduleDraw();
  }
});

detailCanvas.addEventListener('dblclick', (event) => {
  const track = markerAt(event);
  if (track) nameTrack(track);
});

/** Opens a field over a marker's name to type it in. */
function nameTrack(track: Track) {
  const index = tracksIn(mix).indexOf(track);
  const box = markerBoxes.find((b) => b.index === index);
  if (!box) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'track-name-edit';
  input.spellcheck = false;
  input.value = track.name;
  input.placeholder = 'Artist - Title';
  input.style.left = `${box.x}px`;
  input.style.top = `${box.top - 3}px`;
  $('detail-area').append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    if (keep && input.value.trim() !== track.name) {
      track.name = input.value.trim();
      tracksChanged();
    }
    input.remove();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
    event.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

// The Tracks dialog: every track of the mix in a list, with what can be done with them all.

const tracksDialog = $<HTMLDialogElement>('tracks-dialog');

function showTrackList() {
  const { start, end } = mixSeconds(mix);
  const inMix = tracksIn(mix);
  $('tracks-title').textContent = `Tracks in ${mix.name}`;
  const rows = inMix.map((track, index) => {
    const row = document.createElement('div');
    row.className = track.guessed ? 'track-row guessed' : 'track-row';
    const number = document.createElement('span');
    number.className = 'track-number';
    number.textContent = String(index + 1);
    const time = document.createElement('input');
    time.type = 'text';
    time.className = 'track-time';
    time.value = listTime(index === 0 ? 0 : track.at - start);
    time.title = index === 0
      ? 'The first track counts from the start of the mix, wherever its marker is'
      : track.guessed ? 'A guess: where the list was spread evenly. Type the time, or drag the marker on the mix.' : 'Where the track starts, from the start of the mix';
    time.addEventListener('change', () => {
      const seconds = parseTime(time.value);
      if (seconds === null || start + seconds >= end) {
        time.value = listTime(track.at - start);
        return;
      }
      track.at = Math.round((start + seconds) * 1000) / 1000;
      delete track.guessed;
      tracksChanged();
    });
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'track-name';
    name.value = track.name;
    name.placeholder = `Track ${index + 1}`;
    name.spellcheck = false;
    name.addEventListener('input', () => {
      track.name = name.value;
      showTrackCount();
      scheduleSave();
      scheduleDraw();
    });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove this track';
    remove.setAttribute('aria-label', 'Remove this track');
    remove.textContent = '×';
    remove.addEventListener('click', () => removeTrack(track));
    row.append(number, time, name, remove);
    return row;
  });
  const list = $('tracks-list');
  list.replaceChildren(...rows);
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'tracks-empty';
    empty.textContent = 'No tracks yet. Press M while the mix plays to mark where each track starts, or import the list from your DJ software.';
    list.append(empty);
  }
  const guessed = inMix.filter((track) => track.guessed).length;
  const { problems } = youtubeList(mixTracks(mix), end - start);
  const notes = [
    ...(guessed ? [`${guessed === 1 ? 'One place is a guess' : `${guessed} places are guesses`}: drag ${guessed === 1 ? 'its marker' : 'their markers'} on the mix to where the track starts.`] : []),
    ...(inMix.length ? problems : []),
  ];
  $('tracks-note').textContent = notes.join(' ');
  $<HTMLButtonElement>('tracks-copy').disabled = inMix.length === 0;
  $<HTMLButtonElement>('tracks-spread').disabled = inMix.length < 2;
  $<HTMLButtonElement>('tracks-clear').disabled = inMix.length === 0;
}

/**
 * Puts a list into the mix. With a time for every track, the markers go where
 * it says, in place of those there were. Without, the names fill the markers
 * already placed, in order; any more are spread evenly over the rest of the
 * mix, as guesses to drag into place.
 */
function importTracks(listed: ListedTrack[]): string {
  if (listed.length === 0) return 'No tracks found in that.';
  const { start, end } = mixSeconds(mix);
  const inMix = tracksIn(mix);
  if (listed.every((track) => track.at !== null)) {
    const fitting = listed.filter((track) => start + track.at! < end);
    tracks = tracks.filter((track) => !inMix.includes(track));
    tracks.push(...fitting.map((track) => ({ at: Math.round((start + track.at!) * 1000) / 1000, name: track.name })));
    tracksChanged();
    const left = listed.length - fitting.length;
    return `${fitting.length} tracks placed at their times.${left ? ` ${left} start after the end of the mix and were left out.` : ''}`;
  }
  listed.slice(0, inMix.length).forEach((track, i) => (inMix[i].name = track.name));
  const extra = listed.slice(inMix.length);
  const from = inMix.length ? inMix[inMix.length - 1].at : start;
  const gaps = spreadEvenly(extra.length + (inMix.length ? 1 : 0), end - from);
  extra.forEach((track, i) => tracks.push({ at: Math.round((from + gaps[i + (inMix.length ? 1 : 0)]) * 1000) / 1000, name: track.name, guessed: true }));
  tracksChanged();
  return extra.length
    ? `${listed.length} tracks read. The list says nothing of when each was played, so ${extra.length === listed.length ? 'they are' : 'the new ones are'} spread evenly for now: drag each marker to where its track starts.`
    : `${listed.length} names given to the markers there were, in order.`;
}

$('tracks-button').addEventListener('click', () => {
  if (!recording) return;
  showTrackList();
  $('tracks-status').textContent = '';
  tracksDialog.showModal();
});
$('tracks-close').addEventListener('click', () => tracksDialog.close());
$('tracks-import').addEventListener('click', async () => {
  try {
    const text = await api.openTracklist();
    if (text !== null) $('tracks-status').textContent = importTracks(parseTracklist(text));
  } catch (error) {
    $('tracks-status').textContent = `Could not read that list: ${message(error)}`;
  }
});
$('tracks-paste').addEventListener('click', async () => {
  $('tracks-status').textContent = importTracks(parseTracklist(await api.readClipboard()));
});
$('tracks-spread').addEventListener('click', () => {
  const { start, end } = mixSeconds(mix);
  const inMix = tracksIn(mix);
  spreadEvenly(inMix.length, end - start).forEach((at, i) => Object.assign(inMix[i], { at: Math.round((start + at) * 1000) / 1000, guessed: true }));
  tracksChanged();
  $('tracks-status').textContent = 'Spread evenly over the mix. Drag each marker to where its track starts.';
});
$('tracks-clear').addEventListener('click', () => {
  const inMix = tracksIn(mix);
  tracks = tracks.filter((track) => !inMix.includes(track));
  tracksChanged();
  $('tracks-status').textContent = 'All the tracks of this mix are removed. Undo brings them back.';
});
$('tracks-copy').addEventListener('click', () => {
  const { start, end } = mixSeconds(mix);
  const { text, problems } = youtubeList(mixTracks(mix), end - start);
  api.writeClipboard(text);
  $('tracks-status').textContent = `Copied, ready for the video's description.${problems.length ? ` ${problems.join(' ')}` : ''}`;
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
  const block = which === 'in' ? edges(mix).start + fade.in : edges(mix).end - fade.out;
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
  const { start, end } = edges(mix);
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
  const inside = seconds >= edges(mix).start * HOP_SECONDS && seconds < edges(mix).end * HOP_SECONDS;
  const loudness = inside ? curveAt(hearLevelled ? detail.loudnessOut : detail.loudnessIn, seconds) : NaN;
  const applied = inside && hearLevelled;
  levelMeter.setFigures([
    ['LUFS', loudness > -60 ? loudness.toFixed(1).replace('-', '−') : '–', hearLevelled ? colours.after : colours.hover],
    ['gain', applied ? signed(curveAt(detail.gainDb, seconds)) : '–', colours.gain],
    ...(detail.bassDb ? [['bass', applied ? signed(bassAt(seconds)) : '–', colours.bass] as MeterFigure] : []),
  ]);
}

/** The playhead as time into the selected mix, beside the mix's length. */
function showPlayback() {
  const { start, end } = edges(mix);
  const elapsed = clamp(player.time - start * HOP_SECONDS, 0, (end - start) * HOP_SECONDS);
  $('play-time').textContent = recording ? `${clock(elapsed)} / ${clock((end - start) * HOP_SECONDS)}` : '0:00:00 / 0:00:00';
  scheduleDraw();
}

/** Keeps the sound and the playhead in step with the audio while it plays. */
function follow() {
  if (!recording || player.paused) return;
  const time = player.time;
  const { start, end } = edges(mix);
  if (time >= end * HOP_SECONDS) {
    // Playback covers the selected mix only, and comes to rest at its end.
    player.pause();
    player.seek(end * HOP_SECONDS);
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
  player.setEq(hearLevelled ? mix.eq : undefined);
  player.apply(hearLevelled ? gainAt(time) : 1, hearLevelled ? bassAt(time) : 0, held, {
    ceilingDb: mix.ceilingDb,
    bypass: !hearLevelled,
  });
  const heard = player.spectrum();
  if (heard) {
    rta.update(heard, performance.now());
    drawEqPanel();
  }
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

// Running through the mix at speed, as in an editor: L forwards, J backwards,
// each press faster, K to stop. Forwards is ordinary playback sped up, with
// sound up to four times; backwards has no sound, only the playhead moves.
const SHUTTLE_SPEEDS = [1, 2, 4, 8];
/** How fast the playhead is being run: negative is backwards, 0 is not at all (stopped, or playing as usual). */
let shuttle = 0;
let backwardsFrame = 0;
/** The audio element is told where to be this often while running backwards; every frame would swamp it. */
const BACKWARDS_SEEK_MS = 60;

const faster = (speed: number) => SHUTTLE_SPEEDS[Math.min(SHUTTLE_SPEEDS.length - 1, SHUTTLE_SPEEDS.indexOf(speed) + 1)];

function showShuttle() {
  $('shuttle').textContent = shuttle === 0 || shuttle === 1 ? '' : shuttle > 0 ? `${shuttle}×` : `◀ ${-shuttle}×`;
  // The speed the player was really given, for scripted checks.
  $('shuttle').dataset.rate = String(player.rate);
}

/** Back to standing still, or to playing at the ordinary speed. */
function stopShuttle() {
  cancelAnimationFrame(backwardsFrame);
  backwardsFrame = 0;
  shuttle = 0;
  player.rate = 1;
  showShuttle();
}

async function shuttleForwards() {
  if (!recording || busy) return;
  const speed = shuttle > 0 ? faster(shuttle) : player.paused || backwardsFrame ? 1 : 2;
  stopShuttle();
  shuttle = speed;
  player.rate = speed;
  showShuttle();
  if (player.paused) await startPlaying();
}

function shuttleBackwards() {
  if (!recording || busy) return;
  const speed = shuttle < 0 ? faster(-shuttle) : 1;
  // Pausing resets the speed, so it comes first.
  if (!player.paused) player.pause();
  shuttle = -speed;
  showShuttle();
  if (backwardsFrame) return;
  let position = player.time;
  let last = performance.now();
  let sought = 0;
  const run = (now: number) => {
    if (!recording) {
      stopShuttle();
      return;
    }
    const start = edges(mix).start * HOP_SECONDS;
    position = Math.max(start, Math.min(position, player.time) - ((now - last) / 1000) * -shuttle);
    last = now;
    if (now - sought >= BACKWARDS_SEEK_MS || position === start) {
      seek(position);
      sought = now;
    }
    if (position === start) stopShuttle();
    else backwardsFrame = requestAnimationFrame(run);
  };
  backwardsFrame = requestAnimationFrame(run);
}

async function togglePlay() {
  if (!recording || busy) return;
  if (backwardsFrame) {
    stopShuttle();
    return;
  }
  if (!player.paused) {
    player.pause();
    return;
  }
  await startPlaying();
}

/** Starts playback at the playhead, or at the start of the mix when the playhead is outside it or at its end. */
async function startPlaying() {
  const time = player.time;
  const { start, end } = edges(mix);
  // Resting at the very end, where playback stops, there is nothing left to
  // play: start over. Anywhere else, even just short of the end, play from there.
  if (time < start * HOP_SECONDS || time >= (end - 1) * HOP_SECONDS) player.seek(start * HOP_SECONDS);
  try {
    await player.play();
  } catch (error) {
    $('export-status').textContent = `Cannot play this recording here (${message(error)}). Export still works.`;
  }
}

function setHearLevelled(levelled: boolean) {
  hearLevelled = levelled;
  $('bypass').classList.toggle('on', !levelled);
  $('bypass').setAttribute('aria-pressed', String(!levelled));
  $('bypass-note').hidden = levelled;
  scheduleDraw();
}

// A setting changed while bypassed is not heard; the note says why, again.
function remindBypassed(event: Event) {
  if (hearLevelled || (event.target as Element).closest('#bypass-note')) return;
  const note = $('bypass-note');
  note.classList.remove('flash');
  void note.offsetWidth; // so that the animation starts over
  note.classList.add('flash');
}
for (const type of ['input', 'change']) $('mastering-settings').addEventListener(type, remindBypassed);

player.onPlay = () => {
  showPlaying(true);
  follow();
};
player.onPause = () => {
  showPlaying(false);
  if (shuttle > 0) stopShuttle();
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
$('bypass').addEventListener('click', () => setHearLevelled(!hearLevelled));
$('bypass-off').addEventListener('click', () => setHearLevelled(true));

/** Kinds of box whose keys are the letters and numbers typed into them, not the window's shortcuts. */
const TYPED_INTO = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password']);
const typingIn = (target: EventTarget | null) =>
  (target instanceof HTMLInputElement && TYPED_INTO.has(target.type)) ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable);

window.addEventListener('keydown', (event) => {
  if (typingIn(event.target)) return;
  // While a dialog is up, the keys belong to it.
  if (exportDialog.open || checkupDialog.open || helpDialog.open || tracksDialog.open || settings.element.open) return;
  // While a template is edited, as in an image editor: Shift+⌘N adds a layer, ⌘J duplicates one, ⌘G groups it, Shift+⌘G ungroups.
  if (videoView.editing && (event.metaKey || event.ctrlKey) && (event.code === 'KeyJ' || event.code === 'KeyG' || (event.code === 'KeyN' && event.shiftKey))) {
    event.preventDefault();
    videoView.layerCommand(event.code === 'KeyN' ? 'add' : event.code === 'KeyJ' ? 'duplicate' : event.shiftKey ? 'ungroup' : 'group');
    return;
  }
  // While a template is edited, Delete is for its layers, wherever one was selected; never the mix.
  // A number box or a list keeps its keys.
  if (videoView.editing && (event.code === 'Backspace' || event.code === 'Delete')) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    videoView.deleteLayer();
    return;
  }
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
  } else if (event.code === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    // As in Ableton: Tab goes between the two views.
    event.preventDefault();
    showVideo(!videoView.visible);
  } else if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
    // Arrow keys on a slider or a list belong to it.
  } else if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault();
    const step = event.altKey ? STEP_FINE_SECONDS : event.shiftKey ? STEP_COARSE_SECONDS : STEP_SECONDS;
    stepPlayhead(event.code === 'ArrowLeft' ? -step : step);
  } else if ((event.code === 'KeyJ' || event.code === 'KeyK' || event.code === 'KeyL') && !event.metaKey && !event.ctrlKey) {
    if (event.code === 'KeyL') shuttleForwards();
    else if (event.code === 'KeyJ') shuttleBackwards();
    else {
      if (!player.paused) player.pause();
      stopShuttle();
    }
  } else if (event.code === 'KeyE' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    splitAtPlayhead();
  } else if ((event.code === 'KeyI' || event.code === 'KeyO') && !event.metaKey && !event.ctrlKey) {
    markEdge(event.code === 'KeyI' ? 'start' : 'end');
  } else if (event.code === 'KeyM' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    addTrack();
  } else if (event.code === 'Backspace' || event.code === 'Delete') {
    event.preventDefault();
    // The stretch under the pointer, if there is one; then the track marker last clicked; otherwise the mix.
    if (hoveredAdjustment) removeAdjustment(hoveredAdjustment);
    else if (selectedTrack) removeTrack(selectedTrack);
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
  const { start, end } = edges(mix);
  // From outside the mix, the first step lands on its nearest edge.
  const from = clamp(player.time, start * HOP_SECONDS, end * HOP_SECONDS);
  seek(clamp(from + seconds, start * HOP_SECONDS, end * HOP_SECONDS - 0.5));
}

function toStart() {
  if (recording) seek(edges(mix).start * HOP_SECONDS);
}

function toEnd() {
  if (recording) seek(Math.max(edges(mix).start, edges(mix).end - END_PREVIEW_BLOCKS) * HOP_SECONDS);
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
  /** Where a double click puts it back to. */
  initial: number;
}

const sliders: Slider[] = [
  {
    id: 'window',
    get: () => mix.options.windowSeconds,
    set: (v) => (mix.options.windowSeconds = v),
    // Dips up to this share of the window are filled in; see fullEnergyEnvelope.
    format: (v) => `up to ${Math.round(v * mix.options.percentile)} s`,
    initial: DEFAULT_LEVEL_OPTIONS.windowSeconds,
  },
  { id: 'smooth', get: () => mix.options.smoothSeconds, set: (v) => (mix.options.smoothSeconds = v), format: (v) => `${v * 2} s`, initial: DEFAULT_LEVEL_OPTIONS.smoothSeconds },
  { id: 'bass', get: () => mix.options.bassCorrection, set: (v) => (mix.options.bassCorrection = v), format: (v) => (v === 0 ? 'off' : `${Math.round(v * 100)}%`), initial: DEFAULT_LEVEL_OPTIONS.bassCorrection },
  { id: 'bass-max', get: () => mix.options.maxBassDb, set: (v) => (mix.options.maxBassDb = v), format: (v) => `±${v.toFixed(1)} dB`, initial: DEFAULT_LEVEL_OPTIONS.maxBassDb },
  { id: 'boost', get: () => mix.options.maxBoostDb, set: (v) => (mix.options.maxBoostDb = v), format: (v) => db(v), initial: DEFAULT_LEVEL_OPTIONS.maxBoostDb },
  { id: 'cut', get: () => mix.options.maxCutDb, set: (v) => (mix.options.maxCutDb = v), format: (v) => db(-v), initial: DEFAULT_LEVEL_OPTIONS.maxCutDb },
  { id: 'ceiling', get: () => mix.ceilingDb, set: (v) => (mix.ceilingDb = v), format: (v) => `${v.toFixed(1)} dBTP`, initial: DEFAULT_CEILING_DB },
];

/**
 * What the Loudness list shows for a mix. Custom is a target set by hand when
 * the tracks are levelled, and a gain set by hand when the gain is fixed; only
 * the one that goes with the mode is ever set.
 */
function choiceOf(m: Mix): string {
  const preset = presetOf(m);
  if (preset) return preset.id;
  const byHand = m.options.levelTracks ? m.options.targetLufs : m.options.fixedGainDb;
  return byHand === undefined ? 'auto' : 'custom';
}

function syncControls() {
  syncEq();
  for (const slider of sliders) {
    $<HTMLInputElement>(slider.id).value = String(slider.get());
    $(`${slider.id}-value`).textContent = slider.format(slider.get());
  }
  const fixed = !mix.options.levelTracks;
  $('level-tracks').classList.toggle('on', !fixed);
  $('fixed-gain').classList.toggle('on', fixed);
  $('track-levelling').hidden = fixed;
  $('target').hidden = fixed;
  $('gain').hidden = !fixed;
  const preset = presetOf(mix);
  const choice = choiceOf(mix);
  $<HTMLSelectElement>('loudness').value = choice;
  $('loudness-note').textContent =
    preset ? preset.note : choice === 'auto' ? AUTO_NOTE : fixed ? FIXED_CUSTOM_NOTE : CUSTOM_NOTE;
  if (choice === 'custom' && fixed) {
    $<HTMLInputElement>('gain').value = String(mix.options.fixedGainDb);
    $('target-value').textContent = db(mix.options.fixedGainDb!);
  } else if (choice === 'custom') {
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
  resetsTo($<HTMLInputElement>(slider.id), slider.initial);
  $<HTMLInputElement>(slider.id).addEventListener('input', (event) => {
    const value = Number((event.target as HTMLInputElement).value);
    slider.set(value);
    $(`${slider.id}-value`).textContent = slider.format(value);
    scheduleRecompute();
  });
}

/** Sets the level by hand, as a target or as a gain depending on the mode; undefined leaves it to work itself out. */
function setByHand(value: number | undefined) {
  if (mix.options.levelTracks) {
    mix.options.targetLufs = value;
    delete mix.options.fixedGainDb;
  } else {
    mix.options.fixedGainDb = value;
    delete mix.options.targetLufs;
  }
}

// Moving either slider is choosing a level by hand.
for (const id of ['target', 'gain']) {
  $<HTMLInputElement>(id).addEventListener('input', (event) => {
    delete mix.loudness;
    setByHand(Number((event.target as HTMLInputElement).value));
    syncControls();
    scheduleRecompute();
  });
}

// The loudness has no one default value: put back, it goes back to working itself out.
for (const id of ['target', 'gain']) {
  resetsTo($<HTMLInputElement>(id), () => {
    const loudness = $<HTMLSelectElement>('loudness');
    loudness.value = 'auto';
    loudness.dispatchEvent(new Event('change'));
  });
}

$<HTMLSelectElement>('loudness').addEventListener('change', (event) => {
  const choice = (event.target as HTMLSelectElement).value;
  if (choice === 'auto' || choice === 'custom') delete mix.loudness;
  else mix.loudness = choice;
  // Custom starts from the level in use; everything else works its own out.
  const slider = mix.options.levelTracks ? 'target' : 'gain';
  setByHand(choice === 'custom' ? Number($<HTMLInputElement>(slider).value) : undefined);
  syncControls();
  scheduleRecompute();
});

/**
 * Switches between levelling the tracks and one gain for the whole mix. A
 * level set by hand carries over as near as it can: a fixed gain starts at the
 * gain the target came to, and a target at where the fixed gain left the
 * full-energy parts. Presets and "As loud as fits" mean the same in both.
 */
function setLevelTracks(on: boolean) {
  if (!recording || busy || mix.options.levelTracks === on) return;
  const custom = choiceOf(mix) === 'custom';
  mix.options.levelTracks = on;
  if (custom && detail) setByHand(Math.round((on ? detail.targetLufs : detail.offsetDb) * 2) / 2);
  else setByHand(undefined);
  syncControls();
  scheduleRecompute();
}

$('level-tracks').addEventListener('click', () => setLevelTracks(true));
$('fixed-gain').addEventListener('click', () => setLevelTracks(false));

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
// The EQ: a mix's own, for putting right how it was recorded

/** The bands as the panel has them: a slider for the gain, one for the frequency, and how the readout puts the two together. */
const EQ_BANDS = [
  { id: 'low', gain: 'lowDb', hz: 'lowHz', where: 'below' },
  { id: 'low-mid', gain: 'lowMidDb', hz: 'lowMidHz', where: 'at' },
  { id: 'high-mid', gain: 'highMidDb', hz: 'highMidHz', where: 'at' },
  { id: 'high', gain: 'highDb', hz: 'highHz', where: 'above' },
] as const;

const eqOf = (m: Mix): Eq => m.eq ?? FLAT_EQ;
const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`);

/** A frequency slider's place from 0 to 1, spread evenly in pitch over its band's range, as a round number of Hz. */
function hzAt(key: keyof typeof EQ_RANGES_HZ, place: number): number {
  const [lo, hi] = EQ_RANGES_HZ[key];
  const hz = lo * Math.pow(hi / lo, place);
  const step = Math.pow(10, Math.floor(Math.log10(hz)) - 1);
  return clamp(Math.round(hz / step) * step, lo, hi);
}

function placeOf(key: keyof typeof EQ_RANGES_HZ, hz: number): number {
  const [lo, hi] = EQ_RANGES_HZ[key];
  return Math.log(hz / lo) / Math.log(hi / lo);
}

function syncEq() {
  const eq = eqOf(mix);
  $<HTMLInputElement>('eq-high-pass').value = String(eq.highPassHz);
  $('eq-high-pass-value').textContent = eq.highPassHz === 0 ? 'off' : `below ${eq.highPassHz} Hz`;
  for (const band of EQ_BANDS) {
    $<HTMLInputElement>(`eq-${band.id}`).value = String(eq[band.gain]);
    $<HTMLInputElement>(`eq-${band.id}-hz`).value = String(placeOf(band.hz, eq[band.hz]));
    $(`eq-${band.id}-value`).textContent = `${eq[band.gain] === 0 ? '0 dB' : db(eq[band.gain])} ${band.where} ${hzText(eq[band.hz])}`;
  }
  $<HTMLButtonElement>('eq-flat').disabled = !mix.eq;
  fillEqCopy();
  drawEqPanel();
}

/** What is playing, after the EQ, for the analyser behind it. */
const rta = new Rta();
let backdropFor: { key: string; backdrop: EqBackdrop } | null = null;

/**
 * The averages behind the EQ, from the analysis: this mix as its EQ makes it
 * sound, and the other mixes together as theirs do, each weighed by its
 * length rather than its loudness. Worked out again only when a stretch or an
 * EQ changes, as the drawing is redone on every frame while playing.
 */
function eqBackdrop(): EqBackdrop {
  if (!recording) return {};
  const { bands, sampleRate } = recording.measured;
  const key = JSON.stringify([recording.path, mixes.indexOf(mix), mixes.map((m) => [m.region, m.eq ?? null])]);
  if (backdropFor?.key !== key) {
    const mine = bandShares(bands, sampleRate, mix.region.start, mix.region.end, mix.eq);
    const together = new Float64Array(BANDS);
    let length = 0;
    for (const other of mixes) {
      if (other === mix) continue;
      const shares = bandShares(bands, sampleRate, other.region.start, other.region.end, other.eq);
      if (!shares) continue;
      const blocks = other.region.end - other.region.start;
      shares.forEach((share, b) => (together[b] += share * blocks));
      length += blocks;
    }
    backdropFor = {
      key,
      backdrop: {
        mix: mine && bandSpectrum(mine, sampleRate),
        others: length > 0 ? bandSpectrum(together.map((sum) => sum / length), sampleRate) : null,
      },
    };
  }
  return { ...backdropFor.backdrop, live: rta.empty ? undefined : (frequencies) => rta.line(frequencies) };
}

function drawEqPanel() {
  drawEq($<HTMLCanvasElement>('eq-curve'), eqOf(mix), eqBackdrop());
}

/**
 * Changes the selected mix's EQ. One that does nothing is kept as long as
 * its frequencies have been moved, so that a slider does not jump back when
 * its gain passes through zero; only Flat takes it away.
 */
function changeEq(change: Partial<Eq>) {
  const eq = { ...eqOf(mix), ...change };
  if (checkedEq(eq)) mix.eq = eq;
  else delete mix.eq;
  syncEq();
  scheduleRecompute();
}

resetsTo($<HTMLInputElement>('eq-high-pass'), FLAT_EQ.highPassHz);
for (const band of EQ_BANDS) {
  resetsTo($<HTMLInputElement>(`eq-${band.id}`), FLAT_EQ[band.gain]);
  // Set as it is, since the slider's steps need not land on it exactly.
  resetsTo($<HTMLInputElement>(`eq-${band.id}-hz`), () => changeEq({ [band.hz]: FLAT_EQ[band.hz] }));
}

$<HTMLInputElement>('eq-high-pass').addEventListener('input', (event) => {
  changeEq({ highPassHz: Number((event.target as HTMLInputElement).value) });
});
for (const band of EQ_BANDS) {
  $<HTMLInputElement>(`eq-${band.id}`).addEventListener('input', (event) => {
    changeEq({ [band.gain]: Number((event.target as HTMLInputElement).value) });
  });
  $<HTMLInputElement>(`eq-${band.id}-hz`).addEventListener('input', (event) => {
    changeEq({ [band.hz]: hzAt(band.hz, Number((event.target as HTMLInputElement).value)) });
  });
}

$('eq-flat').addEventListener('click', () => {
  if (!recording || busy) return;
  delete mix.eq;
  syncEq();
  scheduleRecompute();
});

/** The list of mixes the EQ can be copied to: each other one, and all of them. */
function fillEqCopy() {
  const select = $<HTMLSelectElement>('eq-copy');
  const others = mixes.filter((m) => m !== mix);
  const prompt = new Option('Copy to…', '');
  prompt.disabled = true;
  select.replaceChildren(
    prompt,
    ...others.map((m) => new Option(m.name, String(mixes.indexOf(m)))),
    ...(others.length > 1 ? [new Option('Every other mix', 'all')] : []),
  );
  select.value = '';
  select.disabled = others.length === 0;
}

// Names may have changed since the list was made.
$('eq-copy').addEventListener('pointerdown', fillEqCopy);
$('eq-copy').addEventListener('change', (event) => {
  const select = event.target as HTMLSelectElement;
  const targets = select.value === 'all' ? mixes.filter((m) => m !== mix) : [mixes[Number(select.value)]].filter((m) => m && m !== mix);
  select.value = '';
  if (!recording || busy || targets.length === 0) return;
  for (const target of targets) {
    if (mix.eq) target.eq = { ...mix.eq };
    else delete target.eq;
  }
  $('readout').textContent =
    targets.length === 1 ? `“${targets[0].name}” now has this EQ too. Undo takes it back.` : `Every other mix now has this EQ too. Undo takes it back.`;
  drawEqPanel();
  scheduleRecompute();
});

onThemeChange(syncEq);

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

/** Opens a recording: one file, or several that are its parts. */
async function open(files: string[]) {
  if (busy || files.length === 0) return;
  let path = files[0];
  let name = path.split(/[\\/]/).pop()!;
  progressLabel = `Analysing ${name}`;
  cancelRequested = false;
  setBusy(progressLabel);
  $('export-status').textContent = '';
  try {
    ({ path, name } = await api.recordingOf(files));
    progressLabel = `Analysing ${name}`;
    $('progress-label').textContent = progressLabel;
    const measured = await api.measure(path);
    if (measured.peaks.length === 0) throw new Error('The recording is too short to analyse');
    const source = await api.mediaUrl(path);
    recording = {
      path,
      name,
      measured,
      body: Float32Array.from(measured.blocks, (energy) => Math.sqrt(energy / 2)),
      gaps: findGaps(measured.blocks),
      checkup: checkup(measured),
      video: source.video,
    };
    finePieces.clear();
    showCheckup();
    overviewShown = { start: 0, end: measured.peaks.length };
    player.load(source);
    $('picture-delay-row').hidden = !source.video;
    $('file-name').textContent = name;
    $('file-name').classList.add('loaded');
    $('empty').hidden = true;
    $('settings').inert = false;
    $('views').hidden = false;
    const restored = restore(await api.recall(path), measured.peaks.length);
    // Only fixes the check-up offers for this recording; heard from the start.
    channelFixes = channelFixes.filter((id) => recording!.checkup.findings.some((finding) => finding.id === id && finding.fix));
    fixedFor = null;
    player.setChannels(channelMix());
    showCheckup();
    $<HTMLInputElement>('picture-delay').value = String(pictureDelayMs);
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
        if ((await api.existing([path])).length > 0) open([path]);
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
  if (saveDue('session')) saveNow();
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  player.unload();
  levelMeter.release();
  recording = null;
  finePieces.clear();
  mixes = [];
  tracks = [];
  channelFixes = [];
  player.setChannels(UNMIXED);
  selectedTrack = null;
  detail = null;
  drag = null;
  grab = null;
  undoSteps = [];
  redoSteps = [];
  settled = null;
  videoView.refresh();
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
    const files = await api.pickFiles();
    if (files) open(files);
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
  tracks?: Track[];
  pictureDelayMs?: number;
  /** The check-up's channel fixes in use, by the ids of their findings. */
  channels?: string[];
}

interface Defaults {
  options: LevelOptions;
  ceilingDb: number;
  loudness?: string;
}

function saveNow() {
  cancelSave('session');
  if (!recording || mixes.length === 0) return;
  const session: Session = {
    version: 1,
    blocks: recording.measured.peaks.length,
    selected: Math.max(0, mixes.indexOf(mix)),
    mixesCreated,
    mixes,
    album,
    tracks,
    ...(pictureDelayMs ? { pictureDelayMs } : {}),
    channels: channelFixes,
  };
  const defaults: Defaults = { options: mix.options, ceilingDb: mix.ceilingDb, ...(mix.loudness ? { loudness: mix.loudness } : {}) };
  api.remember(recording.path, { session, defaults: { ...defaults, export: exportSettings } });
  settleHistory();
}

/** Saves shortly after the last change, so dragging does not write on every frame. */
function scheduleSave() {
  if (!recording) return;
  saveLater('session', saveNow);
}

window.addEventListener('beforeunload', () => {
  if (saveDue('session')) saveNow();
});

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
/** A template choice read back from disk, or null if it is not one. */
function visualsChoice(value: unknown): VisualsChoice | null {
  const given = value as Partial<VisualsChoice> | null;
  if (!given || typeof given.template !== 'string' || typeof given.fields !== 'object' || given.fields === null) return null;
  const fields: Record<string, string | number> = {};
  for (const [key, field] of Object.entries(given.fields)) if (typeof field === 'string' || isNumber(field)) fields[key] = field;
  return { template: given.template, fields, ...(given.shape !== undefined ? { shape: shapeOf(given.shape) } : {}) };
}
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
    format: EXPORT_FORMATS.find((format) => format === saved.format) ?? DEFAULT_EXPORT_SETTINGS.format,
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
      ...(isNumber(m.trimStart) && m.trimStart > 0 && m.trimStart < 1 ? { trimStart: fine(m.trimStart) } : {}),
      ...(isNumber(m.trimEnd) && m.trimEnd > 0 && m.trimEnd < 1 ? { trimEnd: fine(m.trimEnd) } : {}),
      ...(isNumber(m.fadeIn) && m.fadeIn > 0 ? { fadeIn: Math.round(m.fadeIn) } : {}),
      ...(isNumber(m.fadeOut) && m.fadeOut > 0 ? { fadeOut: Math.round(m.fadeOut) } : {}),
      ...(visualsChoice(m.visuals) ? { visuals: visualsChoice(m.visuals)! } : {}),
      ...(checkedEq(m.eq) ? { eq: checkedEq(m.eq)! } : {}),
    }));
    album = typeof session!.album === 'string' ? session!.album : '';
    pictureDelayMs = isNumber(session!.pictureDelayMs) ? clamp(Math.round(session!.pictureDelayMs), -MOST_PICTURE_DELAY_MS, MOST_PICTURE_DELAY_MS) : 0;
    channelFixes = (Array.isArray(session!.channels) ? session!.channels : []).filter((id): id is string => typeof id === 'string');
    tracks = (Array.isArray(session!.tracks) ? session!.tracks : [])
      .filter((t) => isNumber(t?.at) && t.at >= 0 && t.at <= total * HOP_SECONDS && typeof t.name === 'string')
      .map((t) => ({ at: Math.round(t.at * 1000) / 1000, name: t.name, ...(t.guessed === true ? { guessed: true } : {}) }))
      .sort((a, b) => a.at - b.at);
    mixesCreated = Math.max(mixes.length, isNumber(session!.mixesCreated) ? session!.mixesCreated : 0);
    const selected = isNumber(session!.selected) ? clamp(session!.selected, 0, mixes.length - 1) : 0;
    return { selected, fromLastTime: true };
  }

  mixes = [{ name: 'Mix 1', region: { start: 0, end: total }, ...defaults, adjustments: [] }];
  album = '';
  pictureDelayMs = 0;
  tracks = [];
  channelFixes = [];
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
  /** The mixes and the tracks as JSON, which is also what tells two states apart. */
  mixes: string;
  tracks: string;
  channels: string;
  pictureDelayMs: number;
  selected: number;
  mixesCreated: number;
}

const MAX_UNDO_STEPS = 100;
let undoSteps: Step[] = [];
let redoSteps: Step[] = [];
/** The state as of the last settled change. */
let settled: Step | null = null;

function snapshot(): Step {
  return { mixes: JSON.stringify(mixes), tracks: JSON.stringify(tracks), channels: JSON.stringify(channelFixes), pictureDelayMs, selected: Math.max(0, mixes.indexOf(mix)), mixesCreated };
}

/** Records the changes since the last settled state, if any, as one undo step. */
function settleHistory() {
  if (!settled) return;
  const now = snapshot();
  if (now.mixes === settled.mixes && now.tracks === settled.tracks && now.channels === settled.channels && now.pictureDelayMs === settled.pictureDelayMs) {
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
  // While a template is edited, undo and redo work on the template.
  const editing = videoView.editing;
  $<HTMLButtonElement>('undo').disabled = busy || (editing ? !videoView.canUndoTemplate : undoSteps.length === 0);
  $<HTMLButtonElement>('redo').disabled = busy || (editing ? !videoView.canRedoTemplate : redoSteps.length === 0);
}

function applyStep(step: Step) {
  $('export-status').textContent = '';
  mixes = JSON.parse(step.mixes);
  tracks = JSON.parse(step.tracks);
  channelFixes = JSON.parse(step.channels);
  channelsChanged();
  pictureDelayMs = step.pictureDelayMs;
  $<HTMLInputElement>('picture-delay').value = String(pictureDelayMs);
  videoView.refresh();
  selectedTrack = null;
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
  if (videoView.editing) return videoView.stepTemplate(direction);
  // Count a change still in progress as done, so that it is what gets undone.
  if (saveDue('session')) saveNow();
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
$('split-here').title = `Split at playhead (${COMMAND}E): cut this mix in two where the playhead is`;
$('undo').title = `Undo the last change (${COMMAND}Z)`;
$('redo').title = `Redo the change just undone (Shift+${COMMAND}Z)`;

const HELP = shortcuts({ command: COMMAND, option: OPTION });

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
$('help-manual').addEventListener('click', () => api.openManual());

const settings = settingsDialog(api);
onThemeChange(scheduleDraw);
settings.start();
$('open-settings').title = `Settings (${COMMAND},)`;
$('open-settings').addEventListener('click', () => settings.open());

api.onMenu(async (command) => {
  if (command === 'help') {
    showHelp();
    return;
  }
  if (command === 'settings') {
    settings.open();
    return;
  }
  if (command === 'close') {
    closeRecording();
    return;
  }
  if (command === 'open') {
    const files = busy ? null : await api.pickFiles();
    if (files) open(files);
    return;
  }
  // While typing in a field, undo belongs to the text.
  const field = document.activeElement;
  const typing = field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && ['text', 'email', 'url', 'search', 'number'].includes(field.type));
  if (typing) document.execCommand(command);
  else if (command === 'undo') undo();
  else redo();
});

/** File-name-safe version of a mix name. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'mix';
/** Whether a mix still has the name it was given automatically. */
const hasDefaultName = (m: Mix) => /^Mix \d+$/.test(m.name);
// A recording in parts is named like "REC00*.WAV (3 files)"; its exports take the common part.
const recordingStem = () =>
  recording!.name.replace(/ \(\d+ files\)$/, '').replace(/\.[^.]+$/, '').replace(/\*/g, '').replace(/[\s_-]+$/, '') || 'recording';

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

/** `original` is a video with the recording's own picture, for a recording that is a video. */
type ExportFormat = 'wav' | 'flac' | 'mp3' | 'm4a' | 'mp4' | 'original';
const EXPORT_FORMATS: ExportFormat[] = ['wav', 'flac', 'mp3', 'm4a', 'mp4', 'original'];

/**
 * A video export's picture: 30 frames a second, at the bitrate YouTube asks
 * for 1080p. Its size is its shape's (`SHAPES`): a vertical or square picture
 * 1080 across has no more to it than a landscape one.
 */
const VIDEO = { fps: 30, kbps: 8000 };

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
const BITRATES: Record<'mp3' | 'm4a' | 'mp4' | 'original', number[]> = {
  mp3: [320, 256, 192, 128], m4a: [320, 256, 192, 128], mp4: [320, 256, 192, 128], original: [320, 256, 192, 128],
};
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
  const seconds = (edges(m).end - edges(m).start) * HOP_SECONDS;
  if (settings.format === 'mp3') return (seconds * settings.mp3Kbps * 1000) / 8;
  if (settings.format === 'm4a') return (seconds * settings.aacKbps * 1000) / 8;
  if (settings.format === 'mp4') return (seconds * (settings.aacKbps + VIDEO.kbps) * 1000) / 8;
  if (settings.format === 'original') return (seconds * (settings.aacKbps + (recording!.video?.bitrateKbps ?? VIDEO.kbps)) * 1000) / 8;
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
  // A recording that is not a video has no picture of its own to keep.
  if (exportSettings.format === 'original' && !recording!.video) exportSettings.format = 'mp4';
  const settings = exportSettings;
  $('export-original').hidden = !recording!.video;
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
    const format = settings.format as 'mp3' | 'm4a' | 'mp4' | 'original';
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
  } else if (settings.format === 'mp4') {
    const choices = exportingMixes.map((m) => visualsOf(m));
    const named = choices.map((choice) => templateOf(choice).name);
    const which = new Set(named).size === 1 ? `the ${named[0]} template` : 'each mix\'s template';
    const shapes = new Set(choices.map((choice) => shapeOf(choice?.shape)));
    const [shape] = shapes;
    const picture = shapes.size === 1 ? `A ${SHAPES[shape].width} × ${SHAPES[shape].height} picture` : 'A picture in each mix\'s shape';
    note += ` ${picture} of ${which}, chosen in the Video view, with the sound in AAC. Drawing the picture takes a while.`;
  } else if (settings.format === 'original') {
    const { width, height } = recording!.video!;
    note += ` The recording's own ${width} × ${height} picture with the mastered sound in AAC, as ${originalPictureExtension(recording!.video!.codec).toUpperCase()}.`
      + ' The picture is copied, not encoded again, so this is about as quick as exporting the sound.';
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
    bitrateKbps: format === 'mp3' ? mp3Kbps : format === 'm4a' || format === 'mp4' || format === 'original' ? aacKbps : undefined,
    // Players that know chapters show the tracks; formats that cannot carry them ignore this.
    chapters: mixTracks(m).length ? chaptersOf(mixTracks(m), mixSeconds(m).end - mixSeconds(m).start) : undefined,
  };
}

/** The extension of the files the export settings make. */
function exportExtension(): string {
  return exportSettings.format === 'original' ? originalPictureExtension(recording!.video!.codec) : exportSettings.format;
}

// ---------------------------------------------------------------------------
// Fixes for the recording's channels, offered by the check-up

/** The mix that puts the recording's channels right, from the fixes in use. */
function channelMix(): ChannelMix {
  if (!recording) return UNMIXED;
  return recording.checkup.findings
    .filter((finding) => finding.fix && channelFixes.includes(finding.id))
    .reduce((mix, finding) => then(mix, finding.fix!), UNMIXED);
}

let fixedFor: { key: string; measured: Examination } | null = null;

/**
 * The analysis as the levelling should see it: the recording's loudness as it
 * is once its channels are put right. The faults last the whole recording, so
 * the loudness curves move by one amount throughout.
 */
function measuredAsFixed(): Examination {
  const { measured } = recording!;
  const mix = channelMix();
  if (isUnmixed(mix)) return measured;
  const key = `${recording!.path}|${JSON.stringify(mix)}`;
  if (fixedFor?.key === key) return fixedFor.measured;
  const { left, right, cross } = measured.diagnostics;
  const db = loudnessChangeDb(left, right, cross, mix);
  const factor = 10 ** (db / 10);
  const shift = (curve: Float32Array) => curve.map((value) => value + db);
  fixedFor = {
    key,
    measured: {
      ...measured,
      blocks: measured.blocks.map((energy) => energy * factor),
      shortTerm: shift(measured.shortTerm),
      lowShortTerm: shift(measured.lowShortTerm),
      restShortTerm: shift(measured.restShortTerm),
    },
  };
  return fixedFor.measured;
}

/** A fix of the check-up's put to use, or taken back: heard at once, and kept with the recording. */
function setChannelFix(id: string, on: boolean) {
  channelFixes = on ? [...new Set([...channelFixes, id])] : channelFixes.filter((fix) => fix !== id);
  channelsChanged();
  scheduleSave();
}

function channelsChanged() {
  player.setChannels(channelMix());
  if (recording) showCheckup();
  scheduleRecompute();
}

function renderMix(m: Mix, output: string, track?: string) {
  const { gainDb, bassDb } = compute(m).detail;
  const video = videoMixOf(m);
  return api.render({
    input: recording!.path,
    output,
    // To the millisecond; the curves are a block coarser, which at their pace makes no difference.
    start: edges(m).start * HOP_SECONDS,
    end: edges(m).end * HOP_SECONDS,
    gainDb,
    bassDb: bassDb ?? new Float32Array(gainDb.length),
    ceilingDb: m.ceilingDb,
    encode: encodeOptions(m, track),
    headroomDb: isLossy(output) && exportSettings.lossyHeadroom ? LOSSY_HEADROOM_DB : 0,
    fadeInSeconds: fades(m).in * HOP_SECONDS,
    fadeOutSeconds: fades(m).out * HOP_SECONDS,
    ...(isUnmixed(channelMix()) ? {} : { channels: channelMix() }),
    ...(isFlat(m.eq) ? {} : { eq: m.eq }),
    ...(exportSettings.format === 'mp4' ? { video: { ...VIDEO, width: SHAPES[video.shape].width, height: SHAPES[video.shape].height, mix: video } } : {}),
    ...(exportSettings.format === 'original' ? { originalPicture: true, pictureDelay: pictureDelayMs / 1000 } : {}),
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
  const output = await api.pickOutput(`${folder}${fileName(exportName(mix))}.${exportExtension()}`);
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
  const extension = exportExtension();
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
    showExported(`Exported ${done} ${done === 1 ? 'mix' : 'mixes'}.`, outputs[0]);
  } catch (error) {
    $('export-status').textContent = wasCancelled(error)
      ? `Export cancelled after ${done} of ${mixes.length} mixes.`
      : `Export stopped at "${mixes[done].name}" after ${done} of ${mixes.length}: ${message(error)}`;
  } finally {
    setBusy(null);
  }
}

// The picture of a recording that is a video, put in step with its sound.
$<HTMLInputElement>('picture-delay').addEventListener('input', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  pictureDelayMs = clamp(Math.round(value), -MOST_PICTURE_DELAY_MS, MOST_PICTURE_DELAY_MS);
  videoView.refresh();
  scheduleSave();
});

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
  openFiles([...(event.dataTransfer?.files ?? [])].map((file) => api.pathForFile(file)));
});

/**
 * Files from outside: dropped, opened from Finder or named on the command
 * line. Video templates are added, and shown in the Video view; anything else
 * is a recording to open (several together, the parts of one), first, so
 * that the templates become its mix's.
 */
async function openFiles(files: string[]) {
  const templates = files.filter((file) => /\.djmtemplate$/i.test(file));
  const recordings = files.filter((file) => !templates.includes(file));
  if (recordings.length) await open(recordings);
  if (!templates.length) return;
  if (recording) showVideo(true);
  for (const template of templates) await videoView.importFile(template);
}

new ResizeObserver(scheduleDraw).observe(detailCanvas);
new ResizeObserver(scheduleDraw).observe(overview);

$('view-mastering').addEventListener('click', () => showVideo(false));
$('view-video').addEventListener('click', () => showVideo(true));

syncControls();
initTooltips();
initFaderReset();
api.onOpenFiles(openFiles);
showRecent();
api.initialFile().then(async (files) => {
  if (files) await openFiles(files);
  await restoreView();
});
