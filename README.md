# SAVESTATE

**Save your games. Tell the State.**

A single-page tool for supporting California **AB 1921, the Protect Our Games Act**: it tracks the bill's live status, condenses the [consumerrights.wiki rebuttal](https://consumerrights.wiki/w/User:Louis/Rebuttal_to_the_ESA_on_AB_1921_and_Stop_Killing_Games) to the ESA's op-ed into sourced talking points, and helps a visitor write, schedule, and deliver their own letter to the senators who vote next. It also tells them where to show up and how to get there.

## Design rules

1. **Zero data.** No backend, no accounts, no cookies, no analytics, no logging we control. The letter is assembled by JavaScript in the visitor's browser and leaves through *their* email app, the Legislature's own portal, or their printer. Location detection runs on-device against district boundary files bundled with the site; coordinates are never transmitted. There is no server code in this repo at all.
2. **A human sends every message.** The tool drafts; the visitor edits and sends under their own name. Nothing auto-sends, ever. This is what separates constituent mail (which offices count) from blast spam (which they bin).
3. **Human prose only.** Every letter paragraph was written by hand, in plain English, with checkable facts. The builder varies phrasing between users so identical blasts don't happen, and a "robot detector" warns visitors who paste AI text into the draft (em dashes, "delve", "furthermore", the usual tells).
4. **The data updates itself; the words don't.** A scheduled job refreshes bill status from LegInfo and re-syncs against the wiki. If a wiki section changes, its card gets flagged for human re-summary. The refresher never rewrites hand-written prose.

## Repo layout

```
index.html              the whole site
style.css               dark, no frameworks, print stylesheet for the visit sheet
app.js                  letter engine, on-device geo, .ics generator, maps links
data/bill.json          live bill status (auto-refreshed)
data/points.json        talking points: ESA claim, summary, hand-written variants (auto-flagged, never auto-written)
data/targets.json       committee, members, phones, portal, places (hand-maintained, verified against official pages)
data/districts.geojson  all 40 CA Senate districts, simplified (~180 KB), for on-device lookup
data/ca-boundary.geojson state outline for the in/out-of-state branch
og.png                  social share card (1200x630), referenced by the OG/Twitter tags
robots.txt              crawler rules, points at the sitemap
sitemap.xml             one URL; lastmod is bumped by hand when the page changes
scripts/update-data.mjs the refresher (Node 18+, no dependencies)
.github/workflows/      refresh + GitHub Pages deploy, for forks that want free hosting
deploy/                 systemd units + Caddy vhost for self-hosting
```

## Run it locally

```
python3 -m http.server 8080
# open http://localhost:8080
```

`file://` won't work because the app fetches its JSON; any static server is fine.

## Refresh the data by hand

```
node scripts/update-data.mjs
```

Prints what changed. Safe to run anytime; on fetch failure it keeps the last good data and sets a `stale` flag the page displays.

## Deploy

It's a folder of static files. Three workable paths:

- **Any static host or your own box:** copy the folder, serve it. `deploy/` has a Caddy vhost and a systemd service + timer that runs the refresher hourly.
- **GitHub Pages:** push to `main`, enable Pages with "GitHub Actions" as the source. The included workflow refreshes data hourly, commits changes, and redeploys.
- **Subdomain:** point a CNAME at wherever you host it. The site is path-relative and works at any hostname.

Hosting under a different domain? The absolute URLs live in three places: the canonical/OG tags and JSON-LD in `index.html`, `robots.txt`, and `sitemap.xml`. Grep for the current host (`sworrl.github.io/ESAonAB1921`), replace, done.

## Enabling one-click send (optional)

The site is static and works without a backend: "Open in your email app" and the portal/form buttons send the visitor's letter from the visitor's own account. The one-click **Send it for me** button additionally needs the relay (`server/relay.mjs`) running on a Node host (not GitHub Pages).

The relay sends through a mail service you control, **from that service's mailbox**, with the constituent's name signing the body and their address in Reply-To and CC. It never forges the sender's address (that is spoofing and bounces), and it only delivers to the allowlisted committee inbox. Point it at any free SMTP provider:

```
cp deploy/relay.env.example /etc/savestate-relay.env   # then fill in
node server/relay.mjs                                   # reads RELAY_* from the environment
```

The simplest free option is a dedicated Gmail account with an App Password (`RELAY_SMTP_HOST=smtp.gmail.com`, port 465). Resend, Brevo, and SendGrid free tiers work the same way. See `deploy/relay.env.example` for every variable. Reverse-proxy `/api/*` to the relay (the included `deploy/Caddyfile.savestate` does this) and the button lights up. Leave `RELAY_SMTP_HOST` empty to fall back to a local Postfix instead.

## Renaming the tool

The name appears in `index.html` (header, title, FAQ), `app.js` (ICS PRODID), and this README. Grep for `SAVESTATE` and `savestate`, replace, done. The share card `og.png` also carries the name; redraw it or drop the OG image tags.

## Updating the letter prose

Edit `variants` arrays in `data/points.json`. House rules for new variants: facts must trace to the wiki page or the bill record, no em dashes, no filler, two to four sentences, and read it out loud before committing. When the refresher flags a point `stale_content: true`, re-read the wiki section, update the summary and variants, and clear the flag.

## Security model

The goal is that using this site cannot hurt the visitor, even if something upstream goes wrong.

- **No attack surface where it counts.** No accounts, no sessions, no cookies, no database, no server code, no third-party JavaScript, no web fonts, no CDN. There is nothing to phish, nothing to breach, and no supply chain beyond this repo.
- **Strict CSP, enforced twice.** `default-src 'none'` with same-origin scripts/styles only, set in a meta tag and again as a response header (which adds `frame-ancestors 'none'`). Inline scripts won't run even if injected.
- **No HTML injection paths.** The renderer has no `innerHTML` anywhere; every string, including data scraped from the wiki and LegInfo, becomes a text node. A compromised upstream page could change what the cards say, never what the page executes.
- **No referrer leakage.** `Referrer-Policy: no-referrer` plus `rel="noreferrer"` on every external link; clicking out to maps or the Legislature tells those sites nothing about where you came from.
- **Opt-in third-party content.** The only external resource is the OpenStreetMap embed, which loads in a sandboxed iframe after an explicit click, with a note saying whose servers it talks to.
- **Hardened delivery.** HSTS, `nosniff`, `X-Frame-Options: DENY`, cross-origin isolation headers, a locked-down Permissions-Policy (geolocation self-only, everything else denied), no access logs at our origin, and `.well-known/security.txt` for reports.
- **Sandboxed refresher.** The data updater runs as a systemd oneshot with `ProtectSystem=strict` and write access to `data/` only, and it parses upstream content with no eval, no shell, and no dependencies.

Residual honesty: traffic still transits Cloudflare like any proxied site, the user's own mail provider sees the letter they choose to send, and map tiles come from OSM after the click. Those are disclosed on the page rather than papered over.

## What this tool refuses to do

- Send anything on a visitor's behalf
- Store or transmit a visitor's name, location, letter, or anything else
- Auto-generate prose with a language model at runtime
- Target anyone other than the public officials deciding this bill

These are features. Offices discount mail that looks manufactured, and people trust tools that can't betray them.

## License

MIT. Bill data is public record; rebuttal content condenses [consumerrights.wiki](https://consumerrights.wiki), CC BY-SA, with links back to every section. Not affiliated with the California Legislature, FULU, consumerrights.wiki, or Louis Rossmann.
