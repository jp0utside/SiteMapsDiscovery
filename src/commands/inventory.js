import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun, now, setMeta, getMeta } from '../lib/db.js';
import { Scope } from '../lib/url.js';
import { HttpClient, isHtml } from '../lib/fetch.js';
import { parseRobots } from '../lib/robots.js';
import { collectSitemapUrls } from '../lib/sitemap.js';
import { detectStatic } from '../lib/tier1.js';
import { Store, inSample } from '../lib/store.js';
import { log, fmtDuration } from '../lib/log.js';
import { applyDetectionPolicy, isHit } from '../lib/detection.js';
import { applyCrawlDelay } from '../lib/robots.js';
import { hostOf } from '../lib/url.js';

/**
 * Phase 1 — populate the urls table: sitemaps → robots.txt → BFS same-host link crawl.
 * Idempotent: re-running adds newly discovered URLs without disturbing existing queue state.
 */
export async function inventory(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const scope = new Scope(cfg.scope, cfg.inventory);
  const http = new HttpClient(cfg.http);
  const store = new Store(db);
  const runId = startRun(db, 'inventory', cfg, TOOL_VERSION);
  const maxUrls = cfg.inventory.max_urls || 50000;
  let capReached = false; const stats = { sitemap: 0, robots_sitemaps: 0, crawl: 0, seed: 0, skipped_asset: 0, skipped_robots: 0, out_of_scope: 0, fetched: 0, errors: 0 };

  const insStmt = db.prepare(`INSERT OR IGNORE INTO urls(url, source, discovered_at, status, skip_reason) VALUES (?,?,?,?,?)`);
  const countStmt = db.prepare('SELECT COUNT(*) c FROM urls');
  let total = countStmt.get().c;

  // robots.txt — sitemap declarations + Disallow rules.
  let robots = { sitemaps: [], isAllowed: () => true, rules: [] };
  if (cfg.seeds.robots && cfg.http.respect_robots !== false) {
    try {
      const r = await http.getText(cfg.seeds.robots, { accept: 'text/plain,*/*' });
      if (r.status === 200) { robots = parseRobots(r.text, 'smc-map-inventory'); setMeta(db, 'robots_txt', r.text); log.info(`robots.txt: ${robots.rules.length} rules for our UA, ${robots.sitemaps.length} sitemap declarations`); }
      else log.warn(`robots.txt -> HTTP ${r.status}; treating as allow-all`);
    } catch (e) { log.warn(`robots.txt fetch failed: ${e.message}; treating as allow-all`); }
  }
  const allowed = (url) => { try { const u = new URL(url); return robots.isAllowed(u.pathname + u.search); } catch { return true; } };
  applyCrawlDelay(robots, hostOf(cfg.seeds.homepage), [http.limiter], cfg, log);

  /** Insert one candidate; returns true if newly added to the crawl queue. */
  const add = (raw, base, source) => {
    if (capReached) return false;
    const c = scope.classify(raw, base);
    if (!c.url) return false;
    if (!c.crawl) { if (c.reason === 'asset') stats.skipped_asset++; else stats.out_of_scope++; return false; }
    if (total >= maxUrls) { if (!capReached) { capReached = true; log.loud(`URL cap of ${maxUrls} reached — discovery stopped. The inventory is TRUNCATED; raise inventory.max_urls to continue.`); setMeta(db, 'url_cap_reached', String(maxUrls)); } return false; }
    if (!allowed(c.url)) { const r = insStmt.run(c.url, source, now(), 'skipped', 'robots_disallow'); if (r.changes) { total++; stats.skipped_robots++; } return false; }
    const r = insStmt.run(c.url, source, now(), 'pending', null);
    if (r.changes) { total++; stats[source] = (stats[source] || 0) + 1; return true; }
    return false;
  };

  // Seeds: homepage + sitemaps (config + robots).
  if (cfg.seeds.homepage) add(cfg.seeds.homepage, undefined, 'seed');
  const sitemapUrls = [...new Set([...(cfg.seeds.sitemaps || []), ...robots.sitemaps])];
  stats.robots_sitemaps = robots.sitemaps.length;
  if (sitemapUrls.length) {
    const t0 = Date.now(); let n = 0;
    const tx = db.transaction((batch) => { for (const [loc, sm] of batch) { n++; add(loc, sm, 'sitemap'); } });
    const batch = [];
    await collectSitemapUrls(http, sitemapUrls, { onUrl: (loc, sm) => { batch.push([loc, sm]); if (batch.length >= 500) { tx(batch.splice(0)); } } });
    if (batch.length) tx(batch.splice(0));
    log.info(`sitemaps: ${n} locs seen, ${stats.sitemap} new URLs queued (${fmtDuration(Date.now() - t0)}); queue total ${total}`);
  }

  // BFS link crawl: same-host only, no depth cap, hard total cap.
  if (cfg.inventory.bfs_link_crawl !== false && opts.crawl !== false) {
    const claim = db.prepare(`SELECT url FROM urls WHERE links_done=0 AND status IN ('pending','done') ORDER BY rowid LIMIT ?`);
    const markLinks = db.prepare('UPDATE urls SET links_done=1 WHERE url=?');
    const updFetch = db.prepare('UPDATE urls SET http_status=?, final_url=?, title=COALESCE(?, title), last_attempt_at=?, attempts=attempts+1 WHERE url=?');
    const markSkip = db.prepare(`UPDATE urls SET status='skipped', skip_reason=?, tier1_done=1, tier2_reason='none', links_done=1 WHERE url=? AND status='pending'`);
    const markTier1 = db.prepare(`UPDATE urls SET tier1_done=1, tier1_hit=?, tier2_reason=?, status=CASE WHEN ?='none' THEN 'done' ELSE status END WHERE url=? AND status='pending' AND tier1_done=0`);
    const markErr = db.prepare(`UPDATE urls SET error=?, last_attempt_at=? WHERE url=?`);
    const concurrency = Math.max(1, Math.min(8, cfg.scan.concurrency || 3));
    const t0 = Date.now(); let processed = 0; let stopping = false;
    const onSig = () => { if (stopping) process.exit(130); stopping = true; log.warn('Ctrl-C: finishing in-flight fetches, then exiting (re-run inventory to continue).'); };
    process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
    const runTier1 = cfg.inventory.run_tier1_during_crawl !== false;

    const processOne = async (url) => {
      let res;
      try { res = await http.getText(url); }
      catch (e) { stats.errors++; markErr.run(String(e.message).slice(0, 300), now(), url); markLinks.run(url); return; }
      stats.fetched++;
      const finalNorm = scope.normalize(res.finalUrl)?.toString() || res.finalUrl;
      updFetch.run(res.status, res.finalUrl, null, now(), url);
      if (res.status >= 400) { markSkip.run(`http_${res.status}`, url); markLinks.run(url); return; }
      if (!isHtml(res.contentType)) { markSkip.run('non_html', url); markLinks.run(url); return; }
      if (!scope.isCrawlableHost(new URL(res.finalUrl).host)) { markSkip.run('redirected_off_host', url); markLinks.run(url); stats.out_of_scope++; return; }
      if (finalNorm !== url && db.prepare('SELECT 1 FROM urls WHERE url=?').get(finalNorm)) { markSkip.run('redirect_duplicate', url); markLinks.run(url); add(finalNorm, undefined, 'crawl'); return; }
      const det = detectStatic(res.text, url, cfg.rules);
      det.findings = applyDetectionPolicy(det.findings, cfg);
      db.prepare('UPDATE urls SET title=? WHERE url=?').run(det.title || null, url);
      const tx = db.transaction(() => {
        for (const l of det.links) add(l, res.finalUrl, 'crawl');
        if (finalNorm !== url) add(finalNorm, undefined, 'crawl');
        markLinks.run(url);
        if (runTier1) {
          const hit = isHit(det.findings, cfg) ? 1 : 0;
          const adjacent = cfg.rules.isMapAdjacent(new URL(url).pathname) || cfg.rules.isMapAdjacent(det.title);
          const reason = hit ? 'hit' : adjacent ? 'pattern' : inSample(url, cfg.scan.tier2_sample_rate) ? 'sample' : 'none';
          store.store(url, 1, det.findings, null);
          markTier1.run(hit, reason, reason, url);
        }
      });
      tx();
    };

    log.info(`BFS link crawl starting (concurrency ${concurrency}, rate ${cfg.http.requests_per_second_per_host}/s per host, tier-1 during crawl: ${runTier1})`);
    while (!stopping) {
      const batch = claim.all(concurrency * 4).map(r => r.url);
      if (!batch.length) break;
      let i = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => { while (i < batch.length && !stopping) { const u = batch[i++]; await processOne(u); processed++; if (processed % 25 === 0) { const rem = db.prepare(`SELECT COUNT(*) c FROM urls WHERE links_done=0 AND status IN ('pending','done')`).get().c; const el = Date.now() - t0; log.info(`crawl: ${processed} fetched, ${total} known, ${rem} to crawl, ${stats.crawl} new via links, elapsed ${fmtDuration(el)}, ETA ${fmtDuration(rem * el / processed / 1)}`); } } }));
      if (capReached && !db.prepare(`SELECT 1 FROM urls WHERE links_done=0 AND status IN ('pending','done') LIMIT 1`).get()) break;
    }
    process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
    log.info(`BFS crawl ${stopping ? 'interrupted' : 'complete'}: ${processed} pages fetched in ${fmtDuration(Date.now() - t0)}`);
  }

  await http.close();
  const summary = { ...stats, total_urls: total, cap_reached: capReached, cap: maxUrls };
  finishRun(db, runId, summary);
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM urls GROUP BY status').all();
  log.info('inventory summary:', JSON.stringify(summary));
  log.info('queue by status:', byStatus.map(r => `${r.status}=${r.c}`).join(' '));
  if (capReached) log.loud(`URL cap (${maxUrls}) was reached. Discovery is incomplete.`);
  db.close();
}
