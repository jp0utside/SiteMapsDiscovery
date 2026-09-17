import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun, now, getMeta, setMeta } from '../lib/db.js';
import { Scope } from '../lib/url.js';
import { HttpClient, isHtml } from '../lib/fetch.js';
import { parseRobots } from '../lib/robots.js';
import { detectStatic } from '../lib/tier1.js';
import { renderPage } from '../lib/tier2.js';
import { BrowserPool } from '../lib/browser.js';
import { ScreenshotPolicy } from '../lib/screenshots.js';
import { Store, inSample } from '../lib/store.js';
import { HostRateLimiter } from '../lib/ratelimit.js';
import { hostOf } from '../lib/url.js';
import { log, fmtDuration } from '../lib/log.js';
import { applyDetectionPolicy, isHit } from '../lib/detection.js';
import { applyCrawlDelay } from '../lib/robots.js';
import { HealthMonitor, isBlockStatus } from '../lib/health.js';

/**
 * Phase 2 — scan: tier 1 (static fetch, every URL) + tier 2 (headless render of hits, map-adjacent URLs and a random sample).
 * Resumable: rows are claimed pending→in_progress in a transaction; stale in_progress rows are reset on startup;
 * findings are committed per page; failures retry with backoff up to max_retries and never halt the run.
 */
export async function scan(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const scope = new Scope(cfg.scope, cfg.inventory);
  const http = new HttpClient(cfg.http);
  const store = new Store(db);
  const tiers = opts.tier === '1' ? [1] : opts.tier === '2' ? [2] : [1, 2];
  const runId = startRun(db, 'scan', { ...cfg, tiers, limit: opts.limit }, TOOL_VERSION);
  const rules = cfg.rules;

  // Consent mode: auto reads the preflight verdict.
  let consent = { enabled: false, source: 'config' };
  if (cfg.scan.consent === 'on') consent = { enabled: true, source: 'config' };
  else if (cfg.scan.consent === 'auto') {
    const pf = path.resolve(cfg.report.dir, 'preflight.json');
    if (fs.existsSync(pf)) { try { const j = JSON.parse(fs.readFileSync(pf, 'utf8')); consent = { enabled: !!j.consent_gating_detected, source: 'preflight.json' }; } catch {} }
    else consent = { enabled: false, source: 'no preflight.json (run `preflight` to verify)' };
  }
  log.info(`consent handling: ${consent.enabled ? 'ENABLED' : 'disabled'} (${consent.source}); tiers ${tiers.join('+')}; concurrency ${cfg.scan.concurrency}`);

  // robots
  let robots = { isAllowed: () => true };
  if (cfg.http.respect_robots !== false) {
    let txt = getMeta(db, 'robots_txt');
    if (!txt && cfg.seeds.robots) { try { const r = await http.getText(cfg.seeds.robots, { accept: 'text/plain,*/*' }); if (r.status === 200) { txt = r.text; setMeta(db, 'robots_txt', txt); } } catch (e) { log.warn(`robots.txt fetch failed: ${e.message}`); } }
    if (txt) robots = parseRobots(txt, 'smc-map-inventory');
  }
  const allowed = (url) => { try { const u = new URL(url); return robots.isAllowed(u.pathname + u.search); } catch { return true; } };

  // Reset stale in_progress rows (crashed / killed run).
  const staleMin = cfg.scan.stale_in_progress_minutes || 10;
  const stale = db.prepare(`UPDATE urls SET status='pending' WHERE status='in_progress' AND (last_attempt_at IS NULL OR last_attempt_at < ?)`).run(new Date(Date.now() - staleMin * 60000).toISOString());
  if (stale.changes) log.info(`reset ${stale.changes} stale in_progress rows to pending`);
  if (opts.resetInProgress) { const r = db.prepare(`UPDATE urls SET status='pending' WHERE status='in_progress'`).run(); log.info(`--reset-in-progress: ${r.changes} rows`); }

  // Claim: one row per call, inside a transaction (pending → in_progress).
  const t1only = tiers.length === 1 && tiers[0] === 1, t2only = tiers.length === 1 && tiers[0] === 2;
  const onlyList = opts.url ? [].concat(opts.url).map(u => scope.classify(u).url || u) : null;
  const onlyClause = onlyList ? ` AND url IN (${onlyList.map(u => `'${u.replace(/'/g, "''")}'`).join(',')})` : '';
  const where = (t1only ? `status='pending' AND tier1_done=0`
    : t2only ? `status='pending' AND tier1_done=1 AND tier2_done=0 AND tier2_reason IN ('hit','pattern','sample','manual')`
    : `status='pending'`) + onlyClause;
  const claimTx = db.transaction(() => {
    const row = db.prepare(`SELECT url, tier1_done, tier2_done, tier2_reason, title, attempts FROM urls WHERE ${where} AND (retry_after IS NULL OR retry_after <= ?) ORDER BY attempts, rowid LIMIT 1`).get(now());
    if (!row) return null;
    db.prepare(`UPDATE urls SET status='in_progress', last_attempt_at=? WHERE url=?`).run(now(), row.url);
    return row;
  });
  const totalStmt = db.prepare(`SELECT COUNT(*) c FROM urls WHERE ${where.replace("status='pending'", "status IN ('pending','in_progress','done','failed')")}`);
  const remainingStmt = db.prepare(`SELECT COUNT(*) c FROM urls WHERE ${where}`);

  const upd = {
    fetch: db.prepare('UPDATE urls SET http_status=?, final_url=?, title=COALESCE(?, title) WHERE url=?'),
    tier1: db.prepare(`UPDATE urls SET tier1_done=1, tier1_hit=?, tier2_reason=? WHERE url=?`),
    tier2: db.prepare(`UPDATE urls SET tier2_done=1, tier2_hit=? WHERE url=?`),
    done: db.prepare(`UPDATE urls SET status='done', error=NULL, retry_after=NULL WHERE url=?`),
    pendingAgain: db.prepare(`UPDATE urls SET status='pending', retry_after=NULL WHERE url=?`),
    skip: db.prepare(`UPDATE urls SET status='skipped', skip_reason=?, tier1_done=1, tier2_reason='none' WHERE url=?`),
    fail: db.prepare(`UPDATE urls SET status=?, error=?, attempts=?, retry_after=? WHERE url=?`),
    release: db.prepare(`UPDATE urls SET status='pending' WHERE url=? AND status='in_progress'`),
  };

  const pool = new BrowserPool(cfg);
  const shots = new ScreenshotPolicy(cfg, db);
  const navLimiter = new HostRateLimiter(cfg.http.requests_per_second_per_host || 2);
  const consentCookies = consent.enabled ? (rules.cmp.consent_cookies || []).map(c => ({ name: c.name, value: c.value, domain: hostOf(cfg.seeds.homepage), path: '/' })) : null;
  applyCrawlDelay(robots, hostOf(cfg.seeds.homepage), [http.limiter, navLimiter], cfg, log);
  log.info(`detection: vendors ${rules.vendorAllowlist.length ? rules.vendorAllowlist.join(',') : 'ALL'}; links ${cfg.detection.record_links === false ? 'dropped' : 'recorded (flagged)'}; links trigger render: ${cfg.detection.links_trigger_render !== false}`);

  const health = new HealthMonitor({ window: cfg.http.block_window, threshold: cfg.http.block_threshold });
  let blocked = false;
  const checkBlocked = (phase) => { if (blocked || cfg.http.stop_on_block === false || !health.isBlocked()) return; blocked = true; stopping = true; setMeta(db, 'blocked_at', JSON.stringify({ at: now(), phase, summary: health.summary() })); log.loud(`HOST IS REJECTING REQUESTS (${health.summary()}). Stopping the scan so the inventory is not falsely clean. Unfinished pages stay pending; investigate (WAF? rate limit?) then re-run to resume.`); };
  const logNew = (url, newApps) => { for (const f of newApps) log.info(`NEW application ${f.identity_key} [${f.vendor}/${f.type}/${f.placement}] on ${url}`); };
  const t0 = Date.now(); const deadline = cfg.scan.max_runtime_minutes ? t0 + cfg.scan.max_runtime_minutes * 60000 : Infinity;
  let completed = 0, hits = 0, rendered = 0, failed = 0, skipped = 0;
  let stopping = false; const inFlight = new Set();
  const onSig = () => { if (stopping) { log.warn('second Ctrl-C: exiting immediately; in_progress rows will be reset on next start'); for (const u of inFlight) upd.release.run(u); process.exit(130); } stopping = true; log.warn('Ctrl-C: no new pages will be claimed; waiting for in-flight pages (press again to force).'); };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);
  const limit = opts.limit ? Number(opts.limit) : Infinity;
  const only = onlyList ? new Set(onlyList) : null;
  if (only) for (const u of only) { db.prepare(`INSERT OR IGNORE INTO urls(url, source, discovered_at, status) VALUES (?,?,?,'pending')`).run(u, 'manual', now()); db.prepare(`UPDATE urls SET status='pending', tier1_done=0, tier2_done=0, attempts=0, retry_after=NULL, skip_reason=NULL WHERE url=?`).run(u); }

  const total = totalStmt.get().c;
  const progress = () => {
    const el = Date.now() - t0; const rate = completed ? el / completed : 0; const rem = Math.max(0, remainingStmt.get().c);
    const apps = db.prepare('SELECT COUNT(*) c FROM applications').get().c;
    const hitPages = db.prepare('SELECT COUNT(*) c FROM urls WHERE tier1_hit=1 OR tier2_hit=1').get().c, scanned = db.prepare(`SELECT COUNT(*) c FROM urls WHERE tier1_done=1 AND status<>'skipped'`).get().c;
    log.info(`progress: ${completed}/${total} this run, ${rem} remaining | pages with maps ${hitPages}/${scanned} (${scanned ? (100 * hitPages / scanned).toFixed(1) : 0}%) | rendered ${rendered} | ${apps} applications | failed ${failed} skipped ${skipped} | http ${health.summary()} | elapsed ${fmtDuration(el)} | ETA ${fmtDuration(rem * rate)}`);
  };

  async function processRow(row, workerId) {
    const url = row.url; let tier1Hit = row.tier1_done ? null : 0; let reason = row.tier2_reason; let title = row.title;
    if (only) { /* forced re-scan */ }
    // ---- Tier 1
    if (tiers.includes(1) && !row.tier1_done) {
      let res;
      try { res = await http.getText(url); } catch (e) { health.record(null); throw e; }
      health.record(res.status);
      const finalNorm = scope.normalize(res.finalUrl)?.toString() || res.finalUrl;
      upd.fetch.run(res.status, res.finalUrl, null, url);
      if (isBlockStatus(res.status)) throw new Error(`HTTP ${res.status} (block/outage — retrying, not skipping)`);
      if (res.status >= 400) { upd.skip.run(`http_${res.status}`, url); skipped++; return 'skipped'; }
      if (!isHtml(res.contentType)) { upd.skip.run('non_html', url); skipped++; return 'skipped'; }
      if (!scope.isCrawlableHost(new URL(res.finalUrl).host)) { upd.skip.run('redirected_off_host', url); skipped++; return 'skipped'; }
      if (finalNorm !== url && db.prepare('SELECT 1 FROM urls WHERE url=? AND url<>?').get(finalNorm, url)) { upd.skip.run('redirect_duplicate', url); skipped++; return 'skipped'; }
      const det = detectStatic(res.text, url, rules);
      det.findings = applyDetectionPolicy(det.findings, cfg);
      title = det.title; db.prepare('UPDATE urls SET title=? WHERE url=?').run(title || null, url);
      store.storePage(url, res, det.findings.length > 0, cfg.inventory.store_html || 'all');
      tier1Hit = isHit(det.findings, cfg) ? 1 : 0;
      const adjacent = rules.isMapAdjacent(new URL(url).pathname) || rules.isMapAdjacent(title);
      reason = tier1Hit ? 'hit' : adjacent ? 'pattern' : inSample(url, cfg.scan.tier2_sample_rate) ? 'sample' : 'none';
      if (only) reason = reason === 'none' ? 'manual' : reason;
      logNew(url, store.store(url, 1, det.findings, null));
      upd.tier1.run(tier1Hit, reason, url);
      if (tier1Hit) hits++;
    }
    // ---- Tier 2
    const needsT2 = reason && reason !== 'none' && !row.tier2_done;
    if (tiers.includes(2) && needsT2) {
      if (!allowed(url)) { upd.skip.run('robots_disallow', url); skipped++; return 'skipped'; }
      await navLimiter.wait(hostOf(url));
      const ctx = await pool.context(workerId, { cookies: consentCookies });
      const r = await renderPage(ctx, url, { cfg, rules, consent, priorStrong: store.strongKeysForUrl(url), isNewIdentity: (k) => store.needsScreenshot(k), screenshot: (page, key, sel, bbox) => shots.shouldCapture(key, store.needsScreenshot(key)) ? shots.capture(page, key, sel, bbox) : null });
      if (r.error && !r.dom) { health.record(null); throw new Error(`render: ${r.error}`); }
      health.record(r.httpStatus);
      if (isBlockStatus(r.httpStatus)) throw new Error(`HTTP ${r.httpStatus} on render (block/outage — retrying, not skipping)`);
      r.findings = applyDetectionPolicy(r.findings, cfg);
      const t2hit = r.findings.some(f => f.placement !== 'site_chrome' && f.type !== 'map_link_only') ? 1 : 0;
      logNew(url, store.store(url, 2, r.findings, r.requests));
      if (r.title && !title) db.prepare('UPDATE urls SET title=COALESCE(title, ?) WHERE url=?').run(r.title, url);
      upd.tier2.run(t2hit, url);
      rendered++;
      if (t2hit && tier1Hit === 0) hits++;
    } else if (tiers.includes(2) && !needsT2 && t2only) {
      return 'noop';
    }
    if (t1only && reason && reason !== 'none') { upd.pendingAgain.run(url); return 'tier1_only'; } // leave for the tier-2 pass
    upd.done.run(url);
    return 'done';
  }

  let claimed = 0;
  async function worker(workerId) {
    while (!stopping && Date.now() < deadline) {
      if (claimed >= limit) break;
      const row = claimTx(); if (!row) break;
      claimed++;
      inFlight.add(row.url);
      try {
        const outcome = await processRow(row, workerId);
        if (outcome === 'noop') upd.done.run(row.url);
      } catch (e) {
        const attempts = (row.attempts || 0) + 1; const msg = String(e && e.message || e).slice(0, 500);
        const max = cfg.http.max_retries || 3;
        if (attempts >= max) { upd.fail.run('failed', msg, attempts, null, row.url); failed++; log.warn(`FAILED ${row.url}: ${msg}`); }
        else { const backoff = (cfg.http.retry_backoff_ms || 15000) * Math.pow(2, attempts - 1); upd.fail.run('pending', msg, attempts, new Date(Date.now() + backoff).toISOString(), row.url); log.warn(`retry ${attempts}/${max} in ${fmtDuration(backoff)} for ${row.url}: ${msg}`); }
        if (/Target page, context or browser has been closed|browser has disconnected/i.test(msg)) await pool.closeContext(workerId);
      } finally { inFlight.delete(row.url); }
      completed++;
      checkBlocked('scan');
      if (completed % 10 === 0) progress();
    }
  }
  log.info(`scan starting: ${total} URLs in scope for this pass, ${remainingStmt.get().c} remaining`);
  const n = Math.max(1, Number(cfg.scan.concurrency) || 3);
  await Promise.all(Array.from({ length: n }, (_, i) => worker(i)));
  progress();
  if (Date.now() >= deadline) log.warn(`max_runtime_minutes (${cfg.scan.max_runtime_minutes}) reached; stopping. Re-run scan to resume.`);
  if (stopping && !blocked) log.warn('interrupted; re-run scan to resume where it left off.');
  if (blocked) log.loud(`scan STOPPED because the host is rejecting requests (${health.summary()}). ${remainingStmt.get().c} URLs remain pending.`);
  log.info(`http totals this run: ${health.totals() || 'none'}`);
  process.off('SIGINT', onSig); process.off('SIGTERM', onSig);
  await pool.close(); await http.close();
  store.refreshCounts();
  const summary = { completed, hits, rendered, failed, skipped, interrupted: stopping && !blocked, blocked, elapsed_ms: Date.now() - t0, tiers, consent: consent.enabled };
  finishRun(db, runId, summary);
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM urls GROUP BY status').all();
  log.info('scan summary:', JSON.stringify(summary));
  log.info('queue by status:', byStatus.map(r => `${r.status}=${r.c}`).join(' '));
  db.close();
  return summary;
}
