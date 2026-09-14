(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const seat = document.querySelector('[data-composer-seat]');
  const chain = seat.querySelector('[data-slot="conversation.composer"]');
  const out = { seat: R(seat), viewportH: innerHeight };
  // reveal fallback WITHOUT changing layout: use visibility toggling? we need layout, so temporarily swap display
  const hidden = Array.from(chain.children).find(c => getComputedStyle(c).display === 'none');
  const appr = chain.querySelector('[data-approval-key]');
  if (hidden && appr) {
    // hide the approval root so the seat contains ONLY the composer bar -> real input band
    const apprWrap = appr.parentElement;
    const prevAppr = apprWrap.style.display;
    apprWrap.style.display = 'none';
    hidden.style.display = 'contents';
    void seat.offsetHeight;
    const bar = hidden.querySelector('[data-slot="conversation.composer.bar"]');
    const inputCard = bar ? bar.querySelector('[class*=card]') : null;
    const inputRoot = bar ? bar.querySelector('[class*=root]') : null;
    const ta = hidden.querySelector('[data-composer-input]');
    out.inputOnlySeat = R(seat);
    out.inputOnlyBar = R(bar);
    out.inputOnlyCard = R(inputCard);
    out.inputOnlyRoot = R(inputRoot);
    out.inputOnlyTextarea = R(ta);
    // restore
    hidden.style.display = 'none';
    apprWrap.style.display = prevAppr;
    void seat.offsetHeight;
  }
  out.seatRestored = R(seat);
  out.apprRestored = appr ? R(appr) : null;
  return out;
})()
