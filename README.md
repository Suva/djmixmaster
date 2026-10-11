# DJ Mix Master

Masters recorded DJ mixes. Open a long recording, mark the mix inside it, and
the tool evens out the loudness from track to track: louder tracks are turned
down and quieter ones up, while breakdowns keep their natural dip instead of
being pumped up.

It comes as a desktop app for macOS and Windows, and as a command-line tool
that shares the same processing.

![The app with two mixes marked in a recording](site/screenshot.png)

## Download and install

Installers are on the [releases page](https://github.com/Suva/djmixmaster/releases).
Nothing else needs to be installed; the app carries everything it uses.

| System | File | Needs |
|---|---|---|
| macOS | `DJ.Mix.Master-…-arm64.dmg` | A Mac with Apple Silicon (M1 or later), macOS 13 or later |
| Windows | `DJ.Mix.Master.Setup.….exe` | 64-bit Windows 10 or later |

The installers are not signed, so both systems warn about them the first time.

- **macOS**: open the disk image and drag the app to Applications. The first
  launch is blocked. Open System Settings → Privacy & Security, scroll down
  and click "Open Anyway". After that it opens normally. If macOS says the
  app is damaged, run
  `xattr -dr com.apple.quarantine "/Applications/DJ Mix Master.app"`
  in Terminal.
- **Windows**: run the setup file. When "Windows protected your PC" appears,
  click "More info" and then "Run anyway".

There is no build for Intel Macs or Linux yet. On those, the tool can be run
[from source](#running-from-source).

## Getting started

1. **Open a recording.** Drop a file on the window or use "Open recording…".
   It is analysed once, which takes about a minute for an eight-hour file.
2. **Mark the mix.** The whole recording starts out as one mix. Drag its edges
   in, or press "Split at gaps" to cut a night apart at the silences. Drag
   across a free part to mark another mix.
3. **Listen.** Press Space to play. The Original/Levelled switch (or the A
   key) compares before and after.
4. **Adjust if needed.** The defaults work for most mixes. The sliders on the
   right change how it levels; what you hear follows immediately.
5. **Export.** "Export mix…" writes the selected mix, "Export all" every mix
   into one folder.

Your recording is never changed, and nothing leaves your computer.

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
- **Handles long files.** Recordings are streamed, never loaded whole.

## Using the app

### The recording and its mixes

- **Overview**: the whole recording. Drag across a free part to mark a mix,
  drag an edge to adjust it, drag the middle to move it. Scroll to zoom, swipe
  sideways to move.
- **Finding the sets**: silences in the recording are marked in orange. "Split
  at gaps" cuts a mix apart at them; "Split at playhead" is for handovers that
  were mixed without a gap.
- **Several mixes per recording**: each has its own name, settings and
  adjustments. Double-click a mix's tab to rename it.

### Listening and adjusting

- **Detail view**: the waveform, the loudness before and after, and the gain
  being applied. Scroll to zoom in on a transition.
- **Live preview**: settings change what you hear immediately, and the preview
  uses the same limiter as the export.
- **Adjusting by hand**: drag sideways across the gain lane to mark a stretch,
  then drag it up or down. The Adjust switch (Level or Bass) chooses whether a
  new stretch changes the whole sound or the bass only. Drag an edge to resize
  it, double-click to remove it.
- **Undo and redo** cover every change to the mixes.
- **Your work is remembered**: mixes, settings and adjustments are saved per
  recording and restored when you open it again.

### The settings

| Setting | What it does |
|---|---|
| Target loudness | How loud the full-energy parts end up. Left on "As loud as fits without limiting", the tool picks the highest level that keeps the limiter out of the way. |
| Breakdown length | Quieter passages shorter than this keep the gain of the track around them. Longer ones are treated as a quieter track and raised. |
| Transition time | How long a change of gain takes between two tracks. |
| Bass correction | How much of the difference in bass between tracks is evened out. Off by default. |
| Most bass change | The limit on that correction for any one track. |
| Most boost, Most cut | How far a quiet track may be raised and a loud one lowered. |
| True-peak ceiling | The highest level the output may reach. |

### Keys

| Key | Does |
|---|---|
| Space | Play or pause |
| A | Switch between the original and the levelled sound |
| ← → | Move the playhead 5 seconds (30 with Shift, 1 with Option or Alt) |
| Return | Jump to the start of the mix |
| Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z | Undo, redo |
| Cmd/Ctrl+O | Open a recording |
| Esc | Cancel an analysis or export in progress |

### Exporting

The export dialog asks for:

- **Format**: WAV, FLAC, MP3 or AAC.
- **Bit depth** for WAV and FLAC: 16-bit, which is dithered and the usual
  choice for sharing and playing, or 24-bit.
- **Bitrate** for MP3 and AAC.
- **Sample rate**: the recording's own, or 44.1 or 48 kHz.
- **Tags**: a title and an artist per mix and an album for the recording.

It shows roughly how large the files will be and remembers what you chose.
A mix you have named is exported under that name. MP3 and AAC exports are made
1 dB quieter by default, because encoding to them raises the peaks.

### Formats it reads

Anything ffmpeg can decode, including MP3, WAV, FLAC, AAC/M4A, AIFF, Ogg and
Opus. Variable-bitrate MP3s and AIFF files take a moment longer to start
playing after each jump, because they are decoded on the fly to keep the
preview exactly in step.

## Limitations

- **Clipping cannot be undone.** A recording made too hot is turned down to
  match the rest, but tracks that were clipped still sound clipped.
- **Long quiet passages.** A passage quieter than the rest for longer than the
  breakdown length counts as a quieter track and is raised, up to the boost
  limit.
- **Handovers without a gap are not found.** "Split at gaps" sees silences
  only. Where one DJ mixed out of another, the split is yours to place.
- **Moving or renaming a recording** loses the mixes saved for it.
- **Less tested on Windows.** It is developed on macOS. The Windows build has
  been used on a real machine but gets less testing.

## The command line

The same processing without the window. It needs
[Node](https://nodejs.org) 24 or newer and ffmpeg installed; see
[Running from source](#running-from-source).

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
| `--bit-depth <16\|24>` | Bits per sample for `.wav` and `.flac`; 16-bit is dithered | 16 |
| `--bitrate <kbps>` | Bitrate for `.mp3` and `.m4a` | 320 and 256 |
| `--sample-rate <Hz>` | Sample rate of the output | the input's |
| `--headroom <dB>` | Extra room under the ceiling for `.mp3` and `.m4a` | 1 |
| `--title`, `--artist`, `--album` | Tags to write into the output | none |
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

## Running from source

Needs [Node](https://nodejs.org) 24 or newer and ffmpeg on the machine
(`brew install ffmpeg` on macOS).

```bash
git clone https://github.com/Suva/djmixmaster.git
cd djmixmaster
npm install
npm start
```

### Building the installers

```bash
npm run package
```

This builds an installer for the system it runs on into `release/`: a `.dmg`
on macOS, a setup `.exe` on Windows.

To publish a version, run `npm version minor` (or `patch`) and then
`git push --follow-tags`. That updates the version number, tags it, and makes
GitHub build both installers and publish them as a release (see
`.github/workflows/release.yml`).

### Development

```bash
npm test          # unit tests, including an end-to-end run on a synthetic mix
npm run typecheck
```

[AGENTS.md](AGENTS.md) explains how the code is organised and how to check
changes; [TASKS.md](TASKS.md) lists what could be done next.

## Licence

Copyright (C) 2026 Jaan Pullerits

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed in the hope that it will be useful, but without any
warranty. See [LICENSE](LICENSE) for the full text.

The installers include a copy of [FFmpeg](https://ffmpeg.org), which is
licensed separately under the GPL. It is the build from the
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) project, which
documents its sources; its licence is in the app's resources folder next to
the `ffmpeg` binary.
