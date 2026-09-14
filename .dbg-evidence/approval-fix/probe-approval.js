(() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const card = document.querySelector('[data-approval-key]');
  const out = { approvalPresent: !!card };
  if (card) {
    out.key = card.getAttribute('data-approval-key');
    out.cardRect = rectOf(card);
    const inner = card.firstElementChild;
    out.innerRect = inner ? rectOf(inner) : null;
    out.text = (card.innerText || '').slice(0, 300);
    const cs = inner ? getComputedStyle(inner) : null;
    out.innerStyle = cs ? { position: cs.position, overflow: cs.overflow, zIndex: cs.zIndex } : null;
    out.buttons = Array.from(card.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').trim().slice(0, 20), aria: b.getAttribute('aria-expanded'), title: b.title }));
    out.chevron = !!card.querySelector('button[aria-expanded]');
  }
  out.tail = document.body.innerText.slice(-500);
  return out;
})()
