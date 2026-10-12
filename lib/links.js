/*
 * RepHop link engine.
 * Pure functions only (no chrome.*, no DOM) so the same file runs in the
 * service worker, content scripts, the side panel and the Node test suite.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepLinks = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ---------------------------------------------------------------- platforms

  const PLATFORMS = {
    weidian: { label: 'Weidian', short: 'WD', url: (id) => `https://weidian.com/item.html?itemID=${id}` },
    taobao: { label: 'Taobao', short: 'TB', url: (id) => `https://item.taobao.com/item.htm?id=${id}` },
    1688: { label: '1688', short: '1688', url: (id) => `https://detail.1688.com/offer/${id}.html` },
    yupoo: { label: 'Yupoo', short: 'YP', url: (id) => `https://${id.split('/')[0]}.x.yupoo.com/albums/${id.split('/')[1]}?uid=1` },
  };

  // Where "open" sends you. Superbuy is the default and the one this was built around.
  const AGENTS = {
    superbuy: { name: 'Superbuy', short: 'SB', template: 'https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url={url}' },
    allchinabuy: { name: 'AllChinaBuy', short: 'ACB', template: 'https://www.allchinabuy.com/en/page/buy/?nTag=Home-search&from=search-input&url={url}' },
    cnfans: { name: 'CNFans', short: 'CNF', template: 'https://cnfans.com/product?id={id}&platform={PLATFORM}' },
    mulebuy: { name: 'Mulebuy', short: 'MB', template: 'https://mulebuy.com/product?id={id}&platform={PLATFORM}' },
    kakobuy: { name: 'Kakobuy', short: 'KB', template: 'https://www.kakobuy.com/item/details?url={url}' },
    hoobuy: { name: 'Hoobuy', short: 'HB', template: 'https://hoobuy.com/product/{num}/{id}' },
    acbuy: { name: 'ACBuy', short: 'AC', template: 'https://www.acbuy.com/product?id={id}&source={code}' },
    custom: { name: 'Custom', short: 'GO', template: '' },
  };

  const QC_PROVIDERS = {
    finderqc: { name: 'FinderQC', template: 'https://finderqc.com/product/{platform}/{id}' },
    findqc: { name: 'FindQC', template: 'https://findqc.com/detail/{code}/{id}' },
    custom: { name: 'Custom', template: '' },
  };

  const TOKEN = {
    PLATFORM: { weidian: 'WEIDIAN', taobao: 'TAOBAO', 1688: 'ALI_1688' },
    num: { 1688: '0', taobao: '1', weidian: '2' },
    code: { weidian: 'WD', taobao: 'TB', 1688: 'AO' },
  };

  // Spellings other agents use for the three marketplaces in their own URLs.
  const PLATFORM_ALIASES = {
    weidian: 'weidian', wd: 'weidian', micro: 'weidian', wei_dian: 'weidian', weidian_item: 'weidian',
    taobao: 'taobao', tb: 'taobao', tmall: 'taobao', tm: 'taobao',
    1688: '1688', ali_1688: '1688', ali1688: '1688', alibaba: '1688', ao: '1688', al: '1688', t1688: '1688',
  };
  const NUMERIC_PLATFORM = { 0: '1688', 1: 'taobao', 2: 'weidian' };

  // Shopping agents whose product URLs we can read (suffix match on hostname).
  const AGENT_HOSTS = [
    'superbuy.com', 'allchinabuy.com', 'wegobuy.com', 'pandabuy.com', 'cnfans.com', 'mulebuy.com',
    'joyabuy.com', 'joyagoo.com', 'orientdig.com', 'hoobuy.com', 'kakobuy.com', 'acbuy.com', 'oopbuy.com',
    'lovegobuy.com', 'sugargoo.com', 'cssbuy.com', 'hagobuy.com', 'basetao.com', 'eastmallbuy.com',
    'ezbuycn.com', 'loongbuy.com', 'itaobuy.com', 'hipobuy.com', 'ponybuy.com', 'usfans.com',
  ];

  // Share-link shorteners. They only tell us the item after a network hop.
  const SHORT_HOSTS = [
    'k.youshop10.com', 'youshop10.com', 'm.tb.cn', 'e.tb.cn', 's.tb.cn', 'tb.cn', 'qr.1688.com',
    's.click.taobao.com', 'pandabuy.page.link', 'pandabuy.app.link', 'ikako.vip',
  ];

  const ID_PARAMS = ['id', 'itemid', 'item_id', 'product_id', 'productid', 'goods_id', 'goodsid', 'tid', 'spuid', 'offerid', 'num_iid'];
  const PLATFORM_PARAMS = ['shop_type', 'shoptype', 'platform', 'source', 'channel', 'tp', 'type', 'store', 'plat', 'site'];

  // ------------------------------------------------------------------ helpers

  function hostMatches(host, list) {
    for (const h of list) if (host === h || host.endsWith('.' + h)) return true;
    return false;
  }

  function isId(v) {
    return typeof v === 'string' && /^\d{5,20}$/.test(v);
  }

  /** Turn anything link-ish (bare domain, protocol-relative, markdown-escaped) into a URL, or null. */
  function toUrl(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s || s.length > 4000) return null;
    s = s.replace(/\\([_~*()[\]&=?-])/g, '$1').replace(/&amp;/gi, '&');
    if (/^\/\//.test(s)) s = 'https:' + s;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(?::\d+)?([/?#]|$)/i.test(s)) return null;
      s = 'https://' + s;
    }
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch (_) {
      return null;
    }
  }

  function getParam(params, names) {
    for (const [k, v] of params) {
      if (names.includes(k.toLowerCase()) && v) return v.trim();
    }
    return null;
  }

  function makeItem(platform, id, via, extra) {
    return Object.assign({ kind: 'item', platform, id, key: platform + ':' + id, url: PLATFORMS[platform].url(id), via: via || 'direct' }, extra || {});
  }

  // -------------------------------------------------------------- marketplaces

  function parseMarketplace(u) {
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    const q = u.searchParams;

    if (hostMatches(host, ['weidian.com'])) {
      let id = getParam(q, ['itemid', 'item_id', 'vitemid']);
      if (!id && /\/(item|fastorder)\.html?$/i.test(path)) id = getParam(q, ['id']);
      if (!id) {
        const m = path.match(/\/item\/(\d{5,20})/);
        if (m) id = m[1];
      }
      if (!isId(id)) return null;
      const shop = host.match(/^shop(\d+)\./);
      return makeItem('weidian', id, 'direct', shop ? { shopId: shop[1] } : null);
    }

    if (hostMatches(host, ['taobao.com', 'tmall.com', 'tmall.hk'])) {
      let id = null;
      const m = path.match(/\/item\/(\d{5,20})\.html?/) || path.match(/\/i(\d{5,20})\.html?/);
      if (m) id = m[1];
      else if (/item|detail/i.test(host + path)) id = getParam(q, ['id', 'item_id', 'itemid', 'num_iid']);
      return isId(id) ? makeItem('taobao', id) : null;
    }

    if (hostMatches(host, ['1688.com'])) {
      const m = path.match(/\/offer\/(\d{5,20})\.html?/);
      const id = m ? m[1] : getParam(q, ['offerid', 'offer_id']);
      return isId(id) ? makeItem('1688', id) : null;
    }
    return null;
  }

  // ------------------------------------------------------------------- yupoo

  function yupooUser(input) {
    const u = input instanceof URL ? input : toUrl(input);
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    if (!hostMatches(host, ['yupoo.com'])) return null;
    const sub = host.slice(0, -'.yupoo.com'.length);
    if (sub.endsWith('.x') && sub.length > 2) return sub.slice(0, -2);
    const m = u.pathname.match(/^\/photos\/([^/]+)/);
    return m ? m[1].toLowerCase() : null;
  }

  function parseYupoo(u) {
    const user = yupooUser(u);
    if (!user) return null;
    const m = u.pathname.match(/\/albums\/(\d+)/);
    if (!m) return null;
    const id = user + '/' + m[1];
    return { kind: 'yupoo', platform: 'yupoo', user, albumId: m[1], id, key: 'yupoo:' + id, url: PLATFORMS.yupoo.url(id), via: 'yupoo' };
  }

  // ------------------------------------------------------------------ agents

  function parseAgentPath(u, host) {
    const path = u.pathname;
    let m;
    if (hostMatches(host, ['cssbuy.com'])) {
      m = path.match(/\/item-(?:(micro|1688)-)?(\d{5,20})(?:\.html)?/i);
      if (m) return makeItem(m[1] ? PLATFORM_ALIASES[m[1].toLowerCase()] : 'taobao', m[2], 'agent');
    }
    if (hostMatches(host, ['hoobuy.com', 'oopbuy.com'])) {
      m = path.match(/\/product\/([a-z_0-9]+)\/(\d{5,20})/i);
      if (m) {
        const p = NUMERIC_PLATFORM[m[1]] || PLATFORM_ALIASES[m[1].toLowerCase()];
        if (p) return makeItem(p, m[2], 'agent');
      }
    }
    if (hostMatches(host, ['basetao.com'])) {
      m = path.match(/\/products\/agent\/([a-z0-9_]+)\/(\d{5,20})/i);
      if (m && PLATFORM_ALIASES[m[1].toLowerCase()]) return makeItem(PLATFORM_ALIASES[m[1].toLowerCase()], m[2], 'agent');
    }
    return null;
  }

  function parseAgentParams(params) {
    const id = getParam(params, ID_PARAMS);
    const plat = getParam(params, PLATFORM_PARAMS);
    if (!isId(id) || !plat) return null;
    const p = PLATFORM_ALIASES[plat.toLowerCase()];
    return p ? makeItem(p, id, 'agent') : null;
  }

  /** Query-string style params that live after a "#" (Sugargoo and other SPA routers). */
  function hashParams(u) {
    const i = u.hash.indexOf('?');
    return i === -1 ? null : new URLSearchParams(u.hash.slice(i + 1));
  }

  function decodeDeep(v) {
    let s = v;
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
      try {
        s = decodeURIComponent(s);
      } catch (_) {
        break;
      }
    }
    return s;
  }

  /** A link hidden inside another link's parameters (redirectors, agent "?url=" pages, Yupoo's /external). */
  function parseNested(u, depth) {
    const sets = [u.searchParams, hashParams(u)];
    for (const params of sets) {
      if (!params) continue;
      for (const [, v] of params) {
        if (!v || v.length < 12 || !/[a-z0-9]\.[a-z]{2,}/i.test(v)) continue;
        const inner = decodeDeep(v);
        if (!/^(https?:)?\/\//i.test(inner) && !/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(inner)) continue;
        const hit = parseLink(inner, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  // -------------------------------------------------------------- entry point

  /**
   * Classify a URL.
   *   { kind: 'item',  platform, id, key, url, via }   a product we can open right now
   *   { kind: 'yupoo', user, albumId, key, url }        an album; its buy link needs a fetch
   *   { kind: 'short', url, key }                       a share link; needs a redirect hop
   *   null                                              not something we handle
   */
  function parseLink(raw, depth) {
    depth = depth || 0;
    if (depth > 3) return null;
    const u = raw instanceof URL ? raw : toUrl(raw);
    if (!u) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');

    const direct = parseMarketplace(u);
    if (direct) return direct;

    // Yupoo's own redirector wraps the seller's buy link; look inside before treating it as an album.
    if (hostMatches(host, ['yupoo.com']) && /\/external/i.test(u.pathname)) return parseNested(u, depth);

    const album = parseYupoo(u);
    if (album) return album;

    if (hostMatches(host, SHORT_HOSTS)) {
      const clean = u.protocol + '//' + u.host + u.pathname + u.search;
      return { kind: 'short', url: clean, key: 'short:' + u.host + u.pathname + u.search, via: 'short' };
    }

    const isAgent = hostMatches(host, AGENT_HOSTS);
    if (isAgent) {
      const byPath = parseAgentPath(u, host);
      if (byPath) return byPath;
    }

    const nested = parseNested(u, depth);
    if (nested) {
      if (nested.kind === 'item' && nested.via === 'direct') nested.via = isAgent ? 'agent' : 'wrapped';
      return nested;
    }

    if (isAgent) {
      const byParams = parseAgentParams(u.searchParams) || (hashParams(u) && parseAgentParams(hashParams(u)));
      if (byParams) return byParams;
    }
    return null;
  }

  function keyToItem(key) {
    const i = String(key).indexOf(':');
    if (i === -1) return null;
    const platform = key.slice(0, i);
    const id = key.slice(i + 1);
    if (platform === 'yupoo') {
      const [user, albumId] = id.split('/');
      if (!user || !/^\d+$/.test(albumId || '')) return null;
      return { kind: 'yupoo', platform, user, albumId, id, key, url: PLATFORMS.yupoo.url(id), via: 'yupoo' };
    }
    if (!PLATFORMS[platform] || !isId(id)) return null;
    return makeItem(platform, id);
  }

  // ------------------------------------------------------------- URL builders

  function fillTemplate(tpl, item) {
    const canonical = PLATFORMS[item.platform].url(item.id);
    return tpl
      .replace(/\{url\}/g, encodeURIComponent(canonical))
      .replace(/\{rawurl\}/g, canonical)
      .replace(/\{id\}/g, item.id)
      .replace(/\{platform\}/g, item.platform)
      .replace(/\{PLATFORM\}/g, TOKEN.PLATFORM[item.platform] || item.platform.toUpperCase())
      .replace(/\{num\}/g, TOKEN.num[item.platform] || '')
      .replace(/\{code\}/g, TOKEN.code[item.platform] || '');
  }

  function validTemplate(tpl) {
    return typeof tpl === 'string' && /^https:\/\/[^\s]+$/i.test(tpl.trim()) && /\{(url|rawurl|id)\}/.test(tpl);
  }

  function agentInfo(settings) {
    const id = settings && AGENTS[settings.agent] ? settings.agent : 'superbuy';
    if (id === 'custom') {
      if (validTemplate(settings.customTemplate)) return { id, name: settings.customName || 'Agent', short: 'GO', template: settings.customTemplate.trim() };
      return Object.assign({ id: 'superbuy' }, AGENTS.superbuy);
    }
    return Object.assign({ id }, AGENTS[id]);
  }

  /** The listing page on the chosen agent. Yupoo albums have no agent page, so they open as themselves. */
  function agentUrl(item, settings) {
    if (!item || item.platform === 'yupoo' || !PLATFORMS[item.platform]) return item ? item.url : null;
    return fillTemplate(agentInfo(settings).template, item);
  }

  function qcUrl(item, settings) {
    if (!item || item.platform === 'yupoo' || !PLATFORMS[item.platform]) return null;
    const id = settings && QC_PROVIDERS[settings.qcProvider] ? settings.qcProvider : 'finderqc';
    let tpl = QC_PROVIDERS[id].template;
    if (id === 'custom') tpl = validTemplate(settings.qcTemplate) ? settings.qcTemplate.trim() : QC_PROVIDERS.finderqc.template;
    return fillTemplate(tpl, item);
  }

  // ---------------------------------------------------------- text extraction

  // Labels are capped at 63 characters (the DNS limit) so a long unbroken run of letters cannot make the search crawl.
  const URL_RE = /(?:https?:\/\/|\/\/)?(?<![a-z0-9-])(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}(?::\d+)?(?:[/?#][^\s<>"'`\])}|]{0,2000})?/gi;
  const BARE_ID_RE = /\bitemID\s*[=:]\s*(\d{8,13})\b/gi;
  const QUICK_RE = /weidian|taobao|tmall|1688|yupoo|youshop10|tb\.cn|page\.link|ikako|buy\.|fans\.|goo\.|basetao|orientdig|itemID/i;

  function mightContainLink(text) {
    return typeof text === 'string' && text.length >= 8 && QUICK_RE.test(text);
  }

  /** Every supported link in a blob of text: [{ raw, index, length, parsed }], in order, de-duplicated by key. */
  function extractLinks(text) {
    const out = [];
    if (!mightContainLink(text)) return out;
    const seen = new Set();
    const spans = [];
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      let raw = m[0].replace(/[.,;:!?*_~\\]+$/, '');
      if (raw.length < 8) continue;
      const parsed = parseLink(raw);
      spans.push([m.index, m.index + m[0].length]);
      if (!parsed || seen.has(parsed.key)) continue;
      seen.add(parsed.key);
      out.push({ raw, index: m.index, length: raw.length, parsed });
    }
    // "itemID=1234567890" posted on its own (people do this to dodge link filters).
    BARE_ID_RE.lastIndex = 0;
    while ((m = BARE_ID_RE.exec(text))) {
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      const parsed = makeItem('weidian', m[1]);
      if (seen.has(parsed.key)) continue;
      seen.add(parsed.key);
      out.push({ raw: m[0], index: m.index, length: m[0].length, parsed });
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  function looksLikeUrl(text) {
    const t = String(text || '').trim();
    return /^(https?:\/\/|www\.)/i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(t);
  }

  /** Tidy a human label pulled from around a link ("**Black hoodie** - ", "| Jordan 4:"). */
  function cleanLabel(text) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
    t = t.replace(/^[\s>*_#|~`•·\-–—:,.)\]]+/, '').replace(/[\s*_#|~`•·\-–—:,(\[=>]+$/, '');
    t = t.replace(/\*\*|__|~~|`/g, '').trim();
    if (looksLikeUrl(t) || t.length < 2) return '';
    if (/^(link|links|here|w2c|click|click here|this|buy|url|weidian|taobao|yupoo|1688|item|product)$/i.test(t)) return '';
    return t.length > 110 ? t.slice(0, 107).trimEnd() + '…' : t;
  }

  /**
   * Links in Reddit-style markdown together with the words that describe them:
   * "[Jordan 4](url)" -> "Jordan 4", "Black hoodie - url" -> "Black hoodie".
   */
  function extractLabeled(text) {
    const out = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
      if (!mightContainLink(line)) continue;
      const hits = extractLinks(line);
      for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        if (seen.has(h.parsed.key)) continue;
        seen.add(h.parsed.key);
        const start = i === 0 ? 0 : hits[i - 1].index + hits[i - 1].length;
        const before = line.slice(start, h.index);
        const md = before.match(/\[([^\]]+)\]\(\s*$/);
        let label = md ? cleanLabel(md[1]) : '';
        if (!label) label = cleanLabel(md ? before.slice(0, md.index) : before);
        if (!label && hits.length === 1) label = cleanLabel(line.slice(h.index + h.length));
        out.push({ raw: h.raw, parsed: h.parsed, label });
      }
    }
    return out;
  }

  return {
    PLATFORMS, AGENTS, QC_PROVIDERS, AGENT_HOSTS, SHORT_HOSTS,
    parseLink, keyToItem, toUrl, yupooUser, hostMatches,
    agentUrl, agentInfo, qcUrl, validTemplate,
    extractLinks, extractLabeled, mightContainLink, looksLikeUrl, cleanLabel,
  };
});
