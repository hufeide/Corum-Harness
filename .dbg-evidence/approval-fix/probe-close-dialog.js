(() => {
  const out = { steps: [] };
  // close any settings/modal dialog
  const dlg = document.querySelector('[role=dialog]');
  if (dlg) {
    const btn = dlg.querySelector('button[aria-label*="关闭"], button[aria-label*="close"]')
      || Array.from(dlg.querySelectorAll('button')).find(b => /×|✕|close/i.test((b.textContent || '').trim()));
    if (btn) { btn.click(); out.steps.push('clicked dialog close: ' + (btn.getAttribute('aria-label') || btn.textContent)); }
    else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
      out.steps.push('dispatched Escape');
    }
  } else out.steps.push('no dialog');
  out.dialogAfter = !!document.querySelector('[role=dialog]');
  return out;
})()
