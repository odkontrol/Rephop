/*
 * RepHop shared helpers: settings defaults, formatting, export and sync packing.
 * Pure functions only, like links.js, so they can be unit-tested in Node.
 */
(function (root, factory) {
  const links = typeof module === 'object' && module.exports ? require('./links.js') : root.RepLinks;
  const api = factory(links);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepUtil = api;
})(typeof self !== 'undefined' ? self : globalThis, function (L) {
  'use strict';

  const DEFAULT_SETTINGS = {
    agent: '', // nothing is assumed; the user picks their agent on first use
    theme: 'dark', // dark | light | system
    sizes: { shoes: '', tops: '', bottoms: '', belts: '', hats: '' },
    customTemplate: '',
    customName: '',
    openMode: 'reuse', // reuse | window | group | new
    focusOnOpen: true,
    clickHijack: true,
    altClickSave: true,
    hotkeysEnabled: true,
    keys: { open: 's', save: 'a', qc: 'q', original: 'o' },
    showPills: true,
    pillStyle: 'full', // full | compact
    hoverCard: true,
    showFab: true,
    detectTextLinks: true,
    currency: 'USD',
    qcProvider: 'finderqc',
    qcTemplate: '',
    defaultFolder: 'Inbox',
    autoAdvance: false,
    sync: false,
    extraSites: [],
  };

  const DEFAULT_FOLDERS = ['Inbox', 'Next haul', 'Maybe'];

  // Used only until the first successful rate download (and if the rate service is unreachable).
  const FALLBACK_RATES = { CNY: 1, USD: 0.14, EUR: 0.13, GBP: 0.11, CAD: 0.19, AUD: 0.21, PLN: 0.56, SEK: 1.5, NOK: 1.5, DKK: 0.97, CHF: 0.12, BRL: 0.75, MXN: 2.7, NZD: 0.23, SGD: 0.19 };

  const STATUSES = { saved: 'Saved', carted: 'In cart', bought: 'Bought' };

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    s.keys = Object.assign({}, DEFAULT_SETTINGS.keys, (stored && stored.keys) || {});
    s.sizes = Object.assign({}, DEFAULT_SETTINGS.sizes, (stored && stored.sizes) || {});
    if (!['dark', 'light', 'system'].includes(s.theme)) s.theme = 'dark';
    if (!Array.isArray(s.extraSites)) s.extraSites = [];
    return s;
  }

  // -------------------------------------------------------------- formatting

  function displayTitle(item) {
    if (!item) return '';
    if (item.customTitle) return item.customTitle;
    if (item.label) return item.label;
    if (item.titleEn) return item.titleEn;
    if (item.title) return item.title;
    const p = L.PLATFORMS[item.platform];
    return (p ? p.label : 'Item') + ' ' + (item.platform === 'yupoo' ? 'album ' + item.id : '#' + item.id);
  }

  function convert(cny, rates, currency) {
    if (typeof cny !== 'number' || !isFinite(cny)) return null;
    if (currency === 'CNY') return cny;
    const r = (rates && rates.rates && rates.rates[currency]) || FALLBACK_RATES[currency];
    return r ? cny * r : null;
  }

  function money(n, currency) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n);
    } catch (_) {
      return n.toFixed(2) + ' ' + currency;
    }
  }

  function yuan(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    return '¥' + (Number.isInteger(n) ? n : n.toFixed(2));
  }

  /** Pull a yuan price out of free text such as an album title ("￥268 hoodie", "268 yuan", "CNY 268"). */
  function parsePrice(text) {
    const t = String(text || '');
    const m = t.match(/[¥￥]\s*(\d{1,6}(?:\.\d{1,2})?)/) || t.match(/(?:CNY|RMB)\s*(\d{1,6}(?:\.\d{1,2})?)/i) || t.match(/(\d{1,6}(?:\.\d{1,2})?)\s*(?:yuan|rmb|cny|元|¥|￥)/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return n > 0 && n < 1000000 ? n : null;
  }

  /**
   * What a Weidian item page says about the item: the shop, and (for visitors outside China) a translated name.
   * Returns { gone: true } for a deleted item and null when the page is not an item page we can read.
   */
  function parseWeidianPage(html) {
    const m = String(html || '').match(/id=["']__rocker-render-inject__["'][^>]*data-obj=["']([^"']*)["']/);
    if (!m) return null;
    let j;
    try {
      j = JSON.parse(decodeEntities(m[1]));
    } catch (_) {
      return null;
    }
    if (!j || !j.status) return null;
    if (j.status.code !== 0) return j.status.code === 831013 || /不存在|已下架|已删除/.test(j.status.message || '') ? { gone: true } : null;
    const model = (j.result && j.result.default_model) || {};
    const item = model.item_info || {};
    const shop = model.shop_info || {};
    const out = {};
    if (typeof item.item_name === 'string' && item.item_name.trim()) out.name = item.item_name.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (typeof item.item_head === 'string' && /^https:\/\//.test(item.item_head)) out.image = item.item_head;
    const shopId = shop.shop_id || item.shop_id;
    if (shopId && /^\d+$/.test(String(shopId))) out.seller = { key: 'weidian:' + shopId, name: String(shop.shopName || 'Weidian shop ' + shopId).trim().slice(0, 60) };
    return out;
  }

  /** A small version of a product picture. Weidian's originals can be several megabytes. */
  function thumbUrl(url, size) {
    const u = L.toUrl(url);
    if (!u || u.protocol !== 'https:') return '';
    const px = size || 200;
    if (L.hostMatches(u.hostname, ['geilicdn.com'])) return u.origin + u.pathname + '?w=' + px + '&h=' + px + '&cp=1';
    if (u.hostname === 'photo.yupoo.com') return u.href.replace(/\/(medium|big|large|raw)(\.\w+)$/, '/small$2');
    return u.href;
  }

  const KINDS = { shoes: 'Shoes', tops: 'Tops (shirts, hoodies, jackets)', bottoms: 'Bottoms (pants, shorts)', belts: 'Belts', hats: 'Hats' };
  // Garment words are read before sneaker model names, so "Jordan 4 hoodie" is a top and "Dunk shorts" are
  // bottoms; a model name only decides when no garment word is present.
  const KIND_WORDS = [
    ['belts', /\bbelts?\b|腰带|皮带/i],
    ['hats', /\b(hats?|caps?|beanies?)\b|帽/i],
    ['tops', /\b(hoodies?|hoody|tees?|t-?shirts?|shirts?|jackets?|sweaters?|sweatshirts?|crewnecks?|coats?|puffers?|vests?|jerseys?|polos?|cardigans?|tank tops?|short[- ]sleeves?|long[- ]sleeves?)\b|卫衣|短袖|长袖|外套|夹克|衬衫|毛衣|T恤|羽绒/i],
    ['bottoms', /\b(pants|jeans|shorts|trousers|sweatpants|joggers|cargos|leggings|skirts?)\b|裤|裙/i],
    ['shoes', /\b(shoes?|sneakers?|trainers?|boots?|slides?|slippers?|loafers?|sandals?)\b|鞋|靴/i],
    ['shoes', /\b(jordans?|dunks?|yeezys?|air ?force|af1|air ?max|sambas?|gazelles?|campus|nb ?\d{3,4}|new balance|foam runners?|b30|b22)\b/i],
  ];

  /**
   * What sort of thing an item is. Used to pick the right size from "My sizes".
   * Your own choice wins; otherwise the names are read in order of how much they can be trusted:
   * the name you gave it, the words from Reddit, then the listing's own names.
   */
  function guessKind(item) {
    if (!item) return '';
    if (item.kind && (KINDS[item.kind] || item.kind === 'other')) return item.kind === 'other' ? '' : item.kind;
    for (const text of [item.customTitle, item.label, item.titleEn, item.title]) {
      if (!text) continue;
      for (const [kind, words] of KIND_WORDS) if (words.test(text)) return kind;
    }
    return '';
  }

  function normOption(text) {
    return String(text || '').toLowerCase().replace(/[\s\u3000]+/g, ' ').replace(/[【】\[\]（）()]/g, ' ').replace(/ +/g, ' ').trim();
  }

  /** Does an option's text name this size? "L" matches "L码" and "L (175)", not "XL"; "43" matches "EU 43", not "43.5" or "143". */
  function sizeMatches(optionText, size) {
    const o = normOption(optionText);
    const w = normOption(size);
    if (!o || !w) return false;
    if (o === w) return true;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = /^[\d.]+$/.test(w) ? new RegExp('(^|[^\\d.])' + esc + '(?![\\d]|\\.\\d)') : new RegExp('(^|[^a-z0-9])' + esc + '(?![a-z0-9])');
    return re.test(o);
  }

  /** Every word of `wanted` appears in the option as a whole word ("l" is not in "xl", "42" is not in "42.5"). */
  function wordsMatch(optionText, wanted) {
    const o = normOption(optionText);
    const words = normOption(wanted).split(' ').filter(Boolean);
    if (!o || !words.length) return false;
    return words.every((w) => {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9.])' + esc + '(?![a-z0-9]|\\.\\d)').test(o);
    });
  }

  /**
   * Choose one option from a row on a listing page.
   *   options: [{ text, disabled }]      wanted: a string, or several separated by commas ("43, 9.5")
   *   exact:   true when `wanted` is a colour or style, or text remembered from this very listing
   * A choice is only ever matched as a whole: the same text, or all of its words as whole words.
   * Returns the option's index, or -1 when nothing (or more than one thing) fits.
   */
  function pickOption(options, wanted, exact) {
    const usable = (options || []).map((o, i) => ({ i, text: o.text, off: !!o.disabled })).filter((o) => !o.off);
    for (const want of String(wanted || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const w = normOption(want);
      const same = usable.filter((o) => normOption(o.text) === w);
      if (same.length) return same[0].i;
      const hits = usable.filter((o) => (exact ? wordsMatch(o.text, want) : sizeMatches(o.text, want)));
      if (hits.length === 1) return hits[0].i;
    }
    return -1;
  }

  /** Is this option group about size (as opposed to colour or style)? */
  function isSizeGroup(name, options) {
    if (/size|尺码|尺寸|码数|鞋码|号码/i.test(name || '')) return true;
    if (/colou?r|style|颜色|款式|分类|版本/i.test(name || '')) return false;
    const texts = (options || []).map((o) => normOption(o.text));
    const sized = texts.filter((t) => /^(x{0,3}[sml]|[2-5]xl|\d{2,3}(\.5)?)( |$|码)/.test(t)).length;
    return texts.length > 1 && sized >= texts.length * 0.7;
  }

  /** The size to ask for on this item: its own, else the one from "My sizes" for its type. */
  function sizeFor(item, settings) {
    if (item && item.size) return item.size;
    const kind = guessKind(item);
    return (kind && settings && settings.sizes && settings.sizes[kind]) || '';
  }

  function cleanOptions(list) {
    const out = [];
    for (const o of Array.isArray(list) ? list : []) {
      if (!o || typeof o.v !== 'string' || !o.v.trim()) continue;
      out.push({ n: String(o.n || '').replace(/\s+/g, ' ').trim().slice(0, 40), v: o.v.replace(/\s+/g, ' ').trim().slice(0, 80) });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** One line that sums up a save, for toasts. */
  function describeSave(stats) {
    if (!stats.added && !stats.duplicates) {
      if (stats.reason === 'network') return "Couldn't reach that link. Check your connection and try again.";
      if (stats.reason === 'unresolved') return "That short link didn't lead to a product.";
      if (stats.reason === 'paused') return 'Weidian is limiting lookups right now, so that short link could not be read. Open it instead, or try again in half an hour.';
      return stats.failed ? 'No supported product link found there.' : 'Nothing to save.';
    }
    const parts = [];
    if (stats.added) parts.push(stats.added === 1 ? 'Saved' + (stats.title ? ': ' + String(stats.title).slice(0, 60) : '') : 'Saved ' + stats.added + ' new');
    if (stats.duplicates) parts.push(stats.duplicates === 1 && !stats.added ? 'Already in your list' : stats.duplicates + ' already in your list');
    if (stats.noBuyLink) parts.push(stats.noBuyLink + ' album' + (stats.noBuyLink > 1 ? 's' : '') + ' with no buy link');
    if (stats.pending) parts.push(stats.pending + ' album' + (stats.pending > 1 ? 's' : '') + " saved as-is because Yupoo didn't answer (use Find buy link later)");
    if (stats.failed) parts.push(stats.failed + " couldn't be read");
    return parts.join(' · ');
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  function safeChar(code) {
    try {
      return String.fromCodePoint(code);
    } catch (_) {
      return '';
    }
  }

  function stripTags(html) {
    return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ');
  }

  function hostOf(url) {
    const u = L.toUrl(url);
    return u ? u.hostname.replace(/^www\./, '') : '';
  }

  function sourceText(src) {
    if (!src) return '';
    const where = src.sub || src.site || hostOf(src.postUrl);
    return [where, src.postTitle].filter(Boolean).join(' · ');
  }

  function matches(item, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [item.customTitle, item.label, item.title, item.note, item.id, item.platform, item.folder, (item.tags || []).join(' '), item.seller && item.seller.name, (item.sources || []).map(sourceText).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }

  function normalizeTags(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(/[,#\n]+/);
    const out = [];
    for (const raw of list) {
      const t = String(raw).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24);
      if (t && !out.includes(t)) out.push(t);
    }
    return out.slice(0, 12);
  }

  // ------------------------------------------------------------------ export

  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet apps treating a cell as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(items, settings, rates) {
    const cur = settings.currency;
    const head = ['Title', 'Price (CNY)', 'Price (' + cur + ')', 'Qty', 'Platform', 'Item link', L.agentInfo(settings).name + ' link', 'QC link', 'Folder', 'Tags', 'Status', 'Seller', 'Note', 'Found in', 'Source link', 'Added'];
    const rows = [head];
    for (const it of items) {
      const conv = convert(it.price, rates, cur);
      const src = (it.sources || [])[0];
      rows.push([
        displayTitle(it), it.price == null ? '' : it.price, conv == null ? '' : conv.toFixed(2), it.qty || 1,
        (L.PLATFORMS[it.platform] || {}).label || it.platform, it.url, L.agentUrl(it, settings) || '', L.qcUrl(it, settings) || '',
        it.folder || '', (it.tags || []).join(' '), STATUSES[it.status] || it.status || '', (it.seller && it.seller.name) || '', it.note || '',
        sourceText(src), src ? src.commentUrl || src.postUrl || '' : '', it.addedAt ? new Date(it.addedAt).toISOString().slice(0, 10) : '',
      ]);
    }
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }

  /** A paste-ready list. mode: 'text' | 'markdown' | 'links' */
  function toText(items, mode, settings) {
    return items.map((it) => {
      const link = L.agentUrl(it, settings) || it.url;
      const price = it.price != null ? ' — ' + yuan(it.price) : '';
      const title = displayTitle(it);
      if (mode === 'links') return link;
      if (mode === 'markdown') return '- [' + title.replace(/([\[\]])/g, '\\$1') + '](' + link + ')' + price;
      return title + price + '\n' + link;
    }).join(mode === 'text' ? '\n\n' : '\n');
  }

  // -------------------------------------------------------------------- sync
  // chrome.storage.sync allows ~100 KB in 8 KB values, so the list is mirrored
  // in a compact form split across several keys. Pictures and long text are
  // left out and re-fetched on the other device.

  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const SYNC_NAME_MAX = 80;
  const SYNC_NOTE_MAX = 200;
  const CUT_NAME = 1;
  const CUT_NOTE = 2;

  function byteLen(s) {
    return encoder ? encoder.encode(s).length : unescape(encodeURIComponent(s)).length;
  }

  /**
   * Bytes the browser charges for one storage.sync value. It measures the JSON it writes itself, which
   * differs from JSON.stringify in two ways that matter: "<" becomes \u003C, and whole numbers too big
   * for 32 bits (every millisecond timestamp) are written as doubles, a few characters longer.
   * Both are counted here, rounding up. The key is added by the caller.
   */
  function storedSize(value) {
    const json = JSON.stringify(value);
    let extra = 0;
    for (let i = 0; i < json.length; i++) {
      const c = json.charCodeAt(i);
      if (c === 60 || c === 0x2028 || c === 0x2029) extra += 5;
    }
    const big = json.match(/\d{10,}/g);
    if (big) extra += big.length * 6;
    return byteLen(json) + extra;
  }

  /** A short fingerprint of a text, so two devices can tell "same text, shortened" from "edited". */
  function textHash(text) {
    let h = 5381;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function compactItem(it) {
    const src = (it.sources || [])[0];
    const c = { k: it.key, m: it.updatedAt || it.addedAt || 0, a: it.addedAt || 0 };
    const label = it.customTitle || it.label || '';
    const note = it.note || '';
    // "x" marks fields that are shortened here, or that this device itself only ever received shortened.
    // hn / ht fingerprint the full text, so the device that holds it can tell its own text coming back
    // from a genuine edit made elsewhere.
    let cut = it.cut || 0;
    if (label.length > SYNC_NAME_MAX) cut |= CUT_NAME;
    if (note.length > SYNC_NOTE_MAX) cut |= CUT_NOTE;
    if (label) c.l = label.slice(0, SYNC_NAME_MAX);
    if (it.customTitle) c.c = 1;
    if (it.title) c.tt = it.title.slice(0, 50);
    if (typeof it.price === 'number') c.p = it.price;
    if (it.folder) c.f = it.folder;
    if (it.tags && it.tags.length) c.t = it.tags;
    if (note) c.n = note.slice(0, SYNC_NOTE_MAX);
    if (it.status && it.status !== 'saved') c.s = it.status;
    if (it.qty && it.qty !== 1) c.q = it.qty;
    if (src && src.postUrl) c.su = src.postUrl.slice(0, 160);
    if (src && src.postTitle) c.st = src.postTitle.slice(0, 60);
    if (src && src.sub) c.sb = src.sub;
    if (it.seller && it.seller.key) c.se = [it.seller.key, it.seller.name || ''];
    if (it.aliases && it.aliases.length) c.al = it.aliases.slice(0, 3);
    if (it.kind) c.kd = it.kind;
    if (it.size) c.sz = String(it.size).slice(0, 30);
    if (it.style) c.sy = String(it.style).slice(0, 40);
    if (it.options && it.options.length) c.o = it.options.slice(0, 4).map((o) => [String(o.n || '').slice(0, 20), String(o.v || '').slice(0, 40)]);
    if (cut) {
      c.x = cut;
      if (cut & CUT_NAME) c.hn = label.length > SYNC_NAME_MAX ? textHash(label) : it.cutName || '';
      if (cut & CUT_NOTE) c.ht = note.length > SYNC_NOTE_MAX ? textHash(note) : it.cutNote || '';
    }
    return c;
  }

  function expandItem(c) {
    const base = L.keyToItem(c.k);
    if (!base) return null;
    const it = {
      key: base.key, platform: base.platform, id: base.id, url: base.url,
      label: c.c ? '' : c.l || '', customTitle: c.c ? c.l || '' : '', title: c.tt || '',
      price: typeof c.p === 'number' ? c.p : null, image: '', seller: Array.isArray(c.se) && typeof c.se[0] === 'string' ? { key: c.se[0], name: String(c.se[1] || '') } : null,
      note: c.n || '', tags: Array.isArray(c.t) ? c.t : [], folder: c.f || 'Inbox', status: c.s || 'saved', qty: c.q || 1,
      sources: c.su ? [{ postUrl: c.su, postTitle: c.st || '', sub: c.sb || '', addedAt: c.a || 0 }] : [],
      aliases: Array.isArray(c.al) ? c.al : [], addedAt: c.a || c.m || 0, updatedAt: c.m || 0, viewedAt: 0, check: null,
    };
    if (typeof c.kd === 'string') it.kind = c.kd;
    if (typeof c.sz === 'string') it.size = c.sz;
    if (typeof c.sy === 'string') it.style = c.sy;
    if (Array.isArray(c.o)) it.options = cleanOptions(c.o.map((p) => (Array.isArray(p) ? { n: p[0], v: p[1] } : null)));
    if (c.x) {
      it.cut = c.x;
      if (c.hn) it.cutName = c.hn;
      if (c.ht) it.cutNote = c.ht;
    }
    return it;
  }

  /**
   * Split the list into arrays that each fit one storage.sync value (8,192 bytes including the key).
   * Order is fixed (newest first, then by key) so two devices holding the same list produce the same chunks.
   * Newest items win if the ~100 KB total runs out.
   */
  function packSync(items, tombstones, opts) {
    const chunkBytes = (opts && opts.chunkBytes) || 6800;
    const maxBytes = (opts && opts.maxBytes) || 84000;
    const entries = Object.values(items || {}).map(compactItem);
    for (const [k, m] of Object.entries(tombstones || {})) entries.push({ k, d: 1, m });
    entries.sort((a, b) => (b.m || 0) - (a.m || 0) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const chunks = [];
    const kept = [];
    let current = [];
    let currentBytes = 2;
    let total = 0;
    let dropped = 0;
    for (const e of entries) {
      const size = storedSize(e) + 1;
      if (size > chunkBytes || total + size > maxBytes) {
        dropped++;
        continue;
      }
      if (currentBytes + size > chunkBytes && current.length) {
        chunks.push(current);
        current = [];
        currentBytes = 2;
      }
      current.push(e);
      kept.push(e);
      currentBytes += size;
      total += size;
    }
    if (current.length) chunks.push(current);
    return { chunks, kept, dropped, count: kept.length };
  }

  /** Accepts the current format (arrays) and the first release's format (JSON text). */
  function unpackSync(chunks) {
    const out = [];
    for (const c of chunks || []) {
      let arr = c;
      if (typeof c === 'string') {
        try {
          arr = JSON.parse(c);
        } catch (_) {
          continue; // a half-written chunk from another device
        }
      }
      if (Array.isArray(arr)) for (const e of arr) if (e && typeof e.k === 'string' && typeof e.m === 'number') out.push(e);
    }
    return out;
  }

  /**
   * A shortened copy must never replace the longer text it was cut from. The fingerprint tells the two
   * cases apart: the same text coming back (keep ours), or a real edit made on the other device (take it,
   * even though only its first part travelled).
   */
  function takeCut(localText, remoteText, remoteIsCut, remoteHash) {
    if (!remoteIsCut || typeof localText !== 'string') return remoteText;
    if (localText.length <= remoteText.length || !localText.startsWith(remoteText)) return remoteText;
    return !remoteHash || textHash(localText) === remoteHash ? localText : remoteText;
  }

  /** Fold another device's entries into the local list. Newer timestamp wins; deletions beat older edits. */
  function mergeSync(items, tombstones, remote) {
    let changed = false;
    for (const e of remote) {
      const local = items[e.k];
      if (e.d) {
        if (local && (local.updatedAt || 0) <= e.m) {
          delete items[e.k];
          changed = true;
        }
        if (!local || !items[e.k]) {
          if ((tombstones[e.k] || 0) < e.m) tombstones[e.k] = e.m;
        }
        continue;
      }
      if ((tombstones[e.k] || 0) >= (e.m || 0)) continue;
      if (!local) {
        const it = expandItem(e);
        if (it) {
          items[e.k] = it;
          delete tombstones[e.k];
          changed = true;
        }
      } else if ((e.m || 0) > (local.updatedAt || 0)) {
        const it = expandItem(e);
        if (!it) continue;
        const cut = e.x || 0;
        const remoteName = it.customTitle || it.label || '';
        const name = takeCut(local.customTitle || local.label || '', remoteName, !!(cut & CUT_NAME), e.hn);
        const note = takeCut(local.note || '', it.note, !!(cut & CUT_NOTE), e.ht);
        let still = 0;
        if (cut & CUT_NAME && name === remoteName) still |= CUT_NAME;
        if (cut & CUT_NOTE && note === it.note) still |= CUT_NOTE;
        Object.assign(local, {
          customTitle: it.customTitle ? name : '', label: it.customTitle ? local.label : name || local.label,
          price: it.price != null ? it.price : local.price, folder: it.folder, tags: it.tags, note, status: it.status, qty: it.qty, updatedAt: it.updatedAt,
        });
        for (const f of ['kind', 'size', 'style', 'options']) {
          if (it[f] !== undefined) local[f] = it[f];
          else delete local[f];
        }
        delete local.cut;
        delete local.cutName;
        delete local.cutNote;
        if (still) {
          local.cut = still;
          if (still & CUT_NAME && e.hn) local.cutName = e.hn;
          if (still & CUT_NOTE && e.ht) local.cutNote = e.ht;
        }
        if (!local.sources || !local.sources.length) local.sources = it.sources;
        changed = true;
      }
    }
    return changed;
  }

  /** True when this device holds something the synced copy lacks or has older (ignoring items that did not fit). */
  function needsPush(kept, remote) {
    const have = new Map();
    for (const e of remote) have.set(e.k, Math.max(have.get(e.k) || 0, e.m || 0));
    return kept.some((e) => !have.has(e.k) || have.get(e.k) < (e.m || 0));
  }

  function chunkArray(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  return {
    DEFAULT_SETTINGS, DEFAULT_FOLDERS, FALLBACK_RATES, STATUSES,
    mergeSettings, displayTitle, convert, money, yuan, parsePrice, decodeEntities, stripTags, hostOf, sourceText,
    matches, normalizeTags, csvCell, toCsv, toText, byteLen, storedSize, compactItem, expandItem, packSync, unpackSync, mergeSync, needsPush, chunkArray,
    thumbUrl, describeSave, parseWeidianPage, SYNC_NAME_MAX, SYNC_NOTE_MAX, CUT_NAME, CUT_NOTE, textHash,
    KINDS, guessKind, sizeMatches, pickOption, isSizeGroup, sizeFor, cleanOptions,
  };
});
