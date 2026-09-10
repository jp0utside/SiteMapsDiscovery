import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun, getMeta } from '../lib/db.js';
import { HttpClient } from '../lib/fetch.js';
import { Store } from '../lib/store.js';
import { renderHtml } from '../report/html.js';
import { log } from '../lib/log.js';

const csvCell = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (rows, cols) => [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';

/** Phase 3 — aggregate, deduplicate, export. Reads SQLite only; never recrawls. */
export async function report(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const runId = startRun(db, 'report', cfg, TOOL_VERSION);
  const outDir = path.resolve(cfg.report.dir); fs.mkdirSync(outDir, { recursive: true });
  new Store(db).refreshCounts();

  // ---- Applications (one row per identity) with placement breakdown.
  const apps = db.prepare(`
    SELECT a.*, 
      (SELECT COUNT(DISTINCT url) FROM findings f WHERE f.identity_key=a.identity_key AND f.placement='main_content') AS main_content_pages,
      (SELECT COUNT(*) FROM urls u, json_each(u.chrome_keys) j WHERE u.chrome_keys IS NOT NULL AND j.value=a.identity_key) AS site_chrome_pages,
      (SELECT COUNT(DISTINCT url) FROM findings f WHERE f.identity_key=a.identity_key AND f.placement='main_content' AND f.type<>'map_link_only') AS embed_pages,
      (SELECT MIN(url) FROM findings f WHERE f.identity_key=a.identity_key AND f.placement='main_content') AS example_main_url,
      (SELECT MAX(confidence='high') FROM findings f WHERE f.identity_key=a.identity_key) AS any_high,
      (SELECT group_concat(DISTINCT signal_type) FROM findings f WHERE f.identity_key=a.identity_key) AS signal_types,
      (SELECT group_concat(DISTINCT api_key) FROM findings f WHERE f.identity_key=a.identity_key AND api_key IS NOT NULL) AS api_keys,
      (SELECT group_concat(DISTINCT arcgis_org) FROM findings f WHERE f.identity_key=a.identity_key AND arcgis_org IS NOT NULL) AS arcgis_orgs
    FROM applications a ORDER BY a.occurrence_count DESC, a.identity_key`).all();
  for (const a of apps) {
    a.placement_summary = a.main_content_pages === 0 && a.site_chrome_pages > 0 ? 'site-wide navigation' : a.site_chrome_pages > 0 ? 'content + navigation' : 'content';
    a.example_url = a.example_main_url || a.first_seen_url;
    a.flagged = (a.type === 'map_link_only' || a.type === 'non_geographic') ? 1 : 0;
    a.in_county_org_label = a.in_county_org === 1 ? 'yes' : a.in_county_org === 0 ? 'no' : (a.arcgis_item_id ? 'unknown' : 'n/a');
    if (a.screenshot_path) a.screenshot_rel = path.relative(outDir, path.resolve(a.screenshot_path)).split(path.sep).join('/');
  }
  fs.writeFileSync(path.join(outDir, 'applications.csv'), csv(apps, ['identity_key', 'vendor', 'type', 'title', 'occurrence_count', 'main_content_pages', 'site_chrome_pages', 'placement_summary', 'in_county_org_label', 'arcgis_item_id', 'per_page', 'flagged', 'screenshot_path', 'example_url', 'target_url', 'signal_types', 'api_keys']));

  // ---- Occurrences (one row per page × application). Site-chrome presence is not enumerated per page unless asked:
  // it is the same nav/header/footer on every crawled page and is summarised by site_chrome_pages in applications.csv.
  const occ = db.prepare(`
    SELECT f.url AS page_url, u.title AS page_title, f.identity_key, a.vendor, a.type AS application_type,
      MIN(f.placement) AS placement, group_concat(DISTINCT f.signal_type) AS signal_types, group_concat(DISTINCT f.type) AS finding_types,
      MAX(CASE f.confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) AS conf_rank,
      MIN(f.container_selector) AS container_selector, MIN(f.target_url) AS target_url, MAX(f.tier) AS max_tier
    FROM findings f JOIN applications a ON a.identity_key=f.identity_key LEFT JOIN urls u ON u.url=f.url
    WHERE f.placement='main_content'
    GROUP BY f.url, f.identity_key ORDER BY f.identity_key, f.url`).all();
  for (const o of occ) { o.confidence = o.conf_rank === 3 ? 'high' : o.conf_rank === 2 ? 'medium' : 'low'; const st = o.signal_types.split(','); o.how = st.every(s => s === 'link') ? 'link' : (st.includes('iframe') || st.includes('frame')) ? 'iframe_embed' : st.includes('image') ? 'static_image' : 'in_page'; }
  fs.writeFileSync(path.join(outDir, 'occurrences.csv'), csv(occ, ['page_url', 'page_title', 'identity_key', 'vendor', 'application_type', 'placement', 'how', 'signal_types', 'finding_types', 'confidence', 'container_selector', 'target_url', 'max_tier']));

  // ---- Findings JSONL (raw grain, every signal).
  const fj = fs.createWriteStream(path.join(outDir, 'findings.jsonl'));
  for (const f of db.prepare('SELECT * FROM findings ORDER BY id').iterate()) fj.write(JSON.stringify(f) + '\n');
  await new Promise(r => fj.end(r));

  // ---- Coverage.
  const cnt = (sql, ...p) => db.prepare(sql).get(...p).c;
  const coverage = {
    discovered: cnt('SELECT COUNT(*) c FROM urls'),
    by_source: db.prepare('SELECT source, COUNT(*) c FROM urls GROUP BY source').all(),
    by_status: db.prepare('SELECT status, COUNT(*) c FROM urls GROUP BY status').all(),
    crawled_tier1: cnt('SELECT COUNT(*) c FROM urls WHERE tier1_done=1 AND status<>\'skipped\''),
    rendered_tier2: cnt('SELECT COUNT(*) c FROM urls WHERE tier2_done=1'),
    tier2_by_reason: db.prepare(`SELECT tier2_reason reason, SUM(tier2_done) rendered, COUNT(*) scheduled FROM urls WHERE tier2_reason IS NOT NULL AND tier2_reason<>'none' GROUP BY tier2_reason`).all(),
    pending: cnt(`SELECT COUNT(*) c FROM urls WHERE status IN ('pending','in_progress')`),
    failed: cnt(`SELECT COUNT(*) c FROM urls WHERE status='failed'`),
    skipped: cnt(`SELECT COUNT(*) c FROM urls WHERE status='skipped'`),
    skipped_by_reason: db.prepare(`SELECT skip_reason reason, COUNT(*) c FROM urls WHERE status='skipped' GROUP BY skip_reason`).all(),
    failed_urls: db.prepare(`SELECT url, error, attempts FROM urls WHERE status='failed' ORDER BY url LIMIT 200`).all(),
    cap_reached: getMeta(db, 'url_cap_reached'),
    tier1_hit_pages: cnt(`SELECT COUNT(DISTINCT url) c FROM findings WHERE tier=1 AND placement='main_content'`),
    tier2_hit_pages: cnt(`SELECT COUNT(DISTINCT url) c FROM findings WHERE tier=2 AND placement='main_content' AND type<>'map_link_only'`),
  };
  // Sample hit rate: of tier-1 misses rendered because of the random sample, how many had an embedded map
  // (main_content, not link-only) that tier 1 did not see? This is the static-rule blind-spot estimate.
  const sampleRendered = db.prepare(`SELECT url FROM urls WHERE tier2_reason='sample' AND tier2_done=1`).all().map(r => r.url);
  let sampleHits = 0, sampleNewIdentity = 0;
  for (const u of sampleRendered) {
    const t2 = db.prepare(`SELECT identity_key FROM findings WHERE url=? AND tier=2 AND placement='main_content' AND type<>'map_link_only'`).all(u).map(r => r.identity_key);
    if (t2.length) sampleHits++;
    const t1 = new Set(db.prepare(`SELECT identity_key FROM findings WHERE url=? AND tier=1`).all(u).map(r => r.identity_key));
    if (t2.some(k => !t1.has(k) && !(k.startsWith('inpage:') && [...t1].some(x => x.startsWith('inpage:'))))) sampleNewIdentity++;
  }
  coverage.sample = { rendered: sampleRendered.length, hits: sampleHits, hit_rate: sampleRendered.length ? sampleHits / sampleRendered.length : null, new_identity_pages: sampleNewIdentity, rate: cfg.scan.tier2_sample_rate };
  const patternRendered = db.prepare(`SELECT COUNT(*) c FROM urls WHERE tier2_reason='pattern' AND tier2_done=1`).get().c;
  const patternHits = db.prepare(`SELECT COUNT(DISTINCT u.url) c FROM urls u WHERE u.tier2_reason='pattern' AND u.tier2_done=1 AND EXISTS (SELECT 1 FROM findings f WHERE f.url=u.url AND f.tier=2 AND f.placement='main_content' AND f.type<>'map_link_only')`).get().c;
  coverage.pattern = { rendered: patternRendered, hits: patternHits };

  // ---- ArcGIS buckets.
  const org = JSON.parse(getMeta(db, 'arcgis_org') || 'null');
  const arcgis = {
    org,
    embedded: apps.filter(a => a.arcgis_item_id && a.in_county_org === 1),
    external: apps.filter(a => a.arcgis_item_id && a.in_county_org === 0),
    unknown: apps.filter(a => a.arcgis_item_id && a.in_county_org == null),
    orphaned: org ? db.prepare(`SELECT * FROM arcgis_items i WHERE i.in_org=1 AND i.org_id=? AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.arcgis_item_id=i.item_id) ORDER BY modified DESC`).all(org.id) : [],
    org_item_count: org ? cnt('SELECT COUNT(*) c FROM arcgis_items WHERE in_org=1 AND org_id=?', org.id) : 0,
    non_arcgis_external: apps.filter(a => !a.arcgis_item_id && !a.identity_key.startsWith('inpage:') && !/smcgov\.org/i.test(a.identity_key)),
  };

  // ---- API keys / tokens: publishable client-side identifiers; probe for referrer restriction (single GET, no state change).
  const keys = db.prepare(`SELECT api_key, vendor, COUNT(DISTINCT url) pages, MIN(target_url) example, group_concat(DISTINCT identity_key) identities FROM findings WHERE api_key IS NOT NULL GROUP BY api_key, vendor`).all();
  if (cfg.report.probe_api_keys && !opts.noProbeKeys && keys.length) {
    const http = new HttpClient(cfg.http);
    for (const k of keys) k.restriction = await probeKey(http, k);
    await http.close();
  } else for (const k of keys) k.restriction = 'not probed';

  const totals = {
    applications: apps.length, applications_unflagged: apps.filter(a => !a.flagged).length,
    site_wide: apps.filter(a => a.placement_summary === 'site-wide navigation').length,
    occurrences: occ.length, findings: cnt('SELECT COUNT(*) c FROM findings'),
    by_vendor: db.prepare('SELECT vendor, COUNT(*) c FROM applications GROUP BY vendor ORDER BY c DESC').all(),
    by_type: db.prepare('SELECT type, COUNT(*) c FROM applications GROUP BY type ORDER BY c DESC').all(),
    pages_with_maps: cnt(`SELECT COUNT(DISTINCT url) c FROM findings WHERE placement='main_content' AND type<>'map_link_only'`),
  };
  const runs = db.prepare('SELECT * FROM runs ORDER BY id').all();
  const html = renderHtml({ cfg, apps, occ, coverage, arcgis, keys, totals, runs, generatedAt: new Date().toISOString(), toolVersion: TOOL_VERSION });
  fs.writeFileSync(path.join(outDir, 'report.html'), html);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ totals, coverage: { ...coverage, failed_urls: undefined }, arcgis: { embedded: arcgis.embedded.length, orphaned: arcgis.orphaned.length, external: arcgis.external.length, unknown: arcgis.unknown.length }, keys }, null, 2));
  finishRun(db, runId, { applications: apps.length, occurrences: occ.length });
  log.info(`report written to ${outDir}: applications.csv (${apps.length}), occurrences.csv (${occ.length}), findings.jsonl (${totals.findings}), report.html, summary.json`);
  log.info(`coverage: discovered ${coverage.discovered}, tier-1 ${coverage.crawled_tier1}, tier-2 ${coverage.rendered_tier2}, failed ${coverage.failed}, skipped ${coverage.skipped}, pending ${coverage.pending}; sample hit rate ${coverage.sample.hit_rate == null ? 'n/a' : (100 * coverage.sample.hit_rate).toFixed(1) + '%'} (${coverage.sample.hits}/${coverage.sample.rendered})`);
  db.close();
}

const a_target = (apps, k) => (apps.find(a => a.identity_key === k) || {}).target_url || null;

async function probeKey(http, k) {
  try {
    if (k.vendor === 'google') {
      const r = await http.getText(`https://maps.googleapis.com/maps/api/geocode/json?address=San+Mateo+County&key=${encodeURIComponent(k.api_key)}`, { accept: 'application/json' });
      const j = JSON.parse(r.text || '{}'); const msg = String(j.error_message || '');
      if (/referer restrictions/i.test(msg)) return 'referrer-restricted';
      if (/IP address restrictions|not authorized|API key not valid|expired/i.test(msg)) return `restricted/other: ${msg.slice(0, 80)}`;
      if (j.status === 'OK' || j.status === 'ZERO_RESULTS' || /not authorized to use this API/i.test(msg)) return 'UNRESTRICTED (works without a referrer)';
      return `unknown: ${j.status || r.status}`;
    }
    if (k.vendor === 'mapbox') {
      const r = await http.getText(`https://api.mapbox.com/tokens/v2?access_token=${encodeURIComponent(k.api_key)}`, { accept: 'application/json' });
      const j = JSON.parse(r.text || '{}');
      if (j.code === 'TokenValid') return (j.token && j.token.allowedUrls && j.token.allowedUrls.length) ? 'URL-restricted' : 'UNRESTRICTED (no allowed URLs)';
      return `unknown: ${j.code || r.status}`;
    }
    return 'not probed (vendor)';
  } catch (e) { return `probe failed: ${e.message.split('\n')[0].slice(0, 60)}`; }
}
