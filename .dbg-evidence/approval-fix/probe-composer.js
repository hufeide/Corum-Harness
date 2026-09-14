(() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const out = {};
  const ce = Array.from(document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]'));
  out.composerCandidates = ce.map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 70), rect: rectOf(el), placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '', text: (el.textContent || '').slice(0, 40) }));
  const ta = ce.find(el => el.tagName === 'TEXTAREA') || ce[0];
  if (ta) {
    out.composer = { rect: rectOf(ta), fontSize: getComputedStyle(ta).fontSize };
    out.ancestors = [];
    let p = ta;
    for (let i = 0; i < 10 && p; i++) {
      const s = getComputedStyle(p);
      out.ancestors.push({ tag: p.tagName, cls: String(p.className).slice(0, 80), slot: p.getAttribute && p.getAttribute('data-slot'), position: s.position, zIndex: s.zIndex, overflow: s.overflow, display: s.display, rect: rectOf(p) });
      p = p.parentElement;
    }
  }
  out.bodyText = document.body.innerText.slice(0, 300);
  return out;
})()
