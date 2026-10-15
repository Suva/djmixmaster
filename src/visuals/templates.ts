// The templates that come with the app. Each asks for a few things (a name, a
// colour, a logo) and derives the rest from them, so that one colour picked
// gives a whole palette. They are written in the same format a template file
// would be, and checked the same way.

export interface BuiltIn {
  id: string;
  template: unknown;
}

const name = { key: 'name', label: 'Artist name', kind: 'text', default: '' };
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
      format: 1,
      name: 'Glitter',
      fields: [
        name,
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#b43cff' },
        logo,
        { key: 'sparkle', label: 'Sparkle', kind: 'number', default: 1, min: 0, max: 3 },
      ],
      layers: [
        {
          type: 'gradient',
          name: 'Background',
          params: {
            kind: 'radial', y: 40, scale: 110,
            colour1: 'darken(colour1, 0.35 - 0.1 * smooth(bass, 0.05, 0.6))',
            colour2: 'darken(hue(colour1, 40), 0.62)',
            colour3: '#05030a',
          },
        },
        {
          type: 'particles',
          name: 'Glitter',
          params: {
            count: '220 * sparkle', burst: '24 * sparkle', shape: 'soft dot',
            colour1: 'lighten(colour1, 0.25)', colour2: '#ffffff', colour3: 'lighten(hue(colour1, -50), 0.2)',
            sizeLow: 0.15, sizeHigh: '0.7 + 0.4 * smooth(highs, 0.02, 0.4)',
            speed: '2 + 4 * energy', direction: 270, spread: 50, turbulence: 20, lifetime: 9, twinkle: 1.5, twinkleDepth: 60,
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
            text: '%name%', y: 72, size: 7, weight: 800, letterSpacing: 4, case: 'upper',
            colour: '#ffffff', shadowColour: 'alpha(lighten(colour1, 0.2), 0.8)', shadowBlur: 2,
          },
        },
        {
          type: 'text',
          name: 'Mix',
          params: { text: '%mixName%', y: 80, size: 3.2, weight: 500, colour: 'lighten(colour1, 0.35)' },
        },
        nowPlaying,
        { type: 'glow', params: { threshold: 55, strength: '50 + 40 * smooth(beat, 0, 0.3)', radius: 1.5 } },
      ],
    },
  },
  {
    id: 'ring',
    template: {
      format: 1,
      name: 'Spectrum ring',
      fields: [
        name,
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#3ddc97' },
        logo,
      ],
      layers: [
        {
          type: 'gradient',
          name: 'Background',
          params: { kind: 'linear', angle: 120, drift: 2, colour1: 'darken(colour1, 0.62)', colour2: '#06070a', colour3: 'darken(complement(colour1), 0.6)' },
        },
        {
          type: 'spectrum',
          name: 'Ring',
          params: {
            form: 'circle', y: 44, radius: 17, height: '13 + 4 * beat', bars: 120, gap: 35, rounded: true,
            colourLow: 'colour1', colourHigh: 'complement(colour1)', colouring: 'along', rise: 0.02, fall: 0.3,
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
          params: { text: '%name%', y: 81, size: 6, weight: 700, colour: '#ffffff' },
        },
        {
          type: 'text',
          name: 'Mix and time',
          params: { text: '%mixName%  ·  %elapsed%', y: 87, size: 2.6, weight: 400, colour: 'lighten(colour1, 0.3)' },
        },
        nowPlaying,
        { type: 'glow', params: { threshold: 60, strength: 60, radius: 1.2 } },
      ],
    },
  },
  {
    id: 'waveform',
    template: {
      format: 1,
      name: 'Waveform',
      fields: [
        name,
        { key: 'colour1', label: 'Colour', kind: 'colour', default: '#ff6a3d' },
      ],
      layers: [
        { type: 'gradient', name: 'Background', params: { kind: 'linear', angle: 90, colour1: '#0b0c10', colour2: 'darken(colour1, 0.7)' } },
        {
          type: 'waveform',
          name: 'Wave',
          params: { style: 'mirrored', seconds: 8, y: 50, width: 92, height: '34 + 6 * smooth(bass, 0.02, 0.4)', colour: 'alpha(colour1, 0.9)' },
        },
        {
          type: 'spectrum',
          name: 'Bars',
          params: {
            y: 96, anchor: 'bottom', width: 92, height: 10, bars: 64, gap: 25, rounded: false,
            colourLow: 'alpha(lighten(colour1, 0.15), 0.6)', colourHigh: 'alpha(hue(colour1, 60), 0.6)',
          },
        },
        {
          type: 'text',
          name: 'Artist',
          params: { text: '%name%', x: 4, y: 7, anchor: 'top left', align: 'left', size: 5, weight: 800, colour: '#ffffff' },
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
];
