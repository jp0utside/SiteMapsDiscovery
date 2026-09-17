import { loadConfig, TOOL_VERSION } from '../lib/config.js';
import { openDb, startRun, finishRun, now, setMeta } from '../lib/db.js';
import { HttpClient } from '../lib/fetch.js';
import { log } from '../lib/log.js';

/**
 * ArcGIS Online org cross-reference — PUBLIC item search only (consistent with the client-side constraint).
 * Enumerates publicly shared items in the county org, then classifies every ArcGIS application found by the crawl:
 * embedded (in org + on a page), orphaned (in org, on no page), external (on a page, not in the org).
 */
export async function arcgis(opts) {
  const cfg = loadConfig(opts);
  const db = openDb(cfg.database);
  const http = new HttpClient(cfg.http);
  const runId = startRun(db, 'arcgis', cfg, TOOL_VERSION);
  const orgHost = cfg.arcgis.org_host;
  const orgBase = cfg.arcgis.org_base_url || `https://${orgHost}`;
  const portalBase = cfg.arcgis.portal_base_url || 'https://www.arcgis.com';
  const getJson = async (url) => { const r = await http.getText(url, { accept: 'application/json' }); if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`); const j = JSON.parse(r.text); if (j.error) throw new Error(`${j.error.message || JSON.stringify(j.error)} for ${url}`); return j; };

  // 1. Org id from the public portal self endpoint.
  const self = await getJson(`${orgBase}/sharing/rest/portals/self?f=json`);
  const orgId = self.id; const orgName = self.name || orgHost;
  if (!orgId) throw new Error(`could not determine org id from https://${orgHost}/sharing/rest/portals/self`);
  setMeta(db, 'arcgis_org', { id: orgId, name: orgName, host: orgHost, urlKey: self.urlKey, fetched_at: now() });
  log.info(`ArcGIS org: ${orgName} (${orgId}) at ${orgHost}`);

  // 2. Enumerate public items of the configured types.
  const types = cfg.arcgis.item_types || [];
  const typeQ = types.length ? ' AND (' + types.map(t => `type:"${t}"`).join(' OR ') + ')' : '';
  const q = encodeURIComponent(`orgid:${orgId}${typeQ}`);
  const ups = db.prepare(`INSERT INTO arcgis_items(item_id, title, type, owner, created, modified, url, org_id, in_org, access, fetched_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)
    ON CONFLICT(item_id) DO UPDATE SET title=excluded.title, type=excluded.type, owner=excluded.owner, created=excluded.created, modified=excluded.modified, url=excluded.url, org_id=excluded.org_id, in_org=1, access=excluded.access, fetched_at=excluded.fetched_at`);
  let start = 1, total = 0, pages = 0;
  while (start > 0 && pages < 500) {
    const j = await getJson(`${orgBase}/sharing/rest/search?f=json&num=100&start=${start}&sortField=modified&sortOrder=desc&q=${q}`);
    const tx = db.transaction((items) => { for (const it of items) ups.run(it.id, it.title || null, it.type || null, it.owner || null, iso(it.created), iso(it.modified), it.url || null, it.orgId || orgId, it.access || null, now()); });
    tx(j.results || []); total += (j.results || []).length; pages++;
    start = j.nextStart > 0 ? j.nextStart : -1;
    if (pages === 1) log.info(`org search reports ${j.total} public items`);
  }
  log.info(`stored ${total} org items`);

  // 3. Classify crawl findings. Unknown item ids are looked up individually (public item endpoint).
  const apps = db.prepare(`SELECT identity_key, arcgis_item_id, title FROM applications WHERE arcgis_item_id IS NOT NULL`).all();
  const upsExt = db.prepare(`INSERT INTO arcgis_items(item_id, title, type, owner, created, modified, url, org_id, in_org, access, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(item_id) DO UPDATE SET title=COALESCE(excluded.title, title), type=COALESCE(excluded.type, type), owner=COALESCE(excluded.owner, owner), org_id=COALESCE(excluded.org_id, org_id), in_org=excluded.in_org, access=COALESCE(excluded.access, access), fetched_at=excluded.fetched_at`);
  const setApp = db.prepare(`UPDATE applications SET in_county_org=?, title=COALESCE(?, title) WHERE identity_key=?`);
  let embedded = 0, external = 0, unknown = 0;
  for (const a of apps) {
    const known = db.prepare('SELECT * FROM arcgis_items WHERE item_id=?').get(a.arcgis_item_id);
    if (known && known.in_org === 1 && known.org_id === orgId) { setApp.run(1, known.title, a.identity_key); embedded++; continue; }
    try {
      const it = await getJson(`${portalBase}/sharing/rest/content/items/${a.arcgis_item_id}?f=json`);
      const inOrg = it.orgId === orgId ? 1 : 0;
      upsExt.run(it.id, it.title || null, it.type || null, it.owner || null, iso(it.created), iso(it.modified), it.url || null, it.orgId || null, inOrg, it.access || null, now());
      setApp.run(inOrg, it.title || null, a.identity_key);
      if (inOrg) embedded++; else { external++; log.warn(`EXTERNAL item ${a.arcgis_item_id} "${it.title}" owner=${it.owner} org=${it.orgId || '?'}`); }
    } catch (e) {
      // Not publicly readable (private item / deleted). Record as unknown; the report lists it separately.
      upsExt.run(a.arcgis_item_id, null, null, null, null, null, null, null, 0, 'unknown', now());
      setApp.run(null, null, a.identity_key); unknown++;
      log.warn(`item ${a.arcgis_item_id}: not readable (${e.message.split('\n')[0]}) — ownership unknown`);
    }
  }
  // Hosted services carry the org id in their identity: arcgis:service:<orgId>/<Name>
  const svcs = db.prepare(`SELECT identity_key FROM applications WHERE identity_key LIKE 'arcgis:service:%'`).all();
  let svcIn = 0, svcOut = 0;
  for (const a of svcs) { const oid = a.identity_key.slice('arcgis:service:'.length).split('/')[0]; const inOrg = oid === orgId ? 1 : 0; db.prepare('UPDATE applications SET in_county_org=? WHERE identity_key=?').run(inOrg, a.identity_key); if (inOrg) svcIn++; else { svcOut++; log.warn(`EXTERNAL hosted service ${a.identity_key} (org ${oid})`); } }
  if (svcs.length) log.info(`hosted services: ${svcIn} in org, ${svcOut} external`);
  const orphaned = db.prepare(`SELECT COUNT(*) c FROM arcgis_items i WHERE i.in_org=1 AND i.org_id=? AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.arcgis_item_id=i.item_id)`).get(orgId).c;
  const summary = { org_id: orgId, org_items: total, embedded, orphaned, external, unknown, services_in_org: svcIn, services_external: svcOut };
  finishRun(db, runId, summary);
  log.info('arcgis cross-reference:', JSON.stringify(summary));
  await http.close(); db.close();
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
