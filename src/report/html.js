const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : 'n/a';
const table = (rows, cols) => rows.length ? `<table><thead><tr>${cols.map(c => `<th>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c.f ? c.f(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">none</p>';
const link = (u, t) => u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t || u)}</a>` : '';

export function renderHtml({ cfg, apps, occ, coverage, arcgis, keys, totals, runs, generatedAt, toolVersion }) {
  const crawlHosts = (cfg.scope.crawl_allowlist || []).join(', ');
  const siteWide = apps.filter(a => a.placement_summary === 'site-wide navigation');
  const content = apps.filter(a => a.placement_summary !== 'site-wide navigation');
  const appCols = [
    { h: 'Application', f: a => `<code>${esc(a.identity_key)}</code>${a.title ? `<br><span class="muted">${esc(a.title)}</span>` : ''}` },
    { h: 'Vendor', k: 'vendor' }, { h: 'Type', f: a => `${esc(a.type)}${a.flagged ? ' <span class="flag">flagged</span>' : ''}` },
    { h: 'Pages', f: a => `${a.occurrence_count} <span class="muted">(${a.main_content_pages} content / ${a.site_chrome_pages} nav)</span>` },
    { h: 'County org', k: 'in_county_org_label' },
    { h: 'Example page', f: a => link(a.example_url, shorten(a.example_url)) },
    { h: 'Target', f: a => link(a.target_url, shorten(a.target_url, 70)) },
    { h: 'Screenshot', f: a => a.screenshot_rel ? `<a href="${esc(a.screenshot_rel)}" target="_blank"><img src="${esc(a.screenshot_rel)}" class="thumb" loading="lazy"></a>` : '' },
  ];
  const itemCols = [{ h: 'Item id', f: i => `<code>${esc(i.item_id)}</code>` }, { h: 'Title', k: 'title' }, { h: 'Type', k: 'type' }, { h: 'Owner', k: 'owner' }, { h: 'Created', f: i => esc((i.created || '').slice(0, 10)) }, { h: 'Modified', f: i => esc((i.modified || '').slice(0, 10)) }];
  const runsRows = runs.map(r => ({ ...r, dur: r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 60000) + ' min' : '(unfinished)' }));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(cfg.report.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;color:#1b1b1b;background:#fafafa;max-width:1400px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px;border-bottom:2px solid #ddd;padding-bottom:4px}h3{font-size:15px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:8px 0;background:#fff;font-size:13px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f0f0f0}
code{font-size:12px;background:#f3f3f3;padding:1px 4px;border-radius:3px;word-break:break-all}.muted{color:#666}.flag{background:#fde68a;color:#7c2d12;padding:1px 6px;border-radius:10px;font-size:11px}
.cards{display:flex;flex-wrap:wrap;gap:12px}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;min-width:140px}.card b{display:block;font-size:24px}
.warn{background:#fff7ed;border:1px solid #fdba74;padding:10px 14px;border-radius:6px}.crit{background:#fef2f2;border:1px solid #fca5a5;padding:10px 14px;border-radius:6px}
.ok{background:#f0fdf4;border:1px solid #86efac;padding:10px 14px;border-radius:6px}.thumb{max-width:160px;max-height:110px;border:1px solid #ccc}
.gallery{display:flex;flex-wrap:wrap;gap:12px}.gallery figure{margin:0;width:260px;background:#fff;border:1px solid #ddd;padding:8px;border-radius:6px}.gallery img{width:100%;height:170px;object-fit:cover}.gallery figcaption{font-size:12px;word-break:break-all}
</style></head><body>
<h1>${esc(cfg.report.title)}</h1>
<p class="muted">Generated ${esc(generatedAt)} · tool v${esc(toolVersion)} · database <code>${esc(cfg.database)}</code></p>

<div class="warn"><b>Scope boundary.</b> Only <b>${esc(crawlHosts)}</b> was crawled. Other county hosts (<code>gis.smcgov.org</code>, <code>data.smcgov.org</code>, <code>youth.smcgov.org</code>, <code>jobs.smcgov.org</code>, <code>hr.smcgov.org</code>, and every other <code>*.smcgov.org</code> subdomain) were <b>not crawled</b>, so this inventory covers one site rather than the county's entire web presence. Maps hosted on those or any other host are recorded whenever a crawled page embeds or links to them, but their own pages were never visited. Client-side observation only: no CMS, database or hosting access was used.</div>

<h2>Summary</h2>
<div class="cards">
<div class="card"><b>${totals.applications}</b>distinct applications<br><span class="muted">${totals.applications_unflagged} excluding link-only / non-geographic</span></div>
<div class="card"><b>${totals.occurrences}</b>page × application occurrences</div>
<div class="card"><b>${totals.pages_with_maps}</b>pages with an embedded map in content</div>
<div class="card"><b>${totals.site_wide}</b>site-wide navigation apps</div>
<div class="card"><b>${arcgis.external.length}</b>ArcGIS apps outside the county org</div>
<div class="card"><b>${coverage.discovered}</b>URLs discovered</div>
</div>
<h3>By vendor</h3>${table(totals.by_vendor, [{ h: 'Vendor', k: 'vendor' }, { h: 'Applications', k: 'c' }])}
<h3>By type</h3>${table(totals.by_type, [{ h: 'Type', k: 'type' }, { h: 'Applications', k: 'c' }])}
<p class="muted">Types <code>map_link_only</code> and <code>non_geographic</code> are recorded and flagged; filter <code>applications.csv</code> on the <code>flagged</code> column.</p>

<h2>ArcGIS Online cross-reference ${arcgis.org ? `(org: ${esc(arcgis.org.name)} · <code>${esc(arcgis.org.host)}</code> · ${arcgis.org_item_count} public items)` : '<span class="muted">(run <code>arcgis</code> to populate)</span>'}</h2>
<h3>External — embedded on county pages but NOT in the county org (${arcgis.external.length})</h3>
<div class="${arcgis.external.length ? 'crit' : 'ok'}">${arcgis.external.length ? 'These applications are served from ArcGIS accounts outside the county organization (vendor-hosted, personal accounts, shadow IT). Ownership, billing and continuity are not under county control.' : 'No ArcGIS application embedded on a crawled page was found outside the county org.'}</div>
${table(arcgis.external, appCols)}
${arcgis.unknown.length ? `<h3>Unknown ownership — item not publicly readable (${arcgis.unknown.length})</h3><p class="muted">The item endpoint returned an error (private, deleted, or the <code>arcgis</code> command has not run). Verify manually.</p>${table(arcgis.unknown, appCols)}` : ''}
<h3>Embedded — county org items found on crawled pages (${arcgis.embedded.length})</h3>${table(arcgis.embedded, appCols)}
<h3>Orphaned — county org items on no crawled page (${arcgis.orphaned.length})</h3><p class="muted">Publicly shared in the org but never referenced from ${esc(crawlHosts)}. They may be used on other county hosts (not crawled) or be genuinely unused.</p>${table(arcgis.orphaned, itemCols)}
${arcgis.non_arcgis_external.length ? `<h3>Other externally hosted maps (${arcgis.non_arcgis_external.length})</h3><p class="muted">Non-ArcGIS applications hosted outside <code>*.smcgov.org</code> (Google, Mapbox, third-party viewers, …).</p>${table(arcgis.non_arcgis_external, appCols)}` : ''}

<h2>Applications (${content.length} in page content)</h2>
${table(content, appCols)}
<h2>Site-wide navigation applications (${siteWide.length})</h2>
<p class="muted">Found only inside header / navigation / footer chrome. Each is one application row with an occurrence count; the page list is intentionally not enumerated (it would be every crawled page).</p>
${table(siteWide, [{ h: 'Application', f: a => `<code>${esc(a.identity_key)}</code>${a.title ? `<br><span class="muted">${esc(a.title)}</span>` : ''}` }, { h: 'Vendor', k: 'vendor' }, { h: 'Type', k: 'type' }, { h: 'Placement', f: () => 'site-wide navigation' }, { h: 'Pages', k: 'occurrence_count' }, { h: 'County org', k: 'in_county_org_label' }, { h: 'Target', f: a => link(a.target_url, shorten(a.target_url, 80)) }])}

<h2>API keys and access tokens (${keys.length})</h2>
<p class="muted">Publishable client-side identifiers extracted from map URLs — not secrets. Listed to attribute ownership/billing and to flag keys usable from any site. Restriction status comes from a single unauthenticated GET without a Referer header.</p>
${table(keys, [{ h: 'Vendor', k: 'vendor' }, { h: 'Key', f: k => `<code>${esc(k.api_key)}</code>` }, { h: 'Restriction', f: k => /UNRESTRICTED/.test(k.restriction) ? `<b style="color:#b91c1c">${esc(k.restriction)}</b>` : esc(k.restriction) }, { h: 'Pages', k: 'pages' }, { h: 'Applications', f: k => `<code>${esc(k.identities)}</code>` }, { h: 'Example', f: k => link(k.example, shorten(k.example, 70)) }])}

<h2>Coverage</h2>
<div class="${coverage.pending || coverage.cap_reached ? 'warn' : 'ok'}">
${coverage.cap_reached ? `<b>URL cap (${esc(coverage.cap_reached)}) was reached during discovery — the inventory is truncated.</b><br>` : ''}
${coverage.pending ? `<b>${coverage.pending} URLs are still pending / in progress — the scan did not finish.</b> Re-run <code>scan</code> to continue.<br>` : 'Discovery and scan completed for every queued URL.'}
</div>
<div class="cards">
<div class="card"><b>${coverage.discovered}</b>pages discovered</div>
<div class="card"><b>${coverage.crawled_tier1}</b>crawled (tier 1 static)</div>
<div class="card"><b>${coverage.rendered_tier2}</b>rendered (tier 2 headless)</div>
<div class="card"><b>${coverage.failed}</b>failed</div>
<div class="card"><b>${coverage.skipped}</b>skipped</div>
<div class="card"><b>${coverage.pending}</b>pending</div>
</div>
<h3>Discovery by source</h3>${table(coverage.by_source, [{ h: 'Source', k: 'source' }, { h: 'URLs', k: 'c' }])}
<h3>Queue by status</h3>${table(coverage.by_status, [{ h: 'Status', k: 'status' }, { h: 'URLs', k: 'c' }])}
<h3>Skipped by reason</h3>${table(coverage.skipped_by_reason, [{ h: 'Reason', k: 'reason' }, { h: 'URLs', k: 'c' }])}
<h3>Tier 2 scheduling</h3>${table(coverage.tier2_by_reason, [{ h: 'Reason', k: 'reason' }, { h: 'Scheduled', k: 'scheduled' }, { h: 'Rendered', k: 'rendered' }])}
<h3>Tier-2 random sample of tier-1 misses</h3>
<p>Sample rate ${(coverage.sample.rate * 100).toFixed(0)}% · rendered <b>${coverage.sample.rendered}</b> sampled pages · <b>${coverage.sample.hits}</b> had an embedded map in content that static rules missed → <b>sample hit rate ${pct(coverage.sample.hits, coverage.sample.rendered)}</b> (${coverage.sample.new_identity_pages} pages surfaced an application identity tier 1 had not seen). A non-zero rate means the static ruleset is blind to a category; extrapolate over the ${coverage.crawled_tier1 - coverage.tier1_hit_pages} un-rendered tier-1 misses.</p>
<p>Map-adjacent path/title pattern pages: rendered ${coverage.pattern.rendered}, with content maps ${coverage.pattern.hits} (${pct(coverage.pattern.hits, coverage.pattern.rendered)}).</p>
<h3>Failed URLs (${coverage.failed}${coverage.failed_urls.length < coverage.failed ? `, first ${coverage.failed_urls.length}` : ''})</h3>
${table(coverage.failed_urls, [{ h: 'URL', f: r => link(r.url, shorten(r.url, 90)) }, { h: 'Attempts', k: 'attempts' }, { h: 'Error', k: 'error' }])}
<h3>Runs</h3>${table(runsRows, [{ h: '#', k: 'id' }, { h: 'Command', k: 'command' }, { h: 'Started', k: 'started_at' }, { h: 'Duration', k: 'dur' }, { h: 'Summary', f: r => `<code>${esc(r.summary_json || '')}</code>` }])}

<h2>Screenshot gallery</h2>
<div class="gallery">${apps.filter(a => a.screenshot_rel).map(a => `<figure><a href="${esc(a.screenshot_rel)}" target="_blank"><img src="${esc(a.screenshot_rel)}" loading="lazy"></a><figcaption><code>${esc(a.identity_key)}</code><br>${esc(a.vendor)} · ${esc(a.type)} · ${a.occurrence_count} page(s)</figcaption></figure>`).join('') || '<p class="muted">no screenshots captured</p>'}</div>
</body></html>`;
}
function shorten(u, n = 60) { if (!u) return ''; const s = String(u).replace(/^https?:\/\//, ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
