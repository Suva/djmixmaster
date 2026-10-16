// "Moves with…": a setting that follows the music, chosen like a modulation
// knob on a synthesiser instead of written as an expression. The choice is
// turned into an ordinary expression, so expressions stay the one way a
// template says how anything moves, and an expression written this way can be
// read back into the choice to be changed again.

export type MotionSource = 'bass' | 'lowMids' | 'mids' | 'highs' | 'level' | 'energy' | 'beat' | 'wave' | 'wander';
export type MotionSpeed = 'snappy' | 'smooth' | 'slow';

export interface Motion {
  /** The value with nothing moving it. */
  base: number;
  /** How far it moves at most: added at the loudest, the top of a wave. Below zero, it moves down. */
  amount: number;
  source: MotionSource;
  /** How fast a value from the music rises and falls. */
  speed: MotionSpeed;
  /** For a wave or a wander: seconds for one swing. */
  period: number;
}

export const MOTION_SOURCES: [MotionSource, string][] = [
  ['bass', 'Bass'], ['lowMids', 'Low mids'], ['mids', 'Mids'], ['highs', 'Highs'], ['level', 'Level'],
  ['energy', 'Energy (slow, over seconds)'], ['beat', 'Beat (a kick on each)'], ['wave', 'A slow wave'], ['wander', 'Wandering'],
];
export const MOTION_SPEEDS: [MotionSpeed, string][] = [['snappy', 'Snappy'], ['smooth', 'Smooth'], ['slow', 'Slow']];

/** Seconds to rise and to fall, for each speed: of a band or the level, and of the beat, which only falls. */
const RISE_FALL: Record<MotionSpeed, [number, number]> = { snappy: [0.02, 0.2], smooth: [0.05, 0.5], slow: [0.5, 2] };
const BEAT_FALL: Record<MotionSpeed, number> = { snappy: 0.15, smooth: 0.3, slow: 0.8 };

/** Whether a source moves by itself rather than with the music. */
export const timed = (source: MotionSource) => source === 'wave' || source === 'wander';

/** A number written short: no more digits than matter. */
const short = (value: number) => String(Math.round(value * 1000) / 1000);

export function motionExpression(motion: Motion): string {
  const { base, amount, source, speed, period } = motion;
  let mover: string;
  if (source === 'wave') mover = `sine(time / ${short(period)})`;
  else if (source === 'wander') mover = `noise(time / ${short(period)})`;
  else if (source === 'beat') mover = `smooth(beat, 0, ${short(BEAT_FALL[speed])})`;
  else mover = `smooth(${source}, ${short(RISE_FALL[speed][0])}, ${short(RISE_FALL[speed][1])})`;
  return `${short(base)} ${amount < 0 ? '-' : '+'} ${short(Math.abs(amount))} * ${mover}`;
}

const NUMBER = '(-?\\d+(?:\\.\\d+)?)';
const WRITTEN = new RegExp(`^\\s*${NUMBER}\\s*([+-])\\s*${NUMBER}\\s*\\*\\s*(\\w+)\\((.*)\\)\\s*$`);

/** The choice an expression was written from, or null if it was not written this way. */
export function parseMotion(text: string): Motion | null {
  const match = WRITTEN.exec(text);
  if (!match) return null;
  const [, base, sign, size, fn, args] = match;
  const amount = Number(size) * (sign === '-' ? -1 : 1);
  const motion = { base: Number(base), amount, speed: 'smooth' as MotionSpeed, period: 8 };
  const timedMatch = /^time\s*\/\s*(\d+(?:\.\d+)?)$/.exec(args.trim());
  if ((fn === 'sine' || fn === 'noise') && timedMatch) {
    return { ...motion, source: fn === 'sine' ? 'wave' : 'wander', period: Number(timedMatch[1]) };
  }
  if (fn !== 'smooth') return null;
  const parts = args.split(',').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const [source, rise, fall] = [parts[0], Number(parts[1]), Number(parts[2])];
  if (source === 'beat') {
    const speed = MOTION_SPEEDS.find(([s]) => BEAT_FALL[s] === fall)?.[0];
    return rise === 0 && speed ? { ...motion, source: 'beat', speed } : null;
  }
  const speed = MOTION_SPEEDS.find(([s]) => RISE_FALL[s][0] === rise && RISE_FALL[s][1] === fall)?.[0];
  const known = MOTION_SOURCES.some(([s]) => s === source && !timed(s) && s !== 'beat');
  return speed && known ? { ...motion, source: source as MotionSource, speed } : null;
}
