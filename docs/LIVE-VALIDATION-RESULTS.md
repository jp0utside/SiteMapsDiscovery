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
