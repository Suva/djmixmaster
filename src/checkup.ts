// Turns what was measured about a recording into findings a person can read:
// the faults booth recorders and PA feeds tend to leave behind. Only things
// that hold across the recording, or are plainly faults, are reported; dance
// music does unusual things on purpose. Free of Node imports.

import { SPECTRUM_SIZE, type Diagnostics } from './diagnostics.ts';
import type { BlockRange } from './gaps.ts';
import { energyToLufs, HOP_SECONDS } from './loudness.ts';

/** What ffmpeg says about the file the audio came from. */
export interface SourceInfo {
  /** ffmpeg's name for the codec, such as "mp3" or "pcm_s24le". */
  codec: string;
  /** Channel layout as ffmpeg names it, such as "stereo" or "mono". */
  channels: string;
  bitrateKbps: number | null;
  /** File name extension without the dot, lower case. */
  extension: string;
}

export interface Finding {
  id: 'clipping' | 'quieter-channel' | 'dead-channel' | 'out-of-phase' | 'mono' | 'dropouts' | 'quiet' | 'lossy';
  /** A fault harms the sound; a note is only worth knowing. */
  kind: 'fault' | 'note';
  title: string;
  detail: string;
  /** Where it happens, for marking on the timeline. */
  marks?: BlockRange[];
}

export interface Checkup {
  findings: Finding[];
  /** Plain facts about the file, as label and value. */
  facts: [string, string][];
}

/** The measurements the check-up reads. */
export interface Examined {
  sampleRate: number;
  blocks: Float64Array;
  peaks: Float32Array;
  shortTerm: Float32Array;
  integratedLufs: number;
  peak: number;
  diagnostics: Diagnostics;
  source: SourceInfo;
}

const clock = (block: number) => {
  const s = Math.round(block * HOP_SECONDS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};
const decibels = (ratio: number) => 10 * Math.log10(ratio);

function clipping(music: Uint8Array, musicBlocks: number, clipped: Uint8Array): Finding | null {
  let count = 0;
  const ranges: (BlockRange & { count: number })[] = [];
  const MERGE = Math.round(20 / HOP_SECONDS);
  for (let i = 0; i < clipped.length; i++) {
    if (!music[i] || clipped[i] < 3) continue;
    count++;
    const last = ranges[ranges.length - 1];
    if (last && i - last.end < MERGE) {
      last.end = i + 1;
      last.count++;
    } else ranges.push({ start: i, end: i + 1, count: 1 });
  }
  const share = count / musicBlocks;
  if (share < 0.0005) return null;
  const marks = ranges.map(({ start, end }) => ({ start, end }));
  if (share < 0.005) {
    return {
      id: 'clipping',
      kind: 'note',
      title: 'A few moments are clipped',
      detail: 'The level went past full scale here and there. It is unlikely to be heard. The places are marked in red on the overview.',
      marks,
    };
  }
  const largest = ranges.reduce((a, b) => (b.count > a.count ? b : a));
  const where = largest.count > count * 0.6 ? `, mostly between ${clock(largest.start)} and ${clock(largest.end)}` : ', spread across the recording';
  const percent = share >= 0.1 ? Math.round(share * 100) : (share * 100).toFixed(1);
  return {
    id: 'clipping',
    kind: 'fault',
    title: `About ${percent}% of the music is clipped`,
    detail:
      `It was recorded too hot${where}. Those parts are turned down to match the rest, ` +
      'but the distortion cannot be removed. They are marked in red on the overview.',
    marks,
  };
}

function channels(music: Uint8Array, d: Diagnostics): Finding[] {
  let sumLeft = 0;
  let sumRight = 0;
  let sumCross = 0;
  const differences: number[] = [];
  for (let i = 0; i < d.left.length; i++) {
    if (!music[i]) continue;
    sumLeft += d.left[i];
    sumRight += d.right[i];
    sumCross += d.cross[i];
    if (d.left[i] > 0 && d.right[i] > 0) differences.push(decibels(d.left[i] / d.right[i]));
  }
  if (sumLeft + sumRight === 0) return [];

  // One side carrying a millionth of the other's energy is not carrying music.
  for (const [quiet, loud, name] of [[sumLeft, sumRight, 'left'], [sumRight, sumLeft, 'right']] as const) {
    if (quiet < loud * 1e-6) {
      return [{
        id: 'dead-channel',
        kind: 'fault',
        title: `The ${name} channel is silent`,
        detail: 'Only one side was recorded: a cable, a connector or a recorder input. The other side is all there is to work with.',
      }];
    }
  }

  const difference = sumLeft + sumRight - 2 * sumCross;
  if (difference < (sumLeft + sumRight) * 1e-6) {
    return [{
      id: 'mono',
      kind: 'note',
      title: 'This is a mono recording',
      detail: 'Left and right are identical. Nothing is wrong with that; it will simply have no stereo width.',
    }];
  }

  const findings: Finding[] = [];
  const correlation = sumCross / Math.sqrt(sumLeft * sumRight);
  if (correlation < -0.3) {
    findings.push({
      id: 'out-of-phase',
      kind: 'fault',
      title: 'One channel is out of phase with the other',
      detail:
        'Left and right largely cancel when added together, so on a mono system, which many club rigs are, ' +
        'the bass and anything in the centre all but disappear. One side was probably wired or switched the wrong way round.',
    });
  }

  differences.sort((a, b) => a - b);
  const at = (p: number) => differences[Math.floor((differences.length - 1) * p)];
  if (differences.length > 100) {
    const median = at(0.5);
    // The same offset throughout is a fault in the chain; music that leans to one side comes and goes.
    if (Math.abs(median) >= 1.5 && at(0.75) - at(0.25) <= 4) {
      const quieter = median < 0 ? 'left' : 'right';
      findings.push({
        id: 'quieter-channel',
        kind: 'fault',
        title: `The ${quieter} channel is ${Math.abs(median).toFixed(1)} dB quieter throughout`,
        detail: 'A steady difference like this comes from a cable, a balance control or a recorder setting, not from the music.',
      });
    }
  }
  return findings;
}

/** A recorder losing samples leaves a gap of a few hundredths of a second at most. */
const MAX_DROPOUT_SECONDS = 0.05;
/** Another silence this close means a pause or a stutter in the music, not a dropout. */
const DROPOUT_ALONE_BLOCKS = Math.round(2 / HOP_SECONDS);

function dropouts(e: Examined, gate: number): Finding | null {
  const { blocks, diagnostics } = e;
  const AROUND = Math.round(1 / HOP_SECONDS);
  const loud = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < Math.min(blocks.length, to); i++) {
      if (energyToLufs(blocks[i]) > gate) return true;
    }
    return false;
  };
  // Dance music is full of deliberate silences: the pause before a drop, a
  // gated stutter. Those are longer, and tend to come several at a time. Only
  // a very short silence, on its own, with music right up to it on both
  // sides, is taken for a possible dropout.
  const all = diagnostics.silences;
  const found = all.filter((s, index) => {
    if (s.seconds > MAX_DROPOUT_SECONDS) return false;
    const neighbours = [all[index - 1], all[index + 1]];
    if (neighbours.some((other) => other && Math.abs(other.at - s.at) < DROPOUT_ALONE_BLOCKS)) return false;
    const start = Math.floor(s.at);
    const end = Math.ceil(s.at + s.seconds / HOP_SECONDS);
    return loud(start - AROUND, start) && loud(end + 1, end + 1 + AROUND);
  });
  if (found.length === 0) return null;
  const times = found.slice(0, 5).map((s) => clock(s.at)).join(', ');
  const more = found.length > 5 ? ` and ${found.length - 5} more` : '';
  return {
    id: 'dropouts',
    kind: 'note',
    title: found.length === 1 ? 'One very short gap inside the music' : `${found.length} very short gaps inside the music`,
    detail:
      `At ${times}${more}, each a few hundredths of a second of complete silence. A recorder losing samples leaves gaps like these, ` +
      'though a hard cut in a track can look the same. Listen to one before worrying. They are marked in white on the overview.',
    marks: found.map((s) => ({ start: Math.floor(s.at), end: Math.max(Math.floor(s.at) + 1, Math.ceil(s.at + s.seconds / HOP_SECONDS)) })),
  };
}

const LOSSLESS = /^(pcm_|flac|alac|wavpack|ape|tta|truehd|mlp)/;

/** Looks for the sharp upper edge a lossy encoder leaves in the spectrum. */
function lossy(e: Examined): Finding | null {
  const { spectrum } = e.diagnostics;
  const binHz = e.sampleRate / SPECTRUM_SIZE;
  const nyquist = e.sampleRate / 2;
  if (nyquist < 20000) return null;
  const level = (from: number, to: number) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.round(from / binHz); k < Math.round(to / binHz) && k < spectrum.length; k++, n++) sum += spectrum[k];
    return n > 0 && sum > 0 ? decibels(sum / n) : -Infinity;
  };
  const reference = level(6000, 10000);
  if (!Number.isFinite(reference)) return null;
  // The lowest frequency from which everything up to the top is far below the upper mids.
  let edge: number | null = null;
  for (let hz = nyquist - 1500; hz >= 12000; hz -= 500) {
    if (level(hz, hz + 500) > reference - 40) break;
    edge = hz;
  }
  if (edge === null || edge > 19000) return null;
  // A high-bitrate MP3 that is plainly an MP3 needs no remark; a low edge always does.
  const lossless = LOSSLESS.test(e.source.codec);
  if (!lossless && edge > 17000) return null;
  const kHz = (edge / 1000).toFixed(edge % 1000 === 0 ? 0 : 1);
  return {
    id: 'lossy',
    kind: 'note',
    title: `There is nothing above ${kHz} kHz`,
    detail: lossless
      ? 'A sharp edge like this is left by MP3 or similar encoding. This file is lossless, but the audio in it was not at some point: a track, a stream or the recording itself.'
      : 'That is the mark of a low bitrate. The highs that were removed cannot be brought back.',
  };
}

function describeSource(e: Examined): string {
  const { codec, bitrateKbps, extension } = e.source;
  const bits = /^pcm_[a-z]?(\d+)/.exec(codec)?.[1];
  const name = bits ? `${extension.toUpperCase() || 'PCM'}, ${bits}-bit` : codec.replace(/^mp3.*/, 'MP3').replace(/^aac.*/, 'AAC').replace(/^flac$/, 'FLAC').replace(/^vorbis$/, 'Ogg Vorbis').replace(/^opus$/, 'Opus').replace(/^alac$/, 'Apple Lossless');
  return !bits && !LOSSLESS.test(codec) && bitrateKbps ? `${name}, ${bitrateKbps} kbps` : name;
}

/** Examines a recording and reports what is worth knowing about it. */
export function checkup(e: Examined): Checkup {
  const n = e.shortTerm.length;
  const loud = n > 0 ? Float32Array.from(e.shortTerm).sort()[Math.floor(n * 0.9)] : -Infinity;
  const gate = loud - 30;
  const music = new Uint8Array(n);
  let musicBlocks = 0;
  for (let i = 0; i < n; i++) {
    if (e.shortTerm[i] > gate) {
      music[i] = 1;
      musicBlocks++;
    }
  }

  const findings: Finding[] = [];
  if (musicBlocks > 0) {
    const clipped = clipping(music, musicBlocks, e.diagnostics.clipped);
    if (clipped) findings.push(clipped);
    findings.push(...channels(music, e.diagnostics));
    const silent = dropouts(e, gate);
    if (silent) findings.push(silent);
    const peakDb = 2 * decibels(e.peak);
    if (peakDb < -12) {
      findings.push({
        id: 'quiet',
        kind: 'note',
        title: 'It was recorded quietly',
        detail: `The loudest moment reaches ${peakDb.toFixed(1)} dBFS. The levelling raises it, which raises the recording's own noise by as much.`,
      });
    }
    const edge = lossy(e);
    if (edge) findings.push(edge);
  }
  // Faults first, in the order found.
  findings.sort((a, b) => Number(b.kind === 'fault') - Number(a.kind === 'fault'));

  const mono = e.source.channels.startsWith('mono');
  return {
    findings,
    facts: [
      ['Format', describeSource(e)],
      ['Sample rate', `${e.sampleRate / 1000} kHz${mono ? ', mono' : ''}`],
      ['Length', clock(n)],
      ['Loudness', `${e.integratedLufs.toFixed(1)} LUFS`],
      ['Peak level', `${(2 * decibels(Math.max(e.peak, 1e-9))).toFixed(1)} dBFS`],
    ],
  };
}
