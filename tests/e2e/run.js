/*
 * End-to-end check of the unpacked extension in a real Chrome.
 *
 *   cd tests/e2e && npm install && node run.js [--shots <folder>] [--real <folder with saved Reddit pages>]
 *
 * Reddit, the Superbuy listing and Google Sheets are served from fixtures through request
 * interception (Reddit shows a bot check to automated browsers, and Superbuy needs a login).
 * Weidian, Yupoo and the exchange-rate service are the real sites, so this needs a network.
 *
 * RepHop draws its buttons in closed shadow roots, which page scripts cannot open. The checks
 * therefore look at them from the extension's own isolated world (see `world()` below).
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
<div id="late"></div>
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

const OLD_URL = 'https://old.reddit.com/r/FashionReps/comments/old777/old_style_post/';
const OLD_HTML = `<!doctype html><html><head><title>Old style post : FashionReps</title></head><body style="margin:40px">
<div id="siteTable"><div class="thing link" data-fullname="t3_old777" data-permalink="/r/FashionReps/comments/old777/old_style_post/" data-subreddit="FashionReps" data-author="oldposter">
  <a class="title" href="/r/FashionReps/comments/old777/old_style_post/">Old style post</a>
  <div class="usertext-body"><div class="md"><p>Cap: <a id="o1" href="https://weidian.com/item.html?itemID=7288888881">link</a></p></div></div>
</div></div>
<div class="commentarea"><div class="thing comment" data-permalink="/r/FashionReps/comments/old777/old_style_post/c0ffee1/" data-author="oldcommenter">
  <div class="usertext-body"><div class="md"><p>Scarf <a id="o2" href="https://item.taobao.com/item.htm?id=677777777771">here</a></p></div></div>
</div></div></body></html>`;

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
  await sleep(1500);
  // Weidian item pages (shop + translated name) come from a fixture: Weidian cuts off clients that load
  // many of them, and a test run would. The item API, Yupoo and the rate service stay real.
  await sw.evaluate(() => {
    const real = self.fetch;
    self.__pageHits = 0;
    const known = { 7237185689: ['Triangle logo short sleeve tee', 1815387116, 'RM.OOTD'], 7870660857: ['Embroidered zip-up hoodie', 2004619, 'WF shop'] };
    self.fetch = (u, o) => {
      const url = String(u);
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
  for (const p of await browser.pages()) if (p.url().includes('panel.html')) await p.close();

  async function fixturePage(url, routes, headers) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      for (const [prefix, body] of routes) {
        if (!u.startsWith(prefix)) continue;
        const text = typeof body === 'function' ? body(u) : body;
        return req.respond({ status: 200, contentType: text.trim().startsWith('<') ? 'text/html; charset=utf-8' : 'application/json', headers: headers || {}, body: text });
      }
      if (/^https:\/\/([a-z]+\.reddit\.com|www\.superbuy\.com|docs\.google\.com|[a-z.]*redditstatic\.com|[a-z.]*redd\.it|web\.archive\.org)\//.test(u)) return req.respond({ status: 404, body: '' });
      req.continue();
    });
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  /**
   * Run a function inside the extension's isolated world on a page (optionally in a sub-frame whose URL
   * contains `frameUrlPart`). In there `root(el)` opens RepHop's closed shadow roots and `ui()` is the
   * root that holds the card, the bar and the toasts.
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
      const ctx = await until(() => Array.from(contexts.values()).reverse().find((c) => c.auxData && c.auxData.type === 'isolated' && c.auxData.frameId === frameId && /RepHop/.test(c.name || '')), 6000);
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
    return { cls: r.querySelector('.pill').className, go: r.querySelector('.go').textContent.trim(), saveOn: r.querySelector('.save').classList.contains('on'), n: r.querySelector('.n').textContent, tab: r.querySelector('.go').tabIndex };
  }, id);
  const barOf = (w) => w(() => {
    const b = ui().querySelector('.bar');
    const out = { on: b.classList.contains('on') };
    for (const el of b.querySelectorAll('[data-act]')) out[el.dataset.act] = el.hidden ? null : el.textContent.trim() || true;
    out.q = b.querySelector('.q').hidden ? null : b.querySelector('.q').textContent;
    return out;
  });
  const toastsOf = (w) => w(() => Array.from(ui().querySelectorAll('.toast')).map((t) => ({ text: t.querySelector('span').textContent, buttons: Array.from(t.querySelectorAll('button')).map((b) => b.textContent) })));
  /** Click something inside RepHop's own UI with a real mouse event. `find` runs in the content world and returns the element. */
  async function clickUi(page, w, find, ...args) {
    const pt = await w(new Function('...a', 'const el = (' + find.toString() + ')(...a); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };'), ...args);
    if (!pt) throw new Error('UI element not found: ' + find.toString().slice(0, 80));
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
    await sleep(250); // let the toast finish sliding in
    await clickUi(page, w, find, label, about || '');
  }
  const clickBar = (page, w, act) => clickUi(page, w, (act) => ui().querySelector('.bar [data-act="' + act + '"]'), act);
  const clickPill = (page, w, id, part) => clickUi(page, w, (id, part) => root(document.getElementById(id).nextElementSibling).querySelector('.' + part), id, part);
  const agentTabs = async () => (await browser.pages()).filter((p) => /superbuy\.com/.test(p.url()));
  const sbUrl = (inner) => 'https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=' + encodeURIComponent(inner);
  const closeAgentTabs = async () => {
    for (const p of await agentTabs()) await p.close();
    await sw.evaluate(() => chrome.storage.session.remove(['agentTabId', 'agentTabUrl']));
  };

  // =============================================================== 1. Reddit
  const reddit = await fixturePage(POST, [[POST, REDDIT_HTML], ['https://www.reddit.com/comments/abc123.json', REDDIT_JSON]]);
  const rw = await world(reddit);
  await sleep(1200);

  const pills = await reddit.evaluate(() => Array.from(document.querySelectorAll('[data-rh-pill]')).map((p) => p.previousElementSibling.id || p.previousElementSibling.className));
  check('buttons added next to 4 links + 1 plain-text link, none on the ordinary or picture link', pills.length === 5 && ['l1', 'l2', 'l3', 'l4', 'rh-text'].every((x) => pills.includes(x)), pills);
  check('button shows the agent short name; with hotkeys on it adds no tab stop', ((await pillOf(rw, 'l1')) || {}).go === 'SB' && (await pillOf(rw, 'l1')).tab === -1, await pillOf(rw, 'l1'));
  check('corner bar offers "Save all 6 links" (the picture link counts)', /Save all 6 links/.test((await barOf(rw)).grab || ''), await barOf(rw));
  const leak = await reddit.evaluate(() => ({ pill: document.querySelector('[data-rh-pill]').shadowRoot, ui: document.querySelector("[data-rh-root]").shadowRoot }));
  check('page scripts cannot open RepHop\'s shadow roots', leak.pill === null && leak.ui === null, leak);

  await reddit.click('#l1');
  let tabs = await until(async () => { const t = await agentTabs(); return t.length ? t : null; });
  check('left click opens the Superbuy listing', tabs && tabs.length === 1 && tabs[0].url() === sbUrl('https://weidian.com/item.html?itemID=7237185689'), tabs && tabs.map((t) => t.url()));
  check('Reddit tab did not navigate away', reddit.url() === POST, reddit.url());

  await reddit.bringToFront();
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
  const cartTab = tabs[0];
  await cartTab.goto('https://www.superbuy.com/en/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const elsewhere = cartTab.url();
  await reddit.bringToFront();
  await reddit.click('#l3');
  await until(async () => (await agentTabs()).some((t) => /7870660857/.test(t.url())));
  tabs = await agentTabs();
  check('a Superbuy page that is not a listing (cart, checkout, home) is not overwritten either', cartTab.url() === elsewhere && !/page\/buy/.test(elsewhere) && tabs.length === 2, tabs.map((t) => t.url().slice(0, 60)));
  await cartTab.close();
  await reddit.bringToFront();
  await reddit.click('#l1');
  await until(async () => (await agentTabs()).some((t) => /7237185689/.test(t.url())));
  check('and the new listing tab is the one reused from then on', (await agentTabs()).length === 1);

  // ---- two opens at once must still end up in one tab
  await closeAgentTabs();
  await reddit.bringToFront();
  await reddit.evaluate(() => {
    for (const id of ['l1', 'l3']) document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
  await sleep(3000);
  tabs = await agentTabs();
  check('two clicks fired together open one agent tab, not two', tabs.length === 1, tabs.map((t) => t.url().slice(-30)));

  // ---- ordinary behaviour is preserved
  await reddit.bringToFront();
  const untouched = await reddit.evaluate(() => new Promise((res) => {
    document.getElementById('normal').addEventListener('click', (e) => { res(e.defaultPrevented === false); e.preventDefault(); }, { once: true });
    document.getElementById('normal').click();
  }));
  check('ordinary links are not intercepted', untouched === true);
  const shift = await reddit.evaluate(() => new Promise((res) => {
    const a = document.getElementById('l4');
    a.addEventListener('click', (e) => { res(!e.defaultPrevented); e.preventDefault(); }, { once: true });
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true, button: 0 }));
  }));
  check('shift+click reaches the page untouched', shift === true);

  // ---- saving
  await reddit.keyboard.down('Alt');
  await reddit.click('#l4');
  await reddit.keyboard.up('Alt');
  let items = await until(async () => { const it = (await store(['items'])).items || {}; return it['taobao:675330231400'] ? it : null; });
  const tb = items && items['taobao:675330231400'];
  check('alt+click saves the item with its Reddit context', !!tb && tb.label === 'this one' && tb.sources[0].sub === 'r/FashionReps' && /def456/.test(tb.sources[0].commentUrl) && tb.sources[0].author === 'someone' && tb.sources[0].postTitle === 'Budget haul finds', tb && { label: tb.label, src: tb.sources[0] });
  check('its button flips to saved', await until(async () => ((await pillOf(rw, 'l4')) || {}).saveOn === true, 4000), await pillOf(rw, 'l4'));
  check('an opened link is marked viewed', /viewed/.test(((await pillOf(rw, 'l1')) || {}).cls || ''), await pillOf(rw, 'l1'));

  // ---- hotkeys
  await reddit.evaluate(() => document.getElementById('l1').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  await reddit.keyboard.press('a');
  await sleep(1200);
  items = (await store(['items'])).items || {};
  check('a link that merely ended up under the cursor (no real mouse movement) does not arm the hotkeys', !items['weidian:7237185689'], Object.keys(items));
  await reddit.hover('#normal');
  await reddit.hover('#l1');
  await sleep(150);
  await reddit.keyboard.press('a');
  items = await until(async () => { const it = (await store(['items'])).items || {}; return it['weidian:7237185689'] && it['weidian:7237185689'].title && it['weidian:7237185689'].seller ? it : null; }, 12000);
  const wd = ((await store(['items'])).items || {})['weidian:7237185689'];
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
  await reddit.hover('#normal');
  await reddit.focus('#l3');
  await sleep(600);
  await reddit.keyboard.press('a');
  items = await until(async () => { const it = (await store(['items'])).items || {}; return it['weidian:7870660857'] ? it : null; });
  check('keyboard users: focus a link and press A to save it', !!(items && items['weidian:7870660857']), items && Object.keys(items));
  await sw.evaluate(() => removeItems(['weidian:7870660857']));
  await reddit.evaluate(() => document.activeElement.blur());

  // ---- the "click opens in agent" switch covers plain-text links as well
  await sw.evaluate(() => handlers.settings({ patch: { clickHijack: false } }));
  await sleep(500);
  const before = (await agentTabs())[0].url();
  await reddit.bringToFront();
  await reddit.click('.rh-text');
  await sleep(1500);
  check('with the click switch off, a plain-text link no longer opens anything', (await agentTabs()).length === 1 && (await agentTabs())[0].url() === before && reddit.url() === POST);
  await sw.evaluate(() => handlers.settings({ patch: { clickHijack: true } }));
  await sleep(400);

  // ---- hover card
  await reddit.bringToFront();
  await reddit.hover('#normal');
  await reddit.hover('#l1');
  const card = await until(async () => {
    const c = await rw(() => {
      const el = ui().querySelector('.card');
      const img = el.querySelector('.pic img');
      return { on: el.classList.contains('on'), title: el.querySelector('.title').textContent, price: el.querySelector('.price').textContent, tags: el.querySelector('.tags').textContent, keys: el.querySelector('.keys').textContent, img: img ? img.naturalWidth : 0, src: img ? img.src : '' };
    });
    return c.on && c.img > 0 && /¥/.test(c.price) ? c : null;
  }, 9000);
  check('hover card shows name, price, saved badge, key hints and a small picture', !!card && card.title === 'Black hoodie' && /In your list/.test(card.tags) && /S\s+open/.test(card.keys) && /[?&]w=200/.test(card.src) && card.img <= 400, card);
  if (SHOTS) await reddit.screenshot({ path: path.join(SHOTS, 'reddit.png') });

  // ---- Yupoo album: resolved over the real network, de-duplicated against the CNFans link for the same item
  await reddit.hover('#normal');
  await clickPill(reddit, rw, 'l2', 'save');
  items = await until(async () => { const it = (await store(['items'])).items || {}; return it['weidian:7870660857'] ? it : null; }, 15000);
  const y = items && items['weidian:7870660857'];
  check('a Yupoo album resolves to its Weidian buy link (real network)', !!y && y.aliases.includes('yupoo:singor/258055580'), y ? { aliases: y.aliases, label: y.label, price: y.price } : Object.keys(items || {}));
  check('its name comes from the Reddit link text', !!y && y.label === 'Pony zip hoodie', y && y.label);
  check('both the Yupoo link and the CNFans link for that item show as saved', await until(async () => ((await pillOf(rw, 'l2')) || {}).saveOn && ((await pillOf(rw, 'l3')) || {}).saveOn, 5000), { l2: await pillOf(rw, 'l2'), l3: await pillOf(rw, 'l3') });

  // ---- a link that appears under the mouse before the page scan reaches it
  await reddit.evaluate(() => {
    const p = document.createElement('p');
    p.innerHTML = 'Late: <a id="late1" href="https://weidian.com/item.html?itemID=7255555551">late link</a>';
    document.getElementById('late').appendChild(p);
    document.getElementById('late1').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await sleep(1200);
  check('a link hovered the moment it appears still gets its button and is counted', !!(await pillOf(rw, 'late1')) && /Save all 7 links/.test((await barOf(rw)).grab || ''), { pill: await pillOf(rw, 'late1'), bar: (await barOf(rw)).grab });

  // ---- save all: page links + the thread JSON, with progress and an honest note about what Reddit held back
  await clickBar(reddit, rw, 'grab');
  const grabToast = await until(async () => (await toastsOf(rw)).find((t) => /Saved \d+ new/.test(t.text)), 15000);
  items = (await store(['items', 'seen'])).items || {};
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
  check('clicking a saved button asks instead of deleting', !!t && /Already in your list/.test(t.text) && t.buttons.includes('Remove') && t.buttons.includes('Open list') && !!(await store(['items'])).items['taobao:675330231400'], t);
  await clickToast(reddit, rw, 'Remove', 'Already in your list');
  await until(async () => !(await store(['items'])).items['taobao:675330231400']);
  check('Remove takes it out of the list', !(await store(['items'])).items['taobao:675330231400']);
  await clickToast(reddit, rw, 'Undo', 'Removed from your list');
  check('Undo puts it back, context intact', await until(async () => { const it = (await store(['items'])).items['taobao:675330231400']; return it && it.sources.length === 1 && it.label === 'this one'; }));

  // ---- the list button on the page (must reach sidePanel.open inside the click gesture)
  await sw.evaluate(() => {
    self.__panel = 'not called';
    const real = chrome.sidePanel.open.bind(chrome.sidePanel);
    chrome.sidePanel.open = (o) => real(o).then((r) => { self.__panel = 'ok'; return r; }, (e) => { self.__panel = 'ERR ' + e.message; throw e; });
  });
  await clickBar(reddit, rw, 'panel');
  check('the list button on the page opens the side panel', await until(() => sw.evaluate(() => self.__panel === 'ok'), 4000), await sw.evaluate(() => self.__panel));

  // ============================================================ 2. old Reddit
  const old = await fixturePage(OLD_URL, [[OLD_URL, OLD_HTML]]);
  const ow = await world(old);
  await sleep(1000);
  await old.keyboard.down('Alt');
  await old.click('#o2');
  await old.click('#o1');
  await old.keyboard.up('Alt');
  items = await until(async () => { const it = (await store(['items'])).items || {}; return it['taobao:677777777771'] && it['weidian:7288888881'] ? it : null; });
  const o1 = items && items['weidian:7288888881'];
  const o2 = items && items['taobao:677777777771'];
  check('old Reddit: post link keeps post title, subreddit and author', !!o1 && o1.label === 'Cap' && o1.sources[0].postTitle === 'Old style post' && o1.sources[0].sub === 'r/FashionReps' && o1.sources[0].postId === 'old777' && o1.sources[0].author === 'oldposter', o1 && o1.sources[0]);
  check('old Reddit: comment link keeps the comment permalink and author', !!o2 && /c0ffee1/.test(o2.sources[0].commentUrl) && o2.sources[0].author === 'oldcommenter' && o2.label === 'Scarf', o2 && { label: o2.label, src: o2.sources[0] });
  await old.close();

  // ===================================================== 3. Superbuy listing
  const listing = sbUrl('https://item.taobao.com/item.htm?id=675330231400');
  let sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">US $<span>18.42</span></p>', 'silent')]]);
  let sbw = await world(sb);
  await until(async () => ((await store(['items'])).items['taobao:675330231400'] || {}).title);
  let scraped = (await store(['items'])).items['taobao:675330231400'];
  check('listing page: the name is read, and a price not labelled as yuan is NOT taken', scraped.title === 'Stub Listing Title 测试' && scraped.price == null, { title: scraped.title, price: scraped.price });
  const sbBar = await barOf(sbw);
  check('on the agent page the bar shows Saved + QC, not "Open in Superbuy"', sbBar.on && !sbBar.open && /Saved/.test(sbBar.save || '') && !!sbBar.qc, sbBar);
  await sb.click('button.goods-addToCart');
  t = await until(async () => (await toastsOf(sbw)).find((x) => /Did that go into your cart/.test(x.text)), 5000);
  check('Add To Cart with no confirmation from the site: RepHop asks instead of guessing', !!t && (await store(['items'])).items['taobao:675330231400'].status === 'saved', t);
  await clickToast(sb, sbw, 'Yes, mark it', 'Did that go into your cart');
  check('answering yes marks it in cart', await until(async () => (await store(['items'])).items['taobao:675330231400'].status === 'carted'));
  await sb.close();

  await sw.evaluate(() => updateItems(['taobao:675330231400'], { status: 'saved' }));
  sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">CN ￥<span>123.45</span></p>', 'error')]]);
  sbw = await world(sb);
  check('a price labelled "CN ￥" is taken', await until(async () => (await store(['items'])).items['taobao:675330231400'].price === 123.45), (await store(['items'])).items['taobao:675330231400'].price);
  await sleep(600);
  await sb.click('button.goods-addToCart');
  await sleep(2600);
  check('when the site shows an error after Add To Cart, nothing is marked and nothing is asked', (await store(['items'])).items['taobao:675330231400'].status === 'saved' && !(await toastsOf(sbw)).some((x) => /cart/i.test(x.text)), await toastsOf(sbw));
  await sb.close();

  sb = await fixturePage(listing, [['https://www.superbuy.com/en/page/buy/', superbuyStub('<p class="foreign-currency">CN ￥<span>123.45</span></p>', 'ok')]]);
  sbw = await world(sb);
  await sleep(1500);
  await sb.click('button.goods-addToCart');
  check('when the site confirms, the item is marked in cart automatically', await until(async () => (await store(['items'])).items['taobao:675330231400'].status === 'carted', 6000));

  // ================================================================ 4. panel
  const panel = await browser.newPage();
  await panel.setViewport({ width: 420, height: 900 });
  await panel.goto('chrome-extension://' + extId + '/panel/panel.html', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  const list = await panel.evaluate(() => ({
    cards: document.querySelectorAll('#items .item').length, count: document.getElementById('count').textContent, total: document.getElementById('total').textContent,
    titles: Array.from(document.querySelectorAll('#items .title')).map((x) => x.textContent), label: document.getElementById('q-hijack-label').textContent,
  }));
  check('panel lists all 9 items with a total', list.cards === 9 && /9 items/.test(list.count) && /¥/.test(list.total) && /≈/.test(list.total), list);
  const thumbs = await panel.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 2500));
    return Array.from(document.querySelectorAll('#items .item')).map((li) => { const img = li.querySelector('.thumb img'); return li.dataset.key + ' ' + (img ? img.naturalWidth : 'no-img'); });
  });
  check('thumbnails load in the panel, as small versions', thumbs.filter((x) => / [1-9]\d*$/.test(x)).length >= 2 && thumbs.every((x) => !/ (\d{4,})$/.test(x)), thumbs);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-list.png') });

  await panel.type('#search', 'socks');
  await sleep(300);
  check('search narrows the list', (await panel.$$eval('#items .item', (x) => x.length)) === 1);
  await panel.$eval('#search', (el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await panel.select('#f-status', 'carted');
  await sleep(300);
  check('status filter: in cart', (await panel.$$eval('#items .item', (x) => x.length)) === 1);
  await panel.select('#f-status', '');
  const sellerOptions = await panel.$$eval('#f-seller option', (o) => o.map((x) => x.textContent));
  check('seller filter lists the Weidian shop and the Yupoo seller', sellerOptions.length >= 3 && sellerOptions.some((x) => /singor/.test(x)), sellerOptions);

  await panel.evaluate(() => Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === 'weidian:7237185689').querySelector('.acts button:last-child').click());
  await sleep(300);
  await panel.evaluate(() => {
    const ed = document.querySelector('.editor');
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set(ed.querySelectorAll('input[type="text"]')[1], 'Tops, size L');
    set(ed.querySelector('textarea'), 'black, size L');
    set(ed.querySelector('input[type="number"][max="99"]'), '2');
    set(ed.querySelectorAll('select')[1], 'bought');
  });
  const edited = await until(async () => { const it = (await store(['items'])).items['weidian:7237185689']; return it.status === 'bought' && it.qty === 2 ? it : null; });
  check('editing tags, note, quantity and status is saved', !!edited && edited.note === 'black, size L' && edited.tags.join() === 'tops,size-l', edited && { note: edited.note, qty: edited.qty, tags: edited.tags, status: edited.status });
  await sleep(400);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'panel-edit.png') });
  await panel.evaluate(() => Array.from(document.querySelectorAll('#items .item')).find((li) => li.dataset.key === 'weidian:7237185689').querySelectorAll('.acts button')[2].click());
  await sleep(800);
  check('the cart button never silently un-buys a bought item', (await store(['items'])).items['weidian:7237185689'].status === 'bought');
  await panel.keyboard.press('Escape');

  // queue
  await panel.click('#start-queue');
  const q = await until(async () => { const st = await store(['queue']); return st.queue && st.queue.active ? st.queue : null; });
  check('"Go through" starts a queue over the list', !!q && q.keys.length === 9 && q.i === 0, q && { i: q.i, n: q.keys.length });
  await sleep(1500);
  await panel.bringToFront();
  const banner = await panel.evaluate(() => ({ hidden: document.getElementById('queue-banner').hidden, text: document.getElementById('queue-text').textContent }));
  check('panel shows the queue banner', !banner.hidden && /1 of 9/.test(banner.text), banner);
  // (queue steps move focus to the agent tab, so these buttons are pressed without needing the panel in front)
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
  items = await until(async () => { const it = (await store(['items'])).items; return it['weidian:7300000001'] && it['taobao:699999999999'] ? it : null; });
  check('paste box picks out 2 links with their labels', /2 product links found/.test(foundText) && !!items && items['weidian:7300000001'].label === 'Shorts' && items['taobao:699999999999'].label === 'Cap', foundText);

  // a damaged backup must not blank the list
  const imported = await sw.evaluate(() => handlers.importData({ data: { items: [
    { key: 'weidian:7999999991', seller: 'someone', qty: 'lots', check: 'bad', tags: 'x', sources: 'nope', addedAt: 'yesterday', price: 'free' },
    { key: 'weidian:7999999992', seller: { key: 'yupoo:a' }, note: 12345, image: 'javascript:alert(1)', folder: 'Imported' },
    { key: 'not-a-key' }, null, 'junk',
  ], folders: ['Imported'] } }));
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const afterImport = await panel.evaluate(() => ({ cards: document.querySelectorAll('#items .item').length, count: document.getElementById('count').textContent, folders: Array.from(document.querySelectorAll('#folders button')).map((b) => b.textContent), agents: document.querySelectorAll('#s-agent option').length }));
  const bad = (await store(['items'])).items['weidian:7999999991'];
  check('a damaged backup is cleaned on import and the panel still renders', imported.count === 2 && afterImport.cards === 13 && afterImport.agents > 3 && bad.seller === null && bad.qty === 1 && (bad.check === null || ['ok', 'soldout', 'gone'].includes(bad.check.state)) && bad.price === null && Array.isArray(bad.sources), { imported, afterImport, bad: { seller: bad.seller, qty: bad.qty, check: bad.check } });

  // ======================================================== 5. Google Sheets
  const sheetRoutes = [
    ['https://docs.google.com/spreadsheets/d/SHEETID/htmlview/sheet', (u) => SHEET_TAB[new URL(u).searchParams.get('gid')] || '<html></html>'],
    ['https://docs.google.com/spreadsheets/d/SHEETID/htmlview', SHEET_INDEX],
    ['https://docs.google.com/spreadsheets/d/SHEETID/edit', '<!doctype html><html><head><title>Finds - Google Sheets</title></head><body><canvas></canvas></body></html>'],
  ];
  const sheet = await fixturePage('https://docs.google.com/spreadsheets/d/SHEETID/edit#gid=77', sheetRoutes);
  const shw = await world(sheet);
  await sleep(1200);
  const sheetBar = await barOf(shw);
  check('Google Sheets editor: bar offers this tab, all tabs and the clickable view', /Grab links from this tab/.test(sheetBar.grab || '') && !!sheetBar.graball && !!sheetBar.clickable, sheetBar);
  await clickBar(sheet, shw, 'grab');
  await until(async () => (await store(['items'])).items['weidian:7122222222']);
  items = (await store(['items'])).items;
  check('"this tab" saves only the tab on screen', !!items['weidian:7122222222'] && items['weidian:7122222222'].label === 'Box logo tee' && !items['weidian:7111111111'], Object.keys(items).filter((k) => /71/.test(k)));
  await sleep(4200);
  await clickBar(sheet, shw, 'graball');
  await until(async () => (await store(['items'])).items['taobao:688888888888']);
  items = (await store(['items'])).items;
  check('"all tabs" reads every tab, unwraps Google redirects, labels from the row', !!items['weidian:7111111111'] && items['weidian:7111111111'].label === 'Samba OG' && !!items['taobao:688888888888'] && items['taobao:688888888888'].label === 'Gel Kayano' && items['weidian:7111111111'].sources[0].site === 'Google Sheets', { a: items['weidian:7111111111'] && items['weidian:7111111111'].label, b: items['taobao:688888888888'] && items['taobao:688888888888'].label });
  await sheet.close();
  const view = await fixturePage('https://docs.google.com/spreadsheets/d/SHEETID/htmlview', sheetRoutes);
  await sleep(1500);
  const frame = view.frames().find((f) => f.url().includes('/htmlview/sheet'));
  const framePills = frame ? await frame.evaluate(() => Array.from(document.querySelectorAll('[data-rh-pill]')).map((p) => p.previousElementSibling.tagName + ':' + p.previousElementSibling.textContent.slice(0, 20))) : null;
  check('the clickable view: links inside Google\'s sheet frame get their own buttons', !!framePills && framePills.length === 2, framePills);
  await view.close();

  // ======================================================= 6. a lot of links
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
  const seenAll = await until(async () => { const seen = (await store(['seen'])).seen || {}; const n = Object.values(seen).filter((s) => (s.p || []).includes('big999')).length; return n === 1200 ? n : null; }, 12000);
  check('"seen in posts" is recorded for all 1,200, not just the first batch', seenAll === 1200, seenAll);
  await big.close();

  // ============================================== 7. worker-only behaviour
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

  // page lookups stop at the first refusal
  const breaker = await sw.evaluate(async () => {
    const prev = self.fetch;
    const hits0 = self.__pageHits;
    self.fetch = (u, o) => (String(u).startsWith('https://weidian.com/item.html') ? (self.__pageHits++, Promise.reject(new TypeError('connection closed'))) : prev(u, o));
    await chrome.storage.session.remove(['enrichPausedUntil']);
    await saveEntries([{ url: 'https://weidian.com/item.html?itemID=7811111111' }, { url: 'https://weidian.com/item.html?itemID=7822222222' }, { url: 'https://weidian.com/item.html?itemID=7833333333' }]);
    await new Promise((r) => setTimeout(r, 5000));
    const st = await chrome.storage.session.get(['enrichPausedUntil']);
    self.fetch = prev;
    await removeItems(['weidian:7811111111', 'weidian:7822222222', 'weidian:7833333333']);
    return { hits: self.__pageHits - hits0, pausedMin: Math.round(((st.enrichPausedUntil || 0) - Date.now()) / 60000) };
  });
  check('when Weidian refuses an item-page lookup, RepHop stops asking (one request, then a long pause)', breaker.hits === 1 && breaker.pausedMin >= 25, breaker);

  // Yupoo unreachable: the album is kept and upgraded later
  const pend = await sw.evaluate(async () => {
    const realFetch = self.fetch;
    self.fetch = (u, o) => (String(u).includes('yupoo.com') ? Promise.reject(new TypeError('offline')) : realFetch(u, o));
    const saved = await saveEntries([{ url: 'https://singor.x.yupoo.com/albums/256636377?uid=1', label: 'Offline album' }]);
    const item = (await chrome.storage.local.get('items')).items['yupoo:singor/256636377'];
    await chrome.storage.local.set({ queue: { keys: ['yupoo:singor/256636377', 'weidian:7237185689'], i: 0, active: true } });
    self.fetch = realFetch;
    const again = await handlers.recheck({ key: 'yupoo:singor/256636377' });
    const all = await chrome.storage.local.get(['items', 'queue']);
    const out = { saved: { added: saved.added, pending: saved.pending }, pendingFlag: item && item.pending, again, stillAlbum: !!all.items['yupoo:singor/256636377'], upgraded: again.key && all.items[again.key] && { label: all.items[again.key].label, aliases: all.items[again.key].aliases, pending: all.items[again.key].pending }, queue: all.queue.keys };
    await chrome.storage.local.set({ queue: { keys: [], i: 0, active: false } });
    return out;
  });
  check('an album is kept when Yupoo is unreachable', pend.saved.added === 1 && pend.saved.pending === 1 && pend.pendingFlag === true, pend.saved);
  check('"Find buy link" later upgrades it, and a running queue follows the item to its new key', pend.again.ok && !pend.again.noBuyLink && !pend.stillAlbum && pend.upgraded && pend.upgraded.label === 'Offline album' && pend.queue[0] === pend.again.key, pend);

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
    await updateItems(['weidian:7237185689'], { note: 'N'.repeat(500), customTitle: 'Very long name '.repeat(10) });
    await handlers.settings({ patch: { sync: true } });
    out.push = await syncPush(true);
    const remote = await chrome.storage.sync.get(null);
    const chunkKeys = Object.keys(remote).filter((k) => /^rh_i\d+$/.test(k));
    out.chunks = chunkKeys.length;
    out.arrays = chunkKeys.every((k) => Array.isArray(remote[k]));
    out.biggest = Math.max(...chunkKeys.map((k) => new TextEncoder().encode(JSON.stringify(remote[k])).length));
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

    // empty device: everything comes back
    await chrome.storage.local.set({ items: {}, tombstones: {} });
    await syncPull();
    out.restored = Object.keys((await chrome.storage.local.get('items')).items).length;
    return out;
  });
  check('sync writes succeed for a list full of quotes and angle brackets (stored as arrays, each under the limit)', sync.push.ok && sync.push.written && sync.arrays && sync.chunks > 1 && sync.biggest < 8100, { push: sync.push, chunks: sync.chunks, arrays: sync.arrays, biggest: sync.biggest });
  check('a long note travels shortened and flagged', sync.sentNote === 200 && sync.sentCut === 3, { sentNote: sync.sentNote, sentCut: sync.sentCut });
  check('a change from another device is merged without shortening this device\'s own long note and name', sync.folder === 'Maybe' && sync.noteKept === 500 && sync.nameKept === 150 && sync.gotNew, { folder: sync.folder, note: sync.noteKept, name: sync.nameKept, gotNew: sync.gotNew });
  check('after taking in another device\'s changes, a follow-up push is scheduled', sync.alarm === true && sync.secondPush.ok, { alarm: sync.alarm, second: sync.secondPush });
  check('an empty device gets the whole list back from sync', sync.restored >= sync.before, { before: sync.before, restored: sync.restored });

  // ====================================== 8. saved copies of real Reddit pages
  if (REAL && fs.existsSync(REAL)) {
    for (const file of fs.readdirSync(REAL).filter((f) => /\.html$/.test(f))) {
      const html = fs.readFileSync(path.join(REAL, file), 'utf8');
      const tag = (html.match(/<shreddit-post[^>]*>/) || [''])[0];
      const attr = (name) => ((tag.match(new RegExp('\\s' + name + '="([^"]*)"')) || [])[1] || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const permalink = attr('permalink');
      if (!permalink) continue;
      const url = 'https://www.reddit.com' + permalink;
      const expected = Array.from(new Set(Array.from(html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"]+)"/g), (m) => m[1].replace(/&amp;/g, '&')).filter((h) => !/reddit|redd\.it|archive\.org/.test(h))));
      const page = await fixturePage(url, [[url, html]]);
      await sleep(2500);
      const found = await page.evaluate(() => Array.from(document.querySelectorAll('[data-rh-pill]')).map((p) => p.previousElementSibling.getAttribute('href') || p.previousElementSibling.textContent));
      const inComment = await page.evaluate(() => { const p = Array.from(document.querySelectorAll('[data-rh-pill]')).find((x) => x.closest('shreddit-comment')); return p ? p.previousElementSibling.id || (p.previousElementSibling.id = 'rh-e2e-c') : null; });
      const inPost = await page.evaluate(() => { const p = Array.from(document.querySelectorAll('[data-rh-pill]')).find((x) => !x.closest('shreddit-comment') && x.closest('shreddit-post')); return p ? p.previousElementSibling.id || (p.previousElementSibling.id = 'rh-e2e-p') : null; });
      const wanted = await sw.evaluate((list) => list.filter((h) => L.parseLink(h)).length, expected);
      check('real Reddit page ' + file + ': product links found in the saved markup get buttons', wanted === 0 ? found.length === 0 : found.length >= wanted, { wanted, found: found.length });
      for (const [id, kind] of [[inPost, 'post'], [inComment, 'comment']]) {
        if (!id) continue;
        const href = await page.$eval('#' + id, (a) => a.href);
        const key = await sw.evaluate((h) => L.parseLink(h).key, href);
        await sw.evaluate((k) => removeItems([k]), key);
        // The saved page has none of Reddit's own styling, so its layout is not the real one; the click is
        // delivered straight to the link. What is being checked here is the markup: attributes and nesting.
        await page.$eval('#' + id, (a) => a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, altKey: true, button: 0 })));
        const saved = await until(async () => {
          const all = (await store(['items'])).items;
          return Object.values(all).find((it) => it.key === key || (it.aliases || []).includes(key));
        }, 12000);
        const src = saved && saved.sources[saved.sources.length - 1];
        const ok = !!src && src.postTitle === attr('post-title') && src.sub === attr('subreddit-prefixed-name') && src.postUrl === url && (kind === 'post' ? !src.commentUrl : /\/comment\//.test(src.commentUrl) && !!src.author);
        check('real Reddit page ' + file + ': a link in the ' + kind + ' is saved with the right ' + (kind === 'post' ? 'post title and subreddit' : 'comment permalink and author'), ok, src || 'not saved');
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'real-' + file.replace(/\.html$/, '') + '.png') });
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
