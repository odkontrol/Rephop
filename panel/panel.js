/*
 * RepHop side panel: the saved list, the paste box, settings and help.
 * Reads storage directly and re-renders when it changes; every write is a message to the service worker.
 */
(() => {
  'use strict';

  const L = self.RepLinks;
  const U = self.RepUtil;
  const V = self.RepLive;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Tiny element builder. Text always goes in as text, never as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // Icons drawn as SVG (one stroke weight), not as text characters.
  const SVG = {
    sun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>',
    x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    down: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    scale: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8h12l2 12H4L6 8Z"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0"/></svg>',
  };
  function icon(name) {
    const t = document.createElement('template');
    t.innerHTML = SVG[name];
    return t.content.firstChild;
  }

  const KEYS = ['items', 'settings', 'folders', 'sellers', 'seen', 'rates', 'queue', 'syncState', 'cartRun', 'group'];
  const data = { items: {}, settings: U.mergeSettings(), folders: U.DEFAULT_FOLDERS.slice(), sellers: {}, seen: {}, rates: null, queue: null, syncState: null, cartRun: null, group: null };
  let thisTab = null; // the product on the browser tab beside the panel, if there is one
  const view = { name: 'list', folder: '*', status: '', tag: '', seller: '', q: '', sort: 'new', selected: new Set(), openKey: null, limit: 120 };
  const asked = new Set();
  let agent = L.agentInfo(data.settings);

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  function absorb(obj) {
    for (const k of KEYS) {
      if (!(k in obj)) continue;
      const v = obj[k];
      if (k === 'settings') data.settings = U.mergeSettings(v);
      else if (k === 'folders') data.folders = Array.isArray(v) && v.length ? v : U.DEFAULT_FOLDERS.slice();
      else if (k === 'items' || k === 'sellers' || k === 'seen') data[k] = v || {};
      else data[k] = v || null;
    }
    agent = L.agentInfo(data.settings);
    applyTheme();
    if ('group' in obj) liveConnect();
  }

  /** Dark unless the user chose light (or asked to follow the computer). */
  function applyTheme() {
    const want = data.settings.theme;
    const dark = want === 'system' ? !window.matchMedia('(prefers-color-scheme: light)').matches : want !== 'light';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('rhTheme', dark ? 'dark' : 'light'); // read by theme.js before the next draw
    } catch (_) {
      /* private mode */
    }
    const b = $('#theme-toggle');
    if (!b) return;
    b.replaceChildren(icon(dark ? 'sun' : 'moon'));
    b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  /** Something needs an agent and none is chosen: point at the chooser. */
  function needAgent() {
    if (data.settings.agent === 'custom') {
      // "Custom" is chosen but has no link template yet.
      show('settings');
      toast('Finish setting up your agent: enter its link template here.', { error: true });
      $('#s-template').focus();
      return;
    }
    show('list');
    toast('Pick your shopping agent first.', { error: true });
    $('#pick-agent').scrollIntoView({ block: 'center' });
  }

  // ---------------------------------------------------------------- toasts

  function toast(text, opts) {
    const box = $('#toasts');
    const el = h('div', { class: 'toast' + (opts && opts.error ? ' error' : '') }, h('span', {}, text));
    let timer = null;
    const close = () => {
      clearTimeout(timer);
      el.remove();
    };
    if (opts && opts.action) {
      el.append(h('button', { type: 'button', onclick: () => { close(); opts.action.fn(); } }, opts.action.label));
    }
    while (box.children.length >= 4) box.firstChild.remove();
    box.append(el);
    timer = setTimeout(close, opts && opts.action ? 7000 : 3600);
  }

  /** First click arms the button, second click within four seconds runs it. */
  function confirmClick(btn, question, fn) {
    if (btn.dataset.armed) {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
      return fn();
    }
    btn.dataset.armed = '1';
    btn.dataset.label = btn.textContent;
    btn.textContent = question;
    setTimeout(() => {
      if (!btn.dataset.armed) return;
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
    }, 4000);
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied ' + what + '.');
    } catch (_) {
      toast("Couldn't copy. Click inside the panel and try again.", { error: true });
    }
  }

  // ------------------------------------------------------------- list data

  function mentions(it) {
    let n = (data.seen[it.key] && data.seen[it.key].p && data.seen[it.key].p.length) || 0;
    for (const a of it.aliases || []) n = Math.max(n, (data.seen[a] && data.seen[a].p && data.seen[a].p.length) || 0);
    return n;
  }

  function sellerName(seller) {
    return String((seller && (seller.name || seller.key)) || '');
  }

  function trusted(it) {
    return !!(it.seller && data.sellers[it.seller.key] && data.sellers[it.seller.key].trusted);
  }

  const STATUS_TEST = {
    unviewed: (it) => !it.viewedAt,
    saved: (it) => it.status === 'saved',
    carted: (it) => it.status === 'carted',
    bought: (it) => it.status === 'bought',
    problem: (it) => !!(it.check && it.check.state !== 'ok'),
    nolink: (it) => it.platform === 'yupoo',
    noprice: (it) => it.price == null,
  };

  const SORTS = {
    new: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    old: (a, b) => (a.addedAt || 0) - (b.addedAt || 0),
    cheap: (a, b) => (a.price == null) - (b.price == null) || (a.price || 0) - (b.price || 0),
    pricey: (a, b) => (a.price == null) - (b.price == null) || (b.price || 0) - (a.price || 0),
    name: (a, b) => U.displayTitle(a).localeCompare(U.displayTitle(b)),
    hot: (a, b) => mentions(b) - mentions(a) || (b.addedAt || 0) - (a.addedAt || 0),
  };

  function visible() {
    let list = Object.values(data.items);
    if (view.folder !== '*') list = list.filter((it) => it.folder === view.folder);
    if (view.status && STATUS_TEST[view.status]) list = list.filter(STATUS_TEST[view.status]);
    if (view.tag) list = list.filter((it) => (it.tags || []).includes(view.tag));
    if (view.seller) list = list.filter((it) => it.seller && it.seller.key === view.seller);
    if (view.q) list = list.filter((it) => U.matches(it, view.q));
    return list.sort(SORTS[view.sort] || SORTS.new);
  }

  function scope() {
    const vis = visible();
    const picked = vis.filter((it) => view.selected.has(it.key));
    return picked.length ? { list: picked, label: picked.length + ' selected' } : { list: vis, label: 'All ' + vis.length + ' shown' };
  }

  function openItem(it, ev) {
    const background = ev && (ev.ctrlKey || ev.metaKey || ev.button === 1);
    send({ type: 'open', key: it.key, disposition: background ? 'background' : 'default' }).then((r) => {
      if (r && r.reason === 'no-agent') return needAgent();
      if (!r || !r.ok) toast("Couldn't open that item.", { error: true });
      else if (r.noBuyLink) toast('This album has no buy link, so the album itself was opened.');
    });
  }

  // ----------------------------------------------------------- list render

  /**
   * An item's picture: the colourway you picked when the listing has a picture for it (`pick` for one of its other
   * picks), otherwise the listing's own picture.
   */
  function thumb(it, pick, cls) {
    const short = (L.PLATFORMS[it.platform] || {}).short || '?';
    const own = it.platform && Array.isArray(it.choices) ? U.pickImage(it, pick || null, data.settings) : '';
    const src = own || (pick ? '' : it.image);
    const btn = h('button', { class: cls || 'thumb', type: 'button', title: 'Open in ' + agent.name, onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) });
    if (src && /^https:\/\//.test(src)) {
      const img = h('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
      // Ask the picture host for a small version (originals can be megabytes); fall back to the original, then to the
      // listing's own picture, then to a text tile.
      const small = U.thumbUrl(src, 160) || src;
      img.addEventListener('error', () => {
        if (img.src !== src && !img.dataset.retried) {
          img.dataset.retried = '1';
          img.src = src;
        } else if (own && !pick && it.image && img.dataset.retried !== '2' && /^https:\/\//.test(it.image)) {
          img.dataset.retried = '2';
          img.src = U.thumbUrl(it.image, 160) || it.image;
        } else if (pick) img.remove();
        else img.replaceWith(short);
      });
      img.src = small;
      btn.append(img);
    } else if (pick) return null;
    else btn.textContent = short;
    return btn;
  }

  function card(it) {
    const s = data.settings;
    const conv = U.convert(it.price, data.rates, s.currency);
    const src = (it.sources || [])[0];
    const seen = mentions(it);
    const state = it.check ? it.check.state : '';
    const isOpen = view.openKey === it.key;
    const inQueue = data.queue && data.queue.active && data.queue.keys[data.queue.i] === it.key;

    const meta = h('div', { class: 'meta' });
    if (it.price != null) {
      const all = U.totalQty(it);
      meta.append(h('span', { class: 'price' }, U.yuan(it.price) + (all > 1 ? ' × ' + all : '')));
      if (conv != null && s.currency !== 'CNY') meta.append(h('span', {}, '≈ ' + U.money(conv * all, s.currency)));
    }
    if (it.platform !== 'yupoo') {
      const w = U.weightOf(it, s);
      const pieces = U.totalQty(it);
      meta.append(h('span', { class: 'weight', title: w.own ? 'The weight you set (Edit)' : 'Estimated weight, for ' + w.label.toLowerCase() + (pieces > 1 ? ', ' + U.kg(w.g) + ' each' : '') + '. Set the real weight under Edit.' }, (w.own ? '' : '~') + U.kg(w.g * pieces)));
    }
    const plat = (L.PLATFORMS[it.platform] || {}).label || it.platform;
    if (!src) meta.append(h('span', { class: 'plat', title: it.url }, plat));
    if (it.platform === 'yupoo') {
      meta.append(it.pending
        ? h('span', { class: 'badge', title: "Yupoo didn't answer when this was saved. Open Edit and press Find buy link." }, 'Buy link not checked')
        : h('span', { class: 'badge bad', title: 'The seller put no Weidian or Taobao link on this album' }, 'No buy link'));
    }
    if (state === 'soldout') meta.append(h('span', { class: 'badge bad' }, 'Sold out'));
    if (state === 'gone') meta.append(h('span', { class: 'badge bad', title: 'Weidian no longer lists this item' }, 'Removed?'));
    if (it.seller) meta.append(h('span', { class: 'badge' + (trusted(it) ? ' gold' : ''), title: trusted(it) ? 'Trusted seller' : 'Seller' }, (trusted(it) ? '★ ' : '') + sellerName(it.seller)));
    if (seen > 1) meta.append(h('span', { class: 'badge gold', title: 'You have seen this link in ' + seen + ' different posts' }, '×' + seen + ' posts'));
    const hasChoices = (it.choices || []).length > 0;
    const chosen = hasChoices ? [] : (it.options || []).map((o) => o.v).concat((it.options || []).length ? [] : [it.style, it.size].filter(Boolean));
    if (chosen.length) meta.append(h('span', { class: 'badge', title: (it.options || []).length ? 'What you picked on the listing. When RepHop adds this to your cart it looks for the same; if that is sold out or gone, it asks you.' : 'What RepHop will look for when it adds this to your cart' }, chosen.join(' · ')));

    const info = h('div', { class: 'info' },
      h('button', { class: 'title', type: 'button', title: 'Open in ' + agent.name, onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) }, U.displayTitle(it)),
      meta);
    if (src) {
      const where = U.sourceText(src) || 'source';
      const url = L.toUrl(src.commentUrl || src.postUrl);
      info.append(h('div', { class: 'src' }, h('span', { class: 'plat', title: it.url }, plat), ' · ', url ? h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer', title: 'Open where you found it' }, 'from ' + where) : 'from ' + where));
    }
    if ((it.tags && it.tags.length) || it.note) {
      info.append(h('div', { class: 'note' }, (it.tags || []).map((t) => h('span', { class: 'tag' }, '#' + t)), it.note || ''));
    }

    const bought = it.status === 'bought';
    const cartOn = it.status === 'carted';
    // (A friend's copy of the same product being added in a group haul is not this card's business.)
    const adding = !!(inQueue && data.queue.auto && !(Array.isArray(data.queue.owner) && data.queue.owner[data.queue.i]));
    const cartBtn = it.platform === 'yupoo' ? null
      : bought ? h('span', { class: 'on chip', title: 'Marked as bought. Change the status under Edit.' }, '✓ Bought')
      : cartOn ? h('button', { type: 'button', class: 'on', title: 'In your cart. Click to unmark it (your cart itself is not changed).', 'aria-pressed': 'true',
        onclick: async () => {
          await send({ type: 'update', keys: [it.key], patch: { status: 'saved' } });
          toast('Unmarked. Your cart at ' + agent.name + ' was not changed.', { action: { label: 'Undo', fn: () => send({ type: 'update', keys: [it.key], patch: { status: 'carted' } }) } });
        } }, '✓ In cart')
      : h('span', { class: 'split' },
        h('button', { type: 'button', class: 'cart', disabled: adding, title: 'Open this at ' + agent.name + ', set its options and press Add To Cart' + ((it.more || []).some((p) => p.status === 'saved') ? ' (and the other picks still to add)' : ''), onclick: () => addOne(it) }, adding ? 'Adding…' : 'Add to cart'),
        markMenu(it, null));
    const acts = h('div', { class: 'acts' },
      h('button', { class: 'go', type: 'button', title: it.platform === 'yupoo' ? 'Open the album' : 'Open in ' + agent.name, onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) }, it.platform === 'yupoo' ? 'Open album' : ['Open', h('span', { class: 'go-s' }, ' in ' + agent.name)]),
      it.platform !== 'yupoo' && h('button', { type: 'button', title: 'Look for QC photos of this item', onclick: () => send({ type: 'openTab', url: L.qcUrl(it, s) }) }, 'QC'),
      cartBtn,
      h('button', { type: 'button', title: 'Edit, tag, move or delete', 'aria-expanded': String(isOpen), onclick: () => { view.openKey = isOpen ? null : it.key; render(); } }, isOpen ? 'Close' : 'Edit'));

    const li = h('li', { class: 'item' + (it.viewedAt ? ' viewed' : '') + (inQueue ? ' current' : '') },
      h('button', { type: 'button', class: 'x', title: 'Delete from your list (you can undo)', 'aria-label': 'Delete ' + U.displayTitle(it), onclick: () => removeKeys([it.key]) }, icon('x')),
      h('div', { class: 'main' },
        h('input', { type: 'checkbox', class: 'pick', checked: view.selected.has(it.key), 'aria-label': 'Select ' + U.displayTitle(it),
          onchange: (e) => { e.target.checked ? view.selected.add(it.key) : view.selected.delete(it.key); renderChrome(); } }),
        thumb(it), info),
      (it.more || []).length && (it.choices || []).length ? h('div', { class: 'pick-n first' }, 'Pick 1') : null,
      choiceRow(it),
      (it.more || []).length ? h('div', { class: 'picks' }, it.more.map((p, n) => pickRow(it, p, n))) : null,
      it.platform !== 'yupoo' && (it.choices || []).length && (it.more || []).length < U.MAX_MORE
        ? h('button', { type: 'button', class: 'add-pick', title: 'Want two colours, or the top and the trousers of a set? Add another pick from this listing.', onclick: () => addPick(it) }, '+ Another colour or size')
        : null,
      acts);
    li.dataset.key = it.key;
    if (isOpen) li.append(editor(it));
    return li;
  }

  /** "In cart" / "Bought" in a fixed place: a label on the picture. */
  function withState(el, status) {
    if (status === 'carted' || status === 'bought') el.append(h('span', { class: 'state ' + status }, status === 'carted' ? 'In cart' : 'Bought'));
    return el;
  }

  function editor(it) {
    const save = (patch) => send({ type: 'update', keys: [it.key], patch });
    const field = (label, control, full) => h('label', { class: full ? 'full' : '' }, label, control);
    const folderSel = h('select', { onchange: (e) => save({ folder: e.target.value }) }, data.folders.map((f) => h('option', { value: f }, f)));
    folderSel.value = it.folder;
    const statusSel = h('select', { onchange: (e) => save({ status: e.target.value }) }, Object.entries(U.STATUSES).map(([v, t]) => h('option', { value: v }, t)));
    statusSel.value = it.status || 'saved';

    const guess = U.guessKind(Object.assign({}, it, { kind: '' }));
    const short = (k) => U.KINDS[k].split(' (')[0];
    const kindSel = h('select', { onchange: (e) => save({ kind: e.target.value }) },
      h('option', { value: '' }, guess ? 'Automatic (' + short(guess).toLowerCase() + ')' : 'Automatic'),
      Object.keys(U.KINDS).map((k) => h('option', { value: k }, short(k))),
      h('option', { value: 'other' }, 'Something else'));
    kindSel.value = it.kind || '';
    const mine = U.sizeFor(Object.assign({}, it, { size: '' }), data.settings);

    const box = h('div', { class: 'editor' },
      field('Name', h('input', { type: 'text', value: U.displayTitle(it), maxLength: 200, onchange: (e) => save({ customTitle: e.target.value.trim() }) }), true),
      field('Price (¥)', h('input', { type: 'number', min: '0', step: '0.01', value: it.price == null ? '' : String(it.price), onchange: (e) => save({ price: e.target.value }) })),
      field('Quantity', h('input', { type: 'number', min: '1', max: '99', step: '1', value: String(it.qty || 1), onchange: (e) => save({ qty: e.target.value }) })),
      field('Weight of one (g)', h('input', { type: 'number', min: '1', max: '30000', step: '1', value: it.weight ? String(it.weight) : '', placeholder: '≈ ' + U.weightOf(Object.assign({}, it, { weight: 0 }), data.settings).g + ' estimated', title: 'Leave empty for RepHop’s estimate. Once your agent has weighed it, put the real weight here.', onchange: (e) => save({ weight: e.target.value }) })),
      field('Folder', folderSel),
      field('Status', statusSel),
      field('Type', kindSel),
      field('Size for this item', h('input', { type: 'text', value: it.size || '', maxLength: 40, placeholder: mine ? 'My sizes: ' + mine : 'e.g. 43 or L', onchange: (e) => save({ size: e.target.value }) })),
      field('Colour or style to pick', h('input', { type: 'text', value: it.style || '', maxLength: 40, placeholder: 'e.g. black', onchange: (e) => save({ style: e.target.value }) }), true),
      field('Tags (comma separated)', h('input', { type: 'text', value: (it.tags || []).join(', '), placeholder: 'shoes, size 43', onchange: (e) => save({ tags: e.target.value }) }), true),
      field('Note', h('textarea', { rows: 2, value: it.note || '', maxLength: 2000, placeholder: 'Size, colour, batch…', onchange: (e) => save({ note: e.target.value }) }), true));

    const listed = [it.titleEn, it.title].filter((t) => t && t !== U.displayTitle(it));
    if (listed.length) box.append(h('div', { class: 'full orig' }, 'Listing name: ' + listed.join(' · ')));
    if ((it.options || []).length) {
      box.append(h('div', { class: 'full line' },
        h('span', { class: 'orig' }, 'Picked on the listing: ' + it.options.map((o) => (o.n ? o.n + ' ' : '') + o.v).join(' · ')),
        h('button', { type: 'button', title: 'Forget these, so RepHop chooses from your sizes instead', onclick: () => save({ options: [] }) }, 'Forget')));
    }
    if (it.seller) {
      box.append(h('label', { class: 'full line check' },
        h('input', { type: 'checkbox', checked: trusted(it), onchange: (e) => send({ type: 'seller', key: it.seller.key, name: sellerName(it.seller), trusted: e.target.checked }) }),
        'Trusted seller: ' + sellerName(it.seller)));
    }
    if ((it.sources || []).length) {
      box.append(h('div', { class: 'full sources' }, 'Found in',
        it.sources.map((src) => {
          const url = L.toUrl(src.commentUrl || src.postUrl);
          const label = (U.sourceText(src) || 'source') + (src.author ? ' · u/' + src.author : '');
          return url ? h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, label) : h('span', {}, label);
        })));
    }
    box.append(h('div', { class: 'full line' },
      h('button', { type: 'button', onclick: () => send({ type: 'openTab', url: it.url }) }, 'Original link'),
      h('button', { type: 'button', onclick: () => copy(L.agentUrl(it, data.settings) || it.url, 'the link') }, 'Copy link'),
      it.platform === 'weidian' && h('button', { type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        const r = await send({ type: 'refresh', keys: [it.key] });
        toast(!r || r.unknown ? "Couldn't reach Weidian just now." : r.gone ? 'Weidian no longer lists this item.' : r.soldout ? 'This item is sold out.' : 'Still available. Price and name refreshed.');
      } }, 'Check now'),
      it.platform === 'yupoo' && h('button', { type: 'button', title: 'Read the album again and look for a Weidian or Taobao link', onclick: async (e) => {
        e.target.disabled = true;
        const r = await send({ type: 'recheck', key: it.key });
        if (!r || !r.ok) {
          e.target.disabled = false;
          return toast("Couldn't reach Yupoo just now. Try again in a bit.", { error: true });
        }
        if (r.noBuyLink) {
          e.target.disabled = false;
          return toast('Still no Weidian or Taobao link on this album.');
        }
        view.openKey = r.key;
        toast('Found the buy link. This item now opens in ' + agent.name + '.');
      } }, 'Find buy link'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'danger', onclick: () => removeKeys([it.key]) }, 'Delete')));
    return box;
  }

  function savedKeyFor(key) {
    if (data.items[key]) return key;
    for (const it of Object.values(data.items)) if ((it.aliases || []).includes(key)) return it.key;
    return null;
  }

  /** The strip that offers to save whatever product page is open in the tab beside the panel. */
  function renderThisTab() {
    const box = $('#this-tab');
    box.hidden = !thisTab;
    if (!thisTab) return;
    const saved = savedKeyFor(thisTab.key);
    $('#this-tab-text').textContent = saved ? 'This tab is in your list ✓' : 'On this tab: ' + (thisTab.title || 'a product page');
    $('#this-tab-save').hidden = !!saved;
  }

  async function refreshThisTab() {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch (_) {
      /* no window */
    }
    const parsed = tab && tab.url ? L.parseLink(tab.url) : null;
    thisTab = parsed && parsed.kind !== 'short' ? { id: tab.id, url: tab.url, title: (tab.title || '').slice(0, 80), key: parsed.key } : null;
    renderThisTab();
  }

  function norm(t) {
    return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * What RepHop would choose for an item, row by row, from its drop-downs, the item's own size and colour, and your sizes.
   * `pick` is one of the item's other picks (another colour from the same listing); without it, the first pick.
   */
  function planFor(it, pick) {
    const groups = (it.choices || []).map((c) => ({ name: c.n, options: c.o.map((t) => ({ text: t })) }));
    const options = pick ? pick.options || [] : it.options || [];
    return { groups, plan: U.planCart(groups, { options, size: U.sizeFor(it, data.settings), style: pick ? '' : it.style || '', source: it.wd || [] }) };
  }

  /** The drop-downs for a listing's choices (colour, size…). Changing one stores your pick with the item (or with `pick`). */
  function choiceRow(it, pick) {
    if (it.platform === 'yupoo') return null;
    const { groups, plan } = planFor(it, pick);
    if (!groups.length) {
      // Taobao and 1688 only tell us their choices on the agent's listing.
      if (it.platform === 'weidian' || it.status !== 'saved' || (it.options || []).length) return null;
      return h('div', { class: 'opts-hint' }, 'Colours and sizes show up here after you open it once.');
    }
    const box = h('div', { class: 'opts' });
    groups.forEach((g, gi) => {
      const row = plan.rows[gi];
      const label = U.groupLabel(g.name);
      const why = row.pick == null ? 'Choose the ' + label.toLowerCase() + ' RepHop should add to your cart'
        : row.from === 'size' ? 'Filled in from your sizes. Choose another to change it for this item.'
        : row.from === 'style' ? 'Filled in from the colour written under Edit.'
        : row.from === 'only' ? 'The only choice this listing has' : 'Your pick for this item';
      const sel = h('select', {
        class: 'opt' + (row.pick == null ? ' unset' : ''), title: why, 'aria-label': label + ' for ' + U.displayTitle(it),
        onchange: (e) => {
          const v = e.target.value;
          // Replace whatever decided this row before, then store the new pick under the row's own name.
          let next = ((pick ? pick.options : it.options) || []).filter((o, i) => i !== row.from && !(o.n && norm(o.n) === norm(g.name)));
          if (v !== '') next = next.concat({ n: g.name, v: g.options[Number(v)].text });
          if (pick) send({ type: 'pick', op: 'set', key: it.key, id: pick.id, patch: { options: next } });
          else send({ type: 'update', keys: [it.key], patch: { options: next } });
        },
      },
        h('option', { value: '' }, label + '…'),
        g.options.map((o, i) => h('option', { value: String(i) }, U.optionLabel(o.text) + (i === row.pick && row.from === 'size' ? ' (my size)' : ''))));
      sel.value = row.pick != null ? String(row.pick) : '';
      box.append(sel);
    });
    if (plan.unused.length) {
      box.append(h('span', { class: 'badge bad', title: 'You picked this earlier, but the listing no longer offers it. Choose again above.' }, 'Not offered: ' + plan.unused.map((o) => o.v).join(', ')));
    }
    return box;
  }

  /**
   * Only one add-to-cart run at a time. A run that has sat on one item for a quarter of an hour is
   * taken to be abandoned; a live one can be stopped right from the message.
   */
  async function runBusy(retry) {
    const q = data.queue;
    if (!(q && q.active && q.auto)) return false;
    if (Date.now() - (q.stepAt || 0) > 15 * 60000) {
      await send({ type: 'queue', op: 'stop' });
      return false;
    }
    toast('RepHop is still adding something to your cart (' + (q.i + 1) + ' of ' + q.keys.length + ').', { error: true, action: { label: 'Stop that and start this', fn: async () => {
      await send({ type: 'queue', op: 'stop' });
      retry();
    } } });
    return true;
  }

  /** Hand items to the queue in automatic mode. `owner[i]` says whose item entry i is in a group haul. */
  async function runCart(keys, owner, what) {
    if (await runBusy(() => runCart(keys, owner, what))) return false;
    const r = await send({ type: 'queue', op: 'start', keys, owner, auto: true });
    if (r && r.reason === 'no-agent') return needAgent(), false;
    if (!r || !r.ok) return toast("Couldn't start.", { error: true }), false;
    toast('Adding ' + what + ' to your cart at ' + agent.name + '. Watch that tab: RepHop tells you there if it needs you.');
    return true;
  }

  /** The steps that add an item: its first pick (unless it is already in the cart) and each other pick still to add. */
  function cartSteps(it, onlyPick) {
    const steps = [];
    if (!onlyPick && it.status === 'saved') steps.push({ pick: null });
    for (const p of it.more || []) if (p.status === 'saved' && (!onlyPick || onlyPick === p)) steps.push({ pick: p });
    return steps;
  }

  /** The Add to cart button on a card, or on one of its other picks. */
  function addOne(it, onlyPick) {
    const steps = cartSteps(it, onlyPick);
    if (!steps.length) return;
    const keys = steps.map(() => it.key);
    const owner = steps.some((x) => x.pick) ? steps.map((x) => (x.pick ? { v: x.pick.id } : null)) : null;
    const what = steps.length === 1 ? 'it' : steps.length + ' picks of it';
    // Better to say so here than to open the listing and stop there.
    const open = new Set();
    for (const x of steps) {
      const { groups, plan } = planFor(it, x.pick);
      groups.forEach((g, gi) => plan.rows[gi].pick == null && open.add(U.groupLabel(g.name).toLowerCase()));
    }
    if (open.size) {
      return toast('Choose the ' + Array.from(open).join(' and ') + ' first, in the drop-downs on this item.', { error: true, action: { label: 'Add anyway', fn: () => runCart(keys, owner, what) } });
    }
    return runCart(keys, owner, what);
  }

  /** Mark items as in your cart (or bought) without RepHop adding anything; the message offers Undo. */
  async function markAs(keys, status, extra) {
    const r = await send(Object.assign({ type: 'mark', keys, status }, extra || {}));
    if (!r || !r.count) return toast(status === 'bought' ? 'Already marked as bought.' : 'Already marked as in your cart.');
    const what = r.count === 1 ? '1 item' : r.count + ' items';
    toast((status === 'bought' ? 'Marked ' + what + ' as bought.' : 'Marked ' + what + ' as in your cart.') + ' Nothing was added at ' + agent.name + '.', { action: { label: 'Undo', fn: () => send({ type: 'mark', restore: r.before }) } });
  }

  /** The ▾ beside Add to cart: added it at the agent yourself? Mark it, or mark it bought. */
  function markMenu(it, p) {
    const others = !p && (it.more || []).some((x) => x.status === 'saved');
    const menu = h('details', { class: 'menu mark-menu' },
      h('summary', { title: 'Added it yourself? Mark it as in your cart', 'aria-label': 'Mark as in cart or bought' }, icon('down')),
      h('div', { class: 'menu-body' },
        h('button', { type: 'button', onclick: () => { menu.open = false; markAs([it.key], 'carted', p ? { pick: p.id } : { all: true }); } }, others ? 'Already in my cart: mark all picks' : 'Already in my cart: mark it'),
        h('button', { type: 'button', onclick: () => { menu.open = false; markAs([it.key], 'bought', p ? { pick: p.id } : { all: true }); } }, 'Mark as bought')));
    return menu;
  }

  /** A second (third…) choice from the same listing: starts with the size you picked, the rest to choose. */
  async function addPick(it) {
    const groups = (it.choices || []).map((c) => ({ name: c.n, options: c.o.map((t) => ({ text: t })) }));
    const sizeRows = new Set(groups.filter((g) => U.isSizeGroup(g.name, g.options)).map((g) => norm(g.name)));
    const options = (it.options || []).filter((o) => o.n && sizeRows.has(norm(o.n)));
    const r = await send({ type: 'pick', op: 'add', key: it.key, options });
    if (!r || !r.ok) toast('This item already has ' + (U.MAX_MORE + 1) + ' picks.', { error: true });
  }

  /** One of an item's other picks: its drop-downs, how many, and its own Add to cart / In cart / remove. */
  function pickRow(it, p, n) {
    const q = data.queue;
    const adding = !!(q && q.active && q.auto && q.keys[q.i] === it.key && Array.isArray(q.owner) && q.owner[q.i] && q.owner[q.i].v === p.id);
    const set = (patch) => send({ type: 'pick', op: 'set', key: it.key, id: p.id, patch });
    const btn = p.status === 'bought' ? h('button', { type: 'button', class: 'on', title: 'Marked as bought. Click to unmark it.', onclick: () => set({ status: 'saved' }) }, '✓ Bought')
      : p.status === 'carted' ? h('button', { type: 'button', class: 'on', 'aria-pressed': 'true', title: 'In your cart. Click to unmark it (your cart itself is not changed).', onclick: () => set({ status: 'saved' }) }, '✓ In cart')
      : h('span', { class: 'split' },
        h('button', { type: 'button', class: 'cart', disabled: adding, title: 'Add this pick to your cart at ' + agent.name, onclick: () => addOne(it, p) }, adding ? 'Adding…' : 'Add to cart'),
        markMenu(it, p));
    return h('div', { class: 'pick-row', 'data-pick': p.id },
      h('div', { class: 'pick-head' },
        thumb(it, p, 'pick-img'),
        h('span', { class: 'pick-n' }, 'Pick ' + (n + 2)),
        h('label', { class: 'pick-qty', title: 'How many of this pick' }, h('span', { class: 'ql' }, 'Qty'), h('input', { type: 'number', min: '1', max: '99', step: '1', value: String(p.qty || 1), 'aria-label': 'How many of pick ' + (n + 2), onchange: (e) => set({ qty: e.target.value }) })),
        btn,
        h('button', { type: 'button', class: 'pick-x', title: 'Remove this pick (you can undo)', 'aria-label': 'Remove pick ' + (n + 2), onclick: async () => {
          const r = await send({ type: 'pick', op: 'remove', key: it.key, id: p.id });
          if (r && r.removed) toast('Pick removed.', { action: { label: 'Undo', fn: () => send({ type: 'pick', op: 'restore', key: it.key, id: r.removed.id, pick: r.removed }) } });
        } }, '×')),
      choiceRow(it, p));
  }

  /** Add several items, one after the other. */
  async function startCart(list) {
    const items = list.filter((it) => it.platform !== 'yupoo' && cartSteps(it).length);
    const left = list.length - items.length;
    if (!items.length) return toast(left ? 'Nothing to add: these are already marked as in your cart or bought, or are albums with no listing.' : 'Select some items first.', { error: true });
    const keys = [];
    const owner = [];
    for (const it of items) {
      for (const x of cartSteps(it)) {
        keys.push(it.key);
        owner.push(x.pick ? { v: x.pick.id } : null);
      }
    }
    const extra = keys.length > items.length ? ' (' + keys.length + ' picks)' : '';
    const ok = await runCart(keys, owner.some(Boolean) ? owner : null, keys.length === 1 ? 'it' : items.length + ' items' + extra + (left ? ' (' + left + ' left out: already in cart, bought, or no listing)' : ''));
    if (ok) view.selected.clear();
  }

  async function removeKeys(keys) {
    const r = await send({ type: 'remove', keys });
    if (!r || !r.removed || !r.removed.length) return;
    for (const k of keys) view.selected.delete(k);
    toast(r.removed.length === 1 ? 'Deleted.' : 'Deleted ' + r.removed.length + ' items.', { action: { label: 'Undo', fn: () => send({ type: 'restore', items: r.removed }) } });
  }

  function renderFolders() {
    const counts = {};
    const all = Object.values(data.items);
    for (const it of all) counts[it.folder] = (counts[it.folder] || 0) + 1;
    const chip = (value, label, n) => h('button', { type: 'button', role: 'tab', class: view.folder === value ? 'on' : '', 'aria-selected': String(view.folder === value),
      onclick: () => { view.folder = value; view.limit = 120; render(); } }, label, h('small', {}, String(n)));
    $('#folders').replaceChildren(chip('*', 'All', all.length), ...data.folders.map((f) => chip(f, f, counts[f] || 0)));
    if (view.folder !== '*' && !data.folders.includes(view.folder)) view.folder = '*';
  }

  function fillSelect(sel, options, current, placeholder) {
    sel.replaceChildren(...(placeholder ? [h('option', { value: '' }, placeholder)] : []), ...options.map(([v, t]) => h('option', { value: v }, t)));
    sel.value = options.some(([v]) => v === current) ? current : '';
    return sel.value;
  }

  /** Everything around the cards: counts, totals, the selection bar and the queue banner. */
  function renderChrome() {
    const s = data.settings;
    const vis = visible();
    const sc = scope();
    let sum = 0;
    let unpriced = 0;
    let grams = 0;
    let guessed = false;
    for (const it of sc.list) {
      if (it.price == null) unpriced++;
      else sum += it.price * U.totalQty(it);
      if (it.platform === 'yupoo') continue;
      const w = U.weightOf(it, s);
      grams += w.g * U.totalQty(it);
      if (!w.own) guessed = true;
    }
    const conv = U.convert(sum, data.rates, s.currency);
    $('#count').textContent = sc.list.length === vis.length ? vis.length + (vis.length === 1 ? ' item' : ' items') : sc.label;
    const total = $('#total');
    total.replaceChildren();
    if (sc.list.length) {
      total.append(h('span', { class: 'line' }, h('b', {}, U.yuan(Math.round(sum * 100) / 100)), s.currency !== 'CNY' && conv != null ? ' ≈ ' + U.money(conv, s.currency) : ''));
      const second = [];
      if (grams) second.push(h('span', { class: 'weight', title: guessed ? 'Estimated from each item’s type (a hoodie about 0.7 kg, sneakers with their box about 1.25 kg). Your agent weighs the real thing; set it on an item under Edit.' : 'From the weights you set' }, (guessed ? '~' : '') + U.kg(grams)));
      if (unpriced) second.push(unpriced + ' without a price');
      if (second.length) total.append(h('span', { class: 'line sub' }, second.flatMap((x, i) => (i ? [' · ', x] : [x]))));
    }
    $('#scope').textContent = 'Applies to: ' + sc.label.toLowerCase();
    $('#start-queue').disabled = !sc.list.length;
    $('#select-all').textContent = view.selected.size ? 'Select none' : 'Select all';
    $('#select-all').disabled = !vis.length;

    const picked = vis.filter((it) => view.selected.has(it.key)).length;
    $('#bulk').hidden = !picked;
    if (picked) {
      $('#bulk-count').textContent = picked + ' selected';
      fillSelect($('#bulk-move'), data.folders.map((f) => [f, f]), '', 'Move to…');
    }

    const q = data.queue;
    const active = !!(q && q.active && q.keys.length);
    $('#queue-banner').hidden = !active;
    if (active) {
      $('#queue-text').textContent = runText(q);
      $('#queue-prev').disabled = q.i === 0;
      $('#queue-prev').hidden = !!q.auto;
      $('#queue-next').textContent = q.auto ? 'Skip ▶' : q.i + 1 >= q.keys.length ? 'Finish ✓' : 'Next ▶';
      $('#queue-stop').textContent = q.auto ? 'Stop' : 'End';
    }
  }

  function renderList() {
    const s = data.settings;
    $('#q-hijack').checked = s.clickHijack;
    const agentSel = $('#q-agent');
    if (agentSel !== document.activeElement) {
      fillSelect(agentSel, Object.entries(L.AGENTS).map(([k, a]) => [k, k === 'custom' ? 'Custom…' : a.name]), s.agent, 'your agent…');
      agentSel.classList.toggle('unset', !s.agent);
    }
    $('#pick-agent').hidden = !!s.agent;
    $('#q-mode').value = s.openMode;
    renderThisTab();
    const run = data.cartRun;
    $('#cart-summary').hidden = !run;
    if (run) {
      const r = Object.values(run.results || {});
      const n = (what) => r.filter((x) => x === what).length;
      $('#cart-summary-text').textContent = 'Add to cart finished: ' + n('added') + ' added for you' + (n('manual') ? ', ' + n('manual') + ' added by you' : '') + (n('skipped') ? ', ' + n('skipped') + ' skipped' : '') + (run.total > r.length ? ', ' + (run.total - r.length) + ' not reached' : '') + '.';
    }
    $('#sort').value = view.sort;
    $('#f-status').value = view.status;
    const on = [view.status, view.tag, view.seller].filter(Boolean).length;
    $('#filter-count').hidden = !on;
    $('#filter-count').textContent = String(on);
    $('#filters-clear').hidden = !on;
    $('#view-list').classList.toggle('is-empty', Object.keys(data.items).length === 0);
    for (const e of $$('.ag-short')) e.textContent = (L.AGENTS[s.agent] || {}).short || 'Open';
    $('#no-match-text').textContent = view.q && !on ? 'Nothing in your list matches “' + view.q + '”.' : 'Nothing matches these filters.';

    renderFolders();
    const all = Object.values(data.items);
    const tags = new Map();
    const sellers = new Map();
    for (const it of all) {
      for (const t of it.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
      if (it.seller && typeof it.seller.key === 'string') sellers.set(it.seller.key, sellerName(it.seller));
    }
    const tagSel = $('#f-tag');
    view.tag = fillSelect(tagSel, Array.from(tags.keys()).sort().map((t) => [t, '#' + t + ' (' + tags.get(t) + ')']), view.tag, 'Any tag');
    $('#f-tag-row').hidden = !tags.size;
    const sellerSel = $('#f-seller');
    view.seller = fillSelect(sellerSel, Array.from(sellers).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([k, n]) => [k, (data.sellers[k] && data.sellers[k].trusted ? '★ ' : '') + n]), view.seller, 'Any seller');
    $('#f-seller-row').hidden = !sellers.size;

    for (const k of Array.from(view.selected)) if (!data.items[k]) view.selected.delete(k);
    const vis = visible();
    const shown = vis.slice(0, view.limit);
    const frag = document.createDocumentFragment();
    for (const it of shown) {
      try {
        frag.append(card(it));
      } catch (e) {
        console.warn('RepHop: could not draw item', it && it.key, e);
      }
    }
    $('#items').replaceChildren(frag);
    const more = $('#show-more');
    more.hidden = vis.length <= view.limit;
    more.textContent = 'Show ' + Math.min(120, vis.length - view.limit) + ' more';
    $('#empty').hidden = all.length > 0;
    $('#no-match').hidden = !(all.length > 0 && vis.length === 0);
    renderChrome();

    // Fill in names and prices for anything that never got them (bulk imports, synced items).
    const need = shown.filter((it) => it.platform === 'weidian' && ((!it.title && !it.check) || !it.optsAt) && !asked.has(it.key)).map((it) => it.key).slice(0, 40);
    // Shop and English name come from a slower lookup; ask for a few of the items on screen at a time.
    const enrich = shown.filter((it) => it.platform === 'weidian' && !it.seller && !(it.check && it.check.state === 'gone') && !asked.has('e:' + it.key)).map((it) => it.key).slice(0, 6);
    if (need.length || enrich.length) {
      need.forEach((k) => asked.add(k));
      enrich.forEach((k) => asked.add('e:' + k));
      send({ type: 'needPreviews', keys: need, enrich });
    }
  }

  /** "Adding to cart, 2 of 5: Black hoodie (Sam)" */
  function runText(q) {
    const ref = Array.isArray(q.owner) ? q.owner[q.i] : null;
    const person = ref && data.group ? (data.group.people || []).find((p) => p.id === ref.p) : null;
    const theirs = person ? person.items.find((x) => x.uid === ref.x) : null;
    const cur = theirs || data.items[q.keys[q.i]];
    const name = cur ? (theirs ? theirs.title || 'item' : U.displayTitle(cur)) : '';
    return (q.auto ? 'Adding to cart, ' : 'Going through ') + (q.i + 1) + ' of ' + q.keys.length + (name ? ': ' + name : '') + (person ? ' (' + person.name + ')' : '');
  }

  // ----------------------------------------------------------- welcome screen

  function renderSetup() {
    const cur = data.settings.agent;
    $('#setup-agents').replaceChildren(...Object.entries(L.AGENTS).map(([k, a]) => h('button', { type: 'button', class: cur === k ? 'on' : '', 'aria-pressed': String(cur === k), onclick: () => patch({ agent: k }) }, k === 'custom' ? 'Other…' : a.name)));
    $('#setup-done').textContent = cur ? 'Start using RepHop' : 'Pick your agent to start';
    $('#setup-done').classList.toggle('waiting', !cur);
  }

  // --------------------------------------------------------------- group haul

  const gv = { mode: 'people', box: '' };

  /** "Black · M": what someone wants of an item. */
  function picksText(it) {
    const parts = (it.options || []).map((o) => o.v);
    if (it.size && !(it.options || []).some((o) => U.isSizeGroup(o.n, []))) parts.push('size ' + it.size);
    if (it.style) parts.push(it.style);
    return parts.join(' · ');
  }

  /** The part of your own list that belongs to the haul. */
  function myHaul() {
    const g = data.group || {};
    const mine = g.mine == null ? '*' : g.mine;
    if (mine === '') return [];
    return Object.values(data.items).filter((it) => it.platform !== 'yupoo' && (it.status !== 'bought' || (it.more || []).some((p) => p.status !== 'bought')) && (mine === '*' || it.folder === mine)).sort(SORTS.new);
  }

  /** Everyone in the haul, you first: [{ id, name, you, items }] with every item in the same shape. */
  function groupPeople() {
    const g = data.group || {};
    const out = [];
    const mine = [];
    for (const it of myHaul()) {
      const base = { own: it, key: it.key, platform: it.platform, id: it.id, title: U.displayTitle(it), price: it.price, size: U.sizeFor(it, data.settings), image: it.image, kind: it.kind, weight: it.weight };
      if (it.status !== 'bought') mine.push(Object.assign({}, base, { qty: it.qty || 1, options: it.options || [], style: it.style || '', note: it.note || '', status: it.status }));
      // Each other pick from the same listing counts as its own item in the haul.
      for (const pick of it.more || []) {
        if (pick.status !== 'bought') mine.push(Object.assign({}, base, { pick, qty: pick.qty || 1, options: pick.options || [], style: '', note: '', status: pick.status }));
      }
    }
    if (mine.length) out.push({ id: '', name: g.me ? g.me + ' (you)' : 'You', you: true, items: mine });
    for (const p of g.people || []) out.push({ id: p.id, name: p.name, at: p.at, you: false, live: p.live || '', items: p.items || [] });
    return out;
  }

  /** What "Share my list" can send: [[value, label, items]]. */
  function shareScopes() {
    const all = Object.values(data.items).filter((it) => it.platform !== 'yupoo');
    const open = all.filter((it) => it.status !== 'bought');
    const out = [];
    const picked = all.filter((it) => view.selected.has(it.key));
    if (picked.length) out.push(['sel', 'Selected in the list (' + picked.length + ')', picked]);
    out.push(['*', 'Everything not bought yet (' + open.length + ')', open]);
    for (const f of data.folders) {
      const list = open.filter((it) => it.folder === f);
      if (list.length) out.push(['f:' + f, 'Folder: ' + f + ' (' + list.length + ')', list]);
    }
    return out;
  }

  function shareChoice() {
    const scopes = shareScopes();
    return scopes.find(([v]) => v === $('#g-scope').value) || scopes[0];
  }

  /** Start a run over group items: [{ key, owner }] where owner is null for your own. */
  function groupCart(entries, what) {
    if (!entries.length) return toast('Nothing left to add: everything here is already marked as in the cart.', { error: true });
    return runCart(entries.map((e) => e.key), entries.map((e) => e.owner || null), what);
  }

  function entryFor(p, it) {
    return { key: it.key, owner: p.you ? (it.pick ? { v: it.pick.id } : null) : { p: p.id, x: it.uid } };
  }

  function groupItem(p, it, tagged) {
    const s = data.settings;
    const conv = U.convert(it.price, data.rates, s.currency);
    const picks = picksText(it);
    const done = it.status === 'carted' || it.status === 'bought';
    const title = it.title || ((L.PLATFORMS[it.platform] || {}).label || 'Item') + ' #' + it.id;
    const meta = h('div', { class: 'meta' });
    if (tagged) meta.append(h('span', { class: 'badge who' }, p.name));
    if (it.price != null) {
      meta.append(h('span', { class: 'price' }, U.yuan(it.price) + ((it.qty || 1) > 1 ? ' × ' + it.qty : '')));
      if (conv != null && s.currency !== 'CNY') meta.append(h('span', {}, '≈ ' + U.money(conv * (it.qty || 1), s.currency)));
    } else meta.append(h('span', { class: 'badge', title: 'Open the listing once and the price is filled in' }, 'No price yet' + ((it.qty || 1) > 1 ? ' · × ' + it.qty : '')));
    if (picks) meta.append(h('span', { class: 'badge picked', title: 'What ' + (p.you ? 'you' : p.name) + ' picked' }, picks));
    const mark = (status) => (p.you && it.pick ? send({ type: 'pick', op: 'set', key: it.key, id: it.pick.id, patch: { status } })
      : p.you ? send({ type: 'update', keys: [it.key], patch: { status } }) : send({ type: 'group', op: 'mark', id: p.id, uid: it.uid, status }));
    const cart = done
      ? h('button', { type: 'button', class: 'on', title: 'Marked as in the cart. Click to unmark it (the cart itself is not changed).', onclick: () => mark('saved') }, it.status === 'bought' ? '✓ Bought' : '✓ In cart')
      : h('button', { type: 'button', class: 'cart', title: 'Add this to your cart with ' + (p.you ? 'your' : p.name + '’s') + ' choices', onclick: () => groupCart([entryFor(p, it)], p.you ? 'it' : p.name + '’s item') }, 'Add to cart');
    return h('li', { class: 'item g-item' },
      !p.you && h('button', { type: 'button', class: 'x', title: 'Remove from ' + p.name + '’s list', 'aria-label': 'Remove ' + title, onclick: () => send({ type: 'group', op: 'removeItem', id: p.id, uid: it.uid }) }, '×'),
      h('div', { class: 'main' }, thumb(it),
        h('div', { class: 'info' },
          h('button', { class: 'title', type: 'button', title: 'Open in ' + agent.name, onclick: (e) => openItem(it, e) }, title),
          meta,
          it.note ? h('div', { class: 'note' }, it.note) : null)),
      h('div', { class: 'acts' }, h('button', { class: 'go', type: 'button', onclick: (e) => openItem(it, e) }, 'Open in ' + agent.name), cart));
  }

  /** The text behind "Copy who owes what". */
  function groupSummary(tot, split) {
    const cur = data.settings.currency;
    const m = (n) => (n == null ? '?' : U.money(n, cur));
    const approx = (yuan, conv) => U.yuan(yuan) + (cur !== 'CNY' ? ' ≈ ' + m(conv) : '');
    const lines = ['Group haul, ' + new Date().toLocaleDateString(), 'Items: ' + approx(tot.yuan, tot.items) + ' (' + tot.count + (tot.count === 1 ? ' item' : ' items') + ', about ' + U.kg(tot.grams) + ')'];
    if (tot.extra) lines.push('Shipping and fees: ' + m(tot.extra) + ', split ' + (split === 'cost' ? 'by item cost' : split === 'weight' ? 'by estimated weight' : 'evenly'), 'Total: ' + m(tot.total));
    lines.push('');
    for (const r of tot.rows) lines.push(r.name + ': ' + approx(r.yuan, r.items) + (tot.extra ? ' + ' + m(r.share) + ' = ' + m(r.owes) : '') + ' (' + r.count + (r.count === 1 ? ' item' : ' items') + (r.unpriced ? ', ' + r.unpriced + ' without a price' : '') + ')');
    if (cur !== 'CNY') lines.push('', 'Converted at today’s rate. The agent’s own rate and fees decide the final amounts.');
    return lines.join('\n');
  }

  function renderGroup() {
    const g = data.group || {};
    const s = data.settings;
    const friends = g.people || [];
    renderLive();

    $('#g-share-box').hidden = gv.box !== 'share';
    $('#g-add-box').hidden = gv.box !== 'add';
    if (gv.box === 'share') {
      const scopes = shareScopes();
      const sel = $('#g-scope');
      if (sel !== document.activeElement) fillSelect(sel, scopes.map(([v, t]) => [v, t]), scopes.some(([v]) => v === sel.value) ? sel.value : scopes[0][0]);
      const me = $('#g-me');
      if (me !== document.activeElement && !me.value) me.value = g.me || '';
      const n = (shareChoice() || [0, 0, []])[2].length;
      const albums = Object.values(data.items).filter((it) => it.platform === 'yupoo').length;
      $('#g-share-note').textContent = (n ? n + (n === 1 ? ' item goes' : ' items go') + ' into the code, each with the colour, size and quantity set on it.' : 'There is nothing to share yet. Save some items first.') +
        (albums ? ' Yupoo albums without a buy link are left out.' : '');
    }

    const q = data.queue;
    const running = !!(q && q.active && q.auto && q.keys.length);
    $('#g-run').hidden = !running;
    if (running) $('#g-run-text').textContent = runText(q);

    $('#g-body').hidden = !friends.length;
    $('#g-empty').hidden = !!friends.length || !!liveNow();
    $('#view-group').classList.toggle('has-haul', friends.length > 0);
    if (!friends.length) {
      // Nothing of the last haul stays behind in the page.
      $('#g-people').replaceChildren();
      $('#g-rows').replaceChildren();
      return;
    }

    const people = groupPeople();
    const tot = U.groupTotals(people, data.rates, s.currency, g.extra || 0, g.split, s);
    const m = (n) => (n == null ? '?' : U.money(n, s.currency));
    const itemsCost = U.yuan(tot.yuan) + (s.currency !== 'CNY' ? ' ≈ ' + m(tot.items) : '');
    const withShipping = !!tot.extra && tot.total != null;
    $('#g-sum').textContent = withShipping ? m(tot.total) : itemsCost;
    $('#g-sum-note').textContent = (withShipping ? 'Items ' + itemsCost + ' + shipping and fees ' + m(tot.extra) + ' · ' : '') + tot.count + (tot.count === 1 ? ' item' : ' items') + ' · ~' + U.kg(tot.grams) + ' · ' + people.length + (people.length === 1 ? ' person' : ' people') +
      (tot.unpriced ? ' · ' + tot.unpriced + ' without a price' : '');
    $('#g-cur').textContent = s.currency;
    const extra = $('#g-extra');
    if (extra !== document.activeElement) extra.value = g.extra ? String(g.extra) : '';
    $('#g-split').value = g.split === 'cost' || g.split === 'weight' ? g.split : 'even';
    const mine = $('#g-mine');
    if (mine !== document.activeElement) {
      fillSelect(mine, [['*', 'Everything not bought yet']].concat(data.folders.map((f) => ['f:' + f, 'Folder: ' + f]), [['', 'Leave mine out']]), g.mine === '' ? '' : g.mine && g.mine !== '*' ? 'f:' + g.mine : '*');
    }

    $('#g-rows').replaceChildren(...tot.rows.map((r) => h('tr', {},
      h('td', {}, h('b', {}, r.name), h('small', {}, r.count + (r.count === 1 ? ' item' : ' items') + ' · ~' + U.kg(r.grams) + (r.unpriced ? ' · ' + r.unpriced + ' no price' : ''))),
      h('td', {}, U.yuan(r.yuan), s.currency !== 'CNY' && tot.extra ? h('small', {}, '≈ ' + m(r.items)) : null),
      h('td', {}, tot.extra ? '+ ' + m(r.share) : '–'),
      h('td', { class: 'owes' }, m(r.owes)))));
    $('#g-table').classList.toggle('no-share', !tot.extra);
    $('#g-rate-note').textContent = s.currency === 'CNY' ? '' : 'Converted at today’s rate (' + s.currency + '). Your agent’s own rate and fees decide the final amounts.';
    $('#g-cart').textContent = running ? 'Adding…' : 'Add everything to cart';
    $('#g-cart').disabled = running;

    for (const b of $$('[data-gview]')) {
      b.classList.toggle('on', b.dataset.gview === gv.mode);
      b.setAttribute('aria-selected', String(b.dataset.gview === gv.mode));
    }
    const box = $('#g-people');
    if (gv.mode === 'all') {
      const flat = [];
      for (const p of people) for (const it of p.items) flat.push([p, it]);
      // The same product from several people sits together.
      flat.sort((a, b) => a[1].key.localeCompare(b[1].key));
      box.replaceChildren(h('ul', { class: 'items' }, flat.map(([p, it]) => groupItem(p, it, true))));
      return;
    }
    box.replaceChildren(...people.map((p, i) => {
      const r = tot.rows[i];
      const left = p.items.filter((it) => it.status !== 'carted' && it.status !== 'bought');
      return h('section', { class: 'g-person' },
        h('div', { class: 'g-head' },
          h('b', {}, p.name),
          p.live ? h('span', { class: 'badge good', title: 'This list updates by itself' }, 'live') : null,
          h('span', { class: 'hint' }, r.count + (r.count === 1 ? ' item' : ' items') + ' · ' + U.yuan(r.yuan) + (s.currency !== 'CNY' ? ' ≈ ' + m(r.items) : '')),
          h('span', { class: 'grow' }),
          left.length > 0 && h('button', { type: 'button', disabled: running, title: 'Add ' + (p.you ? 'your' : p.name + '’s') + ' items that are not in the cart yet', onclick: () => groupCart(left.map((it) => entryFor(p, it)), left.length + (p.you ? ' of your items' : ' of ' + p.name + '’s items')) }, 'Add ' + left.length + ' to cart'),
          !p.you && h('button', { type: 'button', class: 'danger', title: 'Take ' + p.name + ' out of this haul', onclick: (e) => confirmClick(e.currentTarget, 'Remove ' + p.name + '? Click again', async () => {
            // Someone in the live haul is taken out of it altogether; they are told.
            if (p.live) return liveDo({ op: 'remove', id: p.live }, 'Removed ' + p.name + ' from the live haul.');
            const res = await send({ type: 'group', op: 'remove', id: p.id });
            if (res && res.removed) toast('Removed ' + p.name + '’s list.', { action: { label: 'Undo', fn: () => send({ type: 'group', op: 'restore', person: res.removed }) } });
          }) }, 'Remove')),
        h('ul', { class: 'items' }, p.items.map((it) => groupItem(p, it, false))));
    }));
  }

  // ---------------------------------------------------------------- live haul
  // The list page holds the one connection to the relay while it is open: the relay uses it to say
  // "something changed", and the background then fetches and decrypts it. Sending never needs it.

  let liveSock = null;
  let liveSockFor = '';
  let liveUp = false;
  let liveRetry = null;
  let liveWait = 2000;
  let livePing = null;

  function liveNow() {
    const l = data.group && data.group.live;
    return l && l.room ? l : null;
  }

  function liveWanted() {
    const l = liveNow();
    return l && l.status !== 'gone' ? l.room + '|' + (l.role === 'host' ? 'host' : l.mid) : '';
  }

  function liveClose() {
    clearTimeout(liveRetry);
    clearInterval(livePing);
    liveRetry = null;
    const old = liveSock;
    liveSock = null;
    liveUp = false;
    if (old) {
      try {
        old.close();
      } catch (_) {
        /* already closed */
      }
    }
  }

  async function liveConnect() {
    const want = liveWanted();
    if (want === liveSockFor && (liveSock || liveRetry)) return;
    liveClose();
    liveSockFor = want;
    if (!want) return;
    const again = () => {
      liveRetry = setTimeout(() => {
        liveRetry = null;
        liveSockFor = '';
        liveConnect();
      }, liveWait);
      liveWait = Math.min(liveWait * 2, 30000);
    };
    const info = await send({ type: 'live', op: 'socket' });
    if (liveSockFor !== want) return;
    if (!info || !info.ok) return again();
    let ws;
    try {
      ws = new WebSocket(info.url, info.protocols);
    } catch (_) {
      return again();
    }
    liveSock = ws;
    ws.addEventListener('open', () => {
      if (liveSock !== ws) return;
      liveUp = true;
      liveWait = 2000;
      send({ type: 'live', op: 'sync' });
      livePing = setInterval(() => {
        try {
          ws.send('ping');
        } catch (_) {
          /* closing */
        }
      }, 25000);
      renderLive();
    });
    ws.addEventListener('message', (e) => {
      if (e.data !== 'pong') send({ type: 'live', op: 'sync' });
    });
    ws.addEventListener('close', () => {
      if (liveSock !== ws) return;
      clearInterval(livePing);
      liveSock = null;
      liveUp = false;
      renderLive();
      again();
    });
  }

  /** Ask the background to do something in the live haul, and say so if it could not. */
  async function liveDo(msg, done) {
    const r = await send(Object.assign({ type: 'live' }, msg));
    if (r && r.ok) {
      if (done) toast(done);
      return r;
    }
    const why = r && r.reason;
    toast(why === 'no-relay' ? 'This copy of RepHop has no relay built in. Enter one under Settings → Live group hauls.'
      : why === 'name' ? 'Type your name first.'
      : why === 'invite' ? 'That is not a RepHop invite. Ask your friend to press “Copy invite” again and send all of it.'
      : why === 'full' ? 'That haul is full (12 friends).'
      : why === 'ended' ? 'That live haul has ended.'
      : why === 'busy' ? 'You are already in a live haul. Leave or end it first.'
      : 'The relay could not be reached. Check your connection and try again.', { error: true });
    return null;
  }

  function liveScopes() {
    return [['*', 'Everything not bought yet']].concat(data.folders.map((f) => ['f:' + f, 'Folder: ' + f]));
  }

  function renderLive() {
    const g = data.group || {};
    const live = liveNow();
    $('#live-none').hidden = !!live;
    $('#live-host').hidden = !(live && live.role === 'host');
    $('#live-member').hidden = !(live && live.role === 'member');
    if (!live) {
      const nameBox = $('#live-name');
      if (nameBox !== document.activeElement && !nameBox.value) nameBox.value = g.me || '';
      const sel = $('#live-scope');
      if (sel !== document.activeElement) fillSelect(sel, liveScopes(), liveScopes().some(([v]) => v === sel.value) ? sel.value : '*');
      const pasted = $('#live-code').value.trim();
      const inv = pasted ? V.readInvite(pasted) : null;
      $('#live-join-info').textContent = !pasted ? '' : inv ? 'This is ' + (inv.name ? inv.name + '’s' : 'a') + ' haul, passed along by ' + new URL(inv.relay).host + '.' : 'That is not a RepHop invite.';
      return;
    }
    if (live.role === 'host') {
      const members = Object.entries(live.members || {});
      const inside = members.filter(([, m]) => m.status === 'ok').length;
      $('#live-host-text').textContent = 'Your live haul is on' + (liveUp ? '' : ' (connecting…)') + '. ' + (inside ? inside + (inside === 1 ? ' friend is' : ' friends are') + ' in.' : 'Nobody has joined yet.');
      $('#live-members').replaceChildren(...members.map(([id, m]) => {
        if (m.status === 'pending') {
          return h('li', {}, h('span', {}, m.name + ' wants to join'),
            h('button', { type: 'button', class: 'primary', onclick: () => liveDo({ op: 'approve', id, ok: true }, m.name + ' is in.') }, 'Let in'),
            h('button', { type: 'button', onclick: () => liveDo({ op: 'approve', id, ok: false }) }, 'Decline'));
        }
        if ((g.people || []).some((p) => p.live === id)) return null;
        return h('li', {}, h('span', {}, m.name + ' is in and has shared no items yet'),
          h('button', { type: 'button', class: 'danger', onclick: () => liveDo({ op: 'remove', id }) }, 'Remove'));
      }).filter(Boolean));
      return;
    }
    const host = live.host || 'the person ordering';
    const mine = Object.values(data.items).filter((it) => it.platform !== 'yupoo' && it.status !== 'bought' && (live.scope === '*' || it.folder === live.scope)).length;
    $('#live-member-text').textContent = live.status === 'gone' ? 'This live haul has ended, or you were taken out of it. Nothing more is shared.'
      : live.status === 'pending' ? 'Waiting for ' + host + ' to let you in. Only your name has been sent so far.'
      : 'You are in ' + host + '’s live haul' + (liveUp ? '' : ' (connecting…)') + '. ' + mine + (mine === 1 ? ' item is' : ' items are') + ' shared with them, and changes go out by themselves.';
    const note = live.status === 'ok' ? live.inbox : null;
    const money = (n) => (n == null ? '?' : U.money(n, note.cur));
    $('#live-note').textContent = !note ? '' : 'In ' + host + '’s cart: ' + note.marks.filter((x) => x[1] !== 'saved').length + ' of ' + note.marks.length + '. Your part: ' + U.yuan(note.yuan || 0) +
      (note.cur !== 'CNY' ? ' ≈ ' + money(note.items) : '') + (note.extra ? ' + ' + money(note.share) + ' of shipping and fees = ' + money(note.owes) : '') + '.';
    $('#live-scope-row').hidden = live.status === 'gone';
    const now = $('#live-scope-now');
    if (now !== document.activeElement) fillSelect(now, liveScopes(), live.scope === '*' ? '*' : 'f:' + live.scope);
    $('#live-leave').textContent = live.status === 'gone' ? 'OK' : live.status === 'pending' ? 'Cancel my request' : 'Leave this haul';
  }

  // -------------------------------------------------------------- settings

  function note(el, text) {
    el.textContent = text;
    el.hidden = !text;
  }

  function renderSettings() {
    const s = data.settings;
    fillSelect($('#s-agent'), Object.entries(L.AGENTS).map(([k, a]) => [k, a.name]), s.agent, 'Choose your agent…');
    for (const el of $$('[data-size]')) if (el !== document.activeElement) el.value = s.sizes[el.dataset.size] || '';
    fillSelect($('#s-qc'), Object.entries(L.QC_PROVIDERS).map(([k, a]) => [k, a.name]), s.qcProvider);
    const codes = Object.keys((data.rates && data.rates.rates) || U.FALLBACK_RATES).sort();
    const top = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CNY'].filter((c) => codes.includes(c) || c === 'CNY');
    fillSelect($('#s-currency'), top.concat(codes.filter((c) => !top.includes(c))).map((c) => [c, c]), s.currency);
    fillSelect($('#s-default-folder'), data.folders.map((f) => [f, f]), s.defaultFolder);
    fillSelect($('#paste-folder'), data.folders.map((f) => [f, f]), data.folders.includes($('#paste-folder').value) ? $('#paste-folder').value : s.defaultFolder);

    for (const el of $$('[data-setting]')) {
      if (el === document.activeElement) continue;
      const v = s[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    }
    for (const el of $$('[data-key]')) if (el !== document.activeElement) el.value = (s.keys[el.dataset.key] || '').toUpperCase();
    $('#custom-agent').hidden = s.agent !== 'custom';
    updateCustomAllow();
    $('#custom-qc').hidden = s.qcProvider !== 'custom';
    $('#keys').hidden = !s.hotkeysEnabled;

    const r = data.rates;
    const rate = U.convert(1, r, s.currency);
    note($('#rate-note'), s.currency === 'CNY' ? '' : '¥100 ≈ ' + U.money((rate || 0) * 100, s.currency) + (r && r.live ? ' · rate updated ' + new Date(r.at).toLocaleDateString() : ' · approximate rate (live rates not loaded yet)'));

    const st = data.syncState;
    note($('#sync-note'), !s.sync ? '' : !st ? 'Waiting for the first sync…' : st.error ? 'Sync problem: ' + st.error : 'Last synced ' + new Date(st.at).toLocaleString() + ' · ' + st.count + ' entries' + (st.dropped ? ' · ' + st.dropped + " oldest items didn't fit in browser sync" : ''));
    $('#sync-now').hidden = !s.sync;

    const row = (text, buttons) => h('li', {}, h('span', {}, text), buttons);
    const none = (text) => h('li', { class: 'none' }, text);

    $('#folder-list').replaceChildren(...data.folders.map((f) => {
      const li = row(f, [
        h('button', { type: 'button', onclick: () => {
          const input = h('input', { type: 'text', value: f, maxLength: 30, 'aria-label': 'New name for ' + f });
          const done = () => {
            const name = input.value.trim();
            if (!name || name === f || data.folders.includes(name)) return renderSettings();
            send({ type: 'folders', list: data.folders.map((x) => (x === f ? name : x)), renames: { [f]: name } });
            if (s.defaultFolder === f) send({ type: 'settings', patch: { defaultFolder: name } });
          };
          input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
          input.addEventListener('blur', done);
          li.firstChild.replaceWith(input);
          input.focus();
        } }, 'Rename'),
        data.folders.length > 1 && h('button', { type: 'button', class: 'danger', title: 'Items in it move to ' + data.folders.find((x) => x !== f),
          onclick: () => send({ type: 'folders', list: data.folders.filter((x) => x !== f) }) }, 'Delete'),
      ]);
      return li;
    }));

    const trustedSellers = Object.entries(data.sellers).filter(([, v]) => v.trusted);
    $('#seller-list').replaceChildren(...(trustedSellers.length ? trustedSellers.map(([k, v]) => row('★ ' + (v.name || k), h('button', { type: 'button', onclick: () => send({ type: 'seller', key: k, name: v.name, trusted: false }) }, 'Remove'))) : [none('No trusted sellers yet')]));

    $('#site-list').replaceChildren(...(s.extraSites.length ? s.extraSites.map((host) => row(host, h('button', { type: 'button', onclick: async () => {
      await chrome.permissions.remove({ origins: ['*://' + host + '/*', '*://*.' + host + '/*'] }).catch(() => {});
      send({ type: 'settings', patch: { extraSites: s.extraSites.filter((x) => x !== host) } });
    } }, 'Remove'))) : [none('No extra sites')]));

    for (const el of $$('[data-agent]')) el.textContent = agent.name;
    for (const el of $$('[data-keyname]')) el.textContent = (s.keys[el.dataset.keyname] || '').toUpperCase();
  }

  function customOrigin() {
    const s = data.settings;
    if (s.agent !== 'custom' || !L.validTemplate(s.customTemplate)) return null;
    const u = L.toUrl(s.customTemplate.replace(/\{[^}]+\}/g, 'x'));
    return u ? u.origin + '/*' : null;
  }

  /** Reusing one tab means checking what that tab shows, which needs access to the custom agent's site. */
  async function updateCustomAllow() {
    const origin = customOrigin();
    const has = origin ? await chrome.permissions.contains({ origins: [origin] }).catch(() => false) : true;
    $('#custom-allow-row').hidden = has;
  }

  async function renderCommands() {
    const box = $('#commands');
    const cmds = await chrome.commands.getAll().catch(() => []);
    box.replaceChildren(...cmds.filter((c) => c.description).flatMap((c) => [
      c.shortcut ? h('kbd', {}, c.shortcut) : h('span', { class: 'none' }, 'not set'),
      h('span', {}, c.description),
    ]));
  }

  // ---------------------------------------------------------------- render

  let renderTimer = null;
  let deferred = false;

  function editing() {
    const a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'search' && a.closest('.editor, #view-settings, #view-setup, #g-add-box, #g-share-box, #live'));
  }

  function render() {
    // Each part draws on its own, so a problem in one never leaves the other empty.
    for (const part of [renderList, renderSettings, renderSetup, renderGroup]) {
      try {
        part();
      } catch (e) {
        console.error('RepHop: render failed', e);
      }
    }
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      // Don't yank a field out from under someone who is typing in it.
      if (editing()) {
        deferred = true;
        return;
      }
      render();
    }, 60);
  }

  document.addEventListener('focusout', () => {
    if (!deferred) return;
    deferred = false;
    scheduleRender();
  });

  function show(name) {
    view.name = name;
    document.body.classList.toggle('in-setup', name === 'setup');
    for (const sec of $$('main > section')) sec.hidden = sec.id !== 'view-' + name;
    for (const b of $$('.tabs button')) {
      b.classList.toggle('on', b.dataset.view === name);
      b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
    }
    if (name === 'settings') renderCommands();
    if (name === 'group') renderGroup();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- events

  function patch(p) {
    return send({ type: 'settings', patch: p });
  }

  function wire() {
    for (const b of $$('.tabs button')) b.addEventListener('click', () => show(b.dataset.view));
    for (const b of $$('[data-goto]')) b.addEventListener('click', () => show(b.dataset.goto));

    $('#q-hijack').addEventListener('change', (e) => patch({ clickHijack: e.target.checked }));
    const pickAgent = async (id) => {
      await patch({ agent: id });
      if (id === 'custom') {
        show('settings');
        toast('Enter your agent’s link template below.');
      }
    };
    $('#q-agent').addEventListener('change', (e) => pickAgent(e.target.value));
    $('#pick-grid').replaceChildren(
      ...Object.entries(L.AGENTS).filter(([k]) => k !== 'custom').map(([k, a]) => h('button', { type: 'button', onclick: () => pickAgent(k) }, a.name)),
      h('button', { type: 'button', onclick: () => pickAgent('custom') }, 'Other…'));
    $('#theme-toggle').addEventListener('click', () => patch({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }));
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
    $('#cart-summary-close').addEventListener('click', () => chrome.storage.local.remove('cartRun'));
    $('#this-tab-save').addEventListener('click', async () => {
      if (!thisTab) return;
      // Ask the page itself to save (it also knows which colour and size are picked there); fall back to the plain address.
      const viaPage = await chrome.tabs.sendMessage(thisTab.id, { type: 'saveThis' }).catch(() => null);
      if (viaPage && viaPage.handled) return;
      const r = await send({ type: 'save', url: thisTab.url, ctx: { site: U.hostOf(thisTab.url), postTitle: thisTab.title, postUrl: thisTab.url } });
      toast(r ? r.message : 'Something went wrong.', { error: !r || !r.ok });
    });
    chrome.tabs.onActivated.addListener(refreshThisTab);
    chrome.tabs.onUpdated.addListener((id, info) => (info.url || info.status === 'complete') && refreshThisTab());
    if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(refreshThisTab);
    refreshThisTab();
    $('#q-mode').addEventListener('change', (e) => patch({ openMode: e.target.value }));
    $('#search').addEventListener('input', (e) => { view.q = e.target.value; view.limit = 120; renderList(); });
    $('#sort').addEventListener('change', (e) => { view.sort = e.target.value; try { localStorage.setItem('rhSort', view.sort); } catch (_) { /* private mode */ } renderList(); });
    $('#f-status').addEventListener('change', (e) => { view.status = e.target.value; renderList(); });
    $('#filters-clear').addEventListener('click', () => {
      view.status = view.tag = view.seller = '';
      $('#filters').open = false;
      renderList();
    });
    $('#f-tag').addEventListener('change', (e) => { view.tag = e.target.value; renderList(); });
    $('#f-seller').addEventListener('change', (e) => { view.seller = e.target.value; renderList(); });
    $('#clear-filters').addEventListener('click', () => {
      Object.assign(view, { folder: '*', status: '', tag: '', seller: '', q: '' });
      $('#search').value = '';
      renderList();
    });
    $('#show-more').addEventListener('click', () => { view.limit += 120; renderList(); });
    $('#select-all').addEventListener('click', () => {
      if (view.selected.size) view.selected.clear();
      else for (const it of visible()) view.selected.add(it.key);
      renderList();
    });

    $('#start-queue').addEventListener('click', async () => {
      const keys = scope().list.map((it) => it.key);
      const r = await send({ type: 'queue', op: 'start', keys });
      if (r && r.reason === 'no-agent') return needAgent();
      if (!r || !r.ok) toast("Couldn't start. Is the list empty?", { error: true });
      else toast('Going through ' + keys.length + ' items. Use Next on the page or here.');
    });
    const step = async (delta) => {
      const q = data.queue;
      // In an add-to-cart run, moving on from here means leaving the current item out.
      const result = q && q.auto && delta > 0 ? { key: q.keys[q.i], r: 'skipped' } : undefined;
      const r = await send({ type: 'queue', op: 'step', delta, result, at: q ? q.i : undefined });
      if (r && r.finished && !r.summary) toast('That was the last one.');
    };
    $('#queue-next').addEventListener('click', () => step(1));
    $('#queue-prev').addEventListener('click', () => step(-1));
    $('#queue-stop').addEventListener('click', () => send({ type: 'queue', op: 'stop' }));

    $('#bulk-move').addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const keys = scope().list.map((it) => it.key);
      await send({ type: 'update', keys, patch: { folder: e.target.value } });
      toast('Moved ' + keys.length + ' to ' + e.target.value + '.');
      view.selected.clear();
    });
    $('#bulk-tag').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const input = h('input', { type: 'text', placeholder: 'tag, another tag', 'aria-label': 'Tags to add to the selected items' });
      const done = async () => {
        const tags = U.normalizeTags(input.value);
        input.replaceWith(btn);
        if (!tags.length) return;
        const keys = scope().list.map((it) => it.key);
        await send({ type: 'update', keys, patch: { addTags: tags } });
        toast('Tagged ' + keys.length + ' items.');
      };
      input.addEventListener('keydown', (ev) => ev.key === 'Enter' && input.blur());
      input.addEventListener('blur', done);
      btn.replaceWith(input);
      input.focus();
    });
    $('#bulk-clear').addEventListener('click', () => { view.selected.clear(); renderList(); });
    $('#bulk-cart').addEventListener('click', () => startCart(scope().list));
    $('#bulk-mark').addEventListener('click', () => markAs(scope().list.map((it) => it.key), 'carted', { all: true }));
    $('#bulk-delete').addEventListener('click', (e) => {
      const keys = visible().filter((it) => view.selected.has(it.key)).map((it) => it.key);
      if (!keys.length) return;
      // A handful goes straight away (Undo is offered); a big batch asks once more first.
      if (keys.length <= 5) return removeKeys(keys);
      confirmClick(e.currentTarget, 'Delete ' + keys.length + '? Click again', () => removeKeys(keys));
    });

    $('#more').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-do]');
      if (!btn) return;
      const act = btn.dataset.do;
      const list = scope().list;
      const s = data.settings;
      const close = () => ($('#more').open = false);
      if (!list.length) return close();
      if (act === 'delete') return confirmClick(btn, 'Really delete ' + list.length + '? Click again', () => { close(); removeKeys(list.map((it) => it.key)); });
      if (act === 'open-all') {
        const go = async () => {
          close();
          for (const it of list.slice(0, 40)) await send({ type: 'open', key: it.key, disposition: 'group' });
          toast('Opened ' + Math.min(40, list.length) + ' tabs in a group.' + (list.length > 40 ? ' (Limit is 40 at a time.)' : ''));
        };
        return list.length > 8 ? confirmClick(btn, 'Open ' + Math.min(40, list.length) + ' tabs? Click again', go) : go();
      }
      if (act === 'share') {
        close();
        gv.box = 'share';
        show('group');
        return;
      }
      if (act === 'mark') {
        const go = () => {
          close();
          markAs(list.map((it) => it.key), 'carted', { all: true });
        };
        return !view.selected.size && list.length > 5 ? confirmClick(btn, 'Mark all ' + list.length + ' shown? Click again', go) : go();
      }
      if (act === 'cart') {
        // With nothing ticked this would run over everything shown, so a long list asks once more.
        const go = () => {
          close();
          startCart(list);
        };
        return !view.selected.size && list.length > 5 ? confirmClick(btn, 'Add all ' + list.length + ' shown? Click again', go) : go();
      }
      close();
      if (act === 'check') {
        // Sent in batches, so a long list is checked in full and the count below is honest.
        const r = { checked: 0, skipped: 0, live: 0, soldout: 0, gone: 0, unknown: 0 };
        const batches = U.chunkArray(list.map((it) => it.key), 100);
        for (let i = 0; i < batches.length; i++) {
          toast('Checking ' + Math.min((i + 1) * 100, list.length) + ' of ' + list.length + '…');
          const part = await send({ type: 'refresh', keys: batches[i] });
          if (!part) return toast('Checking stopped. Try again.', { error: true });
          for (const k of Object.keys(r)) r[k] += part[k] || 0;
        }
        const parts = [r.live + ' available'];
        if (r.soldout) parts.push(r.soldout + ' sold out');
        if (r.gone) parts.push(r.gone + ' removed');
        if (r.unknown) parts.push(r.unknown + " couldn't be checked");
        toast((r.checked ? parts.join(' · ') : 'Nothing here can be checked automatically') + (r.skipped ? ' · ' + r.skipped + ' Taobao/1688 items skipped (those can only be checked by opening them)' : ''));
      } else if (act === 'copy-text') copy(U.toText(list, 'text', s), list.length + ' items');
      else if (act === 'copy-md') copy(U.toText(list, 'markdown', s), list.length + ' items as markdown');
      else if (act === 'copy-links') copy(U.toText(list, 'links', s), list.length + ' links');
      else if (act === 'csv') download('rephop-' + new Date().toISOString().slice(0, 10) + '.csv', U.toCsv(list, s, data.rates), 'text/csv;charset=utf-8');
    });
    document.addEventListener('click', (e) => {
      if ($('#more').open && !e.target.closest('#more')) $('#more').open = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('#more').open) $('#more').open = false;
        else if (view.openKey && view.name === 'list') { view.openKey = null; render(); }
      } else if (e.key === '/' && view.name === 'list' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        $('#search').focus();
      }
    });

    // ---- welcome screen
    $('#setup-done').addEventListener('click', async () => {
      if (!data.settings.agent) return toast('Pick your shopping agent first (step 1).', { error: true });
      await patch({ setupDone: true });
      if (data.settings.agent === 'custom' && !L.validTemplate(data.settings.customTemplate)) {
        show('settings');
        toast('Enter your agent’s link template below.');
        $('#s-template').focus();
      } else show('list');
    });
    $('#setup-skip').addEventListener('click', async () => {
      await patch({ setupDone: true });
      show('list');
    });
    $('#setup-again').addEventListener('click', () => show('setup'));

    // ---- group haul
    const openBox = (name, focus) => {
      gv.box = gv.box === name ? '' : name;
      renderGroup();
      if (gv.box) $(focus).focus();
    };
    $('#g-share').addEventListener('click', () => openBox('share', '#g-me'));
    $('#g-add').addEventListener('click', () => openBox('add', '#g-code'));
    $('#g-share-close').addEventListener('click', () => openBox(gv.box));
    $('#g-add-close').addEventListener('click', () => openBox(gv.box));
    $('#g-scope').addEventListener('change', renderGroup);
    const shareCode = async () => {
      const name = $('#g-me').value.replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!name) {
        toast('Type your name first, so whoever is ordering knows whose list this is.', { error: true });
        $('#g-me').focus();
        return null;
      }
      const chosen = shareChoice();
      if (!chosen || !chosen[2].length) return toast('There is nothing to share yet.', { error: true }), null;
      const mine = await send({ type: 'group', op: 'set', patch: { me: name } });
      const obj = U.packShare(name, chosen[2], data.settings, mine && mine.sid);
      return { name, count: obj.items.length, code: await U.encodeShare(obj) };
    };
    $('#g-copy').addEventListener('click', async () => {
      const r = await shareCode();
      if (!r) return;
      try {
        await navigator.clipboard.writeText(r.code);
        toast('Share code copied (' + r.count + (r.count === 1 ? ' item' : ' items') + '). Paste it to whoever is ordering.');
      } catch (_) {
        toast("Couldn't copy. Use “Save as a file” instead.", { error: true });
      }
    });
    $('#g-file').addEventListener('click', async () => {
      const r = await shareCode();
      if (r) download('rephop-haul-' + (r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'list') + '.txt', r.code, 'text/plain;charset=utf-8');
    });
    const addShared = async (text) => {
      const shared = await U.decodeShare(text);
      if (!shared) return toast('That is not a RepHop share code. Ask your friend to press “Copy share code” again and send all of it.', { error: true });
      if (!shared.items.length) return toast('That list is empty.', { error: true });
      if (!shared.name) shared.name = 'Friend';
      const r = await send({ type: 'group', op: 'add', person: shared });
      if (!r || !r.ok) return toast(r && r.reason === 'full' ? 'A group haul holds up to 12 friends. Remove one first.' : "Couldn't add that list.", { error: true });
      $('#g-code').value = '';
      gv.box = '';
      toast((r.replaced ? 'Updated ' : 'Added ') + r.name + '’s list: ' + r.count + (r.count === 1 ? ' item.' : ' items.') + (r.kept ? ' ' + r.kept + ' already in the cart ' + (r.kept === 1 ? 'stays' : 'stay') + ' marked.' : ''), r.replaced ? { action: { label: 'Undo', fn: () => send({ type: 'group', op: 'restore', person: r.replaced }) } } : null);
      renderGroup();
    };
    $('#g-import').addEventListener('click', () => {
      if (!$('#g-code').value.trim()) return toast('Paste the share code first.', { error: true });
      addShared($('#g-code').value);
    });
    $('#g-open').addEventListener('click', () => $('#g-open-file').click());
    $('#g-open-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 2e6) return toast('That file is too big to be a share code.', { error: true });
      addShared(await file.text());
    });
    $('#g-mine').addEventListener('change', (e) => send({ type: 'group', op: 'set', patch: { mine: e.target.value.replace(/^f:/, '') } }));
    $('#g-extra').addEventListener('change', (e) => send({ type: 'group', op: 'set', patch: { extra: e.target.value } }));
    $('#g-split').addEventListener('change', (e) => send({ type: 'group', op: 'set', patch: { split: e.target.value } }));
    for (const b of $$('[data-gview]')) b.addEventListener('click', () => { gv.mode = b.dataset.gview; renderGroup(); });
    $('#g-cart').addEventListener('click', (e) => {
      const entries = [];
      for (const p of groupPeople()) for (const it of p.items) if (it.status !== 'carted' && it.status !== 'bought') entries.push(entryFor(p, it));
      const go = () => groupCart(entries, entries.length + ' items');
      return entries.length > 5 ? confirmClick(e.currentTarget, 'Add all ' + entries.length + '? Click again', go) : go();
    });
    $('#g-summary').addEventListener('click', () => {
      const g = data.group || {};
      copy(groupSummary(U.groupTotals(groupPeople(), data.rates, data.settings.currency, g.extra || 0, g.split, data.settings), g.split), 'who owes what');
    });
    $('#g-run-skip').addEventListener('click', () => step(1));
    $('#g-run-stop').addEventListener('click', () => send({ type: 'queue', op: 'stop' }));

    // ---- live haul
    const liveName = () => $('#live-name').value.replace(/\s+/g, ' ').trim().slice(0, 30);
    const copyInvite = async (invite, said) => {
      try {
        await navigator.clipboard.writeText(invite);
        toast(said);
      } catch (_) {
        toast("Couldn't copy the invite. Click inside the list and press Copy invite again.", { error: true });
      }
    };
    $('#live-start').addEventListener('click', async () => {
      if (!liveName()) {
        toast('Type your name first, so your friends know whose haul it is.', { error: true });
        return void $('#live-name').focus();
      }
      const r = await liveDo({ op: 'host', name: liveName() });
      if (r) copyInvite(r.invite, 'Live haul started. The invite is copied: send it to the friends you are ordering for.');
    });
    $('#live-copy').addEventListener('click', async () => {
      const r = await liveDo({ op: 'invite' });
      if (r) copyInvite(r.invite, 'Invite copied.');
    });
    $('#live-end').addEventListener('click', (e) => confirmClick(e.currentTarget, 'End it for everyone? Click again', () => liveDo({ op: 'end' }, 'Live haul ended. The lists you already have stay here.')));
    $('#live-join-open').addEventListener('click', () => {
      $('#live-join-box').hidden = !$('#live-join-box').hidden;
      if (!$('#live-join-box').hidden) $('#live-code').focus();
    });
    $('#live-code').addEventListener('input', renderLive);
    $('#live-join').addEventListener('click', async () => {
      if (!liveName()) {
        toast('Type your name first, so the person ordering knows who is asking.', { error: true });
        return void $('#live-name').focus();
      }
      if (!$('#live-code').value.trim()) return toast('Paste the invite first.', { error: true });
      const r = await liveDo({ op: 'join', invite: $('#live-code').value, name: liveName(), scope: $('#live-scope').value.replace(/^f:/, '') });
      if (!r) return;
      $('#live-code').value = '';
      $('#live-join-box').hidden = true;
      toast('Asked to join' + (r.host ? ' ' + r.host + '’s haul' : '') + '. Your items are shared once they let you in.');
    });
    $('#live-scope-now').addEventListener('change', (e) => liveDo({ op: 'scope', scope: e.target.value.replace(/^f:/, '') }));
    $('#live-leave').addEventListener('click', () => liveDo({ op: 'leave' }));
    // The connection normally says when something changed; this is the fallback for when it is down.
    setInterval(() => liveWanted() && send({ type: 'live', op: 'sync' }), 60000);

    // ---- add
    const found = () => L.extractLabeled($('#paste').value);
    $('#paste').addEventListener('input', () => {
      const n = found().length;
      $('#paste-found').textContent = $('#paste').value.trim() ? (n ? n + ' product link' + (n === 1 ? '' : 's') + ' found' : 'No product links recognised yet') : '';
    });
    $('#paste-add').addEventListener('click', async (e) => {
      const hits = found();
      if (!hits.length) return toast('No product links found in that text.', { error: true });
      e.target.disabled = true;
      const folder = $('#paste-folder').value;
      const sum = { added: 0, duplicates: 0, failed: 0, noBuyLink: 0, pending: 0 };
      let done = 0;
      let broke = false;
      for (const batch of U.chunkArray(hits, 40)) {
        $('#paste-found').textContent = 'Adding ' + Math.min(done + batch.length, hits.length) + ' of ' + hits.length + '… (Yupoo albums take a moment each)';
        const r = await send({ type: 'saveMany', entries: batch.map((x) => ({ url: x.parsed.url, label: x.label })), folder });
        if (!r) {
          broke = true;
          break;
        }
        for (const k of Object.keys(sum)) sum[k] += r[k] || 0;
        if (r.reason) sum.reason = r.reason;
        if (r.title) sum.title = r.title;
        done += batch.length;
      }
      e.target.disabled = false;
      $('#paste-found').textContent = '';
      if (broke && !done) return toast('Something went wrong. Try again.', { error: true });
      toast(U.describeSave(sum) + (broke ? ' · stopped after ' + done + ' of ' + hits.length : ''), { error: !(sum.added || sum.duplicates) });
      if (sum.added || sum.duplicates) {
        $('#paste').value = '';
        show('list');
      }
    });
    for (const id of ['#add-cart', '#empty-cart']) {
      $(id).addEventListener('click', async () => {
        const r = await send({ type: 'importCartTab' });
        if (r && r.ok) toast('Opening your Superbuy cart. RepHop copies it in once it shows.');
      });
    }
    $('#add-tab').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      if (!tab || !tab.url) return toast('RepHop can only see product pages. Open one, or use the button in its corner.', { error: true });
      if (!L.parseLink(tab.url)) return toast("The current tab isn't a product page RepHop can read.", { error: true });
      const r = await send({ type: 'save', url: tab.url, ctx: { site: U.hostOf(tab.url), postTitle: tab.title || '', postUrl: tab.url } });
      toast(r ? r.message : 'Something went wrong.', { error: !r || !r.ok });
      if (r && r.ok) show('list');
    });

    // ---- settings
    for (const el of $$('[data-setting]')) {
      el.addEventListener('change', () => {
        const key = el.dataset.setting;
        const value = el.type === 'checkbox' ? el.checked : el.value.trim();
        if (key === 'relay' && value && !V.relayUrl(value)) {
          toast('A relay address looks like https://rephop-relay.your-name.workers.dev', { error: true });
          return;
        }
        if (key === 'relay') return void patch({ relay: V.relayUrl(value) });
        if ((key === 'customTemplate' || key === 'qcTemplate') && value && !L.validTemplate(value)) {
          toast('That template needs to start with https:// and contain {url} or {id}.', { error: true });
          return;
        }
        patch({ [key]: value });
      });
    }
    for (const el of $$('[data-size]')) {
      el.addEventListener('change', () => {
        const sizes = Object.assign({}, data.settings.sizes);
        for (const x of $$('[data-size]', el.closest('.sizes'))) sizes[x.dataset.size] = x.value.trim().slice(0, 30);
        patch({ sizes });
      });
    }
    for (const el of $$('[data-key]')) {
      el.addEventListener('input', () => {
        const k = el.value.slice(-1).toLowerCase();
        const keys = Object.assign({}, data.settings.keys);
        if (!/^[a-z0-9]$/.test(k)) return void (el.value = (keys[el.dataset.key] || '').toUpperCase());
        const clash = Object.keys(keys).find((name) => name !== el.dataset.key && keys[name] === k);
        if (clash) {
          toast(k.toUpperCase() + ' is already used. Pick another key.', { error: true });
          return void (el.value = (keys[el.dataset.key] || '').toUpperCase());
        }
        keys[el.dataset.key] = k;
        el.value = k.toUpperCase();
        patch({ keys });
      });
    }
    $('#edit-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
    $('#custom-allow').addEventListener('click', async () => {
      const origin = customOrigin();
      if (!origin) return;
      const ok = await chrome.permissions.request({ origins: [origin] }).catch(() => false);
      toast(ok ? 'Done. Listings will reuse one tab.' : 'Not allowed, so each listing will open in a new tab.', { error: !ok });
      updateCustomAllow();
    });
    $('#clear-history').addEventListener('click', (e) => confirmClick(e.currentTarget, 'Clear viewed marks and cached previews? Click again', async () => {
      const r = await send({ type: 'clearHistory' });
      toast(r && r.ok ? 'History cleared. Your list was not touched.' : 'Something went wrong.', { error: !(r && r.ok) });
    }));

    const addFolder = () => {
      const name = $('#folder-new').value.trim().slice(0, 30);
      if (!name) return;
      if (data.folders.includes(name)) return toast('You already have a folder with that name.', { error: true });
      send({ type: 'folders', list: data.folders.concat(name) });
      $('#folder-new').value = '';
    };
    $('#folder-add').addEventListener('click', addFolder);
    $('#folder-new').addEventListener('keydown', (e) => e.key === 'Enter' && addFolder());

    const addSeller = () => {
      const raw = $('#seller-new').value.trim();
      const name = (L.yupooUser(raw) || raw.replace(/^@/, '')).toLowerCase();
      if (!/^[a-z0-9._-]{2,60}$/.test(name)) return toast('Enter a Yupoo username, like “singor”, or paste the seller’s Yupoo link.', { error: true });
      send({ type: 'seller', key: 'yupoo:' + name, name, trusted: true });
      $('#seller-new').value = '';
    };
    $('#seller-add').addEventListener('click', addSeller);
    $('#seller-new').addEventListener('keydown', (e) => e.key === 'Enter' && addSeller());

    const addSite = async () => {
      const u = L.toUrl($('#site-new').value.trim());
      const host = u ? u.hostname.replace(/^www\./, '') : '';
      if (!host) return toast('Enter a site address, like example.com.', { error: true });
      // Must be the first await: the browser only shows its permission prompt straight from a click.
      const ok = await chrome.permissions.request({ origins: ['*://' + host + '/*', '*://*.' + host + '/*'] }).catch(() => false);
      if (!ok) return toast('Permission was not granted, so the site was not added.', { error: true });
      const sites = data.settings.extraSites.filter((x) => x !== host).concat(host);
      await patch({ extraSites: sites });
      $('#site-new').value = '';
      toast('Added. Reload ' + host + ' to see the buttons.');
    };
    $('#site-add').addEventListener('click', addSite);
    $('#site-new').addEventListener('keydown', (e) => e.key === 'Enter' && addSite());

    $('#sync-now').addEventListener('click', async () => {
      const r = await send({ type: 'syncNow' });
      toast(r && r.ok ? 'Synced.' : 'Sync failed' + (r && r.reason ? ': ' + r.reason : '.'), { error: !(r && r.ok) });
    });
    $('#backup-export').addEventListener('click', () => {
      const backup = { app: 'RepHop', version: 1, exportedAt: new Date().toISOString(), items: Object.values(data.items), folders: data.folders, sellers: data.sellers };
      download('rephop-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(backup, null, 1), 'application/json');
    });
    $('#backup-import').addEventListener('click', () => $('#backup-file').click());
    $('#backup-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        if (file.size > 20e6) throw new Error('too big');
        const parsed = JSON.parse(await file.text());
        if (!parsed || !(Array.isArray(parsed.items) || typeof parsed.items === 'object')) throw new Error('shape');
        const r = await send({ type: 'importData', data: parsed });
        toast(r && r.ok ? 'Imported ' + r.count + ' new or newer items.' : 'Import failed.', { error: !(r && r.ok) });
      } catch (_) {
        toast("That file isn't a RepHop backup.", { error: true });
      }
    });
    $('#wipe').addEventListener('click', (e) => confirmClick(e.currentTarget, 'Really delete all ' + Object.keys(data.items).length + ' items? Click again', () => removeKeys(Object.keys(data.items))));
  }

  // ------------------------------------------------------------- self-update
  // Chrome keeps running the copy of an unpacked extension it loaded, even after the files in its folder
  // are replaced: the background and the page scripts stay old until the extension is reloaded. This
  // page is the one part Chrome always reads fresh, so it is the part that notices and restarts the rest.

  async function staleBuild() {
    let disk = '';
    try {
      disk = (await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json()).version || '';
    } catch (_) {
      /* unreadable: fall back on asking the background */
    }
    if (disk && disk !== chrome.runtime.getManifest().version) return true;
    // An older background does not know this question and answers nothing. Ask twice: it may just be waking up.
    for (let i = 0; i < 2; i++) {
      const res = await send({ type: 'version' });
      if (res && res.build === U.BUILD) return false;
      await new Promise((r) => setTimeout(r, 600));
    }
    return true;
  }

  async function checkBuild() {
    if (!(await staleBuild())) {
      try {
        localStorage.removeItem('rhRestartAt');
      } catch (_) {
        /* private mode */
      }
      return;
    }
    let last = 0;
    try {
      last = Number(localStorage.getItem('rhRestartAt')) || 0;
      // Restart once by itself; if that did not help within two minutes, say so instead of looping.
      if (Date.now() - last > 120000) {
        localStorage.setItem('rhRestartAt', String(Date.now()));
        chrome.runtime.reload();
        return;
      }
    } catch (_) {
      /* fall through to the banner */
    }
    $('#stale').hidden = false;
  }

  // ------------------------------------------------------------------ boot

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const fresh = {};
    for (const k of KEYS) if (changes[k]) fresh[k] = changes[k].newValue;
    if (!Object.keys(fresh).length) return;
    absorb(fresh);
    scheduleRender();
  });

  (async () => {
    try {
      view.sort = localStorage.getItem('rhSort') || 'new';
    } catch (_) {
      /* private mode */
    }
    absorb(await chrome.storage.local.get(KEYS));
    wire();
    render();
    const want = new URLSearchParams(location.search).get('view');
    if (want && $('#view-' + want)) show(want);
    else if (!data.settings.setupDone) show('setup');
    send({ type: 'rates' });
    $('#stale-restart').addEventListener('click', () => chrome.runtime.reload());
    $('#build').textContent = 'RepHop ' + U.BUILD;
    $('#relay-default').textContent = U.DEFAULT_RELAY ? new URL(U.DEFAULT_RELAY).host : 'none in this copy';
    checkBuild();
  })();
})();
