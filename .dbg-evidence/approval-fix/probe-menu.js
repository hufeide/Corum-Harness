(() => {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const vis = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity }; };
  const out = { viewport: { w: innerWidth, h: innerHeight } };
  const card = document.querySelector('[data-approval-key]');
  const cardBox = card ? card.firstElementChild : null;
  out.card = cardBox ? R(cardBox) : null;
  out.cardVis = vis(cardBox);
  // the composer input (fallback) — is it mounted & visible?
  const input = document.querySelector('[data-composer-input]');
  out.input = input ? R(input) : null;
  out.inputVis = vis(input);
  // walk up from the input to find the visible input CARD box
  let cardEl = null;
  if (input) { let p = input; for (let i = 0; i < 6 && p; i++) { if (/card/.test(String(p.className))) { cardEl = p; break } p = p.parentElement } }
  out.inputCard = cardEl ? R(cardEl) : null;
  out.inputCardVis = vis(cardEl);
  // composer seat
  const seat = document.querySelector('[data-composer-seat]');
  out.seat = seat ? R(seat) : null;
  out.seatVis = vis(seat);
  // menu state
  const menu = document.querySelector('[class*=allowMenu]');
  out.menuOpen = !!menu;
  out.menu = menu ? R(menu) : null;
  out.menuVis = vis(menu);
  out.menuItems = menu ? Array.from(menu.querySelectorAll('button')).map(b => ({ t: (b.textContent || '').trim(), r: R(b), fs: getComputedStyle(b).fontSize })) : null;
  // fonts on the card
  const f = (sel) => { const e = cardBox ? cardBox.querySelector(sel) : null; return e ? { fs: getComputedStyle(e).fontSize, fw: getComputedStyle(e).fontWeight, txt: (e.textContent || '').trim().slice(0, 18) } : null };
  out.fonts = {
    who: f('[class*=who]'), tag: f('[class*=tag]'), headline: f('[class*=headline]'),
    command: f('[class*=command]'), allowMain: f('[class*=allowMain]'), reject: f('[class*=reject]'),
  };
  out.tokens = {
    contentFontSize: getComputedStyle(document.documentElement).getPropertyValue('--dsh-content-font-size').trim(),
    contentFontDelta: getComputedStyle(document.documentElement).getPropertyValue('--dsh-content-font-delta').trim(),
  };
  const seatCS = seat ? getComputedStyle(seat) : null;
  out.seatTokens = seatCS ? { textMaxH: seatCS.getPropertyValue('--dsh-composer-text-max-height').trim() } : null;
  out.errors = (window.__approvalProbeErrors || []);
  return out;
})()
