# What's new

The changes in each release of DJ Mix Master that someone using it would
notice. The website shows this list; changes that are not yet in a release
are under "Not released yet" and appear there once they are.

## Not released yet

- **Videos for YouTube.** A Video view, beside the mastering view, shows the
  selected mix as a video: a template that moves to the music (its beats, its
  spectrum, how much energy it has), showing the mix's artist, with a colour and
  a logo to fill in. Exporting as MP4 video makes the file, in 1080p. Three templates
  come with it, and fourteen fonts for the text, from clean to techno to
  neon; any font installed on the computer can be used as well.
- **An Artist field** beside the mix's name, for the exported file's tags and
  for the video.
- The time beside the transport now counts **into the mix, over its length**.
  The Start and End fields are gone: the mix's edges are set on the timeline,
  with I and O, or by splitting.

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
