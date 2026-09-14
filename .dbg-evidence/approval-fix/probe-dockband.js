(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const intersect = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const seat = document.querySelector('[data-composer-seat]');
  const chain = document.querySelector('[data-slot="conversation.composer"]');
  const apprRoot = document.querySelector('[data-approval-key]');
  const menu = document.querySelector('[class*=allowMenu]');
  const out = {};
  out.menu = R(menu);
  // Reveal the hidden composer fallback to get the REAL dock band of the input row,
  // then measure intersection, then restore exactly.
  const hidden = Array.from(chain.children).find(c => getComputedStyle(c).display === 'none');
  if (!hidden) { out.error = 'no hidden fallback'; return out }
  const prev = hidden.style.display;
  hidden.style.display = 'contents';
  void seat.offsetHeight;
  const bar = hidden.querySelector('[data-slot="conversation.composer.bar"]');
  const inputRoot = bar ? bar.querySelector('[class*=root]') : null;
  const inputCard = bar ? bar.querySelector('[class*=card]') : null;
  const ta = hidden.querySelector('[data-composer-input]');
  out.dock = { inputRoot: R(inputRoot), inputCard: R(inputCard), inputArea: R(ta) };
  out.seatBoth = R(seat);
  out.cardBoth = R(apprRoot);
  out.menuBoth = R(menu);
  if (menu && ta) out.menuIntersectsInput = intersect(menu.getBoundingClientRect(), ta.getBoundingClientRect());
  if (menu && inputCard) out.menuIntersectsInputCard = intersect(menu.getBoundingClientRect(), inputCard.getBoundingClientRect());
  if (menu && inputRoot) out.menuIntersectsInputRoot = intersect(menu.getBoundingClientRect(), inputRoot.getBoundingClientRect());
  if (apprRoot && ta) out.cardIntersectsInput = intersect(apprRoot.getBoundingClientRect(), ta.getBoundingClientRect());
  if (apprRoot && inputRoot) out.cardIntersectsInputRoot = intersect(apprRoot.getBoundingClientRect(), inputRoot.getBoundingClientRect());
  hidden.style.display = prev;
  void seat.offsetHeight;
  out.restored = { seat: R(seat), menu: R(menu) };
  return out;
})()
