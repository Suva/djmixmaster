// The Fields tab of the template editor: what someone using the template fills
// in, one card per field in the order they are shown, with its label, its kind,
// the name settings use it by, and its default. A field's name is changed only
// once it will do, and then wherever the template uses it. Cards are dragged
// into another order; a card clicked has the keys, and Delete removes it.

import { MUSIC_NAMES } from '../../visuals/music.ts';
import {
  ASSET_PREFIX, fieldNameProblem, LUT_PREFIX, MEDIA_PREFIX, RECORDING_VIDEO, renameField, TEXT_VARIABLES, type Field, type FieldKind, type MediaFile, type Template,
} from '../../visuals/template.ts';
import type { PackedLut } from '../../visuals/lut.ts';
import type { FolderLut } from '../api.ts';
import { freeName, keptLutName, lutChoices } from './layer-settings.ts';
import { lutPicker } from './lut-picker.ts';
import { fontPicker } from './font-picker.ts';
import { scrubbableInput } from './scrub.ts';
import { colourInput } from './colour-input.ts';

export interface FieldsEditorContext {
  /** The template as it is now. */
  template(): Template;
  /**
   * Makes a change; `kind` merges changes of the same kind made in quick
   * succession into one undo step. With `rebuild`, the cards are made anew
   * after, for a change to what there is rather than to a value, and the card
   * at `focus` is given the keys.
   */
  change(kind: string, apply: (template: Template) => void, rebuild?: boolean, focus?: number): void;
  /** A field was renamed: what the mix filled in goes under the new name. */
  renamed(from: string, to: string): void;
  /** Asks for a picture file and gives its name and contents as a data URL, or null. */
  pickPicture(): Promise<{ name: string; data: string } | null>;
  /** Asks for a video file and makes it one a template can keep: its name, and where it is; or null. */
  pickVideo(): Promise<{ name: string; file: MediaFile } | null>;
  /** Asks for a .cube file and gives its name and the LUT packed; null if none, or it cannot be read. */
  pickLut(): Promise<{ name: string; lut: PackedLut } | null>;
  /** The LUTs in the LUT folder, as last looked at. */
  folderLuts(): FolderLut[];
}

export const FIELD_KINDS: [FieldKind, string][] = [
  ['colour', 'Colour'], ['number', 'Number'], ['text', 'Text'], ['image', 'Picture'], ['video', 'Video'], ['lut', 'LUT'], ['font', 'Font'], ['choice', 'List'],
];

/** A field of a kind as it starts: a default that does something. */
export function newField(kind: FieldKind, key: string): Field {
  const label = FIELD_KINDS.find(([k]) => k === kind)![1];
  switch (kind) {
    case 'colour': return { key, label, kind, default: '#3ddc97' };
    case 'number': return { key, label, kind, default: 1, min: 0, max: 2 };
    case 'choice': return { key, label, kind, default: 'one', choices: ['one', 'two', 'three'] };
    case 'font': return { key, label, kind, default: 'Inter' };
    default: return { key, label, kind, default: '' };
  }
}

/** A name for a new field of a kind that the template does not have yet: colour2, say. */
export function freeFieldName(template: Template, kind: FieldKind): string {
  for (let n = 1; ; n++) {
    const name = `${kind}${n}`;
    if (!fieldNameProblem(template, name, MUSIC_NAMES, TEXT_VARIABLES)) return name;
  }
}

/** Movement under this many pixels is a click, not a drag. */
const DRAG_START_PX = 4;

/** What a press on a card leaves alone, to do what it does: typing, choosing, clicking. */
const CONTROLS = 'input, select, textarea, button, .font-picker, .lut-picker';

/** The cards of a template's fields; with `focus`, that card has the keys. */
export function fieldsEditor(context: FieldsEditorContext, focus?: number): HTMLElement {
  const list = document.createElement('div');
  list.className = 'field-cards';
  const fields = context.template().fields;
  if (fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'editor-empty';
    empty.textContent = 'No fields: this template shows the same for every mix. Add one below.';
    list.append(empty);
  }
  fields.forEach((field, index) => list.append(card(field, index, context)));
  // Once in the page; until then it cannot take the keys.
  if (focus !== undefined) requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('.field-card')[focus]?.focus());
  return list;
}

/** Moves the field at `from` to `to`, and the keys go with it. */
function moveField(context: FieldsEditorContext, from: number, to: number) {
  if (to === from || to < 0 || to >= context.template().fields.length) return;
  context.change('', (template) => {
    const [moved] = template.fields.splice(from, 1);
    template.fields.splice(to, 0, moved);
  }, true, to);
}

function removeField(context: FieldsEditorContext, index: number) {
  const left = context.template().fields.length - 1;
  context.change('', (template) => template.fields.splice(index, 1), true, left ? Math.min(index, left - 1) : undefined);
}

/**
 * Dragging a card to another place in the list: the line shows where it goes,
 * above or below the card under the pointer. Let go without a drag, it is
 * just clicked, and has the keys.
 */
function dragCard(down: MouseEvent, box: HTMLElement, index: number, context: FieldsEditorContext) {
  const list = box.parentElement!;
  let dragging = false;
  let to: number | null = null;
  const marks = ['drop-above', 'drop-below'];
  const move = (event: MouseEvent) => {
    if (!dragging && Math.abs(event.clientY - down.clientY) < DRAG_START_PX) return;
    dragging = true;
    box.classList.add('dragging');
    const cards = [...list.querySelectorAll<HTMLElement>('.field-card')];
    for (const c of cards) c.classList.remove(...marks);
    // The place among all the cards, before any is taken out: 0 above the first, cards.length below the last.
    let at = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return event.clientY < r.top + r.height / 2; });
    if (at === -1) at = cards.length;
    to = at > index ? at - 1 : at;
    if (to === index) return;
    if (at < cards.length) cards[at].classList.add('drop-above');
    else cards.at(-1)!.classList.add('drop-below');
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    for (const c of list.querySelectorAll('.field-card')) c.classList.remove(...marks, 'dragging');
    if (dragging && to !== null) moveField(context, index, to);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function card(field: Field, index: number, context: FieldsEditorContext): HTMLElement {
  const box = document.createElement('div');
  box.className = 'field-card';
  box.dataset.key = field.key;
  box.tabIndex = 0;
  box.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || (event.target as Element).closest(CONTROLS)) return;
    // No text is selected on the way, and the card, not what was under the pointer, has the keys.
    event.preventDefault();
    box.focus();
    dragCard(event, box, index, context);
  });
  box.addEventListener('keydown', (event) => {
    if (event.target !== box) return;
    // Keys on a card belong to the list: they must not reach the window, where Delete removes a layer.
    if (event.key === 'Backspace' || event.key === 'Delete') removeField(context, index);
    else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) moveField(context, index, index + (event.key === 'ArrowUp' ? -1 : 1));
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  const set = (kind: string, apply: (field: Field) => void, rebuild = false) =>
    context.change(`field:${index}:${kind}`, (template) => apply(template.fields[index]), rebuild);

  // A handle to drag it by, label, kind, and removing.
  const top = document.createElement('div');
  top.className = 'field-top';
  const grip = document.createElement('span');
  grip.className = 'field-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.title = `Drag the card to move the field. Click the card, then Delete removes it, and ${navigator.platform.startsWith('Mac') ? 'Option' : 'Alt'}+↑ ↓ moves it.`;
  grip.innerHTML = '<svg viewBox="0 0 8 14"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>';
  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'field-label';
  label.value = field.label;
  label.title = 'What it is called where it is filled in';
  label.spellcheck = false;
  label.addEventListener('input', () => set('label', (f) => (f.label = label.value.trim() || f.key)));
  const kind = document.createElement('select');
  kind.className = 'field-kind';
  for (const [value, text] of FIELD_KINDS) kind.add(new Option(text, value));
  kind.value = field.kind;
  kind.title = 'What kind of thing is filled in';
  kind.addEventListener('change', () => set('', (f) => {
    const fresh = newField(kind.value as FieldKind, f.key);
    for (const key of ['min', 'max', 'choices'] as const) delete f[key];
    Object.assign(f, { kind: fresh.kind, default: fresh.default }, fresh.min !== undefined ? { min: fresh.min, max: fresh.max } : {}, fresh.choices ? { choices: fresh.choices } : {});
  }, true));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon';
  remove.textContent = '×';
  remove.title = 'Remove this field (Delete). Settings that use it will say so.';
  remove.setAttribute('aria-label', 'Remove this field');
  remove.addEventListener('click', () => removeField(context, index));
  top.append(grip, label, kind, remove);

  // The name settings use it by.
  const nameRow = document.createElement('div');
  nameRow.className = 'field-name-row';
  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'Name';
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'field-key';
  name.value = field.key;
  name.spellcheck = false;
  const usage = document.createElement('span');
  usage.className = 'field-usage';
  const showUsage = (key: string) => {
    usage.textContent = field.kind === 'number' || field.kind === 'colour' ? `in expressions: ${key}` : `in texts and settings: %${key}%`;
  };
  showUsage(field.key);
  const problem = document.createElement('p');
  problem.className = 'setting-problem';
  name.addEventListener('input', () => {
    const wrong = fieldNameProblem(context.template(), name.value, MUSIC_NAMES, TEXT_VARIABLES, field.key);
    problem.textContent = wrong ?? '';
    if (!wrong) showUsage(name.value);
  });
  // Renamed only on leaving the field, and only to a name that will do: half a name would rename every use on the way.
  name.addEventListener('change', () => {
    const from = field.key;
    const to = name.value;
    if (to === from) return;
    if (fieldNameProblem(context.template(), to, MUSIC_NAMES, TEXT_VARIABLES, from)) {
      name.value = from;
      problem.textContent = '';
      showUsage(from);
      return;
    }
    context.change('', (template) => renameField(template, from, to), true);
    context.renamed(from, to);
  });
  nameRow.append(nameLabel, name, usage);
  box.append(top, nameRow, problem, defaults(field, set, context));
  return box;
}

/** The default of a field, with what its kind also needs: a number's range, a list's choices. */
function defaults(field: Field, set: (kind: string, apply: (field: Field) => void, rebuild?: boolean) => void, context: FieldsEditorContext): HTMLElement {
  const box = document.createElement('div');
  box.className = 'field-default';
  const row = (title: string, ...controls: HTMLElement[]) => {
    const line = document.createElement('label');
    line.className = 'field-line';
    const text = document.createElement('span');
    text.textContent = title;
    line.append(text, ...controls);
    return line;
  };
  const numberInput = (value: number | undefined, onChange: (value: number) => void) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = String(value ?? 0);
    input.addEventListener('input', () => {
      if (input.value !== '' && Number.isFinite(Number(input.value))) onChange(Number(input.value));
    });
    // A field's numbers have no range to go by: a small step, finer with Shift.
    scrubbableInput(input, 0.01);
    return input;
  };

  switch (field.kind) {
    case 'colour': {
      const input = colourInput(String(field.default), (hex) => set('default', (f) => (f.default = hex)), 'Default colour');
      box.append(row('Default', input.element));
      break;
    }
    case 'number': {
      box.append(
        row('From', numberInput(field.min, (v) => set('min', (f) => (f.min = v)))),
        row('To', numberInput(field.max, (v) => set('max', (f) => (f.max = v)))),
        row('Default', numberInput(Number(field.default), (v) => set('default', (f) => (f.default = v)))),
      );
      break;
    }
    case 'text': {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = String(field.default);
      input.spellcheck = false;
      input.addEventListener('input', () => set('default', (f) => (f.default = input.value)));
      box.append(row('Default', input));
      break;
    }
    case 'choice': {
      const choices = document.createElement('input');
      choices.type = 'text';
      choices.value = (field.choices ?? []).join(', ');
      choices.title = 'The choices, with commas between them';
      choices.spellcheck = false;
      const select = document.createElement('select');
      const fill = (options: string[], current: string) => {
        select.replaceChildren(...options.map((option) => new Option(option, option)));
        select.value = options.includes(current) ? current : options[0] ?? '';
      };
      fill(field.choices ?? [], String(field.default));
      choices.addEventListener('input', () => {
        const options = choices.value.split(',').map((choice) => choice.trim()).filter(Boolean);
        fill(options, select.value);
        set('choices', (f) => Object.assign(f, { choices: options, default: select.value }));
      });
      select.addEventListener('change', () => set('default', (f) => (f.default = select.value)));
      box.append(row('Choices', choices), row('Default', select));
      break;
    }
    case 'image': {
      const select = document.createElement('select');
      select.add(new Option('None', ''));
      for (const name of Object.keys(context.template().assets ?? {})) select.add(new Option(`Packed: ${name}`, ASSET_PREFIX + name));
      select.add(new Option('Add a picture…', '+'));
      select.value = String(field.default);
      select.addEventListener('change', async () => {
        if (select.value !== '+') return set('default', (f) => (f.default = select.value));
        select.value = String(field.default);
        const picked = await context.pickPicture();
        if (!picked) return;
        const taken = new Set(Object.keys(context.template().assets ?? {}));
        let name = picked.name;
        for (let n = 2; taken.has(name); n++) name = `${picked.name} ${n}`;
        context.change('', (template) => {
          template.assets = { ...template.assets, [name]: picked.data };
          template.fields.find((f) => f.key === field.key)!.default = ASSET_PREFIX + name;
        }, true);
      });
      box.append(row('Default', select));
      break;
    }
    case 'video': {
      const select = document.createElement('select');
      select.add(new Option('None', ''));
      select.add(new Option('The recording, when it is a video', RECORDING_VIDEO));
      for (const name of Object.keys(context.template().media ?? {})) select.add(new Option(`Kept: ${name}`, MEDIA_PREFIX + name));
      select.add(new Option('Add a video…', '+'));
      select.value = String(field.default);
      select.addEventListener('change', async () => {
        if (select.value !== '+') return set('default', (f) => (f.default = select.value));
        select.value = String(field.default);
        const picked = await context.pickVideo();
        if (!picked) return;
        const name = freeName(picked.name, Object.keys(context.template().media ?? {}));
        context.change('', (template) => {
          template.media = { ...template.media, [name]: picked.file };
          template.fields.find((f) => f.key === field.key)!.default = MEDIA_PREFIX + name;
        }, true);
      });
      box.append(row('Default', select));
      break;
    }
    case 'lut': {
      // Its default is kept in the template or in the LUT folder; what is chosen for a mix is any of those, or a file.
      box.append(row('Default', lutPicker({
        id: `field-default-${field.key}`,
        current: String(field.default),
        choices: () => [{ value: '', label: 'None' }, ...lutChoices(context.template(), context.folderLuts())],
        choose: (value) => set('default', (f) => (f.default = value)),
        add: {
          label: 'Add a .cube file…',
          run: async () => {
            const picked = await context.pickLut();
            if (!picked) return;
            const { name, known } = keptLutName(context.template(), picked);
            context.change('', (template) => {
              if (!known) template.luts = { ...template.luts, [name]: picked.lut };
              template.fields.find((f) => f.key === field.key)!.default = LUT_PREFIX + name;
            }, true);
          },
        },
      })));
      break;
    }
    case 'font': {
      box.append(row('Default', fontPicker(`field-default-${field.key}`, String(field.default), () => 'Aa Bb 123', (family) => set('default', (f) => (f.default = family)))));
      break;
    }
  }
  return box;
}
