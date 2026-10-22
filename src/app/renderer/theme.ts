// The window's two looks, dark and light. The CSS follows `data-theme` on the root element; what is drawn
// on a canvas cannot, so its colours live here and are changed in place when the look changes.

import type { AppTheme as Theme } from '../api.ts';

export type { Theme };

const DARK = {
  grid: '#262a33',
  text: '#8b93a1',
  label: '#c9ced8',
  before: '#6b7280',
  after: '#3ddc97',
  otherMix: '#2c8f66',
  gain: '#f2a83b',
  bass: '#6aa9ff',
  warn: '#ff5d5d',
  hover: '#e6e8ec',
  /** The lanes' own colour, for lines between them and for handles. */
  lane: '#14161a',
  /** Text and marks laid on `hover`. */
  ink: '#14161a',
  /** Behind a label that lies over a curve, so that it stays readable. */
  scrim: 'rgba(16, 18, 22, 0.85)',
  scrimSoft: 'rgba(16, 18, 22, 0.8)',
  tab: 'rgba(16, 18, 22, 0.82)',
  tabSelected: 'rgba(230, 232, 236, 0.92)',
  /** The meter's lights when off. */
  off: '#1e222a',
  mixTint: '61, 220, 151',
  adjustTint: '255, 255, 255',
  bassTint: '106, 169, 255',
  gainFill: 'rgba(242, 168, 59, 0.22)',
  /** A video's strip: what has been played, what has not, a track's start and the playhead. */
  played: '#3ddc97',
  unplayed: '#4a505c',
  trackStart: 'rgba(230, 232, 236, 0.55)',
  playhead: '#e6e8ec',
};

export type Palette = typeof DARK;

// Darker and stronger than the dark look's, which are made for a dark ground: on a light one they wash out.
const LIGHT: Palette = {
  grid: '#d3d7de',
  text: '#5b6472',
  label: '#2d333d',
  before: '#8a919d',
  after: '#0e9060',
  otherMix: '#7cc4a6',
  gain: '#c77a0a',
  bass: '#2a6fd6',
  warn: '#d93636',
  hover: '#1c2028',
  lane: '#eef0f3',
  ink: '#ffffff',
  scrim: 'rgba(255, 255, 255, 0.88)',
  scrimSoft: 'rgba(255, 255, 255, 0.85)',
  tab: 'rgba(255, 255, 255, 0.85)',
  tabSelected: 'rgba(28, 32, 40, 0.92)',
  off: '#d8dce3',
  mixTint: '14, 144, 96',
  adjustTint: '0, 0, 0',
  bassTint: '42, 111, 214',
  gainFill: 'rgba(199, 122, 10, 0.25)',
  played: '#0e9060',
  unplayed: '#b4bac5',
  trackStart: 'rgba(28, 32, 40, 0.55)',
  playhead: '#1c2028',
};

/** What canvases draw with. One object, changed in place, so that a module holding it sees the new look. */
export const colours: Palette = { ...DARK };

let current: Theme = 'dark';
const listeners: (() => void)[] = [];

export const currentTheme = (): Theme => current;

/** Lets the window draw again when the look changes. */
export const onThemeChange = (listener: () => void) => void listeners.push(listener);

export function setTheme(theme: Theme) {
  if (theme === current && document.documentElement.dataset.theme === theme) return;
  current = theme;
  document.documentElement.dataset.theme = theme;
  Object.assign(colours, theme === 'light' ? LIGHT : DARK);
  for (const listener of listeners) listener();
}
