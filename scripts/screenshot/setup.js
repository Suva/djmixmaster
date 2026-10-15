// Runs inside the app's window, in check mode, to set up the state shown in
// site/screenshot.png: two mixes, fades, bass correction, a stretch raised by
// hand, the tracks of tracks.txt, playing at 12:20, the pointer on a track.
// Made for a recording of about an hour; see scripts/screenshot.mjs.
(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const key = (code, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: extra.key ?? '', bubbles: true, ...extra }));
  const type = (id, value) => { const f = $(id); f.focus(); f.value = value; f.dispatchEvent(new Event('input', { bubbles: true })); f.dispatchEvent(new Event('change', { bubbles: true })); f.blur(); };
  const tabs = () => [...document.querySelectorAll('#mix-tabs .mix-tab')];

  // Two mixes: 0:20 to 29:30, and the rest.
  key('Enter');
  for (let i = 0; i < 4; i++) key('ArrowRight');
  key('KeyI'); await w(200);
  for (let i = 0; i < 58; i++) key('ArrowRight', { shiftKey: true });
  for (let i = 0; i < 2; i++) key('ArrowRight');
  key('KeyE', { metaKey: true }); await w(600);
  tabs()[1].click(); await w(200);
  type('mix-name', 'Peak time'); type('mix-artist', 'Nightshift'); await w(200);
  tabs()[0].click(); await w(200);
  type('mix-name', 'Opening set'); type('mix-artist', 'Nightshift');
  const bass = $('bass'); bass.value = '0.6'; bass.dispatchEvent(new Event('input', { bubbles: true }));
  await w(600);

  // The tracks, from a list with times.
  $('tracks-button').click(); await w(100);
  $('tracks-import').click(); await w(800);
  $('tracks-close').click(); await w(300);

  const detail = $('detail');
  const box = detail.getBoundingClientRect();
  const length = 1750;
  const xAt = (s) => box.left + 48 + (s / length) * (box.width - 48);
  const usable = box.height - 18;
  const waveH = Math.round(usable * 0.38);
  const loudTop = waveH + 10, loudH = Math.round(usable * 0.38) - 10;
  const gainTop = loudTop + loudH + 10, gainH = usable - gainTop;
  const down = (x, y) => detail.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
  const move = (x, y) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  const up = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

  // Fades of 45 seconds at each end.
  down(box.left + 48 + 5, box.top + 28); move(xAt(20), box.top + 28); move(xAt(45), box.top + 28); up(); await w(300);
  down(box.right - 5, box.top + 28); move(xAt(length - 20), box.top + 28); move(xAt(length - 45), box.top + 28); up(); await w(300);

  // A stretch raised by hand, 15:00 to 20:00 of the recording.
  const y = box.top + gainTop + gainH / 2;
  down(xAt(880), y); move(xAt(900), y); move(xAt(1180), y); up(); await w(400);
  down(xAt(1030), y); move(xAt(1030), y - 10); move(xAt(1030), y - 30); up(); await w(400);

  // Playing at 12:38.
  down(xAt(758 - 20), box.top + 200); up();
  detail.dispatchEvent(new MouseEvent('click', { clientX: xAt(758 - 20), clientY: box.top + 200, bubbles: true }));
  await w(200);
  key('Space'); await w(2500);
  // Pointing at the third track's name.
  detail.dispatchEvent(new MouseEvent('mousemove', { clientX: xAt(580) + 20, clientY: box.top + waveH - 8, bubbles: true }));
  await w(800);
  return [$('readout').textContent, tabs().map((t) => t.textContent).join(' | '), $('tracks-button').textContent].join(' || ');
})()
