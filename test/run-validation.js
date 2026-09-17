// Validation harness (spec §14) against the local fixture site. Run: npm test
// 1. inventory → scan → arcgis → report → preflight on the fixture; assert every ground-truth case; print precision/recall.
// 2. Ctrl-C mid-scan, restart, assert no lost or duplicated work.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const PORT = 8765, BASE = `http://localhost:${PORT}`;
const CFG = ['-c', 'test/config.test.yaml'];
const DB = 'test/out/test.sqlite';
const results = []; let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const run = (args, opts = {}) => { const r = spawnSync('node', ['bin/cli.js', ...CFG, ...args], { encoding: 'utf8', ...opts }); if (r.status !== 0 && !opts.allowFail) { console.error(r.stdout, r.stderr); throw new Error(`command failed: ${args.join(' ')}`); } return r; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- fixture server
const server = spawn('node', ['test/fixture-site/server.js', String(PORT)], { stdio: 'inherit' });
server.on('exit', (c) => { if (c) { console.error(`fixture server exited with ${c} (port ${PORT} in use?)`); process.exit(2); } });
await sleep(700);
try {
  fs.rmSync('test/out', { recursive: true, force: true }); fs.mkdirSync('test/out', { recursive: true });
  console.log('\n=== Phase A: full pipeline on fixture site ===');
  run(['inventory']); run(['scan']); run(['arcgis']); run(['report']);
  const db = new Database(DB, { readonly: true });
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const u = (p) => BASE + p;

  // Ground truth: page → expected MAIN-CONTENT application identities (and type). Everything else on these pages is a false positive.
  const GT = {
    '/tsd/san-mateo-county-digital-equity-portal': [['arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1', 'gis_application']],
    '/privacy-policy': [],
    '/planning/gis-map-zoning-and-other-info-0': [['arcgis:item:aaaa1111bbbb2222cccc3333dddd4444', 'map_link_only'], ['iframe:maps.googleapis.com/maps/api/staticmap/?center=37.5,-122.3', 'static_map_image'], ['link:google.com/maps', 'map_link_only']],
    '/tsd/gis': [[`inpage:leaflet:${u('/tsd/gis')}:div#county-map`, 'interactive_webmap']],
    '/hsa/find-services': [['gmymaps:mid:1XyZ_abc123', 'interactive_webmap'], ['link:google.com/maps', 'map_link_only']],
    '/hsa/contact': [['arcgis:item:aaaa1111bbbb2222cccc3333dddd4444', 'map_link_only']],
    '/dpw/viewers': [['iframe:gis.smcgov.org/apps/publicviewer/', 'map_link_only']],
    '/parks/seating': [[`inpage:leaflet:${u('/parks/seating')}:div#seatmap`, 'non_geographic']],
    '/about/shadow-map': [['arcgis:item:ffff0000eeee1111dddd2222cccc3333', 'gis_application']],
    '/tsd/tableau': [['iframe:public.tableau.com/views/SMCDashboard/Map/', 'embedded_third_party'], ['arcgis:item:1234123412341234123412341234abcd', 'map_link_only']],
    '/tsd/mapbox-page': [['mapbox:style:smcgis/ckabc123def', 'interactive_webmap']],
    '/news/article-3': [], '/': [],
  };
  let tp = 0, fp = 0, fn = 0;
  for (const [p, expected] of Object.entries(GT)) {
    const found = new Map(q(`SELECT identity_key, group_concat(DISTINCT type) types, group_concat(DISTINCT signal_type) sig, MIN(tier) t FROM findings WHERE url=? AND placement='main_content' GROUP BY identity_key`, u(p)).map(r => [r.identity_key, r]));
    for (const [key, type] of expected) {
      const f = found.get(key);
      if (f) { tp++; const okType = f.types.split(',').includes(type); check(`${p} → ${key.slice(0, 60)} [${type}]`, okType, okType ? `signals=${f.sig} tier=${f.t}` : `type mismatch: ${f.types}`); found.delete(key); }
      else { fn++; check(`${p} → ${key.slice(0, 60)} [${type}]`, false, `MISSED; found: ${[...found.keys()].join(', ') || 'nothing'}`); }
    }
    for (const [key, f] of found) { fp++; check(`${p} unexpected ${key.slice(0, 70)}`, false, `false positive (${f.types}, ${f.sig})`); }
  }
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1;
  console.log(`\nMain-content detection: TP=${tp} FP=${fp} FN=${fn}  precision=${(precision * 100).toFixed(1)}%  recall=${(recall * 100).toFixed(1)}%`);
  check('precision == 100%', fp === 0); check('recall == 100%', fn === 0);

  // Tier-1 must catch the server-rendered ArcGIS iframe.
  const eq = one(`SELECT * FROM findings WHERE url=? AND identity_key='arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1' AND tier=1`, u('/tsd/san-mateo-county-digital-equity-portal'));
  check('digital-equity: tier 1 (static) caught the iframe', !!eq && eq.signal_type === 'iframe' && eq.placement === 'main_content', eq ? `${eq.signal_type}/${eq.placement}/${eq.confidence}` : 'no tier-1 row');
  check('digital-equity: arcgis org extracted', eq?.arcgis_org === 'smcmaps', eq?.arcgis_org);

  // privacy-policy: only site_chrome, nothing in main content
  const priv = q(`SELECT placement, COUNT(*) c FROM findings WHERE url=? GROUP BY placement`, u('/privacy-policy'));
  const privChrome = one(`SELECT chrome_keys FROM urls WHERE url=?`, u('/privacy-policy'));
  check('privacy-policy: no main_content findings', !priv.some(r => r.placement === 'main_content'), JSON.stringify(priv));
  check('privacy-policy: mega-menu apps recorded as site_chrome on the page', JSON.parse(privChrome?.chrome_keys || '[]').length === 2, privChrome?.chrome_keys);

  // Site-chrome apps: single application row, occurrence count == crawled pages, NO finding row per page.
  const crawled = one(`SELECT COUNT(*) c FROM urls WHERE tier1_done=1 AND status IN ('done','pending','in_progress')`).c;
  for (const key of ['arcgis:item:c7075a28b298498c93a311b7af9a3ae7', 'iframe:gis.smcgov.org/Html5Viewer/']) {
    const app = one(`SELECT * FROM applications WHERE identity_key=?`, key);
    const rows = one(`SELECT COUNT(*) c FROM findings WHERE identity_key=?`, key).c;
    const mainRows = one(`SELECT COUNT(*) c FROM findings WHERE identity_key=? AND placement='main_content'`, key).c;
    const chromePages = one(`SELECT COUNT(*) c FROM urls u, json_each(u.chrome_keys) j WHERE j.value=?`, key).c;
    check(`${key}: one application row, occurrence_count == crawled pages (${crawled})`, !!app && app.occurrence_count === crawled, `count=${app?.occurrence_count}`);
    check(`${key}: classified site_chrome only`, mainRows === 0 && chromePages === crawled, `main=${mainRows} chromePages=${chromePages}`);
    check(`${key}: no finding row per crawled page`, rows <= 4, `finding rows=${rows} (exemplars only)`);
  }
  // Report collapses them
  const appsCsv = fs.readFileSync('test/out/applications.csv', 'utf8');
  check('applications.csv: road closures app is one "site-wide navigation" row', appsCsv.split('\n').filter(l => l.startsWith('arcgis:item:c7075a28b298498c93a311b7af9a3ae7')).length === 1 && /^arcgis:item:c7075a28b298498c93a311b7af9a3ae7[^\n]*site-wide navigation/m.test(appsCsv));
  const occCsv = fs.readFileSync('test/out/occurrences.csv', 'utf8');
  check('occurrences.csv: chrome apps not enumerated per page', !occCsv.includes('c7075a28b298498c93a311b7af9a3ae7'));
  check('occurrences.csv: digital-equity occurrence present with main_content', /digital-equity-portal[^\n]*e04627c3dc7a4c38a6ebb9f0d5b8dff1[^\n]*main_content[^\n]*iframe_embed/.test(occCsv));

  // Queue hygiene
  const st = (p) => one(`SELECT status, skip_reason, tier2_reason FROM urls WHERE url=?`, u(p));
  check('robots Disallow respected (/private/secret skipped, never fetched)', st('/private/secret')?.skip_reason === 'robots_disallow' && one(`SELECT COUNT(*) c FROM findings WHERE url=?`, u('/private/secret')).c === 0, JSON.stringify(st('/private/secret')));
  check('redirect to an already-queued URL skipped as duplicate', st('/redirect-old')?.skip_reason === 'redirect_duplicate', JSON.stringify(st('/redirect-old')));
  check('404 / 500 pages skipped, not failed', st('/missing-page')?.skip_reason === 'http_404' && st('/tsd/broken')?.skip_reason === 'http_500');
  check('PDF asset never queued', !one(`SELECT 1 FROM urls WHERE url LIKE '%report.pdf'`));
  check('tracking params + fragment + bare-host alias + trailing slash normalised (single /tsd/gis row)', one(`SELECT COUNT(*) c FROM urls WHERE url LIKE '%/tsd/gis%'`).c === 1, q(`SELECT url FROM urls WHERE url LIKE '%/tsd/gis%'`).map(r => r.url).join(' '));
  check('off-host links recorded as findings but never crawled', !one(`SELECT 1 FROM urls WHERE url LIKE '%smcgov.org%'`) && one(`SELECT COUNT(*) c FROM findings WHERE target_url LIKE '%gis.smcgov.org%'`).c > 0);
  check('link-only page (article-25, not in sitemap) discovered by BFS', st('/news/article-25')?.status === 'done');
  check('map-adjacent path/title pages scheduled for tier 2', ['/tsd/gis', '/hsa/find-services', '/about/shadow-map'].every(p => ['hit', 'pattern'].includes(st(p)?.tier2_reason)));
  const sample = one(`SELECT COUNT(*) c FROM urls WHERE tier2_reason='sample'`).c, misses = one(`SELECT COUNT(*) c FROM urls WHERE tier2_reason IN ('sample','none')`).c;
  check(`20% random sample of tier-1 misses rendered (${sample}/${misses})`, sample > 0 && sample / misses > 0.05 && sample / misses < 0.5);
  check('all queued URLs finished (no pending / in_progress / failed)', one(`SELECT COUNT(*) c FROM urls WHERE status IN ('pending','in_progress','failed')`).c === 0, JSON.stringify(q(`SELECT status, COUNT(*) c FROM urls GROUP BY status`)));

  // Tier 2 specifics
  check('tier 2: click-revealed Google My Maps iframe found (signal iframe, tier 2)', !!one(`SELECT 1 FROM findings WHERE url=? AND identity_key='gmymaps:mid:1XyZ_abc123' AND signal_type='iframe' AND tier=2`, u('/hsa/find-services')));
  check('tier 2: shadow-DOM iframe found (signal iframe, tier 2)', !!one(`SELECT 1 FROM findings WHERE url=? AND identity_key='arcgis:item:ffff0000eeee1111dddd2222cccc3333' AND signal_type='iframe' AND tier=2`, u('/about/shadow-map')));
  const gisSig = q(`SELECT DISTINCT signal_type FROM findings WHERE url=? AND identity_key LIKE 'inpage:leaflet:%'`, u('/tsd/gis')).map(r => r.signal_type).sort();
  check('tier 2: JS-initialised Leaflet map seen via selector + global + tile network', ['global', 'network', 'selector'].every(s => gisSig.includes(s)), gisSig.join(','));
  check('tier 2: tile requests recorded then aborted (images not blocked from recording)', one(`SELECT COUNT(*) c FROM requests WHERE url=? AND matched_rule='tile' AND aborted=1`, u('/tsd/gis')).c > 0);
  check('tier 2: one in-page identity per container (no unknown/unknown-tiles duplicates)', one(`SELECT COUNT(*) c FROM applications WHERE identity_key LIKE 'inpage:unknown%'`).c === 0, q(`SELECT identity_key FROM applications WHERE identity_key LIKE 'inpage:%'`).map(r => r.identity_key).join(' | '));
  check('tier 2: non-geographic Leaflet (seating chart) flagged', one(`SELECT type FROM applications WHERE identity_key=?`, `inpage:leaflet:${u('/parks/seating')}:div#seatmap`)?.type === 'non_geographic');
  check('tier 1 placeholder in-page identities superseded by tier-2 container identities', one(`SELECT COUNT(*) c FROM applications WHERE identity_key LIKE 'inpage:%:*'`).c === 0);
  const shots = q(`SELECT identity_key, screenshot_path FROM applications WHERE screenshot_path IS NOT NULL`);
  check('screenshots: one per new identity, clipped, stored as path', shots.length >= 4 && shots.every(s => fs.existsSync(s.screenshot_path) && fs.statSync(s.screenshot_path).size > 500 && fs.statSync(s.screenshot_path).size < 400000), `${shots.length} files: ${shots.map(s => s.screenshot_path.split('/').pop() + '=' + fs.statSync(s.screenshot_path).size + 'B').join(', ')}`);
  check('screenshots: none for link-only or site-chrome apps', !shots.some(s => /c7075a28|Html5Viewer|aaaa1111/.test(s.identity_key)));
  const key = one(`SELECT api_key FROM findings WHERE api_key IS NOT NULL LIMIT 1`);
  check('API key extracted from static map URL', key?.api_key === 'AIzaFAKEKEY123', key?.api_key);
  check('attribution links inside map controls ignored (no OpenStreetMap / Leaflet link findings)', one(`SELECT COUNT(*) c FROM findings WHERE target_url LIKE '%openstreetmap.org%' OR target_url LIKE '%leafletjs.com%'`).c === 0, q(`SELECT target_url FROM findings WHERE target_url LIKE '%openstreetmap.org%' OR target_url LIKE '%leafletjs.com%'`).map(r => r.target_url).join(','));
  check('trailing-slash variants resolve to one application', one(`SELECT COUNT(*) c FROM applications WHERE identity_key LIKE 'iframe:gis.smcgov.org/apps/publicviewer%'`).c === 1 && one(`SELECT occurrence_count FROM applications WHERE identity_key='iframe:gis.smcgov.org/apps/publicviewer/'`)?.occurrence_count === 1);
  const gm = one(`SELECT occurrence_count, type FROM applications WHERE identity_key='link:google.com/maps'`);
  check('Google directions/place links collapse to one flagged application', gm?.occurrence_count === 2 && gm?.type === 'map_link_only', JSON.stringify(gm));
  check('link-only pages scheduled for tier 2 when links_trigger_render is on', st('/hsa/contact')?.tier2_reason === 'hit', JSON.stringify(st('/hsa/contact')));

  // ArcGIS cross-reference (mock org)
  const inOrg = (id) => one(`SELECT in_county_org FROM applications WHERE arcgis_item_id=?`, id)?.in_county_org;
  check('arcgis: embedded org item → in_county_org=1', inOrg('e04627c3dc7a4c38a6ebb9f0d5b8dff1') === 1 && inOrg('aaaa1111bbbb2222cccc3333dddd4444') === 1);
  check('arcgis: external (shadow IT) dashboard → in_county_org=0', inOrg('ffff0000eeee1111dddd2222cccc3333') === 0);
  check('arcgis: unreadable item → unknown (NULL)', inOrg('1234123412341234123412341234abcd') == null);
  check('arcgis: orphaned org item listed', !!one(`SELECT 1 FROM arcgis_items i WHERE i.item_id='99998888777766665555444433332222' AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.arcgis_item_id=i.item_id)`));
  check('arcgis: application title backfilled from item metadata', one(`SELECT title FROM applications WHERE arcgis_item_id='aaaa1111bbbb2222cccc3333dddd4444'`)?.title === 'Zoning Map');
  const html = fs.readFileSync('test/out/report.html', 'utf8');
  check('report.html: external bucket surfaces the contractor dashboard', /External[\s\S]*ffff0000eeee1111dddd2222cccc3333/.test(html));
  check('report.html: coverage section + scope boundary + sample hit rate present', /Coverage/.test(html) && /not crawled/.test(html) && /sample hit rate/.test(html));
  check('findings.jsonl written', fs.readFileSync('test/out/findings.jsonl', 'utf8').trim().split('\n').length === one(`SELECT COUNT(*) c FROM findings`).c);
  db.close();

  // Idempotent inventory re-run
  const before = one2(`SELECT COUNT(*) c FROM urls`), beforeDone = one2(`SELECT COUNT(*) c FROM urls WHERE status='done'`);
  run(['inventory']);
  check('inventory re-run is idempotent (no new rows, queue state untouched)', one2(`SELECT COUNT(*) c FROM urls`) === before && one2(`SELECT COUNT(*) c FROM urls WHERE status='done'`) === beforeDone);

  // Preflight (fixture has no CMP)
  const pf = run(['preflight', '--sample', '6']);
  const pfj = JSON.parse(fs.readFileSync('test/out/preflight.json', 'utf8'));
  check('preflight: runs differential render and prints a conclusion', /PREFLIGHT CONCLUSION/.test(pf.stdout) && pfj.sample_size === 6);
  check('preflight: no consent gating on fixture', pfj.consent_gating_detected === false && pfj.cmp_present === false);

  // ---- Phase B: Ctrl-C resume
  console.log('\n=== Phase B: Ctrl-C mid-scan, then resume ===');
  fs.rmSync('test/out/test.sqlite', { force: true }); fs.rmSync('test/out/test.sqlite-wal', { force: true }); fs.rmSync('test/out/test.sqlite-shm', { force: true }); fs.rmSync('test/out/screenshots', { recursive: true, force: true });
  const inv = run(['inventory', '--no-crawl']);                       // sitemap only, nothing tier-1 yet → scan does all the work
  check('robots.txt Crawl-delay parsed and override announced loudly', /Crawl-delay: 5s is being OVERRIDDEN/.test(inv.stdout + inv.stderr));
  const lim = run(['scan', '--limit', '7', '--concurrency', '3']);
  const limDone = one2(`SELECT COUNT(*) c FROM urls WHERE status='done' OR (status='skipped' AND skip_reason<>'robots_disallow')`);
  check('--limit is exact under concurrency', limDone === 7, `processed=${limDone}`);
  check('scan announces detection scope', /detection: vendors ALL; links recorded/.test(lim.stdout));
  const total = one2(`SELECT COUNT(*) c FROM urls WHERE status='pending'`);
  const child = spawn('node', ['bin/cli.js', ...CFG, 'scan', '--concurrency', '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  await sleep(3500); child.kill('SIGINT');
  const code = await new Promise(r => child.on('exit', r));
  const afterKill = { done: one2(`SELECT COUNT(*) c FROM urls WHERE status='done'`), inprog: one2(`SELECT COUNT(*) c FROM urls WHERE status='in_progress'`), pending: one2(`SELECT COUNT(*) c FROM urls WHERE status='pending'`), skipped: one2(`SELECT COUNT(*) c FROM urls WHERE status='skipped'`) };
  check(`Ctrl-C: scan exited (code ${code}) with partial progress`, afterKill.done > 7 && afterKill.done + afterKill.skipped < total + 7, JSON.stringify(afterKill));
  check('Ctrl-C: no rows left in_progress after graceful stop', afterKill.inprog === 0, `in_progress=${afterKill.inprog}`);
  const findingsAfterKill = one2(`SELECT COUNT(*) c FROM findings`);
  run(['scan']);
  const after = { done: one2(`SELECT COUNT(*) c FROM urls WHERE status='done'`), pending: one2(`SELECT COUNT(*) c FROM urls WHERE status IN ('pending','in_progress')`), failed: one2(`SELECT COUNT(*) c FROM urls WHERE status='failed'`) };
  check('resume: every URL finished, nothing lost', after.pending === 0 && after.failed === 0 && after.done >= afterKill.done, JSON.stringify(after));
  const dup = one2(`SELECT COUNT(*) c FROM (SELECT url, identity_key, signal_type, placement, signal_value, tier, COUNT(*) n FROM findings GROUP BY 1,2,3,4,5,6 HAVING n > 1)`);
  check('resume: no duplicated findings', dup === 0, `dup groups=${dup}; findings before resume=${findingsAfterKill}`);
  const dbB = new Database(DB, { readonly: true });
  const eqB = dbB.prepare(`SELECT COUNT(*) c FROM findings WHERE identity_key='arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1' AND placement='main_content'`).get().c;
  const appsB = dbB.prepare(`SELECT COUNT(*) c FROM applications`).get().c;
  dbB.close();
  check('resume: ground-truth findings intact after restart', eqB >= 1 && appsB >= 10, `equity rows=${eqB} apps=${appsB}`);

  // ---- Phase C: Esri-only detection scope (production config values) on the same fixture
  console.log('\n=== Phase C: detection.vendors = [esri, esri-enterprise], links do not trigger render ===');
  const esriCfg = fs.readFileSync('test/config.test.yaml', 'utf8')
    .replace('detection: { vendors: [], record_links: true, links_trigger_render: true }', 'detection: { vendors: [esri, esri-enterprise], record_links: true, links_trigger_render: false }')
    .replace('database: ./test/out/test.sqlite', 'database: ./test/out/esri.sqlite').replace('dir: ./test/out/screenshots', 'dir: ./test/out/screenshots-esri').replace('dir: ./test/out,', 'dir: ./test/out/esri,');
  fs.writeFileSync('test/out/config-esri.yaml', esriCfg);
  const runE = (args) => spawnSync('node', ['bin/cli.js', '-c', 'test/out/config-esri.yaml', ...args], { encoding: 'utf8' });
  runE(['inventory']); const scanE = runE(['scan']); runE(['arcgis']); runE(['report']);
  const dbE = new Database('test/out/esri.sqlite', { readonly: true });
  const qe = (sql, ...p) => dbE.prepare(sql).all(...p); const oe = (sql, ...p) => dbE.prepare(sql).get(...p);
  check('esri-only: scan announces the vendor scope', /detection: vendors esri,esri-enterprise; links recorded \(flagged\); links trigger render: false/.test(scanE.stdout));
  const vendors = qe(`SELECT DISTINCT vendor FROM findings`).map(r => r.vendor).sort();
  check('esri-only: no findings from other vendors', vendors.every(v => ['esri', 'esri-enterprise'].includes(v)), vendors.join(','));
  check('esri-only: equity portal iframe still found at tier 1', !!oe(`SELECT 1 FROM findings WHERE identity_key='arcgis:item:e04627c3dc7a4c38a6ebb9f0d5b8dff1' AND tier=1 AND placement='main_content'`));
  check('esri-only: shadow-DOM dashboard still found at tier 2', !!oe(`SELECT 1 FROM findings WHERE identity_key='arcgis:item:ffff0000eeee1111dddd2222cccc3333' AND signal_type='iframe' AND tier=2`));
  check('esri-only: Enterprise viewers recorded under vendor esri-enterprise', oe(`SELECT vendor FROM applications WHERE identity_key='iframe:gis.smcgov.org/Html5Viewer/'`)?.vendor === 'esri-enterprise' && oe(`SELECT vendor FROM applications WHERE identity_key='iframe:gis.smcgov.org/apps/publicviewer/'`)?.vendor === 'esri-enterprise');
  check('esri-only: Esri links still recorded and flagged', oe(`SELECT type, flagged FROM findings WHERE url=? AND identity_key='arcgis:item:aaaa1111bbbb2222cccc3333dddd4444'`, u('/hsa/contact'))?.flagged === 1);
  check('esri-only: a link-only page is NOT a tier-1 hit (not rendered for that reason)', ['sample', 'none'].includes(oe(`SELECT tier2_reason FROM urls WHERE url=?`, u('/hsa/contact'))?.tier2_reason), oe(`SELECT tier2_reason FROM urls WHERE url=?`, u('/hsa/contact'))?.tier2_reason);
  check('esri-only: Google / Leaflet / Tableau / Mapbox pages produce no applications', oe(`SELECT COUNT(*) c FROM applications WHERE identity_key LIKE '%google%' OR identity_key LIKE 'inpage:leaflet%' OR identity_key LIKE '%tableau%' OR identity_key LIKE 'mapbox:%'`).c === 0);
  const rendered = oe(`SELECT COUNT(*) c FROM urls WHERE tier2_done=1`).c, renderedA = one2(`SELECT COUNT(*) c FROM urls WHERE tier2_done=1`);
  check(`esri-only: fewer pages rendered than the all-vendor run (${rendered} vs ${renderedA})`, rendered < renderedA);
  const appsE = fs.readFileSync('test/out/esri/applications.csv', 'utf8');
  check('esri-only: applications.csv carries app_kind / hosting / linked_only columns', /^identity_key,vendor,app_kind,hosting,/.test(appsE) && /ArcGIS Web AppBuilder,ArcGIS Online/.test(appsE));
  const htmlE = fs.readFileSync('test/out/esri/report.html', 'utf8');
  check('esri-only: report has Linked-only and Enterprise sections and states the scope', /Linked only/.test(htmlE) && /ArcGIS Enterprise \/ Geocortex viewers/.test(htmlE) && /vendors <b>esri, esri-enterprise<\/b> only/.test(htmlE));
  dbE.close();

  // ---- Phase D: production-shaped run-crawl (detection: all vendors, report: esri only, HTML stored, screenshots off → catch-up)
  console.log('\n=== Phase D: run-crawl (broad detection, Esri-only report, stored HTML, screenshots catch-up) ===');
  const prodCfg = fs.readFileSync('test/config.test.yaml', 'utf8')
    .replace('detection: { vendors: [], record_links: true, links_trigger_render: true }', 'detection: { vendors: [], record_links: true, links_trigger_render: false }')
    .replace('database: ./test/out/test.sqlite', 'database: ./test/out/prod.sqlite').replace('dir: ./test/out/screenshots', 'dir: ./test/out/screenshots-prod')
    .replace('report: { dir: ./test/out,', 'report: { vendors: [esri, esri-enterprise], dir: ./test/out/prod,');
  fs.writeFileSync('test/out/config-prod.yaml', prodCfg);
  const runP = (args) => spawnSync('node', ['bin/cli.js', '-c', 'test/out/config-prod.yaml', ...args], { encoding: 'utf8' });
  const rc = runP(['run-crawl', '--no-confirm', '--screenshots', 'none']);
  check('run-crawl: exits 0 and prints the plan, the web-team notice and phase timings', rc.status === 0 && /RUN PLAN/.test(rc.stdout) && /Text for the web team/.test(rc.stdout) && /run-crawl finished/.test(rc.stdout), rc.status !== 0 ? (rc.stdout + rc.stderr).slice(-600) : '');
  const dbP = new Database('test/out/prod.sqlite', { readonly: true });
  const op = (sql, ...p) => dbP.prepare(sql).get(...p);
  const zlib = await import('node:zlib');
  const pg = op(`SELECT url, html_gz, size_bytes FROM pages WHERE url=?`, u('/tsd/san-mateo-county-digital-equity-portal'));
  check('run-crawl: page HTML stored gzipped and round-trips', !!pg && zlib.gunzipSync(pg.html_gz).toString().includes('webappviewer') && pg.size_bytes > 500, pg ? `${pg.size_bytes}B → ${pg.html_gz.length}B` : 'no row');
  check('run-crawl: HTML stored for every crawled HTML page', op(`SELECT COUNT(*) c FROM pages`).c === op(`SELECT COUNT(*) c FROM urls WHERE tier1_done=1 AND status='done'`).c, `${op(`SELECT COUNT(*) c FROM pages`).c} vs ${op(`SELECT COUNT(*) c FROM urls WHERE tier1_done=1 AND status='done'`).c}`);
  check('run-crawl: database holds non-Esri findings (broad detection)', op(`SELECT COUNT(*) c FROM findings WHERE vendor IN ('google','leaflet','tableau','mapbox')`).c > 0);
  check('run-crawl: every URL finished', op(`SELECT COUNT(*) c FROM urls WHERE status IN ('pending','in_progress','failed')`).c === 0);
  const appsP = fs.readFileSync('test/out/prod/applications.csv', 'utf8').split('\n').slice(1).filter(Boolean);
  check('run-crawl: applications.csv shows Esri vendors only', appsP.length > 0 && appsP.every(l => /^[^,]+,(esri|esri-enterprise),/.test(l)), appsP.map(l => l.split(',')[1]).join(','));
  const occP = fs.readFileSync('test/out/prod/occurrences.csv', 'utf8');
  const occVendors = new Set(occP.split('\n').slice(1).filter(Boolean).map(l => l.split(',').find((c, i, arr) => arr[i - 1] && /^(arcgis:|iframe:|inpage:|gmymaps:|mapbox:|link:)/.test(arr[i - 1]))));
  check('run-crawl: occurrences.csv filtered to Esri', occP.split('\n').length > 2 && [...occVendors].every(v => ['esri', 'esri-enterprise'].includes(v)), [...occVendors].join(','));
  check('run-crawl: findings-all-vendors.jsonl keeps the broad data', fs.existsSync('test/out/prod/findings-all-vendors.jsonl') && /"vendor":"google"/.test(fs.readFileSync('test/out/prod/findings-all-vendors.jsonl', 'utf8')));
  const htmlP = fs.readFileSync('test/out/prod/report.html', 'utf8');
  check('run-crawl: report states detection vs report scope and stored-HTML coverage', /Report scope[^<]*vendors <b>esri, esri-enterprise<\/b> only — \d+ of \d+ recorded applications/.test(htmlP) && /pages' HTML stored/.test(htmlP));
  check('run-crawl --screenshots none: no images captured', op(`SELECT COUNT(*) c FROM applications WHERE screenshot_path IS NOT NULL`).c === 0);
  dbP.close();
  const sc = runP(['screenshots']);
  const dbP2 = new Database('test/out/prod.sqlite', { readonly: true });
  const withShot = dbP2.prepare(`SELECT identity_key, screenshot_path FROM applications WHERE screenshot_path IS NOT NULL`).all();
  check('screenshots command: fills in images for embedded applications afterwards', sc.status === 0 && withShot.length >= 3 && withShot.every(a => fs.existsSync(a.screenshot_path)), `${withShot.length} captured`);
  check('screenshots command: skips link-only / site-chrome-only apps', !withShot.some(a => /c7075a28|Html5Viewer|aaaa1111/.test(a.identity_key)));
  dbP2.close();
  const plan = runP(['run-crawl', '--plan']);
  check('run-crawl --plan: prints and exits without touching the database', plan.status === 0 && /RUN PLAN/.test(plan.stdout) && !/inventory starting/.test(plan.stdout));
  const stat = runP(['status']);
  check('status command: prints queue, HTTP statuses, applications and stored pages', stat.status === 0 && /URLs:/.test(stat.stdout) && /HTTP statuses:\s+200/.test(stat.stdout) && /applications:\s+\d+/.test(stat.stdout) && /pages stored:/.test(stat.stdout));
  check('run-crawl: NEW application lines printed during the run', (rc.stdout.match(/NEW application /g) || []).length >= 5);

  // ---- Phase E: the host starts rejecting requests mid-run → loud stop, nothing marked clean, resumable
  console.log('\n=== Phase E: simulated WAF (403 after 12 page fetches) ===');
  const server2 = spawn('node', ['test/fixture-site/server.js', '8766'], { stdio: 'inherit', env: { ...process.env, FIXTURE_BLOCK_AFTER: 12 } });
  await sleep(700);
  try {
    const wafCfg = fs.readFileSync('test/out/config-prod.yaml', 'utf8').replace(/8765/g, '8766').replace('database: ./test/out/prod.sqlite', 'database: ./test/out/waf.sqlite').replace('retry_backoff_ms: 200', 'retry_backoff_ms: 60000');
    fs.writeFileSync('test/out/config-waf.yaml', wafCfg);
    const runW = (args) => spawnSync('node', ['bin/cli.js', '-c', 'test/out/config-waf.yaml', ...args], { encoding: 'utf8' });
    const rw = runW(['run-crawl', '--no-confirm', '--screenshots', 'none']);
    const out = rw.stdout + rw.stderr;
    check('WAF: run-crawl stops loudly when the host starts rejecting requests', rw.status === 0 && /HOST IS REJECTING REQUESTS/.test(out) && /run-crawl STOPPED during inventory/.test(out), out.slice(-400));
    check('WAF: scan / arcgis / report phases were NOT run after the stop', !/===== scan starting/.test(out));
    const dbW = new Database('test/out/waf.sqlite', { readonly: true });
    const ow = (sql) => dbW.prepare(sql).get();
    check('WAF: rejected pages are NOT marked skipped/done (stay pending for retry)', ow(`SELECT COUNT(*) c FROM urls WHERE skip_reason LIKE 'http_403%'`).c === 0 && ow(`SELECT COUNT(*) c FROM urls WHERE status='pending' AND error LIKE 'HTTP 403%'`).c > 0, JSON.stringify(dbW.prepare('SELECT status, COUNT(*) c FROM urls GROUP BY status').all()));
    check('WAF: pages fetched before the block kept their findings', ow(`SELECT COUNT(*) c FROM findings`).c > 0 && ow(`SELECT COUNT(*) c FROM pages`).c > 0);
    check('WAF: blocked_at recorded for status', !!ow(`SELECT value FROM meta WHERE key='blocked_at'`));
    dbW.close();
    const sw = runW(['status']);
    check('WAF: status shows BLOCKED and the 403 count', /BLOCKED:/.test(sw.stdout) && /403×\d+/.test(sw.stdout));
  } finally { server2.kill(); }

  // ---- Phase F: disk guard (threshold set impossibly high so it trips immediately)
  console.log('\n=== Phase F: disk-space guard ===');
  const diskCfg = fs.readFileSync('test/out/config-prod.yaml', 'utf8').replace('database: ./test/out/prod.sqlite', 'database: ./test/out/disk.sqlite') + '\nstorage: { min_free_disk_mb: 999999999, check_every_pages: 50 }\n';
  fs.writeFileSync('test/out/config-disk.yaml', diskCfg);
  const rd = spawnSync('node', ['bin/cli.js', '-c', 'test/out/config-disk.yaml', 'run-crawl', '--no-confirm', '--screenshots', 'none'], { encoding: 'utf8' });
  const outD = rd.stdout + rd.stderr;
  check('disk guard: run-crawl stops loudly when free space is below the threshold', rd.status === 0 && /LOW DISK/.test(outD) && /run-crawl STOPPED during inventory: disk space is low/.test(outD) && !/===== scan starting/.test(outD), outD.slice(-300));
  const sd = spawnSync('node', ['bin/cli.js', '-c', 'test/out/config-disk.yaml', 'status'], { encoding: 'utf8' });
  check('status: shows free disk, the stored-HTML projection and the DISK STOP flag', /free disk:\s+\d+ MB/.test(sd.stdout) && /DISK STOP:/.test(sd.stdout));
  const sp = runP(['status']);
  check('status: projects stored-HTML size for the whole queue', /projected for all \d+ URLs: \d+ MB/.test(sp.stdout));
  check('run-crawl --plan: reports free disk on the database volume', /MB free on that volume/.test(plan.stdout));
} finally { server.kill(); }

console.log(`\n${results.length - failures}/${results.length} checks passed${failures ? `, ${failures} FAILED` : ''}`);
fs.writeFileSync('test/out/validation-results.json', JSON.stringify(results, null, 2));
process.exit(failures ? 1 : 0);

function one2(sql) { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).get().c; } finally { d.close(); } }
