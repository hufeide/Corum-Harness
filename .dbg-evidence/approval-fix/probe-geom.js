(() => {
  const out = {};
  out.url = location.href;
  out.title = document.title;
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const seat = document.querySelector('[data-composer-seat]');
  out.seatFound = !!seat;
  if (seat) {
    const cs = getComputedStyle(seat);
    out.seat = { rect: rectOf(seat), position: cs.position, zIndex: cs.zIndex, overflow: cs.overflow, display: cs.display };
    out.seatChildren = Array.from(seat.children).map(c => ({ tag: c.tagName, cls: String(c.className).slice(0, 90), display: getComputedStyle(c).display, rect: rectOf(c) }));
  }
  const scrollBody = document.querySelector('[data-conversation-scroll]');
  out.scrollBodyFound = !!scrollBody;
  if (scrollBody) {
    const cs = getComputedStyle(scrollBody);
    out.scrollBody = { rect: rectOf(scrollBody), position: cs.position, overflow: cs.overflow, overflowY: cs.overflowY, scrollTop: scrollBody.scrollTop, scrollHeight: scrollBody.scrollHeight, clientHeight: scrollBody.clientHeight };
  }
  const ta = document.querySelector('textarea');
  out.textareaFound = !!ta;
  if (ta) {
    out.textarea = { rect: rectOf(ta), fontSize: getComputedStyle(ta).fontSize };
    out.textareaAncestors = [];
    let p = ta;
    for (let i = 0; i < 9 && p; i++) {
      const s = getComputedStyle(p);
      out.textareaAncestors.push({ tag: p.tagName, cls: String(p.className).slice(0, 90), position: s.position, zIndex: s.zIndex, overflow: s.overflow, display: s.display, rect: rectOf(p) });
      p = p.parentElement;
    }
  }
  out.approvalCards = Array.from(document.querySelectorAll('[data-approval-key]')).map(c => ({ rect: rectOf(c), key: c.getAttribute('data-approval-key') }));
  const rootCS = getComputedStyle(document.documentElement);
  out.fontVars = {
    contentFontSize: rootCS.getPropertyValue('--dsh-content-font-size').trim(),
    contentFontDelta: rootCS.getPropertyValue('--dsh-content-font-delta').trim(),
    composerTextMaxHeight: rootCS.getPropertyValue('--dsh-composer-text-max-height').trim(),
  };
  out.viewport = { w: window.innerWidth, h: window.innerHeight };
  return out;
})()
