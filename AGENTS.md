# Working on DJ Mix Master

Notes for anyone, human or AI agent, changing this code. The [README](README.md)
explains what the program does and how to use it; this file covers how the
code is put together and how to change it safely. Open work is in
[TASKS.md](TASKS.md).

## Commands

```bash
npm install          # once
npm start            # build and run the app from the project
npm test             # build, then unit tests and tests that drive the real window
npm run typecheck    # tsc, no output
npm run package      # build an installer for this system into release/
node src/cli.ts --help
```

Node 24 or newer is required. From the project, the app and the command line
use the ffmpeg installed on the machine (`brew install ffmpeg`); only the
packaged app carries its own.

## How it fits together

Everything works in **blocks of 100 ms** (`HOP_SECONDS`). Positions, regions
and curves in the code are block indexes unless a name says seconds.

1. **Measure** (`src/master.ts` `measure`, `src/loudness.ts`): one streaming
   pass over the audio gives, per block, the K-weighted energy, the energy of
   the low band, and the peak.
2. **Level** (`src/level.ts`, `src/gain-curve.ts`): pure functions turn those
   measurements and the settings into a gain curve and a bass-shelf curve.
   This is cheap and re-runs on every settings change in the app.
3. **Render** (`src/master.ts` `render`): a second streaming pass applies the
   shelf and the gain, runs the limiter and encodes.

| Path | What lives there |
|---|---|
| `src/loudness.ts` | Streaming meter (BS.1770), short-term and integrated loudness |
| `src/gain-curve.ts` | Full-energy envelope, gain curve, hand adjustments |
| `src/level.ts` | Combines the above; automatic target with headroom; bass correction |
| `src/gaps.ts` | Finds silences between sets |
| `src/tracks.ts` | The tracks in a mix: reading track lists, chapters, the list for YouTube |
| `src/features.ts` | What the visuals of a video move to: spectrum, level and beats |
| `src/visuals/shape.ts` | The shapes a video is made in: landscape, vertical, square |
| `src/visuals/clip.ts` | Where a video layer's clip is at each moment: loop, ping-pong, once, speed, restarts |
| `src/visuals/expression.ts` | The expression language of templates' settings, for numbers and colours |
| `src/visuals/colour.ts` | Colours: hex codes, and hue and lightness in OKLCH |
| `src/visuals/lut.ts` | Colour lookup tables: reading .cube files, packing them into templates, applying them without a graphics card |
| `src/visuals/template.ts` | Templates: layer types and their settings, fields, text variables, checking |
| `src/visuals/music.ts` | The music values a video frame gets, read from `features.ts`'s output |
| `src/visuals/draw.ts` | Draws a frame of a template on a 2D canvas, for the preview and the export alike |
| `src/visuals/templates.ts` | The templates that come with the app |
| `src/visuals/layer-tree.ts` | Layer groups: a template's flat list of layers as a tree, and back |
| `src/visuals/motion.ts` | "Moves with…": a choice of what a setting follows, written as an expression and read back |
| `src/visuals/fonts.ts` | Fonts for a video's text: loading them before drawing, and the ones on this computer |
| `src/app/renderer/font-picker.ts` | The font list of the Video view, each name in its own face |
| `src/app/renderer/lut-picker.ts` | The list of LUTs, and of a layer's blends, stepped through with the arrow keys, each put to use as it is reached |
| `src/app/renderer/video-view.ts` | The Video view: a mix's template, its fields and a live picture |
| `src/app/renderer/template-editor.ts` | The template editor in the Video view's panel, with its own undo |
| `src/app/renderer/layer-settings.ts` | The selected layer's settings in the editor, made from its kind's list of settings |
| `src/app/renderer/fields-editor.ts` | The editor's Fields tab: what a template asks to be filled in |
| `src/app/renderer/picture-handles.ts` | Picking, moving and resizing layers on the picture while editing, from where the drawer says each was drawn |
| `src/app/renderer/video-sources.ts` | The frames of a template's videos: video elements in the view, ffmpeg in the export |
| `src/app/renderer/video-frame.ts` | A frame of a mix's video, drawn the same for the view and the export |
| `src/app/renderer/exporter.ts` | The hidden page that draws and encodes a video export |
| `src/diagnostics.ts` | Gathers channel, clipping, silence and spectrum data during analysis |
| `src/checkup.ts` | Turns that data into the findings of the check-up report |
| `src/channels.ts` | Fixes for a recording's channels (rebalance, fill, flip), as a mix of the two, and what they do to its loudness |
| `src/fade.ts` | The fade curve shared by drawing, preview and export |
| `src/shelf.ts`, `src/limiter.ts`, `src/true-peak.ts` | The DSP applied while rendering |
| `src/audio-io.ts` | Decoding, encoding and probing through ffmpeg |
| `src/cli.ts` | Command-line tool |
| `src/app/main.ts` | Electron main process: windows, dialogs, storage, media serving |
| `src/app/worker.ts` | Runs one measure or render job off the main thread |
| `src/app/parts.ts` | The order and the name of a recording that came in several files |
| `src/app/playback.ts` | Decides whether a recording must be streamed for playback |
| `src/app/video-files.ts` | Which files are videos, and the container an export keeps their picture in |
| `src/app/updates.ts` | The background check for a newer version |
| `src/app/zip.ts` | Writing and reading the ZIPs that template files are |
| `src/app/api.ts` | The interface between the window and the main process |
| `src/app/renderer/renderer.ts` | The window: state, mixes, interaction, undo, export |
| `src/app/renderer/draw.ts` | Canvas drawing for the overview and the detail view |
| `src/app/renderer/player.ts` | Playback with live gain, shelf and limiter |
| `src/app/renderer/meter.ts` | The level meter beside the curves |
| `src/app/shortcuts.ts` | The gestures and shortcuts, by where they are used: for the help sheet and the manual |
| `src/app/renderer/settings.ts` | The Settings dialog: the choices that belong to the app, each explained |
| `src/app/renderer/tooltip.ts` | The app's own tooltips, taken from each control's `title` |
| `src/app/renderer/limiter-worklet.ts` | Runs the limiter in the audio thread |

## Rules that are easy to break

- **Erasable TypeScript only.** The command line and the tests run `.ts`
  files directly under Node, which strips types and nothing else. No enums,
  no parameter properties, no namespaces. Imports name the `.ts` extension.
- **No runtime dependencies.** Everything in `package.json` is a dev
  dependency, and the app is bundled by esbuild. Adding a runtime dependency
  also means changing what gets packaged.
- **Keep the shared modules pure.** `loudness.ts`, `gain-curve.ts`,
  `level.ts`, `gaps.ts`, `tracks.ts`, `features.ts`, `visuals/*.ts` (`draw.ts` needs a canvas, so it is for windows only), `fade.ts`, `shelf.ts`, `limiter.ts`, `true-peak.ts`,
  `diagnostics.ts`, `checkup.ts`, `channels.ts` and `encode-options.ts` are
  bundled into the window and the audio worklet. They must not import Node
  modules.
- **Preview and export must sound the same.** They share the limiter code.
  The bass shelf in `shelf.ts` uses the same formulas as the Web Audio
  `lowshelf` filter the preview uses; change one and the other must follow.
- **A mix has two kinds of position.** `region` is in whole blocks and is what
  indexes the curves. The mix's real edges are kept to the millisecond as
  `trimStart` and `trimEnd`, fractions of the first and last block; `edges()`
  in `renderer.ts` gives them and `setEdges()` sets them. Use `edges()` for
  anything about time: playback, export, drawing an edge, whether two mixes
  touch. Two mixes cut apart inside a block both have that block in their
  `region`, so do not compare regions to tell whether mixes overlap.
- **Bump `ANALYSIS_VERSION`** in `loudness.ts` whenever a recording would
  measure differently. Stored analyses are keyed on it and are redone.
- **Saved sessions are read defensively.** `restore` in `renderer.ts` checks
  everything that comes back from disk. A new field on a mix needs a default
  there, or old sessions lose it. A breaking change needs a new `version`.
- **Never load a recording whole.** Files are hours long. Decode and encode
  as streams; keep per-block data, not per-sample data, in memory.
- **Tooltips are written as `title`.** `tooltip.ts` takes every `title` over,
  in markup and when set from code, and shows it sooner than the system
  would. Give an icon button an `aria-label` as well, and name its shortcut
  in the tooltip.
- **Clicks are not drags.** Pointer handlers ignore movement under
  `DRAG_START_PX`. New drag interactions should do the same.

## Checking changes to the app

`test/master.test.ts` covers the core. `test/window.test.ts` covers the
window: each test starts the real app, runs a function inside its window and
checks what comes back (`test/window-app.ts` does the starting). A change to
how the window behaves should come with a test there. They take about half a
minute. Setting `DJMASTER_SKIP_WINDOW_TESTS` leaves them out.

Both the tests and one-off checks rest on a mode of the app that these
environment variables switch on:

| Variable | Effect |
|---|---|
| `DJMASTER_SHOT=<file.png>` | After the first recording is drawn, save a picture of the window and quit |
| `DJMASTER_SHOT_SCRIPT=<js>` | Run this JavaScript in the window first; its result is printed as `[script] ...` |
| `DJMASTER_SHOT_MENU=<command>` | Send this menu command (`close`, `undo`, `redo`, `help`) to the window before the script runs |
| `DJMASTER_SHOT_DATA=<dir>` | Use this folder for saved sessions and analyses |
| `DJMASTER_SHOT_FOLDER=<dir>` | Answer the "Export all" folder dialog with this folder, the save dialog of a single export with the name it suggests in this folder, and Settings' folder choices with it |
| `DJMASTER_SHOT_IMAGE=<file>` | Answer the dialog for a template's picture (a logo, a photo) with this file |
| `DJMASTER_SHOT_VIDEO=<file>` | Answer the dialog for a template's video with this file |
| `DJMASTER_SHOT_LUT=<file>` | Answer the dialog for a template's .cube LUT with this file |
| `DJMASTER_SHOT_TRACKLIST=<file>` | Answer the dialog for a track list to import with this file |
| `DJMASTER_SHOT_TEMPLATE=<file>` | Answer the dialog for a template to import with this file. A template exported is saved into `DJMASTER_SHOT_FOLDER`, and one deleted is removed rather than moved to the Trash |
| `DJMASTER_SHOT_SCALE=2` | Draw at this many pixels per point, for sharp pictures |
| `DJMASTER_PROFILE=stages` | A video export prints where each frame's time went: the clips' frames, drawing, encoding, sending to ffmpeg. Works outside check mode too |
| `DJMASTER_PROFILE=layers` | As `stages`, and the time of each layer. Each layer is waited for on the graphics card, so drawing is slower while it is on |

```bash
DJMASTER_SHOT=/tmp/shot.png DJMASTER_SHOT_DATA=/tmp/djm-data \
DJMASTER_SHOT_SCRIPT="document.getElementById('stats').innerText" \
npx electron . some-recording.wav
```

In this mode the window draws off screen (so it works with the display
asleep), audio runs without an output device (nothing is heard), and the
app's data folder is separate from the user's. The script can click buttons
by id, dispatch mouse and keyboard events, and call `window.api` directly.

- **Always set `DJMASTER_SHOT_DATA`.** Without it the check uses a shared
  temporary folder and earlier runs leak into later ones.
- **The script runs once**, when the first recording is on screen, or when the
  window has come up empty because no recording was given and none is
  remembered.
- **A test's function is sent to the window as text.** It can use its
  arguments and what a web page has, but nothing from the test file around it.
- **Native dialogs cannot be scripted.** Set `DJMASTER_SHOT_FOLDER` and
  Export and Export all write into it.
- **Wait for changes to settle.** Edits are saved, and become undo steps,
  400 ms after the last change.
- **Run it with a time limit.** A script that throws or waits forever leaves
  the app running.

Say what was checked this way and what was not. Nobody has listened to the
output of an agent's change until a person does.

## Where things are stored

The app's data folder is `~/Library/Application Support/DJ Mix Master` on
macOS (`%APPDATA%\DJ Mix Master` on Windows, `~/.config/DJ Mix Master` on
Linux), the same for `npm start` and the packaged app.

| Inside it | What |
|---|---|
| `analyses/` | One measurement per recording, keyed on its fingerprint, modified time and `ANALYSIS_VERSION`; the 20 most recently used are kept |
| `sessions/` | The mixes, settings, hand adjustments and track markers per recording, stored twice: under its path, and under its fingerprint for when it has been moved |
| `last-settings.json` | Settings last in use, for recordings opened for the first time |
| `templates/` | The user's own video templates, one JSON file each, named by an id; a mix chooses one as `user:<id>` |
| `media/` | Videos up to 25 MB added to templates, and those in template files imported, named by their fingerprint; Settings can put them elsewhere |
| `preferences.json` | Choices that belong to the app rather than a recording: the folder for template videos and the LUT folder, chosen in Settings, and the view the window was left in (`mastering`, `video` or `editing`), to start in next time |
| `luts/` | The LUT folder, unless Settings chose another: .cube files the user puts there, offered wherever a LUT is chosen |
| `video-clips/` | Copies of videos made for the app's own use: ping-pong clips there and back, and playable copies of videos the window cannot play; the 20 most recently used are kept |
| `visual-features/` | What the visuals move to, per recording, worked out the first time it is asked for; the 20 most recently used are kept |
| `recordings/` | Lists that join a recording which came in several files, one per set of files (see below) |
| `last-recording.json` | The recording open last, which is opened again at the next start if it is still there |
| `recent-recordings.json` | The ten recordings opened most recently, for File > Open Recent |
| `updates.json` | Whether to check for updates, when it was last done, and what was found |

A recording's fingerprint (`fingerprint` in `main.ts`) is its size and a hash
of sixteen small samples of its content. It is the same after a move or a
rename and takes milliseconds whatever the size of the file.

Do not write test data there.

## Things worth knowing

- **The update check must stay out of the way.** It runs a few seconds after
  the window is up, gives up after five seconds, and fails silently. Only the
  installed app does it. To try it from the project, point
  `DJMASTER_UPDATE_FEED` at a file or address that returns
  `{"tag_name": "v9.9.9"}`; a `file://` address works. The app's promise that
  recordings never leave the computer is stated in the README and on the
  website; anything new that touches the network has to be reflected there.

- **ffmpeg is found** through `DJMASTER_FFMPEG`, then `PATH`, then the usual
  Homebrew folders. The packaged app sets the variable to its bundled copy.
- **Playback has two paths.** The audio element plays most formats straight
  from the file. Variable-bitrate MP3s (where it lands tens of seconds off)
  and formats it cannot play are decoded by ffmpeg from the playhead and
  streamed. `needsStreaming` in `playback.ts` decides A video's sound is played
  straight from an MP4 or WebM when it is in a codec the element knows;
  anything else is streamed.
- **A recording can be a video.** Its sound is read with `-map a:0`
  everywhere, so nothing that reads audio notices. `probe` also describes its
  picture (`VideoInfo`), which the window is given with the media address.
  "Original video" exports (`renderOriginalPicture` in `main.ts`) copy the
  picture of the mix's stretch with `-c copy` beside the exported sound;
  ffmpeg starts the copy on the keyframe before and writes an edit list, so
  players start on the right frame.
- **The window is served from `djm://app/`**, not `file://`, so that audio can
  pass through Web Audio. Only files listed in `APP_FILES` in `main.ts` are
  served; a new file in `dist/` has to be added there.
- **A video export has three steps** (`renderVideo` in `main.ts`): the sound
  is exported to a temporary AAC file as any export is; a hidden window
  (`exporter.ts`) draws each frame with the Video view's code and encodes it
  with WebCodecs, hardware first; the encoded picture is piped into ffmpeg,
  which packs it with the sound without encoding either again. Cancelling
  stops all three and removes the files. The hidden window must keep drawing
  unseen, so it is made with `backgroundThrottling: false`.
- **The window has two views,** Mastering and Video, switched by the bar at
  the bottom or Tab. The Video view (`video-view.ts`) replaces the curves with
  the picture and the levelling settings with the template's fields; the
  recording timeline and the transport stay. A mix's template and fields are
  kept with it (`Mix.visuals`), so they are saved and undone like any other
  setting. The view draws only while shown, and while the music is paused
  only when what it shows has changed (`#stale` in `video-view.ts`, set by
  edits and by pictures, fonts and the music's analysis coming in).
- **Templates come from two places.** The built-in ones (`visuals/templates.ts`)
  are read only; the user's own are files in the data folder, copied from a
  built-in one or imported, and known to the window only (`USER_TEMPLATES` in
  `video-frame.ts`). So a video export is handed the checked template itself,
  not its name. A template can carry pictures as data URLs in `assets`, named
  in an image setting as `asset:name`; `pictureOf` loads either kind.
  LUTs are kept in it the same way, packed in `luts` and named `lut:name`;
  those of the LUT folder are named `lutfolder:Film/Warm` and packed in only
  when the template is exported (`lutOf` loads every kind; see VISUALS.md).
  A `.djmtemplate` is a ZIP (`zip.ts`, entries stored, ZIP64 past 4 GB):
  `template.json`, and the videos of its `media` under `media/`, which the
  JSON names by those entries. On import they are taken out into the media
  folder under names of the app's own. A file that is JSON alone, from before
  videos, still opens.
  A `.djmtemplate` file opened from Finder or Explorer, named on the command
  line or dropped on the window is added (`openFiles` in `renderer.ts`); the
  installers register the extension (`build.fileAssociations` in
  `package.json`), on the Mac with a type of its own (`extendInfo`). The
  Linux AppImage cannot register one, so there it is dropped or imported.
  The editor saves a template as typed, half-written expressions and all; the
  picture shows it checked, with a setting that does not work yet at its last
  good value (`#lastGood` in `video-view.ts`).
- **Video layers are drawn from frames handed in.** The drawer asks
  `frame.video` for a clip's frame; the view answers from video elements,
  the export from ffmpeg (`video-sources.ts`). Drawing is synchronous, so
  the export gets each frame's clips ready first (`clipRequests`). Where a
  clip is comes from `clipTime` in `visuals/clip.ts` for both; anything
  about a clip's timing has to go through it. Videos are never packed into
  a template's JSON: `media` names files (see VISUALS.md).
- **A video has a shape**: landscape, vertical or square
  (`visuals/shape.ts`), kept in a video's choice of template, so it is saved
  and undone with it. The drawer measures sizes against the picture's short
  side (`#unit` in `draw.ts`), so a template works in any shape, and one made
  for landscape draws exactly as it did.
- **A recording can be several files.** Recorders split long recordings at
  2 or 4 GB. Chosen together, the parts are put in order (`parts.ts`: by
  their numbers, or else by when each was written) and listed in
  an ffmpeg concat file in the app's `recordings/` folder (`recordingOf` in
  `main.ts`). That list's path then stands for the recording everywhere a
  path does, and anything that reads audio goes through `inputArgs` and
  `probe` in `audio-io.ts`, which know how to read it. Such a recording is
  always played through the streamed path. Its fingerprint is made from its
  parts', so it is found again when the parts are moved.
  The analysis reads the parts one by one and counts each (`partFrames`);
  their lengths are then written into the list. Without them ffmpeg has to
  open every earlier part on each jump, and seeking slows down the further in
  it goes.
- **The waveform has two sources.** Views of the selected mix longer than 20
  seconds are drawn from the analysis, one value per block. Shorter ones are
  drawn from the wave itself: the main process decodes half a minute at a
  time on request (`fine-wave` in `main.ts`), and the window keeps the pieces
  it was given (`fineWave` in `renderer.ts`). Until a piece arrives the view
  falls back to blocks. This is for display only; nothing is levelled from it.
- **A channel fix is applied before anything else.** The check-up's fixes
  (`channels.ts`) are a mix of the two channels into two, applied first in
  export (`render` in `master.ts`) and in the player (four gains between a
  splitter and a merger). The analysis is not redone: the faults last the
  whole recording, so the levelling reads its loudness curves moved by one
  amount, worked out from the per-channel energies the check-up keeps
  (`measuredAsFixed` in `renderer.ts`). The fixes in use belong to the
  recording, are saved with its session and undone like any change.
- **Decoded MP3s can exceed full scale.** A clipped recording decodes with
  peaks several dB above 0 dBFS. The pipeline is floating point throughout
  and must stay that way.
- **Audio files are ignored by git**, as are `dist/` and `release/`. Test
  recordings in the project folder stay local.
- **Tests run on GitHub** for every push to `main` and every pull request
  (`.github/workflows/test.yml`), on Linux with the bundled ffmpeg. The
  window tests are switched off there, as that machine has no display. A second, trial
  job runs them on macOS and Windows without failing the workflow, and the
  release workflow leaves them out (`DJMASTER_SKIP_WINDOW_TESTS`) until that
  trial has shown them to be dependable there.
- **Releases are built by GitHub.** Pushing a tag such as `v0.2.0` runs
  `.github/workflows/release.yml`, which tests and packages on macOS,
  Windows and Linux and publishes the three installers. The version comes
  from the tag. None is signed for distribution. The Windows app has been
  used on a real machine; the Linux AppImage is only started once by the
  workflow, on a short recording, before it is published. Changes are
  developed and checked on macOS.

## Releasing a version

The version number lives in `package.json` (and `package-lock.json`, which
npm keeps in step). `npm version` updates both, commits, and creates the
matching tag; pushing the tag makes GitHub build and publish the installers.

```bash
node scripts/screenshot.mjs vp-test.wav        # a new picture for the website
node scripts/manual-pictures.mjs vp-test.wav   # new pictures for the manual; commit both
npm version minor -m "Release %s"   # or: patch, major, or an exact number
git push --follow-tags
```

- Always take new pictures first (see "The website" below), so that the
  website, the manual and the README show the window as it is in this
  release. Look at them, and commit them before running `npm version`.
- The working folder has to be clean first.
- `npm version` turns "Not released yet" in `CHANGELOG.md` into a heading for
  the new version (`scripts/release-changelog.mjs`), and stops if there is
  nothing under it.
- Use `minor` for new features and `patch` for fixes only.
- A tag made any other way still builds, with a warning that `package.json`
  disagrees. Fix it by setting the version there to match.

## The website

`site/` holds the website: a front page, a "What's new" page made from
the released part of `CHANGELOG.md`, and the manual. `scripts/build-site.mjs` fills in the
newest release's version and download links and writes the result to `_site/`;
`.github/workflows/site.yml` publishes that to GitHub Pages after every
release and whenever `site/` or `CHANGELOG.md` changes. Run the script locally to look at the
page (it needs the GitHub CLI signed in); `python3 -m http.server --directory _site`
serves it to a browser.

### The manual

The manual is Markdown in `site/manual/`, one page a file, in the order
`contents.json` gives. `scripts/site/manual.mjs` turns it into HTML (the
little Markdown it knows is listed at its top) and fills in directives from
the app's own code, so the manual cannot list what the app does not have:

| Directive | What it puts in | From |
|---|---|---|
| `{{shortcuts: Playback}}` | That section of the shortcuts, Mac and Windows side by side | `src/app/shortcuts.ts`, which the help sheet shows too |
| `{{layers}}`, `{{layer-list}}` | Every kind of layer, with its picture, description and settings | `LAYER_TYPES` in `template.ts` |
| `{{common-settings}}`, `{{style-settings}}` | The settings every layer has, the layer styles | `COMMON_PARAMS`, `STYLE_PARAMS` |
| `{{functions}}`, `{{music}}`, `{{text-variables}}` | The formula functions, the music values, the text variables | `FUNCTION_ABOUT`, `MUSIC_ABOUT`, `TEXT_ABOUT` |
| `{{all-shortcuts}}` | Every section of the shortcuts | `src/app/shortcuts.ts` |

Every layer kind, function, music value and text variable has its
description in the code beside it, typed so that one without a description
does not compile. `test/manual.test.ts` builds the manual and fails on a
page missing from the contents, a broken link, a kind of layer without its
picture, or a picture no page shows.

The pictures are taken by one command, with the same recording as the
website's: the window in each view, its dialogs and the editor's panels,
and every kind of layer drawn on its own (`scripts/manual-pictures.mjs`,
which also says what each layer is shown with, and
`scripts/manual-pictures/pictures.js`, the steps in the window). It uses
`window.api.checkPicture`, which in check mode saves a picture of the window
or a part of it.

The published manual describes the version people download: the website's
workflow builds it from the newest release's sources (`MANUAL_ROOT`), as
"What's new" leaves out what is not released yet. The front page links to it
once a release has one.

`site/screenshot.png` is also the picture in the README. It is taken with the
app's check mode at twice the size, by one command, from a recording of about
an hour (`vp-test.wav` among the local test recordings):

```bash
node scripts/screenshot.mjs vp-test.wav
```

The recording is shown as "Saturday night.wav", and the artist and track
names in the picture are made up, so nothing real ends up on the website.
`scripts/screenshot/setup.js` sets up what is shown; when the window gains
something worth showing, add it there. Look at the picture before committing
it: a script that went wrong still takes one.

## Working agreements

- Commit and push only when asked. Work goes to `main` unless a pull request
  is asked for.
- Write for a reader who was not there: comments say why the code is the way
  it is, and user-facing text avoids jargon.
- When a change makes something in the README or in this file untrue, fix
  the text in the same change.
- When a task in [TASKS.md](TASKS.md) is done, remove it from there.
- When a change is something a person using the app would notice, add a line
  for it under "Not released yet" in [CHANGELOG.md](CHANGELOG.md), written for
  them rather than for developers. The website's "What's new" page is made
  from that file.
- Such a change also goes in the manual (`site/manual/`), on the page it
  belongs to, in a sentence or two: what it is and how to use it, not every
  detail. A new kind of layer needs a description in `LAYER_TYPES` and a
  picture (add it to `LAYERS` in `scripts/manual-pictures.mjs`); a new
  function, music value or text variable, its description; a new shortcut
  goes in `src/app/shortcuts.ts`. A new picture of the window, or a changed
  one, comes from the pictures command.
