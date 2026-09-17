import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { HttpClient } from '../lib/fetch.js';
import { parseRobots } from '../lib/robots.js';
import { hostOf } from '../lib/url.js';
import { log, fmtDuration } from '../lib/log.js';

/**
 * The one-command workflow for the SMC audit. Runs the settled configuration end to end:
 *   inventory (sitemaps + robots + BFS crawl with tier-1 detection and HTML storage)
 *   → scan (tier-2 headless render of hits, map-adjacent pages and the 20% sample; screenshots)
 *   → arcgis (ArcGIS Online org cross-reference)
 *   → report (CSV / JSONL / HTML, filtered to report.vendors)
 * Every phase is resumable: re-running run-crawl after an interruption continues where it stopped.
 */
export async function runCrawl(opts) {
  const cfg = loadConfig(opts);
  const host = hostOf(cfg.seeds.homepage);
  const t0 = Date.now();

  // ---- Plan / pre-flight summary (also the text to send the web team).
  const plan = [];
  plan.push(`Target host:        ${host} (every path); other hosts are recorded when referenced but never crawled`);
  plan.push(`User-Agent:         ${cfg.http.user_agent}`);
  plan.push(`Rate:               ${cfg.http.requests_per_second_per_host} page requests/s per host, ${cfg.scan.concurrency} pages in flight; rendered pages also load their own assets like a browser`);
  plan.push(`robots.txt:         Disallow rules honoured; Crawl-delay ${cfg.http.respect_crawl_delay === false ? 'OVERRIDDEN with site-owner approval' : 'honoured'}`);
  plan.push(`Detection:          ${cfg.detection.vendors.length ? cfg.detection.vendors.join(', ') : 'all vendors'} recorded; links ${cfg.detection.record_links === false ? 'dropped' : 'recorded (flagged)'}, links trigger render: ${cfg.detection.links_trigger_render !== false}`);
  plan.push(`Report:             ${cfg.report.vendors && cfg.report.vendors.length ? cfg.report.vendors.join(', ') + ' only' : 'all recorded vendors'} → ${path.resolve(cfg.report.dir)}`);
  plan.push(`Stored HTML:        ${cfg.inventory.store_html || 'all'} (gzipped, in the database)`);
  plan.push(`Screenshots:        ${cfg.screenshots.mode} → ${path.resolve(cfg.screenshots.dir)} (cap ${cfg.screenshots.max_images})`);
  plan.push(`Tier-2 sample:      ${Math.round((cfg.scan.tier2_sample_rate || 0) * 100)}% of tier-1 misses rendered`);
  plan.push(`Database:           ${path.resolve(cfg.database)}`);
  plan.push(`Max runtime:        ${cfg.scan.max_runtime_minutes ? cfg.scan.max_runtime_minutes + ' min (scan phase; re-run to resume)' : 'unbounded'}`);
  let robots = null;
  try { const http = new HttpClient(cfg.http); const r = await http.getText(cfg.seeds.robots, { accept: 'text/plain,*/*' }); await http.close(); if (r.status === 200) robots = parseRobots(r.text, 'smc-map-inventory'); plan.push(`robots.txt fetched:  HTTP ${r.status}${robots?.crawlDelay ? `, Crawl-delay ${robots.crawlDelay}s declared` : ''}`); }
  catch (e) { plan.push(`robots.txt fetch:    FAILED (${e.message.split('\n')[0]}) — check network access before continuing`); }
  console.log('\n================ RUN PLAN ================\n' + plan.join('\n') + '\n==========================================');
  const notice = `Heads-up: automated inventory crawl of ${host} starting ${new Date().toISOString()}. About ${cfg.http.requests_per_second_per_host} page requests per second (plus browser-like asset loads for rendered pages), ${cfg.scan.concurrency} pages in flight, expected to run roughly 4-5 hours. User-Agent "${cfg.http.user_agent}". Read-only GET requests to public pages; robots.txt Disallow rules respected.`;
  console.log('\nText for the web team:\n' + notice + '\n');
  console.log('While it runs: a progress line every 10 pages (every 25 during discovery), a line for each newly found application, warnings for retries, and a loud STOP if the host starts rejecting requests. Ctrl-C once = finish in-flight pages and exit cleanly; re-run run-crawl to resume. In another terminal: node bin/cli.js status\n');
  if (opts.plan) return;
  if (/<FILL IN>/.test(cfg.http.user_agent)) throw new Error('config.yaml → http.user_agent still contains <FILL IN>; set a real contact before crawling.');
  if (opts.confirm === false) { /* --no-confirm: proceed */ } else if (!process.stdin.isTTY) { log.info('non-interactive; proceeding'); } else {
    process.stdout.write('Proceed with the crawl? [y/N] ');
    const ans = await new Promise(r => { process.stdin.once('data', d => r(String(d).trim().toLowerCase())); });
    process.stdin.pause();
    if (ans !== 'y' && ans !== 'yes') { console.log('aborted'); return; }
  }
  const db = openDb(cfg.database); const phases = { inventory: 0, scan: 0, arcgis: 0, report: 0 }; db.close();
  const phase = async (name, fn) => { const t = Date.now(); log.info(`===== ${name} starting =====`); const r = await fn(); phases[name] = Date.now() - t; log.info(`===== ${name} done in ${fmtDuration(phases[name])} =====`); return r || {}; };
  const sub = { ...opts, plan: undefined, confirm: undefined };
  const halt = (r, name) => {
    if (r.blocked) { console.log(`\nrun-crawl STOPPED during ${name}: the host is rejecting requests. Nothing was marked clean; unfinished pages stay pending. Check with the web team (WAF / rate limit), then re-run run-crawl to resume.`); return true; }
    if (r.interrupted) { console.log(`\nrun-crawl interrupted during ${name}. Progress is saved; re-run run-crawl to resume.`); return true; }
    return false;
  };
  const inv = await phase('inventory', async () => (await import('./inventory.js')).inventory(sub));
  if (halt(inv, 'inventory')) return;
  const sc = await phase('scan', async () => (await import('./scan.js')).scan({ ...sub, tier: undefined }));
  if (halt(sc, 'scan')) return;
  const pending = (() => { const d = openDb(cfg.database); const c = d.prepare(`SELECT COUNT(*) c FROM urls WHERE status IN ('pending','in_progress')`).get().c; d.close(); return c; })();
  if (pending) log.warn(`${pending} URLs still pending (interrupted or max_runtime reached). Re-run run-crawl to resume; the report below reflects partial coverage.`);
  await phase('arcgis', async () => { try { await (await import('./arcgis.js')).arcgis(sub); } catch (e) { log.error(`arcgis cross-reference failed: ${e.message.split('\n')[0]} — continuing; re-run \`arcgis\` later`); } });
  await phase('report', async () => (await import('./report.js')).report(sub));
  console.log(`\nrun-crawl finished in ${fmtDuration(Date.now() - t0)}: ` + Object.entries(phases).map(([k, v]) => `${k} ${fmtDuration(v)}`).join(', '));
  console.log(`Outputs: ${path.resolve(cfg.report.dir)}/report.html, applications.csv, occurrences.csv, findings.jsonl · database ${path.resolve(cfg.database)}`);
  if (pending) console.log(`NOTE: ${pending} URLs pending — run \`run-crawl\` again to finish, then the report regenerates.`);
}
