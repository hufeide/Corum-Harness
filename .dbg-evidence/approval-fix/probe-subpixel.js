(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), bottom: +r.bottom.toFixed(2), right: +r.right.toFixed(2) }; };
  const out = {};
  const seat = document.querySelector('[data-composer-seat]');
  const chain = document.querySelector('[data-slot="conversation.composer"]');
  const root = document.querySelector('[data-approval-key]');
  const card = root.firstElementChild;
  const menu = document.querySelector('[class*=allowMenu]');
  out.seat = R(seat);
  out.chain = R(chain);
  out.approvalRoot = R(root);
  out.card = R(card);
  out.menu = R(menu);
  out.rootPaddingTop = getComputedStyle(root).paddingTop;
  out.rootRect = R(root);
  // subpixel truth: compare raw values
  out.gapMenuBottomToCardTop = +(card.getBoundingClientRect().top - menu.getBoundingClientRect().bottom).toFixed(3);
  out.gapMenuBottomToSeatTop = +(menu.getBoundingClientRect().bottom - seat.getBoundingClientRect().top).toFixed(3);
  // is the hidden fallback (composer input) present and hidden?
  const hidden = Array.from(chain.children).find(c => getComputedStyle(c).display === 'none');
  out.fallbackHidden = !!hidden;
  const inp = document.querySelector('[data-composer-input]');
  out.inputRect = R(inp);
  let vis = true, p = inp;
  while (p && p !== document.documentElement) { if (getComputedStyle(p).display === 'none') { vis = false; break } p = p.parentElement }
  out.inputVisible = vis;
  // what does the menu actually contain / is it hit-testable?
  const m = menu.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(m.left + m.width / 2), Math.round(m.top + 20));
  out.hitTestMenu = hit ? { cls: String(hit.className).slice(0, 40), tag: hit.tagName, text: (hit.textContent || '').trim().slice(0, 20) } : null;
  // viewport
  out.viewport = { w: innerWidth, h: innerHeight };
  return out;
})()
