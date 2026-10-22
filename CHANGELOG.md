# What's new

The changes in each release of DJ Mix Master that someone using it would
notice. The website shows this list; changes that are not yet in a release
are under "Not released yet" and appear there once they are.

## Not released yet

- **Double-click a slider to reset it.** Any slider, in the settings, the EQ,
  a video's fields or the template editor, goes back to its default when you
  double-click it. Undo brings back where it was.
- **A corrective EQ for each mix.** The settings have a new EQ section: a
  rumble filter, and bass, low mids, high mids and treble, each up or down by
  as much as 6 dB at a frequency you choose, with a drawing of what they add
  up to. It is for putting right how a mix was recorded, such as a turntable's
  phono stage that sounds dull or harsh, or a PA mixer's EQ, and it is heard
  before the levelling, which measures the mix as the EQ makes it sound. Each
  mix has its own, as one DJ of a night may have played records and the next
  CDJs; Copy to gives it to another mix, or to all of them. Behind the EQ's
  curve are this mix's average spectrum, the other mixes' and an analyser of
  what is playing, so a set that sounds unlike the rest of the night can be
  brought in line with it by eye as well as by ear. Recordings are
  analysed again once, the first time they are opened, which takes a little
  longer than before.
- **A light look.** Settings has a new Appearance choice, Dark or Light. The
  app stays dark unless you choose Light, whatever your system is set to; Light
  is for when the screen is hard to see in bright daylight. The curves, the
  meter and the video's strip change with it, and the choice is remembered.
- **A gear for Settings.** The Settings button showed what looked like a sun; it
  is now a gear.
- **In the Microsoft Store.** On Windows, DJ Mix Master can now be installed
  from the Microsoft Store, which updates it for you. The website links to it.
- **Calmer tooltips.** A tooltip now waits until the pointer rests on a
  control, rather than popping up on everything it passes over. Moving
  along a row of buttons still shows each one's at once.
- **Fifty-seven LUTs come with the app.** Every list of LUTs now offers a
  set of looks without your having to find any: forty-three imitations of
  real films (Kodak Portra and Tri-X, Fuji Velvia and Provia, Ilford HP5,
  Polaroid and more), made from Pat David's free film emulation collection,
  and fourteen looks of the app's own, such as Teal & Orange, Bleach Bypass,
  Neon Duotone and Night Blue. Step through them with ↑ and ↓ to see each on
  the picture. Your own LUT folder is still listed first.
- **A colour picker with opacity.** Every colour in the template editor and
  in a template's fields now opens the app's own colour picker: hue,
  saturation, brightness and opacity together, the hex code and red, green,
  blue and opacity as numbers, and an eyedropper. A gradient's stops open it
  too, so the see-through end of the noise layer's gradient can finally be
  changed.
- **`smooth()` takes the time it is given.** In a template's settings,
  `smooth(value, rise, fall)` rose and fell twice as fast as its seconds
  said. It now takes those seconds, so a template that uses it moves more
  slowly than before; halve its rise and fall to get the old feel back.
- **Keyed clips are fast.** A video clip with its green or black keyed out
  made a video export several times slower and could make the preview
  stutter. The key is now worked out by the graphics card, and such a clip
  costs about what it does without one. The key now looks at the clip's
  own colours, before its brightness and saturation are changed, and its
  edges are smoother on a clip shown larger than it was filmed.
- **Videos with clips export faster.** A template's video clips, and a
  filmed set's own picture, are now decoded by the computer's video
  decoder, on the graphics card where there is one, rather than frame by
  frame by ffmpeg. On an M1, an export showing a 1080p video takes less
  than half as long as before, and one showing a 4K video, which took
  longer than the mix itself, is about seven times faster. Clips in H.264,
  HEVC, VP9 and AV1 are decoded this way; others, such as ProRes, as
  before. A clip that does not say which colours it is in now keeps the
  colours other players show it in.
- **Grids and mosaics are fast at any cell size.** A grid of checks, a
  honeycomb, hex cells or dots, and the mosaic effect, are now drawn by the
  graphics card, and a perspective floor no longer draws its far distance
  line by line. Small hex cells took seconds a frame and now take a few
  milliseconds, the same as large ones; on an M1 every grid and mosaic
  draws a 1080p frame in a few milliseconds. The smallest dots and
  honeycombs, which could fail to show at all, now show. A mosaic's cells
  each take the exact average of the picture under them, which can change
  the shade of a cell beside a sharp edge a little.

## 0.11.0 — 20 October 2026

- **The manual comes with the app.** Help → User Manual opens the copy the
  app carries, which describes exactly the version you have and works
  without an internet connection.
- **Templates from this version need this version.** Templates made before
  are brought over by themselves when opened. But a template saved or
  exported with this version can no longer be opened by an older one, which
  says it was made for a newer version: whoever you share one with needs
  this version too.
- **Groups move.** A group can be moved, turned and sized as one, in its
  settings or by dragging its outline on the picture, and its place can
  follow the music. Layers in a turned group are still dragged the way the
  pointer goes.
- **Masks.** Any layer, or a group, can be used as a mask, by its shape or
  by its brightness: it is not drawn, but decides where the layers above it
  in its group show. A shape makes a mask of any outline, text shows a video
  through its letters, a gradient a soft wipe, noise a dissolve through
  clouds. A mask can be inverted, grown or shrunk and feathered, and an
  effect above one changes only what it shows.
- **A Grid layer.** Lines, a checkerboard, a honeycomb of lines or of
  coloured cells, dots or stripes, over the whole picture, turned and
  scrolling as you like; or a floor of lines running to the horizon and
  rolling towards you, as in a synthwave video.
- **A Mosaic layer.** Breaks the picture beneath into cells, each the
  colour under it: squares (pixels), hexagons, circles, halftone dots that
  grow with the brightness, or triangles, with an optional gap between
  them. With fewer colours, it looks like an old computer's.
- **Gradients of up to five colours, set on a bar.** The Gradient, Noise,
  Spectrum and Shape layers take a gradient of up to five stops, set on a
  bar in the editor as in a photo editor: drag a stop to move it, click the
  bar to add one, drag one away to take it out. Each stop's colour and place
  can also follow the music. Colours blend evenly, or round the colour wheel
  through the hues between them, as the spectrum always did. Templates made
  before are brought over by themselves; gradients' middles may look a
  little brighter and richer.
- **A Gradient map layer.** Recolours everything beneath it by brightness,
  from shadows to highlights, through up to five colours: a duotone, or any
  palette. The colours can slide along it, or each follow the music.
- **A Displace layer.** Moves the picture beneath about: wobbling with
  noise, waving like a flag, rippling out from a point, swirled round it, or
  bulged and pinched as through a lens, with an optional colour split. Its
  amount can follow the music, so the picture can shake on every kick.
  Near the edges, the picture is mirrored to fill in what moves in; or Hold
  the edges keeps the frame's edges still and eases the movement in from
  them.
- **A Noise layer.** Patterns that slowly change and drift: clouds,
  turbulence, ridges, cells, cell edges, marble and plasma, coloured by a
  gradient. Warp bends them into smoke and liquid; Coverage cuts them down
  to patches, such as scattered clouds; and a see-through colour lets what
  is beneath show, so clouds can float over a video.
- **A White balance layer.** Warms or cools the colours beneath it and moves
  them towards green or magenta, to correct a photo or video taken under the
  wrong light. Put it in a group with a picture to change only that picture.
- **Amounts go from 0 to 1.** Opacities, a tint's amount, brightness,
  saturation, a glow's strength and the other settings that say how much,
  rather than where or how big, are now fractions instead of percentages: an
  opacity of 0.5 is half seen, a brightness of 1 leaves the picture as it is.
  A music value can be put straight into one, such as an opacity of `level`.
  Templates made before are brought over by themselves and look the same.
- **A Shape layer.** Templates can draw rectangles, ellipses, rings,
  triangles, diamonds, polygons, stars, crosses, arrows and hearts, with
  rounded corners, a fill of one colour or a gradient, and a solid, dashed or
  dotted outline. Only part of a shape need be drawn, filling across, up or
  round, with the rest in a colour of its own: set Drawn to `progress` for
  a progress bar or a ring that fills over the mix.
- **`trackProgress` in formulas.** How far through the track playing, from 0
  to 1, starting again at each track marker: a progress bar per track.
- **ffmpeg's licence comes with the Windows app.** The Windows installer
  left out the licence of the ffmpeg it carries; it is now beside it, as on
  the Mac and Linux.
- **A change made just before quitting is kept.** The app now finishes
  saving before it quits, and saves each file whole, so a change made a
  moment before closing the window is there next time, and no saved file is
  left half written.

## 0.10.0 — 18 October 2026

- **A manual.** Every part of the app explained, with pictures, on the
  website: from installing and marking mixes to every kind of layer and
  every function a template's formulas can use. Open it from Help → User
  Manual, or from the shortcuts sheet.
- **Video layers in templates.** A template can show a video clip: a loop
  behind the music, a clip of the club. It loops, plays once and holds its
  last frame or disappears, at a speed of your choosing, and can use part of
  the clip. A video can also be a field, chosen per mix. Small videos (up to
  25 MB) are copied into the app's own folder when added, so they stay with
  the template; larger ones are used where they are.
- **The recording's own picture in a template.** For a set that was filmed,
  a video layer can show the recording itself, in step with the music, and
  the new "Original video" template does just that, with the artist and the
  track playing over it. A video opens with that template chosen. If the picture runs ahead of the sound or behind
  it, "Picture delay" in the Video view puts them in step, for the view and
  every video export.
- **Videos open as recordings.** Open or drop an MP4, MOV, MKV or WebM of
  a set and master its sound as you would a recording.
- **Export with the original picture.** For a video, the export dialog
  offers "Original video": the video's own picture with the mastered sound.
  The picture is copied rather than encoded again, so it is quick and loses
  nothing, and it starts on the very frame the mix does.
- **Vertical and square videos.** Three small buttons beside the template
  in the Video view choose the shape: landscape for YouTube, vertical for
  phones, square for feeds. Every template works in each, its title and its
  shapes keeping their size across the picture.
- **Layer styles: drop shadow, stroke, outer glow, inner shadow and inner
  glow.** Any layer that draws, or a group, can have them, as in an image
  editor: open one in its settings and switch it on. A dot beside the
  heading shows which are on. Like every setting, they can follow the
  music.
- **Transform layer.** Moves, turns, sizes and flips everything beneath it
  as one, as Resolve's Transform does. Choose what shows past the edges:
  nothing, the picture repeated, mirrored without seams, or its edges drawn
  out. Drag its outline on the picture to move and size it.
- **Trails.** A trails layer leaves what moves beneath it behind, fading
  over as long as you choose: as an echo, or only the bright parts (light
  trails on a dark picture) or the dark ones. Zoom and turn the trail to
  make it stream outwards or spiral. Trails show while the music plays; when
  paused, the picture is shown as it is.
- **LUTs in video templates.** A LUT layer gives everything beneath it a
  look from a .cube file, as made in Resolve, Premiere and the like. The
  file is kept inside the template, so it travels when the template is
  shared. A LUT field lets whoever uses the template choose a look of their
  own for each mix. Put your collection of LUTs in the LUT folder (shown, or
  chosen, in Settings) and they are all in the list, ready to pick. Go up and down the list with the
  arrow keys to see each look on the picture at once. A template exported
  to share takes the LUTs it uses from the folder along with it.
- **Solid colour and vignette layers.** A solid colour fills the picture in
  one colour, a quick background or a tint with a blend. A vignette darkens
  the edges towards a colour of your choice, as an oval of the picture's
  shape or a circle; move its centre on the picture.
- **Clips that keep time.** A video layer can start its clip again on every
  beat, every 2, 4, 8 or 16 beats, or at each track. A clip made on a green
  screen or on black can have that keyed out, with a tolerance and a softness.
- **Ping-pong clips**, up to a minute long, play forwards and then
  backwards. Clips in formats the window cannot play itself, such as
  ProRes, are shown from a copy the app makes the first time.
- **Template files carry their videos.** A `.djmtemplate` is now a ZIP
  holding the template and the videos it shows, so it can be shared whole.
  Template files from earlier versions still open; earlier versions cannot
  open the new ones.
- **A folder for template videos.** Settings chooses where small videos added to templates, and those in template files
  imported, are kept. A video that has moved is found again, or can be
  located, and the template's other videos in the same folder are found with
  it.
- **Try blends with the arrow keys.** A layer's blend is chosen from a list
  like the LUTs': press ↑ or ↓ on it, or go through the open list, and the
  picture shows each blend as you reach it. The blends are sorted by what
  they do (lighten, darken, contrast and so on), and you can type to find one.
- **Shift+⌘N adds a layer** while you edit a template (Shift+Ctrl+N on
  Windows and Linux): the list of layers opens with its search ready, so
  type a few letters and press Return.
- **Fields are dragged into order.** In the template editor's Fields tab,
  drag a field's card up or down to change the order fields are filled in.
  Click a card and press Delete to remove it. The name and the kind of a
  field now sit side by side at the same size.
- **"Moves with…" follows a formula you type.** With its panel open, a
  formula typed into the setting shows in it at once.
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
- **One-click fixes for the channels.** When the check-up finds one channel
  quieter than the other, one silent, or one out of phase, its report offers
  to put it right: evened out, filled from the other side, or flipped. You
  hear it at once, the levelling works from the fixed sound, and every export
  carries it.
- **Settings.** The choices that belong to the app, rather than to a
  recording, are now in one place, each with a word on what it does: the
  folder for template videos, the LUT folder, and the check for updates.
  Open it with the gear at the top of the window, or ⌘, (Ctrl+, on Windows
  and Linux). They have left the File and Help menus.
- **The app opens in the view you left.** Mastering, Video, or editing a
  template: the next time the app starts with a recording, it is where you
  were.
- **Templates stay out of your recent files.** A template opened from Finder
  or Explorer no longer shows up among the recordings in the Dock menu or the
  taskbar's jump list.
- **Typing in the Video view while paused.** A name typed into a text
  field now appears in full at once. Before, the last letter stayed missing
  until the music played.
- **Searching for a layer no longer sets off shortcuts.** Typing in the
  editor's layer search, or in its other boxes, no longer switches bypass on
  or starts playback.
- **Messages stay while the music is listened to.** In the Video view, a
  message in the status line, such as a template added, no longer gives way
  to the count of the first listening; the count is over the picture.

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
