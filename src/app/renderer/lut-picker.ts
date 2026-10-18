// Choosing among looks: a button showing the one in use, which opens a list to
// search. Looks are compared by eye, so the arrow keys go up and down the
// list, or step through it with the list closed, and each entry is put to use
// as it is reached; the picture changes with it. Escape goes back to the one
// in use when the list was opened. Made for LUTs, and used for blends too.

/** One entry of the list: what a setting would hold, and what it is called. */
export interface LutChoice {
  value: string;
  label: string;
  /** A heading the entry is listed under, such as "LUT folder". */
  group?: string;
}

export interface LutPickerOptions {
  id?: string;
  /** The button's tooltip, and the words for searching and for finding nothing; a LUT's when not given. */
  title?: string;
  placeholder?: string;
  none?: string;
  /** The entries, as they are now. */
  choices(): LutChoice[];
  current: string;
  /** Called for every entry reached, as it is reached. */
  choose(value: string): void;
  /** The button at the foot of the list that adds a file: its words, and what it does. */
  add?: { label: string; run(): void };
}

/** What a value not among the entries is shown as: a file's name, without its folder or extension. */
const nameOf = (value: string) => value.split(/[\\/:]/).pop()!.replace(/\.cube$/i, '') || value;

export function lutPicker(options: LutPickerOptions): HTMLElement {
  let current = options.current;
  const picker = document.createElement('div');
  picker.className = 'lut-picker';
  const button = document.createElement('button');
  button.type = 'button';
  if (options.id) button.id = options.id;
  button.className = 'lut-current';
  button.title = options.title ?? 'Choose a LUT. ↑ and ↓ step through them, each shown on the picture at once.';
  const show = () => {
    const known = options.choices().find((choice) => choice.value === current);
    button.textContent = known ? known.label : nameOf(current);
    button.dataset.value = current;
  };
  show();

  const menu = document.createElement('div');
  menu.className = 'lut-menu';
  menu.hidden = true;
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = options.placeholder ?? 'Search LUTs';
  search.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'lut-list';
  list.setAttribute('role', 'listbox');
  menu.append(search, list);
  const adding = options.add;
  if (adding) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'lut-add';
    add.textContent = adding.label;
    add.addEventListener('click', () => {
      close();
      adding.run();
    });
    menu.append(add);
  }
  picker.append(button, menu);

  /** The entry in use when the list was opened, for Escape. */
  let opened = current;

  const use = (value: string) => {
    if (value === current) return;
    current = value;
    show();
    for (const item of list.querySelectorAll<HTMLElement>('.lut-item')) {
      const on = item.dataset.value === value;
      item.classList.toggle('on', on);
      item.setAttribute('aria-selected', String(on));
      if (on) item.scrollIntoView({ block: 'nearest' });
    }
    options.choose(value);
  };

  const fill = () => {
    const wanted = search.value.trim().toLowerCase();
    const shown = options.choices().filter((choice) => !wanted || choice.label.toLowerCase().includes(wanted));
    const items: HTMLElement[] = [];
    let group: string | undefined;
    for (const choice of shown) {
      if (choice.group !== group && choice.group) {
        const heading = document.createElement('p');
        heading.className = 'lut-group';
        heading.textContent = choice.group;
        items.push(heading);
      }
      group = choice.group;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = choice.value === current ? 'lut-item on' : 'lut-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(choice.value === current));
      item.dataset.value = choice.value;
      item.textContent = choice.label;
      // Not focusable: the keys stay with the search, which moves through the list.
      item.tabIndex = -1;
      item.addEventListener('click', () => {
        use(choice.value);
        close();
        button.focus();
      });
      items.push(item);
    }
    if (!shown.length) {
      const none = document.createElement('p');
      none.className = 'lut-group';
      none.textContent = options.none ?? 'No LUT of that name';
      items.push(none);
    }
    list.replaceChildren(...items);
    list.querySelector<HTMLElement>('.lut-item.on')?.scrollIntoView({ block: 'nearest' });
  };

  /** Moves to the entry `by` places on from the one in use, among those listed; with the list closed, among all. */
  const step = (by: number) => {
    const values = menu.hidden
      ? options.choices().map((choice) => choice.value)
      : [...list.querySelectorAll<HTMLElement>('.lut-item')].map((item) => item.dataset.value!);
    if (!values.length) return;
    const at = values.indexOf(current);
    const next = at < 0 ? (by > 0 ? 0 : values.length - 1) : Math.max(0, Math.min(values.length - 1, at + by));
    use(values[next]);
  };

  const outside = (event: MouseEvent) => {
    if (!picker.contains(event.target as Node)) close();
  };
  function close() {
    menu.hidden = true;
    document.removeEventListener('mousedown', outside);
  }
  function open() {
    opened = current;
    menu.hidden = false;
    search.value = '';
    fill();
    search.focus();
    document.addEventListener('mousedown', outside);
  }
  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    step(event.key === 'ArrowDown' ? 1 : -1);
  });
  search.addEventListener('input', () => fill());
  search.addEventListener('keydown', (event) => {
    // Kept from the window's shortcuts: these keys belong to the list while it is open.
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'PageDown', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'PageDown') step(8);
    else if (event.key === 'PageUp') step(-8);
    else if (event.key === 'Enter' || event.key === 'Escape') {
      if (event.key === 'Escape') use(opened);
      close();
      button.focus();
    }
  });
  return picker;
}
