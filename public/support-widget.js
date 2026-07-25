/* ============================================================
   HOOKIT LINGO — Support Widget (Gumroad)
   Single shared file. No backend calls, no payment logic here —
   Gumroad owns checkout, tax, and delivery of the digital
   Supporter Certificate. This file only ever opens a link.

   Usage:
     HookitSupport.open('Kana Foundations')       // modal popover
     HookitSupport.mount(el, {context:'...'})      // inline, in-page card

   To swap payment providers later (Stripe / Razorpay Intl / PayPal /
   Paddle / Lemon Squeezy): change SUPPORT_CONFIG.tiers[].url (or
   .gumroadUrl) below. Nothing else in this file, or in any page that
   includes it, needs to change.
   ============================================================ */

window.SUPPORT_CONFIG = {
  // TODO: replace with your real Gumroad product URL before going live.
  // If each tier is a separate Gumroad product, set a "url" on that
  // tier below instead and this becomes just the fallback.
  gumroadUrl: "https://GUMROAD_URL_PLACEHOLDER.gumroad.com/l/hookitlingo-supporter",
  openInNewTab: true,
  tiers: [
    { amount: "$20", name: "Supporter Certificate" },
    { amount: "$50", name: "Founding Supporter Certificate", recommended: true },
    { amount: "$100", name: "Patron Certificate" }
  ]
};

(function(){
  let overlay = null, card = null, body = null, triggerEl = null;

  function ensureOverlay(){
    if(overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'hks-overlay';
    overlay.id = 'hksOverlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <div class="hks-card" role="dialog" aria-modal="true" aria-labelledby="hksTitle">
        <button class="hks-close" id="hksClose" aria-label="Close">✕</button>
        <div id="hksBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    card = overlay.querySelector('.hks-card');
    body = overlay.querySelector('#hksBody');

    overlay.querySelector('#hksClose').onclick = close;
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape' && overlay.classList.contains('hks-open')) close();
    });
  }

  function tierMarkup(context){
    const tiers = SUPPORT_CONFIG.tiers;
    if(tiers.length === 1){
      return `<button class="hks-single-btn" data-i="0">Support for ${tiers[0].amount}</button>`;
    }
    return `<div class="hks-tiers">${tiers.map((t,i)=>`
      <button class="hks-tier${t.recommended ? ' hks-recommended':''}" data-i="${i}">
        ${t.recommended ? '<span class="hks-tier-badge">Recommended</span>' : ''}
        <span>
          <span class="hks-tier-name">${t.name}</span>
          <span class="hks-tier-sub">Digital certificate, delivered by Gumroad</span>
        </span>
        <span class="hks-tier-amt">${t.amount}</span>
      </button>`).join('')}</div>`;
  }

  function contentMarkup(context, isModal){
    const contextLine = context
      ? `If ${context} has helped you learn, you can support future development by purchasing a Founding Supporter Certificate.`
      : `If Hookitlingo has helped you learn Japanese or Korean, you can support future development by purchasing a Founding Supporter Certificate.`;
    return `
      <div class="hks-icon">❤️</div>
      <h3 id="hksTitle">Become a Founding Supporter</h3>
      <p>${contextLine} As a thank-you, you'll receive a digital Supporter Certificate after your purchase.</p>
      ${tierMarkup(context)}
      <div id="hksFallback" class="hks-fallback-link"><a href="#" id="hksFallbackLink" target="_blank" rel="noopener">Didn't open? Click here to continue to Gumroad →</a></div>
      ${isModal ? `<div class="hks-actions"><button class="hks-maybe-later" id="hksMaybeLater">Maybe later</button></div>` : ''}
      <p class="hks-footer-note">Handled securely by Gumroad — checkout, receipts, and delivery all happen on their site.</p>`;
  }

  function bindTierButtons(container){
    container.querySelectorAll('.hks-tier, .hks-single-btn').forEach(btn=>{
      btn.onclick = () => {
        const tier = SUPPORT_CONFIG.tiers[parseInt(btn.dataset.i, 10)];
        goToGumroad(tier, container);
      };
    });
  }

  function goToGumroad(tier, container){
    const url = (tier && tier.url) || SUPPORT_CONFIG.gumroadUrl;
    let win = null;
    if(SUPPORT_CONFIG.openInNewTab){
      win = window.open(url, '_blank', 'noopener');
    } else {
      window.location.href = url;
      return;
    }
    const fallback = container.querySelector('#hksFallback');
    const fallbackLink = container.querySelector('#hksFallbackLink');
    if(!win || win.closed || typeof win.closed === 'undefined'){
      if(fallbackLink) fallbackLink.href = url;
      if(fallback) fallback.classList.add('hks-show');
    }
  }

  function open(context){
    ensureOverlay();
    triggerEl = document.activeElement;
    body.innerHTML = contentMarkup(context, true);
    bindTierButtons(body);
    const maybeLater = body.querySelector('#hksMaybeLater');
    if(maybeLater) maybeLater.onclick = close;
    overlay.classList.add('hks-open');
    const closeBtn = overlay.querySelector('#hksClose');
    if(closeBtn) closeBtn.focus();
  }

  function close(){
    if(!overlay) return;
    overlay.classList.remove('hks-open');
    if(triggerEl && typeof triggerEl.focus === 'function') triggerEl.focus();
  }

  function mount(el, opts){
    opts = opts || {};
    el.innerHTML = `<div class="hks-inline">${contentMarkup(opts.context, false)}</div>`;
    bindTierButtons(el);
  }

  window.HookitSupport = { open, close, mount };
})();
