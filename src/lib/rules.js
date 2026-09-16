import { globToRegex } from './url.js';

const rx = (s, flags = 'i') => new RegExp(s, flags);

/** Compile rules.yaml into matchers. Everything the scanner needs at runtime lives here. */
export function compileRules(raw, detection = {}) {
  const allow = new Set((detection.vendors || []).map(v => String(v).toLowerCase()));
  const keep = (r) => allow.size === 0 || allow.has(String(r.vendor || '').toLowerCase());
  raw = {
    ...raw,
    network: { ...(raw.network || {}), hosts: (raw.network?.hosts || []).filter(keep), paths: (raw.network?.paths || []).filter(keep), static_map_apis: (raw.network?.static_map_apis || []).filter(keep), tile_pattern: raw.network?.tile_pattern && keep(raw.network.tile_pattern) ? raw.network.tile_pattern : null },
    embeds: (raw.embeds || []).filter(keep), globals: (raw.globals || []).filter(keep), selectors: (raw.selectors || []).filter(keep), static_html: (raw.static_html || []).filter(keep),
  };
  const net = raw.network || {};
  const hosts = (net.hosts || []).map((r, i) => {
    const hasPath = r.pattern.includes('/');
    return { ...r, id: `host:${r.pattern}`, hasPath, re: globToRegex(r.pattern, { anchorEnd: !hasPath }) };
  });
  const paths = (net.paths || []).map(r => ({ ...r, id: `path:${r.regex}`, re: rx(r.regex) }));
  const staticApis = (net.static_map_apis || []).map(r => ({ ...r, id: `static:${r.regex}`, re: rx(r.regex) }));
  const tile = net.tile_pattern ? { ...net.tile_pattern, id: 'tile', re: rx(net.tile_pattern.regex) } : null;
  const embeds = (raw.embeds || []).map(r => ({ ...r, id: `embed:${r.label || r.regex}`, re: rx(r.regex) }));
  const globals = (raw.globals || []).map(r => ({ ...r, id: `global:${r.name}` }));
  const selectors = (raw.selectors || []).map(r => ({ ...r, id: `selector:${r.selector}` }));
  const staticHtml = (raw.static_html || []).map(r => ({ ...r, id: `html:${r.regex}`, re: rx(r.regex) }));
  const mapAdjacent = rx('(' + ((raw.map_adjacent || {}).patterns || ['map']).join('|') + ')');
  const interaction = raw.interaction || {};
  const placement = raw.placement || {};
  const nonGeo = rx((raw.non_geographic || {}).hint_regex || 'floor ?plan|seating');
  const identity = raw.identity || {};
  const cmp = raw.cmp || {};
  const ignoreLinkSelectors = placement.ignore_link_selectors || [];
  const ignoreLinkTextRegex = placement.ignore_link_text_regex ? rx(placement.ignore_link_text_regex) : null;

  function matchRequestUrl(url) {
    let host = '', hostPath = '';
    try { const u = new URL(url); host = u.hostname.toLowerCase(); hostPath = host + u.pathname; } catch { return null; }
    for (const r of staticApis) if (r.re.test(url)) return { rule: r, kind: 'static_map_api' };
    for (const r of hosts) if (r.hasPath ? r.re.test(hostPath) : r.re.test(host)) return { rule: r, kind: 'vendor_host' };
    for (const r of paths) if (r.re.test(url)) return { rule: r, kind: 'service_path' };
    if (tile && tile.re.test(url)) return { rule: tile, kind: 'tile' };
    return null;
  }
  function matchEmbedUrl(url) {
    if (!url) return null;
    for (const r of embeds) if (r.re.test(url)) return r;
    return null;
  }
  function matchStaticMapUrl(url) { for (const r of staticApis) if (r.re.test(url)) return r; return null; }
  function matchStaticHtml(html) { const hits = []; for (const r of staticHtml) { const m = html.match(r.re); if (m) hits.push({ rule: r, match: m[0].slice(0, 200) }); } return hits; }
  const isMapAdjacent = (s) => !!s && mapAdjacent.test(s);

  return {
    raw, hosts, paths, staticApis, tile, embeds, globals, selectors, staticHtml, interaction, placement, identity, cmp,
    nonGeoRegex: nonGeo, mapAdjacentRegex: mapAdjacent, ignoreLinkSelectors, ignoreLinkTextRegex,
    vendorAllowlist: [...allow],
    matchRequestUrl, matchEmbedUrl, matchStaticMapUrl, matchStaticHtml, isMapAdjacent,
    /** Plain-data subset shipped into the browser for page.evaluate(). */
    forBrowser() {
      return {
        globals: globals.map(g => ({ id: g.id, name: g.name, expr: g.expr, vendor: g.vendor, type: g.type, confidence: g.confidence })),
        selectors: selectors.map(s => ({ id: s.id, selector: s.selector, vendor: s.vendor, type: s.type, confidence: s.confidence })),
        embeds: embeds.map(e => ({ id: e.id, regex: e.regex, vendor: e.vendor, type: e.type, confidence: e.confidence, label: e.label, identity_key: e.identity_key || null })),
        ignoreLinkSelectors, ignoreLinkTextRegex: placement.ignore_link_text_regex || null,
        staticApis: staticApis.map(e => ({ id: e.id, regex: e.regex, vendor: e.vendor, type: e.type, confidence: e.confidence })),
        chromeSelectors: placement.chrome_selectors || [],
        mainSelectors: placement.main_content_selectors || [],
        nonGeoRegex: (raw.non_geographic || {}).hint_regex || 'floor ?plan|seating',
        clickTextRegex: interaction.click_text_regex || 'map',
        controlSelectors: interaction.control_selectors || [],
      };
    },
  };
}
