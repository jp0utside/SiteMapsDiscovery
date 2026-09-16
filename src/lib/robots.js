// Minimal robots.txt parser: Disallow/Allow for our UA (falls back to *), plus Sitemap: lines.
export function parseRobots(text, userAgentToken = 'smc-map-inventory') {
  const groups = []; let cur = null; const sitemaps = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/#.*$/, '').trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || cur.rulesStarted) { cur = { agents: [], rules: [], rulesStarted: false }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (!cur) { cur = { agents: ['*'], rules: [], rulesStarted: false }; groups.push(cur); }
      cur.rulesStarted = true; if (val) cur.rules.push({ allow: key === 'allow', path: val });
    } else if (key === 'sitemap') { if (val) sitemaps.push(val); }
    else if (key === 'crawl-delay') { if (cur) { cur.rulesStarted = true; cur.crawlDelay = Number(val); } }
  }
  const ua = userAgentToken.toLowerCase();
  const pick = groups.find(g => g.agents.some(a => a !== '*' && ua.includes(a))) || groups.find(g => g.agents.includes('*'));
  const rules = (pick ? pick.rules : []).map(r => ({ ...r, re: pathPatternToRegex(r.path) }));
  return {
    sitemaps, crawlDelay: pick?.crawlDelay,
    rules,
    isAllowed(pathAndQuery) {
      // longest-match wins, Allow beats Disallow on ties (Google semantics)
      let best = null;
      for (const r of rules) if (r.re.test(pathAndQuery)) if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      return !best || best.allow;
    },
  };
}
function pathPatternToRegex(p) {
  let end = false; if (p.endsWith('$')) { end = true; p = p.slice(0, -1); }
  const esc = p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  return new RegExp('^' + esc + (end ? '$' : ''));
}

/**
 * Apply robots.txt Crawl-delay to the rate limiters, or log that it is being overridden.
 * Interpretation: one page fetch / page navigation per Crawl-delay seconds; a rendered page's own
 * subresource loads are part of that page. Returns the effective per-host interval in ms.
 */
export function applyCrawlDelay(robots, host, limiters, cfg, log) {
  const delay = Number(robots?.crawlDelay);
  const configured = 1000 / Math.max(0.01, cfg.http.requests_per_second_per_host || 2);
  if (!delay || !(delay > 0)) { log.info(`rate: ${cfg.http.requests_per_second_per_host}/s per host (robots.txt declares no Crawl-delay)`); return configured; }
  if (cfg.http.respect_crawl_delay !== false) {
    for (const l of limiters) l.setHostMinInterval(host, delay * 1000);
    log.loud(`robots.txt Crawl-delay: ${delay}s is being HONOURED for ${host} → at most one page fetch or navigation every ${delay}s (~${(3600 / delay).toFixed(0)} pages/hour). Set http.respect_crawl_delay: false only with the site owner's approval.`);
    return Math.max(configured, delay * 1000);
  }
  log.loud(`robots.txt Crawl-delay: ${delay}s is being OVERRIDDEN for ${host} (http.respect_crawl_delay: false) → running at ${cfg.http.requests_per_second_per_host}/s per host. This must have the site owner's explicit approval.`);
  return configured;
}
