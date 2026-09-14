(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const seat = document.querySelector('[data-composer-seat]');
  const chain = seat.querySelector('[data-slot="conversation.composer"]');
  const hidden = Array.from(chain.children).find(c => getComputedStyle(c).display === 'none');
  const cardRoot = chain.querySelector('[data-approval-key]');
  const out = {};
  out.seatBefore = R(seat);
  out.cardBefore = R(cardRoot);
  if (hidden) {
    hidden.style.display = 'contents';
    void seat.offsetHeight;
    out.seatBoth = R(seat);
    out.cardBoth = R(cardRoot);
    const bar = document.querySelector('[data-slot="conversation.composer.bar"]');
    out.barBoth = R(bar);
    out.inputCardBoth = R(bar ? bar.querySelector('[class*=card]') : null);
    out.inputRootBoth = R(bar ? bar.querySelector('[class*=root]') : null);
    hidden.style.display = 'none';
    void seat.offsetHeight;
  }
  out.seatAfter = R(seat);
  return out;
})()
