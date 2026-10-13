// The app's own tooltips. The system's take well over a second to appear and
// do not follow the pointer from one button to the next, which makes a row of
// icon buttons hard to explore. These appear after a short pause, and at once
// when moving on from a control that was already showing one.
//
// Controls keep being given an ordinary `title`; it is taken over here.

/** How long the pointer rests on a control before its tooltip appears. */
const SHOW_AFTER_MS = 400;
/** Moving to another control within this time of a tooltip closing shows the next one at once. */
const WARM_FOR_MS = 600;
const GAP_PX = 8;

const TIP = 'tip';

let bubble: HTMLElement;
let current: HTMLElement | null = null;
let pending: ReturnType<typeof setTimeout> | undefined;
let closedAt = -Infinity;

/** Moves a control's `title` out of the system's reach, keeping it as the control's description. */
function adopt(element: HTMLElement) {
  const text = element.getAttribute('title');
  if (text === null) return;
  element.removeAttribute('title');
  if (text) element.dataset[TIP] = text;
  else delete element.dataset[TIP];
  // A control with nothing but an icon was relying on the title for its name.
  if (text && !element.textContent?.trim() && !element.hasAttribute('aria-label')) element.setAttribute('aria-label', text);
  if (element === current) text ? show(element) : hide();
}

function show(target: HTMLElement) {
  current = target;
  bubble.textContent = target.dataset[TIP] ?? '';
  // Shown afresh each time, so it sits above any dialog that opened in between.
  if (bubble.matches(':popover-open')) bubble.hidePopover();
  bubble.showPopover();

  const control = target.getBoundingClientRect();
  const size = bubble.getBoundingClientRect();
  const left = Math.max(GAP_PX, Math.min(window.innerWidth - size.width - GAP_PX, control.left + control.width / 2 - size.width / 2));
  const below = control.bottom + GAP_PX;
  const top = below + size.height + GAP_PX <= window.innerHeight ? below : control.top - GAP_PX - size.height;
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
}

function hide() {
  clearTimeout(pending);
  pending = undefined;
  if (bubble.matches(':popover-open')) {
    bubble.hidePopover();
    closedAt = performance.now();
  }
  current = null;
}

export function initTooltips() {
  bubble = document.createElement('div');
  bubble.id = 'tooltip';
  bubble.popover = 'manual';
  bubble.setAttribute('role', 'tooltip');
  document.body.append(bubble);

  for (const element of document.querySelectorAll<HTMLElement>('[title]')) adopt(element);
  // Titles set later, such as the play button's when it turns into pause.
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === 'attributes') adopt(change.target as HTMLElement);
      for (const added of change.addedNodes) {
        if (!(added instanceof HTMLElement)) continue;
        adopt(added);
        for (const element of added.querySelectorAll<HTMLElement>('[title]')) adopt(element);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('mouseover', (event) => {
    const target = (event.target as Element).closest<HTMLElement>(`[data-${TIP}]`);
    if (target === current) return;
    const warm = current !== null || performance.now() - closedAt < WARM_FOR_MS;
    hide();
    if (!target) return;
    current = target;
    if (warm) show(target);
    else pending = setTimeout(() => show(target), SHOW_AFTER_MS);
  });
  // A press or a key means the control is being used, not read about.
  for (const type of ['mousedown', 'keydown', 'wheel'] as const) {
    document.addEventListener(type, () => {
      hide();
      closedAt = -Infinity;
    }, { capture: true, passive: true });
  }
  document.documentElement.addEventListener('mouseleave', hide);
}
