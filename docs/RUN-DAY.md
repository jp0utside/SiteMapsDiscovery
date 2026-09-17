# Run day: crawling www.smcgov.org

Personal checklist for the sanctioned crawl. Everything decided so far is already in
`config.yaml`; this file is the order of operations and what to watch.

## 1. The day before (15 minutes)

```bash
git pull
npm install
npx playwright install chromium      # only needed once per machine
node --version                       # must be 20 or newer; the CLI refuses otherwise
df -h .                              # want at least 500 MB free (plus Chromium, already installed)
node bin/cli.js run-crawl --plan     # prints the plan; the "robots.txt fetched" line must say HTTP 200
```

Optional but reassuring: `npm test` runs the fixture harness (about 10 minutes, no live traffic)
and should end with `104/104 checks passed`.

**Your IP address**, for the web team:

```bash
curl -s https://api.ipify.org
```

Run it now and again in the morning, ideally after a reboot. Same answer both times means it
is fixed and worth giving them. If it differs, or you are on a VPN that may drop, give them the
User-Agent only. The UA is on every request and is the better identifier for their logs anyway:

```
SMC-Map-Inventory/1.0 (internal web audit; contact: jwarsaw@smcgov.org)
```

**Machine prep.** Plug the laptop in, use wired or stable Wi-Fi, and stop it sleeping for the
run. On macOS prefix the command with `caffeinate -i`; on Windows set the power plan to never
sleep while plugged in; on Linux use `systemd-inhibit`. If the machine sleeps, the crawl pauses
and resumes when it wakes; nothing is lost, but the ETA slips.

## 2. Notify the web team

`run-crawl --plan` prints a ready-to-send paragraph under "Text for the web team". Send it with
your IP (if fixed), the start time, and "roughly 4 to 5 hours". Ask them to tell you if they see
anything they do not like, and tell them you will confirm when it finishes.

## 3. Start

```bash
node bin/cli.js run-crawl
```

Answer `y` at the prompt. What happens, in order:

| Phase | What it does | Expected duration |
|---|---|---|
| inventory | reads the sitemap index (about 11,600 URLs), then crawls every page once at 2 req/s, detecting maps in the HTML and storing each page gzipped | about 1.6 h |
| scan | renders in Chromium the pages that had an embedded map, the map-adjacent ones, and a 20% sample of the rest; takes screenshots | about 2 to 3 h |
| arcgis | pulls the public item list from smcmaps.maps.arcgis.com and classifies what was found | minutes |
| report | writes `output/` | under a minute |

Leave the terminal open. In a second terminal, any time:

```bash
node bin/cli.js status
```

## 4. What to watch

**Healthy** looks like this:

- A `crawl:` line every 25 pages (inventory) or `progress:` every 10 (scan), with `http last 25: 200×25`
  or close to it, an application count that grows early then flattens, and an ETA that shrinks.
- `NEW application …` lines. Expect a burst early (the two site-wide navigation apps appear on
  the very first page) and then occasional ones. Most will be `esri` and `esri-enterprise`;
  `google` and `leaflet` lines are fine, they are recorded but filtered out of the report.
- The occasional `retry 1/3` warning. Single timeouts happen.

**Look closer** when you see:

- `HTTP 403` / `429` / `503` warnings, or those codes in the `http last 25` mix. The tool retries
  them and does not mark the page skipped. A few scattered ones are normal; a run of them is not.
- `failed` climbing in the progress line. `status` lists the last five with their error text.
- No progress line for more than five minutes. Run `status` and look at `in progress now`; if the
  same URLs sit there for a long time the site is slow or a page is hanging. It will time out
  and retry on its own.
- `URL cap of 50000 reached`. Should not happen (the site has about 11,600); if it does, discovery
  is truncated and the report will say so.

**Stop everything** when you see the banner:

```
!! HOST IS REJECTING REQUESTS (last 25: 200×3 403×22). Stopping the crawl so the inventory is not falsely clean.
```

The tool has already stopped itself at that point and left unfinished pages pending. Nothing is
marked clean. Message the web team, find out what tripped (firewall, rate limit, outage), and
when it is resolved simply run `node bin/cli.js run-crawl` again to resume. `status` shows
`BLOCKED` with the time and status mix until the resumed run completes.

## 5. Stopping and resuming

- **Ctrl-C once**: stops taking new pages, lets the ones in flight finish (up to about 30 seconds),
  exits cleanly. Progress is saved. **Ctrl-C twice**: exits immediately; the next start cleans up.
- **Resume**: `node bin/cli.js run-crawl` again. Each phase picks up where it stopped.
- **Bound the run**: `node bin/cli.js run-crawl --max-runtime 120` stops the scan phase after two
  hours and still produces a (partial) report; re-run to continue.
- **Save disk or time**: `--screenshots none`, then later `node bin/cli.js screenshots` captures
  one image per application with a single visit each.

## 6. When it finishes

The terminal prints `run-crawl finished in …` with per-phase timings and the output paths.

1. Open `output/report.html`. Check the **Coverage** section first: pending should be 0, failed
   small (a handful of dead pages is normal), and the tier-2 sample hit rate should be low. A
   non-zero sample hit rate means static detection missed embedded maps on some pages and is
   worth a look.
2. Sanity-check known items in `output/applications.csv`: the Public WiFi Locator
   (`arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1`) as an embedded content app, and the Road
   Closures app (`arcgis:item:c7075a28b298498c93a311b7af9a3ae7`) plus
   `iframe:gis.smcgov.org/Html5Viewer/` as site-wide navigation with occurrence counts in the
   thousands.
3. The GIS team's answer is the ArcGIS cross-reference section: **Embedded**, **Linked only**,
   **External** (apps on county pages that are not in the county org), **Unknown ownership**,
   **Enterprise-hosted**, and **Orphaned**. `occurrences.csv` gives the page for each so
   departments can be attributed offline.
4. Tell the web team the crawl is done.
5. **Back up `inventory.sqlite`.** It holds every finding plus the gzipped HTML of every page.
   The CSVs and report can be regenerated from it at any time with `node bin/cli.js report`,
   including with a different `report.vendors` list in `config.yaml`, with no new crawl.

## 7. If something goes wrong

| Symptom | What to do |
|---|---|
| `requires Node.js 20 or newer` | switch with nvm/fnm, then `npm rebuild` (better-sqlite3 is compiled per Node version) |
| `Executable doesn't exist` from Playwright | `npx playwright install chromium` |
| `robots.txt fetch: FAILED` in the plan | no network path to www.smcgov.org; check VPN / proxy before starting |
| `no space left on device` | delete `screenshots/` (recapture later with `screenshots`) or set `inventory.store_html: hits` in config.yaml before resuming |
| Crash or forced kill mid-run | just re-run `run-crawl`; rows stuck `in_progress` reset after 10 minutes, or immediately with `node bin/cli.js scan --reset-in-progress` |
| Report looks thin | run `node bin/cli.js status`; if `pending` is not 0 the run did not finish; resume |
| `arcgis cross-reference failed` | the crawl is unaffected; run `node bin/cli.js arcgis` then `node bin/cli.js report` later |

## 8. Numbers to expect

From the 236-page live validation, scaled to the full site. Treat as ballpark, not targets.

| | Expected |
|---|---|
| URLs discovered | about 11,600 |
| Pages with an embedded Esri app in content | a few percent, so a few hundred |
| Distinct Esri applications | tens, not hundreds |
| Site-wide navigation apps | 2, each on essentially every page |
| Public items in the county ArcGIS org | about 1,240 |
| Database size | 50 to 100 MB plus 150 to 250 MB of stored HTML |
| Screenshots | 5 to 15 MB |
