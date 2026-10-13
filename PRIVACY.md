# RepHop privacy policy

RepHop is a browser extension that opens product links at a shopping agent, keeps a list of the ones you save, and can add them to your cart at that agent.

## What is collected

Nothing is collected by the developer. RepHop has no server, no account, no analytics and no advertising. No data leaves your browser except the requests listed below, which go directly from your browser to the site named.

## What is stored in your browser

- Your list: the items you saved, with their folder, tags, notes, price, quantity, status, the colour and size you picked for them, and the address of the post or page you found them on.
- Your settings, including the clothing and shoe sizes you enter under "My sizes".
- A history used for the markers on the page: which product links you opened, which Reddit posts a link appeared in (post ids only), and previews already looked up.

You can clear the history, or delete the whole list, under **Settings → Privacy and clean-up**. Removing the extension removes everything.

If you turn on **Sync**, a shortened copy of your list is stored in your browser account's own extension sync storage (provided by the browser vendor) so your other computers can read it. RepHop's developer has no access to it. Your sizes and other settings are not synced.

## Requests RepHop makes

| To | When | Why |
| --- | --- | --- |
| `thor.weidian.com` | You hover, open, save or check a Weidian link | Name, price, picture, stock |
| `weidian.com` | A little after you save a Weidian item; when you open or save a `k.youshop10.com` short link | The shop and translated name; where the short link leads |
| `*.yupoo.com` | You hover, open or save a Yupoo album | Find the buy link, title and cover picture |
| `si.geilicdn.com`, `photo.yupoo.com` | A thumbnail is shown | Product pictures |
| `m.tb.cn`, `qr.1688.com`, `ikako.vip` | You open or save one of these short links | Follow it to the product |
| `reddit.com` | You press "Save all" on a post | Read that thread's comments |
| `docs.google.com` | You press a "Grab links" button on a spreadsheet | Read that sheet's links |
| `open.er-api.com` | Twice a day | Yuan exchange rate |

These requests carry no identifier added by RepHop. Lookups the extension makes itself (Weidian's item API and item pages, Yupoo album pages, the shorteners and the rate service) are sent without your cookies. Pictures load the way any image on a web page does. Requests to Reddit and Google Sheets are made by the page you are on, as you.

When you open a listing, your browser loads the shopping agent's site exactly as if you had pasted the link there yourself. "Add to cart for me" presses the same buttons on that page that you would; RepHop sends nothing to the agent on its own, and never starts a payment.

## What websites can see

A website can tell that RepHop's buttons are on its page and which links RepHop recognised. It cannot read which links you saved, viewed or marked as trusted: RepHop's buttons, hover card and messages are drawn in closed shadow roots.

## Changes

Changes to this policy are published in this file.
