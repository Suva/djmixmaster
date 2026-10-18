// The Settings dialog: the choices that belong to the app rather than to a
// recording, each with a word on what it does. They are kept by the main
// process; the dialog shows what it says after each change.

import type { Api, AppSettings, FolderKind } from '../api.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function settingsDialog(api: Api): { open(): void; readonly element: HTMLDialogElement } {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const updates = $<HTMLInputElement>('settings-updates');

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
    updates.checked = settings.checkUpdates;
    $('settings-version').textContent = `You have version ${settings.version}.`;
  };

  const folder = (which: FolderKind, prefix: string) => {
    $(`${prefix}-change`).addEventListener('click', async () => show(await api.chooseFolder(which)));
    $(`${prefix}-show`).addEventListener('click', () => api.showFolder(which));
    $(`${prefix}-default`).addEventListener('click', async () => show(await api.defaultFolder(which)));
  };
  folder('media', 'settings-media');
  folder('luts', 'settings-lut');
  updates.addEventListener('change', async () => show(await api.setCheckUpdates(updates.checked)));
  $('settings-check-now').addEventListener('click', () => api.checkUpdatesNow());
  $('settings-close').addEventListener('click', () => dialog.close());

  return {
    element: dialog,
    async open() {
      show(await api.settings());
      if (!dialog.open) dialog.showModal();
    },
  };
}
