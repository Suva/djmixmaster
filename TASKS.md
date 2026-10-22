# Tasks

What could and should be done next. Each task says why it matters, roughly
what it involves, and how to tell it is done. Remove a task when it is
finished; add new ones where they belong. For how the code is organised, see
[AGENTS.md](AGENTS.md).

Size is a rough guide: **small** is an hour or two, **medium** a session,
**large** several.

## First: use it for real

Everything so far has been verified by measurement and by scripted runs of
the app. Nobody has yet mastered a whole night with it and listened to the
result on a proper system. That session will reorder this list.

Things to judge by ear:

- Are the defaults right: breakdown length (90 s), transition time (20 s),
  boost and cut limits?
- Does any gain change sound like a move? Does any breakdown feel lifted?
- Is bass correction better on or off, and at what amount?
- Does the limiter sound clean when the target is pushed up?
- How does the automatic target sound on a recording that was made too hot?

## Next

### Check the hum, rumble and offset findings on real recordings — small

The check-up reports mains hum (50 or 60 Hz), rumble below 20 Hz and a DC
offset, but these have only met synthetic signals. Neither of the two real
recordings at hand has any of them, which at least shows they do not raise
false alarms there.

- Try a recording known to hum, ideally one from each mains region.
- Try a vinyl set for rumble.
- If the thresholds need moving, they are in `src/checkup.ts`: the hum has to
  stand 12 dB clear of its surroundings with a harmonic 10 dB clear, in 70%
  of the quietest stretches; rumble has to come within 15 dB of the bass.

### Check-up findings that were tried and left out

Written down so they are not tried the same way again.

- **Already limited.** The idea was that a limiter pins the peaks at one
  level whatever the loudness. But so does any DJ playing mastered tracks at
  steady gains: on a clean one-hour recording the top peak of every five
  minutes stayed within 0.6 dB while the loudness moved by 2.4 dB. The two
  cannot be told apart this way, and the finding would not change what
  anyone does.
- **Clicks and glitches.** A recorder losing samples leaves a sudden jump in
  the waveform, but so does the attack of a kick drum, a square wave, or any
  bit-crushed sound. A detector strict enough to ignore those has nothing
  left to find in an MP3, where such jumps are smoothed away anyway. Worth
  another look only with real examples of glitched recordings to learn from.
- **Dropouts**, from the first round: dance music is full of deliberate
  silences. Only a gap under 50 ms with no other silence within two seconds
  is reported, and as a note. Nobody has yet listened to the four it finds
  in the 8-hour test recording to see whether they are real.

### The built-in templates in vertical and square — small

Every template draws in each shape, with sizes against the short side, but
the built-in ones were laid out for landscape. In vertical, a ring or a title
sits small in a tall picture, with empty space above and below.

- Look at each built-in template in vertical and square, and use `portrait`
  in their expressions where a layer should sit or size otherwise.
- Done when each looks made for the shape in a screenshot of each.

### Named settings presets — small

"Apply to all mixes" copies one mix's settings to the rest of a recording. A
favourite setup is also worth keeping for the next recording.

- Named presets that can be saved, applied and deleted, stored with the
  app's other data.
- Like "Apply to all mixes", a preset holds the settings only, not fades or
  hand adjustments.

### Cue sheets on export — medium

MP3, AAC and MP4 exports carry the mix's track markers as chapters; WAV and
FLAC cannot hold chapters, so nothing of the tracks reaches them.

- Optionally write a `.cue` file next to each export, from the same markers
  (`chaptersOf` in `src/tracks.ts`).
- Placing markers by hand is the only way for now. The steps in the gain
  curve, or changes of tempo, could suggest places, but are not reliable on
  their own.

Done when a player that reads cue sheets shows the tracks of an exported mix.

## Sharing the app

The repository is public, under GPL-3.0-or-later, with installers for Apple
Silicon Macs and for Windows. Neither is signed for distribution.

### Keep the website current — small, ongoing

The repository is public and the website is live at
https://suva.github.io/djmixmaster/, republished after every release.

- Decide whether releases are still marked as pre-releases. The page shows
  the newest release either way and says when it is a pre-release.
- Update the screenshot in `site/` when the window changes noticeably. See
  the AGENTS.md section on the website for how it is taken.

### Intel and universal Mac builds — small

The packaged app does not run on Intel Macs.

- Build for `x64` or as a universal app.
- The bundled ffmpeg has to match: `ffmpeg-static` installs one binary for
  the machine it is installed on, so the other has to be fetched as well.

### A native ARM64 build for Windows — medium, needs an ARM machine to test

The Windows installer and the Microsoft Store package are x64 only, and the
Store says so when a version is submitted. Windows 11 on ARM (the Snapdragon
laptops) runs them through its emulation, so they work there, but slower:
levelling and video exports take longer.

- electron-builder can build ARM64 as well (`--arm64`), for the installer
  and the Store package alike.
- The bundled ffmpeg is the hard part: `ffmpeg-static` has no ARM64 Windows
  build. Fetch a native one in the release workflow from a well-known build
  (BtbN's FFmpeg builds on GitHub have one), checked against a known
  checksum, with its licence beside it. Shipping the x64 ffmpeg in the ARM64
  app would work, emulated, but give up most of the gain.
- GitHub's Windows machines are x64, so nobody can try it there: done when it
  has been installed and used on an ARM laptop, a recording levelled and a
  video exported.
- Worth doing once someone with an ARM laptop asks, or one is at hand.

### Signing and notarization for macOS — small, needs an account

Other Macs block the app until the user approves it in System Settings.

- Needs an Apple Developer Program membership.
- electron-builder supports Developer ID signing and notarization; the work
  is configuration and credentials, plus turning the hardened runtime back on
  with the entitlements Electron needs.

### Finish checking the Windows build — small, needs a tester

The v0.2.0 installer has been opened on a real Windows machine and seemed to
work well in general use. These specific things were written for Windows
without being tried there, and are worth a deliberate check:

- Cancelling an export part-way removes the half-written file.
- Playing a variable-bitrate MP3 or an AIFF, which goes through the streamed
  preview.
- "Export all" into a folder, and file names with unusual characters.

### Sign the Windows installer — a decision

The installer is unsigned, so Windows shows "Windows protected your PC".
Signing options (Store, certificate, or staying unsigned) were researched;
for wide distribution the Microsoft Store with an MSIX package avoids buying
a certificate.

### Try the Linux build — small, needs a tester

Releases include an AppImage. GitHub starts it once on a short recording
before publishing, which shows it opens and finds its ffmpeg, but nobody has
used it on a desktop. Worth a check: playback and sound output, the file
dialogs, dropping files on the window, and whether it starts on Ubuntu 24.04
without extra steps. It runs without Chromium's sandbox (see `main.ts`).

### An LGPL build of ffmpeg — medium

The bundled ffmpeg is a GPL build. That is fine for personal use and under a
GPL licence for the app. If the app is ever to ship under different terms,
bundle an LGPL build with only the codecs needed: MP3, AAC, FLAC and WAV.

## Ideas, not yet decided

### Check what platforms really do to loudness

The loudness presets name SoundCloud and Mixcloud under "Loud" and YouTube
and Spotify under "Streaming". SoundCloud's help pages say it normalizes to
about -14 LUFS, but -14 uploads have been heard to play quieter than their
neighbours there, so it is treated as playing files as they are. Nothing
from Mixcloud was found either way. A test would settle it: upload the same
minute at -9 and at -14 as private tracks and compare. Adjust the preset
descriptions in `renderer.ts` to match what is found.

### Recording: analysis while it records

The recorder sends every sample to the main process for its meters. Run the
analysis's meters on them as they come (`BlockEnergyMeter`, `BandMeter`,
`RecordingExaminer`), so that the recording is analysed the moment it stops
and opens without a second pass; show the check-up's warnings, clipping and
dropouts, while recording; and let M mark a track while recording.

### A capture helper for recording

Recordings are captured by Chromium (`capture.ts`), which gives at most two
channels of a device: a mixer's record output on its channels 3 and 4 cannot
be recorded, and a crash of the app ends the recording. `native/capture/`
holds a helper of our own that does neither: `capture.c`, on miniaudio 0.11.25
(vendored, public domain or MIT-0), which reaches Core Audio, WASAPI, ALSA,
PulseAudio and JACK. `node scripts/build-capture.mjs` builds it; `list` prints
the inputs with their channels and rates, and `record --device <id> --channels
3,4` writes those two as 32-bit floats to stdout, its level as JSON lines on
stderr, and stops on a `q` on stdin, not on stdin closing. The device's
callback only fills a ring buffer of 10 s; anything that would not fit is
reported as `lost`, never dropped without a word.

Tried on macOS with BlackHole as a loopback: tones played into its channels 3
and 4 at its own rate came back for 60 s with not one sample missing or
repeated, checked sample by sample; piped into the writing ffmpeg (`writerArgs`)
and stopped with `q`, both ended within 50 ms with their parts whole. Never ask
it for a rate other than the device's own: miniaudio then resamples, linearly.

The app records through it (`recorder.ts`), with Chromium as the fallback.
Through the whole app, BlackHole's channels 3 and 4 came back for 30 s without
a break, and the Komplete Audio 6 (6 channels) kept 60.02 s of sound in
60.06 s.

What is left:

1. Ship it: built by the release workflow on each system and packaged beside
   ffmpeg (`extraResources`, as `bin/djm-capture`, where `captureHelper` in
   `main.ts` looks for it). It needs no certificate of its own: on macOS the
   linker signs it ad hoc and electron-builder signs it with the app; on
   Windows only downloads are judged, and the Store signs its package whole.
   With a Developer ID later, it needs the audio-input entitlement, as the
   app. Then the manual, the README and the changelog can say that any two
   inputs of a sound card can be recorded, and that a recording carries on
   if the app closes.
2. An hour with a real source into the Komplete Audio 6's inputs 3 and 4 on
   macOS, and the same on Windows and Linux, where the helper has not yet been
   compiled. On Windows, see too whether its pairs of inputs show as devices
   of their own ("Line 3/4").
3. ASIO on Windows only if an interface turns out to need it: miniaudio has
   none, and Steinberg's SDK is under GPLv3 since 2023.

### Recording on Windows and Linux

Recording has been tried on macOS only. Chromium's capture should work on the
others; try it, and declare the microphone capability in the Microsoft Store
package.

### A suggested EQ correction

Each mix has a corrective EQ (`eq.ts`), and the analysis measures how every
four blocks' energy divides over thirteen bands (`bands.ts`). What is left:

- A "Suggest" button. The EQ panel already draws this mix's average spectrum
  beside the other mixes' (`bandShares` in `eq.ts`); the button would close
  the gap between them. The other mixes of the same night went through the same
  mixer, PA and recorder, so their average spectrum is the best reference for
  a set that sounds off, such as one played on records through a faulty phono
  stage while the rest came from CDJs. The difference, smoothed and capped,
  is a correction to judge by ear. Where there is only one mix, the spectrum
  an hour of varied tracks settles into could stand in.
- Presets for faults known from real gear, once someone sends measurements:
  a recording of a test record's sweep through their mixer would show how far
  its phono stage is off.
- An EQ that changes inside a mix, for a DJ who switches between records and
  CDJs during a set, perhaps as a kind of hand adjustment over a stretch.
  Wait until someone asks for it.
- It cannot undo a limiter in the PA chain, clipping, or bass that was split
  off before the recorder.

### Fixes for common recording faults

One-click fixes for what the check-up report finds, added as real recordings
show which faults actually turn up:

- Narrow filters for mains hum and its harmonics, at 50 or 60 Hz according
  to which the check-up found.
- A high-pass filter for rumble and DC offset: the EQ's rumble filter does
  this by hand; the check-up could offer it.
- Patch very short dropouts.

### Cut a section out of a mix

Remove a microphone announcement, a train wreck or a technical stop, and
join the two sides with a crossfade. More work than it sounds: every
position after the cut shifts, which touches the analysis, the saved
session, hand adjustments and the preview.

### Suggest handovers without a gap

Gap detection finds the hard cuts. On the 8-hour test recording that was 3
of about 7 handovers; the rest were mixed through.

An experiment showed that level steps and tone shifts alone give mostly
false suggestions. Something better would be needed: tempo or key changes,
or simply the hour marks. Worth trying only if splitting by ear turns out to
be the slow part.

### Clipping repair

Recordings made too hot stay distorted after levelling. A declipper could
rebuild flattened peaks. Results vary with how hard the clipping was, and it
is the most experimental item here. Only worth it if clipped recordings are
common.

### Run ffmpeg as WebAssembly

One build for every platform, and a browser version would become possible.
It costs speed, likely several times slower, and needs a streaming
interface to the library; the stock builds work on files held in memory,
which an 8-hour recording does not fit. Revisit if per-platform binaries
become a burden or a web version is wanted.

### Set the recording and the selected mix apart

The top of the window is about the whole recording (the mix tabs, its
timeline, and the row that names, places, splits and deletes a mix); below it
are the transport, curves and meter of the one selected mix. Nothing on
screen says so, and the two rows of buttons where they meet read as one.

Tried and taken out again: a bordered box around each half, with the mix's
name leading the lower one. It made the window feel cramped. Something
lighter is wanted: a thin line, more space at the join, or a quiet heading.

### More of the window under test

`test/window.test.ts` drives the real app through opening, settings,
splitting, undo, the keys, playback, closing, the recent list and "Export
all". Still unchecked there:

- Dragging: marking a mix on the overview, moving its edges, fades, hand
  adjustments, and that a click with a pixel of movement is not a drag.
- The streamed playback path, with a variable-bitrate MP3.
- Running on GitHub for real. A trial job in `test.yml` runs them on macOS
  and Windows without failing the workflow. Once it has passed a few times,
  drop its `continue-on-error`, and take `DJMASTER_SKIP_WINDOW_TESTS` out of
  `release.yml` so a release is tested the same way. Linux would need a
  display (`xvfb-run`) and probably `--no-sandbox`.

### Not planned

Compression, stereo wideners, exciters and other processing meant to make
music sound "better". They are matters of taste, they stack on top of music
that is already mastered, and they would pull the tool away from repairing
recordings.

## Known limitations

Not tasks so much as things to remember. Details are in the README.

- Clipping cannot be undone.
- A quiet passage longer than the breakdown length is treated as a quieter
  track and raised, up to the boost limit.
- A recording that was edited or converted to another format is a new
  recording: its mixes and analysis are found by path or by a fingerprint of
  the file's content, and neither survives that.
- Undo history is per session and is not saved.
