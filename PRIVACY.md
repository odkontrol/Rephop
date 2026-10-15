# RepHop privacy policy

RepHop is a browser extension that opens product links at a shopping agent, keeps a list of the ones you save, and can add them to your cart at that agent.

Last updated: 15 October 2026.

## What is collected

RepHop has no account, no analytics and no advertising, and the developer receives nothing about you from ordinary use. No data leaves your browser except the requests listed below, which go directly from your browser to the site named.

The one exception is a live group haul, and only if you start or join one: the lists in it pass through a relay server run by whoever published your copy of RepHop. They are encrypted in your browser first, so the relay's operator cannot read them; what the relay does see is described under "Live group hauls" below.

## What is stored in your browser

- Your list: the items you saved, with their folder, tags, notes, price, quantity, status, the colour and size you picked for them, and the address of the post or page you found them on.
- Your settings, including the clothing and shoe sizes you enter on the welcome screen or under "My sizes".
- Group hauls: the lists your friends sent you as share codes (their name as they typed it, their items and the choices they made), and the name you typed for yourself.
- A history used for the markers on the page: which product links you opened, which Reddit posts a link appeared in (post ids only), and previews already looked up.

You can clear the history, or delete the whole list, under **Settings → Privacy and clean-up**. Removing the extension removes everything stored in your browser. (A live haul's encrypted copy on the relay goes when the haul ends, or after 30 days untouched.)

If you turn on **Sync**, a shortened copy of your list is stored in your browser account's own extension sync storage (provided by the browser vendor) so your other computers can read it. RepHop's developer has no access to it. Your sizes and other settings are not synced.

## Requests RepHop makes

| To | When | Why |
| --- | --- | --- |
| `thor.weidian.com` | You hover, open, save or check a Weidian link; your list is shown and a saved Weidian item has no choices yet; you add a friend's list that contains Weidian items | Name, price, picture, stock, and the choices the listing offers |
| `weidian.com` | A little after you save a Weidian item; when you open or save a `k.youshop10.com` short link | The shop and translated name; where the short link leads |
| `*.yupoo.com` | You hover, open or save a Yupoo album | Find the buy link, title and cover picture |
| `si.geilicdn.com`, `photo.yupoo.com` | A thumbnail is shown | Product pictures |
| `m.tb.cn`, `qr.1688.com`, `ikako.vip` | You open or save one of these short links | Follow it to the product |
| `reddit.com` | You press "Save all" on a post; you open a gallery post | Read that thread's comments; the gallery's photos, their captions and links, and the poster's links |
| `preview.redd.it`, `si.geilicdn.com` | You press "Save from this photo" on a gallery post | The post's photos and the linked products' pictures, compared on your computer to suggest which item is in a photo |
| `docs.google.com` | You press a "Grab links" button on a spreadsheet | Read that sheet's links |
| `open.er-api.com` | Twice a day | Yuan exchange rate |
| The relay named in a live haul's invite, or in your settings | Only while you are in a live group haul | Pass encrypted lists and statuses between the people in that haul |

These requests carry no identifier added by RepHop. Lookups the extension makes itself (Weidian's item API and item pages, Yupoo album pages, the shorteners and the rate service) are sent without your cookies. Pictures load the way any image on a web page does. To suggest which item a gallery photo shows, RepHop compares the pictures in your browser with a small image model that comes with it; no picture or result is sent anywhere. Requests to Reddit and Google Sheets are made by the page you are on, as you.

When you open a listing, your browser loads the shopping agent's site exactly as if you had pasted the link there yourself. "Add to cart for me" presses the same buttons on that page that you would; RepHop sends nothing to the agent on its own, and never starts a payment. When you open your cart at an agent (or press "Copy cart to RepHop"), RepHop reads the lines the cart page shows (each listing's link, name, picture, the choices, quantity and price) and saves them in your list in your browser. It changes nothing in your cart and sends nothing anywhere; turn it off under Settings → Keep the list in step with your agent's cart.

## Sharing a list

"Share my list" turns the items you choose into a line of text (a share code) and puts it on your clipboard or in a file. The code holds each item's link, name, price, quantity, the choices you made, your size for it as text, its note, the name you typed, and a random id of your copy of RepHop (it lets a newer code from you replace your older one, and says nothing else about you). RepHop does not upload it and has nowhere to upload it to: it goes only where you paste or send it, and anyone you give it to can read it. A code you receive is read on your own computer and stored with your group haul until you remove it.

## Live group hauls

A live haul is optional. If you start one or join one, RepHop sends data through a relay: by default the one whose address is built into this copy of RepHop, run by whoever published it, or one of your own if you entered it in Settings. The relay a haul uses is shown before you join.

- **What is sent.** When you ask to join: your name. Once the person ordering lets you in: the items you chose to share (link, name, price, quantity, the choices you made, your size for them, your note), kept up to date while you stay in the haul. If you are the person ordering: to each member, which of their items are in the cart and what they owe.
- **Who can read it.** The people in the haul, as far as it concerns them: your list goes to the person ordering only, and their note to you goes to you only. Everything is encrypted in your browser with a key that travels only inside the invite. The relay stores and forwards it without being able to read it.
- **What the relay can see.** The haul's room id, how many people are in it, when something changed, the size of what was sent, and the IP addresses that connect to it, as any server can. The relay's own code writes no logs; Cloudflare, which hosts it, keeps its own usage statistics, such as how many requests it served.
- **How long it is kept.** The relay keeps the latest encrypted copy of each list and note so that people who were offline catch up. Leaving a haul deletes yours; ending the haul deletes all of it; a haul nobody has touched for 30 days is deleted automatically.
- **The invite is the key.** Anyone who has it can ask to join. Nobody is in until the person ordering lets them in.

## What websites can see

A website can tell that RepHop's buttons are on its page and which links RepHop recognised. It cannot read which links you saved, viewed or marked as trusted: RepHop's buttons, hover card and messages are drawn in closed shadow roots.

## Changes and questions

Changes to this policy are published in this file. Questions: open an issue at https://github.com/odkontrol/Rephop/issues.
