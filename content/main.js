/*
 * RepHop content script.
 * Finds product links on the page, adds the open/save buttons, handles the
 * click and hotkey shortcuts, and draws the hover card, toasts and action bar.
 * It never writes storage itself; everything goes through the service worker.
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

  const PILL_CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; margin: 0 2px 0 6px; }
    .pill { display: inline-flex; align-items: stretch; height: 20px; border-radius: 10px; overflow: hidden;
      font: 600 11px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff; background: #1c2130;
      box-shadow: 0 0 0 1px rgba(255,255,255,.16), 0 1px 2px rgba(0,0,0,.3); user-select: none; white-space: nowrap; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; padding: 0 7px; color: inherit; font: inherit; }
    button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: -2px; }
    .go { background: linear-gradient(135deg, #ff6b35, #f43f5e); padding-left: 6px; }
    .go:hover { filter: brightness(1.12); }
    .save:hover { background: #2c3447; }
    .save.on { color: #4ade80; }
    .n { display: none; align-items: center; padding: 0 7px 0 1px; color: #fbbf24; font-size: 10px; }
    .pill.hot .n { display: inline-flex; }
    .pill.viewed .go { background: linear-gradient(135deg, #7c6f8f, #6b7280); }
    .pill.trusted { box-shadow: 0 0 0 1.5px #facc15, 0 1px 2px rgba(0,0,0,.3); }
    .pill.dead .go { background: #4b5563; text-decoration: line-through; }
    .pill.busy { opacity: .6; pointer-events: none; }
    .pill.compact .go span { display: none; }
  `;

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #f4f5f7; }
    button { all: unset; box-sizing: border-box; cursor: pointer; font: inherit; color: inherit; }
    button:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }

    .toasts { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; width: max-content; max-width: min(560px, 92vw); }
    .toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 10px; background: #1c2130; border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 8px 28px rgba(0,0,0,.4); animation: rise .16s ease-out; max-width: 100%; }
    .toast::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #4ade80; flex: none; }
    .toast.error::before { background: #f87171; }
    .toast.warn::before { background: #fbbf24; }
    .toast span { overflow-wrap: anywhere; }
    .toast button { color: #7dd3fc; font-weight: 600; flex: none; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }

    .card { position: absolute; width: 300px; display: none; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; background: #1c2130; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 12px 36px rgba(0,0,0,.45); }
    .card.on { display: flex; }
    .card .top { display: flex; gap: 10px; }
    .card .pic { width: 72px; height: 72px; border-radius: 8px; background: #2a3142; flex: none; overflow: hidden; }
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
        <span class="q" hidden></span>
        <button data-act="qprev" hidden title="Previous item in the queue ( [ )">◀</button>
        <button data-act="qnext" class="primary" hidden title="Next item in the queue ( ] )">Next ▶</button>
        <button data-act="qstop" hidden title="End the queue">End</button>
        <span class="sep" data-for="queue" hidden></span>
        <button data-act="open" class="primary" hidden></button>
        <button data-act="save" hidden></button>
        <button data-act="qc" hidden>QC photos</button>
        <button data-act="grab" hidden></button>
        <button data-act="graball" hidden title="Read every tab of this spreadsheet and save the product links">All tabs</button>
        <button data-act="clickable" hidden title="Open a plain version of this sheet where every link gets its own open and save buttons">Clickable view</button>
        <button data-act="panel" title="Open your RepHop list" aria-label="Open your RepHop list">${ICON.list}</button>
      </div>
      <div class="toasts" aria-live="polite"></div>
    </div>`;
  const $card = ui.querySelector('.card');
  const $bar = ui.querySelector('.bar');
  const $toasts = ui.querySelector('.toasts');
  (document.documentElement || document.body).appendChild(uiHost);

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
    for (const action of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        close();
        action.fn();
      });
      el.appendChild(b);
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
    return info.mode === 'inline' && !info.noPill && settings.showPills;
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
    const next = info.el.nextElementSibling;
    if (next && next.hasAttribute('data-rh-pill')) next.remove();
    const host = document.createElement('span');
    host.setAttribute('data-rh-ui', '');
    host.setAttribute('data-rh-pill', '');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${PILL_CSS}</style><span class="pill"><button class="go" type="button">${ICON.bolt}<span></span></button><button class="save" type="button"></button><span class="n"></span></span>`;
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
    info.el.insertAdjacentElement('afterend', host);
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
    pill.className = 'pill' + (settings.pillStyle === 'compact' ? ' compact' : '') + (st.viewed ? ' viewed' : '') + (st.trusted ? ' trusted' : '') + (dead ? ' dead' : '') + (st.mentions ? ' hot' : '');
    go.querySelector('span').textContent = agent.short;
    const what = info.parsed.kind === 'yupoo' ? "Find this album's buy link and open it in " + agent.name : 'Open in ' + agent.name;
    const k = settings.hotkeysEnabled ? ' (hover + ' + settings.keys.open.toUpperCase() + ')' : '';
    go.title = (dead ? 'This item looks removed. ' : '') + what + k + (st.viewed ? ' · already viewed' : '') + (st.trusted ? ' · trusted seller' : '');
    go.setAttribute('aria-label', what);
    save.innerHTML = st.status === 'carted' || st.status === 'bought' ? ICON.cart : st.saved ? ICON.check : ICON.plus;
    save.classList.toggle('on', !!st.saved);
    save.title = st.saved ? 'In your list' + (st.status === 'carted' ? ' (in cart)' : '') + '. Click for options.' : 'Save to your RepHop list' + (settings.hotkeysEnabled ? ' (hover + ' + settings.keys.save.toUpperCase() + ')' : '');
    save.setAttribute('aria-label', st.saved ? 'In your RepHop list. Show options.' : 'Save to your RepHop list');
    // With hotkeys on, the link itself is the keyboard stop (focus it, then press the key), so a long
    // thread does not gain two extra tab stops per link.
    go.tabIndex = save.tabIndex = settings.hotkeysEnabled ? -1 : 0;
    n.textContent = st.mentions ? '×' + st.mentions : '';
    n.title = st.mentions ? 'You have seen this link in ' + st.mentions + ' different posts' : '';
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
    refreshStates();
    paintBar();
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
    if (!keys.size) return;
    // Asked in batches so a thread with thousands of links is covered in full.
    const next = {};
    for (const batch of U.chunkArray(Array.from(keys), 500)) {
      const res = await send({ type: 'lookup', keys: batch });
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
    setBusy(info, true);
    const res = await send({ type: 'open', url: info.url, disposition: disposition || 'default' });
    setBusy(info, false);
    if (!res) {
      // The worker is unreachable: never swallow the click, fall back to the plain link.
      window.open(info.orig, '_blank', 'noopener');
      return;
    }
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
    const res = await send({ type: 'save', url: info.url, ctx: getContext(el), label: el ? contextLabel(el) : '' });
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

  window.addEventListener('click', (ev) => {
    if (!alive || ev.button !== 0) return;
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
    if (!alive || ev.button !== 1 || !settings.clickHijack) return;
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
    const hit = linkFromEvent(ev);
    const info = hit && hit.info ? hit.info : null;
    if (info === hovered) return;
    hovered = info;
    armed = false;
    setCardTarget(info || focused);
  }, true);

  window.addEventListener('mousemove', () => {
    if (hovered) armed = true;
  }, { capture: true, passive: true });

  document.addEventListener('scroll', () => {
    armed = false;
    clearTimeout(cardTimer);
    cardFor = null;
    hideCard();
  }, { capture: true, passive: true });

  window.addEventListener('focusin', (ev) => {
    const hit = linkFromEvent(ev);
    focused = hit && hit.info && !hit.onPill ? hit.info : null;
    if (focused) setCardTarget(focused);
  }, true);

  window.addEventListener('focusout', () => {
    if (cardFor === focused) setCardTarget(hovered && armed ? hovered : null);
    focused = null;
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
    if (!alive || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat || typing(ev)) return;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (queueHere() && (k === ']' || k === '[')) {
      block(ev);
      send({ type: 'queue', op: 'step', delta: k === ']' ? 1 : -1 }).then(afterQueueStep);
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
    clearTimeout(cardTimer);
    hideCard();
  }, true);

  // ------------------------------------------------------------ hover card

  const cardCache = new Map();

  function hideCard() {
    $card.classList.remove('on');
  }

  function setThumb(box, url) {
    box.replaceChildren();
    const small = U.thumbUrl(url, 200);
    if (!small) return;
    // Pictures added by the extension are not subject to the page's own image policy,
    // and the worker's header rule supplies the referer Yupoo insists on.
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.remove(), { once: true });
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
      sub.textContent = d.reason === 'network' ? "Couldn't load a preview" : 'No preview available';
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
    const show = settings.showFab && alive && (pageItem || count > 0 || SHEETS_APP || inQueue);
    $bar.classList.toggle('on', !!show);
    if (!show) return;
    $bar.classList.toggle('collapsed', fabCollapsed && !inQueue);
    const btn = (act) => $bar.querySelector('[data-act="' + act + '"]');
    const st = pageItem ? states[pageItem.key] || {} : {};

    const q = $bar.querySelector('.q');
    q.hidden = !inQueue;
    for (const act of ['qprev', 'qnext', 'qstop']) btn(act).hidden = !inQueue;
    $bar.querySelector('[data-for="queue"]').hidden = !inQueue;
    if (inQueue) {
      q.textContent = 'Queue ' + (queue.i + 1) + ' of ' + queue.keys.length;
      btn('qnext').textContent = queue.i + 1 >= queue.keys.length ? 'Finish ✓' : 'Next ▶';
      btn('qprev').style.visibility = queue.i === 0 ? 'hidden' : 'visible';
    }

    const open = btn('open');
    open.hidden = !pageItem || (onAgentTarget() && pageItem.kind === 'item');
    open.textContent = pageItem && pageItem.kind === 'yupoo' ? 'Find buy link → ' + agent.name : 'Open in ' + agent.name;
    const save = btn('save');
    save.hidden = !pageItem;
    save.classList.toggle('on-state', !!st.saved);
    save.innerHTML = '';
    save.insertAdjacentHTML('afterbegin', st.saved ? ICON.check : ICON.plus);
    save.append(st.saved ? (st.status === 'carted' ? ' In cart' : st.status === 'bought' ? ' Bought' : ' Saved') : ' Save');
    save.title = st.saved ? 'In your list. Click for options.' : 'Save this item to your RepHop list';
    btn('qc').hidden = !pageItem || pageItem.kind !== 'item';
    const grab = btn('grab');
    grab.hidden = !(count > 0 || SHEETS_APP);
    grab.textContent = SHEETS_APP ? 'Grab links from this tab' : 'Save all ' + count + ' link' + (count === 1 ? '' : 's');
    grab.title = SHEETS_APP ? 'Save the product links on the sheet tab you are looking at' : 'Save every product link on this page to your list';
    btn('graball').hidden = !SHEETS_APP;
    btn('clickable').hidden = !SHEETS_APP;
  }

  function afterQueueStep(res) {
    if (!res) return;
    if (res.finished) toast('Queue finished.', 'ok');
    else if (res.edge === 'start') toast('That is the first item in the queue.', 'warn');
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
    else if (act === 'open' && own) doOpen(own, ev.ctrlKey || ev.metaKey ? 'background' : 'reuse');
    else if (act === 'save' && own) toggleSave(own);
    else if (act === 'qc' && own) doQc(own);
    else if (act === 'grab') grabAll(false);
    else if (act === 'graball') grabAll(true);
    else if (act === 'clickable') {
      const m = location.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
      const gid = (location.hash.match(/gid=(\d+)/) || [])[1];
      if (m) send({ type: 'openTab', url: location.origin + '/spreadsheets/d/' + m[1] + '/htmlview' + (gid ? '?gid=' + gid : '') });
    } else if (act === 'qnext') send({ type: 'queue', op: 'step', delta: 1 }).then(afterQueueStep);
    else if (act === 'qprev') send({ type: 'queue', op: 'step', delta: -1 }).then(afterQueueStep);
    else if (act === 'qstop') send({ type: 'queue', op: 'stop' });
  });

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
      if (SHEETS_APP) {
        for (const e of await sheetEntries(allTabs)) byKey.set(e.key, e);
      } else {
        for (const e of domEntries()) byKey.set(e.key, e);
        if (IS_REDDIT) {
          const thread = await redditThread().catch(() => ({ entries: [], missed: 0 }));
          missed = thread.missed;
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
      toast(text, sum.added || sum.duplicates ? (missed || stopped ? 'warn' : 'ok') : 'error', sum.added ? { label: 'Open list', fn: () => send({ type: 'openPanel' }) } : null);
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
        const title = text('h3.goods-title') || text('.goods-title h3') || text('.goods-title');
        if (!title || title === '-') return;
        clearInterval(timer);
        // Only take a number that is explicitly labelled as yuan; the page also shows your own currency.
        const yuan = text('p.foreign-currency').match(/(?:CN\s*[¥￥]|[¥￥]|CNY|RMB)\s*([\d,]+(?:\.\d+)?)/i);
        const price = yuan ? parseFloat(yuan[1].replace(/,/g, '')) : NaN;
        let image = '';
        for (const img of document.querySelectorAll('.goods-info_container img, .buy-main img')) {
          if (img.naturalWidth >= 200 && /^https:/.test(img.src) && !/superbuy\.com|allchinabuy\.com/.test(img.src)) {
            image = img.src;
            break;
          }
        }
        send({ type: 'pagePatch', key, title, price: price > 0 ? price : undefined, image });
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

  /**
   * On Superbuy, notice the Add To Cart button being pressed. The item is marked "in cart" only when
   * the site confirms it; if the site says nothing either way, RepHop asks instead of guessing.
   */
  function watchAddToCart() {
    if (!L.hostMatches(HOST, ['superbuy.com', 'allchinabuy.com'])) return;
    const NOTICE = '.ant-message-notice, .ant-notification-notice, .ant-modal-confirm-body, [role="alert"]';
    document.addEventListener('click', (ev) => {
      if (!alive || !pageItem) return;
      const btn = ev.target.closest && ev.target.closest('button');
      if (!btn || !(btn.matches('.goods-addToCart, .toolbar-addGoods') || /^\s*(add to cart|加入购物车)\s*$/i.test(btn.textContent))) return;
      const key = pageItem.key;
      setTimeout(() => {
        if (!pageItem || pageItem.key !== key) return;
        const st = states[key];
        if (!st || !st.saved || st.status === 'carted' || st.status === 'bought') return;
        const itemKey = st.itemKey || key;
        const said = Array.from(document.querySelectorAll(NOTICE), (el) => el.textContent).join(' ').slice(0, 2000);
        const failed = !!document.querySelector('.ant-message-error, .ant-message-warning, .ant-notification-notice-error, .ant-modal-confirm-error, .ant-form-item-explain-error') ||
          /please (select|choose|log ?in|sign ?in)|failed|请选择|请先/i.test(said);
        const worked = !!document.querySelector('.ant-message-success, .ant-notification-notice-success') || /added to (the |your )?cart|successfully|成功|已加入/i.test(said);
        const mark = async () => {
          const res = await send({ type: 'update', keys: [itemKey], patch: { status: 'carted' } });
          if (!res || !res.ok) return;
          if (queueHere() && settings.autoAdvance) {
            let cancelled = false;
            toast('Marked “in cart”. Next item in 3 seconds…', 'ok', { label: 'Stay here', fn: () => (cancelled = true) });
            setTimeout(() => !cancelled && send({ type: 'queue', op: 'step', delta: 1 }).then(afterQueueStep), 3000);
          } else toast('Marked “in cart” in your RepHop list.', 'ok', { label: 'Undo', fn: () => send({ type: 'update', keys: [itemKey], patch: { status: 'saved' } }) });
        };
        if (failed && !worked) return;
        if (worked) mark();
        else toast('Did that go into your cart?', 'ok', { label: 'Yes, mark it', fn: mark });
      }, 1800);
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
  }

  // ---------------------------------------------------------------- wiring

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || sender.id !== chrome.runtime.id) return;
    if (msg.type === 'toast') {
      if (window.top === window) toast(msg.text, msg.kind);
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
      repaintAll();
    }
    if (changes.queue) {
      queue = changes.queue.newValue || null;
      paintBar();
    }
    if (changes.rates) rates = changes.rates.newValue || null;
    if (changes.rev) {
      cardCache.clear();
      refreshStates();
    }
  });

  const pendingRoots = new Set();
  const flushRoots = debounce(() => {
    const roots = Array.from(pendingRoots).filter((n) => n.isConnected);
    pendingRoots.clear();
    for (const root of roots) scan(root);
  }, 300);

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
      if (pendingRoots.size) flushRoots();
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
    // Single-page apps (Reddit, the agents) change the address without loading a new page.
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      onPageChange();
    }, 900);
  });
})();
