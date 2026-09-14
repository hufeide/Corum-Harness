(() => {
  const out = {};
  out.keysOfWindow = Object.keys(window).filter(k => /corum|dsh|rpc|remote|connection/i.test(k));
  out.corumDesktop = typeof window.corumDesktop === 'object' && window.corumDesktop !== null ? Object.keys(window.corumDesktop) : String(window.corumDesktop);
  out.slotRegistry = typeof window.__corumSlotRegistry;
  out.boot = typeof window.__DSH_BOOT__;
  // find react fiber roots to reach services
  const rootEl = document.getElementById('root') || document.body.firstElementChild;
  out.rootElId = rootEl ? rootEl.id : null;
  const fk = rootEl ? Object.keys(rootEl).filter(k => k.startsWith('__react')) : [];
  out.fiberKeys = fk;
  out.buttons = Array.from(document.querySelectorAll('button')).slice(0, 40).map(b => (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30));
  return out;
})()
