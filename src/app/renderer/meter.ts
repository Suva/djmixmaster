// The level meter beside the curves: two columns of lights for what reaches
// the left and right speaker, a thinner one that lights from the top as the
// limiter works, and a lamp for when the recording itself is clipped. Under
// them, in figures, what the levelling is doing at the playhead.

/** The scale runs from a little above full scale down to here, in dBFS. */
const TOP_DB = 3;
const KNEE_DB = -12;
const BOTTOM_DB = -42;
/** The top of the scale gets most of the height: a mix lives in its last twelve decibels. */
const KNEE_AT = 0.62;
/** The limiter column shows this much reduction, in dB, top to bottom. */
const REDUCTION_RANGE_DB = 12;

const FALL_DB_PER_SECOND = 28;
const PEAK_HOLD_MS = 1300;
const LAMP_HOLD_MS = 700;

const SEGMENT = 3;
const GAP = 1;
const COLOR = {
  off: '#1e222a',
  low: '#3ddc97',
  near: '#f2a83b',
  over: '#ff5d5d',
  text: '#8b93a1',
  bright: '#e6e8ec',
};
/** Rows kept free under the lights for the figures, so the lights never change height. */
const FIGURE_ROWS = 3;
const FIGURE_ROW_HEIGHT = 13;
const FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export interface MeterReading {
  /** Peak of the left and of the right output in the last moment, linear. */
  left: number;
  right: number;
  /** How much the limiter is taking off, in dB (0 when idle). */
  reductionDb: number;
  /** Whether the recording itself is clipped at this moment. */
  sourceClipped: boolean;
  /** The ceiling in use, in dBFS, which is where the lights turn red. */
  ceilingDb: number;
}

/** One line under the lights: what it is, its value as it should read, and the colour of the value. */
export type MeterFigure = [label: string, value: string, colour: string];

const toDb = (linear: number) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);

/** How far down the scale a level sits, from 0 at the top to 1 at the bottom. */
function position(db: number): number {
  if (db >= KNEE_DB) return ((TOP_DB - Math.min(TOP_DB, db)) / (TOP_DB - KNEE_DB)) * KNEE_AT;
  return KNEE_AT + ((KNEE_DB - Math.max(BOTTOM_DB, db)) / (KNEE_DB - BOTTOM_DB)) * (1 - KNEE_AT);
}

export class LevelMeter {
  readonly #canvas: HTMLCanvasElement;
  #level = [-Infinity, -Infinity];
  #held = [-Infinity, -Infinity];
  #heldAt = [0, 0];
  #reduction = 0;
  #heldReduction = 0;
  #heldReductionAt = 0;
  #clippedAt = -Infinity;
  #ceilingDb = -1;
  #last = 0;
  #settling = false;
  #figures: MeterFigure[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    new ResizeObserver(() => this.#draw(performance.now())).observe(canvas);
  }

  /** Takes a reading; call once a frame while playing. */
  update(reading: MeterReading) {
    const now = performance.now();
    this.#fall(now);
    this.#ceilingDb = reading.ceilingDb;
    [reading.left, reading.right].forEach((linear, channel) => {
      const db = toDb(linear);
      if (db > this.#level[channel]) this.#level[channel] = db;
      if (db >= this.#held[channel]) {
        this.#held[channel] = db;
        this.#heldAt[channel] = now;
      }
    });
    if (reading.reductionDb > this.#reduction) this.#reduction = reading.reductionDb;
    if (reading.reductionDb >= this.#heldReduction) {
      this.#heldReduction = reading.reductionDb;
      this.#heldReductionAt = now;
    }
    if (reading.sourceClipped) this.#clippedAt = now;
    this.#draw(now);
  }

  /** The figures under the lights. They hold still when playback does, unlike the lights. */
  setFigures(figures: MeterFigure[]) {
    if (JSON.stringify(figures) === JSON.stringify(this.#figures)) return;
    this.#figures = figures;
    this.#draw(performance.now());
  }

  /** Lets the lights fall back by themselves once playback has stopped. */
  release() {
    if (this.#settling) return;
    this.#settling = true;
    const step = () => {
      const now = performance.now();
      this.#fall(now);
      this.#draw(now);
      const lit = this.#level.some((db) => db > BOTTOM_DB) || this.#held.some((db) => db > BOTTOM_DB) ||
        this.#reduction > 0.05 || this.#heldReduction > 0.05 || now - this.#clippedAt < LAMP_HOLD_MS;
      if (lit) requestAnimationFrame(step);
      else this.#settling = false;
    };
    requestAnimationFrame(step);
  }

  #fall(now: number) {
    const elapsed = Math.min(0.25, (now - this.#last) / 1000);
    this.#last = now;
    for (const channel of [0, 1]) {
      this.#level[channel] -= FALL_DB_PER_SECOND * elapsed;
      if (now - this.#heldAt[channel] > PEAK_HOLD_MS) this.#held[channel] = this.#level[channel];
    }
    this.#reduction = Math.max(0, this.#reduction - (FALL_DB_PER_SECOND / 2) * elapsed);
    if (now - this.#heldReductionAt > PEAK_HOLD_MS) this.#heldReduction = this.#reduction;
  }

  #draw(now: number) {
    const canvas = this.#canvas;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const top = 26;
    const bottom = height - 40 - FIGURE_ROWS * FIGURE_ROW_HEIGHT;
    const ladder = bottom - top;
    const bar = 11;
    const leftX = 24;
    const rightX = leftX + bar + 2;
    const limiterX = rightX + bar + 7;
    const limiterWidth = 6;
    const segments = Math.floor(ladder / (SEGMENT + GAP));
    const yOf = (index: number) => top + index * (SEGMENT + GAP);

    // The lamp for clipping in the recording itself, and what the columns are.
    const clipped = now - this.#clippedAt < LAMP_HOLD_MS;
    ctx.fillStyle = clipped ? COLOR.over : COLOR.off;
    ctx.fillRect(leftX, 6, bar * 2 + 2, 7);
    ctx.fillStyle = clipped ? COLOR.over : COLOR.text;
    ctx.textAlign = 'left';
    ctx.fillText('clip', 1, 10);
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'center';
    ctx.fillText('L', leftX + bar / 2, 19);
    ctx.fillText('R', rightX + bar / 2, 19);

    // The scale.
    ctx.textAlign = 'right';
    for (const db of [0, -3, -6, -12, -24, -36]) {
      ctx.fillStyle = COLOR.text;
      ctx.fillText(String(db), leftX - 5, top + position(db) * ladder);
    }

    const ceilingAt = position(this.#ceilingDb);
    const nearAt = position(this.#ceilingDb - 4);
    for (let channel = 0; channel < 2; channel++) {
      const x = channel === 0 ? leftX : rightX;
      const levelAt = position(this.#level[channel]);
      const heldSegment = this.#held[channel] > BOTTOM_DB ? Math.floor(position(this.#held[channel]) * segments) : -1;
      for (let index = 0; index < segments; index++) {
        // A light comes on once the level reaches its top edge. It is red only
        // if all of it lies above the ceiling, so a peak resting on the ceiling is not.
        const at = index / segments;
        const colour = (index + 1) / segments <= ceilingAt ? COLOR.over : at < nearAt ? COLOR.near : COLOR.low;
        const lit = (this.#level[channel] > BOTTOM_DB && at >= levelAt) || index === heldSegment;
        ctx.fillStyle = lit ? colour : COLOR.off;
        ctx.fillRect(x, yOf(index), bar, SEGMENT);
      }
    }

    // The limiter: lights from the top down, the further the harder it works.
    const reductionSegments = Math.round((Math.min(REDUCTION_RANGE_DB, this.#reduction) / REDUCTION_RANGE_DB) * segments);
    const heldReduction = Math.round((Math.min(REDUCTION_RANGE_DB, this.#heldReduction) / REDUCTION_RANGE_DB) * segments);
    for (let index = 0; index < segments; index++) {
      const lit = index < reductionSegments || (heldReduction > 0 && index === heldReduction - 1);
      ctx.fillStyle = lit ? COLOR.near : COLOR.off;
      ctx.fillRect(limiterX, yOf(index), limiterWidth, SEGMENT);
    }
    ctx.fillStyle = COLOR.text;
    ctx.textAlign = 'center';
    ctx.fillText('lim', limiterX + limiterWidth / 2 + 1, 19);

    // The numbers: the peak being held, and how much the limiter has taken off.
    const peak = Math.max(...this.#held);
    ctx.textAlign = 'left';
    ctx.fillStyle = peak > this.#ceilingDb + 0.05 ? COLOR.over : COLOR.bright;
    ctx.fillText(peak > BOTTOM_DB ? `${peak.toFixed(1)}` : '–', leftX, bottom + 12);
    ctx.fillStyle = COLOR.text;
    ctx.fillText('peak', leftX, bottom + 25);
    ctx.textAlign = 'right';
    ctx.fillStyle = this.#heldReduction > 0.05 ? COLOR.near : COLOR.text;
    ctx.fillText(this.#heldReduction > 0.05 ? `-${this.#heldReduction.toFixed(1)}` : '', width - 1, bottom + 12);
    ctx.fillText(this.#heldReduction > 0.05 ? 'limit' : '', width - 1, bottom + 25);

    this.#figures.slice(0, FIGURE_ROWS).forEach(([label, value, colour], row) => {
      const y = bottom + 43 + row * FIGURE_ROW_HEIGHT;
      ctx.textAlign = 'left';
      ctx.fillStyle = COLOR.text;
      ctx.fillText(label, 1, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = colour;
      ctx.fillText(value, width - 1, y);
    });

    // The same numbers where a script can read them; lights are hard to check otherwise.
    canvas.dataset.peak = peak > BOTTOM_DB ? peak.toFixed(1) : '';
    canvas.dataset.left = this.#level[0] > BOTTOM_DB ? this.#level[0].toFixed(1) : '';
    canvas.dataset.right = this.#level[1] > BOTTOM_DB ? this.#level[1].toFixed(1) : '';
    canvas.dataset.reduction = this.#heldReduction.toFixed(1);
    canvas.dataset.clip = String(clipped);
    canvas.dataset.figures = this.#figures.map(([label, value]) => `${label} ${value}`).join(', ');
  }
}
