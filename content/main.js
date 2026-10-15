/*
 * RepHop content script.
 * Finds product links on the page, adds the open/save buttons, handles the
 * click and hotkey shortcuts, and draws the hover card, toasts and action bar.
 * The saved list is only ever changed by the service worker; this script asks it to.
 */
(() => {
  'use strict';
  if (window.__rephopLoaded) return;
  window.__rephopLoaded = true;

  const L = self.RepLinks;
  const U = self.RepUtil;
  if (!L || !U || !chrome.runtime || !chrome.runtime.id) return;

  const HOST = location.hostname.toLowerCase().replace(/^www\./, '');
  const IS_REDDIT = L.hostMatches(HOST, ['reddit.com']);
  const IS_YUPOO = L.hostMatches(HOST, ['yupoo.com']);
  const IS_MARKET = L.hostMatches(HOST, ['weidian.com', 'taobao.com', 'tmall.com', 'tmall.hk', '1688.com']);
  const IS_AGENT = L.hostMatches(HOST, L.AGENT_HOSTS);
  const IS_SHEETS = HOST === 'docs.google.com';
  // The live spreadsheet editor draws cells on a canvas, so there is nothing to scan; links come from a fetch instead.
  const SHEETS_APP = IS_SHEETS && !/\/(htmlview|pubhtml|preview)/.test(location.pathname);
  const SCAN_PAGE = !(IS_MARKET || IS_AGENT || SHEETS_APP);
  const SAVE_BATCH = 40;

  let settings = U.mergeSettings();
  let agent = L.agentInfo(settings);
  let alive = true;
  let states = {}; // link key -> { saved, itemKey, status, viewed, mentions, trusted, state }
  let queue = null;
  let rates = null;
  let pageItem = null;
  let lastHref = location.href;
  let fabCollapsed = false;
  let cartCount = 0; // lines on the agent's cart page RepHop can read
  let cartWanted = false; // the list opened this cart to copy it in
  let cartCopied = null; // the cart as last copied, so the bar can say so
  let cartTried = null; // the cart as last sent (copied or not), so a failure is not retried every second
  let cartNow = ''; // the cart as it is on the page
  let cartBusy = false;
  let cartTimer = null;

  const infos = new WeakMap(); // element -> link info (or null)
  const hrefSeen = new WeakMap(); // anchor -> the href we last classified
  const live = new Set(); // link infos currently tracked on the page
  const pillInfo = new WeakMap(); // pill host -> link info
  const pillRoots = new WeakMap(); // pill host -> its (closed) shadow root

  // ------------------------------------------------------------- messaging

  function send(msg) {
    return new Promise((resolve) => {
      if (!alive) return resolve(null);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res === undefined ? null : res);
        });
      } catch (_) {
        // The extension was reloaded or updated while this tab stayed open.
        if (alive) {
          alive = false;
          toast('RepHop was updated. Reload this page to keep using it.', 'warn');
        }
        resolve(null);
      }
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // -------------------------------------------------------------------- UI
  // Everything RepHop draws sits in closed shadow roots, so the page's own scripts
  // cannot read which links you have saved, viewed or marked as trusted.

  const ICON = {
    bolt: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M13.2 2 4 13.6h6.2L9.4 22 20 9.6h-6.6z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    cart: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M3 4h2.5l2.2 10.5h9.8L20 7H7"/><circle cx="9.5" cy="19" r="1.6" fill="currentColor"/><circle cx="16.5" cy="19" r="1.6" fill="currentColor"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M5 7h14M5 12h14M5 17h14"/></svg>',
  };

  // Set inline with !important: a page's stylesheet outranks a shadow host's own :host rule, and Reddit's
  // feed puts a full-card link over each post, so the button has to be positioned to sit above it.
  const PILL_HOST_STYLE = 'all: initial !important; display: inline-flex !important; vertical-align: middle !important; margin: 0 2px 0 6px !important; position: relative !important; z-index: 1 !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;';

  const PHOTO_PILL_STYLE = 'all: initial !important; position: absolute !important; top: 12px !important; left: 12px !important; z-index: 30 !important; display: inline-flex !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;';

  const PILL_CSS = `
    .wrap { position: relative; display: inline-flex; }
    .pill { display: inline-flex; align-items: stretch; height: 20px; border-radius: 10px; overflow: hidden;
      font: 600 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff; background: #1c2130;
      box-shadow: 0 0 0 1px rgba(255,255,255,.16), 0 1px 2px rgba(0,0,0,.3); user-select: none; white-space: nowrap; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; color: inherit; font: inherit; }
    button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
    .go { background: linear-gradient(135deg, #ff6b35, #f43f5e); padding-left: 6px; }
    .go:hover { filter: brightness(1.12); }
    .save:hover { background: #2c3447; }
    .save.on { color: #4ade80; }
    /* The "seen in N posts" count floats over the corner, so it never changes the button's size. */
    .n { display: none; position: absolute; top: -7px; right: -6px; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px;
      background: #fbbf24; color: #1c2130; font: 700 9px/14px system-ui, sans-serif; text-align: center; pointer-events: none; }
    .wrap.hot .n { display: block; }
    .pill.viewed .go { background: linear-gradient(135deg, #7c6f8f, #6b7280); }
    .pill.trusted { box-shadow: 0 0 0 1.5px #facc15, 0 1px 2px rgba(0,0,0,.3); }
    .pill.dead .go { background: #4b5563; text-decoration: line-through; }
    .pill.busy { opacity: .6; pointer-events: none; }
    .pill.compact .go span { display: none; }
  `;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; visibility: visible; z-index: 2147483646; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f5f7; }
    button { all: unset; box-sizing: border-box; cursor: pointer; font: inherit; color: inherit; }
    button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }

    .toasts { position: absolute; left: 16px; bottom: 68px; display: flex; flex-direction: column; gap: 8px; align-items: stretch; width: min(400px, calc(100vw - 32px)); }
    .toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: #1c2130; border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 8px 28px rgba(0,0,0,.4); animation: rise .16s ease-out; max-width: 100%; }
    .toast::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex: none; }
    .toast.error::before { background: #f87171; }
    .toast.warn::before { background: #fbbf24; }
    .toast.need { border-color: #ff6b35; box-shadow: 0 0 0 2px rgba(255,107,53,.35), 0 10px 30px rgba(0,0,0,.45); font-weight: 600; }
    .toast span { overflow-wrap: anywhere; flex: 1 1 0; min-width: 0; }
    .toast { flex-wrap: wrap; }
    .toast .acts { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding-left: 20px; }
    .toast .acts button { color: #c7cdd9; }
    .toast .acts button:hover { color: #f4f5f7; }
    .toast .acts button.main { background: #ff6b35; color: #fff; padding: 4px 10px; border-radius: 7px; }
    .toast .acts button.main:hover { filter: brightness(1.1); }
    .toast button { color: #ff8a5c; font-weight: 600; flex: none; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }

    .card { position: absolute; width: 300px; display: none; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; background: #1c2130; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 36px rgba(0,0,0,.45); }
    .card.on { display: flex; }
    .card .top { display: flex; gap: 10px; }
    .card .pic { width: 72px; height: 72px; border-radius: 8px; background: #2a3142; flex: none; overflow: hidden; display: grid; place-items: center; color: #9aa3b5; font-weight: 700; font-size: 13px; }
    .card .pic img { width: 100%; height: 100%; display: block; object-fit: cover; }
    .card .body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .card .title { font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .card .sub { color: #9aa3b5; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card .price { font-weight: 700; color: #ffb86b; }
    .card .price small { color: #9aa3b5; font-weight: 500; }
    .card .tags { display: flex; flex-wrap: wrap; gap: 4px; }
    .card .tag { font-size: 10.5px; padding: 1px 6px; border-radius: 6px; background: #2c3447; color: #d5dae4; }
    .card .tag.good { background: #14532d; color: #bbf7d0; }
    .card .tag.bad { background: #7f1d1d; color: #fecaca; }
    .card .tag.gold { background: #713f12; color: #fde68a; }
    .card .keys { color: #9aa3b5; font-size: 11px; white-space: nowrap; overflow: hidden; }
    .card .keys:empty { display: none; }
    .card kbd { font: 600 10.5px ui-monospace, Menlo, Consolas, monospace; padding: 0 4px; border-radius: 4px; background: #2c3447; color: #f4f5f7; border: 1px solid rgba(255,255,255,.14); }

    .bar { position: absolute; left: 16px; bottom: 16px; pointer-events: auto; display: none; align-items: center; gap: 2px; padding: 4px; border-radius: 14px; background: #1c2130; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 28px rgba(0,0,0,.4); max-width: calc(100vw - 32px); flex-wrap: wrap; }
    .bar.on { display: flex; }
    .bar button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: 10px; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
    .bar button:hover { background: #2c3447; }
    .bar button[hidden] { display: none; }
    .bar .logo { background: linear-gradient(135deg, #ff6b35, #f43f5e); padding: 7px 8px; }
    .bar .logo:hover { filter: brightness(1.12); background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .bar .primary { background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .bar .primary:hover { filter: brightness(1.12); background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .bar .on-state { color: #4ade80; }
    .bar .sep { width: 1px; align-self: stretch; margin: 4px 3px; background: rgba(255,255,255,.14); }
    .bar .q { padding: 0 8px; font-weight: 600; font-size: 12.5px; color: #ffb86b; white-space: nowrap; }
    .bar.collapsed > :not(.logo) { display: none; }
    .bar.busy { opacity: .7; pointer-events: none; }

    .picks { position: absolute; left: 16px; bottom: 70px; width: min(350px, calc(100vw - 32px)); max-height: calc(100vh - 110px); overflow: auto; pointer-events: auto; padding: 12px; border-radius: 14px;
      background: #1c2130; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 34px rgba(0,0,0,.45); display: flex; flex-direction: column; gap: 8px; }
    .picks[hidden] { display: none; }
    .picks .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .picks .head b { font-size: 13.5px; }
    .picks .head button { color: #9aa3b5; font-size: 18px; line-height: 1; padding: 0 4px; }
    .picks .head button:hover { color: #f4f5f7; }
    .picks .row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; min-height: 48px; border-radius: 10px; background: #252c3c; }
    .picks .pic { width: 34px; height: 34px; flex: none; border-radius: 7px; object-fit: cover; background: #2c3447; }
    .picks .what { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
    .picks .what small { color: #9aa3b5; font-weight: 500; margin-left: 4px; }
    .picks .st { font-size: 11.5px; font-weight: 700; color: #9aa3b5; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .picks .st.in { color: #4ade80; }
    .picks .row button, .picks .here button { padding: 6px 10px; border-radius: 9px; background: #2c3447; font-weight: 600; font-size: 12px; white-space: nowrap; text-align: center; }
    .picks .row button:hover, .picks .here button:hover { background: #374159; }
    .picks button.go { background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .picks button.go:hover { filter: brightness(1.12); background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .picks .here { border-top: 1px solid rgba(255,255,255,.1); padding-top: 9px; display: flex; flex-direction: column; gap: 7px; }
    .picks .here .sel { color: #c7cdd9; font-size: 12.5px; }
    .picks .here .sel b { color: #f4f5f7; }
    .picks .here .btns { display: flex; gap: 6px; }
    .picks .here .btns button { flex: 1; }
    .picks .hint { color: #9aa3b5; font-size: 11.5px; }
    .picks .row.best { box-shadow: inset 0 0 0 2px #ff6b35; }
    .picks .what .tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: rgba(255,107,53,.18); color: #ffb38f; font-size: 10.5px; font-weight: 700; }
    .bar .count { font-size: 11px; font-weight: 700; color: #9aa3b5; }
    .chooser { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); width: min(340px, 92vw); pointer-events: auto; padding: 16px; border-radius: 14px;
      background: #1c2130; border: 1px solid rgba(255,255,255,.16); box-shadow: 0 18px 60px rgba(0,0,0,.55); }
    .chooser[hidden] { display: none; }
    .chooser h2 { margin: 0 0 4px; font-size: 15px; font-weight: 700; }
    .chooser p { margin: 0 0 12px; color: #9aa3b5; font-size: 12.5px; }
    .chooser .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .chooser button { padding: 9px 10px; border-radius: 10px; background: #2c3447; font-weight: 600; text-align: center; }
    .chooser button:hover { background: linear-gradient(135deg, #ff6b35, #f43f5e); }
    .chooser .plain { grid-column: 1 / -1; background: none; color: #9aa3b5; font-weight: 500; padding: 4px; }
    .chooser .plain:hover { background: none; color: #f4f5f7; }
    @media (prefers-reduced-motion: reduce) { .toast { animation: none; } }
  `;

  // A plain <div>, not a custom element: Reddit's stylesheet hides every custom element it has not defined itself.
  // The inline !important styles keep the page's own rules from hiding or moving it.
  const uiHost = document.createElement('div');
  uiHost.setAttribute('data-rh-ui', '');
  uiHost.setAttribute('data-rh-root', '');
  uiHost.style.cssText = 'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important; visibility: visible !important; opacity: 1 !important;';
  const ui = uiHost.attachShadow({ mode: 'closed' });
  ui.innerHTML = `<style>${UI_CSS}</style>
    <div class="layer">
      <div class="card" role="tooltip"><div class="top"><div class="pic"></div><div class="body"><div class="title"></div><div class="sub"></div><div class="price"></div><div class="tags"></div></div></div><div class="keys"></div></div>
      <div class="bar" role="toolbar" aria-label="RepHop">
        <button class="logo" data-act="toggle" title="Show or hide the RepHop bar" aria-label="Show or hide the RepHop bar">${ICON.bolt}</button>
        <button data-act="back" hidden></button>
        <span class="q" hidden></span>
        <button data-act="qprev" hidden title="Previous item in the queue ( [ )">◀</button>
        <button data-act="qnext" class="primary" hidden title="Next item in the queue ( ] )">Next ▶</button>
        <button data-act="qstop" hidden title="End the queue">End</button>
        <span class="sep" data-for="queue" hidden></span>
        <button data-act="open" class="primary" hidden></button>
        <button data-act="save" hidden></button>
        <button data-act="qc" hidden>QC photos</button>
        <button data-act="photo" hidden></button>
        <button data-act="gpick" hidden></button>
        <button data-act="grab" hidden></button>
        <button data-act="cart" hidden></button>
        <button data-act="graball" hidden title="Read every tab of this spreadsheet and save the product links">All tabs</button>
        <button data-act="clickable" hidden title="Open a plain version of this sheet where every link gets its own open and save buttons">Clickable view</button>
        <button data-act="panel" title="Open your RepHop list" aria-label="Open your RepHop list">${ICON.list}</button>
      </div>
      <div class="picks" role="dialog" aria-label="What you want from this listing" hidden></div>
      <div class="chooser" role="dialog" aria-label="Choose your shopping agent" hidden>
        <h2>Which shopping agent do you use?</h2>
        <p>RepHop opens product links there. You can change it any time in the RepHop list.</p>
        <div class="grid"></div>
      </div>
      <div class="toasts" aria-live="polite"></div>
    </div>`;
  const $card = ui.querySelector('.card');
  const $bar = ui.querySelector('.bar');
  const $toasts = ui.querySelector('.toasts');
  const $chooser = ui.querySelector('.chooser');
  const $picks = ui.querySelector('.picks');
  (document.documentElement || document.body).appendChild(uiHost);

  // ----------------------------------------------------- choosing an agent
  // Nothing is assumed about which agent you use. The first time something has to be opened, this asks.

  let afterChoose = null;
  {
    const grid = $chooser.querySelector('.grid');
    for (const [id, a] of Object.entries(L.AGENTS)) {
      if (id === 'custom') continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.agent = id;
      b.textContent = a.name;
      grid.appendChild(b);
    }
    for (const [id, label] of [['custom', 'A different agent…'], ['', 'Not now']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plain';
      b.dataset.agent = id;
      b.textContent = label;
      grid.appendChild(b);
    }
  }

  let fallbackUrl = '';

  /** Ask which agent to use. `then` runs once one is chosen; `orig` is opened as-is if the user says "Not now". */
  function chooseAgent(then, orig) {
    afterChoose = then || null;
    fallbackUrl = orig || '';
    $chooser.hidden = false;
    const first = $chooser.querySelector('button');
    if (first) first.focus();
  }

  $chooser.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    $chooser.hidden = true;
    const id = b.dataset.agent;
    const next = afterChoose;
    const orig = fallbackUrl;
    afterChoose = null;
    fallbackUrl = '';
    if (!id) {
      // "Not now": the click that brought this up still deserves to go somewhere, so open the plain link.
      if (orig) send({ type: 'openTab', url: orig });
      return;
    }
    if (id === 'custom') {
      send({ type: 'openPanel' });
      toast('Open Settings in the RepHop list and enter your agent’s link there.', 'ok');
      return;
    }
    const res = await send({ type: 'settings', patch: { agent: id } });
    if (!res || !res.ok) return;
    settings = U.mergeSettings(res.settings);
    agent = L.agentInfo(settings);
    repaintAll();
    if (next) next();
  });

  /**
   * A short message at the bottom of the page.
   * actions: one { label, fn } or a list of them. opts.sticky keeps it until closed.
   * Returns { close, set } so long jobs can update their own message.
   */
  function toast(text, kind, actions, opts) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    const span = document.createElement('span');
    span.textContent = text || '';
    el.appendChild(span);
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      el.remove();
    };
    const list = !actions ? [] : Array.isArray(actions) ? actions : [actions];
    const holder = list.length > 1 ? document.createElement('div') : el;
    if (list.length > 1) {
      holder.className = 'acts';
      el.appendChild(holder);
    }
    for (const action of list) {
      const b = document.createElement('button');
      b.type = 'button';
      if (list.length > 1 && action === list[0]) b.className = 'main';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        close();
        action.fn();
      });
      holder.appendChild(b);
    }
    while ($toasts.children.length >= 3) $toasts.firstChild.remove();
    $toasts.appendChild(el);
    if (!(opts && opts.sticky)) timer = setTimeout(close, list.length ? 7000 : 3800);
    return { close, set: (t) => (span.textContent = t) };
  }

  // ------------------------------------------------------- link discovery

  function classify(href) {
    const parsed = L.parseLink(href);
    if (!parsed) return null;
    // On Yupoo itself, album links are how you browse; they get hover and hotkeys but keep their normal click.
    return { parsed, mode: IS_YUPOO && parsed.kind === 'yupoo' ? 'hover' : 'inline' };
  }

  /** What we know about a link element. Cached per href, so a link that changes target is read again. */
  function infoFor(el) {
    if (el.tagName !== 'A') return infos.get(el) || null;
    if (hrefSeen.get(el) === el.href) return infos.get(el) || null;
    const old = infos.get(el);
    if (old) {
      if (old.pill) old.pill.remove();
      live.delete(old);
    }
    hrefSeen.set(el, el.href);
    let info = null;
    if (el.href && /^https?:/i.test(el.href)) {
      const c = classify(el.href) || (L.looksLikeUrl(el.textContent) ? classify(el.textContent.trim()) : null);
      if (c) info = { el, parsed: c.parsed, key: c.parsed.key, url: c.parsed.url, orig: el.href, mode: c.mode, pill: null };
    }
    infos.set(el, info);
    return info;
  }

  function isOurs(node) {
    return node.nodeType === 1 && (node.hasAttribute('data-rh-ui') || node.classList.contains('rh-text'));
  }

  function inEditor(el) {
    return !!el.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"], textarea, shreddit-composer, .usertext-edit');
  }

  /** A link whose visible content is only a picture: clicks are still converted, but it gets no inline button (that would break image grids). */
  function isImageLink(a) {
    return !!a.querySelector('img, picture, video, svg') && !a.textContent.trim();
  }

  function wantsPill(info) {
    return (info.mode === 'inline' || info.mode === 'photo') && !info.noPill && settings.showPills;
  }

  function decorateAnchor(a) {
    if (a.closest('[data-rh-ui]') || inEditor(a)) return;
    const info = infoFor(a);
    if (!info) return;
    if (info.noPill === undefined) info.noPill = isImageLink(a);
    // The link may already have been classified by a hover or click before this scan reached it.
    if (!live.has(info)) track(info);
    else if (wantsPill(info) && !(info.pill && info.pill.isConnected)) attachPill(info);
  }

  function track(info) {
    live.add(info);
    if (wantsPill(info)) attachPill(info);
    noteSeen(info);
  }

  function attachPill(info) {
    if (info.pill && info.pill.isConnected) return;
    const next = info.mode === 'photo' ? info.el.querySelector(':scope > [data-rh-pill]') : info.el.nextElementSibling;
    if (next && next.hasAttribute('data-rh-pill')) next.remove();
    const host = document.createElement('span');
    host.setAttribute('data-rh-ui', '');
    host.setAttribute('data-rh-pill', '');
    const root = host.attachShadow({ mode: 'closed' });
    host.style.cssText = info.mode === 'photo' ? PHOTO_PILL_STYLE : PILL_HOST_STYLE;
    root.innerHTML = `<style>${PILL_CSS}</style><span class="wrap"><span class="pill"><button class="go" type="button">${ICON.bolt}<span></span></button><button class="save" type="button"></button></span><span class="n"></span></span>`;
    const stop = (ev) => ev.stopPropagation();
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) root.addEventListener(type, stop);
    root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const btn = ev.target.closest('button');
      if (!btn || !alive) return;
      if (btn.classList.contains('go')) doOpen(info, ev.ctrlKey || ev.metaKey ? 'background' : 'default');
      else toggleSave(info);
    });
    root.addEventListener('auxclick', (ev) => {
      if (ev.button !== 1) return;
      ev.stopPropagation();
      ev.preventDefault();
      if (ev.target.closest('.go')) doOpen(info, 'background');
    });
    info.pill = host;
    pillInfo.set(host, info);
    pillRoots.set(host, root);
    if (info.mode === 'photo') info.el.appendChild(host);
    else info.el.insertAdjacentElement('afterend', host);
    paintPill(info);
  }

  function paintPill(info) {
    const root = info.pill && pillRoots.get(info.pill);
    if (!root) return;
    const st = states[info.key] || {};
    const pill = root.querySelector('.pill');
    const go = root.querySelector('.go');
    const save = root.querySelector('.save');
    const n = root.querySelector('.n');
    const dead = st.state === 'gone';
    pill.className = 'pill' + (settings.pillStyle === 'compact' ? ' compact' : '') + (st.viewed ? ' viewed' : '') + (st.trusted ? ' trusted' : '') + (dead ? ' dead' : '');
    root.querySelector('.wrap').classList.toggle('hot', !!st.mentions);
    go.querySelector('span').textContent = agent.short;
    const what = info.parsed.kind === 'yupoo' ? "Find this album's buy link and open it in " + agent.name : 'Open in ' + agent.name;
    const k = settings.hotkeysEnabled ? ' (hover + ' + settings.keys.open.toUpperCase() + ')' : '';
    go.title = (dead ? 'This item looks removed. ' : '') + what + k + (st.viewed ? ' · already viewed' : '') + (st.trusted ? ' · trusted seller' : '') + (st.mentions ? ' · seen in ' + st.mentions + ' different posts' : '');
    go.setAttribute('aria-label', what);
    save.innerHTML = st.status === 'carted' || st.status === 'bought' ? ICON.cart : st.saved ? ICON.check : ICON.plus;
    save.classList.toggle('on', !!st.saved);
    save.title = st.saved ? 'In your list' + (st.status === 'carted' ? ' (in cart)' : '') + '. Click for options.' : 'Save to your RepHop list' + (settings.hotkeysEnabled ? ' (hover + ' + settings.keys.save.toUpperCase() + ')' : '');
    save.setAttribute('aria-label', st.saved ? 'In your RepHop list. Show options.' : 'Save to your RepHop list');
    // With hotkeys on, the link itself is the keyboard stop (focus it, then press the key), so a long
    // thread does not gain two extra tab stops per link.
    go.tabIndex = save.tabIndex = settings.hotkeysEnabled ? -1 : 0;
    n.textContent = st.mentions ? String(st.mentions) : '';
  }

  function repaintAll() {
    for (const info of live) {
      if (!info.el.isConnected) {
        live.delete(info);
        continue;
      }
      if (wantsPill(info)) {
        attachPill(info);
        paintPill(info);
      } else if (info.pill) {
        info.pill.remove();
        info.pill = null;
      }
    }
    paintBar();
  }

  const TEXT_SKIP = 'a, script, style, noscript, textarea, select, option, button, [data-rh-ui], .rh-text';

  function scanText(root) {
    if (!settings.detectTextLinks || !root || !L.mightContainLink(root.textContent)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.length < 10 || !L.mightContainLink(node.nodeValue)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(TEXT_SKIP) || inEditor(parent)) continue;
      nodes.push(node);
    }
    for (const textNode of nodes) {
      const hits = L.extractLinks(textNode.nodeValue);
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        const span = document.createElement('span');
        span.className = 'rh-text';
        span.style.cssText = 'text-decoration: underline dotted; text-underline-offset: 2px; cursor: pointer;';
        try {
          const range = document.createRange();
          range.setStart(textNode, h.index);
          range.setEnd(textNode, h.index + h.length);
          range.surroundContents(span);
        } catch (_) {
          continue;
        }
        const info = { el: span, parsed: h.parsed, key: h.parsed.key, url: h.parsed.url, orig: h.parsed.url, mode: IS_YUPOO && h.parsed.kind === 'yupoo' ? 'hover' : 'inline', pill: null, text: true, noPill: false };
        infos.set(span, info);
        track(info);
      }
    }
  }

  function scan(root) {
    if (!SCAN_PAGE || !root) return;
    if (root.nodeType === 1 && root.tagName === 'A') decorateAnchor(root);
    if (root.querySelectorAll) for (const a of root.querySelectorAll('a[href]')) decorateAnchor(a);
    scanText(root.nodeType === 9 ? root.body : root);
    if (IS_REDDIT && root.querySelector && (root.tagName === 'GALLERY-CAROUSEL' || root.querySelector('gallery-carousel'))) decorateGallery();
    refreshStates();
    paintBar();
  }

  // ---------------------------------------------------------- gallery photos
  // A Reddit gallery is a row of photos. Reddit keeps the photos' own links and captions in the post's data,
  // not on the page, so on a post page RepHop reads that once, with the post's text and the poster's comments.
  //  - A photo the poster put a product link on gets the same ⚡ | + button as a link.
  //  - While any photo is on screen (in the post or full screen), the bar offers "Save from this photo": the
  //    post's links with their pictures, the one that looks most like the photo first. RepHop compares the photo
  //    with each product's own pictures on your computer (a small image model and the colours). It is a guess,
  //    so the list always shows every link and you pick.
  const galleries = new Map(); // post id -> Promise of { photos: [{ media, parsed, label, small }], links: [{ parsed, label }] }
  const photoByMedia = new Map(); // media id -> info, for photos with a link of their own
  const slideByMedia = new Map(); // media id -> the photo's place in the gallery
  const matches = new Map(); // post id -> { state, done, total, info, sims }
  const pickerInfos = new Map(); // key -> info, for the links listed in the picker
  let galleryNow = null; // { postId, carousel, data }
  let photoNow = null; // the photo on screen, when it has a link of its own
  let slideNow = null; // { index, media } of the photo on screen
  let pickerSlide = 0;
  let picksMode = 'listing'; // what the list above the bar shows: this listing's picks, or a gallery photo's items
  let photoTimer = null;

  function galleryPhotos(postId) {
    if (!galleries.has(postId)) {
      galleries.set(postId, (async () => {
        const empty = { photos: [], links: [] };
        try {
          const res = await fetch(location.origin + '/comments/' + postId + '.json?limit=200&depth=4&raw_json=1', { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!res.ok) return empty;
          const data = await res.json();
          const post = (((data[0] || {}).data || {}).children[0] || {}).data || {};
          const meta = post.media_metadata || {};
          const small = (id) => {
            const m = meta[id] || {};
            const list = Array.isArray(m.p) ? m.p : [];
            const pick = list.find((x) => x && x.x >= 320) || list[list.length - 1] || m.s;
            return pick && typeof pick.u === 'string' ? pick.u.replace(/&amp;/g, '&') : '';
          };
          const items = post.gallery_data && Array.isArray(post.gallery_data.items) ? post.gallery_data.items : [];
          const photos = items.map((g) => {
            const caption = typeof g.caption === 'string' ? g.caption : '';
            const out = typeof g.outbound_url === 'string' ? L.parseLink(g.outbound_url) : null;
            const hit = out ? null : L.extractLabeled(caption)[0];
            const media = String(g.media_id || '');
            return { media, parsed: out || (hit ? hit.parsed : null), label: L.cleanLabel(caption.replace(/https?:\/\/\S+/g, ' ')) || (hit && hit.label) || '', small: small(media) };
          });
          // The items the photos can show: the post's own links (its text, its photos), then the poster's comments.
          const links = [];
          const seen = new Set();
          const add = (parsed, label) => {
            if (!parsed || seen.has(parsed.key) || links.length >= 25) return;
            seen.add(parsed.key);
            links.push({ parsed, label: label || '' });
          };
          for (const h of L.extractLabeled(post.selftext || '')) add(h.parsed, h.label);
          for (const p of photos) if (p.parsed) add(p.parsed, p.label);
          const walk = (children) => {
            for (const c of children || []) {
              if (!c || c.kind !== 't1' || !c.data) continue;
              if (c.data.author && c.data.author === post.author) for (const h of L.extractLabeled(c.data.body || '')) add(h.parsed, h.label);
              if (c.data.replies && c.data.replies.data) walk(c.data.replies.data.children);
            }
          };
          walk(data[1] && data[1].data && data[1].data.children);
          return { photos, links };
        } catch (_) {
          return empty;
        }
      })());
    }
    return galleries.get(postId);
  }

  async function decorateGallery() {
    const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (!m) return;
    const carousel = document.querySelector('gallery-carousel[post-id="t3_' + m[1] + '"]');
    if (!carousel) return;
    const data = await galleryPhotos(m[1]);
    if (!alive || !data.photos.length) return;
    galleryNow = { postId: m[1], carousel, data };
    data.photos.forEach((p, i) => p.media && slideByMedia.set(p.media, i));
    for (const li of carousel.querySelectorAll('li[slot^="page-"]')) {
      const p = data.photos[(parseInt(li.getAttribute('slot').slice(5), 10) || 0) - 1];
      if (!p || !p.parsed || infos.get(li)) continue;
      const info = { el: li, parsed: p.parsed, key: p.parsed.key, url: p.parsed.url, orig: p.parsed.url, mode: 'photo', pill: null, label: p.label, media: p.media };
      infos.set(li, info);
      live.add(info);
      if (p.media) photoByMedia.set(p.media, info);
    }
    refreshStates();
    if (!photoTimer) photoTimer = setInterval(trackPhoto, 600);
  }

  /** The gallery photo that fills most of the screen (the full-screen viewer draws its own copy): { index, media }, or null. */
  function photoOnScreen() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    let most = vw * vh * 0.12;
    const look = (root, depth) => {
      for (const img of root.querySelectorAll('img')) {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) continue;
        let media = '';
        for (const id of slideByMedia.keys()) {
          if (src.includes(id)) {
            media = id;
            break;
          }
        }
        if (!media) continue;
        const r = img.getBoundingClientRect();
        // A photo waiting beside the current one in the post's carousel is cut off by the carousel.
        const box = img.closest('gallery-carousel');
        const c = box ? box.getBoundingClientRect() : { left: 0, top: 0, right: vw, bottom: vh };
        const w = Math.min(r.right, c.right, vw) - Math.max(r.left, c.left, 0);
        const h = Math.min(r.bottom, c.bottom, vh) - Math.max(r.top, c.top, 0);
        if (w > 0 && h > 0 && w * h > most && getComputedStyle(img).visibility !== 'hidden') {
          most = w * h;
          best = { index: slideByMedia.get(media), media };
        }
      }
      if (depth < 4) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) look(el.shadowRoot, depth + 1);
    };
    look(document.body, 4);
    const viewer = document.querySelector('shreddit-media-lightbox');
    if (viewer) look(viewer.shadowRoot || viewer, 1);
    return best;
  }

  function trackPhoto() {
    if (!alive) return void clearInterval(photoTimer);
    if (document.hidden) return;
    const next = photoOnScreen();
    const changed = (next && next.media) !== (slideNow && slideNow.media);
    slideNow = next;
    photoNow = next ? photoByMedia.get(next.media) || null : null;
    if (!changed) return;
    paintBar();
    if (!$picks.hidden && picksMode === 'gallery' && next) renderPicker();
  }

  /** Compare every photo of the gallery with every linked product's pictures, once per post. */
  async function startMatch() {
    const g = galleryNow;
    if (!g || matches.has(g.postId)) return;
    const mt = { state: 'loading', done: 0, total: 0, info: [], sims: null };
    matches.set(g.postId, mt);
    const again = () => !$picks.hidden && picksMode === 'gallery' && renderPicker();
    try {
      const info = await send({ type: 'photoInfo', urls: g.data.links.map((l) => l.parsed.url) });
      mt.info = (info && info.list) || [];
      again();
      if (!self.RepMatch) await send({ type: 'loadMatcher' });
      if (!self.RepMatch) throw new Error('no matcher');
      const slides = g.data.photos.map((p) => p.small);
      const pics = g.data.links.map((l, j) => (mt.info[j] && mt.info[j].pics) || []);
      const all = Array.from(new Set(slides.concat(...pics).filter(Boolean)));
      mt.total = all.length;
      const feats = new Map();
      for (let i = 0; i < all.length; i += 8) {
        const batch = all.slice(i, i + 8);
        const r = await send({ type: 'fetchPics', urls: batch });
        for (let k = 0; k < batch.length; k++) {
          const got = r && r.list && r.list[k];
          feats.set(batch[k], got ? await self.RepMatch.features(got.b64, got.type) : null);
          mt.done++;
        }
        again();
      }
      mt.sims = slides.map((u) => pics.map((list) => {
        let best = null;
        for (const p of list) {
          const v = self.RepMatch.similarity(feats.get(u), feats.get(p));
          if (v != null && (best == null || v > best)) best = v;
        }
        return best;
      }));
      mt.state = 'done';
    } catch (_) {
      mt.state = 'failed';
    }
    again();
  }

  function togglePicker() {
    if (!$picks.hidden && picksMode === 'gallery') return closePicks();
    if (!galleryNow) return;
    picksMode = 'gallery';
    pickerSlide = slideNow ? slideNow.index : pickerSlide;
    for (const l of galleryNow.data.links) {
      if (!pickerInfos.has(l.parsed.key)) pickerInfos.set(l.parsed.key, { el: galleryNow.carousel, parsed: l.parsed, key: l.parsed.key, url: l.parsed.url, orig: l.parsed.url, mode: 'pick', pill: null, label: l.label });
    }
    $picks.hidden = false;
    renderPicker();
    refreshStates();
    paintBar();
    startMatch();
  }

  /** The list above the bar for a gallery photo: the post's items, the likeliest first, each with Save. */
  function renderPicker() {
    const g = galleryNow;
    if (!g) return void ($picks.hidden = true);
    if (slideNow) pickerSlide = slideNow.index;
    const links = g.data.links;
    const total = g.data.photos.length;
    const mt = matches.get(g.postId) || { state: 'loading', done: 0, total: 0, info: [] };
    const rank = U.rankPhotoLinks(mt.sims ? mt.sims[pickerSlide] : null, pickerSlide, total, links.length);
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (cls, text, title, fn) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', (ev) => ev.isTrusted && fn());
      return b;
    };
    $picks.replaceChildren();
    const head = el('div', 'head');
    head.append(el('b', '', 'Which item is in photo ' + (pickerSlide + 1) + ' of ' + total + '?'), button('', '×', 'Close', closePicks));
    $picks.append(head);
    if (!links.length) {
      $picks.append(el('div', 'hint', 'This post has no product links, in its text or in the poster’s comments.'));
      return;
    }
    const status = mt.state === 'loading' ? (mt.total ? 'Comparing the photo with each item’s pictures… ' + mt.done + ' of ' + mt.total : 'Looking up the items…')
      : mt.state === 'failed' ? 'Could not compare the pictures, so these are in the post’s order.'
      : !mt.sims || rank.byOrder ? 'In the post’s order. Pick the one in the photo.'
      : rank.sure ? 'The closest match is first.' : 'Not sure which one: the closest looking first.';
    $picks.append(el('div', 'hint', status));
    rank.order.forEach((j, n) => {
      const l = links[j];
      const meta = mt.info[j] || {};
      const info = pickerInfos.get(l.parsed.key);
      const st = states[l.parsed.key] || {};
      const row = el('div', 'row' + (n === 0 && (rank.sure || rank.byOrder) ? ' best' : ''));
      if (meta.image) {
        const pic = el('img', 'pic');
        pic.alt = '';
        pic.referrerPolicy = 'no-referrer';
        pic.src = U.thumbUrl(meta.image, 80) || meta.image;
        pic.addEventListener('error', () => pic.remove());
        row.append(pic);
      }
      const what = el('div', 'what', l.label || meta.title || 'Item ' + (j + 1));
      if (typeof meta.price === 'number') what.append(el('small', '', '¥' + meta.price));
      if (n === 0 && mt.sims && !rank.byOrder) what.append(el('span', 'tag', rank.sure ? 'Looks like this photo' : 'Closest'));
      row.append(what);
      if (info) row.append(button(st.saved ? '' : 'go', st.saved ? '✓ Saved' : '+ Save', st.saved ? 'In your list. Click for options.' : 'Save this item to your list', () => toggleSave(info)));
      $picks.append(row);
    });
    $picks.append(el('div', 'hint', 'RepHop compares the photo with each item’s own pictures, on your computer. It can be wrong: check the picture before you save.'));
    const top = $bar.getBoundingClientRect().top;
    if (top > 0) $picks.style.bottom = Math.round(window.innerHeight - top + 8) + 'px';
  }

  // ------------------------------------------------------ context & labels

  function abs(path) {
    try {
      return path ? new URL(path, location.origin).href : '';
    } catch (_) {
      return '';
    }
  }

  function redditContext(el) {
    const ctx = { site: 'reddit', sub: '', postId: '', postTitle: '', postUrl: '', commentUrl: '', author: '' };
    const onPost = /\/comments\/[a-z0-9]+/i.test(location.pathname);
    const comment = el.closest('shreddit-comment');
    const post = el.closest('shreddit-post') || (onPost ? document.querySelector('shreddit-post') : null);
    if (comment) {
      ctx.author = comment.getAttribute('author') || '';
      ctx.commentUrl = abs(comment.getAttribute('permalink'));
    }
    if (post) {
      ctx.postTitle = post.getAttribute('post-title') || '';
      ctx.postUrl = abs(post.getAttribute('permalink'));
      ctx.sub = post.getAttribute('subreddit-prefixed-name') || '';
      ctx.postId = (post.getAttribute('id') || '').replace(/^t3_/, '');
      if (!comment) ctx.author = post.getAttribute('author') || '';
    } else {
      const thing = el.closest('.thing');
      if (thing && thing.classList.contains('comment')) {
        ctx.commentUrl = abs(thing.dataset.permalink);
        ctx.author = thing.dataset.author || '';
      }
      const link = thing && thing.classList.contains('link') ? thing : onPost ? document.querySelector('#siteTable .thing.link') : null;
      if (link) {
        const title = link.querySelector('a.title');
        ctx.postUrl = abs(link.dataset.permalink);
        ctx.postTitle = title ? title.textContent.trim() : '';
        ctx.sub = link.dataset.subreddit ? 'r/' + link.dataset.subreddit : '';
        ctx.postId = (link.dataset.fullname || '').replace(/^t3_/, '');
        if (!ctx.author) ctx.author = link.dataset.author || '';
      }
    }
    const m = location.pathname.match(/^\/r\/([^/]+)(?:\/comments\/([a-z0-9]+))?/i);
    if (m) {
      if (!ctx.sub) ctx.sub = 'r/' + m[1];
      if (!ctx.postId && m[2]) ctx.postId = m[2];
    }
    if (!ctx.postUrl) ctx.postUrl = location.origin + location.pathname;
    if (!ctx.postTitle && onPost) ctx.postTitle = document.title.replace(/\s*[:|-]\s*(r\/\w+|reddit).*$/i, '').trim();
    return ctx;
  }

  function getContext(el) {
    if (IS_REDDIT && el) return redditContext(el);
    const title = document.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (IS_SHEETS) return { site: 'Google Sheets', postTitle: title.replace(/ - Google (Sheets|Drive)$/, ''), postUrl: (window.top === window ? location.href : document.referrer || location.href).split('#')[0] };
    if (IS_YUPOO) return { site: 'Yupoo', sub: L.yupooUser(location.href) || '', postTitle: title.split(/\s\|\s/)[0], postUrl: location.href };
    return { site: HOST, postTitle: title, postUrl: location.href };
  }

  const PRICE_ONLY = /^[¥￥$€£]?\s*[\d.,]+\s*(yuan|rmb|cny|usd|元)?$/i;

  /** The words a human wrote next to a link, used as the item's name in the list. */
  function contextLabel(el) {
    const own = el.tagName === 'A' ? L.cleanLabel(el.textContent) : '';
    if (own) return own;
    let text = '';
    let node = el.previousSibling;
    for (let hops = 0; node && hops < 6 && text.length < 160; hops++, node = node.previousSibling) {
      if (node.nodeType === 3) text = node.nodeValue + text;
      else if (node.nodeType === 1) {
        if (/^(BR|A|P|DIV|LI|TR|TABLE|UL|OL|H[1-6]|HR)$/.test(node.tagName) || isOurs(node)) break;
        text = node.textContent + text;
      }
    }
    const before = L.cleanLabel(text.split('\n').pop());
    if (before && !PRICE_ONLY.test(before)) return before;
    const row = el.closest('tr');
    if (row) {
      for (const cell of row.cells) {
        if (cell.contains(el) || cell.tagName === 'TH') continue;
        const t = L.cleanLabel(cell.textContent);
        if (t && !PRICE_ONLY.test(t)) return t;
      }
    }
    const block = el.closest('li, p, td');
    if (block && block.querySelectorAll('a[href], .rh-text').length === 1) {
      const t = L.cleanLabel(block.textContent.replace(el.textContent, ' '));
      if (t && !PRICE_ONLY.test(t)) return t;
    }
    return '';
  }

  // ------------------------------------------------------ state & tracking

  const refreshStates = debounce(async () => {
    const keys = new Set();
    for (const info of live) {
      if (info.el.isConnected) keys.add(info.key);
      else live.delete(info);
    }
    if (pageItem) keys.add(pageItem.key);
    for (const info of pickerInfos.values()) keys.add(info.key);
    if (!keys.size) return;
    // Asked in batches so a thread with thousands of links is covered in full.
    const next = {};
    for (const batch of U.chunkArray(Array.from(keys), 500)) {
      const res = await send({ type: 'lookup', keys: batch, detail: IS_AGENT && pageItem ? pageItem.key : '' });
      if (!res) return;
      Object.assign(next, res);
    }
    states = next;
    repaintAll();
  }, 250);

  const pendingSeen = new Map();
  const reportedSeen = new Set();
  const flushSeen = debounce(async () => {
    if (!pendingSeen.size) return;
    const entries = Array.from(pendingSeen.values());
    pendingSeen.clear();
    for (const batch of U.chunkArray(entries, 300)) await send({ type: 'seen', entries: batch });
  }, 2000);

  function noteSeen(info) {
    if (!IS_REDDIT || info.mode !== 'inline') return;
    const postId = redditContext(info.el).postId;
    if (!postId) return;
    const id = info.key + '|' + postId;
    if (reportedSeen.has(id)) return;
    reportedSeen.add(id);
    pendingSeen.set(id, { key: info.key, postId });
    flushSeen();
  }

  function setBusy(info, on) {
    const root = info && info.pill && pillRoots.get(info.pill);
    if (root) root.querySelector('.pill').classList.toggle('busy', on);
  }

  // --------------------------------------------------------------- actions

  const REASONS = {
    unsupported: "That link isn't a product RepHop can read.",
    network: "Couldn't reach that link. Check your connection and try again.",
    unresolved: "That short link didn't lead to a product.",
    error: 'Something went wrong. Try again.',
  };

  async function doOpen(info, disposition) {
    if (!alive) return;
    setCardTarget(null);
    setBusy(info, true);
    const res = await send({ type: 'open', url: info.url, disposition: disposition || 'default' });
    setBusy(info, false);
    if (!res) {
      // The worker is unreachable: never swallow the click, fall back to the plain link.
      window.open(info.orig, '_blank', 'noopener');
      return;
    }
    if (!res.ok && res.reason === 'no-agent') return void chooseAgent(() => doOpen(info, disposition), info.mode === 'page' ? '' : info.orig);
    if (!res.ok) return void toast(REASONS[res.reason] || REASONS.error, 'error');
    if (res.noBuyLink) toast('No Weidian or Taobao link on that album, so the album itself was opened.', 'warn');
    else if (res.fallback) toast(res.message, 'warn');
    else if (!res.focused) toast('Opened in ' + res.agent + (disposition === 'background' ? ' in a background tab.' : '.'), 'ok');
    states[info.key] = Object.assign({}, states[info.key], { viewed: true });
    repaintAll();
  }

  async function doSave(info) {
    if (!alive) return;
    setBusy(info, true);
    const el = info.el;
    // Saving from the agent's own listing page also remembers the colour, size and so on picked there.
    const picked = info.mode === 'page' && IS_AGENT ? selectedOptions(true) : [];
    const res = await send({ type: 'save', url: info.url, ctx: getContext(el), label: info.label || (el ? contextLabel(el) : ''), options: picked.length ? picked : undefined });
    setBusy(info, false);
    if (!res) return;
    if (!res.ok) return void toast(res.message || REASONS[res.reason] || REASONS.error, 'error');
    toast(res.message, res.noBuyLink || res.pending ? 'warn' : 'ok', res.added ? { label: 'Undo', fn: () => send({ type: 'remove', keys: res.keys }) } : null);
    refreshStates();
  }

  async function removeSaved(info) {
    const st = states[info.key] || {};
    const res = await send({ type: 'remove', keys: [st.itemKey || info.key] });
    if (res && res.removed && res.removed.length) toast('Removed from your list.', 'ok', { label: 'Undo', fn: () => send({ type: 'restore', items: res.removed }) });
  }

  /** The save button. On something already saved it asks first, so a stray click never throws away notes and tags. */
  function toggleSave(info) {
    const st = states[info.key];
    if (!st || !st.saved) return doSave(info);
    toast('Already in your list' + (st.status === 'carted' ? ' (in cart).' : st.status === 'bought' ? ' (bought).' : '.'), 'ok', [
      { label: 'Open list', fn: () => send({ type: 'openPanel' }) },
      { label: 'Remove', fn: () => removeSaved(info) },
    ]);
  }

  // ------------------------------------------------ this listing's picks
  // On an agent's listing that is in your list, the bar's "In cart" opens what you want from it: every pick with
  // its colour, size and whether it is in the cart, Add to cart for the ones still to add, and a way to add
  // what is selected on the page as another pick (the top and the trousers of a set).

  const pickText = (p) => (p.options || []).map((o) => o.v).join(' · ') || 'No colour or size chosen yet';

  function closePicks() {
    $picks.hidden = true;
    paintBar();
  }

  function togglePicks() {
    if (!$picks.hidden) return closePicks();
    picksMode = 'listing';
    $picks.hidden = false;
    renderPicks();
    paintBar();
  }

  /** Add one pick to your cart: RepHop opens the listing afresh, sets its choices and presses Add To Cart. */
  async function addPickToCart(itemKey, pick) {
    const r = await send({ type: 'queue', op: 'start', keys: [itemKey], owner: [pick.id ? { v: pick.id } : null], auto: true });
    if (!r || !r.ok) return void toast(r && r.reason === 'no-agent' ? 'Choose your shopping agent first.' : 'Could not start: is RepHop busy adding something else?', 'error');
    closePicks();
  }

  /** What is selected on the page, saved as another pick; with `andCart`, added to the cart right away. */
  async function addSelected(itemKey, andCart) {
    const picked = selectedOptions(false);
    if (!picked.length) return void toast('Choose a colour or size on the page first.', 'error');
    const st = states[pageItem.key] || {};
    const same = (st.picks || []).find((p) => p.options.length && picked.every((o) => p.options.some((x) => x.n === o.n && x.v === o.v)) && p.options.length === picked.length);
    if (same && !andCart) return void toast('That one is already in your list: ' + pickText(same) + '.', 'ok');
    if (same) return addPickToCart(itemKey, same);
    const r = await send({ type: 'pick', op: 'add', key: itemKey, options: picked });
    if (!r || !r.ok) return void toast('This item already has 10 picks.', 'error');
    if (andCart) return addPickToCart(itemKey, { id: r.id });
    toast('Added ' + picked.map((o) => o.v).join(' / ') + ' to your list.', 'ok');
    refreshStates();
  }

  function renderPicks() {
    const st = pageItem ? states[pageItem.key] || {} : {};
    if (!pageItem || !st.saved || !Array.isArray(st.picks)) return void ($picks.hidden = true);
    const itemKey = st.itemKey || pageItem.key;
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const button = (cls, text, title, fn) => {
      const b = el('button', cls, text);
      b.type = 'button';
      if (title) b.title = title;
      b.addEventListener('click', (ev) => {
        if (!ev.isTrusted) return;
        fn();
      });
      return b;
    };
    $picks.replaceChildren();
    const head = el('div', 'head');
    head.append(el('b', '', 'From this listing'), button('', '×', 'Close', closePicks));
    $picks.append(head);
    for (const p of st.picks) {
      const row = el('div', 'row');
      if (p.img) {
        const pic = el('img', 'pic');
        pic.alt = '';
        pic.referrerPolicy = 'no-referrer';
        pic.src = U.thumbUrl(p.img, 80) || p.img;
        pic.addEventListener('error', () => pic.remove());
        row.append(pic);
      }
      const what = el('div', 'what', pickText(p));
      if ((p.qty || 1) > 1) what.append(el('small', '', '× ' + p.qty));
      row.append(what);
      if (p.status === 'saved') row.append(button('', 'Add to cart', 'RepHop sets these choices on this page and presses Add To Cart', () => addPickToCart(itemKey, p)));
      else {
        const done = el('span', 'st in');
        done.innerHTML = ICON.check;
        done.append(p.status === 'bought' ? ' Bought' : ' In cart');
        row.append(done);
      }
      $picks.append(row);
    }
    const here = el('div', 'here');
    const picked = selectedOptions(false);
    const sel = el('div', 'sel');
    if (picked.length) {
      sel.append('Selected on this page: ');
      sel.append(el('b', '', picked.map((o) => o.v).join(' · ')));
    } else sel.textContent = 'Choose a colour and size on the page to add another pick.';
    here.append(sel);
    const btns = el('div', 'btns');
    btns.append(
      button('', '+ Add to my list', 'Keep this colour and size as another pick from this listing', () => addSelected(itemKey, false)),
      button('go', '+ Add to cart', 'Keep it as another pick and add it to your cart now', () => addSelected(itemKey, true)));
    here.append(btns);
    here.append(el('div', 'hint', 'Pressing this page’s own Add To Cart works too: RepHop adds what you chose here as a pick.'));
    $picks.append(here);
    // Sit just above the bar, however tall it is.
    const top = $bar.getBoundingClientRect().top;
    if (top > 0) $picks.style.bottom = Math.round(window.innerHeight - top + 8) + 'px';
  }

  // The list follows the choices you click on the page.
  document.addEventListener('click', (ev) => {
    if (!ev.isTrusted || $picks.hidden || !ev.target.closest || !ev.target.closest('ul.goods-options-tags > li')) return;
    setTimeout(() => !$picks.hidden && renderPicks(), 150);
  }, true);

  async function doQc(info) {
    let item = info.parsed;
    if (item.kind !== 'item') {
      const d = await send({ type: 'describe', url: info.url });
      item = d && d.ok && !d.noBuyLink ? L.keyToItem(d.key) : null;
    }
    const url = item ? L.qcUrl(item, settings) : null;
    if (!url) return void toast('QC lookup needs a Weidian, Taobao or 1688 item.', 'error');
    send({ type: 'openTab', url });
  }

  // ------------------------------------------------------- clicks & hotkeys

  function linkFromEvent(ev) {
    const path = ev.composedPath ? ev.composedPath() : [ev.target];
    for (const el of path) {
      if (!el || el.nodeType !== 1) continue;
      if (el.hasAttribute('data-rh-pill')) return { info: pillInfo.get(el) || null, onPill: true };
      if (el.hasAttribute('data-rh-ui')) return null;
      if (el.classList.contains('rh-text')) return { info: infos.get(el) || null };
      if (el.tagName === 'A' && el.href) {
        if (!SCAN_PAGE || inEditor(el)) return null;
        return { info: infoFor(el) };
      }
    }
    return null;
  }

  function block(ev) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }

  // Only the user's own clicks and key presses are acted on. A click made by a page script is left alone.
  window.addEventListener('click', (ev) => {
    if (!alive || !ev.isTrusted || ev.button !== 0) return;
    const hit = linkFromEvent(ev);
    if (!hit || hit.onPill || !hit.info || hit.info.mode !== 'inline') return;
    const info = hit.info;
    if (ev.shiftKey) return; // Shift+click always behaves like a normal link
    if (ev.altKey) {
      if (!settings.altClickSave) return;
      block(ev);
      doSave(info);
      return;
    }
    if (!settings.clickHijack) return;
    // Dragging across a plain-text link to select it is not a click on it.
    if (info.text && String(window.getSelection && window.getSelection()).length) return;
    block(ev);
    doOpen(info, ev.ctrlKey || ev.metaKey ? 'background' : 'default');
  }, true);

  window.addEventListener('auxclick', (ev) => {
    if (!alive || !ev.isTrusted || ev.button !== 1 || !settings.clickHijack) return;
    const hit = linkFromEvent(ev);
    if (!hit || hit.onPill || !hit.info || hit.info.mode !== 'inline' || hit.info.text) return;
    block(ev);
    doOpen(hit.info, 'background');
  }, true);

  // The link the keys act on: the one under a mouse that has really moved onto it, or the one with keyboard focus.
  // Scrolling can slide a link under a resting cursor; that alone never arms the keys.
  let hovered = null;
  let armed = false;
  let focused = null;
  let cardFor = null;
  let cardTimer = null;

  function setCardTarget(info) {
    if (info === cardFor) return;
    cardFor = info;
    clearTimeout(cardTimer);
    hideCard();
    if (info && settings.hoverCard && alive) cardTimer = setTimeout(() => showCard(info), 380);
  }

  window.addEventListener('mouseover', (ev) => {
    if (!ev.isTrusted) return;
    const hit = linkFromEvent(ev);
    const info = hit && hit.info ? hit.info : null;
    if (info === hovered) return;
    hovered = info;
    armed = false;
    setCardTarget(info || focused);
  }, true);

  window.addEventListener('mousemove', (ev) => {
    if (hovered && ev.isTrusted) armed = true;
  }, { capture: true, passive: true });

  document.addEventListener('scroll', () => {
    armed = false;
    setCardTarget(null);
  }, { capture: true, passive: true });

  // Keyboard focus only. A link also receives focus when it is clicked with the mouse, and that must not
  // pin the card to it or point the hotkeys at it.
  window.addEventListener('focusin', (ev) => {
    const hit = linkFromEvent(ev);
    const info = hit && hit.info && !hit.onPill ? hit.info : null;
    focused = info && info.el.matches(':focus-visible') ? info : null;
    if (focused) setCardTarget(focused);
  }, true);

  window.addEventListener('focusout', () => {
    const was = focused;
    focused = null;
    if (was && cardFor === was) setCardTarget(hovered && armed ? hovered : null);
  }, true);

  /** Is the user typing somewhere? Looks through open shadow roots to the element that really has focus. */
  function typing(ev) {
    if (ev.isComposing || ev.keyCode === 229) return true;
    const first = ev.composedPath ? ev.composedPath()[0] : ev.target;
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    for (const t of [first, active]) {
      if (!t || t.nodeType !== 1) continue;
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role="textbox"], [contenteditable=""], [contenteditable="true"]')) return true;
      // A component that hides its insides (closed shadow root) but is clearly an editor.
      if (t.tagName.includes('-') && /composer|editor|textarea|input|search/i.test(t.tagName)) return true;
    }
    return false;
  }

  window.addEventListener('keydown', (ev) => {
    if (!alive || !ev.isTrusted) return;
    if (ev.key === 'Escape') {
      setCardTarget(null);
      if (!$chooser.hidden) $chooser.hidden = true;
      if (!$picks.hidden) closePicks();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat || typing(ev)) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (queueHere() && (k === ']' || k === '[')) {
      block(ev);
      stepQueue(k === ']' ? 1 : -1);
      return;
    }
    const target = hovered && armed ? hovered : focused;
    if (!settings.hotkeysEnabled || !target || !target.el.isConnected) return;
    const keys = settings.keys;
    if (k === keys.open) doOpen(target, ev.shiftKey ? 'background' : 'default');
    else if (k === keys.save) doSave(target);
    else if (k === keys.qc) doQc(target);
    else if (k === keys.original) send({ type: 'openTab', url: target.orig });
    else return;
    block(ev);
    setCardTarget(null);
  }, true);

  // ------------------------------------------------------------ hover card

  const cardCache = new Map();

  function hideCard() {
    $card.classList.remove('on');
  }

  function setThumb(box, url) {
    box.replaceChildren();
    const small = U.thumbUrl(url, 200);
    if (!small) {
      box.textContent = box.dataset.mono || '';
      return;
    }
    // Pictures added by the extension are not subject to the page's own image policy,
    // and the worker's header rule supplies the referer Yupoo insists on.
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      img.remove();
      box.textContent = box.dataset.mono || '';
    }, { once: true });
    img.src = small;
    box.appendChild(img);
  }

  function fillCard(info, d) {
    const st = Object.assign({}, states[info.key], d && d.info);
    const title = $card.querySelector('.title');
    const sub = $card.querySelector('.sub');
    const price = $card.querySelector('.price');
    const tags = $card.querySelector('.tags');
    const keys = $card.querySelector('.keys');
    const pic = $card.querySelector('.pic');
    const platform = (L.PLATFORMS[(d && d.platform) || info.parsed.platform] || {}).label || 'Link';
    pic.dataset.mono = (L.PLATFORMS[(d && d.platform) || info.parsed.platform] || {}).short || '';
    tags.textContent = '';
    price.textContent = '';
    const tag = (text, cls) => {
      const el = document.createElement('span');
      el.className = 'tag' + (cls ? ' ' + cls : '');
      el.textContent = text;
      tags.appendChild(el);
    };
    if (!d) {
      title.textContent = info.parsed.kind === 'yupoo' ? 'Reading the album…' : 'Loading…';
      sub.textContent = platform;
      setThumb(pic, '');
    } else if (!d.ok) {
      title.textContent = info.parsed.kind === 'short' ? 'Short link' : platform + ' link';
      sub.textContent = d.reason === 'short' ? 'Open or save it to see what it is' : d.reason === 'network' ? "Couldn't load a preview" : 'No preview available';
      setThumb(pic, '');
    } else {
      title.textContent = d.title || platform + ' item';
      sub.textContent = [platform, d.seller && d.seller.name, d.subtitle].filter(Boolean).join(' · ');
      if (d.price != null) {
        const conv = U.convert(d.price, rates, settings.currency);
        price.append(U.yuan(d.price));
        if (conv != null && settings.currency !== 'CNY') {
          const small = document.createElement('small');
          small.textContent = '  ≈ ' + U.money(conv, settings.currency);
          price.appendChild(small);
        }
      }
      setThumb(pic, d.image);
      if (d.state === 'gone') tag(d.platform === 'yupoo' ? 'Album removed' : 'Removed?', 'bad');
      else if (d.noBuyLink) tag('No buy link on album', 'bad');
      if (d.state === 'soldout') tag('Sold out', 'bad');
      if (d.platform !== 'yupoo' && d.platform !== 'weidian' && !d.title) tag('Preview appears after you open it once');
    }
    if (st.saved) tag(st.status === 'carted' ? 'In cart' : st.status === 'bought' ? 'Bought' : 'In your list', 'good');
    if (st.viewed) tag('Viewed');
    if (st.trusted) tag('Trusted seller', 'gold');
    if (st.mentions) tag('Seen in ' + st.mentions + ' posts', 'gold');
    keys.textContent = '';
    if (settings.hotkeysEnabled) {
      const hint = (key, text) => {
        const kbd = document.createElement('kbd');
        kbd.textContent = key.toUpperCase();
        keys.append(kbd, ' ' + text + '  ');
      };
      hint(settings.keys.open, 'open');
      hint(settings.keys.save, 'save');
      hint(settings.keys.qc, 'QC');
      hint(settings.keys.original, 'original');
    }
  }

  async function showCard(info) {
    if (cardFor !== info || !info.el.isConnected) return;
    const r = (info.pill && info.pill.isConnected ? info.pill : info.el).getBoundingClientRect();
    const anchor = info.el.getBoundingClientRect();
    const cached = cardCache.get(info.key);
    const fresh = cached && Date.now() - cached.at < 60000;
    fillCard(info, fresh ? cached.d : null);
    $card.classList.add('on');
    const h = $card.offsetHeight || 96;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 308));
    const below = Math.max(anchor.bottom, r.bottom) + 8;
    $card.style.left = left + 'px';
    $card.style.top = (below + h > window.innerHeight - 8 ? Math.max(8, Math.min(anchor.top, r.top) - h - 8) : below) + 'px';
    if (fresh) return;
    const d = (await send({ type: 'describe', url: info.url })) || { ok: false, reason: 'error' };
    cardCache.set(info.key, { d, at: Date.now() });
    if (cardCache.size > 200) cardCache.delete(cardCache.keys().next().value);
    if (cardFor === info) fillCard(info, d);
  }

  // ------------------------------------------------------------- action bar

  function inlineLinks() {
    const byKey = new Map();
    for (const info of live) {
      if (!info.el.isConnected) {
        live.delete(info);
        continue;
      }
      if (info.mode === 'inline' && !byKey.has(info.key)) byKey.set(info.key, info);
    }
    return Array.from(byKey.values());
  }

  function onAgentTarget() {
    const a = L.toUrl(agent.template.replace(/\{[^}]+\}/g, 'x'));
    return !!a && a.hostname.replace(/^www\./, '') === HOST;
  }

  function queueHere() {
    return !!(queue && queue.active && queue.keys.length && pageItem && queue.keys[queue.i] === pageItem.key);
  }

  function paintBar() {
    const count = SCAN_PAGE ? inlineLinks().length : 0;
    const inQueue = queueHere();
    const show = settings.showFab && alive && (pageItem || count > 0 || SHEETS_APP || inQueue || (IS_AGENT && backTo) || photoNow || (slideNow && galleryNow) || (cartCount > 0 && isCart()));
    $bar.classList.toggle('on', !!show);
    if (!show) return;
    // On a product page the bar is how you save the item, so it is never folded away there.
    $bar.classList.toggle('collapsed', fabCollapsed && !inQueue && !pageItem && !(cartCount > 0 && isCart()));
    const btn = (act) => $bar.querySelector('[data-act="' + act + '"]');
    const st = pageItem ? states[pageItem.key] || {} : {};

    const back = btn('back');
    back.hidden = !(IS_AGENT && backTo) || !!(inQueue && queue.auto && runHere());
    if (!back.hidden) {
      back.textContent = '← Back to ' + backTo;
      back.title = 'Go back to the page you opened this from';
    }

    const q = $bar.querySelector('.q');
    q.hidden = !inQueue;
    for (const act of ['qprev', 'qnext', 'qstop']) btn(act).hidden = !inQueue;
    $bar.querySelector('[data-for="queue"]').hidden = !inQueue;
    if (inQueue) {
      const at = (queue.i + 1) + ' of ' + queue.keys.length;
      const last = queue.i + 1 >= queue.keys.length;
      if (queue.auto && runHere()) {
        const mine = auto.key === pageItem.key ? auto : {};
        const short = (t) => (t.length > 96 ? t.slice(0, 94).replace(/[\s,;.:]+\S*$/, '') + '…' : t);
        q.textContent = mine.state === 'needs' ? at + ': ' + short(mine.need) : mine.state === 'done' ? at + ': added ✓' : mine.state === 'press' ? at + ': all set, press Add To Cart' : 'Adding ' + (mine.who ? mine.who + '’s ' : '') + 'to cart, ' + at + '…';
        q.title = mine.state === 'needs' ? mine.need : '';
        btn('qnext').textContent = last ? 'Skip and finish' : 'Skip ▶';
        btn('qnext').title = 'Leave this one out and go on';
        btn('qprev').hidden = true;
        btn('qstop').textContent = 'Stop';
      } else if (queue.auto) {
        // An add-to-cart run works in the tab it opened. Any other tab showing the same listing only says so.
        q.textContent = 'Adding to cart, ' + at + ' (in the tab RepHop opened)';
        btn('qnext').hidden = btn('qprev').hidden = true;
        btn('qstop').textContent = 'Stop';
      } else {
        q.textContent = 'Queue ' + at;
        btn('qnext').textContent = last ? 'Finish ✓' : 'Next ▶';
        btn('qnext').title = 'Next item in the queue ( ] )';
        btn('qprev').style.visibility = queue.i === 0 ? 'hidden' : 'visible';
        btn('qstop').textContent = 'End';
      }
    }

    const open = btn('open');
    open.hidden = !pageItem || (onAgentTarget() && pageItem.kind === 'item');
    open.textContent = pageItem && pageItem.kind === 'yupoo' ? 'Find buy link → ' + agent.name : 'Open in ' + agent.name;
    const save = btn('save');
    save.hidden = !pageItem;
    save.classList.toggle('on-state', !!st.saved);
    // Where "open" is not on offer (you are already on the agent's listing), saving is the main thing to do.
    save.classList.toggle('primary', !st.saved && open.hidden);
    save.innerHTML = '';
    save.insertAdjacentHTML('afterbegin', st.saved ? ICON.check : ICON.plus);
    const picks = IS_AGENT && st.saved && Array.isArray(st.picks) ? st.picks : null;
    const inCart = picks ? picks.filter((p) => p.status !== 'saved').length : 0;
    if (picks && picks.length > 1) {
      // Several picks from this listing: say how many are in the cart.
      save.append(inCart === picks.length ? ' All ' + picks.length + ' in cart' : inCart ? ' ' + inCart + ' of ' + picks.length + ' in cart' : ' Saved to RepHop');
      const c = document.createElement('span');
      c.className = 'count';
      c.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
      save.append(c);
    } else save.append(st.saved ? (st.status === 'carted' ? ' In cart' : st.status === 'bought' ? ' Bought' : ' Saved to RepHop') : ' Save to RepHop');
    save.title = picks ? 'What you want from this listing, and what is in your cart. Click to see it, or to add another colour or size.'
      : st.saved ? 'In your RepHop list. Click for options.' : 'Save this item to your RepHop list' + (IS_AGENT ? ', with the options you have picked here' : '');
    save.setAttribute('aria-expanded', String(!!picks && !$picks.hidden));
    if (!$picks.hidden) (picksMode === 'gallery' ? renderPicker() : renderPicks());
    btn('qc').hidden = !pageItem || pageItem.kind !== 'item';
    if (inQueue && queue.auto && runHere()) save.hidden = btn('qc').hidden = true;
    const photo = btn('photo');
    photo.hidden = !photoNow;
    if (photoNow) {
      const ps = states[photoNow.key] || {};
      photo.innerHTML = '';
      photo.insertAdjacentHTML('afterbegin', ps.saved ? ICON.check : ICON.plus);
      photo.append(ps.saved ? ' This photo’s item is saved' : ' Save this photo’s item');
      photo.classList.toggle('on-state', !!ps.saved);
      photo.classList.toggle('primary', !ps.saved);
      photo.title = (photoNow.label ? photoNow.label + ': ' : '') + 'the link the poster put on this photo';
    }
    const gpick = btn('gpick');
    gpick.hidden = !(slideNow && galleryNow && galleryNow.data.links.length) || !!photoNow;
    if (!gpick.hidden) {
      gpick.innerHTML = '';
      gpick.insertAdjacentHTML('afterbegin', ICON.plus);
      gpick.append(' Save from this photo ▴');
      gpick.title = 'Which of this post’s items is in this photo? RepHop shows them, the closest looking first.';
      gpick.setAttribute('aria-expanded', String(!$picks.hidden && picksMode === 'gallery'));
    }
    const grab = btn('grab');
    grab.hidden = !(count > 0 || SHEETS_APP);
    grab.textContent = SHEETS_APP ? 'Grab links from this tab' : 'Save all ' + count + ' link' + (count === 1 ? '' : 's');
    grab.title = SHEETS_APP ? 'Save the product links on the sheet tab you are looking at' : 'Save every product link on this page to your list';
    const cart = btn('cart');
    cart.hidden = !(cartCount > 0 && isCart());
    if (!cart.hidden) {
      const copied = cartCopied != null && cartCopied === cartNow;
      cart.innerHTML = '';
      cart.insertAdjacentHTML('afterbegin', copied ? ICON.check : ICON.plus);
      cart.append(copied ? (settings.cartSync ? ' List in step with this cart' : ' Cart copied to RepHop') : ' Copy cart to RepHop (' + cartCount + ')');
      cart.classList.toggle('on-state', !!copied);
      cart.classList.toggle('primary', !copied);
      cart.title = copied ? 'Everything here is in your RepHop list, marked In cart. Click to copy it again after a change.' : 'Add everything in this cart to your RepHop list, with the colours, sizes and quantities picked here, marked In cart';
    }
    btn('graball').hidden = !SHEETS_APP;
    btn('clickable').hidden = !SHEETS_APP;
  }

  function afterQueueStep(res) {
    if (!res) return;
    if (res.finished || res.stopped) {
      const r = res.summary ? Object.values(res.summary.results) : [];
      const n = (what) => r.filter((x) => x === what).length;
      if (r.length) toast('Done. ' + n('added') + ' added for you' + (n('manual') ? ', ' + n('manual') + ' added by you' : '') + (n('skipped') ? ', ' + n('skipped') + ' skipped' : '') + '.', 'ok', { label: 'OK', fn: () => {} }, { sticky: true });
      else if (res.finished) toast('Queue finished.', 'ok');
    } else if (res.edge === 'start') toast('That is the first item in the queue.', 'warn');
  }

  /** Move through the queue. In an add-to-cart run, moving on without adding counts as skipping the item. */
  function stepQueue(delta) {
    // An add-to-cart run is only steered from its own tab (or from the list).
    if (queue && queue.auto && !runHere()) return Promise.resolve();
    // This item has just been added and RepHop is about to move on by itself: a second "next" would skip the following one.
    if (queue && queue.auto && runHere() && auto.state === 'done' && delta > 0) return Promise.resolve();
    const result = queue && queue.auto && runHere() && delta > 0 && auto.state !== 'done' ? { key: pageItem.key, r: 'skipped' } : undefined;
    return send({ type: 'queue', op: 'step', delta, result, at: queue ? queue.i : undefined }).then(afterQueueStep);
  }

  $bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || !alive) return;
    const act = b.dataset.act;
    const own = pageItem ? { el: null, parsed: pageItem, key: pageItem.key, url: pageItem.url, orig: location.href, mode: 'page', pill: null } : null;
    if (act === 'toggle') {
      fabCollapsed = !fabCollapsed;
      try {
        chrome.storage.local.set({ fabCollapsed });
      } catch (_) {
        /* context gone */
      }
      paintBar();
    } else if (act === 'panel') send({ type: 'openPanel' });
    else if (act === 'back') send({ type: 'goBack' });
    else if (act === 'open' && own) doOpen(own, ev.ctrlKey || ev.metaKey ? 'background' : 'reuse');
    else if (act === 'save' && own && IS_AGENT && (states[own.key] || {}).saved && Array.isArray((states[own.key] || {}).picks)) togglePicks();
    else if (act === 'save' && own) toggleSave(own);
    else if (act === 'qc' && own) doQc(own);
    else if (act === 'photo' && photoNow) toggleSave(photoNow);
    else if (act === 'gpick') togglePicker();
    else if (act === 'grab') grabAll(false);
    else if (act === 'cart') copyCart(false);
    else if (act === 'graball') grabAll(true);
    else if (act === 'clickable') {
      const m = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
      const gid = (location.hash.match(/gid=(\d+)/) || [])[1];
      if (m) send({ type: 'openTab', url: location.origin + '/spreadsheets/d/' + m[1] + '/htmlview' + (gid ? '?gid=' + gid : '') });
    } else if (act === 'qnext') stepQueue(1);
    else if (act === 'qprev') stepQueue(-1);
    else if (act === 'qstop') send({ type: 'queue', op: 'stop' }).then(afterQueueStep);
  });

  // -------------------------------------------------- the agent's own cart
  // Superbuy's cart page (AllChinaBuy is the same site) draws each line as section.cart-good-item-container >
  // .goods-item, with a link to the listing it came from (/en/page/buy/?url=<the shop's link>), the choices made
  // ("size:M Color:Navy shirt"), the price and the quantity. Lines whose details the site could not load
  // (.load-failed) carry none of that. Other agents' carts have not been seen: there each product link that sits
  // next to a quantity box is taken as one line, and RepHop never concludes that something has left the cart.
  const SB_HOSTS = ['superbuy.com', 'allchinabuy.com'];

  function isCart() {
    if (!IS_AGENT || pageItem) return false;
    if (L.hostMatches(HOST, SB_HOSTS)) return /\/page\/shoppingcart\/?$/.test(location.pathname);
    return /cart/i.test(location.pathname + location.hash);
  }

  function cartAgentName() {
    for (const a of Object.values(L.AGENTS)) {
      const u = a.template && L.toUrl(a.template.replace(/\{[^}]+\}/g, 'x'));
      if (u && L.hostMatches(HOST, [u.hostname.replace(/^www\./, '')])) return a.name;
    }
    return 'agent';
  }

  const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();

  function sbCartRows() {
    const rows = [];
    const present = [];
    let unread = 0;
    let loading = false;
    for (const row of document.querySelectorAll('section.cart-good-item-container .goods-item')) {
      if (row.querySelector('.skeleton-wrapper')) {
        loading = true; // grey placeholders: still loading, or signed out
        continue;
      }
      const a = row.querySelector('.goods-name a[href]') || row.querySelector('a[aria-label="goodsLink"][href]');
      const parsed = a ? L.parseLink(a.href) : null;
      if (!parsed || parsed.kind !== 'item' || row.classList.contains('load-failed')) {
        unread++;
        if (parsed && parsed.kind === 'item') present.push(parsed.key);
        continue;
      }
      const txt = (sel) => {
        const el = row.querySelector(sel);
        return el ? clean(el.textContent) : '';
      };
      const input = row.querySelector('.count-operation input');
      const img = row.querySelector('.goods-img-box img');
      const src = img ? img.currentSrc || img.src || img.getAttribute('data-src') || '' : '';
      rows.push({
        url: a.href, key: parsed.key, title: txt('.goods-name .title'), sku: txt('.goods-name .color-type'), note: txt('.remark'),
        qty: (input && parseInt(input.value, 10)) || 1, price: U.yuanFrom(txt('.unit-price-box')),
        image: /good-item-default|^data:/.test(src) ? '' : src,
      });
    }
    const empty = !!document.querySelector('.cart-empty-container .empty');
    return { rows, unread, present, full: !loading && (rows.length > 0 || unread > 0 || empty), empty };
  }

  /** A quantity box: a small number in a number field, a spin button or something styled as a stepper. */
  function qtyBox(i) {
    if (/^(checkbox|radio|hidden|search|email|password)$/i.test(i.type) || !/^\d{1,3}$/.test(String(i.value).trim())) return false;
    return i.type === 'number' || i.getAttribute('role') === 'spinbutton' || !!i.closest('[class*="number" i], [class*="stepper" i], [class*="quantity" i], [class*="qty" i], [class*="count" i]');
  }

  /** Any other agent's cart: a line is the largest box around a product link that holds one quantity box and no other product. */
  function anyCartRows() {
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (isOurs(a)) continue;
      const p = L.parseLink(a.href);
      if (p && p.kind === 'item') links.push({ a, p });
    }
    const boxes = Array.from(document.querySelectorAll('input')).filter(qtyBox);
    const found = new Map();
    for (const l of links) {
      let row = null;
      for (let el = l.a.parentElement; el && el !== document.body; el = el.parentElement) {
        const inside = boxes.filter((b) => el.contains(b)).length;
        if (inside > 1 || links.some((o) => o.p.key !== l.p.key && el.contains(o.a))) break;
        if (inside === 1) row = el;
      }
      if (row && !found.has(row)) found.set(row, l);
    }
    const rows = [];
    for (const [row, { a, p }] of found) {
      const box = boxes.find((b) => row.contains(b));
      const title = Array.from(row.querySelectorAll('a[href]')).filter((x) => (L.parseLink(x.href) || {}).key === p.key).map((x) => clean(x.textContent)).sort((x, y) => y.length - x.length)[0] || '';
      const skuEl = Array.from(row.querySelectorAll('[class*="sku" i], [class*="spec" i], [class*="prop" i], [class*="attr" i], [class*="variant" i], [class*="option" i]'))
        .find((el) => !el.contains(box) && !el.querySelector('a, input, button, select') && clean(el.textContent) && clean(el.textContent).length < 200);
      const price = Array.from(row.querySelectorAll('[class*="price" i]')).map((el) => U.yuanFrom(clean(el.textContent))).find((v) => v != null);
      const img = row.querySelector('img');
      rows.push({ url: a.href, key: p.key, title, sku: skuEl ? clean(skuEl.textContent) : '', note: '', qty: parseInt(box.value, 10) || 1, price: price == null ? null : price, image: img ? img.currentSrc || img.src || '' : '' });
    }
    return { rows, unread: 0, present: [], full: false, empty: false };
  }

  function cartRows() {
    return L.hostMatches(HOST, SB_HOSTS) ? sbCartRows() : anyCartRows();
  }

  const cartSig = (rows) => rows.map((r) => r.key + '|' + r.sku + '|' + r.qty).join('\n');

  function shortTitle(t) {
    t = String(t || '');
    return t.length > 52 ? t.slice(0, 50).replace(/\s+\S*$/, '') + '…' : t;
  }

  /** Copy the cart into the list. `auto`: started by RepHop, so it only speaks when something changed; `loud`: the list asked. */
  async function copyCart(auto, loud) {
    const read = cartRows();
    const sig = cartSig(read.rows);
    if (!read.rows.length && !(read.full && read.empty)) {
      if (!auto) toast('RepHop could not find any listing in this cart.', 'warn');
      return;
    }
    cartBusy = true;
    cartTried = sig;
    const res = await send(Object.assign({ type: 'importCart', auto, since: BORN, site: HOST, cartUrl: location.href }, read));
    cartBusy = false;
    if (!res) {
      if (!auto) toast('RepHop could not copy the cart. Try again.', 'warn');
      return;
    }
    if (res.ok) cartCopied = sig;
    paintBar();
    if (res.message && (!auto || loud || res.changed)) toast(res.message, res.ok ? 'ok' : 'warn', [{ label: 'Open list', fn: () => send({ type: 'openPanel' }) }, { label: 'OK', fn: () => {} }], { sticky: !!loud });
    if (res.stale && res.stale.length) askStale(res.stale, res.agent);
  }

  /** Things the list says are in the cart that the cart no longer holds: bought, or back to saved? Your call. */
  function askStale(list, name) {
    const n = list.length;
    const what = n === 1 ? '“' + shortTitle(list[0].title) + '” is marked In cart in your list but is' : n + ' things marked In cart in your list are';
    const names = n > 1 ? ' (' + list.slice(0, 3).map((x) => shortTitle(x.title)).join(', ') + (n > 3 ? '…' : '') + ')' : '';
    const answer = (op) => send({ type: 'cartStale', op, list: list.map((x) => ({ key: x.key, pick: x.pick })) }).then(refreshStates);
    toast(what + ' not in your ' + (name || 'agent') + ' cart any more' + names + '. Did you buy ' + (n === 1 ? 'it' : 'them') + '?', 'warn', [
      { label: 'Yes, bought', fn: () => answer('bought') },
      { label: 'Back to saved', fn: () => answer('saved') },
      { label: 'Keep as is', fn: () => answer('leave') },
    ], { sticky: true });
  }

  /**
   * The cart is drawn after the page loads and changes as you edit it. The bar's count follows it and, with
   * "Keep the list in step with your agent's cart" on (or when the list asked), the list is brought in step once
   * the page has settled. Agents that are single-page apps reach their cart without a page load, so this watches
   * every agent page (it does nothing until the address is a cart's).
   */
  function watchCart() {
    if (!IS_AGENT || cartTimer) return;
    let steady = 0;
    let waited = 0;
    let last = null;
    cartTimer = setInterval(() => {
      if (!alive) return;
      if (!isCart()) {
        if (cartCount) {
          cartCount = 0;
          paintBar();
        }
        return;
      }
      const read = cartRows();
      const sig = cartSig(read.rows);
      if (sig + read.empty !== last) {
        last = sig + read.empty;
        steady = 0;
        cartCount = read.rows.length;
        cartNow = sig;
        paintBar();
      } else steady++;
      const settled = steady >= 2 && (read.rows.length > 0 || (read.full && read.empty));
      if (cartWanted) {
        waited++;
        if (settled && read.rows.length) {
          cartWanted = false;
          copyCart(true, true);
        } else if (read.empty) {
          cartWanted = false;
          toast('Your ' + cartAgentName() + ' cart is empty.', 'warn');
        } else if (waited === 12 && !read.rows.length) {
          toast('Sign in to ' + cartAgentName() + ' and RepHop copies your cart in once it shows. Or press “Copy cart to RepHop” at the bottom left.', 'warn', { label: 'OK', fn: () => {} }, { sticky: true });
        }
        return;
      }
      if (settings.cartSync && settled && !cartBusy && cartTried !== sig) copyCart(true, false);
    }, 1000);
  }

  // -------------------------------------------------------------- grab all

  function domEntries() {
    return inlineLinks().map((info) => ({ url: info.url, label: contextLabel(info.el), ctx: getContext(info.el), key: info.key }));
  }

  /**
   * The Reddit thread as JSON, so comments that are collapsed or not on screen are included.
   * Reddit hands over about 500 comments per request and leaves the rest as "more" stubs; `missed` counts those.
   */
  async function redditThread() {
    const m = location.pathname.match(/\/comments\/([a-z0-9]+)/i);
    if (!m) return { entries: [], missed: 0 };
    const res = await fetch(location.origin + '/comments/' + m[1] + '.json?limit=500&depth=10&raw_json=1', { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const post = data[0].data.children[0].data;
    const base = { site: 'reddit', sub: post.subreddit_name_prefixed || '', postId: post.id, postTitle: post.title || '', postUrl: 'https://www.reddit.com' + post.permalink };
    const entries = [];
    let missed = 0;
    const add = (text, extra) => {
      for (const h of L.extractLabeled(text)) entries.push({ url: h.parsed.url, label: h.label, ctx: Object.assign({}, base, extra), key: h.parsed.key });
    };
    const direct = L.parseLink(post.url_overridden_by_dest || post.url || '');
    if (direct) entries.push({ url: direct.url, label: post.title, ctx: Object.assign({ author: post.author }, base), key: direct.key });
    add(post.selftext || '', { author: post.author });
    // A gallery's photos can carry a link and caption each.
    for (const g of post.gallery_data && Array.isArray(post.gallery_data.items) ? post.gallery_data.items : []) {
      const out = typeof g.outbound_url === 'string' ? L.parseLink(g.outbound_url) : null;
      const caption = typeof g.caption === 'string' ? g.caption : '';
      if (out) entries.push({ url: out.url, label: L.cleanLabel(caption.replace(/https?:\/\/\S+/g, ' ')) || post.title, ctx: Object.assign({ author: post.author }, base), key: out.key });
      add(caption, { author: post.author });
    }
    const walk = (children) => {
      for (const c of children || []) {
        if (!c || !c.data) continue;
        if (c.kind === 'more') missed += c.data.count || (c.data.children || []).length || 0;
        if (c.kind !== 't1') continue;
        add(c.data.body || '', { author: c.data.author, commentUrl: 'https://www.reddit.com' + c.data.permalink });
        if (c.data.replies && c.data.replies.data) walk(c.data.replies.data.children);
      }
    };
    walk(data[1] && data[1].data.children);
    return { entries, missed };
  }

  function rowLabel(el) {
    const row = el.closest('tr');
    if (!row) return '';
    for (const cell of row.cells) {
      if (cell.tagName === 'TH' || cell.contains(el)) continue;
      const t = L.cleanLabel(cell.textContent);
      if (t && !PRICE_ONLY.test(t)) return t;
    }
    return L.cleanLabel(el.textContent);
  }

  /** Product links in a Google Sheet, read from its plain HTML view. allTabs: every tab, otherwise the one on screen. */
  async function sheetEntries(allTabs) {
    const m = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
    if (!m || m[1] === 'e') throw new Error('unsupported');
    const base = location.origin + '/spreadsheets/d/' + m[1];
    const current = (location.hash.match(/gid=(\d+)/) || location.search.match(/gid=(\d+)/) || [])[1] || '0';
    let gids = [current];
    if (allTabs) {
      const index = await fetch(base + '/htmlview', { credentials: 'include' });
      if (!index.ok) throw new Error('HTTP ' + index.status);
      const found = Array.from(new Set(Array.from((await index.text()).matchAll(/gid(?:=|\\x3d|%3D)(\d+)/gi), (x) => x[1])));
      if (found.length) gids = found.slice(0, 40);
    }
    const ctx = getContext(null);
    const out = [];
    const seen = new Set();
    const push = (parsed, label) => {
      if (!parsed || seen.has(parsed.key)) return;
      seen.add(parsed.key);
      out.push({ url: parsed.url, label, ctx, key: parsed.key });
    };
    let read = 0;
    for (const gid of gids) {
      const res = await fetch(base + '/htmlview/sheet?headers=true&gid=' + gid, { credentials: 'include' });
      if (!res.ok) continue;
      read++;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      for (const a of doc.querySelectorAll('a[href]')) push(L.parseLink(a.getAttribute('href')) || L.parseLink(a.textContent), rowLabel(a));
      for (const td of doc.querySelectorAll('td')) {
        if (td.querySelector('a') || !L.mightContainLink(td.textContent)) continue;
        for (const h of L.extractLinks(td.textContent)) push(h.parsed, rowLabel(td));
      }
    }
    if (!read) throw new Error('unreadable');
    return out;
  }

  let grabbing = false;
  async function grabAll(allTabs) {
    if (grabbing || !alive) return;
    grabbing = true;
    $bar.classList.add('busy');
    const progress = toast(SHEETS_APP ? 'Reading the spreadsheet…' : 'Collecting links…', 'ok', null, { sticky: true });
    try {
      const byKey = new Map();
      let missed = 0;
      let threadFailed = false;
      if (SHEETS_APP) {
        for (const e of await sheetEntries(allTabs)) byKey.set(e.key, e);
      } else {
        for (const e of domEntries()) byKey.set(e.key, e);
        if (IS_REDDIT) {
          const thread = await redditThread().catch(() => ({ entries: [], missed: 0, failed: true }));
          missed = thread.missed;
          threadFailed = !!thread.failed;
          for (const e of thread.entries) {
            const have = byKey.get(e.key);
            if (!have) byKey.set(e.key, e);
            else if (!have.label && e.label) have.label = e.label;
          }
        }
      }
      const entries = Array.from(byKey.values()).map(({ url, label, ctx }) => ({ url, label, ctx }));
      if (!entries.length) {
        progress.close();
        return void toast(SHEETS_APP ? 'No product links found on ' + (allTabs ? 'this spreadsheet.' : 'this tab. Try “All tabs”.') : 'No product links found on this page.', 'warn');
      }
      // Saved in batches: each batch is stored as soon as it is done, and the message keeps count.
      const sum = { added: 0, duplicates: 0, failed: 0, noBuyLink: 0, pending: 0 };
      let done = 0;
      let stopped = false;
      for (const batch of U.chunkArray(entries, SAVE_BATCH)) {
        progress.set('Saving ' + Math.min(done + batch.length, entries.length) + ' of ' + entries.length + '…');
        const res = await send({ type: 'saveMany', entries: batch });
        if (!res) {
          stopped = true;
          break;
        }
        for (const k of Object.keys(sum)) sum[k] += res[k] || 0;
        if (res.reason) sum.reason = res.reason;
        if (res.title) sum.title = res.title;
        done += batch.length;
      }
      progress.close();
      let text = U.describeSave(sum);
      if (stopped) text += ' · stopped after ' + done + ' of ' + entries.length + ' (the extension was reloaded)';
      if (missed) text += ' · Reddit held back about ' + missed + ' more comments. Expand them on the page and save again to include them.';
      if (threadFailed) text += ' · Reddit did not hand over the comments that are not on screen, so only what is on the page was saved.';
      toast(text, sum.added || sum.duplicates ? (missed || stopped || threadFailed ? 'warn' : 'ok') : 'error', sum.added ? { label: 'Open list', fn: () => send({ type: 'openPanel' }) } : null);
      refreshStates();
    } catch (e) {
      progress.close();
      toast(SHEETS_APP ? "Couldn't read this spreadsheet. It may be private or restricted." : "Couldn't collect links from this page.", 'error');
    } finally {
      grabbing = false;
      $bar.classList.remove('busy');
    }
  }

  // --------------------------------------------- product pages & the queue

  function text(sel) {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** On the listing page itself, read the name, price and picture so saved items get them without extra requests. */
  function scrapeProductPage() {
    if (!pageItem || pageItem.kind !== 'item') return;
    const key = pageItem.key;
    if (L.hostMatches(HOST, ['superbuy.com', 'allchinabuy.com'])) {
      let tries = 0;
      const timer = setInterval(() => {
        if (++tries > 25 || !pageItem || pageItem.key !== key) return clearInterval(timer);
        // When the agent refuses an item it shows a notice and a wall of other products instead of the
        // listing. Nothing on such a page describes this item, so nothing is read from it.
        if (document.querySelector('.dialogRisk')) return clearInterval(timer);
        const title = text('.buy-info h3.goods-title');
        if (!title || title === '-') return;
        clearInterval(timer);
        // The page shows the price twice: in your display currency and in yuan. Take whichever is labelled yuan.
        const YUAN = /CN\s*[¥￥]|[¥￥]|CNY|RMB/i;
        const num = (t) => parseFloat(String(t).replace(/[^\d.]/g, ''));
        let price = NaN;
        if (YUAN.test(text('.buy-info .price-content i.goods-rmb'))) price = num(text('.buy-info .price-content strong.goods-txt'));
        if (!(price > 0)) {
          const m = text('.buy-info p.foreign-currency').match(/(?:CN\s*[¥￥]|[¥￥]|CNY|RMB)\s*([\d,]+(?:\.\d+)?)/i);
          if (m) price = num(m[1]);
        }
        let image = '';
        for (const img of document.querySelectorAll('.goods-info_container img, .buy-main img')) {
          if (img.naturalWidth >= 200 && /^https:/.test(img.src) && !/superbuy\.com|allchinabuy\.com/.test(img.src)) {
            image = img.src;
            break;
          }
        }
        send({ type: 'pagePatch', key, title, price: price > 0 ? price : undefined, image });
        // The rows of choices arrive with the listing; give them a moment, then pass them on so the
        // list can offer them as drop-downs.
        setTimeout(async () => {
          if (!pageItem || pageItem.key !== key) return;
          // A long row (more than 21 choices) keeps the rest behind "More": open it, or only part of the row is known.
          if (foldedRows() && expandRows()) await sleep(400);
          if (!pageItem || pageItem.key !== key) return;
          const groups = optionGroups();
          if (groups && groups.length && !groups.some((g) => g.multi) && !foldedRows()) send({ type: 'pagePatch', key, title, choices: groups.map((g) => ({ n: g.name, o: g.options.map((o) => o.text), i: g.options.map((o) => o.img) })) });
        }, 700);
      }, 800);
    } else if (IS_MARKET) {
      const meta = (p) => {
        const el = document.querySelector('meta[property="' + p + '"]');
        return el ? el.content.trim() : '';
      };
      const title = (meta('og:title') || document.title).replace(/\s*[-|_]\s*(淘宝网|天猫|Taobao|Tmall|1688|阿里巴巴|微店|Weidian).*$/i, '').trim();
      if (title && !/^(商品详情|微店|淘宝|登录)/.test(title)) send({ type: 'pagePatch', key, title, image: meta('og:image') });
    }
  }

  // ---------------------------------------------- reading a listing's options
  // Only Superbuy's listing layout (which AllChinaBuy shares) is read. This is what the page's own code
  // builds (checked October 2026):
  //   rows       .goods-options dl.goods-options-row, named by .good-propName
  //   choices    ul.goods-options-tags > li.sku-item. The name is the title of .sku-name / .sku-text (or of
  //              the picture). The chosen one is .active, an unavailable one .disabled. A long row keeps
  //              the rest behind li.more.
  //   wholesale  a row marked .multi takes an amount per choice instead of one choice
  //   no rows    a listing the site could not read offers a "Shopping Agent Notes" box (textarea#desc)
  //   consent    .rules-operation holds an "I have read and agree" box; Add To Cart is off until it is ticked
  //   result     after Add To Cart a dialog appears: .alert-dialog-success, or -error / -warning
  // The site pre-selects a choice in every row when the page loads, so "something is selected" never
  // means "you chose it". On every other agent RepHop picks and presses nothing: it walks you through
  // the queue and marks each item once you have added it yourself.

  const SB = L.hostMatches(HOST, ['superbuy.com', 'allchinabuy.com']);
  const ADD_TEXT = /^\s*(add to cart|add to shopping cart|加入购物车)\s*$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let myTabId = null; // which browser tab this is; an add-to-cart run only ever acts in its own tab
  let backTo = null; // on an agent page RepHop opened: where the listing was opened from ("r/sneakerreps")
  // When this copy of the page started. A run acts only in a page that was opened for its current step.
  // The step's own stamp is also a Date.now(), taken in the background before the tab is pointed here.
  const BORN = Date.now();

  function shown(el) {
    return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  }

  async function waitFor(test, ms, step) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(step || 300);
    }
    return !!test();
  }

  function addButton() {
    if (SB) return document.querySelector('.buy-info button.goods-addToCart');
    return Array.from(document.querySelectorAll('button, [role="button"], a')).find((b) => shown(b) && ADD_TEXT.test(b.textContent)) || null;
  }

  function addEnabled() {
    const b = addButton();
    return !!b && shown(b) && !b.disabled;
  }

  function labelText(el) {
    if (!el) return '';
    // The row's name only: not the "minimum order" remark the site tucks inside it.
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
    return (own.trim() ? own : el.textContent).replace(/\s+/g, ' ').replace(/[:：*]/g, '').trim();
  }

  function optionOf(el) {
    const name = el.querySelector('.sku-name, .sku-text');
    const img = el.querySelector('img');
    const text = ((name && (name.getAttribute('title') || name.textContent)) || (img && (img.title || img.alt)) || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return { el, text, img: img ? img.getAttribute('src') || '' : '', disabled: el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true', selected: el.classList.contains('active') };
  }

  /**
   * The listing's rows of choices: [{ list, name, multi, options: [{ el, text, disabled, selected }] }].
   * Returns null when this page is not laid out like a listing RepHop knows; nothing is pressed then.
   */
  function optionGroups() {
    if (!SB) return null;
    const area = document.querySelector('.buy-info .goods-options');
    if (!area) return null;
    const groups = [];
    for (const row of area.querySelectorAll('.goods-options-row')) {
      const list = row.querySelector('ul.goods-options-tags');
      if (!list) continue;
      const lis = Array.from(list.children).filter((li) => li.tagName === 'LI' && !li.classList.contains('more') && !li.classList.contains('demoPack'));
      if (!lis.length) continue;
      groups.push({
        list,
        name: labelText(row.querySelector('.good-propName') || row.querySelector('.goods-options-label')).slice(0, 40),
        multi: row.classList.contains('multi') || !!list.querySelector('.multi-select-row, .goods-number-operation'),
        options: lis.map(optionOf),
      });
    }
    return groups;
  }

  /** The "More" tabs of rows that are still folded (a long row shows its first 21 choices). */
  function foldedRows() {
    return Array.from(document.querySelectorAll('.buy-info .goods-options ul.goods-options-tags > li.more')).filter((li) => !/∧|less|收起/i.test(li.textContent)).length;
  }

  /** Open the folded rows, so every choice can be read. */
  function expandRows() {
    let n = 0;
    for (const li of document.querySelectorAll('.buy-info .goods-options ul.goods-options-tags > li.more')) {
      if (/∧|less|收起/i.test(li.textContent)) continue;
      li.click();
      n++;
    }
    return n;
  }

  /** 'loading' until the listing's name is there; 'refused' for the site's "we do not sell this" notice; 'gone' for a listing the shop took down. */
  function listingState() {
    if (document.querySelector('.dialogRisk, .dialogRisk-wrap')) return 'refused';
    if (document.querySelector('.goods-sold-out')) return 'gone';
    const title = text('.buy-info h3.goods-title');
    return !title || title === '-' ? 'loading' : 'ready';
  }

  /** A visible "Sign In" link means nobody is signed in, and the agent will not show the listing. */
  function signedOut() {
    return Array.from(document.querySelectorAll('a, button')).some((el) => /^\s*(sign in|log in|login|登录)\s*$/i.test(el.textContent) && shown(el));
  }

  /** The site's "I have read and agree" box under its risk notice, if this listing has one. */
  function consentBox() {
    return document.querySelector('.rules-operation input[type="checkbox"]');
  }

  /** A listing the site could not read the choices of: it asks you to describe what you want instead. */
  function notesBox() {
    const el = document.querySelector('.buy-info textarea#desc');
    return el && shown(el) ? el : null;
  }

  // Rows in which you have clicked a choice yourself on this page. Only those count as "picked by you"
  // when a listing is saved; whatever the site had selected by itself is not remembered.
  const touched = new WeakSet();
  document.addEventListener('click', (ev) => {
    if (!ev.isTrusted || !ev.target.closest) return;
    const li = ev.target.closest('ul.goods-options-tags > li');
    if (li) touched.add(li.parentElement);
  }, true);

  /** What is chosen right now, as [{ n: 'Color', v: 'Black' }, …]. With `onlyYours`, just the rows you clicked in. */
  function selectedOptions(onlyYours) {
    const out = [];
    for (const g of optionGroups() || []) {
      if (g.multi || (onlyYours && !touched.has(g.list))) continue;
      const sel = g.options.find((o) => o.selected);
      if (sel && sel.text) out.push({ n: g.name, v: sel.text.slice(0, 80) });
    }
    return out;
  }

  // What the site says after Add To Cart is pressed. Only messages that appear after the press count,
  // and a refusal always outranks anything that merely mentions the cart ("Add to cart failed!").
  const NOTICE = '.alert-dialog, .ant-message-notice, .ant-notification-notice, .ant-modal-confirm-body, [role="alert"]';
  const BAD_NOTICE = '.alert-dialog-error, .alert-dialog-warning, .ant-notification-notice-error, .ant-modal-confirm-error';
  const BAD_TEXT = /fail|失败|please (select|choose|log ?in|sign ?in|try)|请选择|请先|请稍后|cannot|can[’']t|unable|不能|不足|less than/i;
  const GOOD_TEXT = /add(ed)? to (the |your )?(shopping )?cart|加入购物车成功|已加入购物车|成功加入/i;
  let noticesBefore = new Set();

  function markPress() {
    noticesBefore = new Set(document.querySelectorAll(NOTICE));
  }

  function newNotices() {
    return Array.from(document.querySelectorAll(NOTICE)).filter((n) => !noticesBefore.has(n));
  }

  function refusal(fresh) {
    return fresh.find((n) => n.matches(BAD_NOTICE) || n.querySelector('.ant-message-error, .ant-message-warning, .ant-notification-notice-error') || BAD_TEXT.test(n.textContent)) || null;
  }

  function cartRefused() {
    return !!refusal(newNotices());
  }

  function cartConfirmed() {
    const fresh = newNotices();
    if (refusal(fresh)) return false;
    return fresh.some((n) => n.matches('.alert-dialog-success, .ant-notification-notice-success') || n.querySelector('.ant-message-success, .ant-notification-notice-success')) ||
      GOOD_TEXT.test(fresh.map((n) => n.textContent).join(' '));
  }

  /** The site's own words for why it refused, to pass on. */
  function refusalText() {
    const n = refusal(newNotices());
    if (!n) return '';
    const el = n.querySelector('.alert-dialog-message, .alert-dialog-title') || n;
    return el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  // The item an add-to-cart run is working on right now, and how it is going (shown in the bar).
  let auto = { key: null, state: '', need: '', who: '' };
  let needNote = null; // the standing message that says what RepHop needs from you
  let handedOver = false; // you pressed Add To Cart yourself during this step, so RepHop must not

  /**
   * Is this the document an add-to-cart run should act in? Only on the chosen agent's site, only in the
   * tab the run opened, and only a page that was loaded for the current step (a listing that was already
   * showing gets reloaded by the run; the old copy must not press anything on its way out).
   */
  function runHere() {
    return alive && !!queue && queue.active && !!queue.auto && !!pageItem && queue.keys[queue.i] === pageItem.key &&
      IS_AGENT && onAgentTarget() && myTabId != null && queue.tabId === myTabId && BORN >= (queue.stepAt || 0);
  }

  function stillOn(key) {
    return runHere() && pageItem.key === key;
  }

  function dropNeed() {
    if (needNote) needNote.close();
    needNote = null;
  }

  /** Hand the listing to you: say what is needed in the bar and in a message that stays until it is dealt with. */
  function autoNeeds(key, need) {
    if (!stillOn(key)) return;
    auto = { key, state: 'needs', need, who: auto.who };
    paintBar();
    dropNeed();
    needNote = toast(need, 'warn need', null, { sticky: true });
  }

  /** The item went into the cart: remember what was chosen, mark it, and move on. */
  async function cartDone(key, how) {
    const picked = selectedOptions(false);
    await send({ type: 'cartMark', key, options: picked });
    const groups = optionGroups();
    if (groups && groups.length && !groups.some((g) => g.multi)) send({ type: 'pagePatch', key, choices: groups.map((g) => ({ n: g.name, o: g.options.map((o) => o.text), i: g.options.map((o) => o.img) })) });
    if (!stillOn(key)) return;
    dropNeed();
    auto = { key, state: 'done', need: '', who: auto.who };
    paintBar();
    const at = queue.i;
    setTimeout(() => stillOn(key) && send({ type: 'queue', op: 'step', delta: 1, result: { key, r: how }, at }).then(afterQueueStep), 1200);
  }

  /**
   * A "prove you are not a robot" check on the page (a slider, a picture puzzle, a Cloudflare box). RepHop never
   * touches one: it hands the page to you and waits.
   */
  function robotCheck() {
    if (/^just a moment/i.test(document.title)) return true;
    for (const f of document.querySelectorAll('iframe')) {
      if (/captcha|challenges\.cloudflare\.com|turnstile|geetest/i.test(f.src || '') && shown(f)) return true;
    }
    for (const el of document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [id*="cf-chl" i], [class*="cf-turnstile" i]')) if (shown(el)) return true;
    return false;
  }

  /** Wait (up to five minutes) for you to clear a robot check, then carry on. False when the listing was handed over. */
  async function waitRobot(key) {
    autoNeeds(key, agent.name + ' wants to check you are not a robot. Solve it on the page; RepHop waits and carries on by itself.' + (settings.pressMyself ? '' : ' If it keeps asking, try Settings → “Let me press Add To Cart myself”.'));
    await waitFor(() => !stillOn(key) || handedOver || !robotCheck(), 300000, 700);
    if (!stillOn(key) || handedOver) return false;
    if (robotCheck()) {
      autoNeeds(key, 'RepHop has stopped waiting for the check. Solve it and press Add To Cart yourself, or skip this one.');
      return false;
    }
    dropNeed();
    auto = { key, state: 'working', need: '', who: auto.who };
    paintBar();
    await sleep(800);
    return true;
  }

  /** "Black · M · ×2": what is wanted for this item, for messages that ask you to choose. */
  function wanted(plan) {
    if (!plan || !plan.ok) return '';
    const parts = (plan.options || []).map((o) => o.v);
    if (plan.size) parts.push('size ' + plan.size);
    if (plan.style) parts.push(plan.style);
    if (plan.qty > 1) parts.push('×' + plan.qty);
    return parts.join(' · ');
  }

  /** Every row checked against the plan. Returns what still stands in the way (empty when all is set). */
  function openRows(plan) {
    const groups = optionGroups();
    if (!groups) return null;
    const res = U.planCart(groups, plan);
    const open = [];
    res.rows.forEach((d, gi) => {
      if (d.ask) open.push(d.ask);
      else if (!groups[gi].options[d.pick].selected) open.push('pick ' + (groups[gi].name || 'an option'));
    });
    for (const o of res.unused) open.push('“' + o.v + '”, which ' + (plan.owner || 'you') + ' picked, is not offered here');
    return open;
  }

  /**
   * One step of "Add to cart for me". Every row of choices is set from what RepHop knows (U.planCart);
   * if even one row cannot be settled, nothing is pressed and the listing is handed to you. After the
   * press RepHop waits for the site to say it worked, and asks you when the site says nothing.
   * It never presses Buy Now, never ticks the site's agreement box for you, and never presses
   * Add To Cart twice for the same step.
   */
  async function autoCart() {
    if (!runHere()) return;
    const key = pageItem.key;
    if (auto.key === key) return;
    auto = { key, state: 'working', need: '', who: '' };
    handedOver = false;
    paintBar();
    const plan = await send({ type: 'cartPlan', key });
    if (!stillOn(key)) return;
    if (plan && plan.owner) {
      auto.who = plan.owner;
      paintBar();
    }
    const want = wanted(plan);
    const forWhom = plan && plan.owner ? plan.owner + ' wants: ' : 'Wanted: ';
    const hint = want ? ' ' + forWhom + want + '.' : '';
    if (!SB) return autoNeeds(key, 'Choose the options and press Add To Cart. RepHop marks it and moves on to the next one.' + hint);

    // The listing fills in a moment after the page (or the site first wants to know you are not a robot).
    const since = Date.now();
    await waitFor(() => listingState() !== 'loading' || robotCheck() || (Date.now() - since > 6000 && signedOut()), 25000);
    if (!stillOn(key)) return;
    if (robotCheck()) {
      if (!(await waitRobot(key))) return;
      await waitFor(() => listingState() !== 'loading', 25000);
      if (!stillOn(key)) return;
    }
    const state = listingState();
    if (state === 'refused') return autoNeeds(key, agent.name + ' will not take this item (see its notice on the page). Skip it.');
    if (state === 'gone') return autoNeeds(key, agent.name + ' says this listing has been taken down, so it cannot be added. Skip it.');
    if (state === 'loading') {
      return autoNeeds(key, signedOut() ? 'You are not signed in to ' + agent.name + ', so the listing is empty. Sign in, then press Add to cart again.'
        : 'This listing has not loaded. Are you signed in to ' + agent.name + '? Reload the page, or skip this one.');
    }
    if (!plan || !plan.ok) return autoNeeds(key, 'Choose the options and press Add To Cart.');
    await sleep(700);
    const unknown = 'RepHop does not recognise this listing, so it has not pressed anything. Add it yourself, or skip it.';

    /**
     * Set every row RepHop can settle, then check all of them. Returns true only when each row holds
     * exactly the choice RepHop decided on; otherwise the listing has been handed to you.
     * This runs once when the listing is ready and again right before the press, because the page can
     * change in between (rows that arrive late, a choice that switches another one off).
     */
    const settle = async () => {
      if (expandRows()) await sleep(300);
      const first = optionGroups();
      if (!first) return autoNeeds(key, unknown), false;
      if (first.some((g) => g.multi)) return autoNeeds(key, 'This listing takes an amount for each choice. Set the amounts yourself, then press Add To Cart.' + hint), false;
      // No buttons to choose from, only a box to describe what you want: that description is yours to write.
      if (notesBox()) return autoNeeds(key, 'This listing has no buttons for its choices. Write what you want in the Shopping Agent Notes box, then press Add To Cart yourself.' + hint), false;
      // One click at a time (a click can switch other choices on or off, so everything is read again
      // afterwards). Each choice is tried once, so nothing can loop.
      const tried = new Set();
      for (let round = 0; round < 16; round++) {
        const groups = optionGroups();
        if (!groups) return autoNeeds(key, unknown), false;
        const rows = U.planCart(groups, plan).rows;
        let clicked = false;
        for (let gi = 0; gi < groups.length; gi++) {
          const d = rows[gi];
          if (d.pick == null || groups[gi].options[d.pick].selected || tried.has(gi + '|' + d.pick)) continue;
          tried.add(gi + '|' + d.pick);
          groups[gi].options[d.pick].el.click();
          clicked = true;
          break;
        }
        if (!clicked) break;
        await sleep(450);
        if (!stillOn(key) || handedOver) return false;
      }
      const open = openRows(plan);
      if (!open) return autoNeeds(key, unknown), false;
      if (!open.length) return true;
      const lead = open[0].charAt(0).toUpperCase() + open[0].slice(1);
      autoNeeds(key, [lead].concat(open.slice(1)).join('; ') + '. Choose, then press Add To Cart yourself.' + (plan.owner ? hint : ''));
      return false;
    };
    if (!(await settle())) return;

    if (plan.qty > 1) {
      // Exactly the quantity on the item, or the listing is handed over.
      const box = document.querySelector('#step2-goods-count input.goods-count, .buy-info input.goods-count');
      const more = document.querySelector('#step2-goods-count .goods-count-add, .buy-info .goods-count-add');
      const now = () => (box ? parseInt(box.value, 10) || 0 : 0);
      for (let i = 0; box && more && now() < plan.qty && i < 110 && !more.classList.contains('disabled'); i++) {
        more.click();
        await sleep(120);
      }
      if (!stillOn(key) || handedOver) return;
      if (now() !== plan.qty) return autoNeeds(key, 'Set the quantity to ' + plan.qty + ' yourself, then press Add To Cart.');
    }

    if (!addEnabled()) {
      const box = consentBox();
      if (box && !box.checked) {
        // The site's risk notice is yours to agree to. RepHop waits; it does not tick the box.
        autoNeeds(key, 'Tick “I have read and agree” below the options on this page (' + agent.name + ' remembers it). RepHop carries on as soon as you have.');
        await waitFor(() => !stillOn(key) || handedOver || addEnabled(), 240000, 400);
        if (!stillOn(key) || handedOver) return;
        if (!addEnabled()) return autoNeeds(key, 'RepHop has stopped waiting. Tick the box and press Add To Cart yourself, or skip this one.');
        dropNeed();
        auto = { key, state: 'working', need: '', who: auto.who };
        paintBar();
      } else {
        await waitFor(() => addEnabled(), 12000);
        if (!stillOn(key) || handedOver) return;
        if (!addEnabled()) return autoNeeds(key, agent.name + ' has Add To Cart switched off for this item (sold out or restricted, most likely). Skip it, or add it yourself if the button comes back.');
      }
    }

    // Whatever happened while waiting, the rows are checked once more at the moment of pressing.
    if (robotCheck() && !(await waitRobot(key))) return;
    if (!(await settle())) return;
    if (!stillOn(key) || handedOver || !addEnabled()) return;

    if (settings.pressMyself) {
      // Everything is set; the press is yours. RepHop notices it (watchAddToCart), marks the item and moves on.
      const b = addButton();
      auto = { key, state: 'press', need: '', who: auto.who };
      paintBar();
      dropNeed();
      needNote = toast('All set' + (want ? ': ' + want : '') + '. Press Add To Cart on the page and RepHop moves on to the next one.', 'ok need', null, { sticky: true });
      if (b) {
        b.style.outline = '3px solid #ff6b35';
        b.style.outlineOffset = '3px';
        b.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    // One press per step, recorded before it happens.
    const go = await send({ type: 'queue', op: 'press', key });
    if (!stillOn(key) || handedOver) return;
    if (!go || !go.first) return autoNeeds(key, 'RepHop has already pressed Add To Cart for this one. Check your cart, then go on.');
    markPress();
    addButton().click();
    await waitFor(() => cartConfirmed() || cartRefused() || robotCheck(), 10000, 250);
    if (!stillOn(key)) return;
    if (robotCheck() && !cartConfirmed()) {
      // The site asks once the button is pressed: the check is yours, and the site's answer is waited for.
      autoNeeds(key, agent.name + ' wants to check you are not a robot. Solve it on the page; RepHop marks the item once ' + agent.name + ' says it is in your cart.');
      await waitFor(() => !stillOn(key) || handedOver || cartConfirmed() || cartRefused(), 300000, 700);
      if (!stillOn(key) || handedOver) return;
    }
    if (cartConfirmed()) return cartDone(key, 'added');
    if (cartRefused()) {
      const why = refusalText();
      return autoNeeds(key, 'The site did not accept that' + (why ? ' (“' + why + '”)' : '') + '. Check the options, then press Add To Cart yourself.');
    }
    // The site said nothing RepHop recognises. Do not guess, and do not ask for a second press: ask.
    auto = { key, state: 'needs', need: 'RepHop pressed Add To Cart. Is it in your cart?', who: auto.who };
    paintBar();
    dropNeed();
    needNote = toast('RepHop pressed Add To Cart but cannot tell whether it worked. Is it in your cart?', 'warn need', [
      { label: 'Yes', fn: () => cartDone(key, 'added') },
      { label: 'No', fn: () => autoNeeds(key, 'Add it yourself, then RepHop carries on. Or skip it.') },
    ], { sticky: true });
  }

  /**
   * Notice the Add To Cart button being pressed by you. The item is marked "in cart" only when the site
   * confirms it; if the site says nothing either way, RepHop asks instead of guessing. What you added
   * (colour, size and so on) is remembered with the item.
   */
  function watchAddToCart() {
    if (!IS_AGENT) return;
    document.addEventListener('click', (ev) => {
      if (!alive || !pageItem || !ev.isTrusted) return;
      const btn = ev.target.closest && ev.target.closest('button, [role="button"], a');
      if (!btn || !(btn.matches('.goods-addToCart, .toolbar-addGoods') || ADD_TEXT.test(btn.textContent))) return;
      const key = pageItem.key;
      if (stillOn(key)) handedOver = true;
      markPress();
      (async () => {
        // The site answers after a request of its own; give it a few seconds before asking you instead.
        await sleep(600);
        await waitFor(() => cartConfirmed() || cartRefused(), 6000, 250);
        if (!pageItem || pageItem.key !== key) return;
        const inRun = stillOn(key);
        const st = states[key];
        if (!inRun && (!st || !st.saved)) return;
        const itemKey = (st && st.itemKey) || key;
        const worked = cartConfirmed();
        if (cartRefused() && !worked) return;
        const picked = selectedOptions(false);
        const mark = async () => {
          if (inRun) return cartDone(key, 'manual');
          // Marks the pick this matches; another colour or size becomes a pick of its own.
          const res = await send({ type: 'cartByHand', key: itemKey, options: picked });
          refreshStates();
          if (!res || !res.ok) return;
          if (res.was === 'new') {
            toast('Added ' + picked.map((o) => o.v).join(' / ') + ' as another pick from this listing, marked “in cart”.', 'ok', { label: 'Undo', fn: () => send({ type: 'pick', op: 'remove', key: itemKey, id: res.pick }).then(refreshStates) });
            return;
          }
          if (queueHere() && settings.autoAdvance) {
            let cancelled = false;
            toast('Marked “in cart”. Next item in 3 seconds…', 'ok', { label: 'Stay here', fn: () => (cancelled = true) });
            const at = queue ? queue.i : undefined;
            setTimeout(() => !cancelled && send({ type: 'queue', op: 'step', delta: 1, at }).then(afterQueueStep), 3000);
          } else toast('Marked “in cart” in your RepHop list' + (picked.length ? ', with ' + picked.map((o) => o.v).join(' / ') + '.' : '.'), 'ok', { label: 'Undo', fn: () => (res.pick ? send({ type: 'pick', op: 'set', key: itemKey, id: res.pick, patch: { status: 'saved' } }) : send({ type: 'update', keys: [itemKey], patch: { status: 'saved' } })).then(refreshStates) });
        };
        if (worked) mark();
        else {
          dropNeed();
          needNote = toast('Did that go into your cart?', 'ok', { label: 'Yes, mark it', fn: mark }, inRun ? { sticky: true } : null);
        }
      })();
    }, true);
  }

  function onPageChange() {
    pageItem = L.parseLink(location.href);
    if (pageItem && pageItem.kind === 'short') pageItem = null;
    cardFor = null;
    hideCard();
    paintBar();
    refreshStates();
    scrapeProductPage();
    autoCart();
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'toast') {
      if (window.top === window) toast(msg.text, msg.kind);
    } else if (msg.type === 'saveThis') {
      // The panel's "save this tab" button: saving from here also captures the options picked on the page.
      if (window.top !== window || !pageItem) return void respond({ handled: false });
      doSave({ el: null, parsed: pageItem, key: pageItem.key, url: pageItem.url, orig: location.href, mode: 'page', pill: null });
      respond({ handled: true });
    } else if (msg.type === 'grabAll') {
      if (window.top !== window) return;
      if (!SCAN_PAGE && !SHEETS_APP) return void respond({ handled: false });
      grabAll(false);
      respond({ handled: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const was = settings;
      settings = U.mergeSettings(changes.settings.newValue);
      agent = L.agentInfo(settings);
      if (settings.detectTextLinks && !was.detectTextLinks && SCAN_PAGE) scanText(document.body);
      if (!settings.detectTextLinks && was.detectTextLinks) unwrapText();
      repaintAll();
    }
    if (changes.queue) {
      queue = changes.queue.newValue || null;
      if (!runHere()) dropNeed();
      paintBar();
      autoCart();
    }
    if (changes.rates) rates = changes.rates.newValue || null;
    if (changes.rev) {
      cardCache.clear();
      refreshStates();
    }
  });

  /** Turn detected plain-text links back into ordinary text (the setting was switched off). */
  function unwrapText() {
    for (const info of Array.from(live)) {
      if (!info.text) continue;
      live.delete(info);
      if (info.pill) info.pill.remove();
      const span = info.el;
      if (!span.isConnected) continue;
      const parent = span.parentNode;
      span.replaceWith(document.createTextNode(span.textContent));
      parent.normalize();
    }
  }

  const pendingRoots = new Set();
  let rootTimer = null;
  let firstRootAt = 0;

  function flushRoots() {
    firstRootAt = 0;
    const roots = Array.from(pendingRoots).filter((n) => n.isConnected);
    pendingRoots.clear();
    for (const root of roots) scan(root);
  }

  /** Wait for the page to go quiet before scanning, but never more than a second on pages that keep changing. */
  function scheduleRoots() {
    const now = Date.now();
    if (!firstRootAt) firstRootAt = now;
    clearTimeout(rootTimer);
    rootTimer = setTimeout(flushRoots, now - firstRootAt >= 1000 ? 0 : 300);
  }

  function observe() {
    if (!SCAN_PAGE) return;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target.tagName === 'A') pendingRoots.add(r.target);
          continue;
        }
        for (const node of r.addedNodes) {
          if (node.nodeType !== 1 || isOurs(node) || node.closest('[data-rh-ui]')) continue;
          pendingRoots.add(node);
        }
      }
      if (pendingRoots.size) scheduleRoots();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }

  chrome.storage.local.get(['settings', 'queue', 'rates', 'fabCollapsed'], (data) => {
    if (chrome.runtime.lastError) return;
    settings = U.mergeSettings(data.settings);
    agent = L.agentInfo(settings);
    queue = data.queue || null;
    rates = data.rates || null;
    fabCollapsed = !!data.fabCollapsed;
    onPageChange();
    scan(document);
    observe();
    watchAddToCart();
    watchCart();
    if (IS_AGENT) {
      send({ type: 'whoami' }).then((r) => {
        myTabId = r && typeof r.tabId === 'number' ? r.tabId : null;
        backTo = r && typeof r.back === 'string' ? r.back : null;
        cartWanted = !!(r && r.cartImport) && isCart();
        paintBar();
        autoCart();
      });
      // Coming back to this tab: the page it was opened from may have changed (or the tab was reused meanwhile).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !alive) return;
        send({ type: 'whoami' }).then((r) => {
          const next = r && typeof r.back === 'string' ? r.back : null;
          if (next !== backTo) {
            backTo = next;
            paintBar();
          }
        });
      });
    }
    // Single-page apps (Reddit, the agents) change the address without loading a new page.
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onPageChange();
    }, 900);
  });
})();
