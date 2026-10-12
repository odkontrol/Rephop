# RepHop

Click a Weidian, Taobao, 1688 or Yupoo link on Reddit and land on the Superbuy listing. Save finds to a list instead of juggling tabs.

No copying, no pasting, and one tab that gets reused instead of a new tab per link.

## Install (unpacked)

1. Open `chrome://extensions` (also works in Edge and Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `rephop` folder.
4. Pin the ⚡ icon. Clicking it opens your list in the side panel.

Requires Chrome 116 or newer. Stay signed in to Superbuy: it only shows a listing when you are logged in.

## What it does

**On Reddit (and Yupoo, Google Sheets, any site you add)**

| You do | You get |
| --- | --- |
| Click a product link | The listing opens in Superbuy, in one reused tab |
| Ctrl+click or middle-click | The listing opens in a background tab |
| Alt+click | The item is saved to your list |
| Shift+click | The original link, untouched |
| Hover a link (or focus it with Tab), press `S` / `A` / `Q` / `O` | Open in Superbuy / save / QC photos / original link |
| Hover or focus a link | A card with the picture, name and price |
| Click `Save all N links` in the corner | Every link on the page is saved, plus the comments Reddit has not put on screen yet |

Each link also gets a small `⚡ SB | +` button: the left half opens, the right half saves. On a link you already saved, the right half shows a green check; clicking it offers "Open list" or "Remove" rather than deleting straight away.

The hotkeys only act on a link your mouse has actually moved onto, or one that has keyboard focus. A link that slides under a resting cursor while you scroll does nothing.

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
- Folders, tags, notes, quantity, in-cart and bought status, search, sort and filters.
- A running total for the folder or selection.
- **Go through**: opens your items one at a time in a single tab, with Next / Previous on the page (`]` and `[`). On Superbuy, RepHop notices you pressing Add To Cart: if the site confirms, the item is marked as in cart; if the site says nothing, RepHop asks; if the site shows an error, nothing is marked.
- Check availability: Weidian items that sold out or were removed, and Yupoo albums that were deleted.
- QC photo lookup, trusted sellers (gold outline on their links), "seen in N posts" counter.
- Export CSV, copy as text or Reddit markdown, JSON backup and restore.
- Optional sync between your computers through the browser's own sync.

**Google Sheets**

In the normal spreadsheet view the corner bar offers "Grab links from this tab", "All tabs" and "Clickable view". The clickable view opens Google's plain HTML version of the sheet, where every link gets its own open and save buttons.

**Everywhere else**

- Right-click a product link, a text selection or the page for the same actions on any website.
- Browser shortcuts (change them at `chrome://extensions/shortcuts`):
  - `Alt+Shift+L` open the list
  - `Alt+Shift+S` open the product on the current page in Superbuy
  - `Alt+Shift+K` save the product on the current page
  - `Alt+Shift+G` save every rep link on the current page

## Settings worth knowing

- **Shopping agent**: Superbuy by default. AllChinaBuy, CNFans, Mulebuy, Kakobuy, Hoobuy and ACBuy are built in, or enter your own link template.
- **Open listings in**: one reused tab (default), a reused side window, a tab group, or a new tab each time.
- **Jump to the listing when it opens**: turn off to stay on Reddit while listings load behind you.
- Every click and hotkey behaviour can be switched off, and the hotkeys can be remapped.
- **Privacy and clean-up**: clear the history RepHop keeps (see below) or delete the whole list.

## Privacy

RepHop has no server, no account and no analytics. Everything it stores stays in your browser.

What it stores locally:

- Your list (items, folders, tags, notes) and your settings.
- A history: which product links you opened, which Reddit posts each link appeared in (post ids only, used for the "seen in N posts" counter), and previews it has already looked up. **Settings → Clear that history** removes all of it.

What the page can see: nothing. The buttons, the hover card and the messages are drawn in closed shadow roots, so a website's own scripts cannot read which links you saved, viewed or trusted.

Network requests the extension makes itself:

| To | When | Why |
| --- | --- | --- |
| `thor.weidian.com` | You hover, open or save a Weidian link, or check availability | Name, price, picture, stock |
| `weidian.com` item page | A little after you save a Weidian item. One at a time, a few seconds apart, capped per session, and paused for 30 minutes if Weidian refuses | The shop (for trusted sellers) and Weidian's translated name |
| `*.yupoo.com` | You hover, open or save a Yupoo album | Find the buy link, title and cover |
| `si.geilicdn.com`, `photo.yupoo.com` | A thumbnail is shown | Product pictures (small versions) |
| Share-link shorteners (`k.youshop10.com`, `m.tb.cn`, `qr.1688.com`, `ikako.vip`) | You hover, open or save a short link | Follow it to the product |
| `reddit.com` (the thread's own JSON) | You press "Save all" on a post | Comments not yet on screen |
| `docs.google.com` (the sheet's HTML view) | You press a "Grab links" button on a sheet | Read the links |
| `open.er-api.com` | Twice a day | Yuan exchange rate. [Rates By Exchange Rate API](https://www.exchangerate-api.com) |

Sync, if you turn it on, goes through your browser account's own extension sync and nowhere else.

See [PRIVACY.md](PRIVACY.md) for the same information as a standalone policy.

## Permissions, and why

| Permission | Reason |
| --- | --- |
| Reddit, Yupoo, Google Sheets | Find links on the page and add the buttons |
| Weidian, Taobao, Tmall, 1688 | Show the "open in Superbuy / save" bar on product pages; read Weidian previews; follow short links |
| Superbuy, AllChinaBuy, CNFans, Mulebuy, Kakobuy, Hoobuy, ACBuy (the agents you can pick as a target) | Queue controls and "saved" state on the listing; check that the reused tab still shows a listing before reusing it |
| `storage` | Your list and settings |
| `sidePanel` | The list |
| `contextMenus`, `activeTab`, `scripting` | Right-click actions and "grab this page" on sites RepHop does not normally run on |
| `tabGroups` | The "tab group" opening mode |
| `declarativeNetRequestWithHostAccess` | Two header rules: one so Weidian's item API answers the extension, one so Yupoo serves album pictures as thumbnails. They apply to those two hosts only |
| `alarms` | Exchange rate refresh and delayed sync |
| Optional: any site you add under **More sites**, or a custom agent's site | Run the same buttons there. Asked for one site at a time, only when you add it |

## Limits

- **Not verified on a signed-in Superbuy listing.** The author could not sign in while building this. The listing reader (name, yuan price, picture) and the Add To Cart detection are written against the page's public skeleton and were tested on a stand-in page. If Superbuy's page differs, those two conveniences may not fire; opening, saving and the queue do not depend on them.
- **Reddit was tested on saved copies**, not on the live site: a hand-built page in Reddit's structure, plus archived copies of real r/FashionReps threads (new Reddit). Reddit blocks automated browsers, so the live site itself was not driven.
- Taobao and 1688 have no public preview API. Their name, price and picture fill in after you open the listing once. Availability checks cover Weidian and Yupoo only.
- A Yupoo album only resolves if the seller put a Weidian, Taobao or 1688 link on it.
- "Save all" gets the comments Reddit hands over in one request (about 500). On bigger threads the message tells you how many were left out; expand them on the page and save again.
- The shop of a Weidian item (needed for "trusted seller") is looked up slowly, by design, and only for saved items.
- Add-to-cart is not automated: size and colour have to be chosen by you.
- Browser sync holds roughly 100 KB. Names are synced up to 80 characters and notes up to 200; longer text stays complete on the device where you wrote it. With several hundred items the oldest ones stop syncing, and the settings page says how many.
- QC links point at third-party QC sites. If one changes its address format, pick another under Settings or enter a custom template.
- Agents other than Superbuy use their publicly known link formats and were not individually verified. If one changes, use the custom template.

## Development

No build step. Everything is plain JavaScript.

```bash
node --test tests/links.test.js tests/util.test.js
```

The end-to-end suite loads the unpacked extension in a real Chrome (needs a network; about three minutes):

```bash
cd tests/e2e && npm install && node run.js
```

Add `--shots <folder>` for screenshots, and `--real <folder>` to also run it against saved copies of real Reddit thread pages (`.html` files).

```
manifest.json
background.js        service worker: storage, tabs, network, sync, menus, shortcuts
lib/links.js         link parsing and URL building (pure, unit-tested)
lib/util.js          formatting, export, sync packing, page readers (pure, unit-tested)
content/main.js      buttons, click and hotkey handling, hover card, corner bar
panel/               the list, paste box, settings and help
tests/               node:test suites, and tests/e2e for the browser run
```

**Publishing to the Chrome Web Store:** zip the folder without `tests/`, `README.md`, `PRIVACY.md` and `LICENSE`. The store will ask for a justification of each permission (the table above) and a privacy policy (PRIVACY.md). Store policy on listings that mention third-party brands or replica goods is the publisher's to check.

## License

MIT. See [LICENSE](LICENSE).
