// Finds the silences in a recording: the places where one set ended and the
// next had not started yet. A DJ who takes over by mixing out of the previous
// one leaves no gap, so this finds the hard cuts only.

import { energyToLufs, HOP_SECONDS } from './loudness.ts';

/** A stretch of the recording, from block `start` up to but not including block `end`. */
export interface BlockRange {
  start: number;
  end: number;
}

/** How far below the loud parts of the recording counts as silence. */
const SILENCE_BELOW_LOUD_DB = 35;
/** Shorter silences are part of the music: the pause before a drop, the end of a breakdown. */
const MIN_GAP_SECONDS = 3;
/** Sound shorter than this between two silences is noise in the gap, not a set. */
const MIN_SOUND_SECONDS = 30;

/** Silences of a few seconds or more, given the K-weighted energy per 100 ms block. */
export function findGaps(blocks: Float64Array): BlockRange[] {
  const n = blocks.length;
  // Loudness over 400 ms, so that a single quiet block between two beats does not count.
  const level = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - 1);
    const to = Math.min(n, i + 3);
    let sum = 0;
    for (let k = from; k < to; k++) sum += blocks[k];
    level[i] = energyToLufs(sum / (to - from));
  }
  const loud = Float32Array.from(level).sort()[Math.floor(n * 0.9)];
  const threshold = loud - SILENCE_BELOW_LOUD_DB;

  const gaps: BlockRange[] = [];
  const minGap = Math.round(MIN_GAP_SECONDS / HOP_SECONDS);
  const minSound = Math.round(MIN_SOUND_SECONDS / HOP_SECONDS);
  for (let i = 0; i < n; ) {
    if (level[i] >= threshold) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && level[end] < threshold) end++;
    if (end - i >= minGap) {
      const previous = gaps[gaps.length - 1];
      // A blip of sound between two silences belongs to the gap around it.
      if (previous && i - previous.end < minSound) previous.end = end;
      else gaps.push({ start: i, end });
    }
    i = end;
  }
  return gaps;
}

/** The parts of `range` that are not in any gap: the stretches with music in them. */
export function soundBetween(gaps: BlockRange[], range: BlockRange): BlockRange[] {
  const parts: BlockRange[] = [];
  let from = range.start;
  for (const gap of gaps) {
    if (gap.end <= range.start || gap.start >= range.end) continue;
    if (gap.start > from) parts.push({ start: from, end: gap.start });
    from = Math.max(from, gap.end);
  }
  if (from < range.end) parts.push({ start: from, end: range.end });
  return parts;
}
