// The templates that come with the app. Each asks for a few things (a colour,
// a logo) and derives the rest from them, so that one colour picked gives a
// whole palette. Who played is the mix's own Artist field, shown as %artist%.
// They are written in the same format a template file would be, and checked
// the same way.

export interface BuiltIn {
  id: string;
  template: unknown;
}

/**
 * A gradient's five stops (see gradient-map.ts): these colours spread evenly
 * from 0 to 1, and the rest not used, written out so that no stop's default
 * creeps in.
 */
const stops = (...colours: string[]) => Object.fromEntries([1, 2, 3, 4, 5].flatMap((n) => [
  [`colour${n}`, colours[n - 1] ?? ''],
  [`position${n}`, n > colours.length ? 1 : colours.length < 2 ? 0 : (n - 1) / (colours.length - 1)],
]));

const logo = { key: 'logo', label: 'Logo', kind: 'image', default: '' };
const nowPlaying = {
  type: 'text',
  name: 'Now playing',
  params: {
    text: '%currentTrack%', size: 2.4, weight: 500, x: 50, y: 93, colour: '#ffffffcc',
    change: 'fade', changeSeconds: 1, hideWhenEmpty: true,
  },
};

export const BUILT_IN_TEMPLATES: BuiltIn[] = [
  {
    id: 'glitter',
    template: {
      format: 3,
      name: 'Glitter',
      about: { author: 'DJ Mix Master', description: 'A glow in your colour and glitter that thickens with the energy and bursts on the kick, round your logo and the artist\'s name.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#b43cff' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Unbounded' },
        logo,
        { key: 'sparkle', label: 'Sparkle', kind: 'number', default: 1, min: 0, max: 3 },
      ],
      layers: [
        {
          type: 'gradient',
          name: 'Background',
          params: {
            kind: 'radial', y: 40, scale: 110,
            ...stops('darken(colour1, 0.35 - 0.1 * smooth(bass, 0.05, 0.6))', 'darken(hue(colour1, 40), 0.62)', '#05030a'),
          },
        },
        {
          type: 'particles',
          name: 'Glitter',
          params: {
            count: '220 * sparkle', burst: '24 * sparkle', shape: 'soft dot',
            colour1: 'lighten(colour1, 0.25)', colour2: '#ffffff', colour3: 'lighten(hue(colour1, -50), 0.2)',
            sizeLow: 0.15, sizeHigh: '0.7 + 0.4 * smooth(highs, 0.02, 0.4)',
            speed: '2 + 4 * energy', direction: 270, spread: 50, turbulence: 20, lifetime: 9, twinkle: 1.5, twinkleDepth: 0.6,
            blend: 'add',
          },
        },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', y: 42, width: 32, height: 32, scale: '100 + 5 * beat' },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 72, size: 7, weight: 800, letterSpacing: 4, case: 'upper',
            colour: '#ffffff', shadowColour: 'alpha(lighten(colour1, 0.2), 0.8)', shadowBlur: 2,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', y: 80, size: 3.2, weight: 500, colour: 'lighten(colour1, 0.35)' },
        },
        nowPlaying,
        { type: 'glow', params: { threshold: 0.55, strength: '0.5 + 0.4 * smooth(beat, 0, 0.3)', radius: 1.5 } },
      ],
    },
  },
  {
    id: 'ring',
    template: {
      format: 3,
      name: 'Spectrum ring',
      about: { author: 'DJ Mix Master', description: 'The spectrum as a ring round your logo, from your colour to its opposite, over a soft background in both.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#3ddc97' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Orbitron' },
        logo,
      ],
      layers: [
        {
          type: 'gradient',
          name: 'Background',
          // The colour's hue at a set lightness rather than darkened by a set amount, which
          // left anything but the lightest colours almost black.
          params: {
            kind: 'linear', angle: 120, drift: 2,
            ...stops('oklch(0.34, 0.6 * chroma(colour1), hueOf(colour1))', 'oklch(0.17, 0.25 * chroma(colour1), hueOf(colour1))', 'oklch(0.3, 0.5 * chroma(colour1), hueOf(colour1) + 180)'),
          },
        },
        {
          type: 'spectrum',
          name: 'Ring',
          params: {
            form: 'circle', y: 44, radius: 17, height: '13 + 4 * beat', bars: 120, gap: 35, rounded: true,
            ...stops('colour1', 'complement(colour1)'), stopBlend: 'round the colour wheel', colouring: 'along', rise: 0.02, fall: 0.3,
          },
        },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', y: 44, width: 24, height: 24, fit: 'contain', rounding: 50, scale: '100 + 3 * beat' },
        },
        {
          type: 'text',
          name: 'Artist',
          params: { text: '%artist%', font: '%font%', y: 81, size: 6, weight: 700, colour: '#ffffff' },
        },
        {
          type: 'text',
          name: 'Mix and time',
          params: { text: '%mixName%  ·  %elapsed%', y: 87, size: 2.6, weight: 400, colour: 'lighten(colour1, 0.3)' },
        },
        nowPlaying,
        { type: 'glow', params: { threshold: 0.6, strength: 0.6, radius: 1.2 } },
      ],
    },
  },
  {
    id: 'waveform',
    template: {
      format: 3,
      name: 'Waveform',
      about: { author: 'DJ Mix Master', description: 'The level of the last seconds as a wave across the picture, a larger one behind, a spectrum underneath, and the time.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ff6a3d' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Bebas Neue' },
      ],
      layers: [
        { type: 'gradient', name: 'Background', params: { kind: 'linear', angle: 90, ...stops('#0b0c10', 'darken(colour1, 0.7)') } },
        {
          type: 'waveform',
          name: 'Wave behind',
          // Larger and darker, and over less time than the wave in front, so it moves past faster.
          params: {
            style: 'mirrored', seconds: 6, y: 50, width: 100, height: '62 + 10 * smooth(bass, 0.04, 0.8)',
            colour: 'alpha(oklch(0.36, 0.7 * chroma(colour1), hueOf(colour1)), 0.5)',
          },
        },
        {
          type: 'waveform',
          name: 'Wave',
          params: { style: 'mirrored', seconds: 8, y: 50, width: 100, height: '34 + 6 * smooth(bass, 0.02, 0.4)', colour: 'alpha(colour1, 0.9)' },
        },
        {
          type: 'waveform',
          name: 'Wave',
          params: { style: 'mirrored', seconds: 8, y: 50, width: 100, height: '5 + 10 * smooth(bass, 0.02, 0.4)', colour: 'alpha(lighten(colour1, 0.01), 1)' },
        },
        {
          type: 'spectrum',
          name: 'Bars',
          params: {
            y: 96, anchor: 'bottom', width: 92, height: 10, bars: 64, gap: 25, rounded: false,
            ...stops('alpha(lighten(colour1, 0.15), 0.6)', 'alpha(hue(colour1, 60), 0.6)'), stopBlend: 'round the colour wheel',
          },
        },
        {
          type: 'text',
          name: 'Artist',
          params: { text: '%artist%', font: '%font%', x: 4, y: 7, anchor: 'top left', align: 'left', size: 6, weight: 800, colour: '#ffffff' },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', x: 4, y: 15, anchor: 'top left', align: 'left', size: 2.8, weight: 400, colour: 'lighten(colour1, 0.25)' },
        },
        {
          type: 'text',
          name: 'Time',
          params: { text: '%elapsed% / %mixLength%', x: 96, y: 7, anchor: 'top right', align: 'right', size: 2.4, font: 'Mono', colour: '#ffffffaa' },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, x: 4, y: 84, anchor: 'top left', align: 'left' } },
      ],
    },
  },
  {
    id: 'photo',
    template: {
      format: 3,
      name: 'Photo',
      about: { author: 'DJ Mix Master', description: 'Your photo, drifting a little and swelling with the bass, faint dust falling, the artist in the corner and the spectrum along the bottom.' },
      fields: [
        { key: 'photo', label: 'Photo', kind: 'image', default: '' },
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#f4efe6' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Space Grotesk' },
      ],
      layers: [
        // Seen only until a photo is chosen.
        { type: 'gradient', name: 'Background', params: { kind: 'radial', ...stops('#22252c', '#08090b') } },
        {
          type: 'image',
          name: 'Photo',
          // A little larger than the frame, so that drifting never shows its edges. It wanders
          // slowly on its own, and swells a little with the bass.
          params: {
            image: '%photo%', fit: 'cover', width: 100, height: 100,
            x: '50 + 1.6 * (noise(time / 9) - 0.5)', y: '50 + 1.6 * (noise(time / 11 + 40) - 0.5)',
            rotation: '0.5 * (noise(time / 13 + 80) - 0.5)',
            scale: '108 + 2.5 * smooth(bass, 0, 0.2)',
          },
        },
        {
          type: 'gradient',
          name: 'Shade',
          // Darker at the top and the bottom, where the writing and the spectrum are.
          params: { kind: 'linear', angle: 90, ...stops('#00000080', '#00000000', '#000000a0') },
        },
        {
          type: 'particles',
          name: 'Dust',
          params: {
            // Drawn over the photo as it is, not lightened into it, so that it shows on bright photos too.
            count: 120, shape: 'soft dot', colour1: '#ffffff', colour2: 'colour1',
            sizeLow: 0.15, sizeHigh: 0.6, speed: 1.2, direction: 90, spread: 30, turbulence: 25,
            lifetime: 20, twinkle: 0.3, twinkleDepth: 0.4, opacity: 0.7,
          },
        },
        {
          type: 'spectrum',
          name: 'Spectrum',
          params: {
            y: 100, anchor: 'bottom', width: 100, height: 16, bars: 96, gap: 30, rounded: false,
            ...stops('alpha(colour1, 0.85)', 'alpha(hue(colour1, 40), 0.85)'), stopBlend: 'round the colour wheel',
          },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', x: 4, y: 6, anchor: 'top left', align: 'left', size: 5.5, weight: 700,
            colour: '#ffffff', shadowColour: '#000000aa', shadowBlur: 1.5,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: {
            text: '%mixName%', font: '%font%', x: 4, y: 13, anchor: 'top left', align: 'left', size: 2.8, weight: 400,
            colour: 'alpha(colour1, 0.9)', shadowColour: '#000000aa', shadowBlur: 1.5,
          },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, x: 4, y: 78, anchor: 'top left', align: 'left' } },
      ],
    },
  },
  {
    id: 'tunnel',
    template: {
      format: 3,
      name: 'Tunnel',
      about: { author: 'DJ Mix Master', description: 'A ring of the sound that streams outwards into an endless tunnel, faster on the kick, turning with the music and through your colours.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#2fa8ff' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Orbitron' },
        logo,
      ],
      layers: [
        { type: 'solid', name: 'Background', params: { colour: '#000000' } },
        // Only the ring and the tunnel it leaves are in the group, so that the writing leaves no trail.
        { type: 'group', name: 'Tunnel', size: 5, params: {} },
        {
          type: 'waveform',
          name: 'Ring',
          params: {
            style: 'line', form: 'circle', seconds: 0.08, radius: '9 + 3 * smooth(bass, 0.02, 0.3)', height: 14, lineWidth: 0.45,
            // Grey rather than white, so that the echoes piling up stay in the colours rather than turning white,
            // and brightest on the kick, so that each kick leaves a ring that flies out down the tunnel.
            colour: 'alpha(#a0a0a0, 0.12 + 0.88 * smooth(beat, 0, 0.08))',
          },
        },
        {
          type: 'spectrum',
          name: 'Spikes',
          params: {
            form: 'circle', radius: 12, height: '6 + 4 * beat', bars: 72, gap: 60, mirrored: true, rounded: true,
            colouring: 'one colour', ...stops('alpha(#ffffff, 0.3)'), rise: 0.02, fall: 0.2,
          },
        },
        // Every frame, what was drawn before zooms out and turns a little: the past becomes the walls of the tunnel.
        {
          type: 'trails',
          name: 'Tunnel',
          params: { length: 1.8, mode: 'bright parts', zoom: '120 + 100 * smooth(beat, 0, 0.25) + 40 * energy', turn: '25 * sin(beats * 0.196)' },
        },
        // Coloured by brightness: the bright ring near white, the tunnel through the colour into black.
        {
          type: 'gradientMap',
          name: 'Colours',
          params: {
            ...stops('#000000', 'darken(hue(colour1, -60), 0.45)', 'colour1', 'lighten(hue(colour1, 40), 0.25)', '#ffffff'),
            position2: 0.1, position3: 0.4, position4: 0.75,
            hueShift: '50 * sin(time / 20)',
          },
        },
        { type: 'glow', name: 'Glow', params: { threshold: 0.6, strength: '0.4 + 0.4 * smooth(beat, 0, 0.3)', radius: 2 } },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', width: 14, height: 14, rounding: 50, scale: '100 + 6 * beat' },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 84, size: 5, weight: 800, letterSpacing: 6, case: 'upper', colour: '#ffffff',
            shadowColour: '#000000cc', shadowBlur: 2,
          },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, y: 91, shadowColour: '#000000cc', shadowBlur: 1.5 } },
      ],
    },
  },
  {
    id: 'retrowave',
    template: {
      format: 3,
      name: 'Retrowave',
      about: { author: 'DJ Mix Master', description: 'A striped sun setting behind mountains made of the spectrum, a grid floor running to the horizon, and the colours splitting on the kick.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ff3d9a' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Monoton' },
      ],
      layers: [
        {
          type: 'gradient',
          name: 'Sky',
          params: {
            kind: 'linear', angle: 90,
            ...stops('#07021a', 'oklch(0.22, 0.12, hueOf(colour1) - 70)', 'oklch(0.5, 0.18, hueOf(colour1))', '#07020f'),
            position2: 0.38, position3: 0.62, position4: 0.62,
          },
        },
        {
          type: 'particles',
          name: 'Stars',
          params: {
            count: 160, shape: 'dot', colour1: '#ffffff', colour2: 'lighten(colour1, 0.4)', sizeLow: 0.08, sizeHigh: 0.3,
            speed: 0.3, direction: 180, spread: 10, turbulence: 0, lifetime: 30, twinkle: 0.8, twinkleDepth: 0.8, area: 'top', opacity: 0.8,
          },
        },
        // The sun: its top half whole, its lower half through stripes, as the old record sleeves had it.
        { type: 'group', name: 'Sun', size: 4, params: { scale: '100 + 3 * smooth(bass, 0.05, 0.6)' } },
        {
          type: 'shape',
          name: 'Top of the sun',
          params: {
            shape: 'ellipse', square: true, width: '48 * min(1, 1 / aspect)', y: 46, fill: 'linear gradient', gradientAngle: 90,
            ...stops('#ffe96b', 'colour1'), amount: 0.5, reveal: 'top',
          },
        },
        { type: 'group', name: 'Striped half', size: 2, params: {} },
        {
          type: 'grid',
          name: 'Stripes',
          params: { kind: 'stripes', cell: 2.6, rotation: 90, y: 46, fill1: '#ffffff', fill2: '', scroll: 1.3, direction: 90, mask: 'by its shape' },
        },
        {
          type: 'shape',
          name: 'Sun',
          params: { shape: 'ellipse', square: true, width: '48 * min(1, 1 / aspect)', y: 46, fill: 'linear gradient', gradientAngle: 90, ...stops('#ffe96b', 'colour1') },
        },
        {
          type: 'spectrum',
          name: 'Skyline',
          params: {
            y: 62, anchor: 'bottom', width: 100, height: 20, bars: 56, gap: 14, rounded: false,
            colouring: 'by height', ...stops('#0a0318', 'oklch(0.32, 0.14, hueOf(colour1) - 40)'), rise: 0.1, fall: 0.9,
          },
        },
        {
          type: 'shape',
          name: 'Ground',
          params: { width: 100, height: 38, y: 62, anchor: 'top', fill: 'linear gradient', gradientAngle: 90, ...stops('#12042a', '#030008') },
        },
        {
          type: 'grid',
          name: 'Floor',
          params: {
            kind: 'floor', y: 62, cell: 7, lineWidth: '0.25 + 0.15 * smooth(beat, 0, 0.2)', lineColour: 'lighten(colour1, 0.1)',
            scroll: 9, direction: 90, perspective: 1.6, fade: 0.8,
          },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 10, size: 7, weight: 400, case: 'upper', letterSpacing: 2,
            colour: '#ffffff', shadowColour: 'colour1', shadowBlur: 1.5,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', y: 16.5, size: 2.4, weight: 600, letterSpacing: 30, case: 'upper', colour: 'lighten(hue(colour1, 140), 0.3)' },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, y: 94, colour: '#ffffffdd' } },
        { type: 'glow', name: 'Glow', params: { threshold: 0.5, strength: 0.8, radius: 1.5 } },
        { type: 'split', name: 'Kick', params: { form: 'from the centre', amount: '0.1 + 0.9 * smooth(beat, 0, 0.12)' } },
        { type: 'vignette', name: 'Vignette', params: { size: 55, opacity: 0.7 } },
      ],
    },
  },
  {
    id: 'chrome',
    template: {
      format: 3,
      name: 'Liquid chrome',
      about: { author: 'DJ Mix Master', description: 'Liquid metal that flows and swells with the bass, with a sheen in your colour, round your logo.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#9b7bff' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Unbounded' },
        logo,
      ],
      layers: [
        // Grey marble, bent by the bass, then given the bands of light and dark that make it look like polished metal.
        {
          type: 'noise',
          name: 'Metal',
          params: {
            kind: 'clouds', size: 60, detail: 2, roughness: 0.35, warp: '0.7 + 0.2 * smooth(energy, 1, 3)', evolve: 0.12, seed: 7,
            ...stops('#000000', '#ffffff'),
          },
        },
        {
          type: 'displace',
          name: 'Swell',
          params: { mode: 'bulge', amount: '1.5 + 7 * smooth(bass, 0.02, 0.35)', radius: 55 },
        },
        {
          type: 'gradientMap',
          name: 'Chrome',
          params: {
            // Light and dark by turns, as a polished surface reflects: the bands are what make it read as metal.
            ...stops('darken(colour1, 0.7)', '#f2f4f8', '#050507', 'lighten(colour1, 0.45)', '#ffffff'),
            position1: 0.15, position2: 0.38, position3: 0.55, position4: 0.72, position5: 0.9,
            shift: '0.08 * sin(time / 6)',
          },
        },
        // A sheen of the colour and the one beside it on the wheel over the grey, as on oil or a soap bubble.
        {
          type: 'gradient',
          name: 'Colour',
          params: { kind: 'linear', angle: 120, drift: 4, ...stops('colour1', 'hue(colour1, 100)'), blend: 'overlay', opacity: 0.75 },
        },
        { type: 'glow', name: 'Sheen', params: { threshold: 0.7, strength: '0.5 + 0.4 * smooth(beat, 0, 0.3)', radius: 2, tint: 'lighten(colour1, 0.5)' } },
        { type: 'vignette', name: 'Vignette', params: { size: 45, softness: 1, opacity: 0.85 } },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', y: 44, width: 26, height: 26, scale: '100 + 4 * beat', shadowColour: '#000000aa', shadowBlur: 3 },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 78, size: 7, weight: 900, case: 'upper', letterSpacing: 3, colour: '#ffffff',
            dropShadow: true, dropOpacity: 0.7, dropDistance: 0.4, dropSize: 1.5,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', y: 85, size: 2.8, weight: 500, letterSpacing: 8, case: 'upper', colour: '#ffffff', shadowColour: '#000000', shadowBlur: 1.5 },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, y: 93, shadowColour: '#000000cc', shadowBlur: 1.5 } },
      ],
    },
  },
  {
    id: 'pulse',
    template: {
      format: 3,
      name: 'Bass ring',
      about: { author: 'DJ Mix Master', description: 'Three rings of the spectrum round your logo, in three colours that rise and fall each at its own pace, over your photo, which swells and shakes with the bass.' },
      fields: [
        { key: 'photo', label: 'Photo', kind: 'image', default: '' },
        logo,
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ff4f6d' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Bebas Neue' },
        { key: 'shake', label: 'Shake', kind: 'number', default: 1, min: 0, max: 3 },
      ],
      layers: [
        // Seen only until a photo is chosen.
        {
          type: 'gradient',
          name: 'Background',
          params: { kind: 'radial', ...stops('oklch(0.28, 0.6 * chroma(colour1), hueOf(colour1))', '#050307'), scale: 120 },
        },
        {
          type: 'image',
          name: 'Photo',
          // A little larger than the frame, so that the shake never shows its edges.
          params: {
            image: '%photo%', fit: 'cover', width: 100, height: 100,
            x: '50 + shake * 0.9 * smooth(bass, 0, 0.15) * (noise(time * 9) - 0.5)',
            y: '50 + shake * 0.9 * smooth(bass, 0, 0.15) * (noise(time * 9 + 50) - 0.5)',
            scale: '110 + 6 * smooth(bass, 0.01, 0.25)', brightness: 0.5, saturation: 0.9,
          },
        },
        { type: 'blur', name: 'Soften', params: { radius: '0.25 + 0.5 * smooth(beat, 0, 0.2)' } },
        { type: 'vignette', name: 'Vignette', params: { size: 35, opacity: 0.9 } },
        {
          type: 'particles',
          name: 'Sparks',
          params: {
            count: 140, burst: 40, area: 'centre', direction: 0, spread: 360, speed: '6 + 22 * smooth(bass, 0.02, 0.4)',
            shape: 'soft dot', colour1: '#ffffff', colour2: 'lighten(colour1, 0.3)', sizeLow: 0.1, sizeHigh: 0.45,
            turbulence: 5, lifetime: 4, twinkle: 3, twinkleDepth: 0.5, blend: 'add',
          },
        },
        // The rings and the logo shake together, a little less than the photo.
        {
          type: 'group',
          name: 'Rings',
          size: 5,
          params: {
            x: '50 + shake * 0.6 * smooth(beat, 0, 0.12) * (noise(time * 14 + 20) - 0.5)',
            y: '50 + shake * 0.6 * smooth(beat, 0, 0.12) * (noise(time * 14 + 70) - 0.5)',
            scale: '100 + 5 * smooth(beat, 0, 0.18)',
          },
        },
        {
          type: 'spectrum',
          name: 'Outer ring',
          params: {
            form: 'circle', radius: 15, height: 20, bars: 100, gap: 30, mirrored: true, rounded: true, lowHz: 30, highHz: 9000,
            colouring: 'one colour', ...stops('hue(colour1, -70)'), rise: 0.08, fall: 0.7,
          },
        },
        {
          type: 'spectrum',
          name: 'Middle ring',
          params: {
            form: 'circle', radius: 15, height: 15, bars: 100, gap: 30, mirrored: true, rounded: true, lowHz: 30, highHz: 9000,
            colouring: 'one colour', ...stops('colour1'), rise: 0.04, fall: 0.38,
          },
        },
        {
          type: 'spectrum',
          name: 'Inner ring',
          params: {
            form: 'circle', radius: 15, height: 10, bars: 100, gap: 30, mirrored: true, rounded: true, lowHz: 30, highHz: 9000,
            colouring: 'one colour', ...stops('#ffffff'), rise: 0.02, fall: 0.16,
          },
        },
        {
          type: 'shape',
          name: 'Disc',
          // Sized against the picture's width, where the rings are against its short side.
          params: { shape: 'ellipse', square: true, width: '30 * min(1, 1 / aspect)', ...stops('#0a0a0e'), outlineWidth: 0.4, outlineColour: '#ffffff' },
        },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', width: '29 * min(1, 1 / aspect)', height: '29 * min(1, aspect)', fit: 'cover', rounding: 50 },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 84, size: 7, weight: 400, letterSpacing: 4, case: 'upper', colour: '#ffffff',
            shadowColour: '#000000cc', shadowBlur: 1.5,
          },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, y: 91, shadowColour: '#000000cc', shadowBlur: 1.5 } },
        { type: 'glow', name: 'Glow', params: { threshold: 0.6, strength: '0.5 + 0.4 * smooth(beat, 0, 0.3)', radius: 1.5 } },
      ],
    },
  },
  {
    id: 'mono',
    template: {
      format: 3,
      name: 'Monochrome',
      about: { author: 'DJ Mix Master', description: 'Black and white for techno: the sound in halftone dots, big type that opens up in the drop, and a glitch only on the hardest kicks.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ffffff' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Rubik Mono One' },
      ],
      layers: [
        { type: 'solid', name: 'Background', params: { colour: '#000000' } },
        { type: 'grid', name: 'Lines', params: { kind: 'lines', cell: 12, lineWidth: 0.08, lineColour: 'alpha(colour1, 0.12)', scroll: 1.5, direction: 0 } },
        // The sound, drawn large and soft, then broken into dots that grow with its brightness.
        { type: 'group', name: 'Halftone', size: 4, params: {} },
        {
          type: 'spectrum',
          name: 'Bars',
          params: {
            width: 100, height: '60 + 15 * smooth(bass, 0.02, 0.5)', bars: '28 - 12 * portrait', gap: 35, rounded: false, mirrored: true,
            colouring: 'one colour', ...stops('colour1'), rise: 0.03, fall: 0.4,
          },
        },
        { type: 'blur', name: 'Soften', params: { radius: 0.35 } },
        { type: 'trails', name: 'Echo', params: { length: 0.5, mode: 'bright parts', zoom: '15 * energy' } },
        { type: 'mosaic', name: 'Dots', params: { cells: 'halftone', size: 1.6 } },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', size: 9, weight: 400, case: 'upper', letterSpacing: '2 + 14 * smooth(energy, 2, 4)',
            colour: '#ffffff', boxColour: '#000000', boxPadding: 1.2,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', font: 'Space Mono', y: 62, size: 2.4, weight: 700, letterSpacing: 20, case: 'upper', colour: 'colour1', boxColour: '#000000', boxPadding: 0.8 },
        },
        {
          type: 'text',
          name: 'Time',
          params: { text: '%elapsed%', font: 'Space Mono', x: 96, y: 5, anchor: 'top right', align: 'right', size: 2.2, weight: 400, colour: '#ffffffaa' },
        },
        {
          ...nowPlaying,
          params: { ...nowPlaying.params, font: 'Space Mono', x: 4, y: 95, anchor: 'bottom left', align: 'left', size: 2.2, case: 'upper', colour: '#000000', boxColour: 'colour1', boxPadding: 0.8 },
        },
        // Only the hardest kicks: below three quarters of a full beat, nothing happens.
        { type: 'glitch', name: 'Kick', params: { amount: 'step(0.75, beat)', slices: 14, shift: 5, split: 0.8, rate: 15 } },
        { type: 'solid', name: 'Flash', params: { colour: 'colour1', blend: 'add', opacity: '0.12 * step(0.85, beat) * smooth(beat, 0, 0.15)' } },
        { type: 'adjust', name: 'Contrast', params: { contrast: 1.15 } },
      ],
    },
  },
  {
    id: 'kaleido',
    template: {
      format: 3,
      name: 'Kaleido',
      about: { author: 'DJ Mix Master', description: 'Patterns in your colours turning slowly in a kaleidoscope in time with the music, breathing with the drops, the colours drifting on every few bars: a backdrop for a live set.' },
      fields: [
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ff8a3d' },
        { key: 'font', label: 'Font', kind: 'font', default: 'Unbounded' },
        logo,
        { key: 'segments', label: 'Segments', kind: 'number', default: 8, min: 3, max: 16 },
      ],
      layers: [
        {
          type: 'noise',
          name: 'Pattern',
          params: {
            kind: 'cell edges', size: '35 - 5 * smooth(energy, 3, 5)', detail: 2, roughness: 0.5, warp: 0.5, evolve: 0.2, drift: 3, direction: 30, seed: 3,
            ...stops('#000000', 'darken(colour1, 0.5)', 'colour1', 'complement(colour1)', '#ffffff'), position2: 0.35, position3: 0.6, position4: 0.85,
          },
        },
        {
          type: 'spectrum',
          name: 'Spectrum',
          params: {
            form: 'circle', radius: 10, height: 22, bars: 48, gap: 40, mirrored: true, rounded: true,
            colouring: 'by height', ...stops('colour1', '#ffffff'), rise: 0.06, fall: 0.5,
          },
        },
        // Turned by the beats rather than by time, so that it keeps pace with the music: once round every 120 beats,
        // a minute at 120 a minute. Mirrored, any movement of the slice shows doubled, so slow is enough.
        { type: 'kaleidoscope', name: 'Kaleidoscope', params: { segments: 'segments', angle: 'beats * 3' } },
        { type: 'hue', name: 'Colours move on', params: { hue: 'smooth(45 * sin(floor(beats / 16) * 1.3), 3, 3)', saturation: 1.1 } },
        { type: 'glow', name: 'Glow', params: { threshold: 0.65, strength: '0.45 + 0.15 * smooth(beat, 0, 0.5)', radius: 1.8 } },
        { type: 'vignette', name: 'Vignette', params: { size: 40, form: 'round', opacity: 0.9 } },
        {
          type: 'image',
          name: 'Logo',
          params: { image: '%logo%', width: 18, height: 18, rounding: 50, scale: '100 + 3 * smooth(beat, 0, 0.3)', shadowColour: '#000000cc', shadowBlur: 3 },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', y: 86, size: 5.5, weight: 800, case: 'upper', letterSpacing: 5, colour: '#ffffff',
            shadowColour: '#000000', shadowBlur: 2.5,
          },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, y: 93, shadowColour: '#000000', shadowBlur: 2 } },
      ],
    },
  },
  {
    id: 'original',
    template: {
      format: 3,
      name: 'Original video',
      about: {
        author: 'DJ Mix Master',
        description: 'The recording\'s own picture, for a set that was filmed, with the artist and the track playing over it.',
      },
      fields: [{ key: 'font', label: 'Font', kind: 'font', default: 'Space Grotesk' }],
      layers: [
        // Seen only where the picture does not fill the frame, or the recording has none.
        { type: 'gradient', name: 'Background', params: { kind: 'radial', ...stops('#22252c', '#08090b') } },
        { type: 'video', name: 'Picture', params: { video: 'recording:video', fit: 'contain', width: 100, height: 100 } },
        {
          type: 'text',
          name: 'No picture',
          params: { text: 'This recording has no picture of its own', visible: '1 - hasVideo', size: 2.4, weight: 500, colour: '#ffffff99' },
        },
        {
          type: 'text',
          name: 'Artist',
          params: {
            text: '%artist%', font: '%font%', x: 4, y: 88, anchor: 'bottom left', align: 'left', size: 4.5, weight: 700,
            colour: '#ffffff', shadowColour: '#000000cc', shadowBlur: 1.5,
          },
        },
        { ...nowPlaying, params: { ...nowPlaying.params, x: 4, y: 89, anchor: 'top left', align: 'left', shadowColour: '#000000cc', shadowBlur: 1.5 } },
      ],
    },
  },
];
