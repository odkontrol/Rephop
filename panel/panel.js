/*
 * RepHop side panel: the saved list, the paste box, settings and help.
 * Reads storage directly and re-renders when it changes; every write is a message to the service worker.
 */
(() => {
  'use strict';

  const L = self.RepLinks;
  const U = self.RepUtil;
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

  const KEYS = ['items', 'settings', 'folders', 'sellers', 'seen', 'rates', 'queue', 'syncState', 'cartRun'];
  const data = { items: {}, settings: U.mergeSettings(), folders: U.DEFAULT_FOLDERS.slice(), sellers: {}, seen: {}, rates: null, queue: null, syncState: null, cartRun: null };
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
    b.textContent = dark ? '☀' : '☾';
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
    $('#q-agent').focus();
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

  function thumb(it) {
    const short = (L.PLATFORMS[it.platform] || {}).short || '?';
    const btn = h('button', { class: 'thumb', type: 'button', title: 'Open in ' + agent.name, onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) });
    if (it.image && /^https:\/\//.test(it.image)) {
      const img = h('img', { alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
      // Ask the picture host for a small version (originals can be megabytes); fall back to the original, then to a text tile.
      const small = U.thumbUrl(it.image, 160) || it.image;
      img.addEventListener('error', () => {
        if (img.src !== it.image && !img.dataset.retried) {
          img.dataset.retried = '1';
          img.src = it.image;
        } else img.replaceWith(short);
      });
      img.src = small;
      btn.append(img);
    } else btn.textContent = short;
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
      meta.append(h('span', { class: 'price' }, U.yuan(it.price) + ((it.qty || 1) > 1 ? ' × ' + it.qty : '')));
      if (conv != null && s.currency !== 'CNY') meta.append(h('span', {}, '≈ ' + U.money(conv * (it.qty || 1), s.currency)));
    }
    meta.append(h('span', { class: 'badge', title: it.url }, (L.PLATFORMS[it.platform] || {}).label || it.platform));
    if (it.platform === 'yupoo') {
      meta.append(it.pending
        ? h('span', { class: 'badge', title: "Yupoo didn't answer when this was saved. Open Edit and press Find buy link." }, 'Buy link not checked')
        : h('span', { class: 'badge bad', title: 'The seller put no Weidian or Taobao link on this album' }, 'No buy link'));
    }
    if (it.status === 'carted') meta.append(h('span', { class: 'badge good' }, 'In cart'));
    if (it.status === 'bought') meta.append(h('span', { class: 'badge good' }, 'Bought'));
    if (state === 'soldout') meta.append(h('span', { class: 'badge bad' }, 'Sold out'));
    if (state === 'gone') meta.append(h('span', { class: 'badge bad', title: 'Weidian no longer lists this item' }, 'Removed?'));
    if (it.seller) meta.append(h('span', { class: 'badge' + (trusted(it) ? ' gold' : ''), title: trusted(it) ? 'Trusted seller' : 'Seller' }, (trusted(it) ? '★ ' : '') + sellerName(it.seller)));
    if (seen > 1) meta.append(h('span', { class: 'badge gold', title: 'You have seen this link in ' + seen + ' different posts' }, '×' + seen + ' posts'));
    const chosen = (it.options || []).map((o) => o.v).concat((it.options || []).length ? [] : [it.style, it.size].filter(Boolean));
    if (chosen.length) meta.append(h('span', { class: 'badge', title: (it.options || []).length ? 'What you picked on the listing. When RepHop adds this to your cart it looks for the same; if that is sold out or gone, it asks you.' : 'What RepHop will look for when it adds this to your cart' }, chosen.join(' · ')));

    const info = h('div', { class: 'info' },
      h('button', { class: 'title', type: 'button', title: 'Open in ' + agent.name, onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) }, U.displayTitle(it)),
      meta);
    if (src) {
      const where = U.sourceText(src) || 'source';
      const url = L.toUrl(src.commentUrl || src.postUrl);
      info.append(h('div', { class: 'src' }, url ? h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer', title: 'Open where you found it' }, 'from ' + where) : 'from ' + where));
    }
    if ((it.tags && it.tags.length) || it.note) {
      info.append(h('div', { class: 'note' }, (it.tags || []).map((t) => h('span', { class: 'tag' }, '#' + t)), it.note || ''));
    }

    const bought = it.status === 'bought';
    const cartOn = it.status === 'carted';
    const acts = h('div', { class: 'acts' },
      h('button', { class: 'go primary', type: 'button', onclick: (e) => openItem(it, e), onauxclick: (e) => e.button === 1 && openItem(it, e) }, it.platform === 'yupoo' ? 'Open album' : 'Open in ' + agent.name),
      it.platform !== 'yupoo' && h('button', { type: 'button', title: 'Look for QC photos of this item', onclick: () => send({ type: 'openTab', url: L.qcUrl(it, s) }) }, 'QC'),
      h('button', { type: 'button', class: cartOn || bought ? 'on' : '', title: bought ? 'Marked as bought. Change the status under Edit.' : cartOn ? 'Marked as in cart. Click to unmark.' : 'Mark as added to cart', 'aria-pressed': String(cartOn || bought),
        onclick: () => (bought ? toast('This one is marked as bought. Change the status under Edit.') : send({ type: 'update', keys: [it.key], patch: { status: cartOn ? 'saved' : 'carted' } })) }, bought ? '✓ Bought' : cartOn ? '✓ Cart' : 'Cart'),
      h('button', { type: 'button', title: 'Edit, tag, move or delete', 'aria-expanded': String(isOpen), onclick: () => { view.openKey = isOpen ? null : it.key; render(); } }, isOpen ? 'Close' : 'Edit'));

    const li = h('li', { class: 'item' + (it.viewedAt ? ' viewed' : '') + (inQueue ? ' current' : '') },
      h('button', { type: 'button', class: 'x', title: 'Delete from your list (you can undo)', 'aria-label': 'Delete ' + U.displayTitle(it), onclick: () => removeKeys([it.key]) }, '×'),
      h('div', { class: 'main' },
        h('input', { type: 'checkbox', class: 'pick', checked: view.selected.has(it.key), 'aria-label': 'Select ' + U.displayTitle(it),
          onchange: (e) => { e.target.checked ? view.selected.add(it.key) : view.selected.delete(it.key); renderChrome(); } }),
        thumb(it), info),
      acts);
    li.dataset.key = it.key;
    if (isOpen) li.append(editor(it));
    return li;
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
      h('option', { value: '' }, guess ? 'Work it out (' + short(guess).toLowerCase() + ')' : 'Work it out'),
      Object.keys(U.KINDS).map((k) => h('option', { value: k }, short(k))),
      h('option', { value: 'other' }, 'Something else'));
    kindSel.value = it.kind || '';
    const mine = U.sizeFor(Object.assign({}, it, { size: '' }), data.settings);

    const box = h('div', { class: 'editor' },
      field('Name', h('input', { type: 'text', value: U.displayTitle(it), maxLength: 200, onchange: (e) => save({ customTitle: e.target.value.trim() }) }), true),
      field('Price (¥)', h('input', { type: 'number', min: '0', step: '0.01', value: it.price == null ? '' : String(it.price), onchange: (e) => save({ price: e.target.value }) })),
      field('Quantity', h('input', { type: 'number', min: '1', max: '99', step: '1', value: String(it.qty || 1), onchange: (e) => save({ qty: e.target.value }) })),
      field('Folder', folderSel),
      field('Status', statusSel),
      field('Type (decides which of your sizes is used)', kindSel),
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

  /** "Add to cart for me": hand the items to the queue in automatic mode. */
  async function startCart(list) {
    const items = list.filter((it) => it.platform !== 'yupoo' && it.status === 'saved');
    const left = list.length - items.length;
    if (!items.length) return toast(left ? 'Nothing to add: these are already in your cart or bought, or are albums with no listing.' : 'Select some items first.', { error: true });
    const r = await send({ type: 'queue', op: 'start', keys: items.map((it) => it.key), auto: true });
    if (r && r.reason === 'no-agent') return needAgent();
    if (!r || !r.ok) return toast("Couldn't start.", { error: true });
    view.selected.clear();
    toast('Adding ' + items.length + ' to your cart at ' + agent.name + (left ? ' (' + left + ' left out: already in cart, bought, or no listing)' : '') + '. Keep an eye on that tab: RepHop asks there when it needs you.');
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
    for (const it of sc.list) {
      if (it.price == null) unpriced++;
      else sum += it.price * (it.qty || 1);
    }
    const conv = U.convert(sum, data.rates, s.currency);
    $('#count').textContent = sc.list.length === vis.length ? vis.length + (vis.length === 1 ? ' item' : ' items') : sc.label;
    const total = $('#total');
    total.replaceChildren();
    if (sc.list.length) {
      total.append(h('b', {}, U.yuan(Math.round(sum * 100) / 100)), s.currency !== 'CNY' && conv != null ? ' ≈ ' + U.money(conv, s.currency) : '', unpriced ? ' · ' + unpriced + ' without a price' : '');
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
      const cur = data.items[q.keys[q.i]];
      $('#queue-text').textContent = (q.auto ? 'Adding to cart, ' : 'Going through ') + (q.i + 1) + ' of ' + q.keys.length + (cur ? ': ' + U.displayTitle(cur) : '');
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
    tagSel.hidden = !tags.size;
    const sellerSel = $('#f-seller');
    view.seller = fillSelect(sellerSel, Array.from(sellers).sort((a, b) => String(a[1]).localeCompare(String(b[1]))).map(([k, n]) => [k, (data.sellers[k] && data.sellers[k].trusted ? '★ ' : '') + n]), view.seller, 'Any seller');
    sellerSel.hidden = !sellers.size;

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
    const need = shown.filter((it) => it.platform === 'weidian' && !it.title && !it.check && !asked.has(it.key)).map((it) => it.key).slice(0, 40);
    // Shop and English name come from a slower lookup; ask for a few of the items on screen at a time.
    const enrich = shown.filter((it) => it.platform === 'weidian' && !it.seller && !(it.check && it.check.state === 'gone') && !asked.has('e:' + it.key)).map((it) => it.key).slice(0, 6);
    if (need.length || enrich.length) {
      need.forEach((k) => asked.add(k));
      enrich.forEach((k) => asked.add('e:' + k));
      send({ type: 'needPreviews', keys: need, enrich });
    }
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
    return !!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'search' && a.closest('.editor, #view-settings'));
  }

  function render() {
    // Each part draws on its own, so a problem in one never leaves the other empty.
    for (const part of [renderList, renderSettings]) {
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
    for (const sec of $$('main > section')) sec.hidden = sec.id !== 'view-' + name;
    for (const b of $$('.tabs button')) {
      b.classList.toggle('on', b.dataset.view === name);
      b.setAttribute('aria-current', b.dataset.view === name ? 'page' : 'false');
    }
    if (name === 'settings') renderCommands();
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
      h('button', { type: 'button', onclick: () => pickAgent('custom') }, 'A different one…'));
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
      const r = await send({ type: 'queue', op: 'step', delta, result });
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
        if ((key === 'customTemplate' || key === 'qcTemplate') && value && !L.validTemplate(value)) {
          toast('That template needs to start with https:// and contain {url} or {id}.', { error: true });
          return;
        }
        patch({ [key]: value });
      });
    }
    for (const el of $$('[data-size]')) {
      el.addEventListener('change', () => patch({ sizes: Object.assign({}, data.settings.sizes, { [el.dataset.size]: el.value.trim().slice(0, 30) }) }));
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
    send({ type: 'rates' });
  })();
})();
