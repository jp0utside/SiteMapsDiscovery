import { pageScript, clickCandidatesScript } from './page-script.js';
import { resolveIdentity, inpageIdentity } from './identity.js';
import { finding } from './tier1.js';
import { hostOf } from './url.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Tier 2 — headless render of one page. Returns { title, findings, requests, clicks, frames, error }.
 * onNewIdentity(identityKey) → bool tells us whether to screenshot; screenshot(page, key, sel, bbox) captures.
 */
export async function renderPage(context, url, { cfg, rules, isNewIdentity, screenshot, consent, priorStrong }) {
  const page = await context.newPage();
  const scan = cfg.scan;
  const abortTypes = new Set(scan.abort_matched_resource_types || []);
  const requests = []; let locked = false; const reqSeen = new Set();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route('**/*', async (route) => {
    const req = route.request();
    try {
      const isMain = req.frame() === page.mainFrame();
      if (locked && req.isNavigationRequest() && isMain) return route.abort('aborted'); // never navigate away
      const rurl = req.url();
      const m = rules.matchRequestUrl(rurl);
      if (!m && scan.record_all_requests !== false) {
        // Unmatched requests are kept too (query stripped, deduped per page, capped) so hosts nobody thought of
        // can still be searched offline after the crawl.
        const bare = rurl.split('?')[0].split('#')[0]; const key = 'all|' + bare;
        if (!reqSeen.has(key) && requests.length < (scan.max_requests_per_page || 400)) { reqSeen.add(key); requests.push({ request_url: bare.slice(0, 2000), resource_type: req.resourceType(), initiator: isMain ? 'main' : (req.frame().url() || 'frame'), matched_rule: null, aborted: 0, main: isMain, unmatched: true }); }
      }
      if (m) {
        const rtype = req.resourceType();
        const initiator = isMain ? 'main' : (req.frame().url() || 'frame');
        const key = rurl.split('?')[0] + '|' + rtype;
        const abort = abortTypes.has(rtype);
        if (!reqSeen.has(key) || requests.length < 50) { reqSeen.add(key); requests.push({ request_url: rurl.slice(0, 2000), resource_type: rtype, initiator, matched_rule: m.rule.id, kind: m.kind, vendor: m.rule.vendor, type: m.rule.type, confidence: m.rule.confidence, aborted: abort ? 1 : 0, main: isMain }); }
        if (abort) return route.abort('aborted');
      }
      return route.continue();
    } catch { try { await route.continue(); } catch {} }
  });

  const result = { title: '', findings: [], requests, clicks: [], frames: [], error: null, httpStatus: null, finalUrl: null };
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: scan.tier2_networkidle_timeout_ms || 30000 });
    result.httpStatus = resp ? resp.status() : null; result.finalUrl = page.url();
    await page.waitForLoadState('networkidle', { timeout: scan.tier2_networkidle_timeout_ms || 30000 }).catch(() => {});
    if (consent && consent.enabled) await acceptConsent(page, rules).catch(() => {});
    locked = true;
    // Scroll full height in increments to trigger IntersectionObserver lazy-init.
    await scrollThrough(page, scan.tier2_scroll_step_px || 800, scan.tier2_scroll_pause_ms || 250).catch(() => {});
    // Click map-ish controls, tabs, accordions (capped; never forms; never navigate).
    result.clicks = await clickProbe(page, rules, scan.tier2_max_clicks || 10).catch(() => []);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await sleep(scan.tier2_settle_ms || 1500);
    // DOM + globals, piercing shadow roots.
    const dom = await page.evaluate(pageScript, rules.forBrowser()).catch(e => ({ error: e.message, globals: [], selectors: [], iframes: [], links: [], images: [], title: '' }));
    result.title = dom.title || '';
    result.dom = dom;
    // Frames: record every cross-origin frame URL. Map-looking frames are findings, not crawl targets.
    const pageHost = hostOf(url);
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const fu = f.url(); if (!fu || fu === 'about:blank' || fu.startsWith('about:')) continue;
      result.frames.push({ url: fu, crossOrigin: hostOf(fu) !== pageHost, parent: f.parentFrame() === page.mainFrame() ? 'main' : (f.parentFrame()?.url() || '') });
    }
    result.findings = composeFindings(url, dom, requests, result.frames, rules, priorStrong);
    // Screenshots: one per new identity (policy handled by caller-provided callbacks).
    if (screenshot) {
      const done = new Set();
      for (const f of result.findings) {
        if (done.has(f.identity_key) || f.placement === 'site_chrome' || f.type === 'map_link_only') continue;
        if (!isNewIdentity(f.identity_key)) continue;
        done.add(f.identity_key);
        const p = await screenshot(page, f.identity_key, f.container_selector, f.bbox);
        if (p) f.screenshot_path = p;
      }
    }
  } catch (e) {
    result.error = String(e && e.message || e).split('\n')[0].slice(0, 500);
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

async function scrollThrough(page, step, pause) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const max = Math.min(height, 40000);
  for (let y = 0; y < max; y += step) { await page.evaluate(v => window.scrollTo(0, v), y); await sleep(pause); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(pause);
}

async function clickProbe(page, rules, max) {
  const R = { clickTextRegex: rules.interaction.click_text_regex || 'map', controlSelectors: rules.interaction.control_selectors || [], max };
  const cands = await page.evaluate(clickCandidatesScript, R);
  const clicked = [];
  for (const c of cands.slice(0, max)) {
    try {
      await page.locator(`[data-smcinv-click="${c.n}"]`).first().click({ timeout: 1500, noWaitAfter: true, trial: false });
      clicked.push({ ...c, ok: true });
      await sleep(400);
    } catch (e) { clicked.push({ ...c, ok: false }); }
    if (page.isClosed()) break;
  }
  return clicked;
}

async function acceptConsent(page, rules) {
  const re = new RegExp(rules.cmp.accept_button_regex || 'accept', 'i');
  const btn = page.getByRole('button', { name: re }).first();
  if (await btn.count()) { await btn.click({ timeout: 2000, noWaitAfter: true }); await sleep(800); return true; }
  const a = page.locator('a, [role=button]').filter({ hasText: re }).first();
  if (await a.count()) { await a.click({ timeout: 2000, noWaitAfter: true }); await sleep(800); return true; }
  return false;
}

/** Turn DOM, network and frame observations into finding rows with stable identities. */
export function composeFindings(pageUrl, dom, requests, frames, rules, priorStrong = new Map()) {
  const findings = []; const seen = new Set();
  const push = (f) => { const k = `${f.identity_key}|${f.signal_type}|${f.placement}|${f.signal_value}`; if (seen.has(k)) return; seen.add(k); findings.push(f); };
  const iframeUrls = new Set();

  // Iframes (DOM visible)
  for (const fr of dom.iframes || []) {
    iframeUrls.add(fr.src);
    const rule = fr.matched || (rules.matchRequestUrl(fr.src) || {}).rule; if (!rule) continue;
    const id = resolveIdentity(fr.src, rules, rule); if (!id) continue;
    const f = finding({ pageUrl, id, rule, type: rule.type, signal_type: 'iframe', signal_value: fr.src, target: fr.src, placement: fr.placement, container: fr.container, width: fr.bbox.w, height: fr.bbox.h, title: fr.title, nonGeo: fr.nonGeo });
    f.bbox = fr.bbox; push(f);
  }
  // Frames not visible in the DOM (nested / cross-origin children)
  for (const fr of frames || []) {
    if (iframeUrls.has(fr.url)) continue;
    const rule = rules.matchEmbedUrl(fr.url) || (rules.matchRequestUrl(fr.url) || {}).rule; if (!rule) continue;
    const id = resolveIdentity(fr.url, rules, rule); if (!id) continue;
    const nested = fr.parent !== 'main';
    push(finding({ pageUrl, id, rule, type: rule.type, signal_type: 'frame', signal_value: fr.url, target: fr.url, placement: 'main_content', container: nested ? `frame(${fr.parent.slice(0, 120)})` : null, confidence: nested ? 'low' : rule.confidence }));
  }
  // Links
  for (const l of dom.links || []) {
    const id = resolveIdentity(l.href, rules, l.matched); if (!id) continue;
    push(finding({ pageUrl, id, rule: l.matched, type: 'map_link_only', signal_type: 'link', signal_value: l.href, target: l.href, placement: l.placement, container: l.container, title: l.text }));
  }
  // Static images
  for (const im of dom.images || []) {
    const id = resolveIdentity(im.src, rules); if (!id) continue;
    const f = finding({ pageUrl, id, rule: im.matched, type: 'static_map_image', signal_type: 'image', signal_value: im.src, target: im.src, placement: im.placement, container: im.container, width: im.bbox.w, height: im.bbox.h, title: im.alt });
    f.bbox = im.bbox; push(f);
  }
  // In-page maps: ONE identity per container. Several selector rules, globals and network rules usually
  // describe the same map, so group by container selector and pick the best-known vendor for it.
  const CONF = { high: 3, medium: 2, low: 1 };
  const containers = new Map(); // container -> { vendor, conf, placement, bbox, nonGeo, type, sels: [] }
  for (const s of dom.selectors || []) {
    const c = containers.get(s.container) || { vendor: 'unknown', conf: 0, placement: s.placement, bbox: s.bbox, nonGeo: false, type: s.type, sels: [] };
    c.sels.push(s); c.nonGeo = c.nonGeo || !!s.nonGeo;
    const score = (CONF[s.confidence] || 1) + (s.vendor === 'unknown' ? -10 : 0);
    if (score > c.conf) { c.conf = score; c.vendor = s.vendor; c.type = s.type; }
    containers.set(s.container, c);
  }
  const globalsByVendor = new Map((dom.globals || []).map(g => [g.vendor, g]));
  // A container with only unknown-vendor selectors adopts the vendor of a present global (if unambiguous).
  const knownGlobals = [...globalsByVendor.keys()].filter(v => !['d3', 'plotly'].includes(v));
  for (const c of containers.values()) if (c.vendor === 'unknown' && knownGlobals.length === 1) { c.vendor = knownGlobals[0]; c.type = globalsByVendor.get(knownGlobals[0]).type; }
  // Strong identities visible on this page (from tier 1 or from this render's main-frame requests), by vendor.
  const strong = new Map(priorStrong);
  for (const r of requests || []) { if (!r.main) continue; const id = resolveIdentity(r.request_url, rules); if (id && (id.arcgisItemId || id.key.startsWith('mapbox:style:') || id.key.startsWith('gmymaps:'))) { if (!strong.has(r.vendor)) strong.set(r.vendor, new Set()); strong.get(r.vendor).add(id.key); } }
  const containerKey = (sel, c) => {
    const ks = strong.get(c.vendor);
    if (ks && ks.size === 1 && containers.size === 1) return [...ks][0]; // one map, one style/item on the page → same application
    return inpageIdentity(c.vendor, pageUrl, sel);
  };
  // An unknown-vendor container adopts the vendor of a strong identity when there is exactly one such vendor.
  if ([...containers.values()].some(c => c.vendor === 'unknown') && strong.size === 1) for (const c of containers.values()) if (c.vendor === 'unknown') c.vendor = [...strong.keys()][0];
  for (const [sel, c] of containers) {
    for (const s of c.sels) {
      const rule = { id: s.id, vendor: c.vendor, type: c.type, confidence: s.confidence };
      const f = finding({ pageUrl, id: { key: containerKey(sel, c) }, rule, type: c.type, signal_type: 'selector', signal_value: s.selector, placement: c.placement, container: sel, width: s.bbox.w, height: s.bbox.h, nonGeo: c.nonGeo, confidence: s.visible ? s.confidence : 'low' });
      f.bbox = s.bbox; push(f);
    }
  }
  const containerForVendor = (vendor) => { for (const [sel, c] of containers) if (c.vendor === vendor) return [sel, c]; const first = [...containers.entries()][0]; return first || null; };
  // Globals → attach to the vendor's container if we saw one, else '*'
  for (const g of dom.globals || []) {
    const hit = containerForVendor(g.vendor); const c = hit && hit[1].vendor === g.vendor ? hit : null;
    const rule = { id: g.id, vendor: g.vendor, type: g.type, confidence: g.confidence };
    const f = finding({ pageUrl, id: { key: c ? containerKey(c[0], c[1]) : inpageIdentity(g.vendor, pageUrl, '*') }, rule, type: c ? c[1].type : g.type, signal_type: 'global', signal_value: g.name, placement: c ? c[1].placement : 'main_content', container: c ? c[0] : '*', nonGeo: c ? c[1].nonGeo : false, confidence: c ? g.confidence : (g.confidence === 'high' ? 'medium' : 'low') });
    if (c) f.bbox = c[1].bbox; push(f);
  }
  // Network → main-frame requests only create page-level findings; sub-frame requests are attributed to the frame.
  const byRule = new Map();
  for (const r of requests || []) {
    if (!r.main || !r.matched_rule) continue; // unmatched requests are stored for offline search only, never findings
    const k = r.matched_rule; if (!byRule.has(k)) byRule.set(k, { ...r, count: 0 }); byRule.get(k).count++;
  }
  for (const r of byRule.values()) {
    const rule = { id: r.matched_rule, vendor: r.vendor, type: r.type, confidence: r.confidence };
    const ident = resolveIdentity(r.request_url, rules);
    let key, placement = 'main_content', container = '*', extra = {}, type = r.type, nonGeo = false;
    if (ident && (ident.arcgisItemId || ident.key.startsWith('arcgis:service:') || ident.key.startsWith('mapbox:style:') || ident.key.startsWith('gmymaps:'))) { key = ident.key; extra = ident; }
    else if (r.kind === 'static_map_api') { key = ident ? ident.key : inpageIdentity(r.vendor, pageUrl, '*'); extra = ident || {}; type = 'static_map_image'; }
    else {
      // tiles / vendor assets loaded by the page: attribute to the matching (or only) in-page container
      const hit = containerForVendor(r.vendor);
      if (hit) { container = hit[0]; placement = hit[1].placement; key = containerKey(hit[0], hit[1]); rule.vendor = hit[1].vendor; type = hit[1].type; nonGeo = hit[1].nonGeo; }
      else key = inpageIdentity(r.vendor, pageUrl, '*');
    }
    if (ident?.apiKey) extra.apiKey = ident.apiKey;
    push(finding({ pageUrl, id: { ...extra, key }, rule, type, signal_type: 'network', signal_value: `${r.request_url}${r.count > 1 ? ` (+${r.count - 1} more)` : ''}`, target: r.request_url, placement, container, nonGeo }));
  }
  return findings;
}
