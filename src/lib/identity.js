import crypto from 'node:crypto';

export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
export const shortHash = (s) => sha1(s).slice(0, 16);
const HEX32 = /\b[0-9a-f]{32}\b/i;

/**
 * Resolve a stable identity for the APPLICATION behind a target URL (iframe src, link href, request url).
 * Resolution order (spec §8): ArcGIS item id → Google My Maps mid → Mapbox style → iframe origin+path.
 * Returns { key, arcgisItemId, arcgisOrg, apiKey, params } or null when the URL is not parseable.
 */
export function resolveIdentity(targetUrl, rules, matchedRule = null) {
  if (!targetUrl) return null;
  if (matchedRule && matchedRule.identity_key) { // rule-level fixed identity (e.g. collapse all Google directions links)
    const base = resolveIdentity(targetUrl, rules) || {};
    return { ...base, key: matchedRule.identity_key };
  }
  const idParams = new Set((rules?.identity?.identifying_params) || ['id', 'appid', 'webmap', 'mid']);
  const credParams = (rules?.identity?.credential_params) || ['key', 'access_token', 'apikey'];
  // mapbox://styles/<org>/<id>
  const mb = String(targetUrl).match(/mapbox:\/\/styles\/([^/?#\s"']+)\/([^/?#\s"']+)/i);
  if (mb) return { key: `mapbox:style:${mb[1]}/${mb[2]}`, arcgisItemId: null, arcgisOrg: null, apiKey: null, params: {} };
  let u; try { u = new URL(targetUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const q = u.searchParams;
  const out = { key: null, arcgisItemId: null, arcgisOrg: null, apiKey: null, params: {} };
  for (const p of credParams) if (q.get(p)) { out.apiKey = q.get(p); break; }
  for (const p of ['appid', 'webmap', 'id', 'viewer', 'mid']) if (q.get(p)) out.params[p] = q.get(p);

  // 1. ArcGIS
  if (/(^|\.)arcgis\.com$/.test(host) || /\/arcgis\/apps\//i.test(u.pathname)) {
    const m = host.match(/^([a-z0-9-]+)\.maps\.arcgis\.com$/);
    if (m) out.arcgisOrg = m[1];
    // 1a. AGOL hosted services: services.arcgis.com/<orgId>/arcgis/rest/services/<Name>/FeatureServer[/0]
    const svc = u.pathname.match(/^\/(?:tiles\/)?([A-Za-z0-9]{8,32})\/arcgis\/rest\/services\/(.+?)\/(FeatureServer|MapServer|ImageServer|VectorTileServer|SceneServer)\b/i);
    if (svc && /^(services|tiles)\d*\.arcgis\.com$/.test(host)) { out.arcgisOrgId = svc[1]; out.key = `arcgis:service:${svc[1]}/${svc[2]}`; out.serviceName = svc[2]; return out; }
    let id = q.get('id') || q.get('appid') || q.get('webmap');
    if (!id) {
      const pm = u.pathname.match(/\/(experience|dashboards|opsdashboard|stories|collections|instant\/[a-z0-9_-]+|apps\/[A-Za-z]+)\/([0-9a-f]{32})\b/i) || u.pathname.match(HEX32);
      if (pm) id = pm[pm.length - 1];
    }
    if (id && HEX32.test(id)) { out.arcgisItemId = id.toLowerCase(); out.key = `arcgis:item:${out.arcgisItemId}`; return out; }
  }
  // 2. Google My Maps
  if (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/maps\/d\//.test(u.pathname) && q.get('mid')) {
    out.key = `gmymaps:mid:${q.get('mid')}`; return out;
  }
  // 3. Mapbox style URLs served over https (api.mapbox.com/styles/v1/<org>/<id>)
  const ms = (host === 'api.mapbox.com') && u.pathname.match(/^\/styles\/v1\/([^/]+)\/([^/]+)/);
  if (ms) { out.key = `mapbox:style:${ms[1]}/${ms[2]}`; return out; }
  // 4. origin + path, query dropped except identifying params
  const kept = [];
  for (const [k, v] of q) if (idParams.has(k.toLowerCase())) kept.push(`${k}=${v.length > 64 ? 'h' + shortHash(v) : v}`);
  // normalise the path so /apps/viewer and /apps/viewer/ are one application (extension-less last segment → trailing slash)
  let p = u.pathname.replace(/\/{2,}/g, '/');
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (last && !last.includes('.')) p += '/';
  out.key = `iframe:${host}${p}${kept.length ? '?' + kept.join('&') : ''}`;
  return out;
}

/** 5. in-page maps with no external identity — inherently per-page. */
export function inpageIdentity(vendor, pageUrl, containerSelector) {
  return `inpage:${vendor}:${pageUrl}:${containerSelector || '*'}`;
}
export const isPerPageIdentity = (key) => key.startsWith('inpage:');
export const screenshotName = (key) => `${shortHash(key)}.jpg`;
