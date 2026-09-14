(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const isVisible = (el) => {
    let p = el;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const seat = document.querySelector('[data-composer-seat]');
  const out = { seat: R(seat) };
  // every visible element inside the seat, shallowest first (BFS) so we see the top-level structure
  const visible = [];
  const q = [seat];
  while (q.length > 0 && visible.length < 60) {
    const el = q.shift();
    if (el !== seat && isVisible(el)) visible.push({ tag: el.tagName, cls: String(el.className).slice(0, 46), slot: el.getAttribute('data-slot'), approval: el.getAttribute('data-approval-key'), rect: R(el) });
    for (const c of el.children) q.push(c);
  }
  out.visibleInSeat = visible;
  // Is there ANY visible composer input anywhere on the page?
  out.visibleComposerInputs = Array.from(document.querySelectorAll('[data-composer-input], textarea')).filter(isVisible).map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 40), rect: R(el) }));
  // hit-test a horizontal scan at the card's vertical band and below
  out.hitScan = [];
  for (const y of [700, 800, 845, 850, 855, 858]) {
    const el = document.elementFromPoint(1080, y);
    out.hitScan.push({ y, tag: el ? el.tagName : null, cls: el ? String(el.className).slice(0, 40) : null, text: el ? (el.innerText || '').trim().slice(0, 18) : null });
  }
  return out;
})()
