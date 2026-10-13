



# RepHop

Click a Weidian, Taobao, 1688 or Yupoo link on Reddit and land on the listing at your shopping agent. Save finds to a list instead of juggling tabs, pick each one's colour and size right in the list, and have them added to your cart. Buying as a group? Friends send their lists and one person orders for everyone.

No copying, no pasting, and one tab that gets reused instead of a new tab per link.

## Install (unpacked)

1. Open `chrome://extensions` (also works in Edge and Brave).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `rephop` folder.

4. Pin the ⚡ icon. Clicking it opens your list in the side panel.
5. A **welcome screen** opens: pick your shopping agent (RepHop does not assume one) and, if you like, enter your sizes. Both can be changed later under Settings.

Requires Chrome 116 or newer. Stay signed in to your agent: Superbuy, for one, only shows a listing when you are logged in.



https://github.com/user-attachments/assets/1eeaec90-efa6-49d2-9d76-41551fb1ed3a



**Updating:** replace the files in that same folder, then open the RepHop list. Chrome keeps running the old copy of an unpacked extension until it is reloaded, so the list checks for that and restarts RepHop by itself (or press the 
reload arrow on RepHop's card at `chrome://extensions`). Afterwards reload any Reddit or agent tab that was already open. The build number is at the bottom of Help.

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
- **Colour and size drop-downs on every card**, showing the choices the listing offers, and an **Add to cart** button next to them (see below).
- **Group haul:** share your list as a code, or collect your friends' lists and see what everyone owes (see below).
- Check availability: Weidian items that sold out or were removed, and Yupoo albums that were deleted.
- QC photo lookup, trusted sellers (gold outline on their links), "seen in N posts" counter.
- Export CSV, copy as text or Reddit markdown, JSON backup and restore.
- Optional sync between your computers through the browser's own sync.
- Dark by default; the sun button in the corner switches to light.



https://github.com/user-attachments/assets/1eeb8571-758f-4990-882e-a525ac564415



**Already on your agent's site?**

A listing there has a **Save to RepHop** button in the corner bar. So does a right-click on the page, `Alt+Shift+K`, and a strip at the top of the list. Saving with the corner button or the strip also remembers any colour or size you clicked on the listing (not the ones the site had pre-selected).

## Colours, sizes and Add to cart

Every card in the list shows a drop-down for each row of choices its listing offers (colour, size, style…) and an **Add to cart** button. Nothing has to be selected first.

**Where the drop-downs come from**

- Weidian items get theirs as soon as they are saved, straight from Weidian, in the seller's own wording. Common Chinese words are shown with a translation (`黑色 · Black`, `M码 · M`).
- Taobao and 1688 have no public lookup, so their drop-downs appear after you have opened the listing at your agent once. From then on the wording is the agent's own.
- Size rows fill themselves in from **your sizes** (the welcome screen, or Settings → My sizes: shoes, tops, bottoms, belts, hats). The item's type is worked out from its name and can be set by hand under **Edit**. Choose another size in the drop-down to override it for one item.

**What Add to cart does**

On **Superbuy and AllChinaBuy** RepHop opens the listing in the agent tab, sets every row, sets the quantity, presses Add To Cart once and waits for the site's own "Add to cart successfully!" dialog before it marks the item. To settle a row it uses, in this order:

1. The pick you made for that row (in the list's drop-down, or by clicking on the listing before).
2. The size or colour written on the item (**Edit** on its card).
3. Your sizes.
4. If a row has only one choice at all, that one.

It only ever picks something it has a reason to pick. The site pre-selects a colour and size on every listing; RepHop ignores that. If a choice is sold out or not offered, if a pick of yours is nowhere on the listing, or if it has nothing to go on for a row, it presses nothing: a message on the page says exactly what is open, and RepHop carries on once you have added the item yourself (or skipped it). It never swaps a sold-out size for a neighbouring one. A pick you made before only ever matches the very same choice (the same text, its translation for the common words, or the same size): if the listing now offers “Black/White” where you had picked “Black”, RepHop asks. If the site answers "Add to cart failed!", RepHop passes that on and marks nothing. If the site says nothing at all, RepHop asks whether the item went in rather than assume.

Three things it will not do: tick Superbuy's "I have read and agree" box under its risk notice (if that box is unticked it waits for you), press Buy Now, or press Add To Cart twice for the same step. It acts only in the tab the run opened.

Listings RepHop leaves to you, with a message saying why: wholesale listings that take an amount per choice, listings where Superbuy shows a notes box instead of choice buttons, listings the shop has taken down, and items Superbuy refuses to sell. The quantity on the item is set exactly, or the listing is handed to you.

Select several items and press **Add to cart** in the bar that appears (or More → Add these to cart) to add them one after the other. At the end RepHop reports how many it added, how many you added, and how many were skipped. Nothing is ever paid for; items only go into your cart.

**On the other agents** RepHop does not pick or press anything. It opens each listing in turn and shows what you wanted; you choose and add, and RepHop marks the item and moves on.

How far to trust it: the page structure RepHop relies on was taken from the code Superbuy's listing page itself runs, and then checked on a live, signed-in Superbuy listing (October 2026) using RepHop's own page-reading code and the same kind of clicks it makes: the rows and choices were read correctly, clicking a colour and a size selected them, the quantity control counted up, and pressing Add To Cart produced Superbuy's "Add to cart successfully!" dialog, which is what RepHop waits for. What was not done is a full run of the installed extension on the live site from start to finish; the automated tests do that against a stand-in page built to the same structure. AllChinaBuy shares the page but was not checked. Watch the first item go in.

**Choices in the seller's wording.** A Weidian item's drop-downs show the seller's own words, often Chinese, while the agent shows a translation. RepHop finds your choice on the agent's listing by the same text, by translation for common words, or by its place in the row: the agent lists the same choices in the same order. Place is only used when the row is recognisably the same row (same number of choices, and the ones RepHop can read sit in the same places); otherwise it asks.

## Group haul

For when one person orders for several friends, so that international shipping is paid once.

1. **Each friend** opens the **Group** tab, presses **Share my list**, types their name, chooses which items to send (everything, a folder, or what is selected in the list) and presses **Copy share code** (or **Save as a file**). They send that text to whoever is ordering, by any means.
2. **The person ordering** presses **Add a friend's list** and pastes each code. A newer code from the same person replaces the earlier one; items already in the cart stay marked as long as they are still wanted the same way. Two friends with the same name are kept apart.
3. The Group tab then shows:
   - one **total** for the whole haul, in yuan and in your currency;
   - a row **per person**: what their items cost, their share of shipping and fees, and what they **owe**;
   - everyone's items, **by person** or **all together** (the same product from several people side by side), each with the colour, size and quantity that person chose;
   - **Add to cart** on every item, **Add N to cart** per person, and **Add everything to cart**. A friend's item is added with that friend's choices and size, never yours.
4. Enter the shipping and fees once they are known and choose **evenly** or **by item cost**. **Copy who owes what** gives a short text for the group chat.

A share code holds each item's link, name, price, quantity, the choices made on it, the size as text and its note, plus the name you typed and a random id of your copy of RepHop (so that your next code replaces this one). RepHop sends it nowhere: it exists only where you paste it. The amounts use the day's exchange rate; your agent's own rate and fees decide the final numbers. Up to 12 friends per haul.

### Live haul

A live haul is the same thing kept up to date by itself: when a friend changes a colour, adds an item or removes one, the person ordering sees it a moment later, and each friend sees what is in the cart and what they owe.

1. **The person ordering** types their name in the Group tab and presses **Start a live haul**. RepHop copies an invite; they send it to the friends they are ordering for.
2. **Each friend** presses **Join with an invite**, pastes it, chooses what to share (everything not bought, or one folder) and presses **Ask to join**. Only their name goes with the request.
3. **The person ordering** sees "Sam wants to join" and presses **Let in**. From then on Sam's list is shared, with them only, and follows Sam's changes while RepHop is open.
4. Anyone can leave, which takes their list off the relay; the person ordering can remove someone or end the haul for everyone. Lists that were already received stay as ordinary lists.

**What makes it live** is a relay: a small server that passes updates between the browsers in a haul. Lists are encrypted in the browser with a key that only travels inside the invite, so the relay stores and forwards data it cannot read; it sees the room, how many people are in it, when something changed, and (like any server) the IP addresses that connect. Friends never connect to each other. A relay is built into RepHop, so there is nothing to set up: the address is in `lib/util.js` (`DEFAULT_RELAY`), is run by whoever published this copy, and travels inside every invite. To use one of your own instead, enter it under **Settings → Live group hauls**; the relay's source and a five-minute guide to putting one on Cloudflare's free plan are in the separate `rephop-relay` project.

The invite is the key to the haul: send it only to the people you are ordering for. Someone who gets hold of it can ask to join under any name, which is why nobody is in until the person ordering lets them in. Friends see their own items and totals, not each other's. It is live while the RepHop list is open on both sides; changes made while it is closed go out the next time it opens. Share codes keep working without a relay.

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

RepHop has no account and no analytics, and everything it stores stays in your browser. The one thing that passes through a server is a live group haul, if you start or join one: the lists in it travel through a relay, encrypted so that the relay cannot read them.

What it stores locally:

- Your list (items, folders, tags, notes, the options you picked and the choices each listing offers), your sizes and your settings.
- Group hauls: the lists friends sent you as share codes, and the name you typed for your own.
- A history: which product links you opened, which Reddit posts each link appeared in (post ids only, used for the "seen in N posts" counter), and previews it has already looked up. **Settings → Clear that history** removes all of it.

What a website can see: that RepHop's buttons are on its page, and which links it recognised. It cannot read which links you saved, viewed or trusted: the buttons, the hover card and the messages are drawn in closed shadow roots, and no button changes size with that state.

Network requests the extension makes itself:

| To | When | Why |
| --- | --- | --- |
| `thor.weidian.com` | You hover, open or save a Weidian link, check availability, or add a friend's list that contains Weidian items | Name, price, picture, stock, and the choices the listing offers |
| `weidian.com` item page | A little after you save a Weidian item, and when you open or save a `k.youshop10.com` short link. One at a time, spaced out, capped per session, and paused for 30 minutes if Weidian refuses | The shop (for trusted sellers) and Weidian's translated name; where a short link leads |
| `*.yupoo.com` | You hover, open or save a Yupoo album | Find the buy link, title and cover |
| `si.geilicdn.com`, `photo.yupoo.com` | A thumbnail is shown | Product pictures (small versions) |
| `m.tb.cn`, `qr.1688.com`, `ikako.vip` | You open or save one of these short links | Follow it to the product |
| `reddit.com` (the thread's own JSON) | You press "Save all" on a post | Comments not yet on screen |
| `docs.google.com` (the sheet's HTML view) | You press a "Grab links" button on a sheet | Read the links |
| `open.er-api.com` | Twice a day | Yuan exchange rate. [Rates By Exchange Rate API](https://www.exchangerate-api.com) |
| The relay named in a live haul's invite (or in your settings) | Only while you are in a live group haul | Pass encrypted lists and statuses between the people in the haul |

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

- **Superbuy's listing page was read, never clicked.** What RepHop relies on there comes from the page's own code (see "How far to trust it" above). If Superbuy changes that page, Add to cart stops and tells you what it could not do; opening, saving, the drop-downs for Weidian items and the group haul do not depend on it.
- **Drop-downs for Weidian items use the seller's wording**, which the agent shows translated. Sizes, plain English and the common colour words are matched; anything else RepHop asks you to pick on the listing once, and remembers in the agent's wording from then on.
- **A live haul depends on the relay being up**, and is live only while the RepHop list is open; with it closed, changes wait until it opens. If the relay is down or over its daily allowance, share codes do the same job by hand.
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
lib/live.js          live group hauls: invites, encryption, talking to the relay (unit-tested)
content/main.js      buttons, click and hotkey handling, hover card, corner bar, add-to-cart help
panel/               the list, paste box, settings and help
tests/               node:test suites, and tests/e2e for the browser run
```

**Publishing to the Chrome Web Store:** zip the folder without `tests/`, `README.md`, `PRIVACY.md` and `LICENSE`. The store will ask for a justification of each permission (the table above) and a privacy policy (PRIVACY.md). Store policy on listings that mention third-party brands or replica goods is the publisher's to check.

## License

MIT. See [LICENSE](LICENSE).
