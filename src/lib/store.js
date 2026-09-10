import { now } from './db.js';
import { isPerPageIdentity, sha1 } from './identity.js';

const TYPE_RANK = { gis_application: 7, story_map: 6, interactive_webmap: 5, embedded_third_party: 4, thematic_chart_map: 4, static_map_image: 3, non_geographic: 2, map_link_only: 1 };
export const typeRank = (t) => TYPE_RANK[t] || 0;

/** Deterministic 20% sample decision so that a resumed run makes the same choice. */
export function inSample(url, rate) { return (parseInt(sha1('sample:' + url).slice(0, 8), 16) / 0x100000000) < rate; }

export class Store {
  constructor(db) {
    this.db = db;
    this.stmts = {
      delFindings: db.prepare('DELETE FROM findings WHERE url=? AND tier=?'),
      delInpageStar: db.prepare("DELETE FROM findings WHERE url=? AND tier=1 AND identity_key LIKE 'inpage:%:*'"),
      delInpageStarVendor: db.prepare("DELETE FROM findings WHERE url=? AND tier=1 AND identity_key = 'inpage:' || ? || ':' || ? || ':*'"),
      delRequests: db.prepare('DELETE FROM requests WHERE url=?'),
      chromeExists: db.prepare(`SELECT 1 FROM findings WHERE identity_key=? AND placement='site_chrome' AND signal_value=? LIMIT 1`),
      getChrome: db.prepare('SELECT chrome_keys FROM urls WHERE url=?'),
      setChrome: db.prepare('UPDATE urls SET chrome_keys=? WHERE url=?'),
      insFinding: db.prepare(`INSERT INTO findings(url, identity_key, vendor, type, confidence, placement, signal_type, signal_value, target_url, container_selector, width_px, height_px, api_key, arcgis_org, tier, flagged, rule, detected_at)
        VALUES (@url,@identity_key,@vendor,@type,@confidence,@placement,@signal_type,@signal_value,@target_url,@container_selector,@width_px,@height_px,@api_key,@arcgis_org,@tier,@flagged,@rule,@detected_at)`),
      insRequest: db.prepare('INSERT INTO requests(url, request_url, resource_type, initiator, matched_rule, aborted) VALUES (?,?,?,?,?,?)'),
      getApp: db.prepare('SELECT * FROM applications WHERE identity_key=?'),
      insApp: db.prepare(`INSERT INTO applications(identity_key, vendor, type, title, screenshot_path, first_seen_url, occurrence_count, arcgis_item_id, in_county_org, target_url, first_seen_at, per_page)
        VALUES (?,?,?,?,?,?,0,?,NULL,?,?,?)`),
      updApp: db.prepare('UPDATE applications SET type=?, title=COALESCE(title,?), screenshot_path=COALESCE(screenshot_path,?), target_url=COALESCE(target_url,?) WHERE identity_key=?'),
    };
    this.txStore = db.transaction((url, tier, findings, requests) => {
      this.stmts.delFindings.run(url, tier);
      if (tier === 2) {
        // a rendered container (selector/global/network with a concrete container) supersedes every tier-1 placeholder;
        // a strong identity of vendor V (arcgis item / mapbox style / gmymaps) supersedes the tier-1 placeholder for V.
        if (findings.some(f => f.container_selector && f.container_selector !== '*' && ['selector', 'global', 'network'].includes(f.signal_type))) this.stmts.delInpageStar.run(url);
        for (const v of new Set(findings.filter(f => f.placement === 'main_content' && !isPerPageIdentity(f.identity_key) && f.type !== 'map_link_only').map(f => f.vendor))) this.stmts.delInpageStarVendor.run(url, v, url);
      }
      if (requests) { this.stmts.delRequests.run(url); for (const r of requests) this.stmts.insRequest.run(url, r.request_url, r.resource_type, r.initiator, r.matched_rule, r.aborted ? 1 : 0); }
      const t = now();
      // Site-chrome findings (mega-menu, header, footer) are the same on every page: keep ONE exemplar finding row
      // per (application, signal) and record page presence compactly on the urls row instead of a row per page.
      const chromeKeys = new Set();
      try { for (const k of JSON.parse((this.stmts.getChrome.get(url) || {}).chrome_keys || '[]')) chromeKeys.add(k); } catch {}
      const kept = [];
      for (const f of findings) {
        if (f.placement !== 'site_chrome') { kept.push(f); continue; }
        chromeKeys.add(f.identity_key);
        if (!this.stmts.chromeExists.get(f.identity_key, String(f.signal_value).slice(0, 2000))) kept.push(f);
        else { const app = this.stmts.getApp.get(f.identity_key); if (app) this.stmts.updApp.run(typeRank(f.type) > typeRank(app.type) ? f.type : app.type, f.title || null, null, f.target_url || null, f.identity_key); }
      }
      this.stmts.setChrome.run(chromeKeys.size ? JSON.stringify([...chromeKeys]) : null, url);
      findings = kept;
      for (const f of findings) {
        this.stmts.insFinding.run({ ...f, tier, detected_at: t, width_px: f.width_px ?? null, height_px: f.height_px ?? null, api_key: f.api_key ?? null, arcgis_org: f.arcgis_org ?? null, container_selector: f.container_selector ?? null, target_url: f.target_url ?? null, flagged: f.flagged ? 1 : 0, rule: f.rule ?? null });
        const app = this.stmts.getApp.get(f.identity_key);
        if (!app) this.stmts.insApp.run(f.identity_key, f.vendor, f.type, f.title || null, f.screenshot_path || null, url, f.arcgis_item_id || null, f.target_url || null, t, isPerPageIdentity(f.identity_key) ? 1 : 0);
        else this.stmts.updApp.run(typeRank(f.type) > typeRank(app.type) ? f.type : app.type, f.title || null, f.screenshot_path || null, f.target_url || null, f.identity_key);
      }
    });
  }
  isNewIdentity(key) { return !this.stmts.getApp.get(key); }
  needsScreenshot(key) { const a = this.stmts.getApp.get(key); return !a || !a.screenshot_path; }
  /** Strong identities (arcgis item / mapbox style / gmymaps) already recorded for this page by tier 1, by vendor. */
  strongKeysForUrl(url) {
    const rows = this.db.prepare(`SELECT DISTINCT identity_key, vendor FROM findings WHERE url=? AND placement='main_content' AND (identity_key LIKE 'arcgis:item:%' OR identity_key LIKE 'mapbox:style:%' OR identity_key LIKE 'gmymaps:%')`).all(url);
    const m = new Map(); for (const r of rows) { if (!m.has(r.vendor)) m.set(r.vendor, new Set()); m.get(r.vendor).add(r.identity_key); } return m;
  }
  store(url, tier, findings, requests) { this.txStore(url, tier, findings, requests); }
  /** Recompute occurrence counts (distinct pages per application) — cheap and always consistent. */
  refreshCounts() {
    this.db.exec(`UPDATE applications SET occurrence_count = (
      SELECT COUNT(*) FROM (
        SELECT url FROM findings f WHERE f.identity_key = applications.identity_key AND f.placement='main_content'
        UNION SELECT u.url FROM urls u, json_each(u.chrome_keys) j WHERE u.chrome_keys IS NOT NULL AND j.value = applications.identity_key))`);
    // tier-1 placeholder identities (inpage:*:<url>:*) superseded by a tier-2 container identity leave no findings behind
    this.db.exec(`DELETE FROM applications WHERE occurrence_count = 0 AND screenshot_path IS NULL`);
  }
}
