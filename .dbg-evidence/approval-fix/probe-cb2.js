(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const appr = document.querySelector('[data-approval-key]');
  const card = appr ? appr.firstElementChild : null;
  const out = { cardFound: !!card };
  if (!card) return out;
  out.cardRect = R(card);
  const cs = getComputedStyle(card);
  out.card = { position: cs.position, backdropFilter: cs.backdropFilter, filter: cs.filter, transform: cs.transform, willChange: cs.willChange, contain: cs.contain, perspective: cs.perspective, overflow: cs.overflow, zIndex: cs.zIndex };
  // fixed probe INSIDE the card: does backdrop-filter capture it?
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;';
  card.appendChild(p);
  out.fixedProbeInCard = R(p);
  p.remove();
  // fixed probe in body baseline
  const p2 = document.createElement('div');
  p2.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;';
  document.body.appendChild(p2);
  out.fixedProbeInBody = R(p2);
  p2.remove();
  // absolute up-flip probe inside the card (the proposed fix)
  const p3 = document.createElement('div');
  p3.style.cssText = 'position:absolute;bottom:calc(100% + 8px);right:14px;width:129px;height:86px;';
  card.appendChild(p3);
  out.absoluteUpProbe = R(p3);
  p3.remove();
  return out;
})()
