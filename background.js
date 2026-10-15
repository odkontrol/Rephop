/*
 * RepHop service worker.
 * The only place that writes the saved list, opens agent tabs and talks to the network.
 * Content scripts and the side panel send messages here.
 */
importScripts('lib/links.js', 'lib/util.js', 'lib/live.js');

const L = self.RepLinks;
const U = self.RepUtil;
const V = self.RepLive;

const DAY = 86400000;
const SKIP = Symbol('skip-write');
const CONTENT_FILES = ['lib/links.js', 'lib/util.js', 'content/main.js'];
const MAX_BULK = 1500;

// ------------------------------------------------------------------ storage

async function get(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] === undefined ? fallback : o[key];
}

// Every read-modify-write goes through this chain so two messages can never clobber each other.
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function getSettings() {
  return U.mergeSettings(await get('settings'));
}

function mutateItems(fn, opts) {
  return locked(async () => {
    const data = await chrome.storage.local.get(['items', 'tombstones', 'rev']);
    const items = data.items || {};
    const tombs = data.tombstones || {};
    const result = await fn(items, tombs);
    if (result === SKIP) return undefined;
    await chrome.storage.local.set({ items, tombstones: tombs, rev: (data.rev || 0) + 1 });
    if (!opts || opts.sync !== false) scheduleSync();
    return result;
  });
}

function mutate(key, fallback, fn, bump) {
  return locked(async () => {
    const data = await chrome.storage.local.get([key, 'rev']);
    const value = data[key] === undefined ? fallback : data[key];
    const result = await fn(value);
    if (result === SKIP) return undefined;
    const out = { [key]: value };
    if (bump) out.rev = (data.rev || 0) + 1;
    await chrome.storage.local.set(out);
    return result;
  });
}

function findKey(items, key) {
  if (!key) return null;
  if (items[key]) return key;
  for (const k in items) {
    const a = items[k].aliases;
    if (a && a.includes(key)) return k;
  }
  return null;
}

function prune(map, max, stampField) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => (map[a][stampField] || 0) - (map[b][stampField] || 0));
  for (const k of keys.slice(0, keys.length - max)) delete map[k];
}

async function pool(list, size, worker) {
  const out = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await worker(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, run));
  return out;
}

// ------------------------------------------------------------------ network

async function fetchPage(url, maxChars) {
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return { url: res.url, text: text.slice(0, maxChars) };
}

/**
 * Weidian rejects cross-origin API calls and Yupoo refuses to serve pictures without its own
 * referer, so two header rules cover exactly those requests and nothing else.
 */
async function setupNetRules() {
  const rules = [
    {
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }, { header: 'Referer', operation: 'set', value: 'https://weidian.com/' }] },
      condition: { requestDomains: ['thor.weidian.com'], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
    },
    {
      id: 2,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: 'https://x.yupoo.com/' }] },
      condition: { requestDomains: ['photo.yupoo.com'], resourceTypes: ['image'] },
    },
  ];
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1, 2], addRules: rules });
  } catch (e) {
    console.warn('RepHop: header rules not installed', e);
  }
}

/** Name, price, picture and stock from Weidian's item API. This endpoint is quick and tolerant, so previews use it. */
async function fetchWeidian(id) {
  const url = 'https://thor.weidian.com/detail/getItemSkuInfo/1.0?param=' + encodeURIComponent(JSON.stringify({ itemId: String(id) }));
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.status || j.status.code !== 0) throw new Error((j && j.status && j.status.message) || 'Weidian API error');
  const r = j.result || {};
  if (!r.itemTitle) return { state: 'gone', choices: [], choicesFrom: 'weidian' };
  const cents = r.itemDiscountLowPrice != null ? r.itemDiscountLowPrice : r.itemOriginalLowPrice;
  const out = { state: r.itemStock === 0 ? 'soldout' : 'ok', title: String(r.itemTitle).trim(), image: r.itemMainPic || '' };
  if (typeof cents === 'number' && cents > 0) out.price = cents / 100;
  // The rows of choices (colour, size…) in the seller's own words. The list shows them as drop-downs.
  out.choices = U.cleanChoices((Array.isArray(r.attrList) ? r.attrList : []).map((a) => {
    const values = Array.isArray(a && a.attrValues) ? a.attrValues : [];
    return { n: a && a.attrTitle, o: values.map((v) => v && v.attrValue), i: values.map((v) => v && v.img) };
  }));
  out.choicesFrom = 'weidian';
  return out;
}

// ---------------------------------------------------- shop + English name
// The item page knows two things the API does not: which shop sells the item, and a translated name.
// Weidian cuts off clients that load many item pages in a row, so this runs only for items you have
// saved, one at a time with a pause in between, a cap per session, and a long break after any refusal.

const ENRICH_GAP_MS = 3000;
const ENRICH_MAX_PER_SESSION = 60;
const enrichQueue = [];
let enrichRunning = false;

function queueEnrich(key) {
  if (!key.startsWith('weidian:') || enrichQueue.includes(key) || enrichQueue.length >= 40) return;
  enrichQueue.push(key);
  if (enrichRunning) return;
  enrichRunning = true;
  (async () => {
    while (enrichQueue.length) {
      const next = enrichQueue.shift();
      await enrichOne(next).catch(() => false);
    }
  })().finally(() => (enrichRunning = false));
}

/** Returns true if a request was made (so the caller should wait before the next one). */
async function enrichOne(key) {
  const item = L.keyToItem(key);
  const items = await get('items', {});
  const saved = items[findKey(items, key)];
  if (!item || !saved || saved.platform !== 'weidian') return false;
  const known = (await get('previews', {}))[key] || {};
  if (known.pageAt && Date.now() - known.pageAt < 7 * DAY) return false;
  const st = await chrome.storage.session.get(['enrichPausedUntil', 'enrichCount']);
  if ((st.enrichPausedUntil || 0) > Date.now() || (st.enrichCount || 0) >= ENRICH_MAX_PER_SESSION) return false;
  await chrome.storage.session.set({ enrichCount: (st.enrichCount || 0) + 1 });
  let page;
  try {
    page = U.parseWeidianPage((await pacedPage(ENRICH_GAP_MS, () => fetchPage('https://weidian.com/item.html?itemID=' + item.id, 400000))).text);
  } catch (_) {
    // Refused: stop asking for a good while rather than make it worse. (Simply being offline does not count.)
    if (navigator.onLine !== false) await pausePages();
    enrichQueue.length = 0;
    return true;
  }
  const patch = { pageAt: Date.now() };
  if (page && page.gone) patch.state = 'gone';
  if (page && page.name) patch.titleEn = page.name;
  if (page && page.seller) patch.seller = page.seller;
  if (page && page.image && !known.image) patch.image = page.image;
  await savePreview(key, patch);
  return true;
}

function metaContent(html, prop) {
  const a = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'));
  const b = a || html.match(new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*property=["\']' + prop + '["\']', 'i'));
  return b ? U.decodeEntities(b[1]).trim() : '';
}

function yupooMeta(html, album) {
  const full = metaContent(html, 'og:title');
  const title = full.split(/\s\|\s/)[0].replace(/\s+/g, ' ').trim();
  const meta = { seller: { key: 'yupoo:' + album.user, name: album.user } };
  if (title) meta.title = title.slice(0, 140);
  const price = U.parsePrice(title);
  if (price) meta.price = price;
  const image = metaContent(html, 'og:image');
  if (/^https?:\/\//.test(image)) meta.image = image;
  return meta;
}

/** Buy links a seller put on an album: the description first, then any outbound link on the page. */
function yupooBuyLinks(html) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const p = L.parseLink(U.decodeEntities(raw));
    if (p && p.kind !== 'yupoo' && !seen.has(p.key)) {
      seen.add(p.key);
      out.push(p);
    }
  };
  const start = html.indexOf('showalbumheader__main');
  if (start !== -1) {
    const head = html.slice(start, start + 9000);
    for (const m of head.matchAll(/href=["']([^"']+)["']/g)) add(m[1]);
    for (const hit of L.extractLinks(U.stripTags(U.decodeEntities(head)))) if (hit.parsed.kind !== 'yupoo' && !seen.has(hit.parsed.key)) {
      seen.add(hit.parsed.key);
      out.push(hit.parsed);
    }
  }
  for (const m of html.matchAll(/href=["']([^"']*\/external\?url=[^"']+)["']/g)) add(m[1]);
  return out;
}

// Every request that ends up at a weidian.com page goes through pacedPage(): one at a time, spaced out,
// and not at all for half an hour after Weidian has refused one. (Weidian cuts off clients that load
// many item pages in a row.)
const PAGE_BREAK_MS = 30 * 60000;
let pageChain = Promise.resolve();
let lastPageAt = 0;

function pacedPage(gapMs, fn) {
  const p = pageChain.then(async () => {
    const wait = lastPageAt + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastPageAt = Date.now();
    }
  });
  pageChain = p.catch(() => {});
  return p;
}

async function pagesPaused() {
  const st = await chrome.storage.session.get('enrichPausedUntil');
  return (st.enrichPausedUntil || 0) > Date.now();
}

function pausePages() {
  return chrome.storage.session.set({ enrichPausedUntil: Date.now() + PAGE_BREAK_MS });
}

async function resolveShort(parsed) {
  if (L.hostMatches(L.toUrl(parsed.url).hostname, ['youshop10.com'])) {
    // Weidian's own shortener redirects to an item page. Only the final address is needed, so ask for
    // headers only, wait our turn, and stay away while Weidian is refusing us.
    if (await pagesPaused()) return { ok: false, reason: 'paused', parsed };
    const ask = (method) => fetch(parsed.url, { method, credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(12000) });
    let res;
    try {
      res = await pacedPage(1500, () => ask('HEAD'));
      if (res.status === 405 || res.status === 501) res = await pacedPage(1500, () => ask('GET'));
    } catch (e) {
      // A refusal starts the break. Simply being offline does not.
      if (navigator.onLine !== false) await pausePages();
      throw e;
    }
    const direct = L.parseLink(res.url);
    return direct && direct.kind === 'item' ? { ok: true, item: direct, from: parsed } : { ok: false, reason: 'unresolved', parsed };
  }
  const page = await fetchPage(parsed.url, 400000);
  const direct = L.parseLink(page.url);
  if (direct && direct.kind === 'item') return { ok: true, item: direct, from: parsed };
  const text = U.decodeEntities(page.text).replace(/\\u002F/gi, '/').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
  for (const hit of L.extractLinks(text)) if (hit.parsed.kind === 'item') return { ok: true, item: hit.parsed, from: parsed };
  return { ok: false, reason: 'unresolved', parsed };
}

async function resolveYupoo(album, opts) {
  const page = await fetchPage(album.url, 700000);
  const meta = yupooMeta(page.text, album);
  const candidates = yupooBuyLinks(page.text);
  const item = candidates.find((c) => c.kind === 'item');
  if (item) return { ok: true, item, from: album, meta };
  for (const c of candidates) {
    if (c.kind !== 'short') continue;
    // The album's buy link is a short link. Following it costs a request to the shop, which a hover is not
    // worth: show the album for now; the link is followed when the item is opened or saved.
    if (opts && opts.hover) return { ok: true, item: album, from: album, meta, later: true };
    const r = await resolveShort(c).catch(() => null);
    if (r && r.ok) return { ok: true, item: r.item, from: album, meta };
  }
  return { ok: true, item: album, from: album, meta, noBuyLink: true };
}

const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Turn any supported link into a product.
 *   { ok: true, item, from?, meta?, noBuyLink? }  item is a marketplace product, or the album itself when it has no buy link
 *   { ok: false, reason: 'unsupported' | 'network' | 'unresolved', parsed? }
 */
async function resolveLink(input, force, opts) {
  const parsed = typeof input === 'string' ? L.parseLink(input) : input;
  if (!parsed) return { ok: false, reason: 'unsupported' };
  if (parsed.kind === 'item') return { ok: true, item: parsed };
  return once('resolve:' + (opts && opts.hover ? 'hover:' : '') + parsed.key, async () => {
    const cache = await get('resolved', {});
    const hit = cache[parsed.key];
    if (hit && !force && Date.now() - hit.at < (hit.key && !hit.noBuyLink ? 30 * DAY : DAY)) {
      const item = L.keyToItem(hit.key);
      if (item) return { ok: true, item, from: parsed, meta: hit.meta, noBuyLink: !!hit.noBuyLink, gone: !!hit.gone };
    }
    let out;
    try {
      out = parsed.kind === 'yupoo' ? await resolveYupoo(parsed, opts) : await resolveShort(parsed);
    } catch (e) {
      if (parsed.kind === 'yupoo' && e && e.status === 404) {
        // The seller deleted the album.
        out = { ok: true, item: parsed, from: parsed, noBuyLink: true, gone: true, meta: { seller: { key: 'yupoo:' + parsed.user, name: parsed.user } } };
      } else return { ok: false, reason: 'network', parsed, error: String((e && e.message) || e) };
    }
    if (out.ok && out.later) {
      if (out.meta) await savePreview(parsed.key, Object.assign({ state: 'ok' }, out.meta));
    } else if (out.ok) {
      await mutate('resolved', {}, (map) => {
        map[parsed.key] = { key: out.item.key, meta: out.meta || null, noBuyLink: !!out.noBuyLink, gone: !!out.gone, at: Date.now() };
        prune(map, 600, 'at');
      });
      if (out.meta) await savePreview(parsed.key, Object.assign({ state: out.gone ? 'gone' : 'ok' }, out.meta));
      if (parsed.kind === 'yupoo' && out.item.kind === 'item') await upgradeAlbum(parsed.key, out.item, out.meta);
    }
    return out;
  });
}

// ----------------------------------------------------------------- previews

async function savePreview(key, preview, opts) {
  await mutate('previews', {}, (map) => {
    const cur = map[key] || {};
    const next = Object.assign({}, cur, preview, { at: Date.now() });
    // What the agent's own listing offers is exact; Weidian's wording never replaces it.
    if (preview.choicesFrom === 'weidian' && Array.isArray(preview.choices) && preview.choices.length) next.wd = preview.choices;
    if (preview.choicesFrom === 'weidian' && cur.choicesFrom === 'agent') {
      next.choices = cur.choices;
      next.choicesFrom = 'agent';
    }
    map[key] = next;
    prune(map, 800, 'at');
  });
  await mutateItems((items) => {
    const k = findKey(items, key);
    if (!k) return SKIP;
    return applyPreview(items[k], preview, opts && opts.fresh) ? true : SKIP;
  }, { sync: false });
  await fillGroup(key, preview);
}

/** Remembered choices, reworded the way this listing words them (so they keep fitting its drop-downs). */
function rewordPicks(options, choices, source) {
  const groups = choices.map((c) => ({ name: c.n, options: c.o.map((t) => ({ text: t })) }));
  const plan = U.planCart(groups, { options, source });
  const out = U.cleanOptions(options);
  plan.rows.forEach((row, gi) => {
    if (row && typeof row.from === 'number' && row.pick != null && out[row.from]) out[row.from] = { n: groups[gi].name, v: groups[gi].options[row.pick].text };
  });
  return out;
}

/** Copy what we know about a listing onto a saved item. Fills gaps; a fresh fetch also updates name and price. */
function applyPreview(it, p, fresh) {
  if (!p) return false;
  let changed = false;
  const put = (field, value) => {
    if (value != null && value !== '' && it[field] !== value) {
      it[field] = value;
      changed = true;
    }
  };
  if (!it.title || fresh) put('title', p.title);
  put('titleEn', p.titleEn);
  if (!it.image) put('image', p.image);
  if (p.seller && (!it.seller || (it.seller.key === p.seller.key && it.seller.name !== p.seller.name))) put('seller', p.seller);
  if (typeof p.price === 'number' && !it.priceEdited && (it.price == null || fresh)) put('price', p.price);
  if (p.state && (!it.check || it.check.state !== p.state)) {
    it.check = { state: p.state, at: Date.now() };
    changed = true;
  }
  // The seller's own rows (Weidian's wording). Kept even once the agent's wording is known: a choice made
  // in the seller's words is found on the agent's listing through them.
  const wd = p.choicesFrom === 'weidian' ? p.choices : p.wd;
  if (Array.isArray(wd) && wd.length && JSON.stringify(it.wd || []) !== JSON.stringify(wd)) {
    it.wd = wd;
    changed = true;
  }
  if (Array.isArray(p.choices)) {
    const fromAgent = p.choicesFrom === 'agent';
    // The agent's own wording wins and stays; Weidian's is used until the listing has been seen there.
    if (fromAgent || it.choicesFrom !== 'agent') {
      const from = fromAgent ? 'agent' : 'weidian';
      if (JSON.stringify(it.choices || []) !== JSON.stringify(p.choices) || (p.choices.length && it.choicesFrom !== from)) {
        if (p.choices.length) {
          it.choices = p.choices;
          it.choicesFrom = from;
        } else {
          delete it.choices;
          delete it.choicesFrom;
        }
        changed = true;
      }
      if (fromAgent && p.choices.length && it.options && it.options.length) {
        const next = rewordPicks(it.options, p.choices, it.wd || []);
        if (JSON.stringify(next) !== JSON.stringify(it.options)) {
          it.options = next;
          changed = true;
        }
      }
      for (const pick of fromAgent && p.choices.length && Array.isArray(it.more) ? it.more : []) {
        if (!pick.options || !pick.options.length) continue;
        const next = rewordPicks(pick.options, p.choices, it.wd || []);
        if (JSON.stringify(next) !== JSON.stringify(pick.options)) {
          pick.options = next;
          changed = true;
        }
      }
    }
    if (!it.optsAt) {
      it.optsAt = Date.now();
      changed = true;
    }
  }
  return changed;
}

/** Title, price, picture and availability. Weidian answers directly; other sites are filled in when you visit them. */
async function getPreview(key, force) {
  const item = L.keyToItem(key);
  if (!item) return null;
  const hit = (await get('previews', {}))[key];
  if (item.platform !== 'weidian') return hit || null;
  if (hit && !force && Date.now() - hit.at < DAY && Array.isArray(hit.choices)) return hit;
  return once('preview:' + key, async () => {
    let p;
    try {
      p = await fetchWeidian(item.id);
    } catch (_) {
      return hit ? Object.assign({}, hit, { stale: true }) : null;
    }
    await savePreview(key, p, { fresh: true });
    return Object.assign({}, hit, p, { at: Date.now() });
  });
}

const previewQueue = [];
let previewWorkers = 0;
function queuePreview(key) {
  if (!key.startsWith('weidian:') || previewQueue.includes(key)) return;
  previewQueue.push(key);
  while (previewWorkers < 2 && previewQueue.length) {
    previewWorkers++;
    (async () => {
      while (previewQueue.length) {
        const key = previewQueue.shift();
        const p = await getPreview(key).catch(() => null);
        // A preview that was already known is still news to an item that arrived later (a backup, a sync).
        if (p && !p.stale) {
          await mutateItems((items) => {
            const k = findKey(items, key);
            return k && applyPreview(items[k], p) ? true : SKIP;
          }, { sync: false }).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })().finally(() => previewWorkers--);
  }
}

// --------------------------------------------------------------------- tabs

function isAgentPage(url, settings) {
  const u = L.toUrl(url);
  const a = L.toUrl(L.agentInfo(settings).template.replace(/\{[^}]+\}/g, 'x'));
  return !!(u && a && u.hostname.replace(/^www\./, '') === a.hostname.replace(/^www\./, ''));
}

/**
 * May we point this tab at a new listing? Only while it still shows something we put there:
 * the last address we opened in it, or any product listing or album. A cart, a checkout, or a
 * site we cannot see (the user took the tab elsewhere) is left alone.
 */
function reusable(tab, lastUrl) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url) return false;
  return url === lastUrl || !!L.parseLink(url);
}

// Opens run one at a time, so two quick clicks cannot both decide "there is no agent tab yet".
let openChain = Promise.resolve();
function openUrl(url, settings, disposition, srcTab) {
  const p = openChain.then(() => openUrlNow(url, settings, disposition, srcTab)).then(async (tabId) => {
    await noteBack(tabId, srcTab, settings).catch(() => {});
    return tabId;
  });
  openChain = p.catch(() => {});
  return p;
}

/** "r/sneakerreps" for a Reddit page, otherwise the site's name: what the agent page's back button says. */
function backLabel(url) {
  const u = L.toUrl(url);
  if (!u) return '';
  const sub = u.pathname.match(/^\/r\/([A-Za-z0-9_]+)/);
  if (sub && L.hostMatches(u.hostname, ['reddit.com'])) return 'r/' + sub[1];
  return u.hostname.replace(/^www\./, '');
}

/**
 * Remembers which page a listing was opened from, so the agent page can offer a way back to it.
 * A listing opened from the list or a queue has no page to go back to, so an older entry for that tab is dropped;
 * a click made on the agent's own site keeps the entry it has.
 */
async function noteBack(tabId, srcTab, settings) {
  if (tabId == null) return;
  const { backTo = {} } = await chrome.storage.session.get('backTo');
  const fromAgent = srcTab && isAgentPage(srcTab.url, settings);
  if (srcTab && srcTab.id !== tabId && /^https?:/.test(srcTab.url || '') && !fromAgent) {
    backTo[tabId] = { tabId: srcTab.id, url: srcTab.url, label: backLabel(srcTab.url), at: Date.now() };
    const old = Object.keys(backTo).sort((a, b) => backTo[b].at - backTo[a].at).slice(30);
    for (const k of old) delete backTo[k];
  } else if (!fromAgent && backTo[tabId]) delete backTo[tabId];
  else return;
  await chrome.storage.session.set({ backTo });
}

async function openUrlNow(url, settings, disposition, srcTab) {
  // disposition: 'default' follows the setting, 'reuse' forces the single tab (queue, shortcuts),
  // 'background' is a ctrl/middle click, 'group' is "open all in tabs".
  const background = disposition === 'background' || disposition === 'group';
  const mode = disposition === 'group' ? 'group' : background ? (settings.openMode === 'group' ? 'group' : 'new') : disposition === 'reuse' && settings.openMode !== 'window' ? 'reuse' : settings.openMode;
  const active = background ? false : !!settings.focusOnOpen;
  const st = await chrome.storage.session.get(['agentTabId', 'agentTabUrl', 'agentWindowId', 'agentGroupId']);
  const beside = srcTab ? { index: srcTab.index + 1, windowId: srcTab.windowId, openerTabId: srcTab.id } : {};

  if (mode === 'reuse') {
    let tab = st.agentTabId != null ? await chrome.tabs.get(st.agentTabId).catch(() => null) : null;
    if (tab && !reusable(tab, st.agentTabUrl)) tab = null;
    // Never navigate away the page the click came from, unless that page is the agent itself.
    if (tab && srcTab && tab.id === srcTab.id && !isAgentPage(srcTab.url, settings)) tab = null;
    if (tab) {
      // The same address again (another pick from this listing): load it afresh, so that step starts on a new page.
      if ((tab.url || tab.pendingUrl) === url) {
        await chrome.tabs.reload(tab.id);
        if (active) await chrome.tabs.update(tab.id, { active: true });
      } else await chrome.tabs.update(tab.id, { url, active });
      if (active) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } else {
      tab = await chrome.tabs.create(Object.assign({ url, active }, beside));
    }
    await chrome.storage.session.set({ agentTabId: tab.id, agentTabUrl: url });
    return tab.id;
  }

  if (mode === 'window') {
    const win = st.agentWindowId != null ? await chrome.windows.get(st.agentWindowId, { populate: true }).catch(() => null) : null;
    if (win && win.tabs && win.tabs.length) {
      let tab = win.tabs.find((t) => t.active) || win.tabs[0];
      if (reusable(tab, st.agentTabUrl)) await chrome.tabs.update(tab.id, { url });
      else tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
      if (active) await chrome.windows.update(win.id, { focused: true }).catch(() => {});
      await chrome.storage.session.set({ agentTabUrl: url });
      return tab.id;
    }
    const cur = await (srcTab ? chrome.windows.get(srcTab.windowId) : chrome.windows.getLastFocused()).catch(() => null);
    const width = 780;
    const bounds = cur && cur.width ? { width, height: cur.height, top: cur.top, left: Math.max(0, cur.left + cur.width - width) } : { width };
    let created;
    try {
      created = await chrome.windows.create(Object.assign({ url, type: 'normal', focused: active }, bounds));
    } catch (_) {
      created = await chrome.windows.create({ url, type: 'normal', focused: active });
    }
    await chrome.storage.session.set({ agentWindowId: created.id, agentTabUrl: url });
    return created.tabs && created.tabs[0] ? created.tabs[0].id : null;
  }

  if (mode === 'group') {
    const tab = await chrome.tabs.create(Object.assign({ url, active }, srcTab ? { windowId: srcTab.windowId } : {}));
    let gid = st.agentGroupId;
    try {
      if (gid != null && (await chrome.tabGroups.get(gid)).windowId !== tab.windowId) gid = null;
    } catch (_) {
      gid = null;
    }
    try {
      if (gid != null) await chrome.tabs.group({ tabIds: tab.id, groupId: gid });
      else {
        gid = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
        await chrome.tabGroups.update(gid, { title: L.agentInfo(settings).name, color: 'orange' });
        await chrome.storage.session.set({ agentGroupId: gid });
      }
    } catch (_) {
      /* grouping is cosmetic; the tab is already open */
    }
    return tab.id;
  }

  const tab = await chrome.tabs.create(Object.assign({ url, active }, beside));
  return tab.id;
}

async function markViewed(keys) {
  const now = Date.now();
  await mutate('seen', {}, (seen) => {
    for (const k of keys) if (k) seen[k] = Object.assign(seen[k] || { p: [] }, { v: now, t: now });
    prune(seen, 4000, 't');
  }, true);
  await mutateItems((items) => {
    const k = findKey(items, keys[0]);
    if (!k) return SKIP;
    items[k].viewedAt = now;
    return true;
  }, { sync: false });
}

async function openLink(msg, srcTab) {
  const settings = await getSettings();
  const target = msg.key ? L.keyToItem(msg.key) : msg.url;
  if (!target) return { ok: false, reason: 'unsupported' };
  // Nothing is opened until the user has said which agent they use.
  if (!L.agentInfo(settings).chosen) return { ok: false, reason: 'no-agent' };
  const res = await resolveLink(target);
  const agent = L.agentInfo(settings).name;
  if (!res.ok) {
    if (res.parsed && res.reason !== 'unsupported') {
      // We could not read the link ourselves, so let the browser follow it; the page it lands on gets a RepHop button.
      await openUrl(res.parsed.url, settings, msg.disposition, srcTab);
      return { ok: true, fallback: true, agent, message: 'Could not read that link directly, so it was opened as-is.' };
    }
    return { ok: false, reason: res.reason };
  }
  const url = res.noBuyLink ? res.item.url : L.agentUrl(res.item, settings);
  const tabId = await openUrl(url, settings, msg.disposition, srcTab);
  await markViewed([res.item.key, res.from && res.from.key]);
  if (res.item.kind === 'item') queuePreview(res.item.key);
  return { ok: true, key: res.item.key, noBuyLink: !!res.noBuyLink, agent, tabId, focused: msg.disposition !== 'background' && msg.disposition !== 'group' && settings.focusOnOpen };
}

// --------------------------------------------------------------- saved list

function sameSource(a, b) {
  return (a.commentUrl || a.postUrl || '') === (b.commentUrl || b.postUrl || '');
}

function cleanCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const out = { site: s(ctx.site, 40), sub: s(ctx.sub, 60), postId: s(ctx.postId, 20), postTitle: s(ctx.postTitle, 200), postUrl: s(ctx.postUrl, 400), commentUrl: s(ctx.commentUrl, 400), author: s(ctx.author, 60), addedAt: Date.now() };
  return out.postUrl || out.commentUrl ? out : null;
}

function applyMeta(it, meta) {
  if (!meta) return;
  if (!it.label && !it.title && meta.title) it.label = meta.title;
  if (it.price == null && typeof meta.price === 'number') it.price = meta.price;
  if (!it.image && meta.image) it.image = meta.image;
  if (!it.seller && meta.seller) it.seller = meta.seller;
}

/** An album that was saved before its buy link was known becomes the real product (or merges into it). */
function upgradeAlbum(albumKey, base, meta) {
  return mutateItems((items, tombs) => {
    const it = items[albumKey];
    if (!it || it.platform !== 'yupoo' || base.platform === 'yupoo') return SKIP;
    delete items[albumKey];
    tombs[albumKey] = Date.now();
    const dup = items[base.key];
    if (dup) {
      for (const src of it.sources || []) if (!dup.sources.some((x) => sameSource(x, src))) dup.sources.push(src);
      if (!dup.aliases.includes(albumKey)) dup.aliases.push(albumKey);
      if (!dup.label && it.label) dup.label = it.label;
      if (!dup.note && it.note) dup.note = it.note;
      dup.updatedAt = Date.now();
    } else {
      Object.assign(it, { key: base.key, platform: base.platform, id: base.id, url: base.url, pending: false, updatedAt: Date.now() });
      if (!it.aliases.includes(albumKey)) it.aliases.push(albumKey);
      items[base.key] = it;
      delete tombs[base.key];
      applyMeta(it, meta);
    }
    return true;
  }).then(async (done) => {
    if (!done) return false;
    queuePreview(base.key);
    await rekeyQueue(albumKey, base.key);
    return true;
  });
}

/** A running queue may still list an item under its old key. */
function rekeyQueue(oldKey, newKey) {
  return mutate('queue', null, (q) => {
    if (!q || !Array.isArray(q.keys) || !q.keys.includes(oldKey)) return SKIP;
    const at = q.keys.indexOf(oldKey);
    if (q.keys.includes(newKey)) {
      q.keys.splice(at, 1);
      if (Array.isArray(q.owner)) q.owner.splice(at, 1);
      if (q.i > at) q.i--;
      q.i = Math.max(0, Math.min(q.i, q.keys.length - 1));
    } else q.keys[at] = newKey;
    return true;
  });
}

/** Save one or many links. entries: [{ url | key, ctx, label }] */
async function saveEntries(entries, folder) {
  const settings = await getSettings();
  const list = (entries || []).slice(0, MAX_BULK);
  const resolved = await pool(list, 4, async (e) => {
    const target = e.key ? L.keyToItem(e.key) : e.url;
    if (!target) return { e, r: { ok: false, reason: 'unsupported' } };
    try {
      return { e, r: await resolveLink(target) };
    } catch (_) {
      return { e, r: { ok: false, reason: 'network' } };
    }
  });

  const stats = { ok: true, added: 0, duplicates: 0, failed: 0, noBuyLink: 0, pending: 0, keys: [], title: '' };
  const fresh = [];
  const rekeyed = [];
  const previews = await get('previews', {});
  const folders = await get('folders', U.DEFAULT_FOLDERS);
  const dest = folder && folders.includes(folder) ? folder : folders.includes(settings.defaultFolder) ? settings.defaultFolder : folders[0] || 'Inbox';

  await mutateItems((items, tombs) => {
    for (const entry of resolved) {
      const e = entry.e;
      let r = entry.r;
      if (!r.ok && r.reason === 'network' && r.parsed && r.parsed.kind === 'yupoo') {
        // Yupoo did not answer. Keep the album so the find is not lost; its buy link is looked up again later.
        r = { ok: true, item: r.parsed, from: r.parsed, pending: true };
      }
      if (!r.ok) {
        stats.failed++;
        stats.reason = r.reason;
        continue;
      }
      const base = r.item;
      const now = Date.now();
      const ctx = cleanCtx(e.ctx);
      const label = L.cleanLabel(e.label || '');
      const existing = findKey(items, base.key) || (r.from ? findKey(items, r.from.key) : null);
      let it = existing ? items[existing] : null;
      if (it) {
        if (it.platform === 'yupoo' && base.platform !== 'yupoo') {
          // An album saved before its buy link was known: upgrade it in place.
          delete items[existing];
          tombs[existing] = now;
          delete tombs[base.key];
          rekeyed.push([existing, base.key]);
          Object.assign(it, { key: base.key, platform: base.platform, id: base.id, url: base.url, pending: false, updatedAt: now });
          if (!it.aliases.includes(existing)) it.aliases.push(existing);
          items[it.key] = it;
        }
        if (ctx && !it.sources.some((s) => sameSource(s, ctx))) {
          it.sources.push(ctx);
          if (it.sources.length > 8) it.sources.shift();
        }
        if (!it.label && label) it.label = label;
        stats.duplicates++;
      } else {
        it = {
          key: base.key, platform: base.platform, id: base.id, url: base.url,
          label, customTitle: '', title: '', price: null, image: '', seller: base.shopId ? { key: 'weidian:' + base.shopId, name: 'Weidian shop ' + base.shopId } : null,
          note: '', tags: [], folder: dest, status: 'saved', qty: 1, sources: ctx ? [ctx] : [], aliases: [],
          addedAt: now, updatedAt: now, viewedAt: 0, check: null,
        };
        items[it.key] = it;
        delete tombs[it.key];
        stats.added++;
        fresh.push(it.key);
      }
      if (r.from && r.from.key !== it.key && !it.aliases.includes(r.from.key)) it.aliases.push(r.from.key);
      if (r.noBuyLink) stats.noBuyLink++;
      if (r.pending) {
        stats.pending++;
        it.pending = true;
      } else if (it.pending) it.pending = false;
      // Options the user had picked on the agent's page when they pressed Save there.
      const picked = U.cleanOptions(e.options);
      if (picked.length) {
        it.options = picked;
        it.updatedAt = now;
      }
      applyMeta(it, r.meta);
      applyPreview(it, previews[it.key]);
      for (const a of it.aliases) applyPreview(it, previews[a]);
      stats.keys.push(it.key);
      stats.title = U.displayTitle(it);
    }
    return stats.keys.length ? true : SKIP;
  });

  for (const [from, to] of rekeyed) await rekeyQueue(from, to);
  for (const k of fresh.slice(0, 60)) queuePreview(k);
  for (const k of fresh.slice(0, 12)) queueEnrich(k);
  if ((entries || []).length > MAX_BULK) stats.truncated = (entries || []).length - MAX_BULK;
  if (stats.added) flashBadge('+' + stats.added);
  return stats;
}

const EDITABLE = ['customTitle', 'label', 'note', 'tags', 'folder', 'status', 'qty', 'price', 'kind', 'size', 'style', 'options', 'weight'];

function updateItems(keys, patch) {
  return mutateItems((items) => {
    let n = 0;
    for (const key of keys) {
      const it = items[key];
      if (!it) continue;
      for (const f of EDITABLE) {
        if (!(f in patch)) continue;
        let v = patch[f];
        if (f === 'tags') v = U.normalizeTags(v);
        if (f === 'qty') v = Math.max(1, Math.min(99, parseInt(v, 10) || 1));
        if (f === 'price') {
          v = v === '' || v == null ? null : Number(v);
          if (v != null && !(v >= 0 && v < 1e7)) continue;
          it.priceEdited = v != null;
        }
        if (f === 'status' && !U.STATUSES[v]) continue;
        if (f === 'kind' && v && !U.KINDS[v] && v !== 'other') continue;
        if (f === 'options') v = U.cleanOptions(v);
        if (f === 'weight') {
          // grams for one piece; empty goes back to RepHop's estimate
          v = parseInt(v, 10);
          if (!(v > 0 && v <= 30000)) {
            delete it.weight;
            continue;
          }
        }
        if (typeof v === 'string') v = v.trim().slice(0, f === 'note' ? 2000 : f === 'size' || f === 'style' ? 40 : 200);
        if ((f === 'kind' || f === 'size' || f === 'style') && !v) delete it[f];
        else if (f === 'options' && !v.length) delete it.options;
        else it[f] = v;
      }
      if (patch.addTags) it.tags = U.normalizeTags((it.tags || []).concat(patch.addTags));
      // Text typed on this device is complete again, whatever sync delivered earlier.
      if ('note' in patch) {
        if (it.cut) it.cut &= ~U.CUT_NOTE;
        delete it.cutNote;
      }
      if ('customTitle' in patch || 'label' in patch) {
        if (it.cut) it.cut &= ~U.CUT_NAME;
        delete it.cutName;
      }
      if (!it.cut) delete it.cut;
      it.updatedAt = Date.now();
      n++;
    }
    return n ? { ok: true, count: n } : SKIP;
  });
}

/**
 * Another choice from the same listing: op 'add' (with starting options), 'set' (options, qty, status of one),
 * 'remove' one, or 'restore' a removed one (undo).
 */
function pickOp(m) {
  return mutateItems((items) => {
    const k = findKey(items, String(m.key || ''));
    const it = k && items[k];
    if (!it || it.platform === 'yupoo') return SKIP;
    let more = U.cleanMore(it.more);
    let id = String(m.id || '');
    if (m.op === 'add' || m.op === 'restore') {
      if (more.length >= U.MAX_MORE) return SKIP;
      if (m.op === 'add') id = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
      const pick = U.cleanMore([Object.assign({}, m.op === 'restore' ? m.pick : { options: m.options }, { id })])[0];
      if (!pick || more.some((p) => p.id === pick.id)) return SKIP;
      more.push(pick);
    } else if (m.op === 'set') {
      const pick = more.find((p) => p.id === id);
      if (!pick) return SKIP;
      const patch = m.patch || {};
      if ('options' in patch) pick.options = U.cleanOptions(patch.options);
      if ('qty' in patch) pick.qty = Math.max(1, Math.min(99, parseInt(patch.qty, 10) || 1));
      if ('status' in patch && U.STATUSES[patch.status]) pick.status = patch.status;
    } else if (m.op === 'remove') {
      const pick = more.find((p) => p.id === id);
      if (!pick) return SKIP;
      more = more.filter((p) => p !== pick);
      if (more.length) it.more = more;
      else delete it.more;
      it.updatedAt = Date.now();
      return { ok: true, removed: pick };
    } else return SKIP;
    it.more = more;
    it.updatedAt = Date.now();
    return { ok: true, id };
  });
}

function removeItems(keys) {
  return mutateItems((items, tombs) => {
    const removed = [];
    for (const key of keys) {
      if (!items[key]) continue;
      removed.push(items[key]);
      delete items[key];
      tombs[key] = Date.now();
    }
    for (const k in tombs) if (Date.now() - tombs[k] > 45 * DAY) delete tombs[k];
    return removed.length ? { ok: true, removed } : SKIP;
  });
}

/** Rebuild an item from untrusted data (a backup file, an undo payload). Returns null if it cannot be one. */
function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') return null;
  const base = L.keyToItem(raw.key);
  if (!base) return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  const it = {
    key: base.key, platform: base.platform, id: base.id, url: base.url,
    label: str(raw.label, 200), customTitle: str(raw.customTitle, 200), title: str(raw.title, 200), titleEn: str(raw.titleEn, 200),
    price: typeof raw.price === 'number' && isFinite(raw.price) && raw.price >= 0 && raw.price < 1e7 ? raw.price : null,
    image: /^https:\/\//.test(str(raw.image, 500)) ? str(raw.image, 500) : '',
    seller: raw.seller && typeof raw.seller === 'object' && typeof raw.seller.key === 'string' && raw.seller.key
      ? { key: raw.seller.key.slice(0, 80), name: str(raw.seller.name, 60) || raw.seller.key.slice(0, 60) } : null,
    note: str(raw.note, 2000), tags: U.normalizeTags(Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === 'string') : []),
    folder: str(raw.folder, 30).trim() || 'Inbox', status: U.STATUSES[raw.status] ? raw.status : 'saved',
    qty: Math.max(1, Math.min(99, parseInt(raw.qty, 10) || 1)),
    sources: Array.isArray(raw.sources) ? raw.sources.map(cleanCtx).filter(Boolean).slice(0, 8) : [],
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === 'string' && L.keyToItem(a)).slice(0, 5) : [],
    addedAt: num(raw.addedAt) || Date.now(), updatedAt: num(raw.updatedAt) || Date.now(), viewedAt: num(raw.viewedAt),
    check: raw.check && typeof raw.check === 'object' && ['ok', 'soldout', 'gone'].includes(raw.check.state) ? { state: raw.check.state, at: num(raw.check.at) } : null,
  };
  if (raw.priceEdited === true && it.price != null) it.priceEdited = true;
  if (raw.pending === true && it.platform === 'yupoo') it.pending = true;
  if (raw.cut === 1 || raw.cut === 2 || raw.cut === 3) it.cut = raw.cut;
  if (it.cut && typeof raw.cutName === 'string') it.cutName = raw.cutName.slice(0, 12);
  if (it.cut && typeof raw.cutNote === 'string') it.cutNote = raw.cutNote.slice(0, 12);
  if (typeof raw.kind === 'string' && (U.KINDS[raw.kind] || raw.kind === 'other')) it.kind = raw.kind;
  if (typeof raw.size === 'string' && raw.size.trim()) it.size = raw.size.trim().slice(0, 40);
  if (typeof raw.style === 'string' && raw.style.trim()) it.style = raw.style.trim().slice(0, 40);
  const options = U.cleanOptions(raw.options);
  if (options.length) it.options = options;
  const choices = U.cleanChoices(raw.choices);
  if (choices.length) {
    it.choices = choices;
    it.choicesFrom = raw.choicesFrom === 'agent' ? 'agent' : 'weidian';
  }
  if (typeof raw.optsAt === 'number' && raw.optsAt > 0) it.optsAt = raw.optsAt;
  const wd = U.cleanChoices(raw.wd);
  if (wd.length) it.wd = wd;
  const more = U.cleanMore(raw.more);
  if (more.length) it.more = more;
  const weight = parseInt(raw.weight, 10);
  if (weight > 0 && weight <= 30000) it.weight = weight;
  return it;
}

/** Put back items (undo delete, import). Existing items win unless the incoming copy is newer and `preferIncoming` is set. */
function restoreItems(list, preferIncoming) {
  return mutateItems((items, tombs) => {
    let n = 0;
    for (const raw of Array.isArray(list) ? list.slice(0, 5000) : []) {
      const it = sanitizeItem(raw);
      if (!it) continue;
      const cur = items[it.key];
      if (cur && !(preferIncoming && it.updatedAt > (cur.updatedAt || 0))) continue;
      for (const s of it.sources) s.addedAt = it.addedAt;
      // If this item was deleted here before, other devices have heard about that deletion (or will).
      // Stamping the restore as "now" makes it the newer event everywhere.
      if (tombs[it.key]) it.updatedAt = Date.now();
      items[it.key] = it;
      delete tombs[it.key];
      n++;
    }
    return n ? { ok: true, count: n } : SKIP;
  }).then(async (r) => {
    await ensureFolders();
    return r || { ok: true, count: 0 };
  });
}

/** Make sure every folder an item sits in exists in the folder list. */
function ensureFolders() {
  return locked(async () => {
    const data = await chrome.storage.local.get(['items', 'folders']);
    const folders = (data.folders || U.DEFAULT_FOLDERS).slice();
    let changed = !data.folders;
    for (const it of Object.values(data.items || {})) {
      if (it.folder && !folders.includes(it.folder)) {
        folders.push(it.folder);
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ folders });
  });
}

async function setFolders(list, renames) {
  const clean = [];
  for (const f of list || []) {
    const name = String(f).trim().slice(0, 30);
    if (name && !clean.includes(name)) clean.push(name);
  }
  if (!clean.length) clean.push('Inbox');
  await locked(() => chrome.storage.local.set({ folders: clean }));
  await mutateItems((items) => {
    let n = 0;
    for (const it of Object.values(items)) {
      const to = renames && renames[it.folder] ? renames[it.folder] : clean.includes(it.folder) ? null : clean[0];
      if (to && to !== it.folder) {
        it.folder = to;
        it.updatedAt = Date.now();
        n++;
      }
    }
    return n ? true : SKIP;
  });
  return { ok: true, folders: clean };
}

// -------------------------------------------------- lookups for page badges

async function lookup(keys, detail) {
  const data = await chrome.storage.local.get(['items', 'seen', 'sellers', 'previews']);
  const items = data.items || {};
  const seen = data.seen || {};
  const sellers = data.sellers || {};
  const previews = data.previews || {};
  const alias = {};
  for (const k in items) for (const a of items[k].aliases || []) alias[a] = k;
  const out = {};
  for (const key of (keys || []).slice(0, 800)) {
    const ik = items[key] ? key : alias[key];
    const it = ik ? items[ik] : null;
    const s = seen[key] || (ik && seen[ik]) || null;
    const sellerKey = it && it.seller ? it.seller.key : key.startsWith('yupoo:') ? 'yupoo:' + key.slice(6).split('/')[0] : previews[key] && previews[key].seller ? previews[key].seller.key : null;
    const info = {};
    if (it) {
      info.saved = true;
      info.itemKey = ik;
      if (it.status !== 'saved') info.status = it.status;
      if (it.check && it.check.state !== 'ok') info.state = it.check.state;
      // The listing you are on: every pick from it, for the bar's list of what is in the cart.
      if (key === detail) info.picks = itemPicks(it);
    }
    if ((it && it.viewedAt) || (s && s.v)) info.viewed = true;
    if (s && s.p && s.p.length > 1) info.mentions = s.p.length;
    if (sellerKey && sellers[sellerKey] && sellers[sellerKey].trusted) info.trusted = true;
    if (Object.keys(info).length) out[key] = info;
  }
  return out;
}

// ----------------------------------------------- gallery photos and their links
// A Reddit gallery photo with no link of its own: the page asks which of the post's links it shows. These
// give it each link's name, price and pictures, the pictures' bytes (the page cannot read pictures from
// other sites itself), and the matcher, which is put into the tab only when it is asked for.

/** For each link (up to 25): { key, title, price, image, pics } from what RepHop knows or looks up. */
async function photoInfo(m) {
  const urls = Array.isArray(m.urls) ? m.urls.filter((u) => typeof u === 'string').slice(0, 25) : [];
  const list = await pool(urls, 3, async (url) => {
    const target = L.parseLink(url);
    if (!target) return null;
    const res = await resolveLink(target, false, { hover: true }).catch(() => null);
    if (!res || !res.ok) return { key: target.key, title: '', price: null, image: '', pics: [] };
    const key = res.item.key;
    const p = Object.assign({}, res.meta, (await getPreview(key).catch(() => null)) || {});
    const pics = [];
    for (const u of [p.image].concat(...U.cleanChoices(p.choices).map((c) => c.i || []))) {
      const url2 = U.choiceImage(u);
      if (url2 && !pics.includes(url2)) pics.push(url2);
      if (pics.length >= 4) break;
    }
    return { key, title: p.titleEn || p.title || '', price: typeof p.price === 'number' ? p.price : null, image: p.image || '', pics };
  });
  return { ok: true, list };
}

/** The bytes of up to 12 pictures, as base64: [{ b64, type }] (null for one that could not be read). */
async function fetchPics(m) {
  const urls = Array.isArray(m.urls) ? m.urls.filter((u) => typeof u === 'string').slice(0, 12) : [];
  const list = await pool(urls, 4, async (raw) => {
    const u = L.toUrl(raw);
    if (!u || u.protocol !== 'https:') return null;
    // Small copies where the host makes them; otherwise the picture as it is (never more than 3 MB).
    const url = L.hostMatches(u.hostname, ['geilicdn.com']) ? U.thumbUrl(u.href, 240) : u.href;
    try {
      const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', signal: AbortSignal.timeout(15000) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !/^image\//.test(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 3e6) return null;
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { b64: btoa(bin), type };
    } catch (_) {
      return null;
    }
  });
  return { ok: true, list };
}

/** Put the matcher (the image model and its code) into the tab that asks for it. */
async function loadMatcher(sender) {
  if (!sender.tab) return { ok: false };
  await chrome.scripting.executeScript({ target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] }, files: ['content/match-pre.js', 'lib/vendor/tf.min.js', 'content/match.js'] });
  return { ok: true };
}

/** An item's picks in one list: the first (id '') and the others. */
function itemPicks(it) {
  return [{ id: '', options: it.options || [], qty: it.qty || 1, status: it.status || 'saved', img: U.pickImage(it, null, null) }]
    .concat(U.cleanMore(it.more).map((p) => ({ id: p.id, options: p.options, qty: p.qty, status: p.status, img: U.pickImage(it, p, null) })));
}

/** Two sets of choices are the same pick when every row both name holds the same choice (in either language). */
function samePick(a, b) {
  const x = U.cleanOptions(a);
  const y = U.cleanOptions(b);
  if (!x.length || !y.length) return false;
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let compared = 0;
  for (const o of x) {
    const other = y.find((p) => norm(p.n) === norm(o.n)) || (x.length === 1 && y.length === 1 ? y[0] : null);
    if (!other) continue;
    compared++;
    if (norm(o.v) !== norm(other.v) && U.pickRemembered([{ text: other.v }], o.v) !== 0) return false;
  }
  return compared > 0 && compared === Math.min(x.length, y.length);
}

/**
 * You pressed the agent's own Add To Cart on a listing in your list. What you had chosen there is marked as in
 * the cart: the pick it matches, or the first pick if that one was still to add; anything else becomes a new pick,
 * so a second colour never replaces the first.
 */
function cartByHand(m) {
  const picked = U.cleanOptions(m.options);
  return mutateItems((items) => {
    const k = findKey(items, String(m.key || ''));
    const it = k && items[k];
    if (!it) return SKIP;
    const more = U.cleanMore(it.more);
    const now = Date.now();
    if (!picked.length || samePick(it.options || [], picked)) {
      if (it.status === 'carted' || it.status === 'bought') return SKIP;
      it.status = 'carted';
      if (picked.length) it.options = picked;
      it.updatedAt = now;
      return { ok: true, pick: '', was: 'saved' };
    }
    const match = more.find((p) => samePick(p.options, picked));
    if (match) {
      if (match.status === 'carted' || match.status === 'bought') return SKIP;
      match.status = 'carted';
      match.options = picked;
      it.more = more;
      it.updatedAt = now;
      return { ok: true, pick: match.id, was: 'saved' };
    }
    if (it.status === 'saved' && !more.length) {
      // Nothing was added from this listing yet: what you chose is the item's own pick.
      it.status = 'carted';
      it.options = picked;
      it.updatedAt = now;
      return { ok: true, pick: '', was: 'saved' };
    }
    if (more.length >= U.MAX_MORE) return SKIP;
    const id = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
    more.push({ id, options: picked, qty: 1, status: 'carted' });
    it.more = more;
    it.updatedAt = now;
    return { ok: true, pick: id, was: 'new' };
  });
}

// ------------------------------------------------------------- the agent's cart
// The lines of Superbuy's cart page, read there by the content script. Each one is saved like any other link (the
// listing it came from), then its pick is marked in cart with the choices and quantity from the cart, so a haul put
// together at the agent shows up in the list without saving it all again by hand. Doing it twice changes nothing.
const CART_PAGE = 'https://www.superbuy.com/en/page/shoppingcart/';

function cleanCartRow(r) {
  if (!r || typeof r !== 'object' || typeof r.url !== 'string' || r.url.length > 2000) return null;
  const parsed = L.parseLink(r.url);
  if (!parsed || parsed.kind !== 'item') return null;
  const s = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const price = r.price == null || r.price === '' ? NaN : Number(r.price);
  let image = s(r.image, 500);
  if (image.startsWith('//')) image = 'https:' + image;
  return {
    url: r.url, key: parsed.key, title: s(r.title, 200), sku: s(r.sku, 400), note: s(r.note, 300),
    qty: Math.max(1, Math.min(99, parseInt(r.qty, 10) || 1)),
    price: price >= 0 && price < 1e7 ? price : null,
    image: /^https:\/\/[^\s"'<>]+$/.test(image) ? image : '',
  };
}

async function importCartTab() {
  const tab = await chrome.tabs.create({ url: CART_PAGE, active: true });
  await chrome.storage.session.set({ cartImport: { tabId: tab.id, at: Date.now() } });
  return { ok: true };
}

function agentNameFor(host) {
  for (const a of Object.values(L.AGENTS)) {
    const u = a.template && L.toUrl(a.template.replace(/\{[^}]+\}/g, 'x'));
    if (u && L.hostMatches(String(host || ''), [u.hostname.replace(/^www\./, '')])) return a.name;
  }
  return '';
}

async function importCart(m, s) {
  if (s && s.tab) {
    const ci = (await chrome.storage.session.get('cartImport')).cartImport;
    if (ci && ci.tabId === s.tab.id) await chrome.storage.session.remove('cartImport');
  }
  const site = typeof m.site === 'string' ? m.site.slice(0, 60) : '';
  const name = agentNameFor(site) || 'agent';
  const page = L.toUrl(m.cartUrl);
  const cartUrl = page && site && L.hostMatches(page.hostname.replace(/^www\./, ''), [site]) ? page.href.slice(0, 400) : CART_PAGE;
  const rows = (Array.isArray(m.rows) ? m.rows : []).slice(0, 300).map(cleanCartRow).filter(Boolean);
  const unread = Math.max(0, (Array.isArray(m.rows) ? m.rows.length : 0) - rows.length) + (parseInt(m.unread, 10) || 0);
  // the whole cart was read (so what is missing from it has left it): Superbuy's own layout only
  const full = !!m.full;
  if (!rows.length && !(full && m.empty)) return { ok: false, message: 'RepHop could not read any listing in this cart.' };
  const before = await get('items', {});
  const had = new Set(rows.filter((r) => findKey(before, r.key)).map((r) => r.key));
  const ctx = { site, postTitle: 'Your ' + name + ' cart', postUrl: cartUrl };
  const saved = rows.length ? await saveEntries(rows.map((r) => ({ url: r.url, ctx }))) : { failed: 0 };
  const sum = { lines: rows.length, fresh: 0, picks: 0, updated: 0, already: 0, full: 0, failed: saved.failed + unread };
  const present = new Set((Array.isArray(m.present) ? m.present : []).filter((k) => typeof k === 'string').slice(0, 300));
  const since = Number(m.since) || 0;
  const ignore = await get('cartStaleIgnore', {});
  const ignored = (key, pick) => Date.now() - (ignore[key + '|' + pick] || 0) < 30 * DAY;
  let stale = [];
  await mutateItems((items) => {
    const used = new Map(); // item -> its picks this import has filled ('' is the item's own)
    let changed = false;
    const now = Date.now();
    for (const r of rows) {
      const k = findKey(items, r.key);
      const it = k && items[k];
      if (!it) continue;
      const taken = used.get(it.key) || new Set();
      used.set(it.key, taken);
      const picked = U.skuOptions(r.sku, (it.choices || []).map((c) => c.n));
      const more = U.cleanMore(it.more);
      const fits = (opts) => (picked.length ? samePick(opts || [], picked) : !(opts || []).length);
      let pick = null;
      let created = false;
      if (!taken.has('') && fits(it.options)) pick = '';
      else {
        const p = more.find((x) => !taken.has(x.id) && fits(x.options));
        if (p) pick = p.id;
      }
      // nothing from this listing was in the cart yet: the cart's choice is the item's own
      if (pick == null && !taken.has('') && it.status === 'saved' && !more.length) pick = '';
      if (pick == null) {
        if (more.length >= U.MAX_MORE) {
          sum.full++;
          continue;
        }
        pick = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
        more.push({ id: pick, options: [], qty: 1, status: 'saved' });
        created = true;
      }
      taken.add(pick);
      const target = pick ? more.find((x) => x.id === pick) : it;
      const was = JSON.stringify([target.options || [], target.qty || 1, target.status]);
      if (picked.length) target.options = picked;
      target.qty = r.qty;
      if (target.status !== 'bought') target.status = 'carted';
      if (pick) it.more = more;
      const now2 = JSON.stringify([target.options || [], target.qty || 1, target.status]);
      if (!had.has(r.key)) sum.fresh++;
      else if (created) sum.picks++;
      else if (was === now2) sum.already++;
      else sum.updated++;
      if (was !== now2) {
        changed = true;
        it.updatedAt = now;
      }
      // what the cart knows that the list does not yet
      const fill = (f, v) => {
        if (it[f] || v == null || v === '') return;
        it[f] = v;
        changed = true;
      };
      if (!it.customTitle) fill('title', r.title);
      fill('price', r.price);
      fill('image', r.image);
      fill('note', r.note);
    }
    if (full) {
      // In cart in the list, but not in the cart: you are asked (bought? back to saved?), nothing is changed here.
      for (const it of Object.values(items)) {
        if (it.platform === 'yupoo' || present.has(it.key) || (it.aliases || []).some((a) => present.has(a))) continue;
        const taken = used.get(it.key);
        // marked after this cart page was drawn: the page cannot know about it yet
        if (!taken && since && it.updatedAt > since) continue;
        const label = (opts) => U.displayTitle(it) + (opts && opts.length ? ' (' + opts.map((o) => o.v).join(' · ') + ')' : '');
        if (it.status === 'carted' && !(taken && taken.has('')) && !ignored(it.key, '')) stale.push({ key: it.key, pick: '', title: label(it.options) });
        for (const p of U.cleanMore(it.more)) {
          if (p.status === 'carted' && !(taken && taken.has(p.id)) && !ignored(it.key, p.id)) stale.push({ key: it.key, pick: p.id, title: label(p.options) });
        }
      }
      stale = stale.slice(0, 100);
    }
    return changed ? true : SKIP;
  });
  const changed = sum.fresh + sum.picks + sum.updated > 0;
  return { ok: true, sum, stale, agent: name, changed, message: describeCartImport(sum, name, !!m.auto) };
}

function describeCartImport(sum, name, auto) {
  if (!sum.lines) return '';
  const n = (x, one, many) => x + ' ' + (x === 1 ? one : many);
  const parts = [];
  if (sum.fresh) parts.push(sum.fresh + ' new');
  if (sum.picks) parts.push(n(sum.picks, 'more colour or size', 'more colours or sizes') + ' of things you had saved');
  if (sum.updated) parts.push(sum.updated + ' updated');
  if (sum.already) parts.push(sum.already + ' already there');
  const changed = sum.fresh || sum.picks || sum.updated;
  let msg = changed && auto
    ? 'Synced with your ' + name + ' cart: ' + n(sum.lines, 'item', 'items') + ' marked In cart' + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.'
    : (changed ? 'Your ' + name + ' cart is in your list, marked In cart: ' : 'Your list already has everything in this cart: ') + n(sum.lines, 'item', 'items') + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.';
  if (sum.failed) msg += ' ' + n(sum.failed, 'item', 'items') + ' could not be read.';
  if (sum.full) msg += ' ' + n(sum.full, 'item was', 'items were') + ' left out: a listing can hold 10 picks.';
  return msg;
}

/** Your answer about things marked In cart that have left the cart: bought, back to saved, or leave them be. */
async function cartStale(m) {
  const list = (Array.isArray(m.list) ? m.list : []).slice(0, 300).filter((x) => x && typeof x.key === 'string').map((x) => ({ key: x.key, pick: typeof x.pick === 'string' ? x.pick : '' }));
  if (!list.length) return { ok: false };
  if (m.op === 'leave') {
    // not asked again about these for a month
    await mutate('cartStaleIgnore', {}, (ig) => {
      const now = Date.now();
      for (const x of list) ig[x.key + '|' + x.pick] = now;
      for (const k of Object.keys(ig)) if (now - ig[k] > 30 * DAY) delete ig[k];
    });
    return { ok: true };
  }
  const status = m.op === 'bought' ? 'bought' : 'saved';
  const r = await mutateItems((items) => {
    let n = 0;
    for (const x of list) {
      const k = findKey(items, x.key);
      const it = k && items[k];
      if (!it) continue;
      const more = U.cleanMore(it.more);
      const target = x.pick ? more.find((p) => p.id === x.pick) : it;
      if (!target || target.status !== 'carted') continue;
      target.status = status;
      if (x.pick) it.more = more;
      it.updatedAt = Date.now();
      n++;
    }
    return n ? { ok: true, count: n } : SKIP;
  });
  return r || { ok: true, count: 0 };
}

/**
 * Mark items as in your cart (or bought, or saved) without RepHop adding anything: for things you added at the
 * agent yourself. With `all` every pick on the item is marked too; marking In cart never undoes Bought. Returns what
 * each was before, which `restore` puts back (Undo).
 */
function markItems(m) {
  return mutateItems((items) => {
    if (m.restore && typeof m.restore === 'object') {
      let n = 0;
      for (const [key, b] of Object.entries(m.restore).slice(0, 2000)) {
        const it = items[key];
        if (!it || !b || typeof b !== 'object') continue;
        if (U.STATUSES[b.s]) it.status = b.s;
        const more = U.cleanMore(it.more);
        for (const p of more) if (b.m && U.STATUSES[b.m[p.id]]) p.status = b.m[p.id];
        if (more.length) it.more = more;
        it.updatedAt = Date.now();
        n++;
      }
      return n ? { ok: true, count: n } : SKIP;
    }
    const status = U.STATUSES[m.status] ? m.status : null;
    if (!status) return SKIP;
    const before = {};
    let n = 0;
    for (const key of (Array.isArray(m.keys) ? m.keys : []).slice(0, 2000)) {
      const k = findKey(items, String(key));
      const it = k && items[k];
      if (!it || it.platform === 'yupoo') continue;
      const more = U.cleanMore(it.more);
      const ids = typeof m.pick === 'string' && m.pick ? [m.pick] : m.all ? [''].concat(more.map((p) => p.id)) : [''];
      let touched = false;
      for (const id of ids) {
        const target = id ? more.find((p) => p.id === id) : it;
        if (!target || target.status === status || (status === 'carted' && target.status === 'bought')) continue;
        if (!touched) before[it.key] = { s: it.status || 'saved', m: Object.fromEntries(more.map((p) => [p.id, p.status])) };
        touched = true;
        target.status = status;
        n++;
      }
      if (!touched) continue;
      if (more.length) it.more = more;
      it.updatedAt = Date.now();
    }
    return n ? { ok: true, count: n, before } : SKIP;
  });
}

function recordSeen(entries) {
  return mutate('seen', {}, (seen) => {
    let changed = false;
    const now = Date.now();
    for (const e of (entries || []).slice(0, 400)) {
      if (!e || typeof e.key !== 'string' || typeof e.postId !== 'string' || !e.postId) continue;
      const s = seen[e.key] || (seen[e.key] = { p: [] });
      if (!s.p.includes(e.postId)) {
        s.p.push(e.postId);
        if (s.p.length > 30) s.p.shift();
        s.t = now;
        changed = true;
      }
    }
    if (!changed) return SKIP;
    prune(seen, 4000, 't');
    return true;
  }, true);
}

/** Everything the hover card shows about a link. */
async function describe(msg) {
  const target = msg.key ? L.keyToItem(msg.key) : L.parseLink(msg.url);
  if (!target) return { ok: false, reason: 'unsupported' };
  if (target.kind === 'short') {
    // Following a short link costs a request to the shop's site, and a hover is not worth one.
    const known = (await get('resolved', {}))[target.key];
    if (!known || !known.key) return { ok: false, reason: 'short', kind: 'short' };
  }
  const res = await resolveLink(target, false, { hover: true });
  if (!res.ok) return { ok: false, reason: res.reason, kind: target.kind };
  const key = res.item.key;
  const [preview, info, items] = await Promise.all([getPreview(key), lookup([key, target.key]), get('items', {})]);
  const it = items[findKey(items, key)] || null;
  const p = Object.assign({}, res.meta, preview || {});
  return {
    ok: true, key, platform: res.item.platform, noBuyLink: !!res.noBuyLink,
    title: (it && U.displayTitle(it)) || p.titleEn || p.title || '', subtitle: it && it.title && U.displayTitle(it) !== it.title ? it.title : '',
    price: it && it.price != null ? it.price : typeof p.price === 'number' ? p.price : null,
    image: (it && it.image) || p.image || '', state: p.state || '',
    seller: (it && it.seller) || p.seller || null, info: Object.assign({}, info[target.key], info[key]),
  };
}

// -------------------------------------------------------------------- queue

/**
 * "Go through" and "Add to cart for me" share one queue: a list of item keys walked in a single tab.
 * With `auto` set, the page script chooses the options and presses Add To Cart where it can, and reports
 * how each item went in `results` (added / manual / skipped). The queue records which tab it runs in and
 * when the current step began, so only the page loaded for that step, in that tab, acts on it; and it
 * records each Add To Cart press, so no item is pressed twice in a run. When the queue ends, the report
 * is kept as `cartRun` for the panel to show.
 */
// Queue changes run one at a time, so two quick presses cannot both start from the same position.
let queueChain = Promise.resolve();
function queueOp(msg, srcTab) {
  const p = queueChain.then(() => queueOpNow(msg, srcTab));
  queueChain = p.catch(() => {});
  return p;
}

async function queueOpNow(msg, srcTab) {
  let q = await get('queue', null);
  const store = () => locked(() => chrome.storage.local.set({ queue: q }));
  const finish = async (extra) => {
    const summary = q && q.auto !== undefined && q.results && Object.keys(q.results).length ? { at: Date.now(), total: q.keys.length, results: q.results } : null;
    await locked(() => chrome.storage.local.set(Object.assign({ queue: { keys: [], i: 0, active: false } }, summary ? { cartRun: summary } : {})));
    return Object.assign({ ok: true }, extra, summary ? { summary } : {});
  };
  if (msg.op === 'start') {
    if (!L.agentInfo(await getSettings()).chosen) return { ok: false, reason: 'no-agent' };
    // owner[i] says whose item step i is in a group haul: { p: person id, x: item id }; { v: pick id } for one of
    // your item's other picks (a second colour from the same listing); null for your item's first pick.
    const pairs = (msg.keys || []).map((k, i) => [k, Array.isArray(msg.owner) ? msg.owner[i] : null]).filter(([k]) => typeof k === 'string' && L.keyToItem(k));
    if (!pairs.length) return { ok: false, reason: 'empty' };
    q = { keys: pairs.map((x) => x[0]), i: 0, active: true, auto: !!msg.auto, results: {}, pressed: {} };
    const ownerOf = (o) => (o && typeof o.p === 'string' && typeof o.x === 'string' ? { p: o.p, x: o.x } : o && typeof o.v === 'string' && /^[a-z0-9]{4,12}$/.test(o.v) ? { v: o.v } : null);
    if (pairs.some((x) => ownerOf(x[1]))) q.owner = pairs.map((x) => ownerOf(x[1]));
  } else if (!q || !q.active) {
    return { ok: false, reason: 'no-queue' };
  } else {
    if (msg.op === 'press') {
      // The page asks before pressing Add To Cart. It is told yes once per step, and only for the current one.
      const key = String(msg.key || '');
      q.pressed = q.pressed || {};
      if (q.keys[q.i] !== key || q.pressed[q.i]) return { ok: true, first: false };
      q.pressed[q.i] = Date.now();
      await store();
      return { ok: true, first: true };
    }
    // A step sent from position N only counts while the queue is still at N (a second press on "Skip" arrives late).
    if (msg.op === 'step' && typeof msg.at === 'number' && msg.at !== q.i) return { ok: true, stale: true, queue: q };
    if (msg.result && msg.result.key === q.keys[q.i] && ['added', 'manual', 'skipped'].includes(msg.result.r)) {
      q.results = q.results || {};
      q.results[q.i] = msg.result.r;
    }
    if (msg.op === 'stop') return finish({ stopped: true });
    if (msg.op === 'step') {
      const next = q.i + (msg.delta || 1);
      if (next < 0) return { ok: true, edge: 'start', queue: q };
      if (next >= q.keys.length) return finish({ finished: true });
      q.i = next;
    } else if (msg.op === 'goto') q.i = Math.max(0, Math.min(q.keys.length - 1, msg.i | 0));
  }
  // Stamp the step before the tab is pointed at the listing: only a page loaded after this moment acts on it.
  q.stepAt = Date.now();
  delete q.tabId;
  await store();
  const r = await openLink({ key: q.keys[q.i], disposition: 'reuse' }, srcTab);
  if (r.ok && r.tabId != null) {
    const now = await get('queue', null);
    if (now && now.active && now.stepAt === q.stepAt) {
      q = now;
      q.tabId = r.tabId;
      await store();
    }
  }
  return { ok: r.ok, queue: q, reason: r.reason };
}

// -------------------------------------------------------------- group hauls
// One person orders for several friends. Each friend's list arrives as a share code and is kept here,
// apart from your own list: { me, mine, extra, split, people: [{ id, name, at, items: [...] }] }.

const GROUP_MAX_PEOPLE = 12;

function newShareId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function emptyGroup() {
  return { me: '', sid: newShareId(), mine: '*', extra: 0, split: 'even', people: [] };
}

/** The same product, wanted the same way. */
function sameWish(a, b) {
  return a.key === b.key && (a.qty || 1) === (b.qty || 1) && (a.size || '') === (b.size || '') && (a.style || '') === (b.style || '') && JSON.stringify(a.options || []) === JSON.stringify(b.options || []);
}

function personId(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30) || 'friend';
}

/** A friend's list, rebuilt from untrusted data. Every item gets an id of its own (the same link can be in a list twice). */
function cleanPerson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
  const items = [];
  for (const x of Array.isArray(raw.items) ? raw.items.slice(0, 300) : []) {
    const it = U.sharedItem(x);
    if (!it) continue;
    it.uid = String(items.length + 1);
    items.push(it);
  }
  if (!name || !items.length) return null;
  // A code made by RepHop carries the id of the copy that made it; a person is that id, not the name they typed.
  const sid = typeof raw.sid === 'string' && /^[a-z0-9]{6,24}$/i.test(raw.sid) ? raw.sid : '';
  const person = { id: sid ? 's:' + sid : personId(name), name, at: typeof raw.at === 'number' && raw.at > 0 ? raw.at : Date.now(), items };
  if (sid) person.sid = sid;
  return person;
}

/** Names, prices and pictures RepHop already knows are filled into a friend's items. */
function fillShared(it, p) {
  if (!p) return false;
  let changed = false;
  if (!it.title && (p.titleEn || p.title)) {
    it.title = String(p.titleEn || p.title).slice(0, 120);
    changed = true;
  }
  if (it.price == null && typeof p.price === 'number') {
    it.price = p.price;
    changed = true;
  }
  if (!it.image && typeof p.image === 'string' && /^https:\/\//.test(p.image)) {
    it.image = p.image.slice(0, 500);
    changed = true;
  }
  return changed;
}

function fillGroup(key, preview) {
  return mutate('group', null, (g) => {
    if (!g || !Array.isArray(g.people)) return SKIP;
    let n = 0;
    for (const p of g.people) for (const it of p.items) if (it.key === key && fillShared(it, preview)) n++;
    return n ? true : SKIP;
  });
}

async function groupOp(m) {
  let incoming = null;
  if (m.op === 'add' || m.op === 'restore') {
    incoming = cleanPerson(m.person);
    if (!incoming) return { ok: false, reason: 'empty' };
    if (typeof m.liveId === 'string' && m.liveId) {
      incoming.id = 'live:' + m.liveId;
      incoming.live = m.liveId;
      delete incoming.sid;
    }
    const previews = await get('previews', {});
    const items = await get('items', {});
    for (const it of incoming.items) {
      const mine = items[findKey(items, it.key)];
      fillShared(it, previews[it.key] || (mine ? { title: mine.title, titleEn: mine.titleEn, price: mine.price, image: mine.image } : null));
    }
  }
  let out = { ok: true };
  await mutate('group', null, (cur) => {
    // `mutate` stores the object it handed us, so the group is edited in place.
    const g = cur && Array.isArray(cur.people) ? cur : null;
    if (!g) return SKIP;
    const person = (id) => g.people.find((p) => p.id === id);
    if (incoming) {
      const at = g.people.findIndex((p) => p.id === incoming.id);
      if (at === -1 && g.people.length >= GROUP_MAX_PEOPLE) return void (out = { ok: false, reason: 'full' }) || SKIP;
      let kept = 0;
      if (at !== -1) {
        // A newer list from the same person: what is already in the cart stays marked, as long as it is
        // still wanted the same way. Anything changed or new comes in unmarked.
        const old = g.people[at].items.slice();
        for (const it of incoming.items) {
          const i = old.findIndex((x) => x.status !== 'saved' && sameWish(x, it));
          if (i === -1) continue;
          it.status = old[i].status;
          if (old[i].added) it.added = old[i].added;
          old.splice(i, 1);
          kept++;
        }
      } else {
        // Someone else with the same name is a different person: they are added beside the first, not over them.
        const taken = (n) => g.people.some((p) => p.name.toLowerCase() === n.toLowerCase());
        const base = incoming.name;
        for (let n = 2; taken(incoming.name) && n < 20; n++) incoming.name = base.slice(0, 26) + ' (' + n + ')';
      }
      out = { ok: true, id: incoming.id, name: incoming.name, count: incoming.items.length, kept, replaced: at !== -1 ? g.people[at] : null };
      if (at !== -1) g.people[at] = incoming;
      else g.people.push(incoming);
      return true;
    }
    if (m.op === 'remove') {
      const p = person(m.id);
      if (!p) return SKIP;
      g.people = g.people.filter((x) => x !== p);
      out = { ok: true, removed: p };
      return true;
    }
    if (m.op === 'removeItem' || m.op === 'mark') {
      const p = person(m.id);
      const it = p && p.items.find((x) => x.uid === m.uid);
      if (!it) return void (out = { ok: false, reason: 'missing' }) || SKIP;
      if (m.op === 'removeItem') {
        p.items = p.items.filter((x) => x !== it);
        if (!p.items.length) g.people = g.people.filter((x) => x !== p);
      } else {
        if (['saved', 'carted', 'bought'].includes(m.status)) it.status = m.status;
        const options = U.cleanOptions(m.options);
        if (options.length && it.status !== 'saved') it.added = options;
        if (it.status === 'saved') delete it.added;
      }
      return true;
    }
    if (m.op === 'set') {
      const p = m.patch || {};
      if (typeof p.me === 'string') g.me = p.me.replace(/\s+/g, ' ').trim().slice(0, 30);
      if (typeof p.mine === 'string') g.mine = p.mine.slice(0, 30);
      if ('extra' in p) g.extra = Math.max(0, Math.min(1e6, Math.round((parseFloat(p.extra) || 0) * 100) / 100));
      if (p.split === 'even' || p.split === 'cost' || p.split === 'weight') g.split = p.split;
      out = { ok: true, sid: g.sid };
      return true;
    }
    if (m.op === 'clear') {
      g.people = [];
      return true;
    }
    return SKIP;
  }).catch(() => (out = { ok: false, reason: 'error' }));
  if (out.ok && incoming) incoming.items.filter((it) => !it.image || it.price == null || !it.title).slice(0, 40).forEach((it) => queuePreview(it.key));
  return out;
}

/** The group record exists from the first time it is needed, so edits always have something to work on. */
async function ensureGroup() {
  await locked(async () => {
    const g = await get('group', null);
    if (!g || !Array.isArray(g.people)) await chrome.storage.local.set({ group: emptyGroup() });
    else if (!g.sid) await chrome.storage.local.set({ group: Object.assign(g, { sid: newShareId() }) });
  });
}

// ------------------------------------------------------- live group hauls
// A live haul keeps everyone's list up to date through a relay (see lib/live.js). This browser is
// either the host of one haul or a member of one, and `group.live` says which:
//   host:   { role, relay, room, key, secret, name, at, members: { id: { name, status, listAt } }, sent: { id: hash } }
//   member: { role, relay, room, key, secret, mid, name, host, scope, status, inbox, sentHash, at }
// A member's list goes to the host only. The host sends each member what is in the cart and what they
// owe. Everything is encrypted before it leaves; the relay cannot read any of it.

function liveOf(g) {
  return g && g.live && g.live.room ? g.live : null;
}

/** Change the stored live record. `fn` gets the record (or null) and the group; returning false changes nothing. */
function editLive(fn) {
  return mutate('group', null, (g) => {
    if (!g || !Array.isArray(g.people)) return SKIP;
    return fn(liveOf(g), g) === false ? SKIP : true;
  });
}

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 30) : '');

/** The part of your own list that takes part in a haul. scope: '*' for everything, a folder name, or '' for nothing. */
function haulItems(items, scope) {
  if (scope === '') return [];
  return Object.values(items || {})
    .filter((it) => it.platform !== 'yupoo' && (it.status !== 'bought' || (it.more || []).some((p) => p.status !== 'bought')) && (scope == null || scope === '*' || it.folder === scope))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/** Your items for the haul's totals: each other pick from a listing counts as an item of its own. */
function withPicks(items) {
  const out = [];
  for (const it of items) {
    if (it.status !== 'bought') out.push(it);
    for (const p of it.more || []) if (p.status !== 'bought') out.push(Object.assign({}, it, { qty: p.qty || 1, options: p.options || [], status: p.status, more: undefined }));
  }
  return out;
}

/** What the host told a member, rebuilt from untrusted data. */
function cleanNote(raw) {
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e9 ? v : null);
  const marks = [];
  for (const m of Array.isArray(raw.marks) ? raw.marks.slice(0, 300) : []) {
    if (!Array.isArray(m) || typeof m[0] !== 'string' || !L.keyToItem(m[0])) continue;
    marks.push([m[0], m[1] === 'carted' || m[1] === 'bought' ? m[1] : 'saved', Math.max(1, Math.min(99, parseInt(m[2], 10) || 1))]);
  }
  return {
    host: cleanName(raw.host), cur: /^[A-Z]{3}$/.test(raw.cur || '') ? raw.cur : 'CNY', marks,
    yuan: num(raw.yuan), items: num(raw.items), share: num(raw.share), owes: num(raw.owes), extra: num(raw.extra),
    split: raw.split === 'cost' || raw.split === 'weight' ? raw.split : 'even', people: Math.max(1, Math.min(99, parseInt(raw.people, 10) || 1)), at: num(raw.at) || 0,
  };
}

/** The haul is over for this browser: the room is gone, or the host took this member out. */
function liveGone(room) {
  return editLive((live, g) => {
    if (!live || live.room !== room) return false;
    if (live.role === 'member') live.status = 'gone';
    else {
      // Lists that were live stay, as ordinary lists.
      for (const p of g.people) delete p.live;
      delete g.live;
    }
  });
}

/** Member: send my list to the host, if it changed. */
async function pushMine() {
  const data = await chrome.storage.local.get(['group', 'items', 'settings']);
  const live = liveOf(data.group);
  if (!live || live.role !== 'member' || live.status !== 'ok') return;
  const obj = U.packShare(live.name, haulItems(data.items, live.scope), U.mergeSettings(data.settings));
  const hash = U.textHash(JSON.stringify([obj.name, obj.items]));
  if (hash === live.sentHash) return;
  const res = await V.call(live, 'list', { method: 'PUT', body: { blob: await V.seal(live.key, V.about(live, live.mid, 'list'), obj) } });
  if (res.http === 401 || res.http === 404) return void (await liveGone(live.room));
  if (!res.ok) return;
  await editLive((cur) => {
    if (!cur || cur.room !== live.room) return false;
    cur.sentHash = hash;
  });
}

/** Host: tell each member what is in the cart and what they owe, if it changed. */
async function pushNotes() {
  const data = await chrome.storage.local.get(['group', 'items', 'settings', 'rates']);
  const g = data.group;
  const live = liveOf(g);
  if (!live || live.role !== 'host') return;
  const settings = U.mergeSettings(data.settings);
  const mine = withPicks(haulItems(data.items, g.mine == null ? '*' : g.mine));
  const people = (mine.length ? [{ id: '', name: live.name, items: mine }] : []).concat(g.people);
  const tot = U.groupTotals(people, data.rates, settings.currency, g.extra || 0, g.split, settings);
  const sent = {};
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const member = p.live && live.members ? live.members[p.live] : null;
    if (!member || member.status !== 'ok') continue;
    const row = tot.rows[i];
    const note = {
      host: live.name, cur: settings.currency, marks: p.items.map((it) => [it.key, it.status || 'saved', it.qty || 1]),
      yuan: row.yuan, items: row.items, share: row.share, owes: row.owes, extra: tot.extra, split: g.split === 'cost' || g.split === 'weight' ? g.split : 'even', people: people.length, grams: row.grams,
    };
    const hash = U.textHash(JSON.stringify(note));
    if ((live.sent || {})[p.live] === hash) continue;
    const blob = await V.seal(live.key, V.about(live, p.live, 'inbox'), Object.assign({ at: Date.now() }, note));
    const res = await V.call(live, 'inbox', { method: 'PUT', body: { id: p.live, blob } });
    if (res.ok) sent[p.live] = hash;
  }
  if (!Object.keys(sent).length) return;
  await editLive((cur) => {
    if (!cur || cur.room !== live.room) return false;
    cur.sent = Object.assign({}, cur.sent, sent);
  });
}

/** Fetch what the relay holds for this browser and take it in. Called when the list opens and whenever the relay says something changed. */
async function liveSync() {
  const live = liveOf(await get('group', null));
  if (!live || live.status === 'gone') return { ok: true, live: false };
  const res = await V.call(live, 'state', { method: 'GET' });
  if (res.http === 401 || res.http === 404) {
    await liveGone(live.room);
    return { ok: true, gone: true };
  }
  if (!res.ok) return { ok: false, reason: 'relay' };

  if (live.role === 'member') {
    const raw = res.inbox ? await V.open(live.key, V.about(live, live.mid, 'inbox'), res.inbox) : null;
    const note = raw && typeof raw === 'object' ? cleanNote(raw) : null;
    await editLive((cur) => {
      if (!cur || cur.room !== live.room) return false;
      const before = JSON.stringify([cur.status, cur.inbox]);
      cur.status = res.status === 'ok' ? 'ok' : 'pending';
      if (note) cur.inbox = note;
      return JSON.stringify([cur.status, cur.inbox]) !== before;
    });
    await pushMine();
    return { ok: true };
  }

  const members = Object.assign({}, live.members);
  const seen = new Set();
  for (const mb of Array.isArray(res.members) ? res.members.slice(0, 40) : []) {
    if (!mb || typeof mb.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(mb.id)) continue;
    seen.add(mb.id);
    const known = members[mb.id] || {};
    let name = known.name;
    if (!name) {
      const hello = await V.open(live.key, V.about(live, mb.id, 'hello'), mb.hello);
      name = cleanName(hello && hello.name) || 'Friend';
    }
    const next = { name, status: mb.status === 'ok' ? 'ok' : 'pending', at: mb.at || 0, listAt: known.listAt || 0 };
    if (next.status === 'ok' && mb.list && mb.listAt && mb.listAt !== known.listAt) {
      const shared = U.unpackShare(await V.open(live.key, V.about(live, mb.id, 'list'), mb.list));
      if (shared) {
        if (shared.items.length) await groupOp({ op: 'add', person: { name, items: shared.items, at: mb.listAt }, liveId: mb.id });
        else await groupOp({ op: 'remove', id: 'live:' + mb.id });
        next.listAt = mb.listAt;
      }
    }
    members[mb.id] = next;
  }
  // Someone the relay no longer lists has left.
  for (const id of Object.keys(members)) {
    if (seen.has(id)) continue;
    delete members[id];
    await groupOp({ op: 'remove', id: 'live:' + id });
  }
  await editLive((cur) => {
    if (!cur || cur.room !== live.room || JSON.stringify(cur.members || {}) === JSON.stringify(members)) return false;
    cur.members = members;
  });
  await pushNotes();
  return { ok: true };
}

async function liveOp(m) {
  await ensureGroup();
  const g = await get('group', null);
  const live = liveOf(g);
  const name = cleanName(m.name);

  if (m.op === 'host') {
    if (live) return { ok: false, reason: 'busy' };
    if (!name) return { ok: false, reason: 'name' };
    // Your own relay if you named one in Settings, otherwise the one built into this copy of RepHop.
    const relay = V.relayUrl((await getSettings()).relay) || V.relayUrl(U.DEFAULT_RELAY);
    if (!relay) return { ok: false, reason: 'no-relay' };
    const next = { role: 'host', relay, room: V.rand(16), key: V.rand(32), secret: V.rand(24), name, at: Date.now(), members: {}, sent: {} };
    const res = await V.call(next, 'create', { auth: false, body: { hostHash: await V.sha256(next.secret) } });
    if (!res.ok) return { ok: false, reason: 'relay', http: res.http };
    await editLive((cur, grp) => {
      grp.live = next;
      grp.me = name;
    });
    return { ok: true, invite: V.makeInvite(next) };
  }

  if (m.op === 'join') {
    if (live) return { ok: false, reason: 'busy' };
    if (!name) return { ok: false, reason: 'name' };
    const inv = V.readInvite(m.invite);
    if (!inv) return { ok: false, reason: 'invite' };
    const scope = typeof m.scope === 'string' ? m.scope.slice(0, 30) : '*';
    const next = { role: 'member', relay: inv.relay, room: inv.room, key: inv.key, host: inv.name, mid: V.rand(12), secret: V.rand(24), name, scope, status: 'pending', inbox: null, at: Date.now() };
    // Only the name goes with the request. The list follows once the host has let this browser in.
    const hello = await V.seal(next.key, V.about(next, next.mid, 'hello'), { name });
    const res = await V.call(next, 'join', { auth: false, body: { id: next.mid, hash: await V.sha256(next.secret), hello } });
    if (!res.ok) return { ok: false, reason: res.error === 'full' ? 'full' : res.http === 404 ? 'ended' : 'relay' };
    await editLive((cur, grp) => {
      grp.live = next;
      grp.me = name;
    });
    return { ok: true, status: 'pending', host: inv.name };
  }

  if (!live) return { ok: false, reason: 'no-live' };
  if (m.op === 'sync') return liveSync();
  if (m.op === 'socket') return live.status === 'gone' ? { ok: false } : Object.assign({ ok: true }, V.socket(live));

  if (live.role === 'member') {
    if (m.op === 'scope') {
      await editLive((cur) => {
        cur.scope = typeof m.scope === 'string' ? m.scope.slice(0, 30) : '*';
      });
      await pushMine();
      return { ok: true };
    }
    if (m.op === 'leave') {
      // Leaving takes this browser's list off the relay. If the relay cannot be reached the record is still dropped here.
      if (live.status !== 'gone') await V.call(live, 'leave');
      await editLive((cur, grp) => {
        delete grp.live;
      });
      return { ok: true };
    }
    return { ok: false, reason: 'member' };
  }

  if (m.op === 'invite') return { ok: true, invite: V.makeInvite(live) };
  if (m.op === 'approve' || m.op === 'remove') {
    if (typeof m.id !== 'string') return { ok: false };
    const res = await V.call(live, m.op === 'remove' ? 'remove' : 'approve', { body: { id: m.id, ok: m.op === 'approve' && !!m.ok } });
    if (!res.ok && res.http !== 404) return { ok: false, reason: res.error === 'full' ? 'full' : 'relay' };
    return liveSync();
  }
  if (m.op === 'end') {
    const res = await V.call(live, 'close');
    if (!res.ok && res.http !== 404 && res.http !== 401) return { ok: false, reason: 'relay' };
    await liveGone(live.room);
    return { ok: true };
  }
  return { ok: false, reason: 'unknown' };
}

// A change to the list, the sizes, the marks or the shipping goes out by itself a moment later.
let liveTimer = null;
function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    pushMine().catch(() => {});
    pushNotes().catch(() => {});
  }, 1200);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.items || changes.group || changes.settings || changes.rates)) scheduleLive();
});

// -------------------------------------------------------------------- rates

async function ensureRates(force) {
  const cur = await get('rates', null);
  if (cur && !force && Date.now() - cur.at < DAY) return cur;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/CNY', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    if (j && j.result === 'success' && j.rates && j.rates.USD) {
      const rates = { at: Date.now(), live: true, rates: j.rates };
      await locked(() => chrome.storage.local.set({ rates }));
      return rates;
    }
  } catch (_) {
    /* offline: fall through to whatever we have */
  }
  return cur || { at: 0, live: false, rates: U.FALLBACK_RATES };
}

// --------------------------------------------------------------------- sync

function scheduleSync() {
  chrome.alarms.create('rh-sync', { delayInMinutes: 0.5 });
}

function readRemote(all) {
  const n = (all.rh_meta && all.rh_meta.n) || 0;
  const chunks = [];
  for (let i = 0; i < n; i++) if (all['rh_i' + i] != null) chunks.push(all['rh_i' + i]);
  return U.unpackSync(chunks);
}

async function syncPull() {
  const all = await chrome.storage.sync.get(null);
  const remote = readRemote(all);
  const fresh = [];
  if (remote.length) {
    await mutateItems((items, tombs) => {
      const before = new Set(Object.keys(items));
      if (!U.mergeSync(items, tombs, remote)) return SKIP;
      for (const k of Object.keys(items)) if (!before.has(k)) fresh.push(k);
      return true;
    }, { sync: false });
  }
  if (all.rh_sellers && typeof all.rh_sellers === 'object') {
    await mutate('sellers', {}, (sellers) => {
      let changed = false;
      for (const [k, v] of Object.entries(all.rh_sellers)) {
        if (!v || typeof v !== 'object' || ((sellers[k] && sellers[k].m) || 0) >= (v.m || 0)) continue;
        sellers[k] = { name: String(v.n || '').slice(0, 60), trusted: !!v.t, m: v.m || 0 };
        changed = true;
      }
      return changed ? true : SKIP;
    }, true);
  }
  await ensureFolders();
  fresh.slice(0, 60).forEach(queuePreview);
  return all;
}

function syncProblem(e) {
  const msg = String((e && e.message) || e);
  if (/quota/i.test(msg)) return 'Your list is too big for browser sync right now. Deleting old items or shortening long notes will make room.';
  if (/MAX_WRITE|rate|throttl/i.test(msg)) return 'The browser is limiting how often sync can write. It will try again shortly.';
  return 'Browser sync is not available right now (' + msg.slice(0, 80) + ').';
}

/** Merge what other devices wrote, then write ours if we hold anything newer. `force` writes regardless (Sync now). */
async function syncPush(force) {
  const settings = await getSettings();
  if (!settings.sync) return { ok: false, reason: 'off' };
  try {
    let all = await syncPull();
    const data = await chrome.storage.local.get(['items', 'tombstones', 'sellers']);
    // Sellers travel in a single value, so they are packed newest-first (ties by key, so every device
    // agrees on the order) until that value is comfortably full.
    const sellers = {};
    let sellerBytes = 2;
    const ranked = Object.entries(data.sellers || {}).sort((a, b) => (b[1].m || 0) - (a[1].m || 0) || (a[0] < b[0] ? -1 : 1));
    for (const [k, v] of ranked) {
      const entry = { n: String(v.name || '').slice(0, 40), t: v.trusted ? 1 : 0, m: v.m || 0 };
      const size = U.storedSize({ [k]: entry });
      if (sellerBytes + size > 6000) break;
      sellers[k] = entry;
      sellerBytes += size;
    }
    const remoteSellers = all.rh_sellers || {};
    const sellersNewer = Object.entries(sellers).some(([k, v]) => !remoteSellers[k] || (remoteSellers[k].m || 0) < v.m);

    let packed = null;
    let written = false;
    // If a write is refused for size, pack into smaller pieces and try once more.
    for (const chunkBytes of [6800, 4200]) {
      packed = U.packSync(data.items || {}, data.tombstones || {}, { chunkBytes });
      if (!force && !sellersNewer && !U.needsPush(packed.kept, readRemote(all))) break;
      const want = { rh_meta: { n: packed.chunks.length, dropped: packed.dropped, v: 2 }, rh_sellers: sellers };
      packed.chunks.forEach((c, i) => (want['rh_i' + i] = c));
      const toSet = {};
      for (const [k, v] of Object.entries(want)) if (JSON.stringify(all[k]) !== JSON.stringify(v)) toSet[k] = v;
      const stale = Object.keys(all).filter((k) => /^rh_i\d+$/.test(k) && !(k in want));
      try {
        if (stale.length) await chrome.storage.sync.remove(stale);
        if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
        written = true;
        break;
      } catch (e) {
        if (!/quota/i.test(String((e && e.message) || e)) || chunkBytes === 4200) throw e;
        all = await chrome.storage.sync.get(null);
      }
    }
    const state = { at: Date.now(), count: packed.count, dropped: packed.dropped, error: '' };
    await locked(() => chrome.storage.local.set({ syncState: state }));
    return { ok: true, state, written };
  } catch (e) {
    const state = { at: Date.now(), count: 0, dropped: 0, error: syncProblem(e) };
    await locked(() => chrome.storage.local.set({ syncState: state }));
    return { ok: false, reason: state.error };
  }
}

// ---------------------------------------------------------------- UI helpers

let badgeTimer = null;
function flashBadge(text) {
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  chrome.action.setBadgeText({ text });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

async function toast(tabId, text, kind) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toast', text, kind: kind || 'ok' });
  } catch (_) {
    flashBadge(kind === 'error' ? '!' : '✓');
  }
}

const describeSave = U.describeSave;
const NO_AGENT_TEXT = 'Pick your shopping agent first: click the RepHop icon and choose it at the top of the list.';

async function buildMenus() {
  const agent = L.agentInfo(await getSettings()).name;
  const hosts = ['weidian.com', 'taobao.com', 'tmall.com', '1688.com', 'yupoo.com'].concat(L.AGENT_HOSTS, L.SHORT_HOSTS);
  const patterns = [];
  for (const h of hosts) patterns.push('*://' + h + '/*', '*://*.' + h + '/*');
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'rh-open', title: 'Open in ' + agent, contexts: ['link'], targetUrlPatterns: patterns });
  chrome.contextMenus.create({ id: 'rh-save', title: 'Save to RepHop list', contexts: ['link'], targetUrlPatterns: patterns });
  chrome.contextMenus.create({ id: 'rh-qc', title: 'Find QC photos', contexts: ['link'], targetUrlPatterns: patterns });
  chrome.contextMenus.create({ id: 'rh-selection', title: 'Save links in selection to RepHop', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'rh-savepage', title: 'Save this product to RepHop list', contexts: ['page'], documentUrlPatterns: patterns });
  chrome.contextMenus.create({ id: 'rh-page', title: 'Grab every rep link on this page', contexts: ['page', 'action'] });
}

/** Collect links from a tab: ask our content script first, fall back to a one-off scrape (needs activeTab). */
async function grabTab(tab) {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'grabAll' });
    if (r && r.handled) return;
  } catch (_) {
    /* no content script on this site */
  }
  let found = [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        links: Array.from(document.querySelectorAll('a[href]')).slice(0, 5000).map((a) => ({ url: a.href, label: (a.textContent || '').trim().slice(0, 120) })),
        text: (document.body ? document.body.innerText : '').slice(0, 400000),
      }),
    });
    const ctx = { site: U.hostOf(tab.url), postTitle: tab.title || '', postUrl: tab.url || '' };
    const seen = new Set();
    for (const l of res.result.links) {
      const p = L.parseLink(l.url);
      if (p && !seen.has(p.key)) {
        seen.add(p.key);
        found.push({ url: l.url, label: l.label, ctx });
      }
    }
    for (const h of L.extractLabeled(res.result.text)) {
      if (!seen.has(h.parsed.key)) {
        seen.add(h.parsed.key);
        found.push({ url: h.raw, label: h.label, ctx });
      }
    }
  } catch (_) {
    flashBadge('!');
    return;
  }
  if (!found.length) return flashBadge('0');
  const stats = await saveEntries(found);
  flashBadge(stats.added ? '+' + stats.added : '✓');
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function registerExtraSites() {
  const settings = await getSettings();
  const matches = [];
  for (const site of settings.extraSites) {
    const host = String(site).trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    const origins = ['*://' + host + '/*', '*://*.' + host + '/*'];
    if (await chrome.permissions.contains({ origins }).catch(() => false)) matches.push(...origins);
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['rh-extra'] }).catch(() => {});
    if (matches.length) await chrome.scripting.registerContentScripts([{ id: 'rh-extra', matches, js: CONTENT_FILES, runAt: 'document_idle' }]);
  } catch (e) {
    console.warn('RepHop: extra sites not registered', e);
  }
}

// ----------------------------------------------------------------- messages

/** The list lives in the side panel; browsers without one get it in a normal tab. */
function openList(tab) {
  if (chrome.sidePanel && chrome.sidePanel.open) return chrome.sidePanel.open({ tabId: tab.id });
  return chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html'), index: tab.index + 1 });
}

function setupPanel() {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

const handlers = {
  open: (m, s) => openLink(m, s.tab),
  save: (m) => saveEntries([{ url: m.url, key: m.key, ctx: m.ctx, label: m.label, options: m.options }], m.folder).then((st) => Object.assign(st, { ok: st.keys.length > 0, key: st.keys[0], message: describeSave(st) })),
  saveMany: (m) => saveEntries(m.entries, m.folder).then((st) => Object.assign(st, { message: describeSave(st) })),
  describe: (m) => describe(m),
  lookup: (m) => lookup(m.keys, typeof m.detail === 'string' ? m.detail : ''),
  cartByHand: (m) => cartByHand(m).then((r) => r || { ok: false }),
  importCart: (m, s) => importCart(m, s),
  cartStale: (m) => cartStale(m),
  mark: (m) => markItems(m).then((r) => r || { ok: true, count: 0 }),
  importCartTab: () => importCartTab(),
  photoInfo: (m) => photoInfo(m),
  fetchPics: (m) => fetchPics(m),
  loadMatcher: (m, s) => loadMatcher(s),
  seen: (m) => recordSeen(m.entries).then(() => ({ ok: true })),
  update: (m) => updateItems(m.keys || [m.key], m.patch || {}).then((r) => r || { ok: true, count: 0 }),
  pick: (m) => pickOp(m).then((r) => r || { ok: false }),
  remove: (m) => removeItems(m.keys || [m.key]).then((r) => r || { ok: true, removed: [] }),
  restore: (m) => restoreItems(m.items, false),
  importData: async (m) => {
    const d = m.data || {};
    if (Array.isArray(d.folders)) {
      const cur = await get('folders', U.DEFAULT_FOLDERS);
      await setFolders(cur.concat(d.folders));
    }
    const r = await restoreItems(Array.isArray(d.items) ? d.items : Object.values(d.items || {}), true);
    if (d.sellers && typeof d.sellers === 'object') {
      await mutate('sellers', {}, (sellers) => {
        for (const [k, v] of Object.entries(d.sellers).slice(0, 200)) if (v && !sellers[k]) sellers[k] = { name: String(v.name || '').slice(0, 60), trusted: !!v.trusted, m: Date.now() };
      }, true);
    }
    return r;
  },
  folders: (m) => setFolders(m.list, m.renames),
  seller: (m) =>
    mutate('sellers', {}, (sellers) => {
      sellers[m.key] = { name: String(m.name || (sellers[m.key] && sellers[m.key].name) || '').slice(0, 60), trusted: !!m.trusted, m: Date.now() };
    }, true).then(() => {
      scheduleSync();
      return { ok: true };
    }),
  settings: async (m) => {
    let next;
    await locked(async () => {
      next = U.mergeSettings(Object.assign(await get('settings', {}), m.patch || {}));
      await chrome.storage.local.set({ settings: next });
    });
    if (m.patch && ('agent' in m.patch || 'customName' in m.patch || 'customTemplate' in m.patch)) await buildMenus();
    if (m.patch && 'extraSites' in m.patch) await registerExtraSites();
    if (m.patch && m.patch.sync) await syncPush(true);
    return { ok: true, settings: next };
  },
  queue: (m, s) => queueOp(m, s.tab),
  whoami: async (m, s) => {
    const tabId = s.tab ? s.tab.id : null;
    const ses = tabId != null ? await chrome.storage.session.get(['backTo', 'cartImport']) : {};
    const back = (ses.backTo || {})[tabId];
    const ci = ses.cartImport;
    // the list opened this tab to copy the cart in (still wanted after you sign in, for a while)
    const cartImport = !!(ci && ci.tabId === tabId && Date.now() - ci.at < 20 * 60000);
    return { tabId, back: back ? back.label || 'post' : null, cartImport };
  },
  // The agent page's "Back to …" button: the tab the listing was opened from, or that page again if it was closed.
  goBack: async (m, s) => {
    if (!s.tab) return { ok: false };
    const back = ((await chrome.storage.session.get('backTo')).backTo || {})[s.tab.id];
    if (!back) return { ok: false };
    const src = await chrome.tabs.get(back.tabId).catch(() => null);
    if (src) {
      await chrome.tabs.update(src.id, { active: true });
      await chrome.windows.update(src.windowId, { focused: true }).catch(() => {});
      return { ok: true };
    }
    const u = L.toUrl(back.url);
    if (!u || !/^https?:$/.test(u.protocol)) return { ok: false };
    const tab = await chrome.tabs.create({ url: u.href, windowId: s.tab.windowId, index: s.tab.index + 1, active: true });
    // The reopened page is where "back" leads from now on.
    const st = await chrome.storage.session.get('backTo');
    const backTo = st.backTo || {};
    if (backTo[s.tab.id]) backTo[s.tab.id] = Object.assign({}, backTo[s.tab.id], { tabId: tab.id, at: Date.now() });
    await chrome.storage.session.set({ backTo });
    return { ok: true, reopened: true };
  },
  // Answered by whichever copy of the background Chrome is running; the list compares it with its own.
  version: () => ({ ok: true, build: U.BUILD }),
  refresh: async (m) => {
    // Weidian items are asked directly; Yupoo albums are re-read (a deleted album answers 404).
    // Taobao and 1688 have no public lookup, so those are reported as skipped.
    // The panel sends these in batches of 100, so nothing is silently left out.
    const all = (m.keys || []).slice(0, 100);
    const keys = all.filter((k) => k.startsWith('weidian:') || k.startsWith('yupoo:'));
    const res = await pool(keys, 2, async (k) => {
      if (k.startsWith('weidian:')) return getPreview(k, true).catch(() => null);
      const r = await resolveLink(L.keyToItem(k), true).catch(() => null);
      return !r || !r.ok ? null : { state: r.gone ? 'gone' : 'ok' };
    });
    const out = { ok: true, checked: keys.length, skipped: all.length - keys.length, live: 0, soldout: 0, gone: 0, unknown: 0 };
    for (const p of res) {
      if (!p || p.stale) out.unknown++;
      else if (p.state === 'gone') out.gone++;
      else if (p.state === 'soldout') out.soldout++;
      else out.live++;
    }
    return out;
  },
  /** What "add to cart for me" should choose for one saved item. */
  cartPlan: async (m) => {
    const data = await chrome.storage.local.get(['items', 'settings', 'queue', 'group', 'previews']);
    const q = data.queue;
    const seen = (data.previews || {})[m.key] || {};
    const sellerRows = seen.wd || (seen.choicesFrom === 'weidian' ? seen.choices : null) || [];
    const ref = q && q.active && Array.isArray(q.owner) && q.keys[q.i] === m.key ? q.owner[q.i] : null;
    if (ref && ref.v) {
      // One of your item's other picks: its own choices and quantity, your size.
      const items = data.items || {};
      const it = items[findKey(items, m.key)];
      const pick = it && Array.isArray(it.more) ? it.more.find((p) => p.id === ref.v) : null;
      if (!pick) return { ok: false };
      const settings = U.mergeSettings(data.settings);
      return { ok: true, itemKey: it.key, options: pick.options || [], size: U.sizeFor(it, settings), style: it.style || '', qty: pick.qty || 1, kind: U.guessKind(it), source: it.wd || sellerRows };
    }
    if (ref) {
      // A friend's item in a group haul: their choices and their size, never yours.
      const person = ((data.group && data.group.people) || []).find((p) => p.id === ref.p);
      const theirs = person && person.items.find((x) => x.uid === ref.x && x.key === m.key);
      if (!theirs) return { ok: false };
      return { ok: true, itemKey: theirs.key, options: theirs.options || [], size: theirs.size || '', style: theirs.style || '', qty: theirs.qty || 1, owner: person.name, source: sellerRows };
    }
    const items = data.items || {};
    const it = items[findKey(items, m.key)];
    if (!it) return { ok: false };
    const settings = U.mergeSettings(data.settings);
    return { ok: true, itemKey: it.key, options: it.options || [], size: U.sizeFor(it, settings), style: it.style || '', qty: it.qty || 1, kind: U.guessKind(it), source: it.wd || sellerRows };
  },
  /** An item went into the cart during a run: mark it (yours, or the friend's whose step this is). */
  cartMark: async (m) => {
    const q = await get('queue', null);
    const ref = q && q.active && Array.isArray(q.owner) && q.keys[q.i] === m.key ? q.owner[q.i] : null;
    const options = U.cleanOptions(m.options);
    if (ref && ref.v) return pickOp({ op: 'set', key: m.key, id: ref.v, patch: Object.assign({ status: 'carted' }, options.length ? { options } : {}) }).then((r) => r || { ok: false });
    if (ref) return groupOp({ op: 'mark', id: ref.p, uid: ref.x, status: 'carted', options });
    const items = await get('items', {});
    const k = findKey(items, m.key);
    if (!k) return { ok: false };
    return updateItems([k], Object.assign({ status: 'carted' }, options.length ? { options } : {})).then((r) => r || { ok: true, count: 0 });
  },
  group: async (m) => {
    await ensureGroup();
    return groupOp(m);
  },
  live: (m) => liveOp(m),
  pagePatch: async (m) => {
    if (!L.keyToItem(m.key)) return { ok: false };
    const p = { state: 'ok' };
    if (typeof m.title === 'string' && m.title.trim()) p.title = m.title.trim().slice(0, 200);
    if (typeof m.price === 'number' && m.price > 0) p.price = m.price;
    if (typeof m.image === 'string' && /^https:\/\//.test(m.image)) p.image = m.image.slice(0, 500);
    // The rows of choices on the agent's listing, in the agent's own words.
    if (Array.isArray(m.choices)) {
      p.choices = U.cleanChoices(m.choices);
      p.choicesFrom = 'agent';
    }
    await savePreview(m.key, p);
    await markViewed([m.key]);
    return { ok: true };
  },
  recheck: async (m) => {
    const album = L.keyToItem(m.key);
    if (!album || album.kind !== 'yupoo') return { ok: false, reason: 'unsupported' };
    const r = await resolveLink(album, true);
    if (!r.ok) return { ok: false, reason: r.reason };
    if (r.noBuyLink) {
      await mutateItems((items) => {
        if (!items[m.key] || !items[m.key].pending) return SKIP;
        items[m.key].pending = false;
        applyMeta(items[m.key], r.meta);
        return true;
      }, { sync: false });
    }
    return { ok: true, noBuyLink: !!r.noBuyLink, key: r.item.key };
  },
  needPreviews: (m) => {
    (m.keys || []).slice(0, 40).forEach(queuePreview);
    (m.enrich || []).slice(0, 6).forEach(queueEnrich);
    return { ok: true };
  },
  rates: (m) => ensureRates(m.force),
  syncNow: () => syncPush(true),
  clearHistory: async () => {
    // Everything RepHop remembers besides the list itself: viewed marks, "seen in posts", cached previews and lookups.
    await locked(async () => {
      const rev = await get('rev', 0);
      await chrome.storage.local.remove(['seen', 'previews', 'resolved']);
      await chrome.storage.local.set({ rev: rev + 1 });
    });
    await mutateItems((items) => {
      let n = 0;
      for (const it of Object.values(items)) {
        if (!it.viewedAt) continue;
        it.viewedAt = 0;
        n++;
      }
      return n ? true : SKIP;
    }, { sync: false });
    return { ok: true };
  },
  openTab: async (m) => {
    // Only for our own "original link" / QC buttons: a plain new tab, http(s) only.
    const u = L.toUrl(m.url);
    if (!u) return { ok: false };
    await chrome.tabs.create({ url: u.href, active: m.active !== false });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'openPanel') {
    // Must run synchronously: the browser only allows this while the page click is still "the current gesture".
    if (!sender.tab) return false;
    openList(sender.tab).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, reason: 'error', error: String((e && e.message) || e) }));
    return true;
  }
  const fn = handlers[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, reason: 'error', error: String((e && e.message) || e) }));
  return true;
});

// ------------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(async (details) => {
  await setupNetRules();
  await buildMenus();
  await ensureFolders();
  await registerExtraSites();
  setupPanel();
  chrome.alarms.create('rh-rates', { periodInMinutes: 720 });
  ensureRates();
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html') });
});

chrome.runtime.onStartup.addListener(async () => {
  // An add-to-cart run left waiting when the browser was closed is over.
  const left = await get('queue', null);
  if (left && left.active && left.auto) await queueOp({ op: 'stop' }, null).catch(() => {});
  await setupNetRules();
  setupPanel();
  ensureRates();
  if ((await getSettings()).sync) scheduleSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rh-sync') syncPush();
  if (alarm.name === 'rh-rates') ensureRates(true);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (!Object.keys(changes).some((k) => k.startsWith('rh_'))) return;
  if (!(await getSettings()).sync) return;
  // Take in the other device's changes, then check (after the usual delay) whether we hold anything it lacks.
  await syncPull().catch(() => {});
  scheduleSync();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const ctx = tab ? { site: U.hostOf(tab.url), postTitle: tab.title || '', postUrl: info.pageUrl || tab.url || '' } : null;
  if (info.menuItemId === 'rh-open') {
    const r = await openLink({ url: info.linkUrl }, tab);
    if (!r.ok) toast(tab && tab.id, r.reason === 'no-agent' ? NO_AGENT_TEXT : "That link isn't a product RepHop can read.", 'error');
  } else if (info.menuItemId === 'rh-save') {
    const st = await saveEntries([{ url: info.linkUrl, ctx, label: info.selectionText || '' }]);
    toast(tab && tab.id, describeSave(st), st.keys.length ? 'ok' : 'error');
  } else if (info.menuItemId === 'rh-qc') {
    const res = await resolveLink(info.linkUrl);
    const url = res.ok ? L.qcUrl(res.item, await getSettings()) : null;
    if (url) chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined });
    else toast(tab && tab.id, 'QC lookup needs a Weidian, Taobao or 1688 item.', 'error');
  } else if (info.menuItemId === 'rh-selection') {
    const entries = L.extractLabeled(info.selectionText || '').map((h) => ({ url: h.raw, label: h.label, ctx }));
    const st = entries.length ? await saveEntries(entries) : { added: 0, duplicates: 0, failed: 1, keys: [] };
    toast(tab && tab.id, describeSave(st), st.keys.length ? 'ok' : 'error');
  } else if (info.menuItemId === 'rh-savepage' && tab) {
    const url = tab.url || info.pageUrl || '';
    const st = L.parseLink(url) ? await saveEntries([{ url, ctx }]) : { keys: [] };
    toast(tab.id, st.keys.length ? describeSave(st) : "This page isn't a product RepHop can read.", st.keys.length ? 'ok' : 'error');
  } else if (info.menuItemId === 'rh-page' && tab) {
    grabTab(tab);
  }
});

chrome.commands.onCommand.addListener(async (command, tabArg) => {
  const tab = tabArg || (await currentTab());
  if (!tab) return;
  if (command === 'open-panel') {
    openList(tab).catch(() => {});
    return;
  }
  if (command === 'grab-all') return grabTab(tab);
  if (!tab.url || !L.parseLink(tab.url)) {
    toast(tab.id, "This page isn't a product RepHop can read.", 'error');
    return;
  }
  if (command === 'send-current') {
    const r = await openLink({ url: tab.url, disposition: 'reuse' }, tab);
    if (!r.ok && r.reason === 'no-agent') toast(tab.id, NO_AGENT_TEXT, 'error');
    else if (r.ok && r.noBuyLink) toast(tab.id, 'This album has no Weidian or Taobao link on it.', 'error');
  } else if (command === 'save-current') {
    const st = await saveEntries([{ url: tab.url, ctx: { site: U.hostOf(tab.url), postTitle: tab.title || '', postUrl: tab.url } }]);
    toast(tab.id, describeSave(st), st.keys.length ? 'ok' : 'error');
  }
});

if (!chrome.sidePanel) chrome.action.onClicked.addListener((tab) => openList(tab));

// The worker restarts often; session header rules survive, but re-adding them is cheap and idempotent.
setupNetRules();
