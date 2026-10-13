# RepHop

Click a Weidian, Taobao, 1688 or Yupoo link on Reddit and land on the listing at your shopping agent. Save finds to a list instead of juggling tabs, then have them added to your cart.

No copying, no pasting, and one tab that gets reused instead of a new tab per link.

## Install (unpacked)

1. Open `chrome://extensions` (also works in Edge and Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `rephop` folder.
4. Pin the ⚡ icon. Clicking it opens your list in the side panel.
5. **Pick your shopping agent.** RepHop does not assume one. The list asks at the top, and so does the first link you click.

Requires Chrome 116 or newer. Stay signed in to your agent: Superbuy, for one, only shows a listing when you are logged in.

## What it does

**On Reddit (and Yupoo, Google Sheets, any site you add)**

| You do | You get |
| --- | --- |
| Click a product link | The listing opens at your agent, in one reused tab |
| Ctrl+click or middle-click | The listing opens in a background tab |
| Alt+click | The item is saved to your list |
| Shift+click | The original link, untouched |
| Hover a link (or focus it with Tab), press `S` / `A` / `Q` / `O` | Open at your agent / save / QC photos / original link |
| Hover or focus a link | A card with the picture, name and price |
| Click `Save all N links` in the corner | Every link on the page is saved, plus the comments Reddit has not put on screen yet |

Each link also gets a small `⚡ | +` button: the left half opens, the right half saves. On a link you already saved, the right half shows a green check; clicking it offers "Open list" or "Remove" rather than deleting straight away.

Only your own clicks and key presses count. The hotkeys act on a link your mouse has actually moved onto, or one you reached with the keyboard; a link that slides under a resting cursor while you scroll does nothing, and neither does a click made by a page script.

**The reused tab** is only reused while it still shows a listing. If you have moved on in it (cart, checkout, another site), RepHop leaves it alone and opens a fresh one.

**Links it understands**

- Weidian, Taobao, Tmall and 1688 item links, in desktop and mobile forms.
- Yupoo albums. RepHop reads the album and uses the Weidian or Taobao link in the description. Albums with no link are saved as albums.
- Other agents' links, converted to the real product: Superbuy, AllChinaBuy, CNFans, Mulebuy, Kakobuy, Hoobuy, ACBuy, OOPBuy, Joyabuy, OrientDig, LoveGoBuy, Sugargoo, CSSBuy, Hagobuy, Basetao, Pandabuy and others that carry the product link in `?url=`.
- Short share links (`k.youshop10.com`, `m.tb.cn`, `qr.1688.com`, `ikako.vip`).
- Links posted as plain text, a bare `itemID=1234567890`, and links that are only a picture.
- Reddit and Google redirect wrappers.

**The list (side panel)**

- Thumbnail, name, price in yuan and your currency, where you found it, with a link back to the post or comment.
- The same product reached through three different links is stored once.
- Folders, tags, notes, quantity, in-cart and bought status, search, sort and filters, and a running total.
- **Delete quickly:** the × on a card deletes it (with Undo). **Select all**, then **Delete**, clears a folder or the whole list.
- **Go through:** opens your items one at a time in a single tab, with Next / Previous on the page (`]` and `[`).
- **Add to cart** (see below).
- Check availability: Weidian items that sold out or were removed, and Yupoo albums that were deleted.
- QC photo lookup, trusted sellers (gold outline on their links), "seen in N posts" counter.
- Export CSV, copy as text or Reddit markdown, JSON backup and restore.
- Optional sync between your computers through the browser's own sync.
- Dark by default; the sun button in the corner switches to light.

**Already on your agent's site?**

A listing there has a **Save to RepHop** button in the corner bar. So does a right-click on the page, `Alt+Shift+K`, and a strip at the top of the list. Saving with the corner button or the strip also remembers any colour or size you clicked on the listing (not the ones the site had pre-selected).

## Add to cart for me

Select items in the list and press **Add to cart**. RepHop opens each one at your agent in turn.

**On Superbuy and AllChinaBuy** it sets the options, presses Add To Cart once, and waits for the site to confirm before moving on. To choose, it uses in this order:

1. What you added to your cart from that listing before, or clicked on it before saving.
2. The size or colour written on the item (**Edit** on its card).
3. Your sizes under **Settings → My sizes** (shoes, tops, bottoms, belts, hats). The item's type is worked out from its name and can be set by hand.
4. If a row has only one choice at all, that one.

It only ever picks something it has a reason to pick. The site pre-selects a colour and size on every listing; RepHop ignores that. If a choice is sold out or not offered, or RepHop has nothing to go on for a row, it presses nothing: it tells you what is open on that listing and carries on once you have added it yourself (or skipped it). It never swaps a sold-out size for a neighbouring one. If the site says nothing after the press, RepHop asks whether it went in rather than assume. It acts only in the tab the run opened, presses Add To Cart at most once per item per run, and never presses Buy Now. Quantities above 1 are set here too (up to 20).

**On the other agents** RepHop does not pick or press anything. It opens each listing in turn; you choose and add, and RepHop marks the item and moves on.

At the end it reports how many it added, how many you added, and how many were skipped. Nothing is ever paid for; items only go into your cart.

How far to trust it: the class names it reads on Superbuy were checked against the live listing page (the rows of choices, the pre-selection, the Add To Cart button). What has not been observed is what Superbuy shows after a successful add, because nobody pressed the button on a live listing while building this. RepHop looks for the usual success message; if Superbuy words it differently you will get the "is it in your cart?" question after each press. Everything else was tested on a stand-in page built to match the live markup.

## Google Sheets

In the normal spreadsheet view the corner bar offers "Grab links from this tab", "All tabs" and "Clickable view". The clickable view opens Google's plain HTML version of the sheet, where every link gets its own open and save buttons.

## Everywhere else

- Right-click a product link, a text selection or the page for the same actions on any website.
- Browser shortcuts (change them at `chrome://extensions/shortcuts`):
  - `Alt+Shift+L` open the list
  - `Alt+Shift+S` open the product on the current page at your agent
  - `Alt+Shift+K` save the product on the current page
  - `Alt+Shift+G` save every rep link on the current page

## Settings worth knowing

- **Shopping agent**: Superbuy, AllChinaBuy, CNFans, Mulebuy, Kakobuy, Hoobuy and ACBuy are built in, or enter your own link template. None is preselected.
- **Open listings in**: one reused tab (default), a reused side window, a tab group, or a new tab each time.
- **Jump to the listing when it opens**: turn off to stay on Reddit while listings load behind you.
- Every click and hotkey behaviour can be switched off, and the hotkeys can be remapped.
- **Theme**: dark, light, or match your computer.
- **Privacy and clean-up**: clear the history RepHop keeps (see below) or delete the whole list.

## Privacy

RepHop has no server, no account and no analytics. Everything it stores stays in your browser.

What it stores locally:

- Your list (items, folders, tags, notes, the options you picked), your sizes and your settings.
- A history: which product links you opened, which Reddit posts each link appeared in (post ids only, used for the "seen in N posts" counter), and previews it has already looked up. **Settings → Clear that history** removes all of it.

What a website can see: that RepHop's buttons are on its page, and which links it recognised. It cannot read which links you saved, viewed or trusted: the buttons, the hover card and the messages are drawn in closed shadow roots, and no button changes size with that state.

Network requests the extension makes itself:

| To | When | Why |
| --- | --- | --- |
| `thor.weidian.com` | You hover, open or save a Weidian link, or check availability | Name, price, picture, stock |
| `weidian.com` item page | A little after you save a Weidian item, and when you open or save a `k.youshop10.com` short link. One at a time, spaced out, capped per session, and paused for 30 minutes if Weidian refuses | The shop (for trusted sellers) and Weidian's translated name; where a short link leads |
| `*.yupoo.com` | You hover, open or save a Yupoo album | Find the buy link, title and cover |
| `si.geilicdn.com`, `photo.yupoo.com` | A thumbnail is shown | Product pictures (small versions) |
| `m.tb.cn`, `qr.1688.com`, `ikako.vip` | You open or save one of these short links | Follow it to the product |
| `reddit.com` (the thread's own JSON) | You press "Save all" on a post | Comments not yet on screen |
| `docs.google.com` (the sheet's HTML view) | You press a "Grab links" button on a sheet | Read the links |
| `open.er-api.com` | Twice a day | Yuan exchange rate. [Rates By Exchange Rate API](https://www.exchangerate-api.com) |

A short link is never followed just to show a hover preview, including one found in a Yupoo album's description. Sync, if you turn it on, goes through your browser account's own extension sync and nowhere else.

See [PRIVACY.md](PRIVACY.md) for the same information as a standalone policy.

## Permissions, and why

| Permission | Reason |
| --- | --- |
| Reddit, Yupoo, Google Sheets | Find links on the page and add the buttons |
| Weidian, Taobao, Tmall, 1688 | Show the "open at your agent / save" bar on product pages; read Weidian previews; follow short links |
| Superbuy, AllChinaBuy, CNFans, Mulebuy, Kakobuy, Hoobuy, ACBuy (the agents you can pick) | Save from a listing, queue controls, add-to-cart help; check that the reused tab still shows a listing before reusing it |
| `storage` | Your list and settings |
| `sidePanel` | The list |
| `contextMenus`, `activeTab`, `scripting` | Right-click actions and "grab this page" on sites RepHop does not normally run on |
| `tabGroups` | The "tab group" opening mode |
| `declarativeNetRequestWithHostAccess` | Two header rules: one so Weidian's item API answers the extension, one so Yupoo serves album pictures as thumbnails. They apply to those two hosts only |
| `alarms` | Exchange rate refresh and delayed sync |
| Optional: any site you add under **More sites**, or a custom agent's site | Run the same buttons there. Asked for one site at a time, only when you add it |

## Limits

- **Superbuy's listing page was read, but never clicked.** The layout RepHop relies on (name, price, rows of choices, Add To Cart button) was checked against the live page. What Superbuy shows after a successful Add To Cart was not observed, so that part rests on the usual success message; when it is not recognised RepHop asks you. Opening, saving and the queue do not depend on any of this.
- **Reddit was tested on saved copies**, not on the live site: a hand-built page in Reddit's structure, plus archived copies of real r/FashionReps threads (new Reddit, with Reddit's own inline stylesheet). Reddit blocks automated browsers, so the live site itself was not driven.
- Taobao and 1688 have no public preview API. Their name, price and picture fill in after you open the listing once. Availability checks cover Weidian and Yupoo only.
- A Yupoo album only resolves if the seller put a Weidian, Taobao or 1688 link on it.
- "Save all" gets the comments Reddit hands over in one request (about 500). On bigger threads the message tells you how many were left out; expand them on the page and save again.
- The shop of a Weidian item (needed for "trusted seller") is looked up slowly, by design, and only for saved items.
- Browser sync holds roughly 100 KB. Names are synced up to 80 characters and notes up to 200; longer text stays complete on the device where you wrote it. With several hundred items the oldest ones stop syncing, and the settings page says how many.
- The buttons and cards on web pages are always dark; the light theme applies to the list.
- QC links point at third-party QC sites. If one changes its address format, pick another under Settings or enter a custom template.
- The agents' link formats are the publicly known ones and, apart from Superbuy's, were not individually verified. If one changes, use the custom template.

## Development

No build step. Everything is plain JavaScript.

```bash
node --test tests/links.test.js tests/util.test.js
```

The end-to-end suite loads the unpacked extension in a real Chrome (needs a network; about eight minutes):

```bash
cd tests/e2e && npm install && node run.js
```

Add `--shots <folder>` for screenshots, and `--real <folder>` to also run it against saved copies of real Reddit thread pages (`.html` files).

```
manifest.json
background.js        service worker: storage, tabs, network, sync, menus, shortcuts, the queue
lib/links.js         link parsing and URL building (pure, unit-tested)
lib/util.js          formatting, export, sync packing, page readers, option matching (pure, unit-tested)
content/main.js      buttons, click and hotkey handling, hover card, corner bar, add-to-cart help
panel/               the list, paste box, settings and help
tests/               node:test suites, and tests/e2e for the browser run
```

**Publishing to the Chrome Web Store:** zip the folder without `tests/`, `README.md`, `PRIVACY.md` and `LICENSE`. The store will ask for a justification of each permission (the table above) and a privacy policy (PRIVACY.md). Store policy on listings that mention third-party brands or replica goods is the publisher's to check.

## License

MIT. See [LICENSE](LICENSE).
