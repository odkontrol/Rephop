const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/links.js');
const U = require('../lib/util.js');

function item(key, extra) {
  return Object.assign(U.expandItem({ k: key, m: 1000, a: 1000 }), extra || {});
}

test('settings merge keeps defaults for anything missing', () => {
  const s = U.mergeSettings({ agent: 'cnfans', keys: { open: 'x' } });
  assert.equal(s.agent, 'cnfans');
  assert.equal(s.keys.open, 'x');
  assert.equal(s.keys.save, 'a');
  assert.equal(s.openMode, 'reuse');
  assert.deepEqual(U.mergeSettings(undefined).extraSites, []);
});

test('displayTitle prefers your own name, then the Reddit label, then the listing', () => {
  assert.equal(U.displayTitle(item('weidian:7237185689')), 'Weidian #7237185689');
  assert.equal(U.displayTitle(item('weidian:7237185689', { title: '短袖' })), '短袖');
  assert.equal(U.displayTitle(item('weidian:7237185689', { title: '短袖', label: 'Prada tee' })), 'Prada tee');
  assert.equal(U.displayTitle(item('weidian:7237185689', { title: '短袖', label: 'Prada tee', customTitle: 'Mine' })), 'Mine');
});

test('prices are read out of album titles', () => {
  assert.equal(U.parsePrice('￥268  小马刺绣拉链连帽卫衣'), 268);
  assert.equal(U.parsePrice('Hoodie ¥ 199.50 S-XL'), 199.5);
  assert.equal(U.parsePrice('Jacket 320 yuan'), 320);
  assert.equal(U.parsePrice('CNY 88'), 88);
  assert.equal(U.parsePrice('size 43 only'), null);
});

test('currency conversion uses live rates, then fallbacks', () => {
  assert.ok(Math.abs(U.convert(100, { rates: { USD: 0.15 } }, 'USD') - 15) < 1e-9);
  assert.ok(Math.abs(U.convert(100, null, 'USD') - 14) < 1e-9, 'fallback rate');
  assert.equal(U.convert(100, null, 'CNY'), 100);
  assert.equal(U.convert(null, null, 'USD'), null);
  assert.equal(U.yuan(310), '¥310');
  assert.equal(U.yuan(310.5), '¥310.50');
});

test('search matches across name, note, tags and source', () => {
  const it = item('weidian:7237185689', { label: 'Black hoodie', note: 'size L', tags: ['winter'], sources: [{ sub: 'r/FashionReps', postTitle: 'Budget haul' }] });
  assert.ok(U.matches(it, 'hoodie'));
  assert.ok(U.matches(it, 'WINTER black'));
  assert.ok(U.matches(it, 'fashionreps haul'));
  assert.ok(!U.matches(it, 'shoes'));
  assert.ok(U.matches(it, ''));
});

test('tags are normalised', () => {
  assert.deepEqual(U.normalizeTags(' Shoes, size 43 ,shoes,, #Winter'), ['shoes', 'size-43', 'winter']);
  assert.deepEqual(U.normalizeTags(['A', 'a']), ['a']);
});

test('CSV escapes quotes, commas and spreadsheet formulas', () => {
  assert.equal(U.csvCell('plain'), 'plain');
  assert.equal(U.csvCell('a,b'), '"a,b"');
  assert.equal(U.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(U.csvCell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(U.csvCell(null), '');
  const csv = U.toCsv([item('weidian:7237185689', { label: 'Tee, black', price: 100, tags: ['a', 'b'] })], U.mergeSettings(), { rates: { USD: 0.15 } });
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Title,Price (CNY),Price (USD)'));
  assert.ok(lines[1].startsWith('"Tee, black",100,15.00,1,Weidian,https://weidian.com/item.html?itemID=7237185689,https://www.superbuy.com/'));
});

test('text and markdown export', () => {
  const list = [item('weidian:7237185689', { label: 'Tee [v2]', price: 100 })];
  const s = U.mergeSettings();
  assert.equal(U.toText(list, 'links', s), L.agentUrl(list[0], s));
  assert.equal(U.toText(list, 'markdown', s), '- [Tee \\[v2\\]](' + L.agentUrl(list[0], s) + ') — ¥100');
  assert.ok(U.toText(list, 'text', s).startsWith('Tee [v2] — ¥100\n'));
});

test('HTML helpers used when reading Yupoo pages', () => {
  assert.equal(U.decodeEntities('itemID&#x3D;7870660857 &amp; &quot;x&quot;'), 'itemID=7870660857 & "x"');
  assert.equal(U.stripTags('<a href="x">hello</a><br>there').replace(/\s+/g, ' ').trim(), 'hello there');
});

test('sync: an item survives compact + expand', () => {
  const it = item('weidian:7237185689', {
    label: 'Prada tee', title: '短袖T恤', price: 310, folder: 'Next haul', tags: ['tee'], note: 'L', status: 'carted', qty: 2,
    sources: [{ postUrl: 'https://www.reddit.com/r/FashionReps/comments/abc/x/', postTitle: 'Haul', sub: 'r/FashionReps' }],
    seller: { key: 'yupoo:singor', name: 'singor' }, aliases: ['yupoo:singor/1'], addedAt: 5, updatedAt: 9,
  });
  const back = U.expandItem(JSON.parse(JSON.stringify(U.compactItem(it))));
  for (const f of ['key', 'platform', 'id', 'url', 'label', 'title', 'price', 'folder', 'note', 'status', 'qty', 'addedAt', 'updatedAt']) assert.deepEqual(back[f], it[f], f);
  assert.deepEqual(back.tags, ['tee']);
  assert.deepEqual(back.seller, it.seller);
  assert.deepEqual(back.aliases, it.aliases);
  assert.equal(back.sources[0].postUrl, it.sources[0].postUrl);
  const custom = U.expandItem(U.compactItem(item('weidian:7237185689', { label: 'From reddit', customTitle: 'My name' })));
  assert.equal(custom.customTitle, 'My name');
});

// What chrome.storage.sync charges for one value: the bytes of its JSON (with "<" written as a 6-byte escape) plus the key.
// This is computed here independently of storedSize() so the test does not just agree with itself.
function chromeCharge(key, value) {
  const json = JSON.stringify(value);
  let escaped = 0;
  for (const ch of json) if (ch === '<' || ch.charCodeAt(0) === 0x2028 || ch.charCodeAt(0) === 0x2029) escaped += 5;
  return Buffer.byteLength(json, 'utf8') + escaped + key.length;
}

function assertFitsSync(packed, why) {
  let total = 0;
  packed.chunks.forEach((c, i) => {
    const size = chromeCharge('rh_i' + i, c);
    assert.ok(size <= 8192, why + ': chunk ' + i + ' is ' + size + ' bytes, over the 8,192 per-value limit');
    total += size;
  });
  assert.ok(total <= 100000, why + ': total ' + total + ' bytes is over the sync quota');
}

test('sync: packing respects the per-value and total size limits', () => {
  const items = {};
  for (let i = 0; i < 900; i++) {
    const k = 'weidian:' + (7000000000 + i);
    items[k] = item(k, { label: '中文标题 hoodie number ' + i, note: 'n'.repeat(120), addedAt: i, updatedAt: i });
  }
  const packed = U.packSync(items, { 'weidian:1234567890': 99999 });
  assert.ok(packed.chunks.length > 1);
  assert.ok(packed.chunks.every(Array.isArray), 'chunks are stored as arrays, not pre-stringified text');
  assertFitsSync(packed, 'plain list');
  assert.ok(packed.dropped > 0, 'oldest items are dropped when the list is too big');
  const entries = U.unpackSync(packed.chunks);
  assert.equal(entries.length, packed.count);
  assert.ok(entries.some((e) => e.d === 1), 'deletions travel too');
  assert.ok(entries.some((e) => e.k === 'weidian:7000000899'), 'newest item kept');
  assert.ok(!entries.some((e) => e.k === 'weidian:7000000000'), 'oldest item dropped');
  assert.deepEqual(U.unpackSync(['not json', '{"a":1}']), []);
  assert.equal(U.unpackSync([JSON.stringify([{ k: 'weidian:7000000001', m: 5 }])]).length, 1, 'the first release stored JSON text; still readable');
});

test('sync: names full of quotes, angle brackets and backslashes still fit', () => {
  const items = {};
  for (let i = 0; i < 400; i++) {
    const k = 'weidian:' + (7100000000 + i);
    items[k] = item(k, { label: 'Jordan 4 "Bred" <' + i + '> \\ "OG"', note: '"""<<<>>>\\\\ size "43" '.repeat(8), tags: ['a"b', '<c>'], addedAt: i, updatedAt: i });
  }
  assertFitsSync(U.packSync(items, {}), 'quote-heavy list');
  assertFitsSync(U.packSync(items, {}, { chunkBytes: 4200 }), 'quote-heavy list, small chunks');
  const tombs = {};
  for (let i = 0; i < 3000; i++) tombs['weidian:' + (7200000000 + i)] = i;
  assertFitsSync(U.packSync({}, tombs), 'tombstones only');
});

test('sync: packing is deterministic, so two devices with the same list agree', () => {
  const a = {};
  const b = {};
  const keys = ['weidian:7300000003', 'weidian:7300000001', 'weidian:7300000002'];
  for (const k of keys) a[k] = item(k, { label: 'same', updatedAt: 7, addedAt: 7 });
  for (const k of keys.slice().reverse()) b[k] = item(k, { label: 'same', updatedAt: 7, addedAt: 7 });
  assert.deepEqual(U.packSync(a, {}).chunks, U.packSync(b, {}).chunks);
});

test('sync: a device only pushes when it holds something newer or missing remotely', () => {
  const items = { 'weidian:7400000001': item('weidian:7400000001', { updatedAt: 10 }), 'weidian:7400000002': item('weidian:7400000002', { updatedAt: 20 }) };
  const kept = U.packSync(items, {}).kept;
  assert.equal(U.needsPush(kept, [{ k: 'weidian:7400000001', m: 10 }, { k: 'weidian:7400000002', m: 20 }]), false);
  assert.equal(U.needsPush(kept, [{ k: 'weidian:7400000001', m: 10 }, { k: 'weidian:7400000002', m: 25 }]), false, 'remote is newer: pull, do not push');
  assert.equal(U.needsPush(kept, [{ k: 'weidian:7400000001', m: 10 }]), true, 'remote lacks an item');
  assert.equal(U.needsPush(kept, [{ k: 'weidian:7400000001', m: 5 }, { k: 'weidian:7400000002', m: 20 }]), true, 'remote copy is older');
});

test('sync: shortened text never overwrites the longer original', () => {
  const longNote = 'N'.repeat(500);
  const longName = 'Very long name '.repeat(10); // 150 characters
  const original = item('weidian:7500000001', { customTitle: longName, note: longNote, folder: 'Inbox', updatedAt: 10 });

  // Device A packs it: the copy that travels is cut and flagged.
  const sent = U.compactItem(original);
  assert.equal(sent.n.length, U.SYNC_NOTE_MAX);
  assert.equal(sent.l.length, U.SYNC_NAME_MAX);
  assert.equal(sent.x, U.CUT_NAME | U.CUT_NOTE);

  // Device B receives it, moves it to another folder and syncs back.
  const deviceB = {};
  U.mergeSync(deviceB, {}, [JSON.parse(JSON.stringify(sent))]);
  const onB = deviceB['weidian:7500000001'];
  assert.equal(onB.note.length, U.SYNC_NOTE_MAX);
  assert.equal(onB.cut, U.CUT_NAME | U.CUT_NOTE, 'B remembers its copy is shortened');
  onB.folder = 'Maybe';
  onB.updatedAt = 20;
  const back = U.compactItem(onB);
  assert.equal(back.x, U.CUT_NAME | U.CUT_NOTE, 'the flag travels back even though B\'s text is under the limit');

  // Device A takes the folder change but keeps its full text.
  const deviceA = { 'weidian:7500000001': original };
  assert.equal(U.mergeSync(deviceA, {}, [JSON.parse(JSON.stringify(back))]), true);
  assert.equal(deviceA['weidian:7500000001'].folder, 'Maybe');
  assert.equal(deviceA['weidian:7500000001'].note, longNote);
  assert.equal(deviceA['weidian:7500000001'].customTitle, longName);
  assert.equal(deviceA['weidian:7500000001'].cut, undefined, 'A holds the full text, so nothing is marked as shortened');

  // If B really rewrites the note, that edit is not flagged and does win.
  onB.note = 'new short note';
  onB.cut &= ~U.CUT_NOTE;
  onB.updatedAt = 30;
  U.mergeSync(deviceA, {}, [JSON.parse(JSON.stringify(U.compactItem(onB)))]);
  assert.equal(deviceA['weidian:7500000001'].note, 'new short note');
  assert.equal(deviceA['weidian:7500000001'].customTitle, longName, 'the name was not edited on B, so A keeps the long one');
});

test('thumbnails ask the picture host for a small version', () => {
  assert.equal(U.thumbUrl('https://si.geilicdn.com/pcitem1-unadjust_788_1280.png', 160), 'https://si.geilicdn.com/pcitem1-unadjust_788_1280.png?w=160&h=160&cp=1');
  assert.equal(U.thumbUrl('https://si.geilicdn.com/a.jpg?w=1000&h=1000'), 'https://si.geilicdn.com/a.jpg?w=200&h=200&cp=1');
  assert.equal(U.thumbUrl('https://photo.yupoo.com/singor/03f56a04f2/medium.jpg'), 'https://photo.yupoo.com/singor/03f56a04f2/small.jpg');
  assert.equal(U.thumbUrl('https://img.alicdn.com/x.jpg'), 'https://img.alicdn.com/x.jpg');
  assert.equal(U.thumbUrl('http://insecure.example/x.jpg'), '');
  assert.equal(U.thumbUrl('javascript:alert(1)'), '');
});

test('describeSave sums up a save in one line', () => {
  assert.equal(U.describeSave({ added: 1, title: 'Tee' }), 'Saved: Tee');
  assert.equal(U.describeSave({ added: 3, duplicates: 2, failed: 1 }), "Saved 3 new · 2 already in your list · 1 couldn't be read");
  assert.equal(U.describeSave({ duplicates: 1 }), 'Already in your list');
  assert.equal(U.describeSave({ failed: 1, reason: 'network' }), "Couldn't reach that link. Check your connection and try again.");
  assert.equal(U.describeSave({}), 'Nothing to save.');
});

test('the link search does not crawl on long unbroken text', () => {
  const junk = 'a1'.repeat(40000) + '1688' + 'zz'.repeat(40000);
  const t = Date.now();
  assert.deepEqual(L.extractLinks(junk), []);
  assert.ok(Date.now() - t < 200, 'took ' + (Date.now() - t) + ' ms');
  const hit = L.extractLinks('x'.repeat(5000) + ' weidian.com/item.html?itemID=7237185689 ' + 'y'.repeat(5000));
  assert.equal(hit.length, 1);
});

test('sync: merge adds, updates and deletes by timestamp', () => {
  const local = {
    'weidian:1111111111': item('weidian:1111111111', { label: 'old name', updatedAt: 10, image: 'https://img/x.jpg' }),
    'weidian:2222222222': item('weidian:2222222222', { label: 'edited here', updatedAt: 50 }),
    'weidian:3333333333': item('weidian:3333333333', { updatedAt: 10 }),
    'weidian:4444444444': item('weidian:4444444444', { updatedAt: 90 }),
  };
  const tombs = { 'weidian:6666666666': 80 };
  const remote = [
    { k: 'weidian:1111111111', l: 'new name', f: 'Maybe', m: 20, a: 1 }, // newer remotely -> update
    { k: 'weidian:2222222222', l: 'stale', m: 40, a: 1 }, // older remotely -> ignore
    { k: 'weidian:3333333333', d: 1, m: 30 }, // deleted remotely after our edit -> delete
    { k: 'weidian:4444444444', d: 1, m: 30 }, // deleted remotely before our edit -> keep
    { k: 'weidian:5555555555', l: 'brand new', m: 5, a: 5 }, // unknown -> add
    { k: 'weidian:6666666666', l: 'zombie', m: 70, a: 1 }, // we deleted it later -> stay deleted
    { k: 'bogus', l: 'x', m: 1 },
  ];
  assert.equal(U.mergeSync(local, tombs, remote), true);
  assert.equal(local['weidian:1111111111'].label, 'new name');
  assert.equal(local['weidian:1111111111'].folder, 'Maybe');
  assert.equal(local['weidian:1111111111'].image, 'https://img/x.jpg', 'local-only fields survive');
  assert.equal(local['weidian:2222222222'].label, 'edited here');
  assert.equal(local['weidian:3333333333'], undefined);
  assert.equal(tombs['weidian:3333333333'], 30);
  assert.ok(local['weidian:4444444444']);
  assert.equal(local['weidian:5555555555'].label, 'brand new');
  assert.equal(local['weidian:6666666666'], undefined);
  assert.equal(local.bogus, undefined);
  assert.equal(U.mergeSync(local, tombs, remote), false, 'merging the same data again changes nothing');
});

function weidianPage(obj) {
  const attr = JSON.stringify(obj).replace(/&/g, '&amp;').replace(/"/g, '&#34;').replace(/</g, '&lt;');
  return '<html><body><div id="root"></div><script id="__rocker-render-inject__" type="application/json" data-obj="' + attr + '"></script></body></html>';
}

test('Weidian item page: shop and translated name are read from the embedded data', () => {
  const html = weidianPage({ status: { code: 0, message: 'OK' }, result: { default_model: {
    item_info: { item_id: '7870660857', item_name: '  Embroidered zip-up hoodie   with a hood 5557 XW ', item_head: 'https://si.geilicdn.com/pcitem9-5c9c_1000_1000.jpg', shop_id: 2004619, origin_price: '268' },
    shop_info: { shop_id: 2004619, shopName: '威风网 "A&B" <shop>', shop_url: 'https://weidian.com/?userid=2004619' },
  } } });
  assert.deepEqual(U.parseWeidianPage(html), {
    name: 'Embroidered zip-up hoodie with a hood 5557 XW',
    image: 'https://si.geilicdn.com/pcitem9-5c9c_1000_1000.jpg',
    seller: { key: 'weidian:2004619', name: '威风网 "A&B" <shop>' },
  });
});

test('Weidian item page: a deleted item, and pages that are not item pages', () => {
  assert.deepEqual(U.parseWeidianPage(weidianPage({ status: { code: 831013, message: '商品不存在', description: '' }, result: null })), { gone: true });
  assert.equal(U.parseWeidianPage(weidianPage({ status: { code: 500, message: 'busy' }, result: null })), null, 'an error is not proof the item is gone');
  assert.equal(U.parseWeidianPage('<html><body>Just a moment...</body></html>'), null);
  assert.equal(U.parseWeidianPage('<script id="__rocker-render-inject__" data-obj="{not json"></script>'), null);
  assert.deepEqual(U.parseWeidianPage(weidianPage({ status: { code: 0 }, result: { default_model: { item_info: { shop_id: 'abc' }, shop_info: {} } } })), {}, 'odd shop ids are ignored');
});

test('displayTitle prefers the translated listing name over the original one', () => {
  assert.equal(U.displayTitle(item('weidian:7237185689', { title: '短袖', titleEn: 'Short sleeve tee' })), 'Short sleeve tee');
  assert.equal(U.displayTitle(item('weidian:7237185689', { title: '短袖', titleEn: 'Short sleeve tee', label: 'From Reddit' })), 'From Reddit');
});
