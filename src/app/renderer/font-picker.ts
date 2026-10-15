// Choosing a font for a video's text: a button showing the font in use, which
// opens a searchable list. Each name is written in its own font, under a
// line of the text it will set, so fonts can be compared at a glance. The
// fonts that come with the app are listed first, then those on this computer.

import { BUNDLED_FAMILIES, BUNDLED_FONTS, fontStack, installedFamilies, loadFonts } from '../../visuals/fonts.ts';
import { FONTS } from '../../visuals/template.ts';

/** The system faces every computer has, by the names templates use for them. */
const SYSTEM_FACES = Object.keys(FONTS);

export function fontPicker(id: string, current: string, sample: () => string, choose: (family: string) => void): HTMLElement {
  const picker = document.createElement('div');
  picker.className = 'font-picker';
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = 'font-current';
  const show = (family: string) => {
    button.textContent = family;
    button.style.fontFamily = fontStack(family);
  };
  show(current);
  loadFonts([current]);

  const menu = document.createElement('div');
  menu.className = 'font-menu';
  menu.hidden = true;
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search fonts';
  search.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'font-list';
  menu.append(search, list);
  picker.append(button, menu);

  const item = (family: string) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = family === current ? 'font-item on' : 'font-item';
    option.dataset.family = family;
    const name = document.createElement('span');
    name.className = 'font-name';
    name.textContent = family;
    const line = document.createElement('span');
    line.className = 'font-sample';
    line.textContent = sample();
    line.style.fontFamily = fontStack(family);
    option.append(line, name);
    option.addEventListener('click', () => {
      current = family;
      show(family);
      close();
      choose(family);
    });
    return option;
  };
  const group = (title: string) => {
    const heading = document.createElement('p');
    heading.className = 'font-group';
    heading.textContent = title;
    return heading;
  };

  const fill = async () => {
    await loadFonts(BUNDLED_FAMILIES);
    const installed = await installedFamilies();
    const wanted = search.value.trim().toLowerCase();
    const matches = (family: string) => !wanted || family.toLowerCase().includes(wanted);
    const bundled = BUNDLED_FAMILIES.filter(matches);
    const system = SYSTEM_FACES.filter(matches);
    const own = installed.filter((family) => matches(family) && !BUNDLED_FAMILIES.includes(family));
    const kinds = new Map(BUNDLED_FONTS.map((font) => [font.family, font.kind]));
    list.replaceChildren(
      ...(bundled.length ? [group('Comes with the app'), ...bundled.map((family) => {
        const option = item(family);
        option.title = `${kinds.get(family)}. Looks the same on every computer.`;
        return option;
      })] : []),
      ...(system.length ? [group('Plain faces'), ...system.map(item)] : []),
      ...(own.length ? [group('On this computer'), ...own.map((family) => {
        const option = item(family);
        option.title = 'Installed on this computer. On another, the video would use a plain face instead.';
        return option;
      })] : []),
    );
    if (!list.children.length) list.append(group('No font of that name'));
  };

  const outside = (event: MouseEvent) => {
    if (!picker.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
  function close() {
    menu.hidden = true;
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', escape);
  }
  button.addEventListener('click', () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    search.value = '';
    fill();
    search.focus();
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
  });
  search.addEventListener('input', () => fill());
  return picker;
}
