(() => {
  const read = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      'content-font-size': cs.getPropertyValue('--dsh-content-font-size').trim(),
      'content-font-delta': cs.getPropertyValue('--dsh-content-font-delta').trim(),
      'content-font-size-secondary': cs.getPropertyValue('--dsh-content-font-size-secondary').trim(),
      'content-font-delta-secondary': cs.getPropertyValue('--dsh-content-font-delta-secondary').trim(),
    };
  };
  const appr = document.querySelector('[data-approval-key]');
  const card = appr ? appr.firstElementChild : null;
  const out = {
    html: read(document.documentElement),
    body: read(document.body),
    bodyInlineStyle: document.body.getAttribute('style'),
    card: read(card),
    seat: read(document.querySelector('[data-composer-seat]')),
    input: read(document.querySelector('[data-composer-input]')),
  };
  // measure what a calc form would produce
  const probe = document.createElement('div');
  probe.style.fontSize = 'calc(14px + var(--dsh-content-font-delta, 0px))';
  document.body.appendChild(probe);
  out.calc14 = getComputedStyle(probe).fontSize;
  probe.style.fontSize = 'var(--dsh-content-font-size, 14px)';
  out.var14 = getComputedStyle(probe).fontSize;
  probe.remove();
  return out;
})()
