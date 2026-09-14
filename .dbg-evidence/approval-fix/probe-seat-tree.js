(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const out = {};
  const seat = document.querySelector('[data-composer-seat]');
  const walk = (el, d) => {
    if (d > 3) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, cls: String(el.className).slice(0, 44), slot: el.getAttribute('data-slot'),
      overlay: el.getAttribute('data-conversation-composer-overlay'),
      approval: el.getAttribute('data-approval-key'),
      display: cs.display, position: cs.position, overflow: cs.overflow, zIndex: cs.zIndex,
      fs: cs.fontSize, rect: R(el),
      kids: Array.from(el.children).map(c => walk(c, d + 1)).filter(Boolean),
    };
  };
  out.seatTree = seat ? walk(seat, 0) : null;
  return out;
})()
