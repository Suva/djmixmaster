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

### A check-up report when a recording is opened — medium

Recordings from booth recorders and PA mixers have recurring faults. The
analysis pass already reads every sample, so it can look for them and say
what it found in plain words. The report alone is useful; fixes can follow
one at a time (see "Fixes for common recording faults" below).

- **Clipping**: how much of the recording peaks at or above full scale. The
  automatic target already works around it without saying why.
- **Channel imbalance or a dead channel**: one side consistently quieter, or
  silent.
- **One channel out of phase**: left and right cancel when summed, which
  takes the bass away on mono systems.
- **Dropouts**: short stretches of digital silence in the middle of music.
  Mark them on the timeline.
- **Mains hum**: steady energy at 50 or 60 Hz and its harmonics.
- **Rumble or DC offset**: energy below anything musical.

These need extra measurements per block, kept small, and so a bump of
`ANALYSIS_VERSION`. Per-channel levels and the left/right correlation cover
the two channel faults; the rest need a few narrow bands.

Done when opening a recording with one of these faults says so, and a clean
recording says nothing is wrong.

### Copy settings between mixes, and presets — small

After tuning one mix, the others from the same night usually want the same
settings, and a favourite setup is worth keeping for next time.

- "Apply these settings to all mixes" for the current recording.
- Named presets that can be saved, applied and deleted, stored with the
  app's other data.
- Hand adjustments are not settings: they belong to their place in one mix
  and are not copied.

### Cue sheets on export — medium

Exports carry title, artist, album and track number, but nothing about the
tracks inside a mix.

- Optionally write a `.cue` file next to each export.
- A cue sheet needs track boundaries. The steps in the gain curve hint at
  them but are not reliable on their own; start with markers placed by hand
  and consider suggestions later.

Done when a player that reads cue sheets shows the tracks of an exported mix.

### Automated tests on GitHub — small

Nothing runs the tests on a push.

- A workflow that installs, type-checks and runs `npm test` on macOS and
  Linux.
- ffmpeg has to be installed on the runner; the end-to-end test needs it.

Done when a push shows a passing check.

### Finer waveform when zoomed in — medium

The displays work in 100 ms blocks, so close zooms are blocky and individual
beats cannot be seen when placing a mix edge or a split.

- Decode the visible stretch on demand at a higher resolution when zoomed
  past a threshold, and cache it.
- The analysis should stay at 100 ms; this is for display only.

Done when a kick drum is visible as a shape at the closest zoom.

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

### Linux build — small, needs a tester

- Add a Linux job to `.github/workflows/release.yml` and an AppImage target.
- `ffmpeg-static` provides the binary on the build machine, as it does for
  the other two.
- Someone has to open the result.

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

### Corrective EQ, with a suggested correction

A recording taken from a PA mixer can carry the system's EQ: boosted bass,
dulled highs. A small set of broad controls could undo it: a low and a high
shelf, one or two mid bands, and a high-pass filter, set once per recording
and inherited by its mixes.

- An EQ changes loudness and peaks, which the levelling and the automatic
  target depend on. Measuring energy in about ten frequency bands during
  analysis would let any EQ's effect be predicted without decoding again.
- The same bands give an average spectrum. Over an hour of varied tracks
  that settles into a predictable shape, so a recording that sits well off
  it probably shows the system's EQ. A "Suggest" button could propose a
  gentle, capped correction to judge by ear.
- Preview and export have to use the same filter formulas, as with the bass
  shelf.
- It cannot undo a limiter in the PA chain, clipping, or bass that was split
  off before the recorder.

Waiting on a real recording known to have come off a PA mixer, to see
whether the spectrum shows what is expected.

### Fixes for common recording faults

One-click fixes for what the check-up report finds, added as real recordings
show which faults actually turn up:

- Rebalance the channels, or build both from the good one.
- Flip one channel that is out of phase.
- Narrow filters for mains hum and its harmonics.
- A high-pass filter for rumble and DC offset (shared with the EQ idea).
- Patch very short dropouts.

### Cut a section out of a mix

Remove a microphone announcement, a train wreck or a technical stop, and
join the two sides with a crossfade. More work than it sounds: every
position after the cut shifts, which touches the analysis, the saved
session, hand adjustments and the preview.

### Track lists from rekordbox

Import a rekordbox history, show its tracks as markers on the timeline to
drag into place, and export a text list or a cue sheet. A history export
gives the order and the names but most likely not when each track started.
Waiting on a look at a real export. Related to "Cue sheets on export".

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

### A window test suite

The window is checked with one-off scripts (see AGENTS.md). Keeping a few of
them as a repeatable suite would catch regressions in interaction, which is
where most bugs have been.

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
- Moving or renaming a recording loses its saved mixes, which are keyed on
  the file's path.
- Undo history is per session and is not saved.
