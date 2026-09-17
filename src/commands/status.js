import { loadConfig } from '../lib/config.js';
import { openDb, getMeta } from '../lib/db.js';

/** Read-only snapshot of a run (safe to call from a second terminal while the crawl is running). */
export async function status(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const row = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const line = (k, v) => console.log(`${(k + ':').padEnd(22)} ${v}`);
  console.log(`\n== ${cfg.database}`);
  const byStatus = all('SELECT status, COUNT(*) c FROM urls GROUP BY status');
  line('URLs', `${row('SELECT COUNT(*) c FROM urls').c} total — ` + byStatus.map(r => `${r.status} ${r.c}`).join(', '));
  line('tier 1 done', `${row('SELECT COUNT(*) c FROM urls WHERE tier1_done=1').c} (hits ${row('SELECT COUNT(*) c FROM urls WHERE tier1_hit=1').c})`);
  const t2 = all(`SELECT tier2_reason r, SUM(tier2_done) d, COUNT(*) n FROM urls WHERE tier2_reason IS NOT NULL AND tier2_reason<>'none' GROUP BY 1`);
  line('tier 2', t2.map(r => `${r.r} ${r.d}/${r.n}`).join(', ') || 'none scheduled yet');
  const http = all('SELECT http_status s, COUNT(*) c FROM urls WHERE http_status IS NOT NULL GROUP BY 1 ORDER BY c DESC');
  line('HTTP statuses', http.map(r => `${r.s}×${r.c}`).join(' ') || 'none yet');
  line('in progress now', all(`SELECT url FROM urls WHERE status='in_progress'`).map(r => r.url).join(', ') || 'none');
  const apps = all('SELECT vendor, COUNT(*) c FROM applications GROUP BY vendor ORDER BY c DESC');
  line('applications', `${row('SELECT COUNT(*) c FROM applications').c} — ` + (apps.map(r => `${r.vendor} ${r.c}`).join(', ') || 'none'));
  line('findings', row('SELECT COUNT(*) c FROM findings').c);
  line('pages stored', `${row('SELECT COUNT(*) c FROM pages').c} (${(row('SELECT COALESCE(SUM(LENGTH(html_gz)),0) b FROM pages').b / 1048576).toFixed(1)} MB gzipped)`);
  const failed = all(`SELECT url, error FROM urls WHERE status='failed' ORDER BY last_attempt_at DESC LIMIT 5`);
  line('failed', `${row(`SELECT COUNT(*) c FROM urls WHERE status='failed'`).c}` + (failed.length ? '\n' + failed.map(f => `    ${f.url}\n      ${f.error}`).join('\n') : ''));
  const retrying = all(`SELECT url, attempts, error, retry_after FROM urls WHERE status='pending' AND attempts>0 ORDER BY last_attempt_at DESC LIMIT 5`);
  line('awaiting retry', `${row(`SELECT COUNT(*) c FROM urls WHERE status='pending' AND attempts>0`).c}` + (retrying.length ? '\n' + retrying.map(f => `    ${f.url} (attempt ${f.attempts}, ${f.error}, after ${f.retry_after})`).join('\n') : ''));
  const blocked = getMeta(db, 'blocked_at');
  if (blocked) line('BLOCKED', blocked);
  const runs = all('SELECT command, started_at, finished_at, summary_json FROM runs ORDER BY id DESC LIMIT 3');
  line('recent runs', runs.map(r => `${r.command} ${r.started_at.slice(0, 19)} ${r.finished_at ? 'finished' : 'RUNNING/unfinished'} ${r.summary_json || ''}`).join('\n' + ' '.repeat(23)) || 'none');
  console.log('');
  db.close();
}
