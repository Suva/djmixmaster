// Runs inside the app's window, in check mode, and takes the manual's
// pictures with window.api.checkPicture: the window in each view, its dialogs
// and the editor's panels, then every kind of layer drawn on its own from the
// template "Manual pictures" (made by scripts/manual-pictures.mjs, which puts
// its list of layers in place of LAYERS below). Starts from the state of the
// website's picture (scripts/screenshot/setup.js, put in place of SETUP).
(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const until = async (test, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) throw new Error(`Waited too long for ${test}`);
      await w(100);
    }
  };
  const key = (code, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: extra.key ?? '', bubbles: true, ...extra }));
  /** The area round one element, or round several together, with a margin; within the window. */
  const area = (elements, pad) => {
    const rects = [elements].flat().map((e) => e.getBoundingClientRect());
    const left = Math.max(0, Math.min(...rects.map((r) => r.left)) - pad);
    const top = Math.max(0, Math.min(...rects.map((r) => r.top)) - pad);
    const right = Math.min(window.innerWidth, Math.max(...rects.map((r) => r.right)) + pad);
    const bottom = Math.min(window.innerHeight, Math.max(...rects.map((r) => r.bottom)) + pad);
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const take = async (name, elements) => {
    await w(400);
    const dialog = [elements].flat()[0]?.tagName === 'DIALOG';
    await window.api.checkPicture(name, elements ? area(elements, dialog ? 0 : 8) : undefined);
  };
  const playing = () => $('play').classList.contains('playing');
  const taken = [];
  const shot = async (name, element) => {
    await take(name, element);
    taken.push(name);
  };

  // The mastering view, as on the website: two mixes, tracks, a stretch raised by hand.
  await SETUP;
  if (playing()) key('Space');
  await until(() => !playing());
  await shot('window-mastering.png');

  // The dialogs.
  $('checkup').click();
  await until(() => $('checkup-dialog').open);
  await shot('checkup.png', $('checkup-dialog'));
  $('checkup-close').click();
  $('tracks-button').click();
  await until(() => $('tracks-dialog').open);
  await shot('tracks.png', $('tracks-dialog'));
  $('tracks-close').click();
  $('export').click();
  await until(() => $('export-dialog').open);
  document.querySelector('[data-format=mp3]').click();
  await shot('export-audio.png', $('export-dialog'));
  document.querySelector('[data-format=mp4]').click();
  await shot('export-video.png', $('export-dialog'));
  $('export-cancel').click();
  $('open-settings').click();
  await until(() => $('settings-dialog').open);
  await shot('settings.png', $('settings-dialog'));
  $('settings-close').click();

  // The Video view, with a template of the app's, once the music has been listened to.
  $('view-video').click();
  const select = $('template');
  select.value = [...select.options].find((o) => o.text === 'Glitter').value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const picture = $('picture');
  await until(() => picture.dataset.music === 'true', 180_000);
  await w(800);
  await shot('window-video.png');
  document.querySelector('#video-shape [data-shape=vertical]').click();
  await w(800);
  await shot('window-vertical.png');
  document.querySelector('#video-shape [data-shape=landscape]').click();
  await w(500);

  // The template editor, on a copy of it, with the artist's text selected.
  $('template-edit').click();
  await until(() => document.body.classList.contains('editing'));
  const row = (name) => [...document.querySelectorAll('.layer-row')].find((r) => r.querySelector('.layer-name').textContent === name);
  const pick = (r) => {
    r.dispatchEvent(new MouseEvent('mousedown', { clientX: r.getBoundingClientRect().left + 30, clientY: r.getBoundingClientRect().top + 5, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
  pick(row('Artist'));
  await w(500);
  await shot('window-editor.png');
  $('editor-add').click();
  await w(300);
  await shot('add-layer.png', [$('editor-add-menu'), $('editor-add')]);
  key('Escape', { key: 'Escape' });
  document.querySelector('#editor-add-menu .add-menu-search')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await w(200);
  document.querySelector('#editor-layer-top .layer-blend .lut-current').click();
  await w(300);
  await shot('blend.png', [$('editor-layer-top'), document.querySelector('#editor-layer-top .lut-menu')]);
  document.querySelector('#editor-layer-top .lut-menu input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await w(200);
  // A setting that moves with the music: its "Moves with…" panel, then written as an expression.
  const size = document.querySelector('#editor-layer .setting[data-key="size"]');
  size.scrollIntoView({ block: 'center' });
  size.querySelector('.motion-button').click();
  await w(400);
  await shot('moves-with.png', document.querySelector('#editor-layer .setting[data-key="size"]'));
  // Closed again with its button, for the formula on its own.
  document.querySelector('#editor-layer .setting[data-key="size"] .motion-button').click();
  await w(300);
  const sizeNow = document.querySelector('#editor-layer .setting[data-key="size"]');
  if (!sizeNow.querySelector('.expr-input')) sizeNow.querySelector('.fx:not(.motion-button)').click();
  await w(200);
  const expression = document.querySelector('#editor-layer .setting[data-key="size"] .expr-input');
  expression.value = '6 + 1.5 * smooth(bass, 0.02, 0.3)';
  expression.dispatchEvent(new Event('input', { bubbles: true }));
  await w(400);
  await shot('expression.png', document.querySelector('#editor-layer .setting[data-key="size"]'));
  // The layer styles, one open.
  const styles = [...document.querySelectorAll('#editor-layer summary')].find((s) => s.textContent.startsWith('Drop shadow'));
  styles.parentElement.open = true;
  styles.scrollIntoView({ block: 'center' });
  await shot('styles.png', styles.parentElement);
  styles.parentElement.open = false;
  $('editor-tab-fields').click();
  await shot('fields.png', $('editor-fields-pane'));
  $('editor-tab-about').click();
  await shot('about.png', $('editor-about-pane'));
  $('editor-tab-layers').click();
  $('editor-done').click();
  await w(300);

  // Every kind of layer on its own, from the template made for it, while the music plays: the spectrum's bars
  // and the trails build up frame by frame.
  $('template-import').click();
  await until(() => select.selectedOptions[0]?.text === 'Manual pictures');
  await w(1000);
  const field = $('field-n');
  key('Space');
  await until(playing);
  for (const [index, type] of LAYERS.entries()) {
    field.value = String(index + 1);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await w(type === 'trails' ? 2000 : 1200);
    await shot(`layer-${type}.jpg`, picture);
  }
  key('Space');
  return taken.join(' ');
})()
