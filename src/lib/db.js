import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  config_json TEXT,
  tool_version TEXT,
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS urls(
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- sitemap | robots | crawl | seed | manual
  discovered_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | in_progress | done | failed | skipped
  tier1_done INTEGER NOT NULL DEFAULT 0,
  tier2_done INTEGER NOT NULL DEFAULT 0,
  tier2_reason TEXT,                 -- hit | pattern | sample | none  (why tier 2 was / was not scheduled)
  http_status INTEGER,
  final_url TEXT,
  title TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  retry_after TEXT,
  links_done INTEGER NOT NULL DEFAULT 0,   -- inventory BFS: outbound links extracted
  skip_reason TEXT,
  tier1_hit INTEGER NOT NULL DEFAULT 0,
  tier2_hit INTEGER NOT NULL DEFAULT 0,
  chrome_keys TEXT                   -- JSON array of identity_keys seen only in site chrome (nav/header/footer) on this page
);
CREATE INDEX IF NOT EXISTS urls_status ON urls(status);
CREATE INDEX IF NOT EXISTS urls_links_done ON urls(links_done, status);
CREATE TABLE IF NOT EXISTS findings(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  vendor TEXT,
  type TEXT,
  confidence TEXT,
  placement TEXT,                    -- main_content | site_chrome
  signal_type TEXT,                  -- network | global | selector | iframe | static_html | link | image | frame
  signal_value TEXT,
  target_url TEXT,
  container_selector TEXT,
  width_px INTEGER,
  height_px INTEGER,
  api_key TEXT,
  arcgis_org TEXT,
  tier INTEGER NOT NULL DEFAULT 1,
  flagged INTEGER NOT NULL DEFAULT 0, -- map_link_only / non_geographic
  rule TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_url ON findings(url);
CREATE INDEX IF NOT EXISTS findings_identity ON findings(identity_key);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  request_url TEXT NOT NULL,
  resource_type TEXT,
  initiator TEXT,
  matched_rule TEXT,
  aborted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_url ON requests(url);
CREATE TABLE IF NOT EXISTS applications(
  identity_key TEXT PRIMARY KEY,
  vendor TEXT,
  type TEXT,
  title TEXT,
  screenshot_path TEXT,
  first_seen_url TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  arcgis_item_id TEXT,
  in_county_org INTEGER,             -- 1 yes | 0 no | NULL unknown / not applicable
  target_url TEXT,
  first_seen_at TEXT,
  per_page INTEGER NOT NULL DEFAULT 0 -- inpage:* identities are inherently per-page
);
CREATE TABLE IF NOT EXISTS arcgis_items(
  item_id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  owner TEXT,
  created TEXT,
  modified TEXT,
  url TEXT,
  org_id TEXT,
  in_org INTEGER NOT NULL DEFAULT 1,
  access TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS pages(
  url TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  http_status INTEGER,
  content_type TEXT,
  final_url TEXT,
  size_bytes INTEGER,
  html_gz BLOB                       -- gzipped raw HTML from the tier-1 fetch; re-analysable offline without recrawling
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

export function openDb(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new Database(abs);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 10000');
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function startRun(db, command, cfg, toolVersion) {
  const safe = { ...cfg }; delete safe.rules; delete safe.rulesRaw; delete safe.__paths;
  const r = db.prepare('INSERT INTO runs(command, started_at, config_json, tool_version) VALUES (?,?,?,?)')
    .run(command, now(), JSON.stringify(safe), toolVersion);
  return Number(r.lastInsertRowid);
}
export function finishRun(db, id, summary) {
  db.prepare('UPDATE runs SET finished_at=?, summary_json=? WHERE id=?').run(now(), JSON.stringify(summary || {}), id);
}
export function setMeta(db, k, v) { db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, typeof v === 'string' ? v : JSON.stringify(v)); }
export function getMeta(db, k) { const r = db.prepare('SELECT value FROM meta WHERE key=?').get(k); return r ? r.value : null; }
