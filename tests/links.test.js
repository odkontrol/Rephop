// Run with:  node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/links.js');

const key = (url) => {
  const p = L.parseLink(url);
  return p ? p.key : null;
};

test('Weidian links in every common shape', () => {
  assert.equal(key('https://weidian.com/item.html?itemID=7237185689'), 'weidian:7237185689');
  assert.equal(key('weidian.com/item.html?itemID=7237185689&spider_token=abc'), 'weidian:7237185689');
  assert.equal(key('https://weidian.com/item.html?itemId=7237185689'), 'weidian:7237185689');
  assert.equal(key('https://weidian.com/fastorder.html?itemID=7237185689'), 'weidian:7237185689');
  assert.equal(key('http://m.weidian.com/item.html?itemID=7237185689'), 'weidian:7237185689');
  const shop = L.parseLink('https://shop1622368742.v.weidian.com/item.html?itemID=7237185689');
  assert.equal(shop.key, 'weidian:7237185689');
  assert.equal(shop.shopId, '1622368742');
  assert.equal(shop.url, 'https://weidian.com/item.html?itemID=7237185689');
});

test('Weidian shop pages are not products', () => {
  assert.equal(key('https://weidian.com/?userid=1622368742'), null);
  assert.equal(key('https://shop1622368742.v.weidian.com/'), null);
});

test('Taobao, Tmall and 1688', () => {
  assert.equal(key('https://item.taobao.com/item.htm?id=675330231400'), 'taobao:675330231400');
  assert.equal(key('https://item.taobao.com/item.htm?spm=a1z10.1&id=675330231400&ft=t'), 'taobao:675330231400');
  assert.equal(key('https://m.intl.taobao.com/detail/detail.html?id=675330231400'), 'taobao:675330231400');
  assert.equal(key('https://detail.tmall.com/item.htm?id=675330231400'), 'taobao:675330231400');
  assert.equal(key('https://world.taobao.com/item/675330231400.htm'), 'taobao:675330231400');
  assert.equal(key('https://detail.1688.com/offer/622042419913.html'), '1688:622042419913');
  assert.equal(key('https://m.1688.com/offer/622042419913.html?spm=x'), '1688:622042419913');
  assert.equal(key('https://www.taobao.com/'), null);
  assert.equal(key('https://s.taobao.com/search?q=shoes'), null);
});

test('Yupoo albums, and non-album Yupoo pages', () => {
  const a = L.parseLink('https://singor.x.yupoo.com/albums/258055580?uid=1&isSubCate=false');
  assert.equal(a.kind, 'yupoo');
  assert.equal(a.key, 'yupoo:singor/258055580');
  assert.equal(a.url, 'https://singor.x.yupoo.com/albums/258055580?uid=1');
  assert.equal(key('https://singor.x.yupoo.com/albums'), null);
  assert.equal(key('https://singor.x.yupoo.com/categories/123'), null);
  assert.equal(L.yupooUser('https://Singor.x.yupoo.com/albums'), 'singor');
  assert.equal(L.yupooUser('https://weidian.com/'), null);
});

test("Yupoo's /external redirect is unwrapped (double-encoded)", () => {
  const u = 'https://x.yupoo.com/external?url=https%253A%252F%252Fweidian.com%252Fitem.html%253FitemID%253D7870660857';
  assert.equal(key(u), 'weidian:7870660857');
});

test('other agents convert to the underlying product', () => {
  const cases = {
    'https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689': 'weidian:7237185689',
    'https://www.allchinabuy.com/en/page/buy/?url=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D675330231400': 'taobao:675330231400',
    'https://www.pandabuy.com/product?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689&utm_source=x': 'weidian:7237185689',
    'https://cnfans.com/product/?shop_type=weidian&id=7237185689': 'weidian:7237185689',
    'https://cnfans.com/product?id=622042419913&platform=ALI_1688': '1688:622042419913',
    'https://mulebuy.com/product?id=675330231400&platform=TAOBAO': 'taobao:675330231400',
    'https://joyabuy.com/product/?shop_type=weidian&id=7237185689': 'weidian:7237185689',
    'https://orientdig.com/product/?shop_type=taobao&id=675330231400': 'taobao:675330231400',
    'https://www.kakobuy.com/item/details?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689&affcode=x': 'weidian:7237185689',
    'https://hoobuy.com/product/2/7237185689': 'weidian:7237185689',
    'https://hoobuy.com/product/1/675330231400?utm=1': 'taobao:675330231400',
    'https://hoobuy.com/product/0/622042419913': '1688:622042419913',
    'https://oopbuy.com/product/weidian/7237185689': 'weidian:7237185689',
    'https://www.acbuy.com/product?id=7237185689&source=WD': 'weidian:7237185689',
    'https://www.acbuy.com/product?id=622042419913&source=AO': '1688:622042419913',
    'https://www.lovegobuy.com/product?id=7237185689&shop_type=weidian': 'weidian:7237185689',
    'https://www.cssbuy.com/item-micro-7237185689.html': 'weidian:7237185689',
    'https://www.cssbuy.com/item-1688-622042419913.html': '1688:622042419913',
    'https://www.cssbuy.com/item-675330231400.html': 'taobao:675330231400',
    'https://www.sugargoo.com/#/home/productDetail?productLink=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689': 'weidian:7237185689',
    'https://www.hagobuy.com/item/details?url=https%3A%2F%2Fitem.taobao.com%2Fitem.htm%3Fid%3D675330231400': 'taobao:675330231400',
    'https://www.basetao.com/best-taobao-agent-service/products/agent/weidian/7237185689.html': 'weidian:7237185689',
  };
  for (const [url, want] of Object.entries(cases)) assert.equal(key(url), want, url);
  assert.equal(L.parseLink('https://cnfans.com/product/?shop_type=weidian&id=7237185689').via, 'agent');
});

test('agent pages that are not products are ignored', () => {
  assert.equal(key('https://cnfans.com/'), null);
  assert.equal(key('https://www.superbuy.com/en/page/account/'), null);
  assert.equal(key('https://hoobuy.com/product/9/123456'), null);
  assert.equal(key('https://cnfans.com/product?id=abc&platform=WEIDIAN'), null);
});

test('redirect wrappers (Reddit, Google) are unwrapped', () => {
  assert.equal(key('https://out.reddit.com/t3_x?url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689&token=a'), 'weidian:7237185689');
  assert.equal(key('https://www.google.com/url?q=https://weidian.com/item.html?itemID%3D7237185689&sa=D'), 'weidian:7237185689');
  assert.equal(key('https://www.google.com/url?q=https%3A%2F%2Fcnfans.com%2Fproduct%2F%3Fshop_type%3Dweidian%26id%3D7237185689'), 'weidian:7237185689');
});

test('short links are flagged for a network hop', () => {
  const s = L.parseLink('https://k.youshop10.com/Ab-cD=1?a=b');
  assert.equal(s.kind, 'short');
  assert.equal(s.url, 'https://k.youshop10.com/Ab-cD=1?a=b');
  assert.equal(L.parseLink('https://m.tb.cn/h.5abc?tk=xyz').kind, 'short');
  assert.equal(L.parseLink('https://qr.1688.com/s/abc').kind, 'short');
});

test('ordinary links are left alone', () => {
  for (const u of ['https://www.reddit.com/r/FashionReps/comments/abc/x/', 'https://imgur.com/a/abc', 'https://example.com/?id=123456&platform=weidian', 'mailto:a@b.c', 'javascript:alert(1)', '', null, 'not a link']) {
    assert.equal(key(u), null, String(u));
  }
});

test('markdown-escaped and protocol-less links still parse', () => {
  assert.equal(key('https://weidian.com/item.html?itemID\\=7237185689'), 'weidian:7237185689');
  assert.equal(key('//weidian.com/item.html?itemID=7237185689'), 'weidian:7237185689');
  assert.equal(key('https://weidian.com/item.html?itemID=7237185689&amp;wfr=c'), 'weidian:7237185689');
});

test('agentUrl builds the Superbuy listing link', () => {
  const item = L.parseLink('https://shop1.v.weidian.com/item.html?itemID=7237185689&x=1');
  assert.equal(
    L.agentUrl(item, { agent: 'superbuy' }),
    'https://www.superbuy.com/en/page/buy/?nTag=Home-search&from=search-input&url=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689'
  );
  assert.equal(L.agentUrl(item, {}), L.agentUrl(item, { agent: 'superbuy' }), 'Superbuy is the default');
  assert.equal(L.agentUrl(item, { agent: 'cnfans' }), 'https://cnfans.com/product?id=7237185689&platform=WEIDIAN');
  assert.equal(L.agentUrl(item, { agent: 'hoobuy' }), 'https://hoobuy.com/product/2/7237185689');
  assert.equal(L.agentUrl(item, { agent: 'acbuy' }), 'https://www.acbuy.com/product?id=7237185689&source=WD');
  assert.equal(L.agentUrl(L.parseLink('https://detail.1688.com/offer/622042419913.html'), { agent: 'cnfans' }), 'https://cnfans.com/product?id=622042419913&platform=ALI_1688');
});

test('every built-in agent link round-trips back to the same product', () => {
  for (const url of ['https://weidian.com/item.html?itemID=7237185689', 'https://item.taobao.com/item.htm?id=675330231400', 'https://detail.1688.com/offer/622042419913.html']) {
    const item = L.parseLink(url);
    for (const agent of Object.keys(L.AGENTS)) {
      if (agent === 'custom') continue;
      assert.equal(key(L.agentUrl(item, { agent })), item.key, agent + ' ' + url);
    }
  }
});

test('custom agent template, with a safe fallback', () => {
  const item = L.parseLink('https://weidian.com/item.html?itemID=7237185689');
  assert.equal(L.agentUrl(item, { agent: 'custom', customTemplate: 'https://x.test/p?u={url}&i={id}&p={platform}' }), 'https://x.test/p?u=https%3A%2F%2Fweidian.com%2Fitem.html%3FitemID%3D7237185689&i=7237185689&p=weidian');
  assert.match(L.agentUrl(item, { agent: 'custom', customTemplate: 'javascript:alert({url})' }), /^https:\/\/www\.superbuy\.com\//);
  assert.equal(L.validTemplate('http://x.test/?u={url}'), false);
  assert.equal(L.validTemplate('https://x.test/nothing'), false);
});

test('Yupoo albums open as themselves and have no QC link', () => {
  const album = L.parseLink('https://singor.x.yupoo.com/albums/258055580');
  assert.equal(L.agentUrl(album, { agent: 'superbuy' }), 'https://singor.x.yupoo.com/albums/258055580?uid=1');
  assert.equal(L.qcUrl(album, {}), null);
  assert.equal(L.qcUrl(L.parseLink('https://weidian.com/item.html?itemID=7237185689'), {}), 'https://finderqc.com/product/weidian/7237185689');
});

test('keyToItem is the inverse of parseLink', () => {
  for (const url of ['https://weidian.com/item.html?itemID=7237185689', 'https://detail.1688.com/offer/622042419913.html', 'https://singor.x.yupoo.com/albums/258055580?uid=1']) {
    const p = L.parseLink(url);
    assert.equal(L.keyToItem(p.key).url, p.url);
  }
  assert.equal(L.keyToItem('short:k.youshop10.com/abc'), null);
  assert.equal(L.keyToItem('weidian:abc'), null);
  assert.equal(L.keyToItem('nonsense'), null);
});

test('extractLinks finds links in free text, in order, without duplicates', () => {
  const text = 'W2C? try weidian.com/item.html?itemID=7237185689. Also https://singor.x.yupoo.com/albums/258055580?uid=1, and again https://weidian.com/item.html?itemID=7237185689 (dupe)';
  const hits = L.extractLinks(text);
  assert.deepEqual(hits.map((h) => h.parsed.key), ['weidian:7237185689', 'yupoo:singor/258055580']);
  assert.equal(text.slice(hits[0].index, hits[0].index + hits[0].length), 'weidian.com/item.html?itemID=7237185689');
  assert.deepEqual(L.extractLinks('nothing here, e.g. file.txt and reddit.com'), []);
});

test('a bare itemID is treated as a Weidian item', () => {
  const hits = L.extractLinks('mods remove links so: itemID=7237185689');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].parsed.key, 'weidian:7237185689');
});

test('extractLabeled pairs links with the words next to them', () => {
  const md = [
    '**Haul list**',
    '[Black Cat J4](https://weidian.com/item.html?itemID=1111111111)',
    'Grey hoodie - https://item.taobao.com/item.htm?id=2222222222',
    '| Cargo pants | ¥120 | https://weidian.com/item.html?itemID=3333333333 |',
    'https://weidian.com/item.html?itemID=4444444444',
    '* Belt: https://cnfans.com/product/?shop_type=weidian&id=5555555555 and wallet https://weidian.com/item.html?itemID=6666666666',
  ].join('\n');
  const got = L.extractLabeled(md).map((h) => [h.parsed.key, h.label]);
  assert.deepEqual(got, [
    ['weidian:1111111111', 'Black Cat J4'],
    ['taobao:2222222222', 'Grey hoodie'],
    ['weidian:3333333333', 'Cargo pants | ¥120'],
    ['weidian:4444444444', ''],
    ['weidian:5555555555', 'Belt'],
    ['weidian:6666666666', 'and wallet'],
  ]);
});

test('cleanLabel drops filler words and stray markdown', () => {
  assert.equal(L.cleanLabel('**LINK**'), '');
  assert.equal(L.cleanLabel('  - Jordan 4 "Bred": '), 'Jordan 4 "Bred"');
  assert.equal(L.cleanLabel('https://weidian.com/item.html?itemID=1'), '');
  assert.equal(L.cleanLabel('x'.repeat(200)).length, 108);
});
