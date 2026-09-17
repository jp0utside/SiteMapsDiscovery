# SMC Map Inventory

Command-line tool that crawls **www.smcgov.org** from the client side and produces a complete
inventory of every mapping application on the site — embedded, linked, static or interactive —
using only what a browser can observe. No CMS, database or hosting access.

Two questions the output answers:

1. **What map applications exist?** `applications.csv` — one row per distinct application
   (stable identity, vendor, type, occurrence count, county-org flag, screenshot).
2. **Where does each one appear?** `occurrences.csv` — one row per (page, application) pair with
   its placement (`main_content` vs `site_chrome`) and how it appears (iframe embed, link, static image, in-page).

The same application embedded on 60 pages is **one** application row and **60** occurrence rows.

## Requirements

- Node.js 20+ (tested on 22; the CLI refuses to start on older versions)
- Chromium via Playwright (`npx playwright install chromium` on first setup)
- A laptop that can run unattended for hours. Runs are resumable (see below).

```bash
npm install
npx playwright install chromium        # once
```

Before a full-site run: **notify the security / network team.** A full crawl looks like
reconnaissance; a WAF that starts returning 403 mid-run yields a falsely *clean* inventory rather
than an obvious failure. Edit the `contact:` in `config.yaml` → `http.user_agent` first.

## The one command

```bash
node bin/cli.js run-crawl --plan     # print the run plan + the notice to send the web team; touches nothing
node bin/cli.js run-crawl            # inventory → scan → arcgis → report with the settled config.yaml
```

`run-crawl` is the whole audit with every decision pre-configured in `config.yaml`: 2 page
requests/s on www.smcgov.org with 3 pages in flight, robots.txt `Disallow` honoured and
`Crawl-delay` overridden with the web team's approval, every vendor recorded but the report
filtered to Esri, each page's HTML stored gzipped for offline re-analysis, one screenshot per
application. It prompts once, prints phase timings, and is resumable: Ctrl-C and re-run
`run-crawl` to continue. Use `--max-runtime <minutes>` to bound the scan phase and
`--screenshots none` to skip images (capture them later with `node bin/cli.js screenshots`).

### What you see while it runs, and how to stop it

- **Progress**: a line every 25 pages during discovery and every 10 during scanning, with pages
  scanned, pages with maps, applications found so far, failures, and the HTTP status mix of the
  last 25 requests. A `NEW application …` line the first time each application is seen. Warnings
  for every retry. Findings are committed per page, so `node bin/cli.js status` in a second
  terminal (read-only) always shows the live picture, and `report` can be run mid-crawl for a
  partial export.
- **Stopping**: Ctrl-C once stops claiming new pages, lets the pages in flight finish (up to ~30 s),
  and exits with nothing left `in_progress`. Ctrl-C twice exits immediately. Re-run `run-crawl`
  to resume; `--max-runtime <minutes>` stops it for you.
- **If the host starts rejecting requests**: 403 / 429 / 401 / 5xx and network errors are never
  treated as a property of the page — the page is scheduled for retry, not marked skipped. If at
  least `http.block_threshold` (8) of the last `http.block_window` (25) page requests were
  rejections, the run prints a loud STOP banner and exits, leaving everything unfinished as
  `pending`, and `run-crawl` does not continue to later phases. `status` shows `BLOCKED` with the
  status mix. Sort it out with the web team, then re-run `run-crawl` to resume. This exists so a
  firewall reacting mid-run cannot produce a falsely clean inventory.

## Individual commands

```
node bin/cli.js preflight   # Phase 0: consent-gating probe (differential render of ~30 pages)
node bin/cli.js inventory   # Phase 1: discover URLs (sitemaps → robots.txt → BFS link crawl); idempotent
node bin/cli.js scan        # Phase 2: tier-1 static + tier-2 headless detection; resumable
node bin/cli.js arcgis      # ArcGIS Online org cross-reference (public item search)
node bin/cli.js report      # Phase 3: aggregate, deduplicate, export (no recrawl)
node bin/cli.js screenshots # capture an image for every application still without one (one visit each)
node bin/cli.js status      # read-only snapshot: queue, HTTP statuses, applications, failures, BLOCKED flag
```

Global options: `-c config.yaml`, `-r rules.yaml`, `-d inventory.sqlite`. `--help` on any command.

### Typical run

```bash
node bin/cli.js preflight                      # prints a clear consent verdict; writes output/preflight.json
node bin/cli.js inventory                      # ~10–12k URLs from the sitemap index + BFS; tier-1 runs during the crawl
node bin/cli.js scan --concurrency 3           # renders tier-1 hits, map-adjacent URLs and a 20% sample of misses
node bin/cli.js arcgis                         # enumerates smcmaps.maps.arcgis.com public items; classifies findings
node bin/cli.js report                         # output/applications.csv, occurrences.csv, findings.jsonl, report.html
```

### Resuming

`scan` survives Ctrl-C and can be restarted hours later:

- Workers claim `urls` rows in a transaction (`pending` → `in_progress`); findings are committed per page.
- First Ctrl-C: stop claiming, finish in-flight pages, exit cleanly. Second Ctrl-C: exit now.
- On startup any `in_progress` row older than `scan.stale_in_progress_minutes` (10) is reset to `pending`
  (`--reset-in-progress` resets all of them immediately after a hard kill).
- Failures retry 3× with exponential backoff, then are marked `failed` with the error; they never halt the run.
- `--max-runtime <minutes>` bounds an overnight run; just re-run `scan` to continue.
- `inventory` is idempotent: re-running adds newly discovered URLs without disturbing queue state.

Progress line every 10 pages: `completed / total | hit rate | rendered | failed | elapsed | ETA`.

Useful `scan` flags: `--tier 1` / `--tier 2` (split the tiers into separate passes),
`--limit N`, `--url <url...>` (re-scan specific pages), `--screenshots none|identity|all`,
`--consent auto|on|off`.

## How detection works

**Tier 1 — static fetch, every URL.** Plain GET; the raw HTML is matched against `rules.yaml`
(iframes, links, static-map images, vendor script loads, source hints, lazy `data-*` embeds).
Drupal renders this site's map iframes server-side, so tier 1 confirms most findings.
A tier-1 hit is confirmed; a tier-1 miss is **unknown**, never "clean".

**Tier 2 — headless Chromium.** Rendered for every tier-1 hit, every URL whose path or title
matches the map-adjacent patterns (`map`, `gis`, `viewer`, `locator`, …), and a deterministic
20% random sample of tier-1 misses (the sample hit rate is reported — it tells you whether the
static rules are blind to a category). Per page: navigate → `networkidle` (30s ceiling) →
intercept **all** requests (matching tile/image requests are recorded, then aborted to save
bandwidth; scripts are allowed through) → scroll the full height → click up to 10 map-ish
controls / tabs / accordions (never forms, never navigating away) → evaluate globals and DOM
selectors piercing shadow roots → enumerate every frame → screenshot new identities.

**Placement.** Every finding's DOM ancestors are walked for `header/nav/footer`, ARIA landmark
roles and Drupal region classes. `site_chrome` findings (the mega-menu's road-closures app and
`gis.smcgov.org` viewer on every page) are stored as **one exemplar finding per application** with
page presence recorded compactly on the URL row — not one finding row per crawled page. In the
report they collapse to a single "site-wide navigation" application row with an occurrence count.

**Identity** (`identity_key`, stable per *application*, not per page):

| Order | Source | Key |
|---|---|---|
| 1 | ArcGIS item id (`id=`, `appid=`, `webmap=`, or the id in an Experience/Dashboard/StoryMap path) | `arcgis:item:<id>` |
| 2 | Google My Maps `mid=` | `gmymaps:mid:<id>` |
| 3 | Mapbox style (`mapbox://styles/<org>/<id>` or the https style URL) | `mapbox:style:<org>/<id>` |
| 4 | Origin + path (trailing slash normalised), query dropped except identifying params (`rules.yaml` → `identity.identifying_params`). The `iframe:` prefix names this rule and is used whether the target was embedded or only linked | `iframe:gis.smcgov.org/Html5Viewer/` |
| 4b | A rule may pin a fixed key (`identity_key:` on an `embeds` rule), e.g. every Google "Get Directions" link → one application | `link:google.com/maps` |
| 5 | In-page map with no external identity (inherently per page; `applications.per_page = 1`) | `inpage:<vendor>:<page_url>:<container>` |

One in-page map gets **one** identity even when several selectors, globals and tile requests
describe the same container; a container adopts the page's ArcGIS/Mapbox/My Maps identity when
that is unambiguous. API keys / access tokens (`key=`, `access_token=`, `apikey=`), the ArcGIS
org (`smcmaps`) and `appid`/`webmap` params are extracted and stored; the report probes each key
with a single unauthenticated GET to flag keys with no referrer restriction.

**Types**: `interactive_webmap`, `gis_application`, `story_map`, `static_map_image`,
`embedded_third_party`, `thematic_chart_map`, `map_link_only`, `non_geographic`. All are
recorded; `map_link_only` and `non_geographic` are **flagged** (column `flagged`) so they can be
filtered, never dropped.

**Screenshots**: one per unique identity on first encounter (`--screenshots identity`, default),
clipped to the map container, JPEG q70, written to `./screenshots/<hash>.jpg`; only the path is
stored. Hard cap 1,000 images (scan continues; a warning is logged).

## Three scopes: crawl, detection, report

| Layer | Question it answers | Setting |
|---|---|---|
| Crawl | which URLs are fetched | `scope` — www.smcgov.org, every path |
| Detection | what is written to the database from each page, and which pages get rendered | `detection` |
| Report | what the CSV / HTML export shows | `report.vendors` |

The crawl is identical whatever the detection scope, so the shipped config records **every**
vendor (`detection.vendors: []`) and stores each page's HTML gzipped (`inventory.store_html: all`,
roughly 150–250 MB for the whole site). The deliverable is then filtered to the audit's subject,
ESRI / ArcGIS Online items, with `report.vendors: [esri, esri-enterprise]`; the database keeps the
rest, and `findings-all-vendors.jsonl` exports it. Re-run `report` with a different vendor list at
any time without recrawling.

```yaml
detection:
  vendors: []                       # [] = all vendors; e.g. [esri, esri-enterprise] to store only Esri findings
  record_links: true                # keep <a href> links to map apps as flagged map_link_only findings
  links_trigger_render: false       # a page whose only signal is a link is not a tier-1 hit
report:
  vendors: [esri, esri-enterprise]  # esri = ArcGIS Online / JS API; esri-enterprise = ArcGIS Enterprise & Geocortex on county hosts
```

Links to Esri apps are recorded and flagged (so an org item that pages link to is not
mis-reported as orphaned) but never cause a page to be rendered on their own. Links inside map
attribution controls ("© OpenStreetMap", "Powered by Esri") are always ignored. Department
attribution is deliberately not derived: the URL, title and stored HTML are all in the database
for that offline step.

## Crawl scope

Scope is data, not code — `config.yaml` → `scope`:

```yaml
crawl_allowlist: [www.smcgov.org]              # crawled fully, every path
normalize_to_www: { smcgov.org: www.smcgov.org }  # alias, same site
never_crawl: ["*.smcgov.org", "*"]             # never enqueued, but ALWAYS recorded when referenced
record_always: true
```

Maps pointing at `smcmaps.maps.arcgis.com`, `gis.smcgov.org`, `arcgis.com`, Google My Maps or
anything else are recorded in full — they are simply not crawled into. The report states this
boundary explicitly: other county hosts were not crawled, so the inventory covers one site rather
than the county's entire web presence.

URL normalization before queueing: lowercase host, strip fragment, strip trailing slash, strip
`utm_*`/`fbclid`/`gclid`/`mc_cid`/`mc_eid`, preserve all other query params, skip non-HTML
assets by extension, dedupe. `robots.txt` `Disallow` rules are respected (disallowed URLs are
recorded as `skipped/robots_disallow`, never fetched). Hard cap 50,000 URLs, logged loudly.

**Rate and Crawl-delay.** www.smcgov.org's robots.txt declares `Crawl-delay: 10`. The shipped
config sets `http.respect_crawl_delay: false` because the web team approved the faster rate
(2026-09-17) on condition of being notified before each crawl; `run-crawl --plan` prints the
notice to send them. The run then goes at `requests_per_second_per_host: 2` page requests per
second — the rate validated live with no 403/429 — and about 4–5 hours end to end. Concurrency
does not multiply that: the limiter is one per-host gate shared by all workers; workers exist
because a render spends most of its time waiting for the page's JavaScript. Rendered pages also
load their own CSS/JS/images like a browser, so logs will show short asset bursts. Set
`respect_crawl_delay: true` to honour the directive instead (roughly 40 hours). Either way the
choice is announced loudly at startup.

## Outputs (`output/`)

| File | Grain |
|---|---|
| `applications.csv` | one row per unique application: identity, vendor, app kind (Web AppBuilder, Experience Builder, Dashboard, …), hosting (ArcGIS Online / ArcGIS Enterprise), type, title, occurrence count, embedded vs linked vs nav page counts, `linked_only`, in-county-org flag, screenshot path, example URL |
| `occurrences.csv` | one row per (page, application) pair in page content, with placement and how it appears (`--include-chrome-occurrences` to also enumerate nav/footer presence per page) |
| `findings.jsonl` | every raw finding with all matched signals |
| `report.html` | totals by vendor / kind / type, the ArcGIS buckets (**External** first — apps on county pages not in the county org; then embedded, linked-only, Enterprise-hosted, in-page JS API, orphaned), unrestricted-key list, screenshot gallery, and a **coverage section** (discovered / crawled / rendered / failed / skipped / pending, cap reached, tier-2 sample hit rate) |
| `summary.json`, `preflight.json` | machine-readable summaries |

## Data model (SQLite, `inventory.sqlite`)

`runs`, `urls` (queue + per-URL status, tiers, `chrome_keys`), `pages` (gzipped HTML of every
fetched page), `findings` (raw grain), `requests` (matched network requests per rendered page),
`applications` (deduplicated grain), `arcgis_items` (org enumeration + individually looked-up
external items), `meta`. See `src/lib/db.js`.

**Searching for hosts you did not think of up front.** Two things make a later question
answerable without a new crawl: every page's HTML is in `pages` (`SELECT url, html_gz FROM pages`,
`zlib.gunzipSync`, then grep or re-run `detectStatic()` from `src/lib/tier1.js` with an edited
`rules.yaml`), and every request a rendered page made is in `requests` — matched rules with
`matched_rule` set, everything else with it NULL (`scan.record_all_requests`, query strings
stripped, deduped per page, capped at 400). Rules match by host and path pattern, so a new host is
a one-line rule, not a list of URLs.

ArcGIS Online hosted services (`services.arcgis.com`, `tiles.arcgis.com`) get their own identity,
`arcgis:service:<orgId>/<ServiceName>`; the org id in the URL sets `in_county_org` in the
cross-reference, so a JS API map's layers are attributed even though they are not items.

## Extending the rules

Everything detection-related lives in `rules.yaml`; no code changes needed:

- `network.hosts` — vendor hostnames (globs; `host/path*` form allowed), `network.paths` — OGC /
  service paths, `network.tile_pattern`, `network.static_map_apis`.
- `embeds` — iframe `src` / link `href` patterns (regex). First match wins; order specific → generic.
- `globals` (JS expressions evaluated in the page), `selectors` (CSS, shadow roots pierced),
  `static_html` (regex on raw HTML for tier 1).
- `map_adjacent.patterns` — path/title words that force a tier-2 render.
- `interaction` — click text regex and tab/accordion control selectors.
- `placement.chrome_selectors` / `main_content_selectors` — site chrome classification.
- `identity.identifying_params` — query params that distinguish applications sharing a path.
- `cmp` — consent platform globals, asset patterns, accept-button regex, cookies to inject.

Every rule carries `vendor`, `type` and `confidence` (`high|medium|low`). Add a rule, re-run
`scan --url <page>` to re-scan a specific page, then `report`.

## Validation

`npm test` runs `test/run-validation.js` against a local fixture site (`test/fixture-site/`)
that reproduces the spec's ground-truth cases: the Digital Equity Portal ArcGIS iframe
(`arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1`, `main_content`, caught by tier 1), a
privacy-policy page with only site-chrome findings, the mega-menu road-closures app and
`gis.smcgov.org/Html5Viewer/` classified `site_chrome` with no per-page finding rows, a zoning
page linking to a map, a JS-initialised Leaflet map, a click-revealed My Maps iframe, a shadow-DOM
iframe, a non-geographic seating chart, robots/redirect/asset handling, a mock ArcGIS org with
embedded / orphaned / external / unreadable items, plus a Ctrl-C-mid-scan-and-resume test
(no lost, no duplicated work). It reports precision/recall for main-content detection.

## Non-goals

No backend/CMS access, no authentication, no form submission or state-changing requests, no
crawling of hosts other than www.smcgov.org, no scheduling or run-over-run diffing, no bypassing
of access controls.
