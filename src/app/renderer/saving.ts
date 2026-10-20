// Saves made a moment after the last change, so that typing or dragging
// writes once rather than on every step. How many saves are waiting, or are
// still being written, is kept on the page as `data-saving` for scripted
// checks: `page.saved()` in the window tests waits for it to come to 0
// rather than for a time that a slow computer may overrun.

const due = new Map<string, ReturnType<typeof setTimeout>>();
let writing = 0;

function show() {
  document.documentElement.dataset.saving = String(due.size + writing);
}

/** Calls `save` `ms` after the last call with the same `key`, in place of the one waiting. */
export function saveLater(key: string, save: () => unknown, ms = 400) {
  clearTimeout(due.get(key));
  due.set(key, setTimeout(() => {
    due.delete(key);
    save();
    show();
  }, ms));
  show();
}

/** Whether a save of `key` is waiting. */
export function saveDue(key: string): boolean {
  return due.has(key);
}

/** Drops the save of `key` that is waiting, if any, as it is being made now instead. */
export function cancelSave(key: string) {
  clearTimeout(due.get(key));
  if (due.delete(key)) show();
}

/** Counts a write as unfinished until it is done. */
export function written<T>(write: Promise<T>): Promise<T> {
  writing++;
  show();
  return write.finally(() => {
    writing--;
    show();
  });
}
