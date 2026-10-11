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

### Tags and cue sheets on export — medium

Exports carry a title but nothing else.

- Add artist, album and date fields per mix (or per recording, inherited by
  its mixes) and write them into the exported file.
- Optionally write a `.cue` file next to each export.
- A cue sheet needs track boundaries. The steps in the gain curve hint at
  them but are not reliable on their own; start with markers placed by hand
  and consider suggestions later.

Done when an exported file shows the entered tags in a music player.

### Automated tests on GitHub — small

Nothing runs the tests on a push.

- A workflow that installs, type-checks and runs `npm test` on macOS and
  Linux.
- ffmpeg has to be installed on the runner; the end-to-end test needs it.

Done when a push shows a passing check.

### Lower ceiling for lossy exports — small

MP3 and AAC encoding reshape the waveform after the limiter, so peaks land
above the ceiling (0.7 dB over in one measured case).

- Offer, or apply by default, an extra margin for `.mp3` and `.m4a` exports.
- Decide whether it is automatic or a visible setting.

Done when an MP3 export measures at or under the ceiling in true peak.

### Finer waveform when zoomed in — medium

The displays work in 100 ms blocks, so close zooms are blocky and individual
beats cannot be seen when placing a mix edge or a split.

- Decode the visible stretch on demand at a higher resolution when zoomed
  past a threshold, and cache it.
- The analysis should stay at 100 ms; this is for display only.

Done when a kick drum is visible as a shape at the closest zoom.

## Sharing the app

These wait on a decision to distribute it. See the README for the current
state: installers for Apple Silicon Macs and for Windows, neither signed for
distribution.

### Choose a licence — small, a decision

The repository has no licence. GPL-3.0-or-later was discussed as a good fit:
it matches the bundled ffmpeg build and comparable audio tools. The choice
has to be made before the repository goes public.

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

### Try the Windows build on a real machine — small, needs a tester

GitHub builds a Windows installer on every version tag, and the unit tests
pass there, but nobody has opened the app on Windows.

- Install it, open a recording, play, export, cancel an export.
- Watch for: the bundled ffmpeg being found, cancelling an export removing
  the half-written file, file dialogs and paths with backslashes.
- The installer is unsigned, so Windows shows "Windows protected your PC".
  Signing options (Store, certificate, or staying unsigned) were researched;
  for wide distribution the Microsoft Store with an MSIX package avoids
  buying a certificate.

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

## Known limitations

Not tasks so much as things to remember. Details are in the README.

- Clipping cannot be undone.
- A quiet passage longer than the breakdown length is treated as a quieter
  track and raised, up to the boost limit.
- Moving or renaming a recording loses its saved mixes, which are keyed on
  the file's path.
- Undo history is per session and is not saved.
