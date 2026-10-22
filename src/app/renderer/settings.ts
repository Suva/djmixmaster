// The Settings dialog: the choices that belong to the app rather than to a
// recording, each with a word on what it does. They are kept by the main
// process; the dialog shows what it says after each change.

import type { Api, AppSettings, FolderKind } from '../api.ts';
import { setTheme } from './theme.ts';
import { defaultOutputName, deviceFor, outputDevices, type OutputFollower } from './output.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const OUTPUT_NOTE = 'Where you hear playback: headphones, speakers, an audio interface. Exports are not affected.';

export function settingsDialog(api: Api, output: OutputFollower): { open(): void; start(): Promise<void>; readonly element: HTMLDialogElement } {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const updates = $<HTMLInputElement>('settings-updates');
  const outputs = $<HTMLSelectElement>('settings-output');

  /** The outputs there are now, the one chosen among them; one chosen but not plugged in is listed too, as such. */
  const showOutputs = async () => {
    const devices = await outputDevices();
    const standing = await defaultOutputName();
    const choice = output.choice;
    const found = choice ? deviceFor(choice, devices) : null;
    outputs.replaceChildren(
      new Option(standing ? `System default (${standing})` : 'System default', ''),
      ...devices.map((device) => new Option(device.name, device.id)),
      ...(choice && !found ? [new Option(`${choice.name} (not connected)`, choice.id)] : []),
    );
    outputs.value = choice ? (found?.id ?? choice.id) : '';
    $('settings-output-note').textContent =
      choice && !found ? `${choice.name} is not connected, so you hear the system's default output until it is.` : OUTPUT_NOTE;
  };
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (dialog.open) void showOutputs();
  });
  outputs.addEventListener('change', async () => {
    const id = outputs.value;
    const name = outputs.selectedOptions[0]?.text.replace(/ \(not connected\)$/, '') ?? '';
    const choice = id ? { id, name } : null;
    await api.setOutput(choice);
    await output.choose(choice);
    await showOutputs();
  });

  const show = (settings: AppSettings) => {
    for (const [which, prefix, folder, chosen] of [
      ['media', 'settings-media', settings.mediaFolder, settings.mediaFolderChosen],
      ['luts', 'settings-lut', settings.lutFolder, settings.lutFolderChosen],
    ] as const) {
      const path = $(`${prefix}-folder`);
      // Cut at the start when long, where the folder's own name is not: the box runs right to left, and the
      // marks either side keep the path itself reading left to right.
      path.textContent = `\u200e${folder}\u200e`;
      path.title = folder;
      path.dataset.path = folder;
      path.dataset.which = which;
      // Already the app's own: nothing to go back to.
      $<HTMLButtonElement>(`${prefix}-default`).disabled = !chosen;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('#settings-theme button')) {
      button.classList.toggle('on', button.dataset.themeChoice === settings.theme);
    }
    setTheme(settings.theme);
    updates.checked = settings.checkUpdates;
    $('settings-updates-own').hidden = settings.updatesFromStore;
    $('settings-updates-store').hidden = !settings.updatesFromStore;
    $('settings-version').textContent = `You have version ${settings.version}.`;
  };

  const folder = (which: FolderKind, prefix: string) => {
    $(`${prefix}-change`).addEventListener('click', async () => show(await api.chooseFolder(which)));
    $(`${prefix}-show`).addEventListener('click', () => api.showFolder(which));
    $(`${prefix}-default`).addEventListener('click', async () => show(await api.defaultFolder(which)));
  };
  folder('media', 'settings-media');
  folder('luts', 'settings-lut');
  for (const button of document.querySelectorAll<HTMLButtonElement>('#settings-theme button')) {
    button.addEventListener('click', async () => show(await api.setTheme(button.dataset.themeChoice === 'light' ? 'light' : 'dark')));
  }
  updates.addEventListener('change', async () => show(await api.setCheckUpdates(updates.checked)));
  $('settings-check-now').addEventListener('click', () => api.checkUpdatesNow());
  $('settings-close').addEventListener('click', () => dialog.close());

  return {
    element: dialog,
    /** Puts the window in the look last chosen; before anything is shown, so that it never flashes the other. */
    async start() {
      const settings = await api.settings();
      setTheme(settings.theme);
      await output.choose(settings.output);
    },
    async open() {
      show(await api.settings());
      await showOutputs();
      if (!dialog.open) dialog.showModal();
    },
  };
}
