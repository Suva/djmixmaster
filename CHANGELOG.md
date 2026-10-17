# What's new

The changes in each release of DJ Mix Master that someone using it would
notice. The website shows this list; changes that are not yet in a release
are under "Not released yet" and appear there once they are.

## Not released yet

- **A fixed gain instead of levelling.** The switch at the top of the
  settings, "Even out tracks" or "Fixed gain", turns the whole mix up or down
  by one amount and leaves the tracks as they are. Loudness still chooses how
  much: as loud as fits, a preset, or a gain in dB set by hand. Hand
  adjustments, fades and the limiter work as before. On the command line:
  `--no-levelling` and `--gain`.
- **Bypass is one button, and hard to miss.** The Original/Levelled switch is
  now a bypass button, left of the play controls. While it is on, it pulses,
  and a note above the settings says that you are hearing the recording as it
  is, with a button to turn it off. Before, the A key could switch to the original unnoticed, and
  the settings then seemed to do nothing.

- **Videos open as recordings.** Open or drop an MP4, MOV, MKV or WebM of
  a set and master its sound as you would a recording.
- **Export with the original picture.** For a video, the export dialog
  offers "Original video": the video's own picture with the mastered sound.
  The picture is copied rather than encoded again, so it is quick and loses
  nothing, and it starts on the very frame the mix does.
- **Video layers in templates.** A template can show a video clip: a loop
  behind the music, a clip of the club. It loops, plays once and holds its
  last frame or disappears, at a speed of your choosing, and can use part of
  the clip. A video can also be a field, chosen per mix. Small videos (up to
  25 MB) are copied into the app's own folder when added, so they stay with
  the template; larger ones are used where they are.

## 0.9.1 — 16 October 2026

- **WAV exports upload to SoundCloud.** A WAV under 4 GB, which is nearly
  every one, is now written as a plain WAV. Before, it carried a placeholder
  that lets a WAV grow past 4 GB, which is allowed but which SoundCloud
  refused, failing to process the upload. Only a WAV that may be larger keeps
  it.

## 0.9.0 — 16 October 2026

- **Make your own video templates.** A template editor opens beside the
  picture, and every change shows straight away:
  - Layers, front-most at the top, are added, hidden, reordered, renamed,
    duplicated (⌘J) and deleted, and picked, moved and resized on the picture
    itself. Several can be selected at once (⌘-click, Shift-click).
  - **Groups** (⌘G) fade, blend or hide layers together, or keep an effect to
    just them.
  - Each layer's colours, sizes, texts, fonts and pictures are set beside the
    list; blend and opacity sit above it, as in an image editor. Any number box
    can be dragged sideways to change it.
  - Any number or colour can follow the music: by choosing what it moves with
    (the bass, the beat, a slow wave) and how much, or with an expression,
    checked as you type.
  - The fields a template asks for (a colour, a logo, a font) are added,
    renamed and given defaults in a tab of their own, and an About tab says
    who made the template and what it is.
- **Share templates** as files, with their pictures packed inside: export
  from the editor or the ⋯ beside the list of templates, and add one by
  importing it, dropping it on the window, or double-clicking it in Finder or
  Explorer. The templates that come with the app stay as they are; editing one
  makes a copy that is yours.
- **New effects:** a colour split, straight or growing towards the edges like
  a lens; a digital glitch; a kaleidoscope; brightness and contrast; hue and
  saturation; and blur.
- **More ways to blend a layer** into what is beneath it: colour dodge and
  burn, linear burn, lighten and darken, soft and hard light, exclusion, and
  hue, saturation, colour and luminosity.
- **The video's picture stands still while the music is paused**, and is drawn
  again only when something changes, sparing the computer.
- Exporting a single mix with "Export all" no longer says "1 mixes".

## 0.8.0 — 15 October 2026

- **Videos for YouTube.** A Video view, beside the mastering view, shows the
  selected mix as a video: a template that moves to the music (its beats, its
  spectrum, how much energy it has), showing the mix's artist, with a colour and
  a logo to fill in. It fades in and out from black with the mix's fades.
  Exporting as MP4 video makes the file, in 1080p. Four templates
  come with it, one of them over a photo of your own, and fourteen fonts for the text, from clean to techno to
  neon; any font installed on the computer can be used as well.
- **The tracks in a mix.** M marks where a track starts; markers are named and
  dragged on the mix timeline. A track list exported from DJ software (such as
  a rekordbox history) can be imported and spread over the mix to drag into
  place. The list copies ready for a YouTube description, the tracks become
  chapters in MP3, AAC and MP4 files, and the video shows what is playing.
- **An Artist field** beside the mix's name, for the exported file's tags and
  for the video.
- The time beside the transport now counts **into the mix, over its length**.
  The Start and End fields are gone: the mix's edges are set on the timeline,
  with I and O, or by splitting.
- **Quiet recordings are easier to see.** The recording's timeline, and the
  mix's strip under the video, draw a quietly recorded wave as large as a loud
  one. The mix's own waveform still shows the true level, against the
  levelled result.

## 0.7.0 — 14 October 2026

- **A Linux version**, as an AppImage that runs on most 64-bit distributions.
- **Recordings that come in several files** open as one. Recorders often
  split a long recording at 2 or 4 GB; select all the parts, or drop them on
  the window together. Parts the recorder numbered are joined in the order of
  their numbers, others in the order they were written. The recording shows
  as one entry, named like "REC00\*.WAV (3 files)".

## 0.6.0 — 14 October 2026

- **Mark a mix by ear.** I and O put the start and the end of the mix at the
  playhead, and Cmd/Ctrl+E splits it there. Buttons in the mix row do the same.
- **Cuts to the millisecond.** Edges and splits land exactly on the playhead,
  in the app and in the exported files.
- **The real waveform close up.** Zoom in down to half a second across the
  window; from 20 seconds inwards the waveform is drawn from the sound itself,
  so single beats and bass notes can be seen.
- **Run through a mix at speed** with J, K and L: L plays forwards and each
  press doubles the speed, J runs backwards (silently), K stops.
- Double-click a free part of the recording to fill it with a new mix.
- Deleting the only mix sets it back to the whole recording.
- Marking and cutting keep the zoom where it is. Playback stops at the end of
  a mix; pressing play there starts the mix over.
- A recording that has been moved or renamed keeps its mixes, and is not
  analysed again.
- Long mixes respond about twice as fast to a change of setting.

## 0.5.0 — 14 October 2026

- **A level meter** beside the curves: left and right with the peak held, a
  column that lights when the limiter works, a lamp for clipping in the
  recording, and the loudness, gain and bass change at the playhead.
- **Starts where you left off,** with the recording that was open last.
  File → Open Recent and the start screen list the recordings you used lately;
  File → Close Recording puts one away.
- **The check-up also finds mains hum** (50 or 60 Hz), rumble and a DC offset.
- A row of transport buttons, quicker tooltips, and a sheet of all gestures
  and shortcuts (the ? button, or ? or F1).
- Smaller icon buttons for undo, redo and the mix tools. Backspace deletes the
  selected mix, or the hand adjustment under the pointer.
- Peaks the limiter holds down are shown in amber; red is kept for clipping.
- The legends on the curves stay faint until pointed at.

## 0.4.0 — 12 October 2026

- **A check-up of the recording** when it is opened: clipping, a missing,
  weak or out-of-phase channel, a recording that is really mono, possible
  dropouts, a very quiet recording, and a source that was compressed.
- **Lets you know when a newer version is out.** It looks at most once a day,
  gives up quickly without an internet connection, and can be switched off in
  the Help menu. Nothing about your recordings leaves the computer.
- "Apply to all mixes" gives every mix in a recording the same settings.

## 0.3.0 — 12 October 2026

- **Fades** at the start and end of a mix: drag a corner of the waveform
  inwards.
- **Loudness presets** for where a mix is going: Loud (-9 LUFS) for places
  that play files as they are, Streaming (-14), Podcast or radio show (-16)
  and Broadcast (-23).
- DJ Mix Master is now free software, under the GPL, with a website.

## 0.2.0 — 11 October 2026

- **An export dialog:** WAV, FLAC, MP3 or AAC, with the bit depth, bitrate and
  sample rate. 16-bit files are dithered.
- Exports carry a title, artist, album and track number, and MP3 and AAC
  files get a little room so that they do not clip when played.
- Hand adjustments can move the bass alone.

## 0.1.0 — 11 October 2026

The first release.

- **Evens out the loudness between the tracks** of a recorded DJ mix: louder
  tracks come down, quieter ones come up, and breakdowns keep their dip.
- **Bass correction** levels the kick and bass between tracks separately from
  everything above them.
- **Made for whole nights:** mark several mixes in one recording, zoom and
  scroll through hours of it, and split it at the silences between sets.
- **As loud as fits:** the automatic level stays clear of the limiter, even on
  a recording that was made too hot.
- **Hear it first:** the preview uses the same true-peak limiter as the
  export, and switches between the original and the levelled sound.
- Raise or lower any stretch by hand.
- Your mixes, settings and adjustments are remembered per recording, with
  undo and redo.
- Exports are named after their mix; analysing and exporting can be cancelled.
- Installers for Macs with Apple Silicon and for Windows.
