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
