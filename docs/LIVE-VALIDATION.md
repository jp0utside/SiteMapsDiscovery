# Live validation against www.smcgov.org (spec §14)

Instructions for an agent running on a machine that can reach `www.smcgov.org`,
`smcmaps.maps.arcgis.com` and `www.arcgis.com`. The tool has already passed a 61-check
validation against a local fixture (`npm test`); what remains is confirming the same behaviour
against the real site before anyone launches the full crawl.

**Hard rule: this is validation only. Do NOT run the full crawl** (`inventory` without
`--no-crawl`, or an unbounded `scan`). Stop after Step 7 and hand back the results below.
Everything here touches at most ~150 pages.

## 0. Setup

```bash
npm install
npx playwright install chromium
```

Edit `config.yaml` → `http.user_agent` and replace `<FILL IN>` with a real contact email.
Confirm nothing on the machine proxies or blocks HTTPS to the three hosts above:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://www.smcgov.org/sitemap.xml            # expect 200
curl -sS "https://smcmaps.maps.arcgis.com/sharing/rest/portals/self?f=json" | head -c 200  # expect JSON with "id"
```

Run the fixture harness once to prove the environment works: `npm test` → expect `61/61 checks passed`.

Use a dedicated database for everything below so nothing pollutes a later production run:
`export DB=validation.sqlite` and pass `-d $DB` to every command.

## 1. Ground-truth pages (the core §14 check)

```bash
node bin/cli.js -d $DB scan --url \
  https://www.smcgov.org/ \
  https://www.smcgov.org/tsd/san-mateo-county-digital-equity-portal \
  https://www.smcgov.org/privacy-policy \
  https://www.smcgov.org/planning/gis-map-zoning-and-other-info-0 \
  https://www.smcgov.org/tsd/gis
node bin/cli.js -d $DB report --out output/validation
```

Then inspect the database. `sqlite3` may not be installed; this works anywhere:

```bash
node -e '
const db = require("better-sqlite3")(process.env.DB, { readonly: true });
console.log("\n== urls"); console.table(db.prepare("SELECT url, status, http_status, tier1_done, tier2_done, tier2_reason, tier1_hit, tier2_hit, chrome_keys, error FROM urls").all());
console.log("\n== main-content findings"); console.table(db.prepare("SELECT url, identity_key, type, placement, signal_type, confidence, tier, container_selector FROM findings WHERE placement=\"main_content\" ORDER BY url").all());
console.log("\n== site-chrome exemplar findings"); console.table(db.prepare("SELECT identity_key, signal_type, container_selector, substr(signal_value,1,80) signal_value FROM findings WHERE placement=\"site_chrome\"").all());
console.log("\n== applications"); console.table(db.prepare("SELECT identity_key, vendor, type, title, occurrence_count, screenshot_path FROM applications").all());
'
```

Expected outcomes — record PASS/FAIL for each, with the actual values:

| # | Check | Expected |
|---|---|---|
| 1a | Digital Equity Portal page has a finding with `identity_key = arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1` | yes |
| 1b | … with `placement = main_content` | yes |
| 1c | … with `tier = 1` and `signal_type = iframe` (server-rendered HTML must be caught statically) | yes |
| 1d | … `arcgis_org = smcmaps` on that finding | yes |
| 2a | `/privacy-policy` has **no** `main_content` findings | yes |
| 2b | `/privacy-policy` row's `chrome_keys` contains both `arcgis:item:c7075a28b298498c93a311b7af9a3ae7` and `iframe:gis.smcgov.org/Html5Viewer/` | yes |
| 3 | `/planning/gis-map-zoning-and-other-info-0` has at least one `main_content` finding whose target is a map (record identity, type, signal) | yes; report what |
| 4 | `/tsd/gis` — record whatever is found (no fixed expectation) | informational |
| 5a | `applications` has exactly one row for `arcgis:item:c7075a28b298498c93a311b7af9a3ae7` and one for `iframe:gis.smcgov.org/Html5Viewer/` | yes |
| 5b | In `output/validation/applications.csv` both rows have `main_content_pages = 0`, `site_chrome_pages = 5`, `placement_summary = site-wide navigation` | yes |
| 5c | `SELECT COUNT(*) FROM findings WHERE identity_key='arcgis:item:c7075a28b298498c93a311b7af9a3ae7'` is small (≤ 4), i.e. not one row per page | yes |
| 6 | `output/validation/report.html` opens; the screenshot for the equity portal exists under `screenshots/` and shows the map, not the whole page | yes |
| 7 | No row in `urls` has `status = failed`; `http_status` is 200 for all five | yes |

### If 2b or 5b fail (mega-menu links classified `main_content`)

The placement classifier only knows generic landmarks plus a guessed list of Drupal region
classes. Look at `container_selector` on the offending findings and at the real DOM:

```bash
curl -sS https://www.smcgov.org/privacy-policy | grep -n -i -E "c7075a28|Html5Viewer" | head
```

Walk up from that link in the raw HTML and note the wrapper's tag, `role`, `id` and classes.
Add the wrapper's selector(s) to `rules.yaml` → `placement.chrome_selectors` (no code change
needed), then re-run the Step 1 `scan --url …` and `report` commands and re-check. Report the
selectors you added.

### If 1c fails (equity iframe only found by tier 2)

Save the HTML (`curl -sS <url> > equity.html`) and search it for `webappviewer`. If the iframe is
injected client-side after all, that is a finding about the site, not a bug; report it. If it is
present in the HTML but missed, report the surrounding markup so the tier-1 rules can be fixed.

## 2. Preflight (consent gating)

```bash
node bin/cli.js -d $DB preflight
```

Copy the `PREFLIGHT CONCLUSION` block into your results. Expected on this site: CMP present =
NO, map hosts gated by consent = NONE, decision = scan runs without consent handling. If the
verdict differs, keep `output/preflight.json` and report which hosts/signals triggered it.

## 3. Sitemap and robots discovery (no link crawl)

```bash
node bin/cli.js -d $DB inventory --no-crawl
node -e '
const db = require("better-sqlite3")(process.env.DB, { readonly: true });
console.table(db.prepare("SELECT source, status, COUNT(*) n FROM urls GROUP BY 1,2").all());
console.log(db.prepare("SELECT url FROM urls WHERE source=\"sitemap\" ORDER BY random() LIMIT 10").all());
console.log(db.prepare("SELECT value FROM meta WHERE key=\"robots_txt\"").get());
'
```

Record: number of sitemap URLs (expected roughly 10,000–12,000), number of sub-sitemaps logged
(expected six `?page=N` children, but the tool must not care), robots `Disallow` rules seen, and
how many URLs were skipped as `robots_disallow`. Note any surprises (URLs on other hosts, odd
query strings, non-HTML paths that slipped past the extension filter).

## 4. ArcGIS org cross-reference

Run this on the same database (it joins against the applications found in Step 1):

```bash
node bin/cli.js -d $DB arcgis
node -e '
const db = require("better-sqlite3")(process.env.DB, { readonly: true });
console.log(db.prepare("SELECT value FROM meta WHERE key=\"arcgis_org\"").get());
console.table(db.prepare("SELECT type, COUNT(*) n FROM arcgis_items WHERE in_org=1 GROUP BY type").all());
console.table(db.prepare("SELECT identity_key, arcgis_item_id, in_county_org, title FROM applications WHERE arcgis_item_id IS NOT NULL").all());
'
```

Expected: org id resolved from `portals/self`; a non-trivial number of public items; the equity
portal item `e04627c3dc7a4c38a6ebb9f0d5b8dff1` and the road-closures item
`c7075a28b298498c93a311b7af9a3ae7` marked `in_county_org = 1` with titles filled from item
metadata. If the search returns 0 items, capture the raw response of
`https://smcmaps.maps.arcgis.com/sharing/rest/search?f=json&num=10&q=orgid:<ORGID>` and report it.

## 5. Bounded tier-1 + tier-2 timing sample

With the sitemap-populated database from Step 3:

```bash
time node bin/cli.js -d $DB scan --limit 100 --concurrency 3
node -e '
const db = require("better-sqlite3")(process.env.DB, { readonly: true });
console.table(db.prepare("SELECT http_status, COUNT(*) n FROM urls WHERE tier1_done=1 GROUP BY 1").all());
console.table(db.prepare("SELECT tier2_reason, SUM(tier2_done) rendered, COUNT(*) n FROM urls WHERE tier1_done=1 GROUP BY 1").all());
console.log(db.prepare("SELECT summary_json FROM runs WHERE command=\"scan\" ORDER BY id DESC LIMIT 1").get());
'
```

Record: elapsed time, pages/minute, how many of the 100 went to tier 2 and why, and the
`http_status` distribution. **Any 403 or 429 responses mean a WAF or rate limiter is reacting;
stop and report immediately** rather than continuing. Also report the share of URLs with
`tier2_reason = pattern` (the map-adjacent word list is broad and this number drives run time).

## 6. Ctrl-C resume on the live site

```bash
node bin/cli.js -d $DB scan --limit 60 --concurrency 2 &
sleep 25; kill -INT %1; wait
node -e 'const db=require("better-sqlite3")(process.env.DB,{readonly:true}); console.table(db.prepare("SELECT status, COUNT(*) n FROM urls GROUP BY 1").all())'
node bin/cli.js -d $DB scan --limit 60 --concurrency 2
node -e '
const db = require("better-sqlite3")(process.env.DB, { readonly: true });
console.log("in_progress:", db.prepare("SELECT COUNT(*) c FROM urls WHERE status=\"in_progress\"").get().c);
console.log("duplicate finding groups:", db.prepare("SELECT COUNT(*) c FROM (SELECT url, identity_key, signal_type, placement, signal_value, tier, COUNT(*) n FROM findings GROUP BY 1,2,3,4,5,6 HAVING n>1)").get().c);
'
```

Expected: after the interrupt the process exits on its own with no `in_progress` rows; after the
second run there are 0 `in_progress` rows and 0 duplicate finding groups.

## 7. Final report

```bash
node bin/cli.js -d $DB report --out output/validation
```

Open `output/validation/report.html` and confirm the Coverage section reflects the numbers
above (discovered, crawled, rendered, pending, sample hit rate) and the scope-boundary notice is
present.

## What to hand back

1. The Step 1 table with PASS/FAIL and actual values for every row.
2. Any edits made to `rules.yaml` (diff) and why.
3. The preflight conclusion block.
4. Step 3 counts (sitemap URLs, sub-sitemaps, robots rules, skipped).
5. Step 4 org id, item counts by type, and the in-org classification of the two known items.
6. Step 5 timing: pages/minute, tier-2 share by reason, HTTP status distribution, and an
   extrapolated duration for the full site at concurrency 3.
7. Step 6 result (in_progress count, duplicate count).
8. Anything unexpected: WAF responses, redirects to other hosts, consent banners, pages that
   time out, findings that look like false positives.

Then stop. Launching the full crawl is a separate decision for a human, made after the security
or network team has been notified.
