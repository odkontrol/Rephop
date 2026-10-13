/*
 * End-to-end check of the unpacked extension in a real Chrome.
 *
 *   cd tests/e2e && npm install && node run.js [--shots <folder>] [--real <folder with saved Reddit pages>]
 *
 * Reddit, the agent's listing page and Google Sheets are served from fixtures through request
 * interception (Reddit shows a bot check to automated browsers, and Superbuy needs a login). The
 * listing fixture uses the class names from Superbuy's own public stylesheet. Weidian's item API,
 * Yupoo and the exchange-rate service are the real sites, so this needs a network. Weidian item
 * PAGES are a fixture too: Weidian cuts off clients that load many of them.
 *
 * With --real, saved copies of real Reddit thread pages are also loaded. They carry Reddit's inline
 * stylesheet (which hides custom elements Reddit has not defined), but not its scripts.
 *
 * RepHop acts only on real input, so clicks and keys here go through the browser's input pipeline.
 * Its own buttons live in closed shadow roots; the checks look at them from the extension's own
 * isolated world (see `world()` below).
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..', '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const SHOTS = arg('--shots');
const REAL = arg('--real');
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U_displayTitle = (it) => it.customTitle || it.label || it.titleEn || it.title;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  const d = detail === undefined ? '' : '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : d.slice(0, 900)));
}

async function until(fn, ms, step) {
  const end = Date.now() + (ms || 8000);
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step || 200);
  }
  return last;
}

// ------------------------------------------------------------------ fixtures

const POST = 'https://www.reddit.com/r/FashionReps/comments/abc123/budget_haul_finds/';
const REDDIT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Budget haul finds : r/FashionReps</title>
<style>body{font:14px sans-serif;margin:40px;max-width:760px} p{margin:18px 0}</style></head><body>
<shreddit-app>
<shreddit-post id="t3_abc123" post-title="Budget haul finds" permalink="/r/FashionReps/comments/abc123/budget_haul_finds/" subreddit-prefixed-name="r/FashionReps" author="repfinder">
  <div slot="text-body"><div class="md">
    <p>Black hoodie - <a id="l1" href="https://weidian.com/item.html?itemID=7237185689">https://weidian.com/item.html?itemID=7237185689</a></p>
    <p><a id="l2" href="https://singor.x.yupoo.com/albums/258055580?uid=1">Pony zip hoodie</a></p>
    <p>Tee: <a id="l3" href="https://cnfans.com/product/?shop_type=weidian&id=7870660857">cnfans link</a></p>
    <p id="plain">Plain text one weidian.com/item.html?itemID=7231112223 enjoy</p>
    <p><a id="normal" href="https://example.com/">not a product</a></p>
    <p><a id="pic" href="https://weidian.com/item.html?itemID=7299999999"><img alt="" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a></p>
    <p><textarea id="box"></textarea></p>
  </div></div>
</shreddit-post>
<shreddit-comment author="someone" permalink="/r/FashionReps/comments/abc123/comment/def456/" thingid="t1_def456">
  <div slot="comment"><p>W2C belt? <a id="l4" href="https://item.taobao.com/item.htm?id=675330231400">this one</a></p></div>
</shreddit-comment>
<div id="late" style="min-height:60px"></div>
</shreddit-app></body></html>`;

const REDDIT_JSON = JSON.stringify([
  { data: { children: [{ kind: 't3', data: { id: 'abc123', title: 'Budget haul finds', author: 'repfinder', subreddit_name_prefixed: 'r/FashionReps', permalink: '/r/FashionReps/comments/abc123/budget_haul_finds/', url: POST, selftext: 'Black hoodie - https://weidian.com/item.html?itemID=7237185689' } }] } },
  { data: { children: [
    { kind: 't1', data: { author: 'someone', permalink: '/r/FashionReps/comments/abc123/comment/def456/', body: 'W2C belt? [this one](https://item.taobao.com/item.htm?id=675330231400)', replies: { data: { children: [
      { kind: 't1', data: { author: 'deep', permalink: '/r/FashionReps/comments/abc123/comment/ghi789/', body: 'Collapsed reply: Factory socks https://detail.1688.com/offer/622042419913.html', replies: '' } },
    ] } } } },
    { kind: 'more', data: { count: 37, children: ['x1', 'x2'] } },
  ] } },
]);

// A feed card the way Reddit builds one: a link stretched over the whole card, with body links lifted above it.
const FEED_URL = 'https://www.reddit.com/r/FashionReps/';
const FEED_HTML = `<!doctype html><html><head><title>r/FashionReps</title></head><body style="margin:40px;font:14px sans-serif">
<article style="position:relative;padding:24px;border:1px solid #ccc;width:600px">
  <a id="cardlink" href="/r/FashionReps/comments/feed111/feed_post/" style="position:absolute;inset:0"></a>
  <shreddit-post id="t3_feed111" post-title="Feed post" permalink="/r/FashionReps/comments/feed111/feed_post/" subreddit-prefixed-name="r/FashionReps">
    <p>W2C <a id="f1" href="https://weidian.com/item.html?itemID=7266666661" style="position:relative;pointer-events:auto">these</a> please</p>
  </shreddit-post>
</article></body></html>`;

const OLD_URL = 'https://old.reddit.com/r/FashionReps/comments/old777/old_style_post/';
const OLD_HTML = `<!doctype html><html><head><title>Old style post : FashionReps</title></head><body style="margin:40px">
<div id="siteTable"><div class="thing link" data-fullname="t3_old777" data-permalink="/r/FashionReps/comments/old777/old_style_post/" data-subreddit="FashionReps" data-author="oldposter">
  <a class="title" href="/r/FashionReps/comments/old777/old_style_post/">Old style post</a>
  <div class="usertext-body"><div class="md"><p>Cap: <a id="o1" href="https://weidian.com/item.html?itemID=7288888881">link</a></p></div></div>
</div></div>
<div class="commentarea"><div class="thing comment" data-permalink="/r/FashionReps/comments/old777/old_style_post/c0ffee1/" data-author="oldcommenter">
  <div class="usertext-body"><div class="md"><p>Scarf <a id="o2" href="https://item.taobao.com/item.htm?id=677777777771">here</a></p></div></div>
</div></div></body></html>`;

/** A bare listing: name, price and an Add To Cart button whose result the test decides. */
function superbuyStub(priceHtml, mode) {
  return `<!doctype html><html><head><title>Superbuy</title></head><body style="margin:40px">
<div class="buy-main"><section class="goods-info-header_container"><div class="goods-info_container card-wrap">
<div class="buy-info"><div class="goods-title"><h3 class="goods-title">Stub Listing Title 测试</h3></div>
${priceHtml}
<div class="goods-commit"><button class="goods-buyNow">Buy Now</button><button class="goods-addToCart">Add To Cart</button></div></div></div></section></div>
<script>document.querySelector('.goods-addToCart').addEventListener('click', () => {
  const mode = ${JSON.stringify(mode || 'silent')};
  if (mode === 'silent') return;
  const n = document.createElement('div'); n.className = 'ant-message-notice';
  n.innerHTML = mode === 'ok' ? '<div class="ant-message-success">Added to cart successfully</div>' : '<div class="ant-message-error">Please select specifications</div>';
  document.body.appendChild(n);
});</script></body></html>`;
}

/**
 * A listing with colour and size rows, built like the live Superbuy page: every row arrives with its
 * first choice already selected (li.sku-item.active), and there is no mini-cart on the page.
 *   confirm: 'toast' shows a success message after Add To Cart; 'silent' shows nothing.
 *   soldOut: a size to mark as unavailable.
 * Every Add To Cart and Buy Now press is written to localStorage, so the test can see exactly what was
 * added, how often, and from which tab.
 */
function optionStub(opts) {
  const o = Object.assign({ confirm: 'toast', soldOut: '' }, opts);
  const li = (text, i) => '<li class="sku-item' + (i === 0 ? ' active' : '') + (text === o.soldOut ? ' disabled' : '') + '">' + text + '</li>';
  return `<!doctype html><html><head><title>Superbuy</title><style>
body{margin:30px;font:14px sans-serif} .goods-options-tags{list-style:none;display:flex;gap:8px;padding:0} .goods-options-tags li{border:1px solid #999;padding:6px 12px;cursor:pointer}
.goods-options-tags li.active{border-color:#e33;color:#e33} .goods-options-tags li.disabled{opacity:.4} button{padding:8px 14px;margin-right:8px}</style></head><body>
<div class="buy-main"><div class="buy-info">
  <div class="goods-title"><h3 class="goods-title">Option Listing</h3></div>
  <div class="goods-price"><div class="price-content"><span class="appr">≈</span><i class="goods-rmb">US $</i><strong class="goods-txt">12.34</strong><p class="foreign-currency">CN ￥<span>88</span></p></div></div>
  <div class="goods-options">
    <dl class="goods-options-row"><dt class="goods-options-label"><span class="good-propName">Color</span><span class="select-tips"></span></dt>
      <dd class="goods-options-content"><ul class="goods-options-tags">${['Black', 'White'].map(li).join('')}</ul></dd></dl>
    <dl class="goods-options-row"><dt class="goods-options-label"><span class="good-propName">Size</span></dt>
      <dd class="goods-options-content"><ul class="goods-options-tags">${['S', 'M', 'L', 'XL'].map(li).join('')}</ul></dd></dl>
    <dl class="goods-options-row goods-options-freight"><dd class="new-goods-options-content">Superbuy Warehouse</dd></dl>
  </div>
  <div class="goods-commit"><button class="goods-buyNow">Buy Now</button><button class="goods-addToCart">Add To Cart</button></div>
</div></div>
<script>
const item = (new URLSearchParams(location.search).get('url') || '').replace(/^.*[=/]/, '').replace(/\\D/g, '');
const log = (what) => { const all = JSON.parse(localStorage.getItem('rhLog') || '[]'); all.push(what); localStorage.setItem('rhLog', JSON.stringify(all)); };
for (const li of document.querySelectorAll('.goods-options-tags li')) li.addEventListener('click', () => {
  if (li.classList.contains('disabled')) return;
  for (const x of li.parentElement.children) x.classList.remove('active');
  li.classList.add('active');
});
document.querySelector('.goods-buyNow').addEventListener('click', () => log('BUY ' + item));
document.querySelector('.goods-addToCart').addEventListener('click', () => {
  log(item + ' ' + Array.from(document.querySelectorAll('.goods-options-tags')).map((l) => (l.querySelector('li.active') || {}).textContent).join('/'));
  if (${JSON.stringify(o.confirm)} !== 'toast') return;
  const n = document.createElement('div'); n.className = 'ant-message-notice';
  n.innerHTML = '<div class="ant-message-success">Added to cart</div>';
  document.body.appendChild(n);
});
</script></body></html>`;
}

const SHEET_INDEX = `<html><head><title>Finds - Google Drive</title></head><body><script>var items=[];items.push({name: "Shoes", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/SHEETID\\/htmlview\\/sheet?headers\\x3dtrue&gid=0", gid: "0"});items.push({name: "Tops", pageUrl: "https:\\/\\/docs.google.com\\/spreadsheets\\/d\\/SHEETID\\/htmlview\\/sheet?headers\\x3dtrue&gid=77", gid: "77"});</script>
<iframe id="pageswitcher-content" style="width:900px;height:400px" src="https://docs.google.com/spreadsheets/d/SHEETID/htmlview/sheet?headers=true&gid=0"></iframe></body></html>`;
const SHEET_TAB = {
  0: `<html><head><title>Finds</title></head><body><table><tr><th>1</th><td>Samba OG</td><td>¥180</td><td><a href="https://www.google.com/url?q=https://weidian.com/item.html?itemID%3D7111111111&sa=D">LINK</a></td></tr>
      <tr><th>2</th><td>Gel Kayano</td><td>¥260</td><td>https://item.taobao.com/item.htm?id=688888888888</td></tr></table></body></html>`,
  77: `<html><head><title>Finds</title></head><body><table><tr><th>1</th><td>Box logo tee</td><td><a href="https://www.google.com/url?q=https://cnfans.com/product/?shop_type%3Dweidian%26id%3D7122222222">LINK</a></td></tr></table></body></html>`,
};

// --------------------------------------------------------------------- main

(async () => {
  const probe = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true });
  const major = (await probe.version()).split('/')[1].split('.')[0];
  await probe.close();
  // Yupoo refuses the literal "HeadlessChrome" user agent, so present the normal one.
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, pipe: true, enableExtensions: true,
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--user-agent=' + UA],
    defaultViewport: { width: 1280, height: 900 },
  });
  const extId = await browser.installExtension(EXT);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId), { timeout: 15000 });
  const sw = await swTarget.worker();
  const store = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys || null);
  const item = async (key) => ((await store(['items'])).items || {})[key];
  await sleep(1500);

  // Weidian item pages (shop + translated name) come from a fixture. `__pageHits` counts how often one is asked for.
  await sw.evaluate(() => {
    const real = self.fetch;
    self.__pageHits = 0;
    self.__shortHits = [];
    const known = { 7237185689: ['Triangle logo short sleeve tee', 1815387116, 'RM.OOTD'], 7870660857: ['Embroidered zip-up hoodie', 2004619, 'WF shop'] };
    self.fetch = (u, o) => {
      const url = String(u);
      if (url.startsWith('https://k.youshop10.com/')) {
        // Weidian's shortener: stands in for the redirect to an item page (only the final address is read).
        self.__shortHits.push((o && o.method) || 'GET');
        return Promise.resolve({ status: 200, ok: true, url: 'https://weidian.com/item.html?itemID=7399999991' });
      }
      if (!url.startsWith('https://weidian.com/item.html')) return real(u, o);
      self.__pageHits++;
      const id = new URL(url).searchParams.get('itemID');
      const k = known[id] || ['Listing ' + id, 1000001, 'Fixture shop'];
      const obj = id === '1111111'
        ? { status: { code: 831013, message: '商品不存在' }, result: null }
        : { status: { code: 0, message: 'OK' }, result: { default_model: { item_info: { item_name: k[0], item_head: 'https://si.geilicdn.com/x.jpg', shop_id: k[1] }, shop_info: { shop_id: k[1], shopName: k[2] } } } };
      const html = '<html><body><script id="__rocker-render-inject__" type="application/json" data-obj="' + JSON.stringify(obj).replace(/&/g, '&amp;').replace(/"/g, '&#34;') + '"></script></body></html>';
      return Promise.resolve(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    };
  });

  async function fixturePage(url, routes, opts) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      for (const [prefix, body] of routes) {
        if (!u.startsWith(prefix)) continue;
        const text = typeof body === 'function' ? body(u) : body;
        return req.respond({ status: 200, contentType: text.trim().startsWith('<') ? 'text/html; charset=utf-8' : 'application/json', body: text });
      }
      if (/^https:\/\/([a-z]+\.reddit\.com|www\.superbuy\.com|docs\.google\.com|[a-z.]*redditstatic\.com|[a-z.]*redd\.it|web\.archive\.org)\//.test(u)) return req.respond({ status: 404, body: '' });
      req.continue();
    });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (opts && opts.css) await page.addStyleTag({ content: opts.css });
    return page;
  }

  /**
   * Run a function inside the extension's isolated world on a page (optionally in a sub-frame whose URL
   * contains `frameUrlPart`). In there `root(el)` opens RepHop's closed shadow roots and `ui()` is the
   * root that holds the card, the bar, the chooser and the toasts.
   */
  async function world(page, frameUrlPart) {
    const client = await page.createCDPSession();
    const contexts = new Map();
    client.on('Runtime.executionContextCreated', (e) => contexts.set(e.context.id, e.context));
    client.on('Runtime.executionContextDestroyed', (e) => contexts.delete(e.executionContextId));
    client.on('Runtime.executionContextsCleared', () => contexts.clear());
    await client.send('Runtime.enable');
    return async (fn, ...args) => {
      const tree = (await client.send('Page.getFrameTree')).frameTree;
      let frameId = tree.frame.id;
      if (frameUrlPart) {
        const child = (tree.childFrames || []).find((c) => c.frame.url.includes(frameUrlPart));
        if (!child) throw new Error('no frame matching ' + frameUrlPart);
        frameId = child.frame.id;
      }
      const ctx = await until(() => Array.from(contexts.values()).reverse().find((c) => c.auxData && c.auxData.type === 'isolated' && c.auxData.frameId === frameId && /RepHop/.test(c.name || '')), 8000);
      if (!ctx) throw new Error('content script world not found');
      const expression = '(() => { const root = (el) => chrome.dom.openOrClosedShadowRoot(el); const ui = () => root(document.querySelector("[data-rh-root]")); return (' + fn.toString() + ')(...' + JSON.stringify(args) + '); })()';
      const res = await client.send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error('in content world: ' + (res.exceptionDetails.exception ? res.exceptionDetails.exception.description : res.exceptionDetails.text));
      return res.result.value;
    };
  }

  const pillOf = (w, id) => w((id) => {
    const el = document.getElementById(id) || document.querySelector(id);
    const host = el && el.nextElementSibling;
    if (!host || !host.hasAttribute('data-rh-pill')) return null;
    const r = root(host);
    return { cls: r.querySelector('.pill').className, hot: r.querySelector('.wrap').classList.contains('hot'), go: r.querySelector('.go').textContent.trim(), saveOn: r.querySelector('.save').classList.contains('on'), tab: r.querySelector('.go').tabIndex, width: Math.round(host.getBoundingClientRect().width) };
  }, id);
  const barOf = (w) => w(() => {
    const b = ui().querySelector('.bar');
    const out = { on: b.classList.contains('on'), collapsed: b.classList.contains('collapsed') };
    for (const el of b.querySelectorAll('[data-act]')) out[el.dataset.act] = el.hidden ? null : el.textContent.trim() || true;
    out.q = b.querySelector('.q').hidden ? null : b.querySelector('.q').textContent;
    return out;
  });
  const cardOf = (w) => w(() => {
    const el = ui().querySelector('.card');
    const img = el.querySelector('.pic img');
    return { on: el.classList.contains('on'), title: el.querySelector('.title').textContent, sub: el.querySelector('.sub').textContent, price: el.querySelector('.price').textContent, tags: el.querySelector('.tags').textContent, keys: el.querySelector('.keys').textContent, img: img ? img.naturalWidth : 0, src: img ? img.src : '' };
  });
  const toastsOf = (w) => w(() => Array.from(ui().querySelectorAll('.toast')).map((t) => ({ text: t.querySelector('span').textContent, buttons: Array.from(t.querySelectorAll('button')).map((b) => b.textContent) })));
  /** Click something inside RepHop's own UI with a real mouse event. `find` runs in the content world and returns the element. */
  async function clickUi(page, w, find, ...args) {
    const pt = await w(new Function('...a', 'const el = (' + find.toString() + ')(...a); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };'), ...args);
    if (!pt) throw new Error('UI element not found: ' + find.toString().slice(0, 90));
    await page.mouse.click(pt.x, pt.y);
  }
  /** Click a button on a toast, waiting for the toast (whose text contains `about`) to appear first. */
  async function clickToast(page, w, label, about) {
    const find = (label, about) => {
      const toast = Array.from(ui().querySelectorAll('.toast')).reverse().find((t) => t.querySelector('span').textContent.includes(about || '') && Array.from(t.querySelectorAll('button')).some((b) => b.textContent === label));
      return toast ? Array.from(toast.querySelectorAll('button')).find((b) => b.textContent === label) : null;
    };
    const there = await until(() => w(new Function('...a', 'return !!(' + find.toString() + ')(...a);'), label, about || ''), 6000);
    if (!there) throw new Error('no toast button "' + label + '" on a toast about "' + (about || '') + '"');
    await sleep(250);
    await clickUi(page, w, find, label, about || '');
  }
  const clickBar = (page, w, act) => clickUi(page, w, (act) => ui().querySelector('.bar [data-act="' + act + '"]'), act);
  const clickPill = (page, w, id, part) => clickUi(page, w, (id, part) => root(document.getElementById(id).nextElementSibling).querySelector('.' + part), id, part);
  const centre = async (page, sel) => {
    const b = await (await page.$(sel)).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const agentTabs = async () => (await browser.pages()).filter((p) => /superbuy\.com/.test(p.url()));
  const sbUrl = (inner) => 'https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=' + encodeURIComponent(inner);
  const closeAgentTabs = async () => {
    for (const p of await agentTabs()) await p.close();
    await sw.evaluate(() => chrome.storage.session.remove(['agentTabId', 'agentTabUrl']));
  };
  for (const p of await browser.pages()) if (p.url().includes('panel.html')) await p.close();

  // ==================================================== 0. first run: no agent is assumed
  const first = await browser.newPage();
  await first.setViewport({ width: 420, height: 900 });
  await first.goto('chrome-extension://' + extId + '/panel/panel.html', { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  const fresh = await first.evaluate(() => ({
    theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor,
    pick: !document.getElementById('pick-agent').hidden, agents: Array.from(document.querySelectorAll('#pick-grid button')).map((b) => b.textContent),
    select: document.getElementById('q-agent').value, selectText: document.getElementById('q-agent').selectedOptions[0].textContent, unset: document.getElementById('q-agent').classList.contains('unset'),
  }));
  check('first run: the list is dark by default', fresh.theme === 'dark' && fresh.bg === 'rgb(18, 21, 28)', fresh);
  check('first run: no agent is preselected; the list asks which one you use', fresh.pick && fresh.select === '' && /your agent/.test(fresh.selectText) && fresh.unset && fresh.agents.includes('Superbuy') && fresh.agents.includes('CNFans'), fresh);
  if (SHOTS) await first.screenshot({ path: path.join(SHOTS, 'panel-first-run.png') });
  await first.close();

  // =============================================================== 1. Reddit
  const reddit = await fixturePage(POST, [[POST, REDDIT_HTML], ['https://www.reddit.com/comments/abc123.json', REDDIT_JSON]]);
  const rw = await world(reddit);
  await sleep(1200);

  const pills = await reddit.evaluate(() => Array.from(document.querySelectorAll('[data-rh-pill]')).map((p) => p.previousElementSibling.id || p.previousElementSibling.className));
  check('buttons added next to 4 links + 1 plain-text link, none on the ordinary or picture link', pills.length === 5 && ['l1', 'l2', 'l3', 'l4', 'rh-text'].every((x) => pills.includes(x)), pills);
  check('before an agent is chosen the button says GO, and adds no tab stop', ((await pillOf(rw, 'l1')) || {}).go === 'GO' && (await pillOf(rw, 'l1')).tab === -1, await pillOf(rw, 'l1'));
  check('corner bar offers "Save all 6 links" (the picture link counts)', /Save all 6 links/.test((await barOf(rw)).grab || ''), await barOf(rw));
  const leak = await reddit.evaluate(() => ({ pill: document.querySelector('[data-rh-pill]').shadowRoot, ui: document.querySelector('[data-rh-root]').shadowRoot }));
  check('page scripts cannot open RepHop\'s shadow roots', leak.pill === null && leak.ui === null, leak);

  // first click: nothing opens until the user has said which agent they use
  await reddit.click('#l1');
  const asked = await until(() => rw(() => !ui().querySelector('.chooser').hidden), 4000);
  check('the first click asks which agent you use instead of assuming one', asked && (await agentTabs()).length === 0 && reddit.url() === POST, { asked, tabs: (await agentTabs()).length });
  if (SHOTS) await reddit.screenshot({ path: path.join(SHOTS, 'chooser.png') });
  // "Not now" still honours the click: the plain link opens in a new tab, and the question comes back next time
  await clickUi(reddit, rw, () => Array.from(ui().querySelectorAll('.chooser button')).find((b) => b.textContent === 'Not now'));
  const plain = await until(async () => (await browser.pages()).find((p) => /weidian\.com\/item\.html\?itemID=7237185689/.test(p.url())), 6000);
  check('"Not now" opens the plain link instead of swallowing the click', !!plain && !(await store(['settings'])).settings, plain ? plain.url() : 'no tab');
  if (plain) await plain.close();
  await reddit.bringToFront();
  await reddit.click('#l1');
  await until(() => rw(() => !ui().querySelector('.chooser').hidden), 4000);
  await clickUi(reddit, rw, () => Array.from(ui().querySelectorAll('.chooser button')).find((b) => b.textContent === 'Superbuy'));
  let tabs = await until(async () => { const t = await agentTabs(); return t.length ? t : null; });
  check('choosing Superbuy there carries on and opens the listing', tabs && tabs.length === 1 && tabs[0].url() === sbUrl('https://weidian.com/item.html?itemID=7237185689') && (await store(['settings'])).settings.agent === 'superbuy', tabs && tabs.map((t) => t.url()));
  check('Reddit tab did not navigate away, and buttons now show the agent', reddit.url() === POST && (await until(async () => ((await pillOf(rw, 'l1')) || {}).go === 'SB', 4000)), await pillOf(rw, 'l1'));

  // a mouse click must not leave the link "focused": no stuck card, no hotkeys aimed at it
  await reddit.bringToFront();
  await reddit.mouse.move(700, 600);
  await sleep(1000);
  await reddit.keyboard.press('a');
  await sleep(1200);
  check('after clicking a link and moving away, its card is gone and the hotkeys do nothing', !(await cardOf(rw)).on && !(await item('weidian:7237185689')), { card: (await cardOf(rw)).on, saved: !!(await item('weidian:7237185689')) });

  await reddit.click('#l3');
  await until(async () => (await agentTabs()).some((t) => /7870660857/.test(t.url())));
  tabs = await agentTabs();
  check('second click reuses the same tab (CNFans link converted)', tabs.length === 1 && /itemID%3D7870660857/.test(tabs[0].url()), tabs.map((t) => t.url()));

  await reddit.bringToFront();
  await reddit.click('#pic');
  await until(async () => (await agentTabs()).some((t) => /7299999999/.test(t.url())));
  tabs = await agentTabs();
  check('a picture-only link is converted too, still in the same tab', tabs.length === 1 && /7299999999/.test(tabs[0].url()), tabs.map((t) => t.url()));

  // ---- the reused tab is left alone once the user has moved on in it
  const taken = tabs[0];
  await taken.goto('https://example.org/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await reddit.bringToFront();
  await reddit.click('#l1');
  await until(async () => (await agentTabs()).length === 1);
  tabs = await agentTabs();
  check('a tab the user took elsewhere is not overwritten; a fresh one is opened', /example\.org/.test(taken.url()) && tabs.length === 1 && tabs[0] !== taken, { taken: taken.url(), agent: tabs.map((t) => t.url().slice(-30)) });
  await taken.close();
  const homeTab = tabs[0];
  await homeTab.goto('https://www.superbuy.com/en/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const elsewhere = homeTab.url();
  await reddit.bringToFront();
  await reddit.click('#l3');
  await until(async () => (await agentTabs()).some((t) => /7870660857/.test(t.url())));
  tabs = await agentTabs();
  check('a Superbuy page that is not a listing (cart, checkout, home) is not overwritten either', homeTab.url() === elsewhere && !/page\/buy/.test(elsewhere) && tabs.length === 2, tabs.map((t) => t.url().slice(0, 60)));
  await homeTab.close();
  await reddit.bringToFront();
  await reddit.click('#l1');
  await until(async () => (await agentTabs()).some((t) => /7237185689/.test(t.url())));
  check('and the new listing tab is the one reused from then on', (await agentTabs()).length === 1);

  // ---- two real clicks in quick succession must still end up in one tab
  await closeAgentTabs();
  await reddit.bringToFront();
  const c1 = await centre(reddit, '#l1');
  const c3 = await centre(reddit, '#l3');
  await Promise.all([reddit.mouse.click(c1.x, c1.y), reddit.mouse.click(c3.x, c3.y)]);
  await sleep(3000);
  tabs = await agentTabs();
  check('two clicks in quick succession open one agent tab, not two', tabs.length === 1, tabs.map((t) => t.url().slice(-30)));

  // ---- ordinary behaviour is preserved; script-made clicks are not acted on
  await reddit.bringToFront();
  await reddit.evaluate(() => {
    window.__seen = {};
    document.getElementById('normal').addEventListener('click', (e) => { window.__seen.normal = e.defaultPrevented; e.preventDefault(); }, { once: true });
    document.getElementById('l4').addEventListener('click', (e) => { window.__seen.shift = e.defaultPrevented; e.preventDefault(); }, { once: true });
  });
  await reddit.click('#normal');
  await reddit.keyboard.down('Shift');
  await reddit.click('#l4');
  await reddit.keyboard.up('Shift');
  const seen = await reddit.evaluate(() => window.__seen);
  check('ordinary links are not intercepted', seen.normal === false, seen);
  check('shift+click reaches the page untouched', seen.shift === false, seen);
  const beforeScript = (await agentTabs())[0].url();
  await reddit.evaluate(() => {
    const a = document.getElementById('l3');
    const stay = (e) => e.preventDefault(); // keep the test page where it is; RepHop is expected to do nothing at all
    a.addEventListener('click', stay);
    a.click();
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, altKey: true }));
    a.removeEventListener('click', stay);
  });
  await sleep(1500);
  check('a click made by a page script is ignored: nothing opens, nothing is saved', (await agentTabs())[0].url() === beforeScript && !(await item('weidian:7870660857')));
  await reddit.evaluate(() => document.getElementById('l3').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await reddit.mouse.move(705, 605);
  await reddit.mouse.move(700, 600);
  await reddit.keyboard.press('a');
  await sleep(1200);
  check('a made-up mouseover from a page script cannot aim the hotkeys at a link', !(await item('weidian:7870660857')));

  // ---- saving
  await reddit.keyboard.down('Alt');
  await reddit.click('#l4');
  await reddit.keyboard.up('Alt');
  const tb = await until(() => item('taobao:675330231400'));
  check('alt+click saves the item with its Reddit context', !!tb && tb.label === 'this one' && tb.sources[0].sub === 'r/FashionReps' && /def456/.test(tb.sources[0].commentUrl) && tb.sources[0].author === 'someone' && tb.sources[0].postTitle === 'Budget haul finds', tb && { label: tb.label, src: tb.sources[0] });
  check('its button flips to saved', await until(async () => ((await pillOf(rw, 'l4')) || {}).saveOn === true, 4000), await pillOf(rw, 'l4'));
  check('an opened link is marked viewed', /viewed/.test(((await pillOf(rw, 'l1')) || {}).cls || ''), await pillOf(rw, 'l1'));

  // ---- hotkeys: a link that slides under a resting cursor while scrolling does not arm them
  await reddit.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'farp';
    p.style.marginTop = '1500px';
    p.innerHTML = '<a id="far" href="https://weidian.com/item.html?itemID=7244444441">far link</a>';
    document.body.appendChild(p);
    document.body.style.paddingBottom = '1500px';
    window.scrollTo(0, 0);
  });
  await sleep(900);
  const farBox = await reddit.evaluate(() => { const r = document.getElementById('far').getBoundingClientRect(); return { x: r.x + 12, y: r.y + r.height / 2 }; });
  await reddit.mouse.move(farBox.x, 620);
  await reddit.mouse.wheel({ deltaY: Math.round(farBox.y - 620) });
  await sleep(900);
  const under = await reddit.evaluate((x) => { const el = document.elementFromPoint(x, 620); return el && el.id; }, farBox.x);
  await reddit.keyboard.press('a');
  await sleep(1200);
  check('a link that slid under a resting cursor during scrolling does not arm the hotkeys', under === 'far' && !(await item('weidian:7244444441')), { under, saved: !!(await item('weidian:7244444441')) });
  await reddit.mouse.move(farBox.x + 3, 621);
  await sleep(150);
  await reddit.keyboard.press('a');
  check('moving the mouse onto it does: hover + A saves', !!(await until(() => item('weidian:7244444441'), 6000)));
  await reddit.evaluate(() => { document.getElementById('farp').remove(); document.body.style.paddingBottom = ''; window.scrollTo(0, 0); });
  await sw.evaluate(() => removeItems(['weidian:7244444441']));
  await sleep(600);

  await reddit.hover('#normal');
  await reddit.hover('#l1');
  await sleep(150);
  await reddit.keyboard.press('a');
  await until(async () => { const it = await item('weidian:7237185689'); return it && it.title && it.seller; }, 12000);
  const wd = await item('weidian:7237185689');
  check('hover + A saves; the name comes from the words before the link', !!wd && wd.label === 'Black hoodie', wd && wd.label);
  check('Weidian preview is filled in from the item API (real network): name, price, picture', !!wd && !!wd.title && typeof wd.price === 'number' && /^https:/.test(wd.image || ''), wd && { title: wd.title, price: wd.price, check: wd.check });
  check('the shop and the translated name are added from the item page shortly after saving', !!wd && !!wd.seller && wd.seller.key === 'weidian:1815387116' && wd.seller.name === 'RM.OOTD' && wd.titleEn === 'Triangle logo short sleeve tee', wd && { seller: wd.seller, titleEn: wd.titleEn });

  await reddit.hover('.rh-text');
  await sleep(150);
  await reddit.keyboard.press('s');
  await until(async () => (await agentTabs()).some((t) => /7231112223/.test(t.url())));
  tabs = await agentTabs();
  check('hover + S on a plain-text link opens it in the same tab', tabs.length === 1 && /itemID%3D7231112223/.test(tabs[0].url()), tabs.map((t) => t.url()));
  await reddit.bringToFront();
  await reddit.hover('#l1');
  await reddit.focus('#box');
  await reddit.keyboard.type('sa');
  await sleep(500);
  check('hotkeys are ignored while typing', (await reddit.$eval('#box', (b) => b.value)) === 'sa');
  // keyboard users: Shift+Tab from the text box lands on the picture link; the card shows and A saves it
  await reddit.mouse.move(700, 600);
  await reddit.keyboard.down('Shift');
  await reddit.keyboard.press('Tab');
  await reddit.keyboard.up('Shift');
  const focusedId = await reddit.evaluate(() => document.activeElement && document.activeElement.id);
  const focusCard = await until(async () => { const c = await cardOf(rw); return c.on ? c : null; }, 4000);
  await reddit.keyboard.press('a');
  const viaKeyboard = await until(() => item('weidian:7299999999'), 6000);
  check('keyboard users: Tab to a link, see its card, press A to save it', focusedId === 'pic' && !!focusCard && !!viaKeyboard, { focusedId, card: !!focusCard, saved: !!viaKeyboard });
  await reddit.keyboard.press('Escape');
  await sleep(300);
  check('Escape closes the card', !(await cardOf(rw)).on);
  await sw.evaluate(() => removeItems(['weidian:7299999999']));
  await reddit.evaluate(() => document.activeElement.blur());

  // ---- the "click opens at your agent" switch covers plain-text links as well
  await sw.evaluate(() => handlers.settings({ patch: { clickHijack: false } }));
  await sleep(500);
  const beforeSwitch = (await agentTabs())[0].url();
  await reddit.bringToFront();
  await reddit.click('.rh-text');
  await sleep(1500);
  check('with the click switch off, a plain-text link no longer opens anything', (await agentTabs()).length === 1 && (await agentTabs())[0].url() === beforeSwitch && reddit.url() === POST);
  await sw.evaluate(() => handlers.settings({ patch: { clickHijack: true } }));
  await sleep(400);

  // ---- hover card
  await reddit.bringToFront();
  await reddit.hover('#normal');
  await reddit.hover('#l1');
  const card = await until(async () => { const c = await cardOf(rw); return c.on && c.img > 0 && /¥/.test(c.price) ? c : null; }, 9000);
  check('hover card shows name, price, saved badge, key hints and a small picture', !!card && card.title === 'Black hoodie' && /In your list/.test(card.tags) && /S\s+open/.test(card.keys) && /[?&]w=200/.test(card.src) && card.img <= 400, card);
  if (SHOTS) await reddit.screenshot({ path: path.join(SHOTS, 'reddit.png') });

  // ---- Yupoo album: resolved over the real network, de-duplicated against the CNFans link for the same item
  await reddit.hover('#normal');
  await clickPill(reddit, rw, 'l2', 'save');
  const y = await until(() => item('weidian:7870660857'), 15000);
  check('a Yupoo album resolves to its Weidian buy link (real network)', !!y && y.aliases.includes('yupoo:singor/258055580'), y ? { aliases: y.aliases, label: y.label, price: y.price } : 'not saved');
  check('its name comes from the Reddit link text', !!y && y.label === 'Pony zip hoodie', y && y.label);
  check('both the Yupoo link and the CNFans link for that item show as saved', await until(async () => ((await pillOf(rw, 'l2')) || {}).saveOn && ((await pillOf(rw, 'l3')) || {}).saveOn, 5000), { l2: await pillOf(rw, 'l2'), l3: await pillOf(rw, 'l3') });

  // ---- a link that appears right under the mouse
  const lateBox = await reddit.evaluate(() => { const r = document.getElementById('late').getBoundingClientRect(); return { x: r.x + 14, y: r.y + 28 }; });
  await reddit.mouse.move(lateBox.x, lateBox.y);
  await reddit.evaluate(() => {
    const p = document.createElement('p');
    p.innerHTML = '<a id="late1" href="https://weidian.com/item.html?itemID=7255555551">late link</a>';
    document.getElementById('late').appendChild(p);
  });
  await sleep(1300);
  check('a link that appears under the mouse still gets its button and is counted', !!(await pillOf(rw, 'late1')) && /Save all 7 links/.test((await barOf(rw)).grab || ''), { pill: await pillOf(rw, 'late1'), bar: (await barOf(rw)).grab });

  // ---- a page that never stops changing must not starve the scan
  await reddit.evaluate(() => {
    window.__storm = setInterval(() => { const s = document.createElement('span'); s.textContent = '.'; document.body.appendChild(s); }, 100);
    const p = document.createElement('p');
    p.id = 'stormp';
    p.innerHTML = '<a id="storm1" href="https://weidian.com/item.html?itemID=7277777771">storm link</a>';
    document.getElementById('late').appendChild(p);
  });
  const stormPill = await until(() => pillOf(rw, 'storm1'), 2500, 150);
  await reddit.evaluate(() => { clearInterval(window.__storm); document.getElementById('stormp').remove(); });
  check('on a page that keeps changing, a new link still gets its button within a couple of seconds', !!stormPill);
  await sleep(700);

  // ---- save all: page links + the thread JSON, with progress and an honest note about what Reddit held back
  await reddit.mouse.move(700, 600);
  await clickBar(reddit, rw, 'grab');
  const grabToast = await until(async () => (await toastsOf(rw)).find((t) => /Saved \d+ new/.test(t.text)), 15000);
  let items = (await store(['items'])).items || {};
  const keys = Object.keys(items).sort();
  check('"Save all" saves every link, including a collapsed reply that only exists in the thread JSON', ['1688:622042419913', 'weidian:7231112223', 'weidian:7255555551', 'weidian:7299999999', 'weidian:7870660857', 'weidian:7237185689', 'taobao:675330231400'].every((k) => keys.includes(k)) && keys.length === 7, keys);
  check('its message says how many comments Reddit did not hand over', !!grabToast && /held back about 37 more comments/.test(grabToast.text) && grabToast.buttons.includes('Open list'), grabToast);
  const sock = items['1688:622042419913'];
  check('an item from the thread JSON keeps its comment link and label', !!sock && /ghi789/.test((sock.sources[0] || {}).commentUrl || '') && /Factory socks/.test(sock.label), sock && { label: sock.label, src: sock.sources[0] });
  check('the same product reached through three links is stored once', keys.filter((k) => k.includes('7870660857')).length === 1);

  // ---- the green check asks before removing
  await sleep(4200);
  await clickPill(reddit, rw, 'l4', 'save');
  await sleep(600);
  let t = (await toastsOf(rw)).pop();
  check('clicking a saved button asks instead of deleting', !!t && /Already in your list/.test(t.text) && t.buttons.includes('Remove') && t.buttons.includes('Open list') && !!(await item('taobao:675330231400')), t);
  await clickToast(reddit, rw, 'Remove', 'Already in your list');
  check('Remove takes it out of the list', await until(async () => !(await item('taobao:675330231400'))));
  await clickToast(reddit, rw, 'Undo', 'Removed from your list');
  check('Undo puts it back, context intact', await until(async () => { const it = await item('taobao:675330231400'); return it && it.sources.length === 1 && it.label === 'this one'; }));

  // ---- the "seen in N posts" count must not change the button's size (a page could measure that)
  const plainWidth = (await pillOf(rw, 'l1')).width;
  await sw.evaluate(() => recordSeen([{ key: 'weidian:7237185689', postId: 'other1' }, { key: 'weidian:7237185689', postId: 'other2' }]));
  const hot = await until(async () => { const p = await pillOf(rw, 'l1'); return p && p.hot ? p : null; }, 5000);
  check('the "seen in other posts" marker shows without changing the button\'s size', !!hot && hot.width === plainWidth, { before: plainWidth, after: hot });

  // ---- the list button on the page (must reach sidePanel.open inside the click gesture)
  await sw.evaluate(() => {
    self.__panel = 'not called';
    const real = chrome.sidePanel.open.bind(chrome.sidePanel);
    chrome.sidePanel.open = (o) => real(o).then((r) => { self.__panel = 'ok'; return r; }, (e) => { self.__panel = 'ERR ' + e.message; throw e; });
  });
  await clickBar(reddit, rw, 'panel');
  check('the list button on the page opens the side panel', await until(() => sw.evaluate(() => self.__panel === 'ok'), 4000), await sw.evaluate(() => self.__panel));

  // ============================================== 1b. a feed card with a full-card link
  const feed = await fixturePage(FEED_URL, [[FEED_URL, FEED_HTML]]);
  const fw = await world(feed);
  await sleep(1200);
  const over = await feed.evaluate(() => {
    const pill = document.querySelector('[data-rh-pill]');
    if (!pill) return null;
    const r = pill.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hit: at === pill, tag: at && (at.id || at.tagName) };
  });
  check('in a feed card, the button sits above the full-card link', !!over && over.hit, over);
  await clickPill(feed, fw, 'f1', 'go');
  await until(async () => (await agentTabs()).some((p) => /7266666661/.test(p.url())));
  check('clicking it opens the listing and does not open the post', (await agentTabs()).some((p) => /7266666661/.test(p.url())) && feed.url() === FEED_URL, feed.url());
  await feed.close();

  // ============================================================ 2. old Reddit
  const old = await fixturePage(OLD_URL, [[OLD_URL, OLD_HTML]]);
  await sleep(1000);
  await old.keyboard.down('Alt');
  await old.click('#o2');
  await old.click('#o1');
  await old.keyboard.up('Alt');
  await until(async () => (await item('taobao:677777777771')) && (await item('weidian:7288888881')));
  const o1 = await item('weidian:7288888881');
  const o2 = await item('taobao:677777777771');
  check('old Reddit: post link keeps post title, subreddit and author', !!o1 && o1.label === 'Cap' && o1.sources[0].postTitle === 'Old style post' && o1.sources[0].sub === 'r/FashionReps' && o1.sources[0].postId === 'old777' && o1.sources[0].author === 'oldposter', o1 && o1.sources[0]);
  check('old Reddit: comment link keeps the comment permalink and author', !!o2 && /c0ffee1/.test(o2.sources[0].commentUrl) && o2.sources[0].author === 'oldcommenter' && o2.label === 'Scarf', o2 && { label: o2.label, src: o2.sources[0] });
  await old.close();

  // ===================================================== 3. the agent's listing page
  const listing = sbUrl('https://item.taobao.com/item.htm?id=675330231400');
  let sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">US $<span>18.42</span></p>', 'silent')]]);
  let sbw = await world(sb);
  await until(async () => ((await item('taobao:675330231400')) || {}).title);
  let scraped = await item('taobao:675330231400');
  check('listing page: the name is read, and a price not labelled as yuan is NOT taken', scraped.title === 'Stub Listing Title 测试' && scraped.price == null, { title: scraped.title, price: scraped.price });
  const sbBar = await barOf(sbw);
  check('on the agent page the bar shows Saved + QC, not "Open in Superbuy"', sbBar.on && !sbBar.open && /Saved to RepHop/.test(sbBar.save || '') && !!sbBar.qc, sbBar);
  await sb.click('button.goods-addToCart');
  t = await until(async () => (await toastsOf(sbw)).find((x) => /Did that go into your cart/.test(x.text)), 5000);
  check('Add To Cart with no confirmation from the site: RepHop asks instead of guessing', !!t && (await item('taobao:675330231400')).status === 'saved', t);
  await clickToast(sb, sbw, 'Yes, mark it', 'Did that go into your cart');
  check('answering yes marks it in cart', await until(async () => (await item('taobao:675330231400')).status === 'carted'));
  await sb.close();

  await sw.evaluate(() => updateItems(['taobao:675330231400'], { status: 'saved' }));
  sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">CN ￥<span>123.45</span></p>', 'error')]]);
  sbw = await world(sb);
  check('a price labelled "CN ￥" is taken', await until(async () => (await item('taobao:675330231400')).price === 123.45), (await item('taobao:675330231400')).price);
  await sleep(600);
  await sb.click('button.goods-addToCart');
  await sleep(2600);
  check('when the site shows an error after Add To Cart, nothing is marked and nothing is asked', (await item('taobao:675330231400')).status === 'saved' && !(await toastsOf(sbw)).some((x) => /cart/i.test(x.text)), await toastsOf(sbw));
  await sb.close();

  sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">CN ￥<span>123.45</span></p>', 'ok')]]);
  sbw = await world(sb);
  await sleep(1500);
  await sb.click('button.goods-addToCart');
  check('when the site confirms, the item is marked in cart automatically', await until(async () => (await item('taobao:675330231400')).status === 'carted', 6000));
  await sb.close();

  // the page set to show yuan: no "foreign currency" line, the main price is the yuan one
  await sw.evaluate(() => saveEntries([{ url: 'https://item.taobao.com/item.htm?id=655555555501', label: 'Yuan display' }, { url: 'https://item.taobao.com/item.htm?id=655555555502', label: 'Refused item' }]));
  sb = await fixturePage(sbUrl('https://item.taobao.com/item.htm?id=655555555501'), [['https://www.superbuy.com/en/page/buy/', superbuyStub('<div class="price-content"><i class="goods-rmb">CN ￥</i><strong class="goods-txt">66.60</strong></div>', 'silent')]]);
  check('with the page showing yuan, the price is read from the main price', await until(async () => (await item('taobao:655555555501')).price === 66.6, 6000), (await item('taobao:655555555501')).price);
  await sb.close();
  // an item the agent refuses: a notice and a wall of other products, none of which is this item
  const refused = '<!doctype html><html><head><title>Superbuy</title></head><body><div class="dialogRisk">Risk Reminder</div><div class="waterfall">' +
    '<div class="card"><p class="goods-title">LEM Outdoor Camping Light</p></div><div class="card"><h3 class="goods-title">Some other product</h3></div></div></body></html>';
  sb = await fixturePage(sbUrl('https://item.taobao.com/item.htm?id=655555555502'), [['https://www.superbuy.com/en/page/buy/', refused]]);
  await sleep(4000);
  const notRead = await item('taobao:655555555502');
  check('when the agent refuses an item, nothing on that page is taken as its name', notRead.title === '' && U_displayTitle(notRead) === 'Refused item', { title: notRead.title });
  await sb.close();
  await sw.evaluate(() => removeItems(['taobao:655555555501', 'taobao:655555555502']));

  // ---- already on the agent's site: saving from there, with the options picked on the page
  const optRoutes = [['https://www.superbuy.com/en/page/buy/', optionStub()]];
  // The page arrives with Black / S already selected by the site. Saving without touching anything must
  // not record that as something the user picked.
  const untouched = await fixturePage(sbUrl('https://weidian.com/item.html?itemID=7355555553'), optRoutes);
  const uw = await world(untouched);
  await sleep(1200);
  await clickBar(untouched, uw, 'save');
  const plainSave = await until(() => item('weidian:7355555553'), 6000);
  check('saving from a listing without choosing anything does not record the site\'s pre-selected colour and size as yours', !!plainSave && !plainSave.options, plainSave && plainSave.options);
  await untouched.close();
  await sw.evaluate(() => removeItems(['weidian:7355555553']));
  const shop = await fixturePage(sbUrl('https://weidian.com/item.html?itemID=7355555551'), optRoutes);
  const shw = await world(shop);
  await sleep(1200);
  const shopBar = await barOf(shw);
  check('on a listing that is not in the list yet, the bar leads with "Save to RepHop" and is never folded away', shopBar.on && !shopBar.collapsed && /Save to RepHop/.test(shopBar.save || '') && !shopBar.open, shopBar);
  await shop.click('.goods-options-row:nth-of-type(1) li:nth-child(2)');
  await shop.click('.goods-options-row:nth-of-type(2) li:nth-child(1)');
  await clickBar(shop, shw, 'save');
  const fromAgent = await until(() => item('weidian:7355555551'), 6000);
  check('saving from the agent\'s own listing adds it to the list and remembers the colour and size you clicked there', !!fromAgent && JSON.stringify(fromAgent.options) === JSON.stringify([{ n: 'Color', v: 'White' }, { n: 'Size', v: 'S' }]), fromAgent && fromAgent.options);
  await shop.goto(sbUrl('https://weidian.com/item.html?itemID=7355555552'), { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  await shop.click('.goods-options-row:nth-of-type(1) li:nth-child(1)');
  const viaPanel = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.superbuy.com/*' });
    const tab = tabs.find((x) => /7355555552/.test(x.url));
    return chrome.tabs.sendMessage(tab.id, { type: 'saveThis' });
  });
  const fromPanel = await until(() => item('weidian:7355555552'), 6000);
  check('the list\'s "save this tab" button saves through the page, options included', viaPanel && viaPanel.handled && !!fromPanel && fromPanel.options[0].v === 'Black', { viaPanel, options: fromPanel && fromPanel.options });
  await shop.close();

  // ================================================================ 4. panel
  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 900 });
  await panel.goto('chrome-extension://' + extId + '/panel/panel.html', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const total = Object.keys((await store(['items'])).items).length;
  const list = await panel.evaluate(() => ({
    cards: document.querySelectorAll('#items .item').length, count: document.getElementById('count').textContent, total: document.getElementById('total').textContent,
    agent: document.getElementById('q-agent').value, pick: document.getElementById('pick-agent').hidden, xs: document.querySelectorAll('#items .item .x').length,
  }));
  check('panel lists every item with a total, shows the chosen agent, and each card has a delete button', total === 11 && list.cards === total && /11 items/.test(list.count) && /¥/.test(list.total) && list.agent === 'superbuy' && list.pick === true && list.xs === total, list);
  const thumbs = await panel.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 2500));
    return Array.from(document.querySelectorAll('#items .item')).map((li) => { const img = li.querySelector('.thumb img'); return li.dataset.key + ' ' + (img ? img.naturalWidth : 'no-img'); });
  });
  check('thumbnails load in the panel, as small versions', thumbs.filter((x) => / [1-9]\d*$/.test(x)).length >= 2 && thumbs.every((x) => !/ (\d{4,})$/.test(x)), thumbs);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-list.png') });

  // theme: dark out of the box, light on request
  await panel.click('#theme-toggle');
  const light = await until(async () => { const v = await panel.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })); return v.theme === 'light' ? v : null; }, 4000);
  check('the sun button switches the list to light mode, and the choice is remembered', !!light && light.bg === 'rgb(246, 247, 249)' && (await store(['settings'])).settings.theme === 'light', light);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-light.png') });
  await panel.click('#theme-toggle');
  check('and back to dark', await until(() => panel.evaluate(() => document.documentElement.dataset.theme === 'dark'), 4000));

  await panel.type('#search', 'socks');
  await sleep(300);
  check('search narrows the list', (await panel.$$eval('#items .item', (x) => x.length)) === 1);
  await panel.$eval('#search', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await panel.select('#f-status', 'carted');
  await sleep(300);
  check('status filter: in cart', (await panel.$$eval('#items .item', (x) => x.length)) === 1);
  await panel.select('#f-status', '');
  const sellerOptions = await panel.$$eval('#f-seller option', (o) => o.map((x) => x.textContent));
  check('seller filter lists the Weidian shop and the Yupoo seller', sellerOptions.some((x) => /RM\.OOTD/.test(x)) && sellerOptions.some((x) => /singor/.test(x)), sellerOptions);

  // quick delete: the × on a card, with Undo
  await panel.evaluate(() => Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === 'weidian:7355555552').querySelector('.x').click());
  check('the × on a card deletes it straight away', await until(async () => !(await item('weidian:7355555552'))));
  await panel.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast button')).find((b) => b.textContent === 'Undo').click());
  check('and Undo brings it back', await until(() => item('weidian:7355555552')));

  // select all + delete, from the list itself
  await panel.type('#search', '73555555');
  await sleep(300);
  await panel.click('#select-all');
  await sleep(200);
  const bulk = await panel.evaluate(() => ({ shown: !document.getElementById('bulk').hidden, count: document.getElementById('bulk-count').textContent, selectText: document.getElementById('select-all').textContent }));
  await panel.click('#bulk-delete');
  check('Select all, then Delete, removes the selection from the list view', bulk.shown && /2 selected/.test(bulk.count) && (await until(async () => !(await item('weidian:7355555551')) && !(await item('weidian:7355555552')))), bulk);
  await panel.$eval('#search', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(300);
  await panel.click('#select-all');
  await sleep(200);
  await panel.click('#bulk-delete');
  await sleep(500);
  const armed = await panel.evaluate(() => document.getElementById('bulk-delete').textContent);
  check('deleting a big selection asks once more first', /Delete 9\? Click again/.test(armed) && Object.keys((await store(['items'])).items).length === 9, armed);
  await sleep(4200);
  await panel.click('#bulk-clear');

  await panel.evaluate(() => Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === 'weidian:7237185689').querySelector('.acts button:last-child').click());
  await sleep(300);
  await panel.evaluate(() => {
    const ed = document.querySelector('.editor');
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    const texts = ed.querySelectorAll('input[type="text"]');
    set(Array.from(texts).find((i) => /shoes|size 43/.test(i.placeholder)), 'Tops, size L');
    set(ed.querySelector('textarea'), 'black, size L');
    set(ed.querySelector('input[type="number"][max="99"]'), '2');
    set(ed.querySelectorAll('select')[1], 'bought');
  });
  const edited = await until(async () => { const it = await item('weidian:7237185689'); return it.status === 'bought' && it.qty === 2 ? it : null; });
  check('editing tags, note, quantity and status is saved', !!edited && edited.note === 'black, size L' && edited.tags.join() === 'tops,size-l', edited && { note: edited.note, qty: edited.qty, tags: edited.tags, status: edited.status });
  const typeText = await panel.evaluate(() => document.querySelector('.editor').querySelectorAll('select')[2].selectedOptions[0].textContent);
  check('the editor works out what kind of item it is (for sizes)', /Work it out \(tops\)/.test(typeText), typeText);
  await sleep(400);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-edit.png'), fullPage: true });
  await panel.evaluate(() => Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === 'weidian:7237185689').querySelectorAll('.acts button')[2].click());
  await sleep(800);
  check('the cart button never silently un-buys a bought item', (await item('weidian:7237185689')).status === 'bought');
  await panel.keyboard.press('Escape');

  // queue ("Go through")
  await panel.click('#start-queue');
  const q = await until(async () => { const st = await store(['queue']); return st.queue && st.queue.active ? st.queue : null; });
  check('"Go through" starts a queue over the list', !!q && q.keys.length === 9 && q.i === 0 && q.auto === false, q && { i: q.i, n: q.keys.length, auto: q.auto });
  await sleep(1500);
  await panel.bringToFront();
  const banner = await panel.evaluate(() => ({ hidden: document.getElementById('queue-banner').hidden, text: document.getElementById('queue-text').textContent }));
  check('panel shows the queue banner', !banner.hidden && /Going through 1 of 9/.test(banner.text), banner);
  await panel.evaluate(() => document.getElementById('queue-next').click());
  check('Next advances the queue', await until(async () => (await store(['queue'])).queue.i === 1));
  await sleep(1500);
  await panel.evaluate(() => document.getElementById('queue-stop').click());
  check('End stops the queue', await until(async () => !(await store(['queue'])).queue.active));

  // settings
  await panel.bringToFront();
  await panel.click('.tabs [data-view="settings"]');
  await sleep(400);
  await panel.select('#s-agent', 'cnfans');
  await until(async () => (await store(['settings'])).settings.agent === 'cnfans');
  await reddit.bringToFront();
  check('switching agent in settings updates buttons on open pages', await until(async () => ((await pillOf(rw, 'l1')) || {}).go === 'CNF', 4000), await pillOf(rw, 'l1'));
  await panel.bringToFront();
  await panel.select('#s-agent', 'superbuy');
  await sleep(500);
  await panel.$eval('[data-size="tops"]', (el) => { el.value = 'L'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await panel.$eval('[data-size="shoes"]', (el) => { el.value = '43, 9.5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  check('"My sizes" are saved', await until(async () => { const s = (await store(['settings'])).settings.sizes; return s && s.tops === 'L' && s.shoes === '43, 9.5'; }, 4000), (await store(['settings'])).settings.sizes);
  const cmds = await panel.evaluate(() => Array.from(document.querySelectorAll('#commands kbd')).map((k) => k.textContent));
  check('all four browser shortcuts are assigned', cmds.length === 4, cmds);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-settings.png'), fullPage: true });
  await panel.click('.tabs [data-view="help"]');
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-help.png'), fullPage: true });

  // paste box
  await panel.click('.tabs [data-view="add"]');
  await panel.type('#paste', 'Shorts - https://weidian.com/item.html?itemID=7300000001\n[Cap](https://www.kakobuy.com/item/details?url=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D699999999999)\nrandom text');
  await sleep(300);
  const foundText = await panel.$eval('#paste-found', (e) => e.textContent);
  await panel.click('#paste-add');
  await until(async () => (await item('weidian:7300000001')) && (await item('taobao:699999999999')));
  check('paste box picks out 2 links with their labels', /2 product links found/.test(foundText) && (await item('weidian:7300000001')).label === 'Shorts' && (await item('taobao:699999999999')).label === 'Cap', foundText);

  // a damaged backup must not blank the list
  const imported = await sw.evaluate(() => handlers.importData({ data: { items: [
    { key: 'weidian:7999999991', seller: 'someone', qty: 'lots', check: 'bad', tags: 'x', sources: 'nope', addedAt: 'yesterday', price: 'free', options: 'x', kind: 7 },
    { key: 'weidian:7999999992', seller: { key: 'yupoo:a' }, note: 12345, image: 'javascript:alert(1)', folder: 'Imported' },
    { key: 'not-a-key' }, null, 'junk',
  ], folders: ['Imported'] } }));
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const afterImport = await panel.evaluate(() => ({ cards: document.querySelectorAll('#items .item').length, count: document.getElementById('count').textContent, agents: document.querySelectorAll('#s-agent option').length }));
  const bad = await item('weidian:7999999991');
  check('a damaged backup is cleaned on import and the panel still renders', imported.count === 2 && afterImport.cards === 13 && afterImport.agents > 3 && bad.seller === null && bad.qty === 1 && (bad.check === null || ['ok', 'soldout', 'gone'].includes(bad.check.state)) && bad.price === null && Array.isArray(bad.sources) && bad.options === undefined && bad.kind === undefined, { imported, afterImport, bad: { seller: bad.seller, qty: bad.qty, check: bad.check } });

  // ================================================== 5. "Add to cart for me"
  // The agent tab is driven by the extension, so the listing fixture is attached to that tab itself.
  // Every listing arrives with Black / S pre-selected, as the live page does.
  //   A  taobao:675330231400   added before in White / M            -> RepHop must change both, then press
  //   B  weidian:7237185689    a hoodie, nothing remembered         -> size L from "My sizes"; colour is yours to pick
  //   C  weidian:7231112223    size L written on the item, sold out -> nothing pressed, never another size
  //   D  weidian:7255555551    added before in Black / S, and the site says nothing after the press -> RepHop asks
  const variants = { 7231112223: { soldOut: 'L' }, 7255555551: { confirm: 'silent' } };
  const serve = (req) => {
    const u = req.url();
    if (!u.startsWith('https://www.superbuy.com/en/page/buy/')) return req.continue();
    const id = (decodeURIComponent(u).match(/(\d{9,})\D*$/) || [])[1];
    req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: optionStub(variants[id]) });
  };
  await closeAgentTabs();
  await sw.evaluate(() => openLink({ key: 'taobao:675330231400', disposition: 'reuse' }, null));
  const agentPage = await until(async () => (await agentTabs())[0], 8000);
  await agentPage.setRequestInterception(true);
  agentPage.on('request', serve);
  const aw = await world(agentPage);
  await agentPage.reload({ waitUntil: 'domcontentloaded' });
  await agentPage.evaluate(() => localStorage.removeItem('rhLog'));
  // A second tab showing listing A, and one showing listing A as the run's own tab already does. Neither extra copy may act.
  const twin = await browser.newPage();
  await twin.setRequestInterception(true);
  twin.on('request', serve);
  await twin.goto(sbUrl('https://item.taobao.com/item.htm?id=675330231400'), { waitUntil: 'domcontentloaded' });

  await sw.evaluate(async () => {
    await updateItems(['taobao:675330231400'], { status: 'saved', options: [{ n: 'Color', v: 'White' }, { n: 'Size', v: 'M' }] });
    await updateItems(['weidian:7237185689'], { status: 'saved', options: [] });
    await updateItems(['weidian:7231112223'], { status: 'saved', size: 'L' });
    await updateItems(['weidian:7255555551'], { status: 'saved', options: [{ n: 'Color', v: 'Black' }, { n: 'Size', v: 'S' }] });
  });
  const runSet = ['taobao:675330231400', 'weidian:7237185689', 'weidian:7231112223', 'weidian:7255555551'];
  await panel.bringToFront();
  await panel.evaluate((keys) => {
    for (const key of keys) {
      const box = Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === key).querySelector('.pick');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, runSet);
  await sleep(200);
  await panel.click('#bulk-cart');
  const started = await until(async () => { const st = await store(['queue']); return st.queue && st.queue.active && st.queue.auto && st.queue.tabId != null ? st.queue : null; }, 8000);
  check('"Add to cart" on a selection starts an automatic run in one tab at the chosen agent', !!started && started.keys.length === 4, started && { keys: started.keys, auto: started.auto, tabId: started.tabId });
  const logOf = () => agentPage.evaluate(() => JSON.parse(localStorage.getItem('rhLog') || '[]')).catch(() => null);
  const onStep = (key) => until(async () => { const q = (await store(['queue'])).queue; return q && q.active && q.keys[q.i] === key; }, 40000, 300);
  for (const key of started ? started.keys : runSet) {
    await onStep(key);
    if (key === 'taobao:675330231400') {
      const done = await until(async () => (await item(key)).status === 'carted', 25000);
      check('A: the site had Black / S selected; RepHop changed it to the remembered White / M before pressing', done && JSON.stringify((await item(key)).options) === JSON.stringify([{ n: 'Color', v: 'White' }, { n: 'Size', v: 'M' }]) && ((await logOf()) || []).includes('675330231400 White/M'), { options: (await item(key)).options, log: await logOf() });
    } else if (key === 'weidian:7237185689') {
      const needs = await until(async () => { const b = await barOf(aw).catch(() => null); return b && b.q && /Pick Color/i.test(b.q) ? b : null; }, 25000, 400);
      const picked = await agentPage.evaluate(() => Array.from(document.querySelectorAll('.goods-options-tags li.active')).map((li) => li.textContent));
      check('B: RepHop sets your size (L) but does not accept the site\'s pre-selected colour as a choice; it asks, and presses nothing', !!needs && picked.join() === 'Black,L' && (await item(key)).status === 'saved' && !((await logOf()) || []).some((x) => x.startsWith('7237185689')), { bar: needs && needs.q, picked, log: await logOf() });
      if (SHOTS) await agentPage.screenshot({ path: path.join(SHOTS, 'autocart-needs.png') });
      await agentPage.bringToFront();
      await agentPage.click('.goods-options-row:nth-of-type(1) li:nth-child(2)');
      await agentPage.click('button.goods-addToCart');
      const done = await until(async () => (await item(key)).status === 'carted', 12000);
      check('B: once you pick the colour and press Add To Cart yourself, it is marked and remembered, and the run carries on', done && JSON.stringify((await item(key)).options) === JSON.stringify([{ n: 'Color', v: 'White' }, { n: 'Size', v: 'L' }]), (await item(key)).options);
    } else if (key === 'weidian:7231112223') {
      const needs = await until(async () => { const b = await barOf(aw).catch(() => null); return b && b.q && /sold out/i.test(b.q) ? b : null; }, 25000, 400);
      const picked = await agentPage.evaluate(() => Array.from(document.querySelectorAll('.goods-options-tags li.active')).map((li) => li.textContent));
      check('C: your size is sold out; RepHop says so, changes nothing and presses nothing', !!needs && /“L” is sold out/.test(needs.q) && picked.join() === 'Black,S' && !((await logOf()) || []).some((x) => x.startsWith('7231112223')), { bar: needs && needs.q, picked, log: await logOf() });
      await agentPage.bringToFront();
      await clickBar(agentPage, aw, 'qnext');
    } else {
      const ask = await until(async () => (await toastsOf(aw).catch(() => [])).find((x) => /Is it in your cart/.test(x.text)), 25000, 400);
      check('D: the site says nothing after the press, so RepHop asks instead of assuming (and has pressed exactly once)', !!ask && ask.buttons.join() === 'Yes,No' && (await item(key)).status === 'saved' && ((await logOf()) || []).filter((x) => x.startsWith('7255555551')).join() === '7255555551 Black/S', { ask, log: await logOf() });
      await agentPage.bringToFront();
      await clickToast(agentPage, aw, 'Yes', 'Is it in your cart');
      check('D: answering Yes marks it in cart', await until(async () => (await item(key)).status === 'carted', 8000));
    }
  }
  const run = await until(async () => { const st = await store(['cartRun', 'queue']); return st.cartRun && !st.queue.active ? st.cartRun : null; }, 15000);
  check('the run ends with a report: two added for you, one added by you, one skipped', !!run && run.results['taobao:675330231400'] === 'added' && run.results['weidian:7237185689'] === 'manual' && run.results['weidian:7231112223'] === 'skipped' && run.results['weidian:7255555551'] === 'added', run);
  const finalLog = (await logOf()) || [];
  check('across the whole run: one press per item, none in the other tab showing the same listing, the sold-out item never added, Buy Now never touched', finalLog.slice().sort().join(' | ') === ['675330231400 White/M', '7237185689 White/L', '7255555551 Black/S'].sort().join(' | '), finalLog);
  check('the skipped item is still not marked as in cart', (await item('weidian:7231112223')).status === 'saved');
  await twin.close();
  await panel.bringToFront();
  await sleep(600);
  const summary = await panel.evaluate(() => ({ hidden: document.getElementById('cart-summary').hidden, text: document.getElementById('cart-summary-text').textContent }));
  check('the list shows that report', !summary.hidden && /2 added for you, 1 added by you, 1 skipped/.test(summary.text), summary);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-after-cart.png') });

  // "More -> Add to cart for me" with nothing ticked would run over the whole list: it asks once more first
  await panel.evaluate(() => { document.getElementById('more').open = true; document.querySelector('#more [data-do="cart"]').click(); });
  await sleep(400);
  const armedCart = await panel.evaluate(() => document.querySelector('#more [data-do="cart"]').textContent);
  check('starting a run over the whole list (nothing ticked) asks once more first', /Add all \d+ shown\? Click again/.test(armedCart) && !(await store(['queue'])).queue.active, armedCart);
  await sleep(4200);
  await panel.evaluate(() => (document.getElementById('more').open = false));

  // on an agent other than Superbuy/AllChinaBuy, RepHop presses nothing at all
  const assist = await sw.evaluate(async () => {
    await handlers.settings({ patch: { agent: 'cnfans' } });
    await updateItems(['weidian:7255555551'], { status: 'saved' });
    return true;
  });
  await closeAgentTabs();
  const cnUrl = 'https://cnfans.com/product?id=7255555551&platform=WEIDIAN';
  const cn = await browser.newPage();
  await cn.setRequestInterception(true);
  cn.on('request', (req) => (req.url().startsWith('https://cnfans.com/') ? req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><title>CNFans</title></head><body style="margin:40px"><h1>Listing</h1><p>Color</p><ul><li class="active">Red</li><li>Blue</li></ul><button id="add">Add to Cart</button><script>document.getElementById("add").addEventListener("click",()=>{window.__pressed=(window.__pressed||0)+1;document.title="pressed "+window.__pressed;});</script></body></html>' }) : req.continue()));
  await cn.goto(cnUrl, { waitUntil: 'domcontentloaded' });
  const cw = await world(cn);
  await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: 'https://cnfans.com/*' });
    await chrome.storage.session.set({ agentTabId: tab.id, agentTabUrl: url });
    await queueOp({ op: 'start', auto: true, keys: ['weidian:7255555551'] }, null);
  }, cnUrl);
  const handOver = await until(async () => { const b = await barOf(cw).catch(() => null); return b && b.q && /Choose the options/.test(b.q) ? b : null; }, 20000, 400);
  await sleep(2500);
  check('on another agent RepHop presses nothing: it opens the listing and leaves the choosing and the button to you', assist && !!handOver && (await cn.title()) === 'CNFans' && (await item('weidian:7255555551')).status === 'saved', { bar: handOver && handOver.q, title: await cn.title() });
  await sw.evaluate(() => queueOp({ op: 'stop' }, null));
  await cn.close();
  await sw.evaluate(() => handlers.settings({ patch: { agent: 'superbuy' } }));
  await sw.evaluate(() => chrome.storage.local.remove('cartRun'));

  // ======================================================== 6. Google Sheets
  const sheetRoutes = [
    ['https://docs.google.com/spreadsheets/d/SHEETID/htmlview/sheet', (u) => SHEET_TAB[new URL(u).searchParams.get('gid')] || '<html></html>'],
    ['https://docs.google.com/spreadsheets/d/SHEETID/htmlview', SHEET_INDEX],
    ['https://docs.google.com/spreadsheets/d/SHEETID/edit', '<!doctype html><html><head><title>Finds - Google Sheets</title></head><body><canvas></canvas></body></html>'],
  ];
  const sheet = await fixturePage('https://docs.google.com/spreadsheets/d/SHEETID/edit#gid=77', sheetRoutes);
  const gw = await world(sheet);
  await sleep(1200);
  const sheetBar = await barOf(gw);
  check('Google Sheets editor: bar offers this tab, all tabs and the clickable view', /Grab links from this tab/.test(sheetBar.grab || '') && !!sheetBar.graball && !!sheetBar.clickable, sheetBar);
  await clickBar(sheet, gw, 'grab');
  await until(() => item('weidian:7122222222'));
  check('"this tab" saves only the tab on screen', !!(await item('weidian:7122222222')) && (await item('weidian:7122222222')).label === 'Box logo tee' && !(await item('weidian:7111111111')));
  await sleep(4200);
  await clickBar(sheet, gw, 'graball');
  await until(() => item('taobao:688888888888'));
  const g1 = await item('weidian:7111111111');
  const g2 = await item('taobao:688888888888');
  check('"all tabs" reads every tab, unwraps Google redirects, labels from the row', !!g1 && g1.label === 'Samba OG' && !!g2 && g2.label === 'Gel Kayano' && g1.sources[0].site === 'Google Sheets', { a: g1 && g1.label, b: g2 && g2.label });
  await sheet.close();
  const view = await fixturePage('https://docs.google.com/spreadsheets/d/SHEETID/htmlview', sheetRoutes);
  await sleep(1500);
  const frame = view.frames().find((f) => f.url().includes('/htmlview/sheet'));
  const framePills = frame ? await frame.evaluate(() => Array.from(document.querySelectorAll('[data-rh-pill]')).map((p) => p.previousElementSibling.tagName + ':' + p.previousElementSibling.textContent.slice(0, 20))) : null;
  check('the clickable view: links inside Google\'s sheet frame get their own buttons', !!framePills && framePills.length === 2, framePills);
  await view.close();

  // ======================================================= 7. a lot of links
  const many = Array.from({ length: 1200 }, (_, i) => '<p>Item ' + i + ' <a id="m' + i + '" href="https://weidian.com/item.html?itemID=' + (7400000000 + i) + '">w2c</a></p>').join('');
  const bigUrl = 'https://www.reddit.com/r/FashionReps/comments/big999/huge_thread/';
  await sw.evaluate(() => saveEntries([{ url: 'https://weidian.com/item.html?itemID=7400000010' }, { url: 'https://weidian.com/item.html?itemID=7400001100' }]));
  const big = await fixturePage(bigUrl, [[bigUrl, '<!doctype html><html><head><title>Huge thread : r/FashionReps</title></head><body><shreddit-post id="t3_big999" post-title="Huge thread" permalink="/r/FashionReps/comments/big999/huge_thread/" subreddit-prefixed-name="r/FashionReps"><div slot="text-body">' + many + '</div></shreddit-post></body></html>']]);
  const bw = await world(big);
  const bigState = await until(async () => {
    const n = await big.evaluate(() => document.querySelectorAll('[data-rh-pill]').length);
    const a = await pillOf(bw, 'm10');
    const b = await pillOf(bw, 'm1100');
    return n === 1200 && a && a.saveOn && b && b.saveOn ? { n, a: a.saveOn, b: b.saveOn } : null;
  }, 15000);
  check('1,200 links on one page: every one gets a button and saved marks reach past the 800th', !!bigState, bigState || { n: await big.evaluate(() => document.querySelectorAll('[data-rh-pill]').length), late: await pillOf(bw, 'm1100') });
  const seenAll = await until(async () => { const all = (await store(['seen'])).seen || {}; const n = Object.values(all).filter((s) => (s.p || []).includes('big999')).length; return n === 1200 ? n : null; }, 12000);
  check('"seen in posts" is recorded for all 1,200, not just the first batch', seenAll === 1200, seenAll);
  await big.close();

  // ============================================== 8. worker-only behaviour
  const direct = await sw.evaluate(async () => {
    const out = {};
    out.dead = await getPreview('weidian:1111111', true).catch((e) => String(e));
    out.rates = await ensureRates(true);
    out.rules = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
    out.goneAlbum = await resolveLink('https://singor.x.yupoo.com/albums/1?uid=1');
    out.commands = (await chrome.commands.getAll()).filter((c) => c.name !== '_execute_action').map((c) => c.name + '=' + (c.shortcut || '-'));
    return out;
  });
  check('a non-existent Weidian item is reported as gone', direct.dead && direct.dead.state === 'gone', direct.dead);
  check('a deleted Yupoo album is reported as gone, not as a network problem', direct.goneAlbum.ok && direct.goneAlbum.gone === true && direct.goneAlbum.noBuyLink === true, direct.goneAlbum);
  check('live currency rates load', direct.rates && direct.rates.live === true && direct.rates.rates.USD > 0.05 && direct.rates.rates.USD < 0.5, direct.rates && { live: direct.rates.live, USD: direct.rates.rates && direct.rates.rates.USD });
  check('header rules installed', direct.rules.includes(1) && direct.rules.includes(2), direct.rules);
  check('browser shortcuts registered without conflicts', direct.commands.every((c) => !c.endsWith('=-')), direct.commands);

  // short links: never followed for a hover; followed with a headers-only request when opened or saved; not at all while paused
  const shorts = await sw.evaluate(async () => {
    const out = {};
    await chrome.storage.session.remove(['enrichPausedUntil']);
    out.hover = await describe({ url: 'https://k.youshop10.com/e2e=1' });
    out.hoverHits = self.__shortHits.length;
    out.resolve = await resolveLink('https://k.youshop10.com/e2e=1');
    out.methods = self.__shortHits.slice();
    await chrome.storage.session.set({ enrichPausedUntil: Date.now() + 60000 });
    out.paused = await resolveLink('https://k.youshop10.com/e2e=2');
    out.pausedHits = self.__shortHits.length - out.methods.length;
    await chrome.storage.session.remove(['enrichPausedUntil']);
    return out;
  });
  check('a short link is not followed just to show a hover preview', shorts.hover.ok === false && shorts.hover.reason === 'short' && shorts.hoverHits === 0, shorts.hover);
  // an album whose only buy link is a short link: hovering shows the album and follows nothing; saving follows it
  const albumShort = await sw.evaluate(async () => {
    const real = self.fetch;
    const before = self.__shortHits.length;
    self.fetch = (u, o) => (String(u).includes('shortalbum.x.yupoo.com')
      ? Promise.resolve(new Response('<html><head><meta property="og:title" content="￥99 Short link album | x | y"></head><body><div class="showalbumheader__main"><div class="showalbumheader__gallerysubtitle"><a href="https://x.yupoo.com/external?url=https%253A%252F%252Fk.youshop10.com%252Falb%253D1">buy</a></div></div></body></html>', { status: 200 }))
      : real(u, o));
    const hover = await describe({ url: 'https://shortalbum.x.yupoo.com/albums/424242?uid=1' });
    const hoverHits = self.__shortHits.length - before;
    const saved = await resolveLink('https://shortalbum.x.yupoo.com/albums/424242?uid=1');
    self.fetch = real;
    return { hover: { ok: hover.ok, key: hover.key, noBuyLink: hover.noBuyLink, title: hover.title }, hoverHits, saved: saved.ok && saved.item.key, savedHits: self.__shortHits.length - before };
  });
  check('hovering an album whose buy link is a short link follows nothing; opening or saving it does', albumShort.hover.ok && albumShort.hover.key === 'yupoo:shortalbum/424242' && albumShort.hover.noBuyLink === false && albumShort.hoverHits === 0 && albumShort.saved === 'weidian:7399999991' && albumShort.savedHits === 1, albumShort);
  check('opening or saving one follows it with a headers-only request', shorts.resolve.ok && shorts.resolve.item.key === 'weidian:7399999991' && shorts.methods.join() === 'HEAD', { resolve: shorts.resolve, methods: shorts.methods });
  check('and not at all while Weidian is refusing lookups', shorts.paused.ok === false && shorts.paused.reason === 'paused' && shorts.pausedHits === 0, shorts.paused);

  // page lookups stop at the first refusal
  const breaker = await sw.evaluate(async () => {
    const prev = self.fetch;
    const hits0 = self.__pageHits;
    self.fetch = (u, o) => (String(u).startsWith('https://weidian.com/item.html') ? (self.__pageHits++, Promise.reject(new TypeError('connection closed'))) : prev(u, o));
    await chrome.storage.session.remove(['enrichPausedUntil']);
    await saveEntries([{ url: 'https://weidian.com/item.html?itemID=7811111111' }, { url: 'https://weidian.com/item.html?itemID=7822222222' }, { url: 'https://weidian.com/item.html?itemID=7833333333' }]);
    await new Promise((r) => setTimeout(r, 6000));
    const st = await chrome.storage.session.get(['enrichPausedUntil']);
    self.fetch = prev;
    await removeItems(['weidian:7811111111', 'weidian:7822222222', 'weidian:7833333333']);
    await chrome.storage.session.remove(['enrichPausedUntil']);
    return { hits: self.__pageHits - hits0, pausedMin: Math.round(((st.enrichPausedUntil || 0) - Date.now()) / 60000) };
  });
  check('when Weidian refuses an item-page lookup, RepHop stops asking (one request, then a long pause)', breaker.hits === 1 && breaker.pausedMin >= 25, breaker);

  // Yupoo unreachable: the album is kept and upgraded later
  const pend = await sw.evaluate(async () => {
    const realFetch = self.fetch;
    self.fetch = (u, o) => (String(u).includes('yupoo.com') ? Promise.reject(new TypeError('offline')) : realFetch(u, o));
    const saved = await saveEntries([{ url: 'https://singor.x.yupoo.com/albums/256636377?uid=1', label: 'Offline album' }]);
    const it = (await chrome.storage.local.get('items')).items['yupoo:singor/256636377'];
    await chrome.storage.local.set({ queue: { keys: ['yupoo:singor/256636377', 'weidian:7237185689'], i: 0, active: true } });
    self.fetch = realFetch;
    const again = await handlers.recheck({ key: 'yupoo:singor/256636377' });
    const all = await chrome.storage.local.get(['items', 'queue', 'tombstones']);
    const out = { saved: { added: saved.added, pending: saved.pending }, pendingFlag: it && it.pending, again, stillAlbum: !!all.items['yupoo:singor/256636377'], tomb: !!all.tombstones['yupoo:singor/256636377'], upgraded: again.key && all.items[again.key] && { label: all.items[again.key].label, aliases: all.items[again.key].aliases, pending: all.items[again.key].pending }, queue: all.queue.keys };
    await chrome.storage.local.set({ queue: { keys: [], i: 0, active: false } });
    return out;
  });
  check('an album is kept when Yupoo is unreachable', pend.saved.added === 1 && pend.saved.pending === 1 && pend.pendingFlag === true, pend.saved);
  check('"Find buy link" later upgrades it; the old key is retired and a running queue follows the item', pend.again.ok && !pend.again.noBuyLink && !pend.stillAlbum && pend.tomb && pend.upgraded && pend.upgraded.label === 'Offline album' && pend.queue[0] === pend.again.key, pend);

  // history can be cleared
  const cleared = await sw.evaluate(async () => {
    const before = await chrome.storage.local.get(['seen', 'previews', 'resolved']);
    await handlers.clearHistory();
    const after = await chrome.storage.local.get(['seen', 'previews', 'resolved', 'items']);
    return { before: [Object.keys(before.seen || {}).length, Object.keys(before.previews || {}).length, Object.keys(before.resolved || {}).length], after: [after.seen, after.previews, after.resolved].map((x) => (x ? Object.keys(x).length : 0)), viewed: Object.values(after.items).filter((i) => i.viewedAt).length, items: Object.keys(after.items).length };
  });
  check('"Clear history" removes viewed marks, post counts and cached previews, and leaves the list alone', cleared.before[0] > 1000 && cleared.after.every((n) => n === 0) && cleared.viewed === 0 && cleared.items > 10, cleared);

  // sync
  const sync = await sw.evaluate(async () => {
    const out = {};
    // a list whose names are full of quotes and brackets: the case that used to overflow a sync value
    const extra = Array.from({ length: 150 }, (_, i) => ({ key: 'weidian:' + (7600000000 + i), label: 'Jordan 4 "Bred" <' + i + '> "OG"', note: '"size 43" <maybe> \\\\ '.repeat(6), updatedAt: Date.now() - i, addedAt: Date.now() - i }));
    await restoreItems(extra, false);
    await updateItems(['weidian:7237185689'], { note: 'N'.repeat(500), customTitle: 'Very long name!'.repeat(10) });
    for (let i = 0; i < 90; i++) await handlers.seller({ key: 'yupoo:seller' + i, name: 'A seller with quite a long shop name number ' + i, trusted: true });
    await handlers.settings({ patch: { sync: true } });
    out.push = await syncPush(true);
    const remote = await chrome.storage.sync.get(null);
    const chunkKeys = Object.keys(remote).filter((k) => /^rh_i\d+$/.test(k));
    out.chunks = chunkKeys.length;
    out.arrays = chunkKeys.every((k) => Array.isArray(remote[k]));
    // what the browser itself says each value costs, against the 8,192 limit and against RepHop's own estimate
    out.sizes = [];
    for (const k of chunkKeys.concat(['rh_sellers'])) out.sizes.push([k, await chrome.storage.sync.getBytesInUse(k), U.storedSize(remote[k]) + k.length]);
    out.totalBytes = await chrome.storage.sync.getBytesInUse(null);
    out.sellersSynced = Object.keys(remote.rh_sellers || {}).length;
    const before = (await chrome.storage.local.get('items')).items;
    out.before = Object.keys(before).length;

    // "another device": it only has the synced copy, changes a folder, and writes back
    const entries = readRemote(remote);
    const mine = entries.find((e) => e.k === 'weidian:7237185689');
    out.sentNote = mine.n.length;
    out.sentCut = mine.x;
    const other = {};
    U.mergeSync(other, {}, entries);
    other['weidian:7237185689'].folder = 'Maybe';
    other['weidian:7237185689'].updatedAt = Date.now() + 1000;
    other['weidian:7700000001'] = U.expandItem({ k: 'weidian:7700000001', l: 'Added on the other device', m: Date.now() + 1000, a: Date.now() });
    const packed = U.packSync(other, {});
    const write = { rh_meta: { n: packed.chunks.length, dropped: packed.dropped, v: 2 } };
    packed.chunks.forEach((c, i) => (write['rh_i' + i] = c));
    await chrome.storage.sync.set(write);
    await new Promise((r) => setTimeout(r, 1500)); // the worker's own onChanged listener pulls
    const after = (await chrome.storage.local.get('items')).items;
    out.folder = after['weidian:7237185689'].folder;
    out.noteKept = after['weidian:7237185689'].note.length;
    out.nameKept = after['weidian:7237185689'].customTitle.length;
    out.gotNew = !!after['weidian:7700000001'];
    out.alarm = !!(await chrome.alarms.get('rh-sync'));
    out.secondPush = await syncPush(false);

    // delete an item, let the deletion sync, then restore it from a backup: it has to stay restored
    const victim = JSON.parse(JSON.stringify(after['weidian:7600000005']));
    await removeItems(['weidian:7600000005']);
    await syncPush(true);
    out.deletedRemotely = readRemote(await chrome.storage.sync.get(null)).some((e) => e.k === 'weidian:7600000005' && e.d === 1);
    await handlers.importData({ data: { items: [victim] } });
    await syncPush(false);
    await syncPull();
    out.restoredStays = !!(await chrome.storage.local.get('items')).items['weidian:7600000005'];
    out.restoredRemotely = readRemote(await chrome.storage.sync.get(null)).some((e) => e.k === 'weidian:7600000005' && !e.d);

    // empty device: everything comes back
    const count = Object.keys((await chrome.storage.local.get('items')).items).length;
    await chrome.storage.local.set({ items: {}, tombstones: {} });
    await syncPull();
    out.count = count;
    out.restored = Object.keys((await chrome.storage.local.get('items')).items).length;
    return out;
  });
  check('sync writes succeed for a list full of quotes and angle brackets, stored as arrays', sync.push.ok && sync.push.written && sync.arrays && sync.chunks > 1, { push: sync.push, chunks: sync.chunks, arrays: sync.arrays });
  check('every synced value is under the browser\'s own 8,192-byte limit, and RepHop\'s estimate is never below the real charge', sync.sizes.every(([, real, est]) => real <= 8192 && est >= real) && sync.totalBytes < 102400, { sizes: sync.sizes.map(([k, real, est]) => k + ':' + real + '/' + est), total: sync.totalBytes });
  check('more trusted sellers than fit in one value are trimmed instead of breaking sync', sync.sellersSynced > 20 && sync.sellersSynced < 90, sync.sellersSynced);
  check('a long note travels shortened and flagged', sync.sentNote === 200 && sync.sentCut === 3, { sentNote: sync.sentNote, sentCut: sync.sentCut });
  check('a change from another device is merged without shortening this device\'s own long note and name', sync.folder === 'Maybe' && sync.noteKept === 500 && sync.nameKept === 150 && sync.gotNew, { folder: sync.folder, note: sync.noteKept, name: sync.nameKept, gotNew: sync.gotNew });
  check('after taking in another device\'s changes, a follow-up push is scheduled', sync.alarm === true && sync.secondPush.ok, { alarm: sync.alarm, second: sync.secondPush });
  check('an item restored from a backup after being deleted stays restored through the next sync', sync.deletedRemotely && sync.restoredStays && sync.restoredRemotely, { deletedRemotely: sync.deletedRemotely, stays: sync.restoredStays, remote: sync.restoredRemotely });
  check('an empty device gets the whole list back from sync', sync.restored >= sync.count, { before: sync.count, restored: sync.restored });

  // ====================================== 9. saved copies of real Reddit pages
  if (REAL && fs.existsSync(REAL)) {
    // Reddit hides its own components until its scripts define them. Those scripts are not loaded here, so
    // the comments are un-hidden by hand (the post body is visible as served). RepHop's own elements are
    // excluded from that help: whether they survive Reddit's rule unaided is what is being tested.
    const reveal = 'shreddit-comment-tree, shreddit-comment, shreddit-comment :not([data-rh-ui]) { visibility: visible !important; }';
    for (const file of fs.readdirSync(REAL).filter((f) => /\.html$/.test(f))) {
      const html = fs.readFileSync(path.join(REAL, file), 'utf8');
      const tag = (html.match(/<shreddit-post[^>]*>/) || [''])[0];
      const attr = (name) => ((tag.match(new RegExp('\\s' + name + '="([^"]*)"')) || [])[1] || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const permalink = attr('permalink');
      if (!permalink) continue;
      const url = 'https://www.reddit.com' + permalink;
      const hides = /:not\(:defined\)[^{]*\{visibility:hidden\}/.test(html);
      const expected = Array.from(new Set(Array.from(html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"]+)"/g), (m) => m[1].replace(/&amp;/g, '&')).filter((h) => !/reddit|redd\.it|archive\.org/.test(h))));
      const page = await fixturePage(url, [[url, html]], { css: reveal });
      const pw = await world(page);
      await sleep(2500);
      const found = await page.evaluate(() => document.querySelectorAll('[data-rh-pill]').length);
      const wanted = await sw.evaluate((list) => list.filter((h) => L.parseLink(h)).length, expected);
      check('real Reddit page ' + file + ': product links found in the saved markup get buttons', wanted === 0 ? found === 0 : found >= wanted, { wanted, found });

      // Reddit's own stylesheet is on this page. RepHop's bar has to be visible and clickable under it.
      const vis = await page.evaluate(() => {
        const host = document.querySelector('[data-rh-root]');
        const at = document.elementFromPoint(40, window.innerHeight - 36);
        const pill = document.querySelector('[data-rh-pill]');
        return { host: getComputedStyle(host).visibility, barHit: at === host, pill: pill ? getComputedStyle(pill).visibility : 'none' };
      });
      const barText = (await barOf(pw)).grab;
      check('real Reddit page ' + file + ': under Reddit\'s own stylesheet (which hides undefined custom elements) the corner bar is visible and clickable', hides && vis.host === 'visible' && vis.barHit && vis.pill === 'visible' && /Save all \d+ link/.test(barText || ''), { hides, vis, barText });

      const ids = await page.evaluate(() => {
        const pick = (test) => { const p = Array.from(document.querySelectorAll('[data-rh-pill]')).find(test); if (!p) return null; const a = p.previousElementSibling; if (!a.id) a.id = 'rh-e2e-' + Math.random().toString(36).slice(2, 8); a.scrollIntoView({ block: 'center' }); return a.id; };
        return { post: pick((x) => !x.closest('shreddit-comment') && x.closest('shreddit-post')), comment: pick((x) => x.closest('shreddit-comment')) };
      });
      for (const [id, kind] of [[ids.post, 'post'], [ids.comment, 'comment']]) {
        if (!id) continue;
        await page.$eval('#' + id, (a) => a.scrollIntoView({ block: 'center' }));
        await sleep(300);
        const href = await page.$eval('#' + id, (a) => a.href);
        const key = await sw.evaluate((h) => L.parseLink(h).key, href);
        await sw.evaluate((k) => removeItems([k]), key);
        await sleep(400);
        await page.keyboard.down('Alt');
        await page.click('#' + id);
        await page.keyboard.up('Alt');
        const saved = await until(async () => Object.values((await store(['items'])).items).find((it) => it.key === key || (it.aliases || []).includes(key)), 12000);
        const src = saved && saved.sources[saved.sources.length - 1];
        const ok = !!src && src.postTitle === attr('post-title') && src.sub === attr('subreddit-prefixed-name') && src.postUrl === url && (kind === 'post' ? !src.commentUrl : /\/comment\//.test(src.commentUrl) && !!src.author);
        check('real Reddit page ' + file + ': a real alt+click on a link in the ' + kind + ' saves it with the right ' + (kind === 'post' ? 'post title and subreddit' : 'comment permalink and author'), ok, src || 'not saved');
        const toast = await until(() => pw(() => {
          const el = Array.from(ui().querySelectorAll('.toast')).pop();
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { text: el.querySelector('span').textContent, visibility: getComputedStyle(el).visibility, inView: r.width > 0 && r.bottom <= window.innerHeight && r.top >= 0 };
        }), 4000);
        check('real Reddit page ' + file + ': the "Saved" message for that ' + kind + ' link can be seen', !!toast && toast.visibility === 'visible' && toast.inView && /Saved|Already/.test(toast.text), toast);
        await page.mouse.move(5, 5);
        await page.hover('#' + id);
        const seenCard = await until(() => pw(() => {
          const el = ui().querySelector('.card');
          const r = el.getBoundingClientRect();
          return el.classList.contains('on') ? { visibility: getComputedStyle(el).visibility, inView: r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight, title: el.querySelector('.title').textContent } : null;
        }), 5000);
        check('real Reddit page ' + file + ': hovering that ' + kind + ' link shows its card', !!seenCard && seenCard.visibility === 'visible' && seenCard.inView, seenCard);
        if (SHOTS && kind === 'post') await page.screenshot({ path: path.join(SHOTS, 'real-' + file.replace(/\.html$/, '') + '.png') });
        await page.mouse.move(5, 5);
        await sleep(4200);
      }
      if (SHOTS && !ids.post) await page.screenshot({ path: path.join(SHOTS, 'real-' + file.replace(/\.html$/, '') + '.png') });
      await page.close();
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 1));
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(3);
});
