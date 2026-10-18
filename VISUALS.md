# Visuals for video exports — layer types

A design sketch, not built. The idea: export a mix as a video for YouTube and
the like, drawn from a template of layers. A template exposes a few fields
("Artist name", "Colour 1", "Logo") for the DJ to fill in, and any number
parameter can follow the music, through knobs (base value plus modulation
slots) or an expression such as `1 + 0.5 * smooth(bass, 0.01, 0.25)`.

Layers marked ★ are the smallest set that could make good-looking templates
for a first version. Positions and sizes are in percent of the frame, so a
template works at any size; times are in seconds unless they say beats.

## How it fits the app

- **A view of its own.** The main window gets a second view, Video, beside
  Mastering: the template, its fields and a live picture of the selected mix,
  following the playhead. See "The Video view, as built" below.
- **Nothing changes until it is used.** Without the Video view ever being
  used, exporting works exactly as it does now. Visuals come into play only
  when a video format (MP4) is chosen in the export dialog; that format takes
  the template and fields set for the mix, or a default template if none was.
- **What the picture follows is worked out ahead, not listened to live.** The
  preview reads the same per-frame values the export does, so what is seen
  while playing is what the video will show.
- **Opening a recording stays as quick as now.** The values the visuals need
  (a spectrum per video frame, beats, tempo) come from a second pass over the
  recording that runs in the background, at low priority, only once the
  Video view is shown or a video is exported. It is stored with the
  analysis, so it is done once per recording. Until it has reached the part
  being played, the preview moves without the music. It must never hold up an
  audio export, which runs as before.

## The whole video

| Parameter | Kind | Notes |
|---|---|---|
| Size | choice | 1920×1080, 1080×1920 (Shorts, Reels), 1080×1080, 3840×2160 |
| Frame rate | choice | 30 or 60 |
| Background colour | colour | Behind every layer |
| Safe area | switch | Guides in the editor for where platforms put their buttons |

## Parameters every layer has

| Parameter | Kind | Notes |
|---|---|---|
| Visible | switch | |
| Opacity | number 0–100% | |
| Blend | choice | Normal, add, screen, multiply, overlay, difference |
| Position | x, y | Of the layer's anchor |
| Anchor | choice | Centre, a corner or an edge |
| Scale | number | 100% is the layer's own size |
| Rotation | number, degrees | |
| Shown from, until | time or marker | Start of the mix, end, a marker, or a time |
| Fade in, fade out | seconds | When it appears and disappears |

## Backgrounds

**★ Gradient** — also a single colour, with one stop
- Colours: two to four, each with its position along the gradient
- Kind: linear, radial, conic
- Angle; centre (for radial and conic)
- Drift: rotation speed, hue shift speed

**★ Glitter / particles**
- Count; size, smallest and largest
- Colours: one to three, picked at random per particle
- Shape: dot, soft dot, star, sparkle, or an image
- Speed; direction and spread; gravity; turbulence
- Lifetime; twinkle rate and depth
- Area they start from: the whole frame, an edge, a point
- Burst on beat: how many extra per beat

**Noise field** — slow clouds, plasma, smoke
- Colours: two or three, mapped across the noise
- Scale; detail (layers of noise); contrast
- Speed; warp (how much the noise bends itself)

**Shapes** — rings, polygons, lines, tunnels
- Shape: circle, ring, rectangle, polygon (number of sides), line
- Size; stroke width; fill colour; stroke colour
- Copies: count, spacing, scale and rotation per copy (a tunnel is a ring
  repeated smaller and turned a little each time)
- Rotation speed

## Pictures and words

**★ Image** — a logo, a photo, a flyer
- Image file (PNG with transparency, JPEG)
- Fit: contain, cover, stretch, natural size
- Size; corner rounding
- Shadow: colour, blur, offset
- Tint colour and amount; brightness; saturation
- Slow drift, as a background photo: zoom amount and speed, pan direction

**★ Video** — a loop behind the music, a clip of the club
- Video file (MP4, MOV, MKV, WebM), a video field, or the recording's own
  picture when the recording is a video
- Plays: loop, ping-pong, once then hold its last frame, once then hide
- Speed (a plain number: it cannot follow the music, see below)
- Starts again: never, each track, each beat, every 2, 4, 8 or 16 beats
- The part used: from, until, and how far into it to start
- Everything an image has: fit, size, rounding, shadow, tint, brightness,
  saturation
- Key out: a colour (a green screen) or what is dark (a clip made on black),
  with a tolerance and a softness

**★ Text**
- Text, with variables written between percent signs, such as
  `%currentTrack%` or `%mixName%` (see "Variables in text" below), so one text
  layer can show a name, the track playing or the time
- Font; weight; size; colour
- Alignment; letter spacing; line height; largest width before wrapping
- Upper case, lower case, as written
- Outline: width and colour
- Shadow or glow: colour, blur, offset
- Box behind it: colour, padding, corner rounding

- When what it says changes (a new track, say): cut, fade, slide or
  typewriter, and how long the change takes

A progress bar is a rectangle from Shapes whose width follows `progress`.

## Showing the sound

**★ Spectrum**
- Bars: count; lowest and highest frequency; spacing on a musical scale
- Bar width and gap; height; rounded ends
- Colours: one, a gradient along the bars, or by how high each bar is
- Mirrored (up and down from a centre line); reflection below
- Rise and fall times
- Peak markers: on or off, how long they hold, how fast they fall
- Form: straight, or circular with its radius, start angle and arc

**★ Waveform**
- Style: line, filled, mirrored
- How much time it shows, from a few milliseconds (an oscilloscope) to
  several seconds (a scrolling wave)
- Line width; colour; height
- Form: straight or circular, with its radius

**Level bars** — a pair of meters, VU style
- Orientation; size; segments or smooth
- Colours for low, near the top and over

## Effects

Effect layers change what is beneath them rather than drawing their own.

**★ Glow** — threshold, strength, radius, colour tint
**Blur** — amount
**Vignette** — strength, softness, colour
**Colour** — hue shift, saturation, contrast, brightness
**Grain** — amount, size, speed
**Camera shake** — amount, speed (made for following `beat`)
**Zoom pulse** — amount, centre (also made for `beat`)
**Trails** — how slowly the past frames fade, zoom and turn per frame
**Split colour** — how far red and blue are pushed apart, and in which direction
**Kaleidoscope** — number of segments, rotation, zoom
**LUT** — a look from a colourist's .cube file, kept in the template or chosen through a field
**Pixelate** — block size
**Scan lines** — spacing, strength, roll speed

## Groups

**Group** — holds other layers; its position, scale, rotation, opacity and
timing apply to all of them. Can also act as a mask: what it draws decides
where the layer just above it shows.

## Variables in text

Text fields take variables between percent signs; `%%` is a percent sign
itself. A name the app does not know is shown as written, and the editor
underlines it. Number values in text (tempo, say) are shown rounded.

| Variable | What it shows |
|---|---|
| `%mixName%` | The mix's name, as on its tab |
| `%mixNumber%`, `%mixCount%` | Which mix of the recording this is, and how many there are |
| `%mixLength%` | The mix's length, as 1:02:49 |
| `%elapsed%`, `%remaining%` | Time into the mix and left of it, counting as it plays |
| `%artist%`, `%title%`, `%album%` | The tags set in the export dialog |
| `%recordingName%` | The recording's file name, without its extension |
| `%date%` | The day of the export, written out |
| `%currentTrack%` | The track playing, as "Artist – Title", from markers on the mix |
| `%currentArtist%`, `%currentTitle%` | Its two halves |
| `%trackNumber%`, `%trackCount%` | Which track it is, and how many have markers |
| `%nextTrack%` | The track after it |
| `%tempo%` | Beats per minute at that moment |
| `%anyField%` | A field the template itself asks for, under the name its designer gave it |

The track variables come from the mix's track markers (see the README, "The
tracks in a mix"). Before the first marker it is the first track that plays.
Without markers, or for a track not named, they are empty, and a layer can be
set to hide itself when its text is.

Number parameters use the same names without the percent signs, as in an
expression: `tempo`, `progress`.

## What the music gives

Values any number parameter can follow, through a knob or an expression:

| Name | What it is |
|---|---|
| `bass`, `lowMids`, `mids`, `highs` | Loudness in each band, 0 to 1, levelled across the mix |
| `level` | Overall loudness, 0 to 1 |
| `beat` | 1 on each kick, falling to 0 before the next |
| `beatPhase` | 0 to 1 from one beat to the next, for smooth motion in time |
| `barPhase` | 0 to 1 across four beats |
| `tempo` | Beats per minute |
| `energy` | Slow-moving: high in a drop, low in a breakdown |
| `trackChange` | 1 when a new track's marker passes, falling to 0 |
| `time`, `progress` | Seconds into the mix, and 0 to 1 across it |
| `hasVideo` | 1 when the recording is a video with a picture of its own, 0 when not |

## Fields a template can ask for

| Kind | Example |
|---|---|
| Text | Artist name, title, venue, date |
| Colour | Colour 1, colour 2 |
| Image | Logo, background photo |
| Video | A loop for the background |
| Number | Particle amount, as a slider with the range the designer allows |
| Choice | Layout: logo left or centred |
| Font | From the fonts the app carries |
| LUT | A .cube file for the look |

## What the first try of the export showed

`spikes/video-export/` holds a proof of the pipeline, run outside the app:
a hidden window draws each frame with WebGL, the browser's own encoder
(WebCodecs) turns it into H.264, and the stream is piped into ffmpeg, which
packs it with the audio into an MP4 without encoding the picture again. The
picture was a full-screen shader (gradient, rings, 64 bars), about what a
modest template would cost. On an M1, at 1920×1080 and 30 frames a second:

| | Speed | Time for a 2-hour mix |
|---|---|---|
| Hardware encoder | 206 frames a second, 6.9 times real time | about 18 minutes |
| Software encoder (OpenH264, built into Electron) | 111 frames a second, 3.7 times | about 32 minutes |

- A whole hour (113,070 frames) came out with picture and sound both exactly
  3769.000 seconds long, so they stay in step.
- Memory stayed flat throughout: 29 MB in the window, 143 MB in the main
  process. Nothing but the output file is written.
- At 8 Mbit/s an hour is 3.9 GB. Calm visuals would look as good at half that.
- A raw H.264 stream carries no timing. ffmpeg has to be given the frame rate
  with `-r` before the input; `-framerate`, the option documented for raw
  input, is ignored when the stream is copied, and the video comes out a
  thousand times too fast.
- Not tried yet: Windows and Linux, where the hardware encoder may not be
  offered and the software one would take over, and heavier templates.

## What the music gives, as built

`src/features.ts` works it out; `listen` in `master.ts` runs it over a
recording, and the main process does so in a worker of its own, with the
decoder at low priority, the first time the window asks (`api.features`).
The result is stored in `visual-features/`, beside the analyses.

- **Spectrum:** 24 bands from 30 Hz to 16 kHz, evenly spaced in pitch, 30
  times a second, each a byte from -72 dB to full scale. A video at 60 frames
  a second interpolates between them.
- **Level:** the same, one value 30 times a second.
- **Beats:** the time of each beat to the millisecond, and how strong the
  kick on it is. Found from how suddenly the low end (below 120 Hz) gets
  louder, followed 200 times a second: first the tempo of each stretch, then
  the row of beats that best fits the kicks at that tempo (after Ellis, "Beat
  tracking by dynamic programming", 2007). Stretches with no clear kick take
  the tempo around them, so the beats run on through a breakdown, with low
  strength.
- **On the synthetic mix** (a kick every 0.48 s, three tracks with
  breakdowns) every beat where the kick plays lands on it, and the tempo holds
  at 125 through the breakdowns. Inside a breakdown the row can slip half a
  beat until the kick returns.
- **On real recordings:** the one-hour test recording comes out at a steady
  160–164 BPM, the eight-hour one at 150 BPM in the middle. Nobody has yet
  checked those against the music by ear.
- **Cost:** the eight-hour MP3 takes 75 seconds in the background (about as
  long as its analysis), and 23 MB is stored. A one-hour WAV takes about 9
  seconds.

`bass`, `mids` and the rest, `tempo`, `beatPhase` and `energy` are not
stored: they are worked out from these when a frame is drawn.

## Templates and expressions, as built

`src/visuals/template.ts` defines the format; `src/visuals/expression.ts`
the expression language; `src/visuals/music.ts` turns the stored music
values into the ones a frame gets. None draws anything yet.

- **A template is JSON:** `format`, `name`, `fields` (each with a `key`, a
  label, a kind and a default) and `layers` (each a `type` and its
  `params`). The layer types so far are the ★ ones above: gradient,
  particles, image, text, spectrum, waveform and glow; and effects that
  change the picture beneath them: colour split (`split`: straight, or from
  the centre as a lens does), glitch (slices torn sideways with the colours
  split, worked out from the time alone so the export matches the preview),
  brightness and contrast (`adjust`), hue and saturation (`hue`), blur, and
  a kaleidoscope (a slice round the layer's position repeated all the way
  round, filled from the picture mirrored past its edges so that no corner is
  left black), and a LUT (see "LUTs, as built" below).
- **Groups** are layers of the kind `group` whose `size` says how many of the
  layers after it are theirs, so that the list stays flat and everything that
  knows a layer by its place in it (outlines on the picture, what a layer
  remembers between frames, the editor's selection) works as before
  (`layer-tree.ts`). A group's layers are drawn on a clear canvas of its own,
  which effects in it then take as the picture, and laid on the picture with
  the group's opacity and blend. Effects start from clear rather than black,
  so that inside a group what is not drawn stays see-through; and at the
  normal blend an effect's result takes the place of the picture beneath
  (`#putBack`), rather than being laid over it, where the layers it was made
  from would show through what is see-through in it.
- **Blends** are the canvas's own, by their names in an image editor (add is
  linear dodge), except linear burn, which the canvas has not: such a layer
  is drawn on a canvas of its own and burnt in by inverting, adding and
  inverting back (`#linearBurn` in `draw.ts`).
  The colour split and the glitch take the picture apart into red, green and
  blue on scratch canvases; the others use the canvas's own filters.
- **Settings take what fits their kind:** a number, or an expression giving
  one; a colour, or an expression giving one (`#3ddc97`, `colour1 * 0.5`,
  `complement(colour1)`); text with `%variables%`; for a choice, image or
  font, a value or just `%field%`. Number and colour fields are used in
  expressions by their bare name, so one field such as "Colour 1" can serve
  several layers, changed differently in each.
- **Checking** (`checkTemplate`) never refuses a template outright. Each
  problem is listed with where it is (layer, setting, and for expressions and
  text the characters to underline) and the setting falls back to its
  default, so a slightly broken template still draws.
- **The expression language:** numbers, names, `+ - * / % ^`, comparisons
  giving 1 or 0, `condition ? a : b`, brackets, and functions:
  - waves taking a phase in cycles and giving 0 to 1: `sine`, `triangle`,
    `saw`, `square`; so `sine(time / 8)` sways every 8 seconds and
    `saw(beats / 4)` ramps once a bar;
  - `noise(x)` and `random(n)`, the same on every render;
  - `smooth(value, rise, fall)`, an envelope follower that remembers from
    frame to frame;
  - `min`, `max`, `clamp`, `mix`, `step`, `smoothstep`, `abs`, `floor`,
    `ceil`, `round`, `fract`, `sqrt`, `pow`, `exp`, `log`, `sin`, `cos`, and
    the constant `pi`.
- **Colours are values too,** as in a shader. An expression gives a number or
  a colour, and the compiler works out which from what it is made of; a
  colour setting given a number, or the other way round, is reported.
  - Written `#3ddc97` (or with alpha, `#3ddc9780`), or made with
    `rgb(r, g, b)` (each 0 to 1), `hsl(hue, saturation, lightness)` or
    `oklch(lightness, chroma, hue)`.
  - Arithmetic works on red, green and blue alike: `colour1 * 0.5` is half
    as bright, `colour1 * #ffcc99` tints, `colour1 + colour2 * 0.2` adds a
    little. Adding a plain number to a colour is refused, with the advice to
    multiply or use `lighten`, since what it should mean is unclear.
  - Hue, lightness and saturation are changed in OKLCH, where equal steps
    look equal: `hue(c, degrees)`, `complement(c)`, `lighten(c, amount)`,
    `darken(c, amount)`, `saturate(c, amount)`, `desaturate(c, amount)`,
    `gray(c)`, `alpha(c, value)`. A complement looks as light as the colour
    it came from, which HSL does not manage.
  - `mix(a, b, t)` blends colours in the same space, so red to blue passes a
    clear purple; `smooth` follows colours as well as numbers.
  - Read back as numbers: `lightness`, `chroma`, `hueOf`, `red`, `green`,
    `blue`, `alphaOf`. So text that stays readable on whatever colour was
    picked is `lightness(colour1) > 0.6 ? #000000 : #ffffff`.
  - A colour no screen can show has its saturation lowered until it fits,
    keeping hue and lightness.

  An unknown name is reported with a guess ("did you mean bass?"), and what
  cannot be worked out (a division by zero) is 0, never a broken frame.
- **Music values** are each scaled to the mix's own range: 0 is the quiet end
  of what that mix does (its 10th percentile), 1 the loud end (98th). `beat`
  is the kick's strength on the beat, falling away by the next. `beats`
  counts from the first beat of the mix, so `beats / 4` starts its bars
  there. Where the downbeat of a bar really is is not detected, on purpose:
  DJs break the bar structure, on purpose or by starting a track early, and
  build-ups bring kicks ahead of the bar. If it ever matters, a nudge by
  hand (shift the bar by one to three beats) is the way, not cleverer
  detection. Reading a frame takes well under a microsecond.

## The Video view, as built

- The main window has two views, **Mastering** and **Video**, switched by a
  small switch in the bar along the bottom, or Tab, as in Ableton. (A
  separate window was tried first and dropped: two windows had to keep each
  other informed, which made editing while playing unreliable, and the
  switching between windows got in the way.)
- The Video view keeps the header, the recording timeline with its mix tabs
  and the transport row, so mixes are chosen and played as before. The curves
  give way to the picture, with the level meter still beside it, and the
  levelling settings to the template and its fields. Under the picture, a strip
  shows the selected mix on its own, how loud it is along its length and how
  far the playhead has got; clicking or dragging on it moves the playhead.
- The template and what was filled in belong to the mix: kept with its other
  settings, saved, and undone with them. Fields of the same name carry over
  when the template changes, so a name and a colour need entering once.
- Four templates come with it, each showing the mix's Artist field (from the
  mix row) and asking for one colour, deriving the rest from it: **Glitter** (a radial glow, particles that thicken
  with the energy and burst on the kick, a logo that pulses), **Spectrum
  ring** (a circular spectrum from the colour to its complement around the
  logo) and **Waveform** (the level of the last eight seconds as a wave, before a larger, darker one of the last six and with a thin bright core, with
  a spectrum underneath, and the time), and **Photo** (a photo of the user's
  own that drifts slowly and swells a little with the bass, a little dust falling,
  the artist and the mix in a corner and a spectrum along the bottom; asks for
  the photo, and the colour is the spectrum's).
- Drawing is a 2D canvas (`src/visuals/draw.ts`), the same code the export
  will use. A frame follows from its moment in the mix alone, except for the
  spectrum's rise and fall and a text changing, which remember the frame
  before. The view draws only while shown.
- Templates of the user's own are copies of a built-in one, or imported, kept
  as JSON in the data folder. A template file to share (`.djmtemplate`) is the
  same JSON with its pictures packed in as data URLs (`assets`, named in an
  image setting as `asset:name`).
- The editor, in the Video view's panel while a template of the user's own is
  edited: the layers, each layer's settings (any number, switch or colour as an
  expression, checked as it is typed; "moves with…" writes one for a number
  from a choice of source, amount and speed), the fields, and dragging layers
  on the picture. It keeps its own undo history and saves the template as
  typed.
- Not yet: "moves with…" for colours, the waveform as a true oscilloscope (it
  shows the level, not the wave), and the glow's threshold (approximated).

## Video layers, as built

- **Where a clip is** at each moment of the mix is worked out by one pure
  function, `clipTime` in `src/visuals/clip.ts`, from the layer's timing
  settings and the clip's length. The view and the export both ask it, so
  they cannot disagree. A clip's time starts when its layer appears
  ("shown from"), or at its last restart.
- **Speed is a plain number.** A speed that followed the music would have to
  be added up frame by frame, and the view (at the screen's rate) and the
  export (at 30 frames a second) would drift apart. Such settings are
  `fixed` in their spec: no ƒ and no "moves with…" in the editor, and an
  expression is refused when a template is checked. "Starts again" on beats
  or tracks gives a clip a musical feel instead, and stays exact.
- **In the view**, each video layer has a muted video element
  (`PreviewVideos` in `video-sources.ts`), served from its file by the main
  process with byte ranges (`/video`). Playing, the element plays at the
  clip's speed and is put back only when it drifts more than 0.15 s from
  where `clipTime` says; paused, it is put on the exact frame, and the
  picture is drawn again when the frame comes in.
- **In the export**, the main process decodes each clip with ffmpeg
  (`/frames`): frames on an even grid at the clip's own rate, scaled to fit
  the video being made, as raw I420 in BT.709. `ExportVideos` reads them as
  `VideoFrame`s. Since drawing a frame is synchronous, the frames it will ask
  for are got ready first (`clipRequests` in `video-frame.ts`), from the
  layers' settings. A clip is decoded forwards; a jump back (a loop starting
  over) or far ahead starts ffmpeg again from there.
- **Videos are not packed into the template.** A template's `media` lists
  each by name with its path, size and fingerprint, and a setting names one
  as `media:name`. A video up to 25 MB is copied into the app's media folder
  when added, named by its fingerprint; a larger one is used where it is. A
  setting can also hold a path (a video field filled in for a mix), or
  `recording:video` for the recording's own picture.
- **A template file to share** is a ZIP of `template.json` and its videos,
  stored as they are. Videos found missing when a template is shown are
  looked for in the media folders by their kept names; those still missing
  are listed above the fields with a "Locate…" button each, and the others
  that were in the same folder are looked for beside the one located.
  Anything found must have the fingerprint the template noted, where it
  noted one.
- **Ping-pong** is played from a copy: the used part followed by itself
  reversed, played forwards as a loop (`pingPongClip` in `main.ts`, used by
  `PingPongs` in `video-sources.ts`). A decoder cannot step backwards a frame
  at a time. The reversed half is made in two-second pieces, each reversed on
  its own, so that ffmpeg never holds more than a piece decoded. Parts up to
  60 s (`PING_PONG_MOST_SECONDS`); a longer one, or one whose copy is still
  being made, is played back and forth by jumping, which is slow.
- **Videos the window cannot play** (ProRes, DNxHD, anything in an MKV) are
  shown in the view from a copy in `video-clips/`: the picture as it is, in
  an MP4, where only the file was the trouble; otherwise made again as
  H.264 at up to 1280 × 720. The export reads the original.
- **The recording's own picture** ignores a layer's playing settings: it is
  always at the same moment of the recording as the sound, less the
  recording's picture delay (`recordingTiming` in `video-frame.ts`). A
  recording in several files is played in the view part by part, as a video
  element cannot join them (`previewParts` in `main.ts`); the export reads it
  through the same concat list as the sound. `hasVideo`, 1 or 0, tells an
  expression whether the recording has a picture.

## The MP4 export, as built

- "MP4 video" is a format in the export dialog, beside WAV, FLAC, MP3 and
  AAC; Export all works with it too. Each mix is drawn with its own template,
  or Glitter if none was chosen. The dialog says which.
- 1920 × 1080 at 30 frames a second, H.264 at up to 8 Mbit/s (the encoder
  uses far less on calm pictures: 2 to 4 Mbit/s for the built-in templates),
  and the sound in AAC at the bitrate chosen, made 1 dB quieter like any
  lossy export. The tags go into the video file.
- Measured on an M1, from a clean start: ten minutes of the tekno recording
  as two five-minute videos in 100 seconds, about six times real time. Each
  file had exactly 9000 frames and picture and sound both 300.000 seconds
  long.
- Not yet tried: Windows and Linux, where the hardware encoder may not be
  offered and the software one built into Electron takes over (about half
  the speed on the Mac); other sizes and frame rates; very long mixes end to
  end.

## LUTs, as built

- **A LUT layer** sends the picture beneath it through a colour lookup table
  from a `.cube` file, the format colour grading programs write
  (`src/visuals/lut.ts`). 3D tables of up to 65 points a side are read;
  a 1D one is made into a 3D one of 33. `DOMAIN_MIN` and `DOMAIN_MAX` are
  kept; a file with a 1D and a 3D table together is refused. Its only setting
  is the LUT: how much of the look is the layer's opacity, and it has no
  place or size of its own.
- **Kept in the template,** unless it comes from a field. Adding a .cube file
  in the editor packs it into the template's `luts`, by name, and the setting
  names it as `lut:name`; so it travels in a template file with no file
  beside it. Packed, each value is 16 bits from the lowest to the highest the
  table gives, in base 64: finer than a frame's 8 bits, and a third of the
  size of the file's text, which matters as the editor's undo keeps the
  template whole at each step.
- **A LUT field** lets whoever uses the template choose a look for a mix: one
  the template keeps, one of the LUT folder's, or any .cube file, which is
  read where it is, as a picture field's is. Its default can be one the
  template keeps or one of the folder's.
- **The LUT folder** (File > Show LUT Folder; `luts/` in the data folder,
  or another chosen with File > Folder for LUTs) holds a collection of
  looks. Its .cube files, and those in folders in it two deep, are offered in
  every list of LUTs, named by where they are in it ("Film/Warm"). Chosen,
  one is named by that, as `lutfolder:Film/Warm`, and not kept: a collection
  can be tried look by look without the template filling up. Only a LUT
  added with "Add a .cube file…" is kept in the template. A template
  exported to share has the folder's LUTs it names packed in then
  (`keepFolderLuts`), as whoever opens it has not got the folder; one kept
  already with the same table is used rather than kept twice. The folder is
  looked in again whenever the window is brought forward, so files put there
  show up without a restart, and those changed are read again.
- **The list of LUTs** (`lut-picker.ts`) is a button that opens a list to
  search, as the fonts' is, rather than a dropdown of the system's: there,
  the arrow keys go through the list, and each LUT is put to use as it is
  reached, so looks are compared on the picture itself; Escape goes back to
  the one there was. With the list closed, the arrow keys on the button step
  through it as well.
- **Applied on the graphics card,** in WebGL 2: the picture is a texture, the
  table a 3D texture in half floats that the card reads between its points
  (trilinear), and the result is drawn back as any effect's is. Where WebGL
  2 cannot be had, the same is done on the processor (`applyLut`), with the
  same colours, at some tens of milliseconds a 1080p frame.
- The values are applied to the picture as it is, in sRGB, as a LUT made for
  Rec. 709 video expects. A LUT made for log footage will look wrong on
  anything else, as it would in an editor.
