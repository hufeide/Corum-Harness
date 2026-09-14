(() => {
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const btn = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').includes('新建会话'));
  if (!btn) return { ok: false, reason: 'new-session button not found', buttons: Array.from(document.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)) };
  btn.click();
  return { ok: true, clicked: btn.getAttribute('aria-label'), rect: rectOf(btn) };
})()
