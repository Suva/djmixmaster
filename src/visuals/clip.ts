// Where in a video clip a frame of a mix is: worked out the same way for the
// Video view, which plays the clip in a video element, and for the export,
// which decodes it frame by frame. Both ask this module, so the two cannot
// disagree about which frame of the clip goes with which moment of the mix.
//
// Kept free of Node imports: the window and the export page use it.

/** How a clip plays when it has reached its end. */
export const PLAYBACKS = ['loop', 'ping-pong', 'once, then hold', 'once, then hide'] as const;
export type Playback = (typeof PLAYBACKS)[number];

/** When a clip starts again from its beginning, besides when its layer appears. */
export const RESTARTS = ['never', 'each track', 'each beat', 'every 2 beats', 'every 4 beats', 'every 8 beats', 'every 16 beats'] as const;
export type Restart = (typeof RESTARTS)[number];

/** How many beats apart a restart rule starts the clip again; 0 for one that does not go by beats. */
export const beatsOf = (restart: string) => (restart === 'each beat' ? 1 : Number(/^every (\d+) beats$/.exec(restart)?.[1] ?? 0));

/**
 * The longest part of a clip that plays ping-pong; a longer one is played
 * back and forth by jumping, which is slow. Its reversed copy takes a while
 * to make, and room on disk.
 */
export const PING_PONG_MOST_SECONDS = 60;

/** A clip shorter than this is taken as a still: there is nothing to play. */
const SHORTEST = 0.001;

/** What decides where in its clip a video layer is. */
export interface ClipTiming {
  /** Seconds into the mix. */
  seconds: number;
  /** Seconds into the mix when the clip last started from its beginning: when the layer appeared, or the last restart. */
  started: number;
  playback: Playback;
  /** 1 is the clip's own speed. */
  speed: number;
  /** The part of the clip used, in its own seconds; `outPoint` 0 means to its end. */
  inPoint: number;
  outPoint: number;
  /** Seconds into the used part at which it starts. */
  offset: number;
}

/** The part of a clip that is used, in its own seconds: `[from, to)`, within the clip. */
export function usedPart(timing: Pick<ClipTiming, 'inPoint' | 'outPoint'>, duration: number): [number, number] {
  const from = Math.max(0, Math.min(duration, timing.inPoint));
  const to = timing.outPoint > 0 ? Math.max(from, Math.min(duration, timing.outPoint)) : duration;
  return [from, to];
}

/**
 * Where a frame of the mix is in the clip, as a time in the clip's own
 * seconds, or null when the clip shows nothing then (played once, and over).
 *
 * Ping-pong plays the used part forwards and then backwards. Played from a
 * clip, backwards means jumping back a frame each frame, which no decoder
 * does quickly; so where a copy of the part followed by itself reversed has
 * been made (see `pingPongTime`), that copy is played forwards instead.
 */
export function clipTime(timing: ClipTiming, duration: number, frameSeconds = 1 / 30): number | null {
  const [from, to] = usedPart(timing, duration);
  const length = to - from;
  if (length < SHORTEST) return from;
  const into = Math.max(0, (timing.seconds - timing.started) * Math.max(0, timing.speed)) + Math.max(0, timing.offset);
  switch (timing.playback) {
    case 'once, then hold':
      // The last frame, rather than the very end, where there is no frame.
      return from + Math.min(into, Math.max(0, length - frameSeconds));
    case 'once, then hide':
      return into < length ? from + into : null;
    case 'ping-pong': {
      const round = into % (2 * length);
      return from + (round < length ? round : 2 * length - round);
    }
    default:
      return from + (into % length);
  }
}

/**
 * Where a frame of the mix is in a ping-pong copy of the used part: the part
 * followed by itself reversed, which plays forwards from 0 to twice its
 * length. Null when the clip shows nothing.
 */
export function pingPongTime(timing: ClipTiming, duration: number): number | null {
  const [from, to] = usedPart(timing, duration);
  const length = to - from;
  if (length < SHORTEST) return 0;
  const into = Math.max(0, (timing.seconds - timing.started) * Math.max(0, timing.speed)) + Math.max(0, timing.offset);
  return into % (2 * length);
}
