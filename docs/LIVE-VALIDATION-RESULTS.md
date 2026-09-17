# Live validation results — www.smcgov.org (2026-09-14)

Results of running [LIVE-VALIDATION.md](LIVE-VALIDATION.md) against the live site. All eight
"What to hand back" items are below. **Verdict: every Step 1 check passed and no 403/429 responses
were seen, but robots.txt `Crawl-delay: 10` is not honoured (see §8) and should be decided before
the full crawl.**

## Run conditions

- Database: `validation.sqlite` on every command. `inventory` was only run with `--no-crawl`;
  `scan` was only run with `--url` or `--limit`.
- Node: the project requires Node ≥ 20 (`package.json` engines) but the machine's default is
  v18.20.8, which fails (`ReferenceError: File is not defined` from undici). Everything was run
  under nvm Node v22.20.0 after `npm rebuild` (for `better-sqlite3`).
- `config.yaml` → `http.user_agent` contact set to the placeholder `inventory@smcgis.org`.
- Fixture harness: `npm test` → **60/62** (runbook expects 61/61). The environment is fine; the
  failure is a fixture false positive: `/tsd/mapbox-page` reports an unexpected
  `iframe:www.mapbox.com/` (`map_link_only`, `link`), which drops main-content precision to 90.9%.
- Pages fetched: roughly 270 (5 ground truth + 30 preflight + 102 + 61 + 7 + 61), above the
  runbook's ~150 estimate. The extra 61 came from a first Step 6 attempt in which SIGINT reached
  the wrapping subshell rather than node, so that `--limit 60` scan ran to completion before the
  interrupt test was repeated correctly.
- The runbook's inline `node -e` queries use double-quoted string literals
  (`placement="main_content"`), which this SQLite build rejects
  (`no such column: "main_content"`). The same queries were run with single quotes.

## 1. Ground-truth pages (Step 1)

| # | Result | Actual value |
|---|---|---|
| 1a | PASS | Digital Equity Portal page has `arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1` |
| 1b | PASS | `placement = main_content` |
| 1c | PASS | `tier = 1`, `signal_type = iframe`, confidence `high`, container `iframe#iframe-field_media_inline_frame-96` (tier 2 also found it) |
| 1d | PASS | `arcgis_org = smcmaps` |
| 2a | PASS | `/privacy-policy` has 0 `main_content` findings |
| 2b | PASS | `chrome_keys = ["arcgis:item:c7075a28b298498c93a311b7af9a3ae7","iframe:gis.smcgov.org/Html5Viewer/"]` |
| 3 | PASS | `iframe:gis.smcgov.org/apps/publicviewer/` ("View Planning GIS"), type `map_link_only`, signal `link` (`a#gis-link`), tiers 1 and 2. The page links to the viewer; it has no embedded map. |
| 4 | info | `/tsd/gis`: `iframe:gis.smcgov.org/apps/raster` ("Property Records") and `iframe:gis.smcgov.org/apps/beach` ("Beach Monitoring"), both `map_link_only` table links |
| 5a | PASS | One `applications` row each: "Road Closures" (esri) and "Recorded Property Maps" (vertigis), `occurrence_count = 5` |
| 5b | PASS | Both rows in `applications.csv`: `main_content_pages = 0`, `site_chrome_pages = 5`, `placement_summary = site-wide navigation` |
| 5c | PASS | `COUNT(*)` = 1 |
| 6 | PASS | `report.html` opens; image link `../../screenshots/a9bd53474840bc33.jpg` resolves; the screenshot shows only the Public WiFi Locations map app |
| 7 | PASS | 5/5 `done`, all `http_status = 200`, 0 failed |

The five pages scanned in 42 s. Site-chrome exemplars were detected in
`li.main-nav--list-item-sub` menu items, so the existing placement rules already cover the
mega-menu.

## 2. Edits to rules.yaml

None. 2b and 5b passed without changes, so no chrome selectors had to be added.

## 3. Preflight conclusion (Step 2)

```
================ PREFLIGHT CONCLUSION ================
Pages sampled:               30
CMP present:                 NO (no CMP globals or vendor assets observed)
Map hosts gated by consent:  NONE
Decision:                    scan runs WITHOUT consent handling
Written:                     output/preflight.json
======================================================
```

Matches the expected result.

## 4. Sitemap and robots discovery (Step 3)

| Item | Value |
|---|---|
| Sitemap locs seen | 11,584 |
| New URLs queued | 11,577 (the other 7: the 5 Step 1 URLs already present, plus 2 skipped) |
| Sub-sitemaps | 6: `sitemap.xml?page=1` … `?page=6` (2000 × 5 + 1584) |
| robots.txt | 64 rules for our UA, 1 sitemap declaration, **`Crawl-delay: 10`** |
| Skipped `robots_disallow` | 2: `/tsd/news`, `/dem/news` (matched `Disallow: /*/news$`) |
| URLs on other hosts | 0 |
| URLs with query strings | 0 |
| Non-HTML extensions | 0 |

Robots `Disallow` rules seen: Drupal defaults (`/core/`, `/profiles/`, `/admin/`, `/user/*`,
`/node/add/`, `/search/`, `/media/oembed`, `/index.php/…`), plus site additions `/search`,
`/search*`, `/news$`, `/*/news$`, `/news?*`, `/*/news?*`, and facet filters `/*?f[*`, `/*&f[*`,
`/*?f%5B*`, `/*&f%5B*` (with `Allow: /news/*` and `Allow: /*/news/*`).

## 5. ArcGIS org cross-reference (Step 4)

- Org: **`yq3FgOI44hYHAFVZ`** ("San Mateo County", `smcmaps.maps.arcgis.com`), resolved from
  `portals/self`.
- Public items: 1,243 stored, all `in_org = 1`. Cross-reference: 2 embedded, 1,241 orphaned,
  0 external, 0 unknown.

| Type | Items |
|---|---|
| Web Map | 595 |
| Web Mapping Application | 302 |
| Web Experience | 127 |
| Dashboard | 110 |
| Form | 51 |
| StoryMap | 43 |
| Hub Page | 7 |
| Hub Site Application | 5 |
| Web Scene | 3 |
| Instant App | 0 |

| identity_key | in_county_org | title (from item metadata) |
|---|---|---|
| `arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1` | 1 | SMC Public WiFi Locator App |
| `arcgis:item:c7075a28b298498c93a311b7af9a3ae7` | 1 | CZU Fire - Road Closure Map |

## 6. Bounded tier-1 + tier-2 timing sample (Step 5)

`scan --limit 100 --concurrency 3`: **102 pages in 3m26s (205.9 s) ≈ 30 pages/min**, 55 hits,
63 rendered, 0 failed.

| tier2_reason | Pages (of 102) | Share |
|---|---|---|
| `hit` | 55 | 54% |
| `sample` | 8 | 8% (≈17% of the 47 tier-1 misses; configured rate 20%) |
| `pattern` | 0 | **0%** |
| none (not rendered) | 39 | 38% |

(Including the 5 Step 1 pages, the database showed hit 58, manual 2, sample 8, none 39.)

- HTTP status distribution: 200 for all pages (107 after Step 5, 236 by the end of all runs).
  No 403, 429, or other codes; no `final_url` differed from `url`.
- Extrapolated full site at concurrency 3 and 2 req/s: 11,584 ÷ 30/min ≈ **6.5 hours** (the tool's
  own ETA was 6h19m). This depends heavily on the hit rate. A later 60-page batch at concurrency 2
  hit 95% and the tool estimated 12h30m, so plan for **6.5–12 hours**. At the robots.txt
  `Crawl-delay: 10`, it would be over 32 hours.

## 7. Ctrl-C resume (Step 6)

| Stage | Result |
|---|---|
| Interrupt | SIGINT at 25 s → `Ctrl-C: no new pages will be claimed; waiting for in-flight pages`; exited by itself 2 s later, exit 0, `interrupted: true`, 7 pages completed |
| After interrupt | done 175, pending 11,407, skipped 2, **0 `in_progress`** |
| Resume run | 61 completed, exit 0, 0 failed |
| After resume | **0 `in_progress`**, **0 duplicate finding groups** |

PASS.

### Step 7: final report

`report --out output/validation` → `applications.csv` (82), `occurrences.csv` (162),
`findings.jsonl` (325). The Coverage section matches the database: 11,584 discovered, 236 crawled
(tier 1), 174 rendered (tier 2), 0 failed, 2 skipped (`robots_disallow`), 11,346 pending, sample
hit rate 0.0% (0/14), with the "scan did not finish" notice. The scope-boundary notice is present.

## 8. Unexpected findings

1. **`Crawl-delay: 10` is not honoured.** `src/lib/robots.js` parses `crawlDelay`, but nothing
   uses it. The rate limiters (`src/lib/fetch.js`, `src/commands/scan.js`) use only
   `http.requests_per_second_per_host` (2/s), about 20× the pace robots.txt requests. No WAF
   reacted at validation scale, but a full crawl should either enforce the delay or have the
   faster rate explicitly approved by the site owner.
2. **"Get Directions" Google Maps links dominate hits.** Across 236 pages the tool found
   323 `main_content` findings: 312 `map_link_only` and 11 `gis_application`. Of the 312
   link-only findings, 306 are `google.com/maps` "Get Directions" links, and 73 of the 82
   applications are Google Maps link identities. Because a hit triggers
   tier 2, these links drive rendering volume and run time. They are likely noise for a
   map-application inventory.
3. **Fragmented Google Maps identities.** Each address becomes its own application
   (`iframe:google.com/maps?q=455 County Center Room 402 …`), and some links are keyed by opaque
   hashes (`iframe:google.com/maps?q=h6536031dcc7782b4`). 82 applications came from 236 pages,
   but the report counts only 4 excluding link-only and non-geographic entries.
4. **Trailing-slash duplicate identity:** `iframe:gis.smcgov.org/gis_exchange/SHARED_RESOURCES/PAGES/HSA`
   and `…/HSA/` are separate applications.
5. **`iframe:` prefix on link-only identities:** keys such as `iframe:gis.smcgov.org/Html5Viewer/`
   are links, not iframes. This is cosmetic but can confuse readers of the CSV.
6. **Stale site-wide navigation link:** the "Road Closures" menu item on every page points at
   the 2020 "CZU Fire - Road Closure Map" (`c7075a28…`).
7. **`--limit` overshoots slightly:** `--limit 100` completed 102 pages; `--limit 60` completed 61.
8. **Runbook and environment issues** (see Run conditions): the Node ≥ 20 requirement is not
   enforced at startup, the runbook's SQL quoting fails on current SQLite, and the fixture
   harness has one false positive (60/62).

No WAF responses, consent banners, page timeouts, or redirects to other hosts were observed.

The full crawl was not launched. That decision rests with a human after the security/network
team has been notified.

## 9. Decisions before the full crawl (review of 2026-09-14)

Review of the results above, with the decisions they raise, the implications of each, and the
recommendation reached in discussion. Items marked **open** still need a human decision; items
marked **agreed** are ready to implement.

### 9.1 Crawl-delay: 10 — **open**

robots.txt asks for 10 seconds between requests. The tool parses the directive
(`src/lib/robots.js`) but nothing enforces it; the per-host limiter runs at
`http.requests_per_second_per_host = 2`, about 20× the requested pace. No WAF or rate limiter
reacted during validation (236 pages, all HTTP 200).

Implications:

| Rate | Tier 1 (11,584 fetches) | Tier 2 renders | Total wall clock |
|---|---|---|---|
| 2 req/s, concurrency 3 (as validated) | ~1.6 h | ~7,200 today / ~2,900 after §9.2 | 6.5–12 h today; **~4–5 h after §9.2** |
| Crawl-delay 10 (one page fetch or navigation per 10 s) | ~32 h | ~20 h today / ~8 h after §9.2 | ~50 h today; **~40 h after §9.2** |

The floor under the slow option is tier 1: every one of the 11,584 URLs must be fetched once,
and no detection change can reduce that. Only crawling fewer URLs would, which contradicts the
full-crawl requirement.

Interpretation if the delay is honoured: 10 s between *page* fetches and *page* navigations,
with a rendered page's own CSS/JS/image loads from the host treated as part of that page.
Applying the delay to every subresource would make tier 2 impossible.

Recommendation: since the county owns the site and this is its own audit, ask the web/security
team to explicitly approve the 2 req/s rate and record that approval, rather than running for
two days. Either way the choice should be deliberate: add a config switch
(`http.respect_crawl_delay`) that enforces the directive when on, and log the effective rate and
ETA at startup so the run announces which mode it is in.

### 9.2 "Get Directions" links and tier-2 scheduling — **agreed**

Two distinct changes were discussed; they are easy to conflate.

**What a link-only finding is.** An ordinary `<a href>` on a www.smcgov.org page whose target
matches a map-application pattern. The page itself contains no map. Three kinds turned up:

1. Links to genuine county applications (the mega-menu "Road Closures" app, the `/tsd/gis`
   links to the Property Records and Beach Monitoring viewers, the zoning page's "View Planning
   GIS"). These are real applications and the spec asks that they be recorded and flagged
   `map_link_only`, not dropped.
2. "Get Directions" links to `google.com/maps?q=<address>` on office and contact pages.
   306 of the 312 link-only findings in the sample were these; each address became its own
   application row, so 73 of the 82 application rows are noise.
3. Attribution links (`© Mapbox`, `© OpenStreetMap`) that map libraries inject inside the map
   itself. These caused the single fixture false positive on the local machine and would recur
   on any live Leaflet/Mapbox page.

**Change A — collapse the identities (reporting only).** Fold every Google Maps directions,
place and search link into one flagged application ("Google Maps directions links") with an
occurrence count instead of one row per address. Ignore links inside attribution controls.
This changes how findings are keyed and what the CSVs show. It has **no effect** on network
calls, CPU or run time.

**Change B — link-only findings no longer count as a tier-1 hit.** Today any `main_content`
finding, including a directions link, marks the page a hit, and every hit is rendered in
Chromium. In the 102-page sample that made 54% of pages hits when only about 5% had an embedded
map. After the change a page is rendered only if it has an embedded/in-page map signal, matches
the map-adjacent path/title list, or falls in the 20% random sample. Estimated renders drop from
~7,200 to ~2,900 (roughly 60% less tier-2 work). Nothing is lost: a link to a county ArcGIS app
is visible in the static HTML, so tier 1 still records it with the correct identity.

Change B is the lever on effort and is what brings the 2 req/s run down to a single afternoon.
It does **not** make the Crawl-delay option feasible (see §9.1): it trims tier 2 from ~20 h to
~8 h under that option, but the 32 h tier-1 floor is untouched.

Kind 1 above is unaffected by either change and remains in the inventory.

### 9.3 Identity-key cosmetics — **agreed**

- The `iframe:` prefix on link-only keys (e.g. `iframe:gis.smcgov.org/Html5Viewer/`) matches the
  spec's own expected identity for the mega-menu link, so it stays. It denotes the
  "origin + path" identity rule regardless of whether the target was embedded or linked; document
  this in the README.
- The trailing-slash duplicate (`…/PAGES/HSA` vs `…/PAGES/HSA/`) is a real bug: normalise the
  path in identity keys so both forms produce one application.

### 9.4 Content finding for the final report — **noted**

The site-wide "Road Closures" menu item on every page points at the 2020 "CZU Fire - Road
Closure Map" (`c7075a28…`). This is an inventory finding about the site, not a tool issue; it
belongs in the narrative of the final report.

### 9.5 Fixes to make before the full run — **agreed**

- Ignore links inside map attribution controls (`.leaflet-control-attribution`,
  `.mapboxgl-ctrl-attrib`, `.ol-attribution`, `.esri-attribution`, `.gm-style-cc`, and links
  whose text begins with "©").
- Enforce the Node ≥ 20 requirement at startup with a clear message (the local machine's
  default Node 18 failed inside undici).
- Make `--limit` exact instead of overshooting by up to the concurrency count.
- Fix the SQL quoting in the runbook's inline `node -e` queries (single quotes for string
  literals).
- README note on the identity-key convention (§9.3).
- Config switch and startup logging for Crawl-delay (§9.1), whichever way that decision goes.

### 9.6 Steps from here

1. Settle §9.1 with the site owner; confirm §9.2 (both changes) — recommendation: apply both.
2. Apply the fixes in §9.2, §9.3 and §9.5; re-run the fixture harness; push for a second PR.
3. Local agent re-runs runbook Step 1 and the 100-page timing sample to confirm the reduced
   tier-2 share and produce a fresh duration estimate.
4. Notify the security/network team with the User-Agent string, the approved rate, and the
   planned window.
5. Launch `inventory`, then `scan` with `--max-runtime` sized to the window (resume as needed),
   then `arcgis` and `report`.

### 9.7 Scope change and implementation status (2026-09-16)

Further context narrowed the audit's subject to **ESRI / ArcGIS Online items embedded in county
pages**; PDFs and Google Maps links are out of scope. Rather than removing rules, the scope is
now configuration (`config.yaml → detection`), so the wider ruleset stays available:

| Item | Status |
|---|---|
| Vendor allowlist `detection.vendors: [esri, esri-enterprise]` | implemented; other vendors' rules stay in rules.yaml but are inert |
| ArcGIS Enterprise / Geocortex viewers on county hosts (§9.2 kind 1, decision: include) | implemented as vendor `esri-enterprise`, reported in their own group |
| Esri links recorded and flagged, never a render trigger (§9.2 change B, decision: keep) | implemented: `detection.record_links: true`, `detection.links_trigger_render: false` |
| Google directions links collapse to one identity (§9.2 change A) | implemented via `identity_key:` on the embed rule; moot under the Esri-only scope |
| Attribution-link suppression (§9.5) | implemented (`placement.ignore_link_selectors` / `ignore_link_text_regex`) |
| Trailing-slash identity duplicate (§9.3) | fixed: extension-less paths normalised to a trailing slash |
| Crawl-delay (§9.1) | implemented: `http.respect_crawl_delay` (default **true**), announced loudly at startup; decision to override still rests with the site owner |
| Node ≥ 20 check, exact `--limit`, runbook SQL quoting (§9.5) | done |
| Sample rate | unchanged at 20% (decision: keep) |
| Report | applications now carry `app_kind`, `hosting`, `embed_pages`, `linked_only`; report.html adds Linked-only, Enterprise-hosted and in-page JS API groups and states the detection scope |

Fixture harness: 83/83 (a third phase runs the fixture under the production Esri-only scope).

### 9.8 Web-team approval, purpose clarification and run configuration (2026-09-17)

- **Rate (§9.1 resolved).** The web team approved exceeding the robots.txt `Crawl-delay`
  ("as long as I am not firing like 1000 requests a second") on condition of being told before
  each crawl. Settled at **2 page requests/s, 3 pages in flight** — the rate validated live with
  no 403/429, within an order of magnitude of the ~1 req/s courtesy convention used by Wikipedia's
  bot policy, Common Crawl and the Internet Archive. `http.respect_crawl_delay: false` in
  config.yaml; startup announces `OVERRIDDEN`.
- **Purpose.** The GIS team wants to know where AGOL web maps/apps are located on the SMC site and
  which department posts them, to update, take down, or coordinate. PDFs and Google Maps links are
  out of scope. Department attribution is deferred to offline analysis (URL, title and now the
  full stored HTML are in the database).
- **One sanctioned session.** Because each crawl requires a notification, the crawl collects
  broadly and the report filters narrowly: `detection.vendors: []` (record everything),
  `report.vendors: [esri, esri-enterprise]`, `inventory.store_html: all` (gzipped HTML of every
  page, ~150–250 MB, re-analysable offline without recrawling).
- **Storage.** Screenshots are not the heavy item (~5–15 MB for ~100 identities); the whole run
  is ~50–100 MB of database plus the stored HTML. Screenshots can be skipped
  (`--screenshots none`) and captured later with the new `screenshots` command (one visit per
  application, ~100 navigations).
- **`run-crawl`** wraps inventory → scan → arcgis → report with the settled configuration,
  prints the plan and the web-team notice (`--plan`), prompts once, and is resumable.
- User-Agent contact set to `jwarsaw@smcgov.org`.

Fixture harness: 96/96 (Phase D exercises `run-crawl`, stored HTML, the report filter and the
`screenshots` catch-up command).
