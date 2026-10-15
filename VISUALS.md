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

- **A window of its own.** A small screen icon in the transport row, beside
  Original/Levelled, opens the visuals window: the template, its fields and a
  live picture. It sits beside the mastering window (or on a second screen)
  and follows it: the selected mix, the playhead, playing and pausing. The
  mastering window does not change.
- **Nothing changes until it is used.** Without the visuals window ever being
  opened, exporting works exactly as it does now. Visuals come into play only
  when a video format (MP4) is chosen in the export dialog; that format takes
  the template and fields set for the mix, or a default template if none was.
- **What the picture follows is worked out ahead, not listened to live.** The
  preview reads the same per-frame values the export does, so what is seen
  while playing is what the video will show.
- **Opening a recording stays as quick as now.** The values the visuals need
  (a spectrum per video frame, beats, tempo) come from a second pass over the
  recording that runs in the background, at low priority, only once the
  visuals window has been opened or a video is exported. It is stored with the
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

The track variables need track markers, which belong with the cue-sheet task
in TASKS.md: placed by hand, or imported from a rekordbox history. Without
markers they are empty, and a layer can be set to hide itself when its text is.

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

## Fields a template can ask for

| Kind | Example |
|---|---|
| Text | Artist name, title, venue, date |
| Colour | Colour 1, colour 2 |
| Image | Logo, background photo |
| Number | Particle amount, as a slider with the range the designer allows |
| Choice | Layout: logo left or centred |
| Font | From the fonts the app carries |

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

