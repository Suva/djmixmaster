# DJ Mix Master

[![Tests](https://github.com/Suva/djmixmaster/actions/workflows/test.yml/badge.svg)](https://github.com/Suva/djmixmaster/actions/workflows/test.yml)

Masters recorded DJ mixes. Open a long recording, mark the mix inside it, and
the tool evens out the loudness from track to track: louder tracks are turned
down and quieter ones up, while breakdowns keep their natural dip instead of
being pumped up.

It comes as a desktop app for macOS and Windows, and as a command-line tool
that shares the same processing.

![The app with two mixes marked in a recording](site/screenshot.png)

## Download and install

Installers for macOS (Apple Silicon), Windows and Linux are on the
[website](https://suva.github.io/djmixmaster/) and the
[releases page](https://github.com/Suva/djmixmaster/releases); on Windows it
is also in the
[Microsoft Store](https://apps.microsoft.com/detail/9PCL3QKW3G4N). Nothing else
needs to be installed; the app carries everything it uses. The installers
are not signed, so each system warns about them the first time; the manual's
[Installing](https://suva.github.io/djmixmaster/manual/install.html) page
says how to get past that. What changed in each release is in
[CHANGELOG.md](CHANGELOG.md).

There is no build for Intel Macs yet. On those, the tool can be run
[from source](#running-from-source).

## The manual

The [manual](https://suva.github.io/djmixmaster/manual/) covers every part
of the app, with pictures: opening a recording and marking its mixes, the
check-up, levelling, tracks, exporting, and the videos, down to every kind of
layer and every function a template's formulas can use. Its pages are in
[site/manual/](site/manual/); the published one describes the latest
release. The app carries its own copy, for its own version, and Help → User
Manual opens it without a network.

## Getting started

1. **Open a recording.** Drop a file on the window or use "Open recording…".
   It is analysed once. A recording split into several files by the recorder
   opens as one when its parts are chosen together; a video of the set opens
   like a recording.
2. **Mark the mix.** The whole recording starts out as one mix. Drag its edges
   in, or press "Split at gaps" to cut a night apart at the silences.
3. **Listen.** Press Space to play, and A to hear the recording as it was.
4. **Adjust if needed.** The defaults work for most mixes.
5. **Export** the sound, or a video of the mix moving to the music.

Your recording is never changed and never leaves your computer. The only
thing the app contacts is GitHub, at most once a day, to see whether a newer
version exists. If there is one, a line in the header says so; nothing is
installed for you. Turn the check off in Settings.

## What it does

- **Levels track against track, not moment against moment.** A slow gain curve
  follows how loud each track is at full energy. Quiet passages shorter than
  about 90 seconds are treated as breakdowns and keep the gain of the track
  around them.
- **Optional bass correction.** Kick and bass can be levelled separately from
  everything above them with a slowly moving low-shelf EQ, so the low end stays
  consistent without dragging the mids and highs along.
- **A corrective EQ per mix**, for a phono stage that sounds dull or harsh, a
  PA mixer's EQ or turntable rumble: a rumble filter and four broad bands,
  applied before the levelling, which measures the mix as it sounds with it.
- **Leaves headroom by default.** With no target set, the result is made as
  loud as fits under the ceiling without leaning on the limiter. A higher
  target pushes into the limiter for more level.
- **Look-ahead true-peak limiter** on the output, with the ceiling at -1 dBTP by
  default. It holds the level between samples as well as on them.
- **A check-up of the recording**: clipping, channel faults (with one-click
  fixes), dropouts, hum and more.
- **Tracks and chapters**: mark where tracks start, import a list from DJ
  software, copy a list for YouTube; exports carry them as chapters.
- **Videos for YouTube and social media**, in landscape, vertical or square:
  templates that move to the music, or the recording's own picture with the
  mastered sound. Templates can be made in an editor with layers, effects,
  blends, layer styles and formulas, and shared as files.
- **Records the night itself** from a DJ mixer's sound card or any other
  input (macOS for now), with its level shown before you start, in parts of
  half an hour that a crash cannot spoil, and opens the recording when it
  stops.
- **Handles long files.** Recordings are streamed, never loaded whole.

## Limitations

- **Clipping cannot be undone.** A recording made too hot is turned down to
  match the rest, but tracks that were clipped still sound clipped.
- **Long quiet passages.** A passage quieter than the rest for longer than the
  breakdown length counts as a quieter track and is raised, up to the boost
  limit.
- **Handovers without a gap are not found.** "Split at gaps" sees silences
  only. Where one DJ mixed out of another, the split is yours to place.
- **A recording that was edited or converted** is a new recording to the app:
  its saved mixes stay with the old file. Moving or renaming it is fine.
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
| `--fade-in`, `--fade-out <seconds>` | Fade at the start and at the end | none |
| `--headroom <dB>` | Extra room under the ceiling for `.mp3` and `.m4a` | 1 |
| `--title`, `--artist`, `--album` | Tags to write into the output | none |
| `--force` | Overwrite the output if it exists | off |
| `--analyze-only` | Print the planned gain without writing audio | off |
| `--dump <file.csv>` | Write the loudness and gain curves for inspection | off |
| `--target <LUFS>` | Loudness of the full-energy sections | as loud as fits without limiting |
| `--no-levelling` | Leave the tracks as they are; turn the whole mix up or down by one amount | levelling on |
| `--gain <dB>` | That amount, set by hand (implies `--no-levelling`) | as loud as fits |
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
npm test          # build, then unit tests and tests that drive the real window
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

The fonts for videos in `assets/fonts` come from
[Google Fonts](https://github.com/google/fonts) and are each licensed under the
SIL Open Font License, whose text is beside each font.

The bypass icon is `bypass_alt` from
[Brightlayer UI Icons](https://www.npmjs.com/package/@brightlayer-ui/icons-svg)
by Eaton, under the BSD 3-Clause License; its text is in `assets/icons` and
travels with the app.
