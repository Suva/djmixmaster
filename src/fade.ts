// Fades at the two ends of a mix. Kept free of Node imports: the window draws
// and previews with the same curve the export applies.

/** How far up a fade is at `x`, from 0 at its silent end to 1 where it is over. */
function shape(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // An S-curve: it leaves silence and arrives at full level without a corner,
  // which sounds more even than a straight line.
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * The gain the fades apply at position `at` of something `total` long, with a
 * fade in of `fadeIn` and a fade out of `fadeOut`. All four are in the same
 * unit, whichever the caller works in.
 */
export function fadeGain(at: number, total: number, fadeIn: number, fadeOut: number): number {
  let gain = 1;
  if (fadeIn > 0 && at < fadeIn) gain = shape(at / fadeIn);
  if (fadeOut > 0 && at > total - fadeOut) gain *= shape((total - at) / fadeOut);
  return gain;
}
