// Fixes for a recording whose channels went wrong on the way in: one quieter
// than the other, one silent, one upside down. Each is a mix of the two
// channels into two again, applied before anything else, in playback and in
// every export alike. Kept free of Node imports: the window works with them too.

/**
 * How each channel that comes out is made of those that went in:
 * left = ll·left + lr·right, right = rl·left + rr·right.
 */
export interface ChannelMix {
  ll: number;
  lr: number;
  rl: number;
  rr: number;
}

export const UNMIXED: ChannelMix = { ll: 1, lr: 0, rl: 0, rr: 1 };

export const isUnmixed = (mix: ChannelMix) => mix.ll === 1 && mix.lr === 0 && mix.rl === 0 && mix.rr === 1;

/** One mix after another, as one. */
export function then(first: ChannelMix, second: ChannelMix): ChannelMix {
  return {
    ll: second.ll * first.ll + second.lr * first.rl,
    lr: second.ll * first.lr + second.lr * first.rr,
    rl: second.rl * first.ll + second.rr * first.rl,
    rr: second.rl * first.lr + second.rr * first.rr,
  };
}

/** Mixes interleaved stereo samples in place. */
export function mixChannels(samples: Float32Array, mix: ChannelMix) {
  if (isUnmixed(mix)) return;
  for (let i = 0; i + 1 < samples.length; i += 2) {
    const left = samples[i];
    const right = samples[i + 1];
    samples[i] = mix.ll * left + mix.lr * right;
    samples[i + 1] = mix.rl * left + mix.rr * right;
  }
}

/** The fix for a silent channel: the other one, on both sides. */
export const fillFrom = (side: 'left' | 'right'): ChannelMix =>
  side === 'left' ? { ll: 1, lr: 0, rl: 1, rr: 0 } : { ll: 0, lr: 1, rl: 0, rr: 1 };

/** The fix for one channel out of phase: the right turned upside down (which of the two is a matter of taste). */
export const FLIP: ChannelMix = { ll: 1, lr: 0, rl: 0, rr: -1 };

/** The fix for one channel quieter throughout: it raised by as much. */
export const raise = (side: 'left' | 'right', db: number): ChannelMix => {
  const gain = 10 ** (db / 20);
  return side === 'left' ? { ll: gain, lr: 0, rl: 0, rr: 1 } : { ll: 1, lr: 0, rl: 0, rr: gain };
};

/**
 * How much louder a recording becomes with a mix, in dB: from the energy of
 * each channel and of their product, summed over the recording. Loudness
 * adds the two channels' energies, so a flip changes nothing, and a silent
 * channel filled from the other doubles it. The faults these fix last the
 * whole recording, so one figure does for all of it.
 */
export function loudnessChangeDb(left: ArrayLike<number>, right: ArrayLike<number>, cross: ArrayLike<number>, mix: ChannelMix): number {
  let [l, r, x] = [0, 0, 0];
  for (let i = 0; i < left.length; i++) {
    l += left[i];
    r += right[i];
    x += cross[i];
  }
  const before = l + r;
  if (before <= 0) return 0;
  const after = (mix.ll ** 2 + mix.rl ** 2) * l + (mix.lr ** 2 + mix.rr ** 2) * r + 2 * (mix.ll * mix.lr + mix.rl * mix.rr) * x;
  return 10 * Math.log10(Math.max(after, 1e-30) / before);
}
