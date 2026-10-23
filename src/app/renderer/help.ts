// The Help window: the manual the app carries (dist/help/, made by
// scripts/build-manual.mjs), under a toolbar of its own. The pages are shown in
// a frame, so that its history is theirs alone: Back and Forward step through
// the pages read, and the toolbar stays put. The search looks through every
// page, using the list of their parts built with them (search.json); the words
// searched for are marked on whatever page is shown, as a browser's find does.
//
// The window has no preload and no way to reach the app: the main process
// keeps it to the manual's own pages, and sends links out of it to the
// browser (`openManual` in main.ts).
import { initTooltips } from './tooltip.ts';

interface Part { id: string; heading: string; text: string }
interface Page { name: string; title: string; parts: Part[] }
interface Found { page: Page; part: Part; score: number }

/** The most results listed at once; past that, more words narrow it. */
const MOST_RESULTS = 30;
/** How much of a part's text a result shows around the first word found. */
const SNIPPET_BEFORE = 50;
const SNIPPET_LENGTH = 180;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>('help-page');
const query = $<HTMLInputElement>('help-query');
const results = $<HTMLUListElement>('help-results');
const back = $<HTMLButtonElement>('help-back');
const forward = $<HTMLButtonElement>('help-forward');

const onMac = navigator.userAgent.includes('Mac');
// The toolbar stands in for the Mac's title bar (insetTitleBar in main.ts).
if (onMac) document.documentElement.dataset.titleBar = 'inset';
/** In full screen the window's buttons are gone, and so is the room kept for them; the main process calls this. */
function setFullScreen(full: boolean) {
  document.documentElement.toggleAttribute('data-full-screen', full);
}
Object.assign(window, { setFullScreen });
// As src/app/shortcuts.ts lists them for the manual: ⌘[ as in a Mac's browsers, Alt+← as in the others', and both everywhere.
back.title = `The page before (${onMac ? '⌘[' : 'Alt+←'})`;
forward.title = `The page after (${onMac ? '⌘]' : 'Alt+→'})`;
query.title = `Search every page of the manual (${onMac ? '⌘F' : 'Ctrl+F'})`;

const params = new URLSearchParams(location.search);
setTheme(params.get('theme') ?? 'dark');
// The page to open at, such as "video" or "layer-types#noise"; the first page otherwise.
const start = /^[\w-]+(#[\w-]+)?$/.test(params.get('page') ?? '') ? params.get('page')! : 'index';
frame.src = pageAddress(start);

const index: Promise<Page[]> = fetch('help/search.json').then((response) => response.json()).catch(() => []);

function pageAddress(page: string): string {
  const [name, part] = page.split('#');
  return new URL(`help/manual/${name}.html${part ? `#${part}` : ''}`, location.href).href;
}

/** Light or dark, as the app is; the main process calls this again when it changes. */
function setTheme(theme: string) {
  const value = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = value;
  // The page shown follows as well; a page opened later asks when it loads (site/manual.html).
  const shown = frame.contentDocument?.documentElement;
  if (shown) shown.dataset.theme = value;
}
Object.assign(window, { setTheme });

// ---------------------------------------------------------------------------
// Moving about

/** The frame's own history, which the Navigation API keeps apart from the window's. */
const frameHistory = () => (frame.contentWindow as (Window & { navigation?: { canGoBack: boolean; canGoForward: boolean; back(): void; forward(): void } }) | null)?.navigation;

function goBack() {
  if (frameHistory()?.canGoBack) frameHistory()!.back();
}
function goForward() {
  if (frameHistory()?.canGoForward) frameHistory()!.forward();
}
function goHome() {
  showPage('index');
}

/** Goes to a page, such as "shortcuts" or "layer-types#noise"; the main process calls this when the app asks for one. */
function showPage(page: string) {
  if (/^[\w-]+(#[\w-]+)?$/.test(page)) frame.contentWindow?.location.assign(pageAddress(page));
}
Object.assign(window, { showPage });

back.addEventListener('click', goBack);
forward.addEventListener('click', goForward);
$('help-home').addEventListener('click', goHome);

/** The keys of the window, which work in the page as well as in the toolbar. */
function onKey(event: KeyboardEvent) {
  const command = onMac ? event.metaKey : event.ctrlKey;
  if (command && (event.code === 'KeyF' || event.code === 'KeyK')) {
    event.preventDefault();
    query.focus();
    query.select();
    return;
  }
  // Alt and an arrow move by a word in the search box, as they do in any text, rather than to another page.
  const arrows = event.altKey && !command && event.target !== query;
  if ((command && event.code === 'BracketLeft') || (arrows && event.code === 'ArrowLeft')) {
    event.preventDefault();
    goBack();
  } else if ((command && event.code === 'BracketRight') || (arrows && event.code === 'ArrowRight')) {
    event.preventDefault();
    goForward();
  }
}

/** A mouse's own back and forward buttons. */
function onMouseButton(event: MouseEvent) {
  if (event.button === 3) goBack();
  else if (event.button === 4) goForward();
}

document.addEventListener('keydown', onKey);
document.addEventListener('mouseup', onMouseButton);

/** What the search should bring the reader to once the page it opens has loaded. */
let arriving: { part: string } | null = null;

frame.addEventListener('load', () => {
  const page = frame.contentDocument;
  if (!page) return;
  // Keys and mouse buttons pressed while reading the page do not reach this document by themselves.
  page.addEventListener('keydown', onKey);
  page.addEventListener('mouseup', onMouseButton);
  // A click in the page closes the list of results, as a click anywhere else would.
  page.addEventListener('mousedown', () => closeResults());
  // A link out of the manual is handed to the main process to open in the browser; the frame itself may
  // only show the manual (the policy in help.html), so following the link there would only fail.
  page.addEventListener('click', (event) => {
    const link = (event.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link || link.href.startsWith(new URL('help/', location.href).href)) return;
    event.preventDefault();
    window.open(link.href);
  });
  document.title = page.title || 'DJ Mix Master Manual';
  back.disabled = !frameHistory()?.canGoBack;
  forward.disabled = !frameHistory()?.canGoForward;
  markFound(arriving?.part);
  arriving = null;
});

// ---------------------------------------------------------------------------
// Searching

/** The words of a search, each to be found somewhere in a part, in any order. */
const wordsOf = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** The parts that have every word, those with the words in their heading first. */
function search(pages: Page[], words: string[]): Found[] {
  if (!words.length) return [];
  const shown = currentPage();
  const found: Found[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    for (const part of page.parts) {
      const heading = part.heading.toLowerCase();
      const text = part.text.toLowerCase();
      if (!words.every((word) => has(heading, word) || has(text, word) || has(title, word))) continue;
      let score = 0;
      for (const word of words) {
        if (has(heading, word)) score += heading.startsWith(word) ? 14 : 10;
        if (has(title, word)) score += 3;
        score += Math.min(wordsAt(text, word).length, 5);
      }
      // A page's opening part stands for the page: it leads the page's results when they are as good.
      if (!part.id) score += 0.5;
      if (page.name === shown) score += 0.25;
      found.push({ page, part, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, MOST_RESULTS);
}

/**
 * Where a word of the search begins a word of the text, in lower case: "eq" finds "EQ" and "EQs" but not
 * "frequency", which would bury what is looked for.
 */
function wordsAt(text: string, word: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) found.push(at);
  }
  return found;
}
const has = (text: string, word: string) => wordsAt(text, word).length > 0;

/** The name of the page shown, as search.json has it. */
function currentPage(): string {
  return /\/help\/manual\/([\w-]+)\.html/.exec(frame.contentWindow?.location.href ?? '')?.[1] ?? '';
}

/** Text with the words in it marked, built as nodes so that nothing in it is read as markup. */
function withMarks(text: string, words: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    let next = -1;
    let length = 0;
    for (const word of words) {
      const i = wordsAt(lower, word).find((place) => place >= at) ?? -1;
      if (i >= 0 && (next < 0 || i < next || (i === next && word.length > length))) {
        next = i;
        length = word.length;
      }
    }
    if (next < 0) break;
    fragment.append(text.slice(at, next));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(next, next + length);
    fragment.append(mark);
    at = next + length;
  }
  fragment.append(text.slice(at));
  return fragment;
}

/** Some of a part's text, from a little before the first word found in it. */
function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const first = Math.min(...words.flatMap((word) => wordsAt(lower, word).slice(0, 1)), Infinity);
  if (first === Infinity) return text.slice(0, SNIPPET_LENGTH);
  let from = Math.max(0, first - SNIPPET_BEFORE);
  // Start on a word.
  if (from > 0) from = text.indexOf(' ', from) + 1 || from;
  return `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET_LENGTH)}`;
}

let found: Found[] = [];
let chosen = 0;

async function showResults() {
  const words = wordsOf(query.value);
  markFound();
  if (!words.length) return closeResults();
  const typed = query.value;
  const pages = await index;
  // A later keystroke has already shown its own.
  if (query.value !== typed) return;
  found = search(pages, words);
  chosen = 0;
  results.replaceChildren();
  if (!found.length) {
    const none = document.createElement('li');
    none.className = 'none';
    none.textContent = pages.length ? 'Nothing in the manual has all of these words' : 'The manual’s search is missing from this copy of the app';
    results.append(none);
  }
  found.forEach((result, i) => {
    const item = document.createElement('li');
    item.setAttribute('role', 'option');
    item.classList.toggle('on', i === chosen);
    const heading = document.createElement('div');
    heading.className = 'heading';
    heading.append(withMarks(result.part.heading, words));
    const where = document.createElement('div');
    where.className = 'where';
    // A part under its page's title; a page's opening part is the page.
    where.textContent = result.part.id ? result.page.title : 'Page';
    const text = document.createElement('div');
    text.className = 'snippet';
    text.append(withMarks(snippet(result.part.text, words), words));
    item.append(where, heading, text);
    // Chosen on mousedown, before the search box loses focus and closes the list.
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      open(result);
    });
    item.addEventListener('mousemove', () => choose(i));
    results.append(item);
  });
  results.hidden = false;
}

function choose(i: number) {
  chosen = Math.max(0, Math.min(found.length - 1, i));
  [...results.children].forEach((item, j) => item.classList.toggle('on', j === chosen));
  results.children[chosen]?.scrollIntoView({ block: 'nearest' });
}

function closeResults() {
  results.hidden = true;
}

/** Shows a result's page at its part, with the words searched for marked. */
function open(result: Found) {
  closeResults();
  const address = pageAddress(result.part.id ? `${result.page.name}#${result.part.id}` : result.page.name);
  const shown = frame.contentWindow;
  if (shown && currentPage() === result.page.name) {
    // The same page: no load to wait for, only a place to go to on it.
    if (result.part.id) shown.location.hash = result.part.id;
    markFound(result.part.id);
  } else {
    arriving = { part: result.part.id };
    shown?.location.assign(address);
  }
}

/**
 * Marks the words of the search on the page shown, and, when a part is given
 * (an id, or '' for the page's opening), shows the first of them there.
 */
function markFound(part?: string) {
  const page = frame.contentDocument;
  const view = frame.contentWindow as (Window & typeof globalThis) | null;
  if (!page || !view?.CSS?.highlights) return;
  const words = wordsOf(query.value);
  const text = page.querySelector('.manual-text') ?? page.body;
  const ranges: Range[] = [];
  if (words.length && text) {
    const walker = page.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const lower = node.data.toLowerCase();
      for (const word of words) {
        for (const at of wordsAt(lower, word)) {
          const range = page.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + word.length);
          ranges.push(range);
        }
      }
    }
  }
  // The page's own Highlight, as the registry of its own window is the one it draws from.
  if (ranges.length) view.CSS.highlights.set('found', new view.Highlight(...ranges));
  else view.CSS.highlights.delete('found');
  if (part === undefined || !ranges.length) return;
  // The first word found from the part's heading on, in the order of the page.
  const heading = part ? page.getElementById(part) : null;
  const after = heading
    ? ranges.filter((range) => heading.compareDocumentPosition(range.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING)
    : ranges;
  const first = after.sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b))[0];
  const element = first?.startContainer.parentElement;
  if (element) element.scrollIntoView({ block: 'center' });
}

query.addEventListener('input', () => void showResults());
query.addEventListener('focus', () => {
  if (query.value.trim()) void showResults();
});
query.addEventListener('blur', closeResults);
query.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (results.hidden) void showResults();
    else choose(chosen + (event.key === 'ArrowDown' ? 1 : -1));
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (found[chosen] && !results.hidden) open(found[chosen]);
    else void showResults();
  }
});

/**
 * Esc, wherever it is pressed in the window: the main process takes it before
 * the page does and asks here first. It closes the list of results, then
 * clears the search and its marks on the page; when there is neither, it says
 * so, and the main process hides the window, as the sheet of shortcuts this
 * replaced was closed.
 */
function escapePressed(): boolean {
  if (!results.hidden) {
    closeResults();
    return true;
  }
  if (query.value) {
    query.value = '';
    markFound();
    return true;
  }
  return false;
}
Object.assign(window, { escapePressed });

initTooltips();
