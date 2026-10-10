# DJ Mix Master

Masters recorded DJ mixes. Open a long recording, mark the mix inside it, and
the tool evens out the loudness from track to track: louder tracks are turned
down and quieter ones up, while breakdowns keep their natural dip instead of
being pumped up.

It comes as a desktop app (macOS for now) and as a command-line tool that share
the same processing.

## What it does

- **Levels track against track, not moment against moment.** A slow gain curve
  follows how loud each track is at full energy. Quiet passages shorter than
  about 90 seconds are treated as breakdowns and keep the gain of the track
  around them.
- **Optional bass correction.** Kick and bass can be levelled separately from
  everything above them with a slowly moving low-shelf EQ, so the low end stays
  consistent without dragging the mids and highs along.
- **Leaves headroom by default.** With no target set, the result is made as
  loud as fits under the ceiling without leaning on the limiter. A higher
  target pushes into the limiter for more level.
- **Look-ahead true-peak limiter** on the output, with the ceiling at -1 dBTP by
  default. It holds the level between samples as well as on them.
- **Handles long files.** Recordings are streamed, never loaded whole; an
  8-hour MP3 analyses in under a minute and only once.

## The app

```bash
npm install
npm start
```

Running from the project needs Node 24 or newer and ffmpeg on the machine
(`brew install ffmpeg`). The packaged app carries its own ffmpeg.

- **Overview**: the whole recording. Drag across a free part to mark a mix,
  drag an edge to adjust it, drag the middle to move it. Scroll to zoom, swipe
  sideways to move.
- **Several mixes per recording**: each has its own name, settings and
  adjustments. Export one, or all of them into a folder in one go.
- **Detail view**: waveform, loudness before and after, and the gain being
  applied. Scroll to zoom in on a transition.
- **Live preview**: Space plays and pauses, A switches between the original
  and the levelled sound. Settings change what you hear immediately, and the
  preview uses the same limiter as the export.
- **Adjusting by hand**: drag sideways across the gain lane to mark a stretch,
  then drag it up or down. Drag an edge to resize it, double-click to remove.
- **Undo and redo**: Cmd+Z and Shift+Cmd+Z cover every change to the mixes.
- **Remembers your work**: mixes, settings and adjustments are saved per
  recording and restored when you open it again.
- **Exact preview in every format**: recordings the built-in player cannot
  seek in exactly (variable-bitrate MP3s) or cannot play (AIFF) are decoded by
  ffmpeg from the playhead instead, at the cost of a moment's delay on each jump.
- **Export formats**: WAV and FLAC (24-bit), MP3 (320 kbps), AAC (256 kbps).

### Building the Mac app

```bash
npm run package
```

This writes a `.dmg` to `release/`. The app is built for Apple Silicon and
signed locally only: it runs on the Mac that built it, but is not signed for
distribution, so another Mac will block it until the user approves it. The
bundled ffmpeg is a GPL build, which brings obligations if you share the app.

## The command line

```bash
node src/cli.ts recording.mp3 --start 1:12:00 --end 2:45:30 -o mix.wav
```

The output format follows the file extension: `.wav`, `.flac`, `.mp3` or
`.m4a`. Without `-o` the result is written next to the input as
`<name>.mastered.wav`.

| Option | What it does | Default |
|---|---|---|
| `--start`, `--end` | The mix inside the recording, in seconds or `h:mm:ss` | whole file |
| `-o`, `--output` | Output file | `<input>.mastered.wav` |
| `--force` | Overwrite the output if it exists | off |
| `--analyze-only` | Print the planned gain without writing audio | off |
| `--dump <file.csv>` | Write the loudness and gain curves for inspection | off |
| `--target <LUFS>` | Loudness of the full-energy sections | as loud as fits without limiting |
| `--window <seconds>` | Quiet passages shorter than about this are breakdowns | 100 |
| `--percentile <0-1>` | Loudness percentile that counts as full energy | 0.9 |
| `--bass-correction <0-1>` | How much of the bass difference between tracks the EQ evens out | 0 |
| `--max-bass <dB>` | Most that EQ raises or lowers a track's bass | 3 |
| `--bass-weight <0-1>` | Steer the overall gain by bass level instead of perceived loudness | 0 |
| `--max-boost <dB>` | Most a quiet track is raised | 6 |
| `--max-cut <dB>` | Most a loud track is lowered | 12 |
| `--smooth <seconds>` | How long a gain change takes | 10 |
| `--slew <dB/s>` | Fastest the gain may move | 0.25 |
| `--ceiling <dBTP>` | True-peak ceiling of the limiter | -1 |
| `--no-limiter` | Leave peaks alone; boosted tracks may clip | off |

The command line looks for ffmpeg on `PATH` and in the usual Homebrew folders.
Set `DJMASTER_FFMPEG` to use a specific binary.

## How it works

1. **Measure.** One pass over the audio produces the loudness (ITU-R BS.1770,
   K-weighted) in 100 ms blocks, plus the level of the low band and the peaks.
2. **Find the full-energy level.** A sliding high percentile fills in every dip
   shorter than the window, then the mirrored low percentile puts the edges
   back where they were. Breakdowns vanish from this curve; a change of level
   between two tracks stays a step.
3. **Derive the gain.** The gain is the difference between that curve and its
   typical level, limited by the boost and cut settings, smoothed and capped in
   how fast it may move. Hand adjustments are added on top.
4. **Render.** A second pass applies the bass shelf and the gain, runs the
   limiter and encodes the result.

## Limitations

- **Clipping cannot be undone.** A recording made too hot is turned down to
  match the rest, but tracks that were clipped still sound clipped.
- **Lossy formats overshoot.** MP3 and AAC encoding reshape the waveform after
  the limiter, so their peaks can land a little above the ceiling (around
  0.7 dB in one test). Lower the ceiling for those exports if it matters.
- **Long quiet passages.** A passage quieter than the rest for longer than the
  breakdown length counts as a quieter track and is raised, up to the boost
  limit.
- **macOS only** so far. The code avoids platform-specific pieces where it
  can, but it has not been run on Windows or Linux.

## Development

```bash
npm test          # unit tests, including an end-to-end run on a synthetic mix
npm run typecheck
```

| Path | What lives there |
|---|---|
| `src/loudness.ts` | Streaming loudness, low-band and peak meter |
| `src/gain-curve.ts` | Full-energy envelope, gain curve, hand adjustments |
| `src/level.ts` | Turns measurements and settings into gain and bass curves |
| `src/shelf.ts`, `src/limiter.ts` | The bass shelf and the look-ahead limiter |
| `src/true-peak.ts` | Estimates peaks between samples for the limiter |
| `src/audio-io.ts` | Decoding and encoding through ffmpeg |
| `src/master.ts` | The two passes: measure and render |
| `src/cli.ts` | Command-line tool |
| `src/app/` | Electron app: main process, worker, and the window in `renderer/` |
| `test/` | Tests and the synthetic mix they run on |

The TypeScript runs directly under Node 24 for the command line and tests. The
app is bundled with esbuild into `dist/` by `npm run build`.
