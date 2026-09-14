(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const out = { viewport: { w: innerWidth, h: innerHeight } };
  // any dialog / modal open?
  out.dialogs = Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true]')).map(d => ({ cls: String(d.className).slice(0, 50), rect: R(d), text: (d.innerText || '').slice(0, 60) }));
  // approval card + its ancestor chain with classes
  const appr = document.querySelector('[data-approval-key]');
  out.apprChain = [];
  if (appr) {
    let p = appr;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      out.apprChain.push({ cls: String(p.className).slice(0, 50), slot: p.getAttribute('data-slot'), role: p.getAttribute('role'), rect: R(p), display: cs.display, position: cs.position, overflow: cs.overflow, zIndex: cs.zIndex });
      p = p.parentElement;
    }
  }
  // ALL composer inputs (any lane) with visibility
  out.allComposerInputs = Array.from(document.querySelectorAll('[data-composer-input]')).map(el => {
    const cs = getComputedStyle(el);
    let vis = true, p = el;
    while (p && p !== document.documentElement) { if (getComputedStyle(p).display === 'none') { vis = false; break } p = p.parentElement }
    return { rect: R(el), display: cs.display, visibleInTree: vis };
  });
  // composer seat + its subtree visibility
  const seat = document.querySelector('[data-composer-seat]');
  out.seatRect = seat ? R(seat) : null;
  out.seatKids = seat ? Array.from(seat.querySelectorAll('*')).slice(0, 40).filter(e => { const c = getComputedStyle(e); return c.display !== 'none' }).map(e => ({ cls: String(e.className).slice(0, 40), rect: R(e) })).filter(x => x.rect.w > 0) : null;
  // what is at the bottom center of the viewport (point probe)?
  const el = document.elementFromPoint(700, 840);
  out.atBottomCenter = el ? { cls: String(el.className).slice(0, 50), tag: el.tagName, text: (el.innerText || '').slice(0, 40) } : null;
  return out;
})()
