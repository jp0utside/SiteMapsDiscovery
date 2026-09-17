import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun } from '../lib/db.js';
import { BrowserPool } from '../lib/browser.js';
import { ScreenshotPolicy } from '../lib/screenshots.js';
import { HostRateLimiter } from '../lib/ratelimit.js';
import { hostOf } from '../lib/url.js';
import { log } from '../lib/log.js';

/**
 * Catch-up screenshots: capture an image for every application that has none, by revisiting one page
 * where it appears in content. One navigation per application; skips link-only and site-chrome-only apps.
 */
export async function screenshots(opts) {
  const cfg = loadConfig(opts);
  if (cfg.screenshots.mode === 'none') cfg.screenshots.mode = 'identity';
  const db = openDb(cfg.database);
  const runId = startRun(db, 'screenshots', cfg, TOOL_VERSION);
  const apps = db.prepare(`
    SELECT a.identity_key, f.url, f.container_selector FROM applications a
    JOIN findings f ON f.identity_key = a.identity_key AND f.placement='main_content' AND f.type<>'map_link_only'
    WHERE a.screenshot_path IS NULL
    GROUP BY a.identity_key ORDER BY a.identity_key`).all();
  log.info(`${apps.length} applications without a screenshot`);
  if (!apps.length) { finishRun(db, runId, { captured: 0 }); db.close(); return; }
  const pool = new BrowserPool(cfg); const shots = new ScreenshotPolicy(cfg, db); const limiter = new HostRateLimiter(cfg.http.requests_per_second_per_host || 2);
  const upd = db.prepare('UPDATE applications SET screenshot_path=? WHERE identity_key=?');
  let captured = 0, failed = 0;
  for (const a of apps) {
    if (!shots.shouldCapture(a.identity_key, true)) break;
    await limiter.wait(hostOf(a.url));
    const ctx = await pool.context(0);
    const page = await ctx.newPage();
    try {
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: cfg.scan.tier2_networkidle_timeout_ms || 30000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, cfg.scan.tier2_settle_ms || 1500));
      const p = await shots.capture(page, a.identity_key, a.container_selector, null);
      if (p) { upd.run(p, a.identity_key); captured++; log.info(`captured ${a.identity_key} ← ${a.url}`); } else failed++;
    } catch (e) { failed++; log.warn(`screenshot ${a.identity_key} failed: ${String(e.message).split('\n')[0]}`); }
    finally { await page.close().catch(() => {}); }
  }
  await pool.close();
  finishRun(db, runId, { captured, failed });
  log.info(`screenshots: captured ${captured}, failed ${failed}`);
  db.close();
}
