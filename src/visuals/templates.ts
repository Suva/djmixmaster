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
