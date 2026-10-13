/*
 * Live group hauls, end to end: the real extension in a real browser on one side, and on the other a
 * friend played by this script with the extension's own code (lib/live.js), both talking through a
 * relay. Run a relay first (in the relay project: `npm run dev`), then:
 *
 *   node tests/e2e/live.js [--relay http://127.0.0.1:8787 | --default] [--shots <folder>]
 *
 * First the browser hosts a haul and the script joins it; then the script hosts and the browser joins.
 */
const path = require('path');
const puppeteer = require('puppeteer-core');
const U = require('../../lib/util.js');
const V = require('../../lib/live.js');

const EXT = path.resolve(__dirname, '..', '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
// --default: use the relay built into the extension, with nothing entered in Settings.
const BUILT_IN = process.argv.includes('--default');
const RELAY = BUILT_IN ? U.DEFAULT_RELAY : arg('--relay', 'http://127.0.0.1:8787');
const SHOTS = arg('--shots', '');
const CHROME = process.env.CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}
async function until(fn, ms, step) {
  const end = Date.now() + (ms || 5000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step || 250);
  }
}

(async () => {
  const up = await fetch(RELAY + '/').then((r) => r.json()).catch(() => null);
  if (!up || up.service !== 'rephop-relay') throw new Error('no relay at ' + RELAY + ' (start one with `npm run dev` in the relay project)');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, enableExtensions: true, args: ['--no-first-run', '--window-size=500,1000'], defaultViewport: { width: 460, height: 1000 } });
  const extId = await browser.installExtension(EXT);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId), { timeout: 15000 });
  const sw = await swTarget.worker();
  const group = async () => (await sw.evaluate(() => chrome.storage.local.get('group'))).group || {};
  await sleep(1200);
  for (const p of await browser.pages()) if (p.url().includes('panel.html')) await p.close();

  // The browser's own list: three items, one already bought (which is never shared).
  await sw.evaluate(async (relay) => {
    await handlers.settings({ patch: { agent: 'superbuy', setupDone: true, relay, sizes: { shoes: '', tops: 'L', bottoms: '', belts: '', hats: '' } } });
    await saveEntries([
      { url: 'https://weidian.com/item.html?itemID=7411111111', label: 'Grey hoodie' },
      { url: 'https://item.taobao.com/item.htm?id=741111111112', label: 'Cargo pants' },
      { url: 'https://weidian.com/item.html?itemID=7411111113', label: 'Old tee' },
    ]);
    await updateItems(['weidian:7411111111'], { price: 120, options: [{ n: 'Color', v: 'Grey' }] });
    await updateItems(['taobao:741111111112'], { price: 80, qty: 2 });
    await updateItems(['weidian:7411111113'], { price: 30, status: 'bought' });
  }, BUILT_IN ? '' : RELAY);

  const panel = await browser.newPage();
  await panel.goto('chrome-extension://' + extId + '/panel/panel.html?view=group', { waitUntil: 'domcontentloaded' });
  await sleep(1000);
  await panel.evaluate(() => { navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  const liveBox = () => panel.evaluate(() => ({
    none: !document.getElementById('live-none').hidden, host: !document.getElementById('live-host').hidden, member: !document.getElementById('live-member').hidden,
    hostText: document.getElementById('live-host-text').textContent, members: Array.from(document.querySelectorAll('#live-members li')).map((li) => li.textContent),
    memberText: document.getElementById('live-member-text').textContent, note: document.getElementById('live-note').textContent,
    people: Array.from(document.querySelectorAll('#g-people .g-person')).map((sec) => sec.querySelector('.g-head b').textContent + (sec.querySelector('.g-head .badge.good') ? ' [live]' : '') + ': ' + Array.from(sec.querySelectorAll('.item')).map((li) => li.querySelector('.title').textContent + (li.querySelector('.badge.picked') ? ' (' + li.querySelector('.badge.picked').textContent + ')' : '') + (li.querySelector('.acts .on') ? ' ✓' : '')).join(', ')),
    rows: Array.from(document.querySelectorAll('#g-rows tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent).join(' | ')),
    toasts: Array.from(document.querySelectorAll('#toasts .toast span')).map((x) => x.textContent),
  }));

  // ================================================= 1. the browser hosts
  await panel.click('#live-start');
  await sleep(500);
  check('starting a live haul asks for your name first', /Type your name first/.test((await liveBox()).toasts.join(' ')) && !(await group()).live);
  await panel.type('#live-name', 'Ahmed');
  await panel.click('#live-start');
  const hosting = await until(async () => { const g = await group(); return g.live && g.live.role === 'host' ? g.live : null; }, 8000);
  const invite = await until(() => panel.evaluate(() => window.__copied || ''), 4000);
  const inv = V.readInvite('yo join my haul ' + invite);
  check('Start creates a room on the relay and copies an invite that names the host and the relay, and nothing else readable', !!hosting && !!inv && inv.relay === RELAY && inv.name === 'Ahmed' && inv.room === hosting.room && inv.key === hosting.key && /^RHL1\.[A-Za-z0-9_-]+$/.test(invite), { invite: invite && invite.slice(0, 30) });
  check('the host\'s secret is not in the invite', !!hosting && !Buffer.from(invite.slice(5), 'base64url').toString().includes(hosting.secret));

  // A friend ("Sam"), played with the extension's own code.
  const sam = { role: 'member', relay: inv.relay, room: inv.room, key: inv.key, mid: V.rand(12), secret: V.rand(24), name: 'Sam' };
  let r = await V.call(sam, 'join', { auth: false, body: { id: sam.mid, hash: await V.sha256(sam.secret), hello: await V.seal(sam.key, V.about(sam, sam.mid, 'hello'), { name: 'Sam' }) } });
  check('a friend with the invite can ask to join', r.ok && r.status === 'pending', r);
  const asked = await until(async () => { const b = await liveBox(); return b.members.some((x) => /Sam wants to join/.test(x)) ? b : null; }, 6000);
  check('the host sees "Sam wants to join" by itself, within moments', !!asked, await liveBox());
  r = await V.call(sam, 'list', { method: 'PUT', body: { blob: await V.seal(sam.key, V.about(sam, sam.mid, 'list'), U.packShare('Sam', [], U.mergeSettings())) } });
  check('until the host lets them in, the relay takes no list from them', r.http === 403, r);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'live-request.png'), fullPage: true });
  await panel.evaluate(() => Array.from(document.querySelectorAll('#live-members li button')).find((b) => b.textContent === 'Let in').click());
  check('the host lets Sam in', await until(async () => (await V.call(sam, 'state', { method: 'GET' })).status === 'ok', 6000));

  const samList = (items) => V.seal(sam.key, V.about(sam, sam.mid, 'list'), { app: 'RepHop', haul: 1, name: 'Sam', at: Date.now(), items });
  r = await V.call(sam, 'list', { method: 'PUT', body: { blob: await samList([{ k: 'weidian:7422222221', t: 'Sam hoodie', p: 100, q: 2, o: [['Color', 'Black']], s: 'XL' }]) } });
  const arrived = await until(async () => { const b = await liveBox(); return b.people.some((x) => /^Sam \[live\]: Sam hoodie \(Black · size XL\)/.test(x)) ? b : null; }, 8000);
  check('Sam\'s list shows up on the host\'s screen by itself, marked live, with Sam\'s choices', r.ok && !!arrived, await liveBox());
  check('and the haul adds up: a row for the host and a row for Sam', !!arrived && arrived.rows.length === 2 && /^Ahmed \(you\)/.test(arrived.rows[0]) && /^Sam.*¥200/.test(arrived.rows[1]), arrived && arrived.rows);
  await sleep(600);
  r = await V.call(sam, 'list', { method: 'PUT', body: { blob: await samList([{ k: 'weidian:7422222221', t: 'Sam hoodie', p: 100, q: 2, o: [['Color', 'Black']], s: 'XL' }, { k: 'taobao:742222222223', t: 'Sam cap', p: 40 }]) } });
  const grown = await until(async () => { const b = await liveBox(); return b.people.some((x) => /Sam cap/.test(x)) ? b : null; }, 8000);
  check('a change on Sam\'s side follows a moment later', r.ok && !!grown, (await liveBox()).people);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'live-host.png'), fullPage: true });

  // What reaches the relay is unreadable there, and a blob moved to another slot does not open.
  const hostView = await V.call({ role: 'host', relay: RELAY, room: hosting.room, secret: hosting.secret }, 'state', { method: 'GET' });
  const stored = hostView.members && hostView.members[0] && hostView.members[0].list;
  check('what the relay holds is ciphertext: no name, no link, no item text', !!stored && !/Sam|hoodie|weidian|7422222221/i.test(JSON.stringify(hostView)), hostView.members && hostView.members.map((m) => (m.list || '').slice(0, 24)));
  check('the right key opens it; a wrong key or a different slot does not', !!(await V.open(inv.key, V.about(sam, sam.mid, 'list'), stored)) && !(await V.open(V.rand(32), V.about(sam, sam.mid, 'list'), stored)) && !(await V.open(inv.key, V.about(sam, sam.mid, 'inbox'), stored)) && !(await V.open(inv.key, V.about(sam, 'someoneelse', 'list'), stored)));

  // The host marks one of Sam's items as in the cart and adds shipping: Sam is told, and only Sam.
  await sw.evaluate(async () => {
    const g = (await chrome.storage.local.get('group')).group;
    const p = g.people.find((x) => x.live);
    await handlers.group({ op: 'mark', id: p.id, uid: p.items[0].uid, status: 'carted' });
    await handlers.group({ op: 'set', patch: { extra: 10 } });
  });
  const told = await until(async () => {
    const st = await V.call(sam, 'state', { method: 'GET' });
    const note = st.inbox ? await V.open(sam.key, V.about(sam, sam.mid, 'inbox'), st.inbox) : null;
    return note && note.marks && note.marks.some((m) => m[1] === 'carted') && note.extra === 10 ? note : null;
  }, 10000, 500);
  check('Sam is told what is in the cart and what they owe (items, their share of shipping, the sum)', !!told && told.host === 'Ahmed' && told.marks.length === 2 && told.marks[0][1] === 'carted' && told.marks[1][1] === 'saved' && told.yuan === 240 && told.share === 5 && Math.abs(told.owes - (told.items + 5)) < 0.001 && told.people === 2, told);
  check('the note says nothing about anyone else\'s items', !!told && !/Grey hoodie|Cargo pants|7411111111/.test(JSON.stringify(told)));

  r = await V.call(sam, 'leave');
  const left = await until(async () => { const b = await liveBox(); return !b.people.some((x) => /^Sam/.test(x)) && /Nobody has joined yet/.test(b.hostText) ? b : null; }, 8000);
  check('when Sam leaves, their list disappears from the host\'s screen', r.ok && !!left, { mid: sam.mid, people: ((await group()).people || []).map((p) => [p.id, p.live, p.items.length]), members: ((await group()).live || {}).members });

  // a stranger who only guesses at things
  const stranger = { role: 'member', relay: RELAY, room: hosting.room, mid: sam.mid, secret: V.rand(24) };
  check('someone without the right secret gets nothing from the room', (await V.call(stranger, 'state', { method: 'GET' })).http === 401 && (await V.call({ role: 'host', relay: RELAY, room: hosting.room, secret: 'guess' }, 'state', { method: 'GET' })).http === 401);

  await panel.click('#live-end');
  await sleep(200);
  await panel.click('#live-end');
  check('End live haul closes the room on the relay and here', (await until(async () => !(await group()).live, 6000)) && (await V.call({ role: 'host', relay: RELAY, room: hosting.room, secret: hosting.secret }, 'state', { method: 'GET' })).http === 404);

  // ================================================= 2. the browser joins
  const nadia = { role: 'host', relay: RELAY, room: V.rand(16), key: V.rand(32), secret: V.rand(24), name: 'Nadia' };
  await V.call(nadia, 'create', { auth: false, body: { hostHash: await V.sha256(nadia.secret) } });
  await panel.click('#live-join-open');
  await panel.type('#live-code', 'hey, join: ' + V.makeInvite(nadia));
  await sleep(300);
  const info = await panel.evaluate(() => document.getElementById('live-join-info').textContent);
  check('pasting an invite says whose haul it is and which relay passes it along, before anything is sent', /Nadia’s haul/.test(info) && info.includes(new URL(RELAY).host), info);
  check('nothing has reached the relay yet', (await V.call(nadia, 'state', { method: 'GET' })).members.length === 0);
  await panel.click('#live-join');
  const pending = await until(async () => { const st = await V.call(nadia, 'state', { method: 'GET' }); return st.members && st.members.length ? st.members[0] : null; }, 8000);
  const hello = pending ? await V.open(nadia.key, V.about(nadia, pending.id, 'hello'), pending.hello) : null;
  check('asking to join sends the name and nothing else: no list while waiting', !!pending && pending.status === 'pending' && !!hello && hello.name === 'Ahmed' && pending.list === null, pending && { status: pending.status, list: pending.list, hello });
  const waiting = await liveBox();
  check('the friend\'s screen says it is waiting, and that only the name was sent', waiting.member && /Waiting for Nadia/.test(waiting.memberText) && /Only your name/.test(waiting.memberText), waiting.memberText);
  r = await V.call(nadia, 'approve', { body: { id: pending.id, ok: true } });
  const shared = await until(async () => {
    const st = await V.call(nadia, 'state', { method: 'GET' });
    const m = st.members && st.members[0];
    return m && m.list ? U.unpackShare(await V.open(nadia.key, V.about(nadia, m.id, 'list'), m.list)) : null;
  }, 10000, 500);
  check('once let in, the browser shares its list by itself: what is not bought, with choices, quantity and its own size', r.ok && !!shared && shared.name === 'Ahmed' && shared.items.length === 2 && !shared.items.some((x) => x.key === 'weidian:7411111113') &&
    shared.items.some((x) => x.key === 'weidian:7411111111' && x.options[0].v === 'Grey' && x.size === 'L') && shared.items.some((x) => x.key === 'taobao:741111111112' && x.qty === 2), shared);
  // a change in the browser's list goes out without anyone pressing anything
  await sw.evaluate(() => updateItems(['taobao:741111111112'], { qty: 3 }));
  const changed = await until(async () => {
    const st = await V.call(nadia, 'state', { method: 'GET' });
    const m = st.members && st.members[0];
    const list = m && m.list ? U.unpackShare(await V.open(nadia.key, V.about(nadia, m.id, 'list'), m.list)) : null;
    return list && list.items.some((x) => x.key === 'taobao:741111111112' && x.qty === 3) ? list : null;
  }, 10000, 500);
  check('a change made in the list (quantity 2 to 3) reaches the host by itself', !!changed);
  // the host's note arrives and is shown
  const note = { host: 'Nadia', cur: 'USD', marks: [['weidian:7411111111', 'carted', 1], ['taobao:741111111112', 'saved', 3]], yuan: 360, items: 50.4, share: 4, owes: 54.4, extra: 12, split: 'even', people: 3, at: Date.now() };
  await V.call(nadia, 'inbox', { method: 'PUT', body: { id: pending.id, blob: await V.seal(nadia.key, V.about(nadia, pending.id, 'inbox'), note) } });
  const shown = await until(async () => { const b = await liveBox(); return /In Nadia’s cart: 1 of 2/.test(b.note) ? b : null; }, 8000);
  check('the friend sees, live, what is in the host\'s cart and what they owe', !!shown && /Your part: ¥360/.test(shown.note) && /\$54\.40/.test(shown.note), (await liveBox()).note);
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, 'live-member.png'), fullPage: true });
  // the host ends the haul
  await V.call(nadia, 'close');
  const ended = await until(async () => { const b = await liveBox(); return /has ended/.test(b.memberText) ? b : null; }, 8000);
  check('when the host ends the haul, the friend\'s screen says so and nothing more is shared', !!ended && (await group()).live.status === 'gone', (await liveBox()).memberText);
  await panel.click('#live-leave');
  check('and one click clears it', await until(async () => !(await group()).live, 4000));

  const failed = results.filter((x) => !x.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('live test crashed:', e);
  process.exit(3);
});
