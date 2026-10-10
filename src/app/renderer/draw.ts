// Canvas drawing for the recording overview and the three-lane detail view.

import { HOP_SECONDS } from '../../loudness.ts';

const COLOR = {
  grid: '#262a33',
  text: '#8b93a1',
  label: '#c9ced8',
  before: '#6b7280',
  after: '#3ddc97',
  gain: '#f2a83b',
  bass: '#6aa9ff',
  warn: '#ff5d5d',
  hover: '#e6e8ec',
};
const FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/** Left margin of the detail view that holds the axis labels. */
export const GUTTER = 48;
const AXIS = 18;
const LOUDNESS_SPAN_DB = 24;

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

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
function columns(values: ArrayLike<number>, width: number, reduce: 'max' | 'mean'): Float32Array {
  const n = values.length;
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const lo = Math.min(n - 1, Math.floor((x * n) / width));
    const hi = Math.max(lo + 1, Math.min(n, Math.floor(((x + 1) * n) / width)));
    let acc = reduce === 'max' ? -Infinity : 0;
    for (let i = lo; i < hi; i++) acc = reduce === 'max' ? Math.max(acc, values[i]) : acc + values[i];
    out[x] = reduce === 'max' ? acc : acc / (hi - lo);
  }
  return out;
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function timeAxis(ctx: CanvasRenderingContext2D, startSeconds: number, endSeconds: number, x0: number, x1: number, y: number) {
  const span = endSeconds - startSeconds;
  const step = TICK_STEPS.find((s) => (span / s) * 70 <= x1 - x0) ?? TICK_STEPS[TICK_STEPS.length - 1];
  ctx.fillStyle = COLOR.text;
  ctx.textAlign = 'center';
  for (let t = Math.ceil(startSeconds / step) * step; t <= endSeconds; t += step) {
    const x = x0 + ((t - startSeconds) / span) * (x1 - x0);
    if (x < x0 + 24 || x > x1 - 24) continue;
    ctx.fillText(clock(t), x, y);
  }
}

export interface Region {
  /** First block of the mix and the block just past its end. */
  start: number;
  end: number;
}

/** `playhead` is a block position in the recording, or null to hide it. */
export function drawOverview(canvas: HTMLCanvasElement, peaks: Float32Array, region: Region, playhead: number | null) {
  const { ctx, width, height } = fit(canvas);
  const waveHeight = height - AXIS;
  const mid = waveHeight / 2;
  const cols = columns(peaks, width, 'max');
  const x0 = (region.start / peaks.length) * width;
  const x1 = (region.end / peaks.length) * width;

  ctx.fillStyle = 'rgba(61, 220, 151, 0.10)';
  ctx.fillRect(x0, 0, x1 - x0, waveHeight);
  for (let x = 0; x < width; x++) {
    const half = Math.max(0.5, cols[x] * (mid - 2));
    ctx.fillStyle = x >= x0 && x < x1 ? COLOR.after : COLOR.before;
    ctx.fillRect(x, mid - half, 1, half * 2);
  }
  ctx.fillStyle = COLOR.after;
  ctx.fillRect(Math.round(x0) - 1, 0, 2, waveHeight);
  ctx.fillRect(Math.round(x1) - 1, 0, 2, waveHeight);
  if (playhead !== null) {
    ctx.fillStyle = COLOR.hover;
    ctx.fillRect(Math.round((playhead / peaks.length) * width), 0, 1, waveHeight);
  }

  timeAxis(ctx, 0, peaks.length * HOP_SECONDS, 0, width, height - AXIS / 2);
}

/** Everything the detail view shows, one value per block of the region. */
export interface Detail {
  /** Block index of the region's start within the recording, for the time axis. */
  startBlock: number;
  peaksIn: Float32Array;
  peaksOut: Float32Array;
  loudnessIn: Float32Array;
  loudnessOut: Float32Array;
  gainDb: Float32Array;
  /** Bass shelf gain, or null when bass correction is off. */
  bassDb: Float32Array | null;
  targetLufs: number;
  /** Limiter ceiling as a linear sample value. */
  ceiling: number;
}

function laneLabel(ctx: CanvasRenderingContext2D, x: number, y: number, parts: [string, string][]) {
  ctx.textAlign = 'left';
  for (const [text, color] of parts) {
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    x += ctx.measureText(text).width + 12;
  }
}

/** `playhead` is a block position within the region, or null to hide it. */
export function drawDetail(canvas: HTMLCanvasElement, detail: Detail, hoverX: number | null, playhead: number | null) {
  const { ctx, width, height } = fit(canvas);
  const plot = width - GUTTER;
  const n = detail.gainDb.length;
  if (plot < 10 || n === 0) return;

  const usable = height - AXIS;
  const gap = 10;
  const waveLane = { top: 0, height: Math.round(usable * 0.38) };
  const loudLane = { top: waveLane.height + gap, height: Math.round(usable * 0.38) - gap };
  const gainLane = { top: loudLane.top + loudLane.height + gap, height: usable - (loudLane.top + loudLane.height + gap) };

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
    ctx.beginPath();
    for (let x = 0; x < values.length; x++) {
      const y = toY(values[x]);
      if (x === 0) ctx.moveTo(GUTTER + x + 0.5, y);
      else ctx.lineTo(GUTTER + x + 0.5, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };

  // Lane 1: waveform, original behind the levelled result.
  {
    const mid = waveLane.top + waveLane.height / 2;
    const scale = waveLane.height / 2 - 4;
    const before = columns(detail.peaksIn, plot, 'max');
    const after = columns(detail.peaksOut, plot, 'max');
    for (let x = 0; x < plot; x++) {
      const b = Math.min(1, before[x]) * scale;
      ctx.fillStyle = COLOR.before;
      ctx.fillRect(GUTTER + x, mid - b, 1, b * 2);
      const a = Math.min(1, Math.min(after[x], detail.ceiling)) * scale;
      ctx.fillStyle = COLOR.after;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(GUTTER + x, mid - a, 1, a * 2);
      ctx.globalAlpha = 1;
      if (after[x] > detail.ceiling) {
        // Peaks the limiter will have to hold down.
        ctx.fillStyle = COLOR.warn;
        ctx.fillRect(GUTTER + x, mid - a - 3, 1, 3);
        ctx.fillRect(GUTTER + x, mid + a, 1, 3);
      }
    }
    gridLine(mid, '');
    gridLine(mid - scale, '0 dB');
    laneLabel(ctx, GUTTER + 8, waveLane.top + 10, [
      ['Waveform', COLOR.label], ['original', COLOR.before], ['levelled', COLOR.after], ['limited', COLOR.warn],
    ]);
  }

  // Lane 2: short-term loudness before and after.
  separator(waveLane.height);
  {
    let top = detail.targetLufs;
    for (let i = 0; i < n; i++) top = Math.max(top, detail.loudnessIn[i], detail.loudnessOut[i]);
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
    line(columns(detail.loudnessIn, plot, 'mean'), toY, COLOR.before, 1.25);
    line(columns(detail.loudnessOut, plot, 'mean'), toY, COLOR.after, 1.5);
    ctx.restore();
    laneLabel(ctx, GUTTER + 8, loudLane.top + 10, [
      ['Loudness (LUFS)', COLOR.label], ['original', COLOR.before], ['levelled', COLOR.after], ['- - target', COLOR.label],
    ]);
  }

  // Lane 3: the gain being applied.
  separator(loudLane.top + loudLane.height);
  {
    let lo = -3;
    let hi = 3;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, detail.gainDb[i] - 1, (detail.bassDb?.[i] ?? 0) - 1);
      hi = Math.max(hi, detail.gainDb[i] + 1, (detail.bassDb?.[i] ?? 0) + 1);
    }
    const toY = (db: number) => gainLane.top + 16 + ((hi - db) / (hi - lo)) * (gainLane.height - 20);
    const step = hi - lo > 12 ? 6 : 3;
    for (let db = Math.ceil(lo / step) * step; db <= hi; db += step) {
      gridLine(toY(db), `${db > 0 ? '+' : ''}${db}`);
    }
    const cols = columns(detail.gainDb, plot, 'mean');
    const zero = toY(0);
    ctx.fillStyle = 'rgba(242, 168, 59, 0.22)';
    for (let x = 0; x < plot; x++) {
      const y = toY(cols[x]);
      ctx.fillRect(GUTTER + x, Math.min(y, zero), 1, Math.abs(y - zero));
    }
    line(cols, toY, COLOR.gain, 1.5);
    if (detail.bassDb) line(columns(detail.bassDb, plot, 'mean'), toY, COLOR.bass, 1.5);
    laneLabel(ctx, GUTTER + 8, gainLane.top + 10, [
      ['Gain (dB)', COLOR.label], ['whole mix', COLOR.gain], ...(detail.bassDb ? [['bass only', COLOR.bass] as [string, string]] : []),
    ]);
  }

  const startSeconds = detail.startBlock * HOP_SECONDS;
  timeAxis(ctx, startSeconds, startSeconds + n * HOP_SECONDS, GUTTER, width, height - AXIS / 2);

  if (playhead !== null && playhead >= 0 && playhead <= n) {
    ctx.fillStyle = COLOR.hover;
    ctx.fillRect(Math.round(GUTTER + (playhead / n) * plot), 0, 1.5, usable);
  }
  if (hoverX !== null && hoverX >= GUTTER) {
    ctx.fillStyle = COLOR.hover;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.round(hoverX), 0, 1, usable);
    ctx.globalAlpha = 1;
  }
}
