const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/links.js');
const U = require('../lib/util.js');

function item(key, extra) {
  return Object.assign(U.expandItem({ k: key, m: 1000, a: 1000 }), extra || {});
}

test('settings merge keeps defaults for anything missing', () => {
  assert.equal(U.mergeSettings().agent, '', 'no agent out of the box');
  assert.equal(U.mergeSettings().theme, 'dark', 'dark out of the box');
  assert.equal(U.mergeSettings({ theme: 'neon' }).theme, 'dark');
  assert.deepEqual(U.mergeSettings({ sizes: { shoes: '43' } }).sizes, { shoes: '43', tops: '', bottoms: '', belts: '', hats: '' });
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
  const csv = U.toCsv([item('weidian:7237185689', { label: 'Tee, black', price: 100, tags: ['a', 'b'] })], U.mergeSettings({ agent: 'superbuy' }), { rates: { USD: 0.15 } });
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith('Title,Price (CNY),Price (USD)'));
  assert.ok(lines[1].startsWith('"Tee, black",100,15.00,1,Weidian,https://weidian.com/item.html?itemID=7237185689,https://www.superbuy.com/'));
});

test('text and markdown export', () => {
  const list = [item('weidian:7237185689', { label: 'Tee [v2]', price: 100 })];
  const s = U.mergeSettings({ agent: 'superbuy' });
  assert.equal(U.toText(list, 'links', U.mergeSettings()), 'https://weidian.com/item.html?itemID=7237185689', 'with no agent chosen, the plain product link is exported');
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
  // Whole numbers beyond 32 bits (millisecond timestamps) are written as doubles: measured at 5 extra bytes each.
  const doubles = (json.match(/[:\[,]\d{10,}(?=[,}\]])/g) || []).length * 5;
  return Buffer.byteLength(json, 'utf8') + escaped + doubles + key.length;
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
  for (const c of packed.chunks) assert.ok(U.storedSize(c) + 6 >= chromeCharge('rh_i00', c), 'the estimate is never below the real charge');
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

test('sync: an edit made to a shortened name on another device is taken, not mistaken for the old text', () => {
  const longName = 'Very long name '.repeat(10); // 150 characters
  const original = item('weidian:7500000002', { customTitle: longName, updatedAt: 10 });
  const sent = JSON.parse(JSON.stringify(U.compactItem(original)));
  assert.equal(sent.hn, U.textHash(longName), 'the shortened copy carries a fingerprint of the full text');

  const deviceB = {};
  U.mergeSync(deviceB, {}, [sent]);
  const onB = deviceB['weidian:7500000002'];
  assert.equal(onB.cutName, sent.hn, 'B keeps the fingerprint with its shortened copy');

  // B changes only the folder: the fingerprint comes back unchanged, so A keeps its full name.
  onB.folder = 'Maybe';
  onB.updatedAt = 20;
  const deviceA = { 'weidian:7500000002': original };
  U.mergeSync(deviceA, {}, [JSON.parse(JSON.stringify(U.compactItem(onB)))]);
  assert.equal(deviceA['weidian:7500000002'].customTitle, longName);

  // B types more onto the end of the name. The first 80 characters are the same as before, but the
  // fingerprint is not, so A takes B's (newer) name instead of silently keeping its own.
  onB.customTitle = onB.customTitle + ' plus words typed on the second device';
  delete onB.cut;
  delete onB.cutName;
  onB.updatedAt = 30;
  const edited = JSON.parse(JSON.stringify(U.compactItem(onB)));
  assert.notEqual(edited.hn, sent.hn);
  U.mergeSync(deviceA, {}, [edited]);
  assert.equal(deviceA['weidian:7500000002'].customTitle, edited.l);
  assert.equal(deviceA['weidian:7500000002'].cut, U.CUT_NAME, 'and A now knows its copy is the shortened one');
});

test('sync: size, colour, type and remembered options travel with the item', () => {
  const it = item('weidian:7500000003', { kind: 'shoes', size: '43', style: 'black', options: [{ n: 'Color', v: 'Black' }, { n: 'Size', v: '43' }], updatedAt: 5 });
  const back = U.expandItem(JSON.parse(JSON.stringify(U.compactItem(it))));
  assert.equal(back.kind, 'shoes');
  assert.equal(back.size, '43');
  assert.equal(back.style, 'black');
  assert.deepEqual(back.options, it.options);
});

test('add to cart: sizes are matched as whole sizes, never as part of another', () => {
  const o = (text, disabled) => ({ text, disabled: !!disabled });
  assert.equal(U.pickOption([o('S'), o('M'), o('L'), o('XL'), o('XXL')], 'L'), 2);
  assert.equal(U.pickOption([o('S'), o('M'), o('L'), o('XL')], 'XL'), 3);
  assert.equal(U.pickOption([o('S码'), o('M码'), o('L码 (175/92A)'), o('XL码')], 'L'), 2);
  assert.equal(U.pickOption([o('42'), o('42.5'), o('43'), o('43.5'), o('143')], '43'), 2);
  assert.equal(U.pickOption([o('42'), o('42.5'), o('43.5')], '43'), -1, 'no near misses');
  assert.equal(U.pickOption([o('EU 42 / US 8.5'), o('EU 43 / US 9.5')], '44, 9.5'), 1, 'alternatives are tried in order');
  assert.equal(U.pickOption([o('L', true), o('XL')], 'L'), -1, 'a sold-out size is not picked');
  assert.equal(U.pickOption([o('30'), o('32'), o('34')], ''), -1);
  assert.equal(U.sizeMatches('2XL', 'XL'), false);
  assert.equal(U.sizeMatches('Size L', 'l'), true);
});

test('add to cart: remembered colours are matched by their wording', () => {
  const o = (text) => ({ text });
  assert.equal(U.pickOption([o('Black'), o('Black/White'), o('White')], 'black', true), 0, 'the exact one wins over a longer one that contains it');
  assert.equal(U.pickOption([o('黑色 Black'), o('白色 White')], 'black', true), 0);
  assert.equal(U.pickOption([o('Black/White'), o('Black/Red')], 'black', true), -1, 'two candidates means RepHop does not guess');
  assert.equal(U.pickOption([o('Grey'), o('Navy')], 'black', true), -1);
  // a remembered choice is matched as a whole, never as part of a neighbour
  assert.equal(U.pickOption([o('S'), o('M'), o('XL')], 'L', true), -1, '"L" is not inside "XL"');
  assert.equal(U.pickOption([o('41'), o('42.5')], '42', true), -1, '"42" is not "42.5"');
  assert.equal(U.pickOption([o('XXL')], 'L', false), -1);
  assert.equal(U.pickOption([o('M is suitable for 100-130 kg'), o('L suitable for 130-145 kg')], 'L suitable for 130-145 kg', true), 1);
  assert.equal(U.pickOption([o('Black'), o('Jet Black')], 'jet black', true), 1);
});

test('add to cart: the kind of item decides which of your sizes is used', () => {
  const sizes = { shoes: '43, 9.5', tops: 'L', bottoms: '32', belts: '110', hats: '' };
  const s = U.mergeSettings({ sizes });
  assert.equal(U.guessKind({ label: 'Jordan 4 Black Cat' }), 'shoes');
  assert.equal(U.guessKind({ label: 'Essentials hoodie' }), 'tops');
  assert.equal(U.guessKind({ title: '男士牛仔裤' }), 'bottoms');
  assert.equal(U.guessKind({ label: 'LV belt' }), 'belts');
  assert.equal(U.guessKind({ label: 'Mystery thing' }), '');
  assert.equal(U.guessKind({ titleEn: 'Triangle logo short sleeve tee' }), 'tops', 'a short-sleeve tee is not a pair of shorts');
  assert.equal(U.guessKind({ label: 'Nike shorts' }), 'bottoms');
  assert.equal(U.guessKind({ label: 'Black hoodie', titleEn: 'cargo pants set' }), 'tops', 'the words from Reddit outrank the listing name');
  assert.equal(U.guessKind({ label: 'Stussy cap' }), 'hats');
  assert.equal(U.guessKind({ label: 'Top quality cargo pants' }), 'bottoms', '"top" as praise does not make it a top');
  // a garment word outranks a sneaker model name
  assert.equal(U.guessKind({ label: 'Jordan 4 hoodie' }), 'tops');
  assert.equal(U.guessKind({ label: 'Air Max tee' }), 'tops');
  assert.equal(U.guessKind({ label: 'Dunk shorts' }), 'bottoms');
  assert.equal(U.guessKind({ label: 'Campus cargo pants' }), 'bottoms');
  assert.equal(U.guessKind({ label: 'Dunk Low Panda' }), 'shoes');
  assert.equal(U.guessKind({ label: 'Jordan 4', kind: 'tops' }), 'tops', 'your own choice of type wins');
  assert.equal(U.guessKind({ label: 'Jordan 4', kind: 'other' }), '');
  assert.equal(U.sizeFor({ label: 'Jordan 4' }, s), '43, 9.5');
  assert.equal(U.sizeFor({ label: 'Cargo pants' }, s), '32');
  assert.equal(U.sizeFor({ label: 'Jordan 4', size: '44' }, s), '44', 'a size written on the item wins');
  assert.equal(U.sizeFor({ label: 'Bucket hat' }, s), '');
  assert.equal(U.isSizeGroup('Size', []), true);
  assert.equal(U.isSizeGroup('尺码', []), true);
  assert.equal(U.isSizeGroup('Color', [{ text: 'S' }, { text: 'M' }]), false);
  assert.equal(U.isSizeGroup('', [{ text: 'S' }, { text: 'M' }, { text: 'L' }]), true);
  assert.equal(U.isSizeGroup('', [{ text: 'Black' }, { text: 'White' }]), false);
});

test('remembered options are cleaned before they are stored', () => {
  assert.deepEqual(U.cleanOptions([{ n: ' Color: ', v: '  Black  ' }, { n: 'Size', v: '' }, null, { v: 5 }, { n: 'Size', v: 'L' }]), [{ n: 'Color:', v: 'Black' }, { n: 'Size', v: 'L' }]);
  assert.deepEqual(U.cleanOptions('nope'), []);
  assert.equal(U.cleanOptions(Array.from({ length: 20 }, (_, i) => ({ n: 'g' + i, v: 'v' }))).length, 8);
});

// ------------------------------------------------ choices, in two languages

const rows = (spec) => spec.map(([name, ...texts]) => ({ name, options: texts.map((t) => (typeof t === 'string' ? { text: t } : t)) }));

test('common Chinese option words are translated; nothing else is', () => {
  assert.equal(U.zhHint('黑色'), 'Black');
  assert.equal(U.zhHint('M码'), 'M');
  assert.equal(U.zhHint('2XL码'), '2XL');
  assert.equal(U.zhHint('43码'), '43');
  assert.equal(U.zhHint('Black'), '', 'English is left alone');
  assert.equal(U.zhHint('复古做旧款'), '', 'an unknown word is not guessed at');
  assert.equal(U.zhHint('constructor'), '');
  assert.equal(U.optionLabel('黑色'), '黑色 · Black');
  assert.equal(U.optionLabel('Black'), 'Black');
  assert.equal(U.groupLabel('颜色'), 'Color');
  assert.equal(U.groupLabel('尺寸 衣服'), 'Size');
  assert.equal(U.groupLabel('Colour'), 'Colour');
  assert.equal(U.groupLabel(''), 'Option');
});

test('the choices of a listing are cut to size before they are stored', () => {
  assert.deepEqual(U.cleanChoices([{ n: ' Color ', o: ['Black', ' Black ', '', 5, 'White'] }, { n: 'Empty', o: [] }, null, { o: 'x' }]), [{ n: 'Color', o: ['Black', 'White'] }]);
  assert.equal(U.cleanChoices(Array.from({ length: 10 }, (_, i) => ({ n: 'g' + i, o: ['a'] }))).length, 6);
  assert.equal(U.cleanChoices([{ n: 'x', o: Array.from({ length: 200 }, (_, i) => 'v' + i) }])[0].o.length, 60);
  assert.deepEqual(U.cleanChoices('nope'), []);
});

test('planning a cart: every row needs a reason, and a choice that fits nowhere stops the add', () => {
  const page = rows([['Color', 'black', 'white'], ['Size clothes', 'S code', 'M code', 'L code', 'XL']]);
  // a pick made in Weidian's wording lands on the translated row; the size comes from "My sizes"
  let r = U.planCart(page, { options: [{ n: '颜色', v: '白色' }], size: 'M' });
  assert.deepEqual(r.rows, [{ pick: 1, from: 0 }, { pick: 1, from: 'size' }]);
  assert.deepEqual(r.unused, []);
  // "M码" picked on Weidian is the "M code" the agent shows
  r = U.planCart(page, { options: [{ n: '颜色', v: '黑色' }, { n: '尺寸 衣服', v: 'M码' }] });
  assert.deepEqual(r.rows.map((x) => x.pick), [0, 1]);
  // a word RepHop cannot translate is never guessed: the row is asked for, and the pick is reported as unused
  r = U.planCart(page, { options: [{ n: '颜色', v: '复古做旧款' }], size: 'L' });
  assert.equal(r.rows[0].ask, 'pick Color');
  assert.deepEqual(r.unused, [{ n: '颜色', v: '复古做旧款' }]);
  // with nothing to go on, nothing is settled (whatever the site pre-selected counts for nothing)
  r = U.planCart(page, {});
  assert.deepEqual(r.rows.map((x) => x.ask), ['pick Color', 'pick Size clothes']);
  // a row with one choice needs no decision, but an unused pick still stops the add
  r = U.planCart(rows([['Color', 'black']]), { options: [{ n: '颜色', v: '奶白色定制' }] });
  assert.deepEqual(r.rows, [{ pick: 0, from: 'only' }]);
  assert.equal(r.unused.length, 1);
  // sold out is reported, never swapped for a neighbour
  r = U.planCart(rows([['Size', 'S', { text: 'M', disabled: true }, 'L']]), { size: 'M' });
  assert.equal(r.rows[0].ask, '“M” is sold out');
  // a remembered choice named for a row is looked for in that row only
  r = U.planCart(rows([['Size', '42', '43'], ['Insole', '42', '43']]), { options: [{ n: 'Insole', v: '43' }] });
  assert.deepEqual(r.rows[1], { pick: 1, from: 0 });
  assert.equal(r.rows[0].ask, 'pick Size');
  // a nameless choice that two rows offer is not assigned to either
  r = U.planCart(rows([['A', '42', '43'], ['B', '42', '43']]), { options: [{ n: '', v: '43' }] });
  assert.deepEqual(r.rows.map((x) => x.pick), [undefined, undefined]);
  assert.equal(r.unused.length, 1);
});

// ---------------------------------------------------------------- group hauls

test('a share code carries a list with each item\'s choices, and survives being pasted into a chat', async () => {
  const settings = U.mergeSettings({ sizes: { tops: 'M', shoes: '43, 9.5' } });
  const mine = [
    { key: 'weidian:7237185689', platform: 'weidian', label: 'Triangle tee', price: 310, qty: 2, options: [{ n: 'Color', v: 'black' }], note: 'x'.repeat(500) },
    { key: 'taobao:675330231400', platform: 'taobao', title: 'Dunk Low', price: 199.5, size: '44' },
    { key: 'yupoo:seller/123', platform: 'yupoo', label: 'album only' },
  ];
  const obj = U.packShare('  Sam  ', mine, settings);
  assert.equal(obj.name, 'Sam');
  assert.equal(obj.items.length, 2, 'albums without a buy link are left out');
  const code = await U.encodeShare(obj);
  assert.match(code, /^RH[01]\.[A-Za-z0-9_-]+$/);
  const back = await U.decodeShare('hey, my list:\n' + code + '\nthanks!');
  assert.equal(back.name, 'Sam');
  assert.deepEqual(back.items.map((x) => [x.key, x.title, x.price, x.qty, x.size]), [['weidian:7237185689', 'Triangle tee', 310, 2, 'M'], ['taobao:675330231400', 'Dunk Low', 199.5, 1, '44']]);
  assert.deepEqual(back.items[0].options, [{ n: 'Color', v: 'black' }]);
  assert.equal(back.items[0].note.length, 200);
  assert.equal(back.items[0].url, 'https://weidian.com/item.html?itemID=7237185689', 'links are rebuilt from the product id, never taken from the code');
  // a saved file is the same text; plain JSON is accepted too
  assert.equal((await U.decodeShare(JSON.stringify(obj))).items.length, 2);
});

test('a share code from anywhere is treated as untrusted', async () => {
  assert.equal(await U.decodeShare('just some text'), null);
  assert.equal(await U.decodeShare('RH1.AAAAAAAAAAAA'), null);
  assert.equal(await U.decodeShare('RH0.' + 'A'.repeat(500000)), null, 'oversized');
  assert.equal(await U.decodeShare('{"app":"Other","items":[]}'), null);
  const junk = await U.decodeShare(JSON.stringify({ app: 'RepHop', haul: 1, name: 'x'.repeat(99), items: [
    { k: 'weidian:7111111111', t: '<img src=x onerror=alert(1)>', p: -5, q: 5000, o: [['a'.repeat(99), 'b'.repeat(999)], 'nope', [1, 2]], s: 7, image: 'javascript:alert(1)', url: 'https://evil.example/' },
    { k: 'yupoo:a/1' }, { k: 'nonsense' }, null, 'str',
  ] }));
  assert.equal(junk.name.length, 30);
  assert.equal(junk.items.length, 1);
  const it = junk.items[0];
  assert.equal(it.price, null);
  assert.equal(it.qty, 99);
  assert.equal(it.size, '');
  assert.equal(it.image, undefined);
  assert.equal(it.url, 'https://weidian.com/item.html?itemID=7111111111');
  assert.equal(it.options.length, 1);
  assert.equal(it.options[0].v.length, 80);
  // a bomb: megabytes of zeros that deflate to almost nothing
  const zeros = new Uint8Array(3000000);
  const reader = new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate')).getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...value);
  }
  const b64 = Buffer.from(parts).toString('base64url');
  assert.equal(await U.decodeShare('RH1.' + b64), null, 'a code that unpacks to megabytes is refused');
});

test('who owes what: per-person totals, and shared costs that always add up', () => {
  const people = [
    { id: '', name: 'You', items: [{ price: 100, qty: 1 }, { price: null, qty: 1 }] },
    { id: 'sam', name: 'Sam', items: [{ price: 200, qty: 1 }] },
    { id: 'ali', name: 'Ali', items: [{ price: 50, qty: 2 }] },
  ];
  const rates = { rates: { USD: 0.14 } };
  let t = U.groupTotals(people, rates, 'USD', 10, 'even');
  assert.equal(t.yuan, 400);
  assert.equal(t.items, 56);
  assert.equal(t.total, 66);
  assert.equal(t.count, 5);
  assert.equal(t.unpriced, 1);
  assert.deepEqual(t.rows.map((r) => r.share), [3.34, 3.33, 3.33], 'the odd cent goes to one person, so the shares add up');
  assert.equal(Math.round(t.rows.reduce((a, r) => a + r.share, 0) * 100), 1000);
  assert.deepEqual(t.rows.map((r) => r.owes), [17.34, 31.33, 17.33]);
  t = U.groupTotals(people, rates, 'USD', 10, 'cost');
  assert.deepEqual(t.rows.map((r) => r.share), [2.5, 5, 2.5]);
  // in yuan nothing is converted
  t = U.groupTotals(people, rates, 'CNY', 0, 'even');
  assert.deepEqual(t.rows.map((r) => r.owes), [100, 200, 100]);
  // someone with no items takes no share
  t = U.groupTotals(people.concat({ id: 'x', name: 'Empty', items: [] }), rates, 'USD', 9, 'even');
  assert.deepEqual(t.rows.map((r) => r.share), [3, 3, 3, 0]);
  assert.deepEqual(U.groupTotals([], rates, 'USD', 5, 'even').rows, []);
});

// ------------------------------------------- found by the fourth review

test('a choice you picked before only ever matches the very same choice', () => {
  const o = (...texts) => texts.map((text) => ({ text }));
  assert.equal(U.pickRemembered(o('Blue', 'Black/White'), 'Black'), -1, '"Black" is not "Black/White"');
  assert.equal(U.pickRemembered(o('米白色', '黑色'), '白色'), -1, '白色 is not 米白色');
  assert.equal(U.pickRemembered(o('酒红色'), '红色'), -1);
  assert.equal(U.pickRemembered(o('黑色加绒', '白色'), '黑色'), -1);
  assert.equal(U.pickRemembered(o('black', 'white'), '黑色'), 0, 'the same colour in the other language');
  assert.equal(U.pickRemembered(o('黑色', '白色'), 'White'), 1);
  assert.equal(U.pickRemembered(o('M code', 'L code'), 'M'), 0, 'the same size');
  assert.equal(U.pickRemembered(o('M code', 'L code'), 'M码'), 0);
  assert.equal(U.pickRemembered(o('XL', '2XL'), 'L'), -1);
  assert.equal(U.pickRemembered(o('41', '42.5'), '42'), -1);
  assert.equal(U.pickRemembered(o('  BLACK ', 'White'), 'black'), 0);
  // and so the plan asks instead of putting a different colour in the cart
  const plan = U.planCart([{ name: 'Color', options: o('Blue', 'Black/White') }], { options: [{ n: 'Color', v: 'Black' }] });
  assert.equal(plan.rows[0].ask, '“Black” is not offered here (Color)');
  // a colour typed under Edit is still looked for as a whole word, and Chinese characters count as letters
  assert.equal(U.pickOption(o('米白色', '黑色'), '白色', true), -1);
  assert.equal(U.pickOption(o('Blue', 'Black/White'), 'black', true), 1);
});

test('odd keys are not products', () => {
  for (const key of ['constructor:1234567', '__proto__:1234567', 'toString:1234567', 'hasOwnProperty:1']) assert.equal(L.keyToItem(key), null, key);
  assert.equal(U.sharedItem({ k: 'constructor:1234567' }), null);
});

test('a share says which copy of RepHop made it, and never carries a picture', async () => {
  const obj = U.packShare('Sam', [{ key: 'weidian:7111111111', platform: 'weidian', title: 'Tee', image: 'https://si.geilicdn.com/x.jpg' }], U.mergeSettings(), 'abc123def456');
  assert.equal(obj.sid, 'abc123def456');
  assert.equal((await U.decodeShare(await U.encodeShare(obj))).sid, 'abc123def456');
  assert.equal(U.packShare('Sam', [], U.mergeSettings(), '<script>').sid, undefined);
  assert.equal(U.unpackShare({ app: 'RepHop', haul: 1, name: 'x', sid: '../../etc', items: [] }).sid, '');
  assert.equal(U.sharedItem({ k: 'weidian:7111111111', image: 'https://tracker.example/p.gif' }).image, undefined);
});

test('what people owe adds up to the total shown, to the cent', () => {
  const rates = { rates: { USD: 0.1403 } };
  for (let n = 1; n <= 6; n++) {
    for (const split of ['even', 'cost']) {
      const people = Array.from({ length: n }, (_, i) => ({ id: String(i), name: 'P' + i, items: [{ price: 10 + i * 3.33, qty: 1 + (i % 2) }] }));
      const t = U.groupTotals(people, rates, 'USD', 10, split);
      const owed = Math.round(t.rows.reduce((a, r) => a + r.owes, 0) * 100);
      assert.equal(owed, Math.round(t.total * 100), n + ' people, ' + split);
    }
  }
});

// ----------------------------------- seen on the live Superbuy listing

test('a choice made in the seller\'s wording is found by its place on the agent\'s translated listing', () => {
  const g = (name, ...texts) => ({ name, options: texts.map((text) => ({ text })) });
  // Weidian item 7870660857 as Weidian lists it, and as Superbuy showed it on 2026-10-13
  const seller = [{ n: '颜色', o: ['黑色', '藏蓝色', '灰色'] }, { n: '尺码', o: ['S', 'M', 'L', 'XL'] }];
  const page = [g('Color', 'black', 'Dark blue', 'gray'), g('Size', 'S', 'M', 'L', 'XL')];
  // 藏蓝色 is not a word RepHop translates; it is the second colour there and the second colour here
  let r = U.planCart(page, { options: [{ n: '颜色', v: '藏蓝色' }], size: 'L', source: seller });
  assert.deepEqual(r.rows, [{ pick: 1, from: 0 }, { pick: 2, from: 'size' }]);
  assert.deepEqual(r.unused, []);
  // "grey" in the dictionary is "gray" on the page
  r = U.planCart(page, { options: [{ n: '颜色', v: '灰色' }, { n: '尺码', v: 'M' }] });
  assert.deepEqual(r.rows.map((x) => x.pick), [2, 1]);
  // without the seller's rows nothing is assumed
  r = U.planCart(page, { options: [{ n: '颜色', v: '藏蓝色' }], size: 'L' });
  assert.equal(r.rows[0].ask, 'pick Color');
  // the agent shows the colours in another order: the readable ones are in the wrong places, so RepHop asks
  r = U.planCart([g('Color', 'gray', 'Dark blue', 'black'), page[1]], { options: [{ n: '颜色', v: '藏蓝色' }], source: seller });
  assert.equal(r.rows[0].ask, 'pick Color');
  // one colour fewer on the agent's listing: not the same row
  r = U.planCart([g('Color', 'black', 'gray'), page[1]], { options: [{ n: '颜色', v: '藏蓝色' }], source: seller });
  assert.equal(r.rows[0].ask, 'pick Color');
  // nothing readable and a row name that does not translate: no anchor, so RepHop asks
  r = U.planCart([g('Version', 'A', 'B', 'C')], { options: [{ n: '批次', v: '二批' }], source: [{ n: '批次', o: ['一批', '二批', '三批'] }] });
  assert.equal(r.rows[0].ask, 'pick Version');
  // nothing readable, but the row's name translates to this row's name
  r = U.planCart([g('Color', 'Retro', 'Aged', 'Washed')], { options: [{ n: '颜色', v: '做旧' }], source: [{ n: '颜色', o: ['复古', '做旧', '水洗'] }] });
  assert.deepEqual(r.rows, [{ pick: 1, from: 0 }]);
  // two rows of the same length that both fit: not decided
  r = U.planCart([g('Color', 'Retro', 'Aged'), g('Color', 'One', 'Two')], { options: [{ n: '颜色', v: '做旧' }], source: [{ n: '颜色', o: ['复古', '做旧'] }] });
  assert.equal(r.unused.length, 1);
  // a sold-out choice found by its place is still reported, not replaced
  r = U.planCart([{ name: 'Color', options: [{ text: 'black' }, { text: 'Dark blue', disabled: true }, { text: 'gray' }] }], { options: [{ n: '颜色', v: '藏蓝色' }], source: seller });
  assert.equal(r.rows[0].ask, '“Dark blue” is sold out');
});

test('every part of RepHop knows which build it is', () => {
  assert.match(U.BUILD, /^\d+\.\d+\.\d+$/);
  assert.equal(U.BUILD, require('../manifest.json').version, 'the build in the code is the version in the manifest');
});

// ------------------------------------------------------------ live hauls

const V = require('../lib/live.js');

test('an invite carries where the haul is and the key to read it, and survives a chat message', () => {
  const live = { relay: 'https://rephop-relay.example.workers.dev', room: V.rand(16), key: V.rand(32), secret: V.rand(24), name: '  Ahmed ' };
  const invite = V.makeInvite(live);
  assert.match(invite, /^RHL1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(V.readInvite('yo, join my haul:\n' + invite + '\nsee you'), { relay: live.relay, room: live.room, key: live.key, name: 'Ahmed' });
  assert.ok(!Buffer.from(invite.slice(5), 'base64url').toString().includes(live.secret), 'the host\'s own secret never travels');
  // things that are not invites
  assert.equal(V.readInvite('hello'), null);
  assert.equal(V.readInvite('RHL1.' + Buffer.from('{"u":"http://evil.example","r":"' + live.room + '","k":"' + live.key + '"}').toString('base64url')), null, 'plain http is refused');
  assert.equal(V.readInvite('RHL1.' + Buffer.from('{"u":"javascript:alert(1)","r":"' + live.room + '","k":"' + live.key + '"}').toString('base64url')), null);
  assert.equal(V.readInvite('RHL1.' + Buffer.from('{"u":"https://ok.example","r":"../../x","k":"' + live.key + '"}').toString('base64url')), null, 'a room id is letters and digits');
  assert.equal(V.readInvite('RHL1.' + Buffer.from('{"u":"https://ok.example","r":"' + live.room + '","k":"short"}').toString('base64url')), null);
  assert.equal(V.readInvite('RHL1.' + 'A'.repeat(60)), null);
});

test('a relay address is https (or this computer, for tests) and nothing else', () => {
  assert.equal(V.relayUrl(' https://rephop-relay.me.workers.dev/ '), 'https://rephop-relay.me.workers.dev');
  assert.equal(V.relayUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  for (const bad of ['http://example.com', 'ftp://x.y', 'javascript:alert(1)', 'https://user:pass@x.y', 'https://x.y/?a=1', 'not a url', '']) assert.equal(V.relayUrl(bad), '', bad);
});

test('what leaves the browser is sealed: only the haul\'s key opens it, and only in its own slot', async () => {
  const live = { room: V.rand(16) };
  const key = V.rand(32);
  const list = U.packShare('Sam', [{ key: 'weidian:7237185689', platform: 'weidian', label: 'Triangle tee', price: 310, options: [{ n: 'Color', v: 'black' }] }], U.mergeSettings());
  const blob = await V.seal(key, V.about(live, 'member-one', 'list'), list);
  assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!/Sam|Triangle|weidian|7237185689|black/.test(blob), 'nothing readable in it');
  assert.deepEqual((await V.open(key, V.about(live, 'member-one', 'list'), blob)).items, list.items);
  assert.equal(await V.open(V.rand(32), V.about(live, 'member-one', 'list'), blob), null, 'another key');
  assert.equal(await V.open(key, V.about(live, 'member-two', 'list'), blob), null, 'another member\'s slot');
  assert.equal(await V.open(key, V.about(live, 'member-one', 'inbox'), blob), null, 'another kind of slot');
  assert.equal(await V.open(key, V.about({ room: V.rand(16) }, 'member-one', 'list'), blob), null, 'another room');
  const bent = blob.slice(0, -3) + (blob.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.equal(await V.open(key, V.about(live, 'member-one', 'list'), bent), null, 'altered on the way');
  assert.equal(await V.open(key, V.about(live, 'member-one', 'list'), 'garbage'), null);
  // sealing the same thing twice never gives the same bytes
  assert.notEqual(await V.seal(key, 'x', { a: 1 }), await V.seal(key, 'x', { a: 1 }));
  assert.equal((await V.sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the built-in relay is a proper relay address', () => {
  assert.equal(V.relayUrl(U.DEFAULT_RELAY), U.DEFAULT_RELAY);
  assert.match(U.DEFAULT_RELAY, /^https:\/\//);
  assert.equal(U.mergeSettings().relay, '', 'your own relay is empty until you enter one');
});
