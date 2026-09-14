(() => {
  const b = document.querySelector('[data-approval-scroll]');
  if (!b) return JSON.stringify({ error: 'no body' });
  const cs = getComputedStyle(b);
  const out = {
    maxHeight: cs.maxHeight,
    overflowY: cs.overflowY,
    boxSizing: cs.boxSizing,
    before: { h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight, clientH: b.clientHeight },
  };
  // stress: inject a long reason to prove the cap + internal scroll (not external bleed)
  const kid = b.querySelector('[class*=headline]');
  const prev = kid.textContent;
  kid.textContent = '长文本压力测试 long reason line. '.repeat(200);
  const card = document.querySelector('[data-approval-key]').firstElementChild;
  const seat = document.querySelector('[data-composer-seat]');
  out.stressed = {
    bodyH: Math.round(b.getBoundingClientRect().height),
    bodyScrollable: b.scrollHeight > b.clientHeight,
    scrollHeight: b.scrollHeight,
    clientHeight: b.clientHeight,
    cardBottom: Math.round(card.getBoundingClientRect().bottom),
    seatBottom: Math.round(seat.getBoundingClientRect().bottom),
    cardWithinSeat: card.getBoundingClientRect().bottom <= seat.getBoundingClientRect().bottom,
    cardTop: Math.round(card.getBoundingClientRect().top),
    inViewport: card.getBoundingClientRect().top >= 0,
  };
  kid.textContent = prev;
  return JSON.stringify(out, null, 1);
})()
