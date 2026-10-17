#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  DEFAULT_AAC_KBPS, DEFAULT_BIT_DEPTH, DEFAULT_MP3_KBPS, isLossy, LOSSY_HEADROOM_DB, type EncodeOptions, type Region,
} from './audio-io.ts';
import { DEFAULT_LEVEL_OPTIONS, type LevelOptions } from './gain-curve.ts';
import { checkup } from './checkup.ts';
import { HOP_SECONDS } from './loudness.ts';
import { level, measure, render, type Levelling, type Measurement, type Progress } from './master.ts';

const USAGE = `Usage: djmaster <input> [options]

Evens out the loudness between the tracks of a DJ mix without pumping the breakdowns.

Region
  --start <time>       Start of the mix inside the recording (seconds or h:mm:ss)
  --end <time>         End of the mix inside the recording

Output
  -o, --output <file>  Output file; .wav, .flac, .mp3 or .m4a (default: <input>.mastered.wav)
  --bit-depth <16|24>  Bits per sample for .wav and .flac; 16-bit is dithered (default: ${DEFAULT_BIT_DEPTH})
  --bitrate <kbps>     Bitrate for .mp3 and .m4a (default: ${DEFAULT_MP3_KBPS} and ${DEFAULT_AAC_KBPS})
  --sample-rate <Hz>   Sample rate of the output (default: the input's)
  --fade-in <seconds>  Fade in at the start (default: none)
  --fade-out <seconds> Fade out at the end (default: none)
  --headroom <dB>      Extra room under the ceiling for .mp3 and .m4a, whose encoding
                       raises the peaks (default: ${LOSSY_HEADROOM_DB})
  --title, --artist, --album <text>
                       Tags to write into the output
  --force              Overwrite the output file if it exists
  --analyze-only       Measure and print the planned gain without writing audio
  --dump <file.csv>    Write the loudness and gain curves for inspection

Levelling
  --target <LUFS>      Loudness for full-energy sections (default: as loud as fits under the
                       ceiling without limiting); set it higher to push into the limiter
  --no-levelling       Leave the tracks as they are and turn the whole mix up or down by one
                       amount, set by --target or --gain, or else as loud as fits
  --gain <dB>          That amount, set by hand; implies --no-levelling
  --window <seconds>   Quiet passages shorter than about this are breakdowns (default: ${DEFAULT_LEVEL_OPTIONS.windowSeconds})
  --percentile <0-1>   Loudness percentile that counts as full energy (default: ${DEFAULT_LEVEL_OPTIONS.percentile})
  --bass-weight <0-1>  0 matches perceived loudness, 1 matches bass/kick level (default: ${DEFAULT_LEVEL_OPTIONS.bassWeight})
  --bass-correction <0-1>
                       How much of the bass difference between tracks a slow EQ evens out (default: ${DEFAULT_LEVEL_OPTIONS.bassCorrection})
  --max-bass <dB>      Most that EQ raises or lowers a track's bass (default: ${DEFAULT_LEVEL_OPTIONS.maxBassDb})
  --max-boost <dB>     Most a quiet track is raised towards the rest (default: ${DEFAULT_LEVEL_OPTIONS.maxBoostDb})
  --max-cut <dB>       Most a loud track is lowered towards the rest (default: ${DEFAULT_LEVEL_OPTIONS.maxCutDb})
  --smooth <seconds>   How long a gain change takes (default: ${DEFAULT_LEVEL_OPTIONS.smoothSeconds})
  --slew <dB/s>        Fastest the gain may move (default: ${DEFAULT_LEVEL_OPTIONS.slewDbPerSecond})

Limiter
  --ceiling <dBTP>     True-peak ceiling (default: -1)
  --no-limiter         Leave peaks alone; boosted tracks may clip
`;

interface Args {
  input: string;
  output?: string;
  region: Region;
  options: LevelOptions;
  ceilingDb: number | null;
  encode: EncodeOptions;
  headroomDb?: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  analyzeOnly: boolean;
  dump?: string;
  force: boolean;
}

function parseTime(text: string): number {
  const parts = text.split(':').map(Number);
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) {
    throw new Error(`Invalid time "${text}" (use seconds or h:mm:ss)`);
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    input: '',
    region: {},
    options: { ...DEFAULT_LEVEL_OPTIONS },
    ceilingDb: -1,
    encode: {},
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
    analyzeOnly: false,
    force: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline: string | undefined;
    if (flag.startsWith('--') && flag.includes('=')) {
      inline = flag.slice(flag.indexOf('=') + 1);
      flag = flag.slice(0, flag.indexOf('='));
    }
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const number = () => {
      const v = Number(value());
      if (!Number.isFinite(v)) throw new Error(`${flag} needs a number`);
      return v;
    };
    switch (flag) {
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0);
      case '-o': case '--output': args.output = value(); break;
      case '--start': args.region.start = parseTime(value()); break;
      case '--end': args.region.end = parseTime(value()); break;
      case '--force': args.force = true; break;
      case '--bit-depth': {
        const bits = number();
        if (bits !== 16 && bits !== 24) throw new Error('--bit-depth must be 16 or 24');
        args.encode.bitDepth = bits;
        break;
      }
      case '--bitrate': args.encode.bitrateKbps = number(); break;
      case '--sample-rate': args.encode.sampleRate = number(); break;
      case '--headroom': args.headroomDb = number(); break;
      case '--fade-in': args.fadeInSeconds = number(); break;
      case '--fade-out': args.fadeOutSeconds = number(); break;
      case '--title': args.encode.title = value(); break;
      case '--artist': args.encode.artist = value(); break;
      case '--album': args.encode.album = value(); break;
      case '--analyze-only': args.analyzeOnly = true; break;
      case '--dump': args.dump = value(); break;
      case '--target': args.options.targetLufs = number(); break;
      case '--no-levelling': args.options.levelTracks = false; break;
      case '--gain': args.options.fixedGainDb = number(); args.options.levelTracks = false; break;
      case '--window': args.options.windowSeconds = number(); break;
      case '--percentile': args.options.percentile = number(); break;
      case '--bass-weight': args.options.bassWeight = number(); break;
      case '--bass-correction': args.options.bassCorrection = number(); break;
      case '--max-bass': args.options.maxBassDb = number(); break;
      case '--max-boost': args.options.maxBoostDb = number(); break;
      case '--max-cut': args.options.maxCutDb = number(); break;
      case '--smooth': args.options.smoothSeconds = number(); break;
      case '--slew': args.options.slewDbPerSecond = number(); break;
      case '--ceiling': args.ceilingDb = number(); break;
      case '--no-limiter': args.ceilingDb = null; break;
      default:
        if (flag.startsWith('-') && flag.length > 1) throw new Error(`Unknown option ${flag}`);
        positional.push(flag);
    }
  }
  if (positional.length !== 1) throw new Error('Expected exactly one input file');
  args.input = positional[0];

  const { bassWeight, bassCorrection, maxBassDb: maxBass } = args.options;
  if (!(bassCorrection >= 0 && bassCorrection <= 1)) throw new Error('--bass-correction must be between 0 and 1');
  if (!(maxBass >= 0)) throw new Error('--max-bass must not be negative');
  if (!(bassWeight >= 0 && bassWeight <= 1)) throw new Error('--bass-weight must be between 0 and 1');
  const { percentile, windowSeconds, maxBoostDb, maxCutDb, smoothSeconds, slewDbPerSecond } = args.options;
  if (!(percentile > 0 && percentile < 1)) throw new Error('--percentile must be between 0 and 1');
  if (!(windowSeconds > 0)) throw new Error('--window must be positive');
  if (maxBoostDb < 0 || maxCutDb < 0) throw new Error('--max-boost and --max-cut must not be negative');
  if (!(smoothSeconds >= 0)) throw new Error('--smooth must not be negative');
  if (!(slewDbPerSecond > 0)) throw new Error('--slew must be positive');
  if (args.options.fixedGainDb !== undefined && args.options.targetLufs !== undefined) {
    throw new Error('--gain and --target cannot be used together');
  }
  if (args.ceilingDb !== null && args.ceilingDb > 0) throw new Error('--ceiling must be 0 dBFS or lower');
  if (!(args.fadeInSeconds >= 0) || !(args.fadeOutSeconds >= 0)) throw new Error('--fade-in and --fade-out must not be negative');
  if (args.headroomDb !== undefined && !(args.headroomDb >= 0)) throw new Error('--headroom must not be negative');
  if (args.encode.bitrateKbps !== undefined && !(args.encode.bitrateKbps > 0)) throw new Error('--bitrate must be positive');
  if (args.encode.sampleRate !== undefined && !(args.encode.sampleRate >= 8000)) throw new Error('--sample-rate must be 8000 Hz or more');
  return args;
}

function progress(label: string): Progress {
  if (!process.stderr.isTTY) return () => {};
  let shown = -1;
  return (fraction) => {
    const percent = Math.floor(fraction * 100);
    if (percent === shown) return;
    shown = percent;
    process.stderr.write(`\r${label} ${percent}%${percent === 100 ? '\n' : ''}`);
  };
}

const db = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
const lufs = (value: number) => `${value.toFixed(1)} LUFS`;
const dbfs = (linear: number) => `${(20 * Math.log10(Math.max(linear, 1e-9))).toFixed(1)} dBFS`;

function clock(seconds: number): string {
  const s = Math.round(seconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

async function dumpCurves(file: string, before: Measurement, levelling: Levelling, after?: Measurement) {
  const lines = [`time_s,short_term_lufs,low_band_db,full_energy_lufs,gain_db,bass_db${after ? ',mastered_short_term_lufs' : ''}`];
  for (let i = 0; i < before.shortTerm.length; i++) {
    const row = [
      ((i + 0.5) * HOP_SECONDS).toFixed(2),
      before.shortTerm[i].toFixed(2),
      before.lowShortTerm[i].toFixed(2),
      levelling.envelope[i].toFixed(2),
      levelling.gainDb[i].toFixed(2),
      levelling.bassDb[i].toFixed(2),
    ];
    if (after) row.push((after.shortTerm[i] ?? NaN).toFixed(2));
    lines.push(row.join(','));
  }
  await writeFile(file, lines.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.input)) throw new Error(`Input file not found: ${args.input}`);

  const output =
    args.output ?? join(dirname(args.input), `${basename(args.input, extname(args.input))}.mastered.wav`);
  if (!args.analyzeOnly) {
    if (resolve(output) === resolve(args.input)) throw new Error('The output would overwrite the input');
    if (existsSync(output) && !args.force) throw new Error(`${output} already exists (use --force to overwrite)`);
  }

  const before = await measure(args.input, args.region, progress('Analysing'));
  const levelling = level(before, args.options, { peaks: before.peaks, ceilingDb: args.ceilingDb ?? 0 });
  const { gainDb, bassDb } = levelling;
  const minGain = gainDb.reduce((a, b) => Math.min(a, b), Infinity);
  const maxGain = gainDb.reduce((a, b) => Math.max(a, b), -Infinity);

  // What is worth knowing about the recording itself, before anything is done to it.
  for (const finding of checkup(before).findings) {
    console.log(`${finding.kind === 'fault' ? 'Fault' : 'Note '}        ${finding.title}. ${finding.detail}`);
  }
  console.log(`Length       ${clock(before.shortTerm.length * HOP_SECONDS)}`);
  console.log(`Input        ${lufs(before.integratedLufs)} integrated, peak ${dbfs(before.peak)}`);
  console.log(`Target       ${lufs(levelling.targetLufs)} for full-energy sections`);
  console.log(`Gain         ${db(minGain)} to ${db(maxGain)}`);
  if (args.options.levelTracks && args.options.bassCorrection > 0) {
    const minBass = bassDb.reduce((a, b) => Math.min(a, b), Infinity);
    const maxBass = bassDb.reduce((a, b) => Math.max(a, b), -Infinity);
    console.log(`Bass         ${db(minBass)} to ${db(maxBass)}`);
  }

  let after: Measurement | undefined;
  if (!args.analyzeOnly) {
    const headroomDb = args.headroomDb ?? (isLossy(output) ? LOSSY_HEADROOM_DB : 0);
    if (headroomDb > 0) console.log(`Headroom     ${headroomDb.toFixed(1)} dB left for the encoding`);
    const result = await render(
      args.input, args.region, gainDb, output, {
        ceilingDb: args.ceilingDb, bassDb, encode: args.encode, headroomDb,
        fadeInSeconds: args.fadeInSeconds, fadeOutSeconds: args.fadeOutSeconds,
      },
      progress('Rendering'),
    );
    after = result;
    console.log(`Output       ${lufs(result.integratedLufs)} integrated, peak ${dbfs(result.peak)}`);
    console.log(`Limiter      ${args.ceilingDb === null ? 'off' : `up to ${result.limiterReductionDb.toFixed(1)} dB reduction`}`);
    console.log(`Wrote        ${output}`);
  }
  if (args.dump) {
    await dumpCurves(args.dump, before, levelling, after);
    console.log(`Curves       ${args.dump}`);
  }
}

main().catch((error) => {
  console.error(`djmaster: ${error.message}`);
  process.exit(1);
});
