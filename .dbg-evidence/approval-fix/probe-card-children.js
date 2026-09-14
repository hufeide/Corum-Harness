(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const card = document.querySelector('[data-approval-key]');
  const cardBox = card ? card.firstElementChild : null;
  const out = { cardChildren: [] };
  if (cardBox) {
    out.cardChildren = Array.from(cardBox.children).map(c => ({
      tag: c.tagName, cls: String(c.className), rect: R(c), text: (c.innerText || '').trim().slice(0, 40),
      pos: getComputedStyle(c).position, transform: getComputedStyle(c).transform, zIndex: getComputedStyle(c).zIndex,
      scrollH: c.scrollHeight, clientH: c.clientHeight,
    }));
  }
  const chev = cardBox ? cardBox.querySelector('button[aria-expanded]') : null;
  out.chevExpanded = chev ? chev.getAttribute('aria-expanded') : null;
  out.chevRect = chev ? R(chev) : null;
  out.chevHTML = chev ? chev.outerHTML.slice(0, 200) : null;
  return out;
})()
