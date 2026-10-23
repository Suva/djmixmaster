// The small ? beside a panel that opens the manual where that panel is
// explained (src/app/help-topics.ts). Made here for settings built in code;
// those written into the window's markup are buttons with `data-help`.
import { HELP, type HelpTopic } from '../help-topics.ts';

/** A ? that opens the manual at a topic; `about` says what it explains, as in "About masks". */
export function helpLink(topic: HelpTopic, about: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'help-link';
  button.textContent = '?';
  button.title = `${about}, in the manual`;
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', (event) => {
    // Inside a heading that folds (a <summary>), the click must not fold it too.
    event.preventDefault();
    event.stopPropagation();
    window.api.openManual(HELP[topic]);
  });
  return button;
}

/** Makes the ? buttons of the markup, `<button class="help-link" data-help="eq" title=… aria-label=…>`, open their topics. */
export function initHelpLinks() {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-help]')) {
    const topic = button.dataset.help as HelpTopic;
    if (!(topic in HELP)) throw new Error(`A ? in the window's markup names ${topic}, which src/app/help-topics.ts does not have`);
    button.addEventListener('click', () => window.api.openManual(HELP[topic]));
  }
}
