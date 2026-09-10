import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { compileRules } from './rules.js';

export const TOOL_VERSION = '1.0.0';

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

const DEFAULTS = {
  scope: { crawl_allowlist: [], normalize_to_www: {}, never_crawl: ['*'], record_always: true },
  seeds: { sitemaps: [] },
  inventory: { max_urls: 50000, bfs_link_crawl: true, run_tier1_during_crawl: true, skip_extensions: [], strip_query_params: [] },
  http: { user_agent: 'SMC-Map-Inventory/1.0', requests_per_second_per_host: 2, timeout_ms: 30000, max_retries: 3, retry_backoff_ms: 15000, respect_robots: true, max_html_bytes: 5000000 },
  scan: { concurrency: 3, tier2_sample_rate: 0.2, tier2_networkidle_timeout_ms: 30000, tier2_max_clicks: 10, tier2_scroll_step_px: 800, tier2_scroll_pause_ms: 250, tier2_settle_ms: 1500, context_recycle_pages: 200, stale_in_progress_minutes: 10, max_runtime_minutes: 0, viewport: { width: 1366, height: 900 }, abort_matched_resource_types: ['image', 'media', 'font'], consent: 'auto' },
  screenshots: { mode: 'identity', dir: './screenshots', max_images: 1000, jpeg_quality: 70 },
  arcgis: { org_host: 'smcmaps.maps.arcgis.com', org_slug: 'smcmaps', item_types: [] },
  report: { dir: './output', probe_api_keys: true, title: 'Map Application Inventory' },
  database: './inventory.sqlite',
};

/**
 * Load config.yaml + rules.yaml, apply CLI overrides, compile rules.
 * opts: { config, rules, db, concurrency, screenshots, ... } from the CLI.
 */
export function loadConfig(opts = {}) {
  const configPath = path.resolve(opts.config || 'config.yaml');
  const rulesPath = path.resolve(opts.rules || 'rules.yaml');
  if (!fs.existsSync(configPath)) throw new Error(`config file not found: ${configPath}`);
  if (!fs.existsSync(rulesPath)) throw new Error(`rules file not found: ${rulesPath}`);
  const raw = YAML.parse(fs.readFileSync(configPath, 'utf8')) || {};
  const cfg = deepMerge(DEFAULTS, raw);
  if (opts.db) cfg.database = opts.db;
  if (opts.concurrency) cfg.scan.concurrency = Number(opts.concurrency);
  if (opts.screenshots) cfg.screenshots.mode = opts.screenshots;
  if (opts.maxRuntime != null) cfg.scan.max_runtime_minutes = Number(opts.maxRuntime);
  if (opts.out) cfg.report.dir = opts.out;
  if (opts.consent) cfg.scan.consent = opts.consent;
  cfg.__paths = { config: configPath, rules: rulesPath, base: path.dirname(configPath) };
  cfg.rulesRaw = YAML.parse(fs.readFileSync(rulesPath, 'utf8')) || {};
  cfg.rules = compileRules(cfg.rulesRaw);
  return cfg;
}
