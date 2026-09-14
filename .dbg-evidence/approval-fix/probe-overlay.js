(() => {
  const out = {};
  const input = document.querySelector('[data-composer-input]');
  out.chain = [];
  if (input) {
    let p = input;
    for (let i = 0; i < 12 && p; i++) {
      const cs = getComputedStyle(p);
      const r = p.getBoundingClientRect();
      out.chain.push({ tag: p.tagName, cls: String(p.className).slice(0, 60), slot: p.getAttribute && p.getAttribute('data-slot'), overlay: p.getAttribute && p.getAttribute('data-conversation-composer-overlay'), display: cs.display, position: cs.position, overflow: cs.overflow, zIndex: cs.zIndex, w: Math.round(r.width), h: Math.round(r.height) });
      p = p.parentElement;
    }
  }
  // seat children
  const seat = document.querySelector('[data-composer-seat]');
  out.seatChildren = seat ? Array.from(seat.children).map(c => {
    const r = c.getBoundingClientRect();
    return { tag: c.tagName, cls: String(c.className).slice(0, 60), slot: c.getAttribute('data-slot'), display: getComputedStyle(c).display, overflow: getComputedStyle(c).overflow, position: getComputedStyle(c).position, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  }) : null;
  // menu clipping: which ancestors clip it?
  const menu = document.querySelector('[class*=allowMenu]');
  out.menuClippers = [];
  if (menu) {
    const mr = menu.getBoundingClientRect();
    let p = menu.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const clips = cs.overflow !== 'visible';
      const intersects = !(mr.right <= pr.left || mr.left >= pr.right || mr.bottom <= pr.top || mr.top >= pr.bottom);
      if (clips) out.menuClippers.push({ cls: String(p.className).slice(0, 60), overflow: cs.overflow, pr: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height), bottom: Math.round(pr.bottom) }, intersects, mrBottom: Math.round(mr.bottom) });
      p = p.parentElement;
    }
  }
  return out;
})()
