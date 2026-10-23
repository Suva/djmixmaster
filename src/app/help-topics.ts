// Where in the manual each part of the app is explained: what F1 and the ?
// button open for what is on screen, and what the small ? beside a panel
// opens. Each is a page of site/manual/, by its file's name, and a part of it
// by its heading's id. test/manual.test.ts checks every one against the
// manual, so that renaming a heading fails there rather than leaving the app
// to open the top of a page. Pure, for the window and the tests.

export const HELP = {
  // What is on screen.
  start: 'recording',
  mastering: 'levelling',
  record: 'record',
  video: 'video',
  templates: 'templates',
  fields: 'fields',
  about: 'fields#the-about-page',
  // Dialogs.
  checkup: 'checkup',
  channels: 'checkup#putting-the-channels-right',
  tracks: 'tracks',
  settings: 'install#settings',
  exportAudio: 'export-audio',
  exportVideo: 'export-video',
  originalVideo: 'export-video#original-video',
  // Panels.
  eq: 'levelling#eq',
  adjusting: 'levelling#adjusting-by-hand',
  styles: 'layer-settings#layer-styles',
  masks: 'layer-settings#masks',
  timing: 'layer-settings#place-size-and-timing',
  movesWith: 'formulas#moves-with',
  formulas: 'formulas#formulas',
  shortcuts: 'shortcuts',
} as const;

export type HelpTopic = keyof typeof HELP;

/** A kind of layer's own part of the Layer types page, which the manual makes for every kind. */
export const layerHelp = (type: string) => `layer-types#${type}`;
