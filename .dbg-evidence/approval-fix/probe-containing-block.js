(() => {
  const card = document.querySelector('[class*=card]');
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; };
  const out = { cardRect: card ? R(card) : null };
  const cardCS = card ? getComputedStyle(card) : null;
  out.cardBackdrop = cardCS ? cardCS.backdropFilter : null;
  // does .card (backdrop-filter) create a containing block for position:fixed?
  if (card) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;';
    card.appendChild(probe);
    out.fixedProbeRectInsideCard = R(probe);
    probe.remove();
    const probe2 = document.createElement('div');
    probe2.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;';
    document.body.appendChild(probe2);
    out.fixedProbeRectInBody = R(probe2);
    probe2.remove();
  }
  // absolute probe inside card, anchored bottom:100%
  if (card) {
    const p3 = document.createElement('div');
    p3.style.cssText = 'position:absolute;bottom:calc(100% + 8px);right:14px;width:129px;height:86px;';
    card.appendChild(p3);
    out.absoluteUpProbeRect = (() => { const r = p3.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), bottom: Math.round(r.bottom), right: Math.round(r.right) } })();
    p3.remove();
  }
  return out;
})()
