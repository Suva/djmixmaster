// Canvas drawing for the recording overview and the three-lane detail view.

import type { Adjustment } from '../../gain-curve.ts';
import { fadeGain } from '../../fade.ts';
import { HOP_SECONDS } from '../../loudness.ts';

const COLOR = {
  grid: '#262a33',
  text: '#8b93a1',
  label: '#c9ced8',
  before: '#6b7280',
  after: '#3ddc97',
  otherMix: '#2c8f66',
  gain: '#f2a83b',
  bass: '#6aa9ff',
  warn: '#ff5d5d',
  // The limiter at work is no fault, so it is not red, which stays for clipping
  // in the recording. The meter's limiter column uses the same amber.
  limited: '#f2a83b',
  hover: '#e6e8ec',
};
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Left margin of the detail view that holds the axis labels. */
export const GUTTER = 48;
const AXIS = 18;
const LOUDNESS_SPAN_DB = 24;
/** Draws the body of the sound larger than life: average levels are small next to peaks. */
const BODY_SCALE = 2;

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

const clampTo = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Sizes the backing store to the element and returns a context scaled to CSS pixels. */
function fit(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  return { ctx, width, height };
}

/** Reduces `values` to one number per pixel column. */
function columns(values: ArrayLike<number>, width: number, reduce: 'max' | 'min' | 'mean'): Float32Array {
  const n = values.length;
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const lo = Math.min(n - 1, Math.floor((x * n) / width));
    const hi = Math.max(lo + 1, Math.min(n, Math.floor(((x + 1) * n) / width)));
    let acc = reduce === 'max' ? -Infinity : reduce === 'min' ? Infinity : 0;
    for (let i = lo; i < hi; i++) {
      acc = reduce === 'max' ? Math.max(acc, values[i]) : reduce === 'min' ? Math.min(acc, values[i]) : acc + values[i];
    }
    out[x] = reduce === 'mean' ? acc / (hi - lo) : acc;
  }
  return out;
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function timeAxis(ctx: CanvasRenderingContext2D, startSeconds: number, endSeconds: number, x0: number, x1: number, y: number) {
  const span = endSeconds - startSeconds;
  const step = TICK_STEPS.find((s) => (span / s) * 70 <= x1 - x0) ?? TICK_STEPS[TICK_STEPS.length - 1];
  ctx.fillStyle = COLOR.text;
  ctx.textAlign = 'center';
  // Counted in tenths of a second, so that steps under a second add up exactly.
  const stepTenths = Math.round(step * 10);
  for (let tenths = Math.ceil((startSeconds * 10) / stepTenths) * stepTenths; tenths <= endSeconds * 10; tenths += stepTenths) {
    const t = tenths / 10;
    const x = x0 + ((t - startSeconds) / span) * (x1 - x0);
    if (x < x0 + 24 || x > x1 - 24) continue;
    ctx.fillText(step < 1 ? `${clock(Math.floor(t))}.${tenths % 10}` : clock(t), x, y);
  }
}

export interface Region {
  /** First block of the mix and the block just past its end. */
  start: number;
  end: number;
}

/** What the overview needs to know about the recording. */
export interface OverviewData {
  /** Highest sample value per block. */
  peaks: Float32Array;
  /** Average level per block, which keeps showing structure when the peaks are all at full scale. */
  body: Float32Array;
  /** Silences between sets, in blocks. */
  gaps: Region[];
  /** Where the check-up found clipping, and possible dropouts. */
  clipping: Region[];
  dropouts: Region[];
}

/**
 * Draws blocks `shown.start` to `shown.end` of the recording with every marked
 * mix on it. `view` is the part of the selected mix the detail view is showing
 * and `playhead` a block position in the recording, or null to hide it.
 */
export function drawOverview(
  canvas: HTMLCanvasElement, data: OverviewData, shown: Region,
  mixes: (Region & { name: string })[], selected: number, view: Region, playhead: number | null,
) {
  const { ctx, width, height } = fit(canvas);
  const waveHeight = height - AXIS;
  const mid = waveHeight / 2;
  const span = shown.end - shown.start;
  if (span <= 0) return;
  const peaks = columns(data.peaks.subarray(shown.start, shown.end), width, 'max');
  const body = columns(data.body.subarray(shown.start, shown.end), width, 'mean');
  const toX = (block: number) => ((block - shown.start) / span) * width;

  // Which mix, if any, each pixel column belongs to.
  const owner = new Int16Array(width).fill(-1);
  mixes.forEach((mix, index) => {
    const x0 = Math.max(0, toX(mix.start));
    const x1 = Math.min(width, toX(mix.end));
    if (x1 <= x0) return;
    for (let x = Math.ceil(x0); x < x1; x++) owner[x] = index;
    ctx.fillStyle = index === selected ? 'rgba(61, 220, 151, 0.12)' : 'rgba(61, 220, 151, 0.05)';
    ctx.fillRect(x0, 0, x1 - x0, waveHeight);
  });
  for (let x = 0; x < width; x++) {
    const color = owner[x] < 0 ? COLOR.before : owner[x] === selected ? COLOR.after : COLOR.otherMix;
    // Peaks faintly, the body of the sound solid on top.
    const outer = Math.max(0.5, Math.min(1, peaks[x]) * (mid - 2));
    const inner = Math.max(0.5, Math.min(1, body[x] * BODY_SCALE) * (mid - 2));
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, mid - outer, 1, outer * 2);
    ctx.globalAlpha = 1;
    ctx.fillRect(x, mid - inner, 1, inner * 2);
  }
  mixes.forEach((mix, index) => {
    const x0 = Math.round(toX(mix.start));
    const x1 = Math.round(toX(mix.end));
    ctx.fillStyle = index === selected ? COLOR.after : COLOR.otherMix;
    ctx.fillRect(x0 - 1, 0, 2, waveHeight);
    ctx.fillRect(x1 - 1, 0, 2, waveHeight);
    // The mix's number and as much of its name as fits inside it.
    const labelX = Math.max(0, x0);
    const room = Math.min(width, x1) - labelX - 14;
    let label = `${index + 1}  ${mix.name}`;
    while (label.length > 1 && ctx.measureText(label).width > room) label = `${label.slice(0, -2).trimEnd()}…`;
    if (room > 8 && ctx.measureText(label).width <= room) {
      ctx.fillStyle = 'rgba(16, 18, 22, 0.85)';
      ctx.fillRect(labelX + 1, 0, ctx.measureText(label).width + 10, 15);
      ctx.fillStyle = index === selected ? COLOR.after : COLOR.label;
      ctx.textAlign = 'left';
      ctx.fillText(label, labelX + 6, 8);
    }
  });

  // Silences between sets, drawn wide enough to see even when they are seconds in hours.
  ctx.fillStyle = COLOR.gain;
  for (const gap of data.gaps) {
    if (gap.end < shown.start || gap.start > shown.end) continue;
    const x0 = toX(gap.start);
    ctx.fillRect(Math.round(x0), waveHeight - 6, Math.max(2, toX(gap.end) - x0), 6);
  }

  // What the check-up found: clipping along the top edge, possible dropouts as ticks.
  const marks: [Region[], string, number][] = [[data.clipping, COLOR.warn, 3], [data.dropouts, COLOR.hover, 7]];
  for (const [regions, color, tall] of marks) {
    ctx.fillStyle = color;
    for (const mark of regions) {
      if (mark.end < shown.start || mark.start > shown.end) continue;
      const x0 = toX(mark.start);
      ctx.fillRect(Math.round(x0), 0, Math.max(2, toX(mark.end) - x0), tall);
    }
  }

  const zoomedMix = mixes[selected];
  if (zoomedMix && view.end - view.start < zoomedMix.end - zoomedMix.start) {
    // Mark the part of the mix the detail view is zoomed in on.
    ctx.fillStyle = COLOR.hover;
    ctx.fillRect(toX(view.start), waveHeight - 3, Math.max(2, toX(view.end) - toX(view.start)), 3);
  }
  if (playhead !== null && playhead >= shown.start && playhead <= shown.end) {
    ctx.fillStyle = COLOR.hover;
    ctx.fillRect(Math.round(toX(playhead)), 0, 1, waveHeight);
  }

  timeAxis(ctx, shown.start * HOP_SECONDS, shown.end * HOP_SECONDS, 0, width, height - AXIS / 2);
}

/** Everything the detail view shows, one value per block of the region. */
export interface Detail {
  /** Block index of the region's start within the recording, for the time axis. */
  startBlock: number;
  peaksIn: Float32Array;
  peaksOut: Float32Array;
  /** Average level of the levelled result per block. */
  bodyOut: Float32Array;
  /** What the levelling, the bass change and the fades together do to the level of each block, as a factor. */
  peakGain: Float32Array;
  loudnessIn: Float32Array;
  loudnessOut: Float32Array;
  gainDb: Float32Array;
  /** Bass shelf gain, or null when bass correction is off. */
  bassDb: Float32Array | null;
  /** Manual gain changes, in blocks counted from the start of the mix. */
  adjustments: Adjustment[];
  /** Length in blocks of the fades at the two ends of the mix. */
  fadeIn: number;
  fadeOut: number;
  /** Where in these curves the mix really starts and ends, in blocks: its edges can lie inside the first and last block. */
  from: number;
  to: number;
  targetLufs: number;
  /** Limiter ceiling as a linear sample value. */
  ceiling: number;
}

const LANE_GAP = 10;
/** How far below the top of the waveform lane the fade handles sit, clear of the legend. */
export const FADE_HANDLE_Y = 28;
const FADE_HANDLE_SIZE = 9;

/** Where the three lanes of the detail view sit, top to bottom, for a canvas of this height. */
export function detailLanes(height: number) {
  const usable = height - AXIS;
  const wave = { top: 0, height: Math.round(usable * 0.38) };
  const loudness = { top: wave.height + LANE_GAP, height: Math.round(usable * 0.38) - LANE_GAP };
  const gainTop = loudness.top + loudness.height + LANE_GAP;
  return { wave, loudness, gain: { top: gainTop, height: usable - gainTop } };
}

/** How much of a lane's legend shows while the pointer is elsewhere. */
const LEGEND_FAINT = 0.28;

/**
 * The legend of a lane. It lies over the curves, so it is only a hint until
 * the pointer rests on it; then it shows in full, on a backing that keeps it
 * readable over a full waveform.
 */
function laneLabel(
  ctx: CanvasRenderingContext2D, x: number, y: number, parts: [string, string][], pointer: { x: number; y: number } | null,
) {
  ctx.textAlign = 'left';
  const widthOfAll = parts.reduce((sum, [text]) => sum + ctx.measureText(text).width + 12, 0);
  const pointedAt =
    pointer !== null && pointer.x >= x - 6 && pointer.x <= x - 4 + widthOfAll && pointer.y >= y - 10 && pointer.y <= y + 10;
  if (pointedAt) {
    ctx.fillStyle = 'rgba(16, 18, 22, 0.8)';
    ctx.fillRect(x - 6, y - 9, widthOfAll + 2, 18);
  }
  ctx.globalAlpha = pointedAt ? 1 : LEGEND_FAINT;
  for (const [text, color] of parts) {
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + 12;
  }
  ctx.globalAlpha = 1;
}

/**
 * Draws the part of the mix between blocks `view.start` and `view.end`, counted
 * from the start of the mix. `playhead` is a block position on the same scale,
 * or null to hide it.
 */
export function drawDetail(
  canvas: HTMLCanvasElement, detail: Detail, view: Region, hoverX: number | null, playhead: number | null,
  /** How far down the canvas the pointer is, when it is over it. */
  hoverY: number | null,
  /** Index of the adjustment under the pointer or being dragged, if any. */
  activeAdjustment: number | null,
  /** Which fade handle is under the pointer or being dragged, if any. */
  activeFade: 'in' | 'out' | null,
  /** The original as a wave across exactly this view, fine enough to show a beat; null when not zoomed in that far. */
  fine: { low: Float32Array; high: Float32Array } | null,
) {
  const { ctx, width, height } = fit(canvas);
  const plot = width - GUTTER;
  const total = detail.gainDb.length;
  const n = view.end - view.start;
  if (plot < 10 || total === 0 || n <= 0) return;
  // The view need not start or end on a block: close up it moves by the
  // millisecond, or scrolling and zooming would go in jumps of a tenth of a second.
  /** A curve reduced to one value per pixel across the view. */
  const across = (values: Float32Array, reduce: 'max' | 'mean'): Float32Array => {
    const out = new Float32Array(plot);
    for (let x = 0; x < plot; x++) {
      const lo = clampTo(Math.floor(view.start + (x / plot) * n), 0, total - 1);
      const hi = clampTo(Math.ceil(view.start + ((x + 1) / plot) * n), lo + 1, total);
      let acc = reduce === 'max' ? -Infinity : 0;
      for (let i = lo; i < hi; i++) acc = reduce === 'max' ? Math.max(acc, values[i]) : acc + values[i];
      out[x] = reduce === 'max' ? acc : acc / (hi - lo);
    }
    return out;
  };
  const pointer = hoverX !== null && hoverY !== null ? { x: hoverX, y: hoverY } : null;

  const usable = height - AXIS;
  const gap = LANE_GAP;
  const { wave: waveLane, loudness: loudLane, gain: gainLane } = detailLanes(height);

  const gridLine = (y: number, label: string) => {
    ctx.fillStyle = COLOR.grid;
    ctx.fillRect(GUTTER, Math.round(y), plot, 1);
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'right';
    ctx.fillText(label, GUTTER - 6, y);
  };
  const separator = (y: number) => {
    ctx.fillStyle = '#14161a';
    ctx.fillRect(0, y, width, gap);
  };
  const line = (values: Float32Array, toY: (v: number) => number, color: string, lineWidth: number) => {
    // One point per pixel when zoomed out, one per block when zoomed in.
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, 0, plot, usable);
    ctx.clip();
    ctx.beginPath();
    if (n > plot) {
      const points = across(values, 'mean');
      for (let x = 0; x < plot; x++) ctx.lineTo(GUTTER + x + 0.5, toY(points[x]));
    } else {
      // Each value sits at the centre of its block. One more on either side
      // carries the line out to the edges of the view.
      const first = Math.max(0, Math.floor(view.start) - 1);
      const last = Math.min(total - 1, Math.ceil(view.end));
      for (let i = first; i <= last; i++) ctx.lineTo(GUTTER + ((i + 0.5 - view.start) / n) * plot, toY(values[i]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };

  // Lane 1: waveform, original behind the levelled result.
  {
    const mid = waveLane.top + waveLane.height / 2;
    const scale = waveLane.height / 2 - 4;
    if (fine) {
      // Close up it is the wave itself: from the lowest to the highest sample
      // under each pixel, which is what gives a kick drum its shape. The
      // levelling comes from the curves, which move far too slowly to need
      // any finer steps.
      const low = columns(fine.low, plot, 'min');
      const high = columns(fine.high, plot, 'max');
      const bar = (x: number, from: number, to: number) => {
        const top = mid - Math.min(1, to) * scale;
        ctx.fillRect(GUTTER + x, top, 1, Math.max(1, mid - Math.max(-1, from) * scale - top));
      };
      for (let x = 0; x < plot; x++) {
        // Nothing is left of the levelled sound outside the mix's own edges,
        // which close up can be seen to lie inside the first or last block.
        const at = view.start + ((x + 0.5) / plot) * n;
        const inside = at >= detail.from && at < detail.to;
        const gain = inside ? detail.peakGain[Math.min(total - 1, Math.floor(at))] : 0;
        ctx.fillStyle = COLOR.before;
        bar(x, low[x], high[x]);
        if (!inside) continue;
        ctx.fillStyle = COLOR.after;
        bar(x, Math.max(-detail.ceiling, low[x] * gain), Math.min(detail.ceiling, high[x] * gain));
        // Peaks the limiter will have to hold down.
        ctx.fillStyle = COLOR.limited;
        const edge = Math.min(1, detail.ceiling) * scale;
        if (high[x] * gain > detail.ceiling) ctx.fillRect(GUTTER + x, mid - edge - 3, 1, 3);
        if (low[x] * gain < -detail.ceiling) ctx.fillRect(GUTTER + x, mid + edge, 1, 3);
      }
    }
    const before = fine ? new Float32Array(0) : across(detail.peaksIn, 'max');
    const after = fine ? before : across(detail.peaksOut, 'max');
    const body = fine ? before : across(detail.bodyOut, 'mean');
    for (let x = 0; x < before.length; x++) {
      const b = Math.min(1, before[x]) * scale;
      ctx.fillStyle = COLOR.before;
      ctx.fillRect(GUTTER + x, mid - b, 1, b * 2);
      const a = Math.min(1, Math.min(after[x], detail.ceiling)) * scale;
      const inner = Math.min(a, Math.min(1, body[x] * BODY_SCALE) * scale);
      ctx.fillStyle = COLOR.after;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(GUTTER + x, mid - a, 1, a * 2);
      ctx.globalAlpha = 1;
      ctx.fillRect(GUTTER + x, mid - inner, 1, inner * 2);
      if (after[x] > detail.ceiling) {
        // Peaks the limiter will have to hold down.
        ctx.fillStyle = COLOR.limited;
        ctx.fillRect(GUTTER + x, mid - a - 3, 1, 3);
        ctx.fillRect(GUTTER + x, mid + a, 1, 3);
      }
    }
    gridLine(mid, '');
    gridLine(mid - scale, '0 dB');

    // The fades: the shape the sound is held under, and a handle to drag at
    // the inner end of each. With no fade the handle sits in the mix's corner.
    const toX = (block: number) => GUTTER + ((block - view.start) / n) * plot;
    if (detail.fadeIn > 0 || detail.fadeOut > 0) {
      ctx.beginPath();
      for (let x = 0; x <= plot; x++) {
        const fade = fadeGain(view.start + (x / plot) * n - detail.from, detail.to - detail.from, detail.fadeIn, detail.fadeOut);
        if (x === 0) ctx.moveTo(GUTTER + x, mid - fade * scale);
        else ctx.lineTo(GUTTER + x, mid - fade * scale);
      }
      for (let x = plot; x >= 0; x--) {
        ctx.lineTo(GUTTER + x, mid + fadeGain(view.start + (x / plot) * n - detail.from, detail.to - detail.from, detail.fadeIn, detail.fadeOut) * scale);
      }
      ctx.closePath();
      ctx.strokeStyle = COLOR.hover;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const handles: ['in' | 'out', number][] = [['in', detail.from + detail.fadeIn], ['out', detail.to - detail.fadeOut]];
    for (const [which, block] of handles) {
      if (block < view.start || block > view.end) continue;
      // Keep the whole handle inside the lane when it sits in a corner.
      const x = clampTo(toX(block), GUTTER + FADE_HANDLE_SIZE / 2, width - FADE_HANDLE_SIZE / 2);
      const y = waveLane.top + FADE_HANDLE_Y;
      ctx.fillStyle = activeFade === which ? COLOR.hover : '#14161a';
      ctx.strokeStyle = COLOR.hover;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(x - FADE_HANDLE_SIZE / 2, y - FADE_HANDLE_SIZE / 2, FADE_HANDLE_SIZE, FADE_HANDLE_SIZE);
      ctx.fill();
      ctx.stroke();
    }

    laneLabel(ctx, GUTTER + 8, waveLane.top + 10, [
      ['Waveform', COLOR.label], ['original', COLOR.before], ['levelled', COLOR.after], ['limited', COLOR.limited],
    ], pointer);
  }

  // Lane 2: short-term loudness before and after.
  separator(waveLane.height);
  {
    let top = detail.targetLufs;
    // Scales come from the whole mix, so they hold still while zooming and scrolling.
    for (let i = 0; i < total; i++) top = Math.max(top, detail.loudnessIn[i], detail.loudnessOut[i]);
    top = Math.ceil(top + 1);
    const bottom = top - LOUDNESS_SPAN_DB;
    const toY = (lufs: number) =>
      loudLane.top + ((top - Math.max(bottom, lufs)) / LOUDNESS_SPAN_DB) * (loudLane.height - 2) + 1;
    for (let lufs = Math.floor(top / 6) * 6; lufs > bottom; lufs -= 6) gridLine(toY(lufs), `${lufs}`);

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLOR.label;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER, Math.round(toY(detail.targetLufs)) + 0.5);
    ctx.lineTo(width, Math.round(toY(detail.targetLufs)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER, loudLane.top, plot, loudLane.height);
    ctx.clip();
    line(detail.loudnessIn, toY, COLOR.before, 1.25);
    line(detail.loudnessOut, toY, COLOR.after, 1.5);
    ctx.restore();
    laneLabel(ctx, GUTTER + 8, loudLane.top + 10, [
      ['Loudness (LUFS)', COLOR.label], ['original', COLOR.before], ['levelled', COLOR.after], ['- - target', COLOR.label],
    ], pointer);
  }

  // Lane 3: the gain being applied.
  separator(loudLane.top + loudLane.height);
  {
    let lo = -3;
    let hi = 3;
    for (let i = 0; i < total; i++) {
      lo = Math.min(lo, detail.gainDb[i] - 1, (detail.bassDb?.[i] ?? 0) - 1);
      hi = Math.max(hi, detail.gainDb[i] + 1, (detail.bassDb?.[i] ?? 0) + 1);
    }
    const toY = (db: number) => gainLane.top + 16 + ((hi - db) / (hi - lo)) * (gainLane.height - 20);
    const step = hi - lo > 12 ? 6 : 3;
    // In a small window the lines crowd together; their labels then give way.
    let labelled = Infinity;
    for (let db = Math.ceil(lo / step) * step; db <= hi; db += step) {
      const roomy = labelled - toY(db) >= 11;
      gridLine(toY(db), roomy ? `${db > 0 ? '+' : ''}${db}` : '');
      if (roomy) labelled = toY(db);
    }
    // Manual adjustments as bands behind the curve.
    detail.adjustments.forEach((adjustment, index) => {
      const x0 = GUTTER + Math.max(0, ((adjustment.start - view.start) / n) * plot);
      const x1 = GUTTER + Math.min(plot, ((adjustment.end - view.start) / n) * plot);
      if (x1 <= x0) return;
      const active = index === activeAdjustment;
      // Bass adjustments are tinted like the bass curve they move.
      const tint = adjustment.bass ? '106, 169, 255' : '255, 255, 255';
      ctx.fillStyle = `rgba(${tint}, ${active ? 0.16 : 0.08})`;
      ctx.fillRect(x0, gainLane.top, x1 - x0, gainLane.height);
      ctx.fillStyle = adjustment.bass ? COLOR.bass : active ? COLOR.hover : COLOR.text;
      ctx.globalAlpha = active || !adjustment.bass ? 1 : 0.7;
      ctx.fillRect(Math.round(x0), gainLane.top, 1, gainLane.height);
      ctx.fillRect(Math.round(x1) - 1, gainLane.top, 1, gainLane.height);
      const label = `${adjustment.bass ? 'bass ' : ''}${adjustment.db >= 0 ? '+' : ''}${adjustment.db.toFixed(1)} dB`;
      if (x1 - x0 > ctx.measureText(label).width + 8) {
        ctx.textAlign = 'center';
        ctx.fillText(label, (x0 + x1) / 2, gainLane.top + gainLane.height - 9);
      }
      ctx.globalAlpha = 1;
    });
    const cols = across(detail.gainDb, 'mean');
    const zero = toY(0);
    ctx.fillStyle = 'rgba(242, 168, 59, 0.22)';
    for (let x = 0; x < plot; x++) {
      const y = toY(cols[x]);
      ctx.fillRect(GUTTER + x, Math.min(y, zero), 1, Math.abs(y - zero));
    }
    line(detail.gainDb, toY, COLOR.gain, 1.5);
    if (detail.bassDb) line(detail.bassDb, toY, COLOR.bass, 1.5);
    laneLabel(ctx, GUTTER + 8, gainLane.top + 10, [
      ['Gain (dB)', COLOR.label], ['whole mix', COLOR.gain], ...(detail.bassDb ? [['bass only', COLOR.bass] as [string, string]] : []),
    ], pointer);
  }

  const startSeconds = (detail.startBlock + view.start) * HOP_SECONDS;
  timeAxis(ctx, startSeconds, startSeconds + n * HOP_SECONDS, GUTTER, width, height - AXIS / 2);

  if (playhead !== null && playhead >= view.start && playhead <= view.end) {
    ctx.fillStyle = COLOR.hover;
    ctx.fillRect(Math.round(GUTTER + ((playhead - view.start) / n) * plot), 0, 1.5, usable);
  }
  if (hoverX !== null && hoverX >= GUTTER) {
    ctx.fillStyle = COLOR.hover;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.round(hoverX), 0, 1, usable);
    ctx.globalAlpha = 1;
  }
}
