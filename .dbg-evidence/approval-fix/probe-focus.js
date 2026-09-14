(() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const out = {};
  const ce = document.querySelector('[contenteditable="true"]');
  out.found = !!ce;
  if (!ce) { out.body = document.body.innerText.slice(0, 400); return out; }
  out.rect = rectOf(ce);
  out.attrs = Array.from(ce.attributes).map(a => a.name + '=' + String(a.value).slice(0, 50));
  out.placeholder = ce.getAttribute('placeholder') || ce.getAttribute('data-placeholder') || ce.getAttribute('aria-placeholder') || '';
  out.focusable = ce.tabIndex;
  ce.focus();
  out.focused = document.activeElement === ce;
  // access mode button
  const modeBtn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('访问模式'));
  out.accessMode = modeBtn ? modeBtn.getAttribute('aria-label') : null;
  // agent chip present?
  out.agentChips = Array.from(document.querySelectorAll('button')).filter(b => /Agent|Agent$/i.test(b.getAttribute('aria-label') || '')).map(b => b.getAttribute('aria-label'));
  out.textSoFar = ce.textContent;
  return out;
})()
