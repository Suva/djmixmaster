// The gestures and shortcuts of the window, by where they are used: shown
// by the app's help sheet, and in the manual, which is made from this list so
// that the two never disagree. Pure, for the window and the site's build.

/** The modifier keys as a system writes them: ⌘ or Ctrl, Option or Alt. */
export interface Modifiers {
  command: string;
  option: string;
}

/** Sections, each a title and its rows: what is done, and what it does. */
export type Shortcuts = [string, [string, string][]][];

export function shortcuts({ command, option }: Modifiers): Shortcuts {
  return [
    ['The recording, at the top', [
      ['Drag across a free part', 'Mark a new mix'],
      ['Double-click a free part', 'Fill it with a new mix'],
      ['Drag a mix\'s edge', 'Move where it starts or ends'],
      ['Drag the middle of a mix', 'Move it'],
      ['Click inside a mix', 'Select it and put the playhead there'],
      ['Click a mix\'s edge', 'Jump to its start, or just before its end'],
      ['Scroll, or pinch', 'Zoom in and out'],
      ['Swipe sideways', 'Move along the recording'],
      ['Orange, red and white marks', 'Silences, clipping and possible dropouts'],
    ]],
    ['The mix, below it', [
      ['Click', 'Put the playhead there'],
      ['Scroll, or pinch', 'Zoom in and out'],
      ['Swipe sideways', 'Move along the mix'],
      ['Drag a square handle inwards', 'Fade in or out; back to the corner removes it'],
      ['Drag across the gain lane', 'Mark a stretch to adjust by hand'],
      ['Drag a marked stretch up or down', 'Raise or lower it'],
      ['Drag a stretch\'s edge', 'Make it longer or shorter'],
      ['Double-click a stretch', 'Remove it (or point at it and press Backspace)'],
      ['Drag a track marker', 'Move where the track starts'],
      ['Double-click a track\'s name', 'Type it in, as Artist - Title'],
    ]],
    ['Playback', [
      ['Space', 'Play or pause'],
      ['A', 'Bypass processing, to hear the recording as it is, and back'],
      ['← →', 'Back or forward 5 seconds'],
      [`Shift+← →, ${option}+← →`, '30 seconds, 1 second'],
      ['I, O', 'Start, or end, the mix at the playhead'],
      [`${command}E`, 'Split the mix at the playhead'],
      ['M', 'Mark a track starting at the playhead'],
      ['J, K, L', 'Run backwards, stop, run forwards; press J or L again to go faster'],
      ['Return', 'Jump to the start of the mix'],
      ['End', 'Jump to just before its end'],
    ]],
    ['Editing a video template', [
      [`Shift+${command}N`, 'Add a layer: type to find its kind, Return to add it'],
      ['Drag a layer up or down', 'Put it in front of or behind others'],
      [`${option}+↑ ↓`, 'Move the selected layer forward or back'],
      ['Double-click a layer', 'Rename it'],
      ['Drag a number box sideways', 'Change it; with Shift, finer'],
      ['Click the picture', 'Select the layer there'],
      ['Drag a layer\'s outline, or a corner', 'Move it, or resize it; with Shift, keeping its proportions'],
      ['Backspace', 'Delete the selected layer'],
      [`${command}J`, 'Duplicate the selected layer'],
      [`${command}G, Shift+${command}G`, 'Group the selected layer, ungroup a group'],
      ['Drag a layer onto a group', 'Put it in the group'],
      [`${command.replace(/\+$/, '')}-click, Shift-click a layer`, 'Select several, or a run of them, to group, delete, duplicate or drag together'],
      ['Drag a field up or down', `Change the order fields are filled in; or click it and press ${option}+↑ ↓`],
      ['Click a field, Backspace', 'Remove it'],
      [`${command}Z, Shift+${command}Z`, 'Undo, redo changes to the template'],
    ]],
    ['Everything else', [
      [`${command}Z, Shift+${command}Z`, 'Undo, redo'],
      ['Backspace', 'Delete the track marker last clicked, or else the selected mix; the only mix goes back to the whole recording'],
      ['Tab', 'Switch between the Mastering and the Video view'],
      [`${command}O`, 'Open a recording'],
      [`Shift+${command}W`, 'Close the recording'],
      ['Esc', 'Cancel an analysis or an export'],
      ['? or F1', 'Show this sheet'],
      [`${command},`, 'Settings: the folders for template videos and LUTs, and the check for updates'],
      ['Double-click a mix\'s tab', 'Rename it'],
      ['Rest the pointer on a control', 'See what it does'],
    ]],
  ];
}
