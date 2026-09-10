import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun } from '../lib/db.js';
import { HttpClient } from '../lib/fetch.js';
import { collectSitemapUrls } from '../lib/sitemap.js';
import { BrowserPool } from '../lib/browser.js';
import { cmpScript } from '../lib/page-script.js';
import { Scope, hostOf } from '../lib/url.js';
import { log } from '../lib/log.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Phase 0 — consent-gating probe. Differential render over ~30 pages spanning site sections:
 * run A (no interaction) vs run B (consent cookies injected + accept button clicked). Diff the
 * network hostnames; any map-vendor hostname only in B means maps are consent-gated.
 */
export async function preflight(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const runId = startRun(db, 'preflight', cfg, TOOL_VERSION);
  const rules = cfg.rules; const scope = new Scope(cfg.scope, cfg.inventory);
  const sampleSize = Number(opts.sample || 30);
  const http = new HttpClient(cfg.http);

  // Sample: prefer the urls table; fall back to the sitemap. Spread across first path segments.
  let candidates = db.prepare(`SELECT url FROM urls WHERE status<>'skipped' ORDER BY rowid`).all().map(r => r.url);
  if (candidates.length < sampleSize) {
    const sm = await collectSitemapUrls(http, cfg.seeds.sitemaps || []);
    candidates = [...new Set([...candidates, ...sm.urls.map(u => scope.classify(u)).filter(c => c.crawl).map(c => c.url)])];
  }
  if (cfg.seeds.homepage) candidates.unshift(scope.classify(cfg.seeds.homepage).url);
  const bySection = new Map();
  for (const u of candidates) { const seg = (new URL(u).pathname.split('/')[1] || '(root)'); if (!bySection.has(seg)) bySection.set(seg, []); bySection.get(seg).push(u); }
  const sections = [...bySection.keys()]; const sample = []; let i = 0;
  while (sample.length < sampleSize && sections.length) { const seg = sections[i % sections.length]; const arr = bySection.get(seg); if (arr.length) sample.push(arr.shift()); else sections.splice(i % sections.length, 1); i++; if (!sections.length) break; }
  log.info(`preflight: ${sample.length} pages across ${bySection.size} sections`);

  const pool = new BrowserPool(cfg); await pool.launch();
  const cmpAssets = (rules.cmp.asset_patterns || []).map(s => s.toLowerCase());
  const results = []; const cmpHits = new Set(); const vendorOnlyB = new Map();
  const cookies = (rules.cmp.consent_cookies || []).map(c => ({ name: c.name, value: c.value, domain: hostOf(cfg.seeds.homepage), path: '/' }));
  const acceptRe = new RegExp(rules.cmp.accept_button_regex || 'accept', 'i');

  async function load(url, withConsent) {
    const ctx = await pool.browser.newContext({ userAgent: cfg.http.user_agent, viewport: cfg.scan.viewport, acceptDownloads: false, serviceWorkers: 'block' });
    if (withConsent) await ctx.addCookies(cookies).catch(() => {});
    const page = await ctx.newPage(); const hosts = new Set(); const assets = new Set(); const mapHosts = new Set();
    page.on('request', r => { const h = hostOf(r.url()); if (h) hosts.add(h); const lu = r.url().toLowerCase(); for (const a of cmpAssets) if (lu.includes(a)) assets.add(a); if (rules.matchRequestUrl(r.url())) mapHosts.add(h); });
    page.on('dialog', d => d.dismiss().catch(() => {}));
    let cmpGlobals = [], clicked = false, status = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); status = resp ? resp.status() : null;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      if (withConsent) {
        const btn = page.getByRole('button', { name: acceptRe }).first();
        if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 2000, noWaitAfter: true }).then(() => { clicked = true; }).catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); }
      }
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(1500);
      await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
      cmpGlobals = await page.evaluate(cmpScript, { globals: rules.cmp.globals || [], gtagConsentRegex: rules.cmp.gtag_consent_regex || 'gtag\\(\\s*.consent' }).catch(() => []);
    } catch (e) { log.warn(`preflight ${withConsent ? 'B' : 'A'} ${url}: ${e.message.split('\n')[0]}`); }
    await ctx.close().catch(() => {});
    return { hosts, assets, mapHosts, cmpGlobals, clicked, status };
  }

  for (const url of sample) {
    const a = await load(url, false); const b = await load(url, true);
    const onlyB = [...b.mapHosts].filter(h => !a.mapHosts.has(h));
    for (const h of onlyB) vendorOnlyB.set(h, (vendorOnlyB.get(h) || 0) + 1);
    for (const g of a.cmpGlobals) cmpHits.add(g); for (const s of a.assets) cmpHits.add('asset:' + s);
    results.push({ url, status: a.status, hosts_a: a.hosts.size, hosts_b: b.hosts.size, map_hosts_a: [...a.mapHosts], map_hosts_b: [...b.mapHosts], map_hosts_only_with_consent: onlyB, cmp_signals: [...a.cmpGlobals, ...[...a.assets].map(s => 'asset:' + s)], accept_button_clicked: b.clicked });
    log.info(`${url} | A: ${a.hosts.size} hosts, ${a.mapHosts.size} map | B: ${b.hosts.size} hosts, ${b.mapHosts.size} map | only-with-consent: ${onlyB.join(',') || '-'} | cmp: ${results.at(-1).cmp_signals.join(',') || '-'}`);
  }
  await pool.close(); await http.close();

  const gated = vendorOnlyB.size > 0;
  const verdict = {
    generated_at: new Date().toISOString(), sample_size: results.length,
    consent_gating_detected: gated, cmp_present: cmpHits.size > 0,
    cmp_signals: [...cmpHits], map_hosts_only_with_consent: Object.fromEntries(vendorOnlyB),
    recommendation: gated ? 'Map vendors load only after consent: scan will run WITH consent handling (config scan.consent=auto reads this file; set scan.consent=on to force).' : 'No map vendor appears only after consent: scan runs without consent handling.',
    pages: results,
  };
  const outDir = path.resolve(cfg.report.dir); fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'preflight.json'); fs.writeFileSync(outFile, JSON.stringify(verdict, null, 2));
  finishRun(db, runId, { consent_gating_detected: gated, cmp_present: cmpHits.size > 0, sample: results.length });
  console.log('\n================ PREFLIGHT CONCLUSION ================');
  console.log(`Pages sampled:               ${results.length}`);
  console.log(`CMP present:                 ${cmpHits.size ? 'YES — ' + [...cmpHits].join(', ') : 'NO (no CMP globals or vendor assets observed)'}`);
  console.log(`Map hosts gated by consent:  ${gated ? 'YES — ' + [...vendorOnlyB.entries()].map(([h, n]) => `${h} (${n} pages)`).join(', ') : 'NONE'}`);
  console.log(`Decision:                    ${gated ? 'scan WILL use consent handling' : 'scan runs WITHOUT consent handling'}`);
  console.log(`Written:                     ${outFile}`);
  console.log('======================================================\n');
  db.close();
}
