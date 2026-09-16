import * as cheerio from 'cheerio';
import { resolveIdentity, inpageIdentity } from './identity.js';
import { classifyPlacementCheerio, cssPathCheerio } from './placement.js';

const FLAGGED_TYPES = new Set(['map_link_only', 'non_geographic']);
const URL_ATTRS = ['src', 'href', 'data-src', 'data-lazy-src', 'data-url', 'data-href', 'data-iframe-src', 'data-embed', 'data', 'srcdoc'];

/**
 * Tier 1 — static HTML detection. Returns { title, findings: [...], links: [...] }.
 * Findings here are CONFIRMED hits; a miss is unknown, never "clean".
 */
export function detectStatic(html, pageUrl, rules) {
  const $ = cheerio.load(html);
  const title = ($('title').first().text() || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  const findings = []; const seen = new Set();
  const push = (f) => { const k = `${f.identity_key}|${f.signal_type}|${f.placement}|${f.signal_value}`; if (seen.has(k)) return; seen.add(k); findings.push(f); };
  const abs = (v) => { try { return new URL(v, pageUrl).toString(); } catch { return null; } };

  // Iframes / objects / embeds — server-rendered map embeds (this site's most common case).
  $('iframe, object, embed').each((_, el) => {
    for (const a of URL_ATTRS) {
      const v = $(el).attr(a); if (!v) continue;
      const target = abs(v); if (!target) continue;
      const rule = rules.matchEmbedUrl(target) || (rules.matchRequestUrl(target) || {}).rule;
      if (!rule) continue;
      const id = resolveIdentity(target, rules, rule); if (!id) continue;
      const title = $(el).attr('title') || null;
      push(finding({ pageUrl, id, rule, type: rule.type, signal_type: 'iframe', signal_value: target, target, placement: classifyPlacementCheerio($, el, rules), container: cssPathCheerio($, el), width: dim($(el).attr('width')), height: dim($(el).attr('height')), title, nonGeo: nonGeoHint($, el, rules) }));
      break;
    }
  });
  // Anchors → map_link_only (recorded, flagged so the report can filter them).
  $('a[href]').each((_, el) => {
    const target = abs($(el).attr('href')); if (!target) return;
    if (/^(mailto|tel|javascript):/i.test($(el).attr('href'))) return;
    const rule = rules.matchEmbedUrl(target); if (!rule) return;
    const text = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 120) || $(el).attr('aria-label') || $(el).attr('title') || null;
    if (isAttributionLink($, el, text, rules)) return;
    const id = resolveIdentity(target, rules, rule); if (!id) return;
    push(finding({ pageUrl, id, rule, type: 'map_link_only', signal_type: 'link', signal_value: target, target, placement: classifyPlacementCheerio($, el, rules), container: cssPathCheerio($, el), title: text }));
  });
  // Static map images.
  $('img[src], img[data-src], source[srcset], img[srcset]').each((_, el) => {
    const cands = [$(el).attr('src'), $(el).attr('data-src'), ...(($(el).attr('srcset') || '').split(',').map(s => s.trim().split(/\s+/)[0]))].filter(Boolean);
    for (const c of cands) {
      const target = abs(c); if (!target) continue;
      const rule = rules.matchStaticMapUrl(target); if (!rule) continue;
      const id = resolveIdentity(target, rules); if (!id) continue;
      push(finding({ pageUrl, id, rule, type: 'static_map_image', signal_type: 'image', signal_value: target, target, placement: classifyPlacementCheerio($, el, rules), container: cssPathCheerio($, el), width: dim($(el).attr('width')), height: dim($(el).attr('height')), title: $(el).attr('alt') || null }));
      break;
    }
  });
  // Vendor script / stylesheet loads → in-page map library present (container unknown at tier 1).
  $('script[src], link[href]').each((_, el) => {
    const target = abs($(el).attr('src') || $(el).attr('href')); if (!target) return;
    const m = rules.matchRequestUrl(target); if (!m) return;
    const id = resolveIdentity(target, rules) || {};
    const key = (m.rule.type === 'static_map_image') ? id.key : inpageIdentity(m.rule.vendor, pageUrl, '*');
    push(finding({ pageUrl, id: { ...id, key }, rule: m.rule, type: m.rule.type, signal_type: 'static_html', signal_value: target, target, placement: 'main_content', container: '*', confidence: m.rule.confidence === 'high' ? 'medium' : 'low' }));
  });
  // Lazy / data-attribute embeds anywhere in the DOM.
  $('[data-src],[data-url],[data-href],[data-iframe-src],[data-embed]').not('iframe,img,a,object,embed,source').each((_, el) => {
    for (const a of URL_ATTRS) {
      const v = $(el).attr(a); if (!v) continue; const target = abs(v); if (!target) continue;
      const rule = rules.matchEmbedUrl(target); if (!rule) continue; const id = resolveIdentity(target, rules, rule); if (!id) continue;
      push(finding({ pageUrl, id, rule, type: rule.type, signal_type: 'static_html', signal_value: `${a}=${target}`, target, placement: classifyPlacementCheerio($, el, rules), container: cssPathCheerio($, el), confidence: 'medium' }));
    }
  });
  // Raw source hints (inline scripts, class names, mapbox:// style URLs, JSON blobs).
  for (const { rule, match } of rules.matchStaticHtml(html)) {
    const idm = match.match(/mapbox:\/\/styles\/[^"'\s]+/);
    const id = idm ? resolveIdentity(idm[0], rules) : null;
    const key = id?.key || inpageIdentity(rule.vendor, pageUrl, '*');
    push(finding({ pageUrl, id: { ...(id || {}), key }, rule, type: rule.type, signal_type: 'static_html', signal_value: match, target: idm ? idm[0] : null, placement: 'main_content', container: '*' }));
  }
  // Embed URLs appearing anywhere in the source that no element-level pass caught (inline JSON etc.).
  const urlRe = /https?:\/\/[^\s"'<>()\\]+/g; let m;
  const already = new Set(findings.map(f => f.target_url));
  while ((m = urlRe.exec(html))) {
    const target = m[0].replace(/[.,;:]+$/, '').replace(/&amp;/g, '&');
    if (already.has(target)) continue;
    const rule = rules.matchEmbedUrl(target); if (!rule) continue;
    const id = resolveIdentity(target, rules, rule); if (!id) continue;
    already.add(target);
    push(finding({ pageUrl, id, rule, type: rule.type, signal_type: 'static_html', signal_value: target, target, placement: 'main_content', container: '*', confidence: 'low' }));
  }

  // Outbound links for the BFS crawl (raw; the caller normalizes and scopes them).
  const links = [];
  $('a[href], area[href]').each((_, el) => { const h = $(el).attr('href'); if (h && !/^(mailto|tel|javascript|data):/i.test(h)) links.push(h); });
  return { title, findings, links };
}

function isAttributionLink($, el, text, rules) {
  if (rules.ignoreLinkTextRegex && text && rules.ignoreLinkTextRegex.test(text)) return true;
  for (const sel of rules.ignoreLinkSelectors || []) { try { if ($(el).closest(sel).length) return true; } catch {} }
  return false;
}
function dim(v) { if (v == null) return null; const n = parseInt(String(v), 10); return isNaN(n) ? null : n; }
function nonGeoHint($, el, rules) {
  const ctx = [$(el).attr('title'), $(el).attr('aria-label'), $(el).parent().text().slice(0, 300), $(el).closest('section,article,div').find('h1,h2,h3,figcaption').first().text()].filter(Boolean).join(' ');
  return rules.nonGeoRegex.test(ctx);
}
export function finding({ pageUrl, id, rule, type, signal_type, signal_value, target, placement, container, width, height, title, confidence, nonGeo }) {
  if (nonGeo && type !== 'map_link_only') type = 'non_geographic';
  return {
    url: pageUrl, identity_key: id.key, vendor: rule.vendor, type, confidence: confidence || rule.confidence || 'medium',
    placement: placement || 'main_content', signal_type, signal_value: String(signal_value).slice(0, 2000), target_url: target || null,
    container_selector: container || null, width_px: width ?? null, height_px: height ?? null,
    api_key: id.apiKey || null, arcgis_org: id.arcgisOrg || null, arcgis_item_id: id.arcgisItemId || null,
    flagged: FLAGGED_TYPES.has(type) ? 1 : 0, rule: rule.id, title: title || null,
  };
}
