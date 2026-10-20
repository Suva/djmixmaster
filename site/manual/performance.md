# Performance

A video export draws every frame of the mix, 30 a second, at full size. How long that takes depends on the template.

| Template | On an M1 Mac, a one-hour mix takes about |
|---|---|
| A simple one: a background, glitter, text | 10 minutes |
| With a full-size video clip | 20 minutes |
| Heavy: a video clip, text with several layer styles, glow, trails, a LUT | 50 minutes |

The first video export of a recording also listens to it for the beats and the spectrum, which takes about as long as its analysis, once.

## What takes the most

- **Video clips.** A clip shown small costs as much as one filling the picture. Keying out a clip's green or black adds little on a computer with a graphics card, and a lot on one without.
- **Layer styles**, several on one layer: each is drawn every frame.
- **Glitter** with thousands of particles, **glow**, **trails** and **blur**.

Gradients, solid colours, text without styles, the spectrum and the waveform cost little.

## The preview

The Video view draws the picture at the size it is shown. If it stutters while playing, make the window smaller, or hide the heaviest layers while you work on others: an export draws every frame whatever the preview managed.
