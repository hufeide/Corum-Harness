(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const out = {};
  const seat = document.querySelector('[data-composer-seat]');
  out.seat = seat ? R(seat) : null;
  // find the hidden fallback subtree under the composer chain
  const chain = seat ? seat.querySelector('[data-slot="conversation.composer"]') : null;
  out.chainKids = chain ? Array.from(chain.children).map(c => ({ cls: String(c.className).slice(0, 50), display: getComputedStyle(c).display, rect: R(c) })) : null;
  // locate the hidden fallback (contains the composer bar) and reveal it transiently to measure the input row band
  const hidden = chain ? Array.from(chain.children).find(c => getComputedStyle(c).display === 'none') : null;
  out.hiddenFound = !!hidden;
  if (hidden) {
    const prev = hidden.style.display;
    hidden.style.display = 'contents';
    const bar = hidden.querySelector('[data-slot="conversation.composer.bar"]');
    const root = bar ? bar.querySelector('[class*=root]') : null;
    const cardEl = bar ? bar.querySelector('[class*=card]') : null;
    out.revealed = {
      bar: bar ? R(bar) : null,
      inputRoot: root ? R(root) : null,
      inputCard: cardEl ? R(cardEl) : null,
    };
    hidden.style.display = prev;
  }
  // also: the seat's own bottom band
  out.seatBottom = seat ? Math.round(seat.getBoundingClientRect().bottom) : null;
  return out;
})()
