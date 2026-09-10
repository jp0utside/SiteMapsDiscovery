// Placement classification shared by tier 1 (cheerio) and tier 2 (browser; see page-script.js).
// Nearest matching ancestor wins, except that a weak chrome match (nav / role=navigation)
// sitting INSIDE a main-content ancestor is treated as in-page navigation → main_content.
const STRONG_CHROME = /^(header|footer|\[role=banner\]|\[role=contentinfo\]|\.region-|\.site-|\.mega|\.megamenu|#header|#footer|#mega|\.block-|\.layout-container|\.dialog-off-canvas)/i;

export function classifyPlacementCheerio($, el, rules) {
  const chrome = rules.placement.chrome_selectors || [];
  const main = rules.placement.main_content_selectors || [];
  let node = el, depth = 0, chromeAt = -1, chromeStrong = false, mainAt = -1;
  while (node && node.type === 'tag' && depth < 200) {
    const $n = $(node);
    if (mainAt < 0) for (const s of main) { if ($n.is(s)) { mainAt = depth; break; } }
    if (chromeAt < 0) for (const s of chrome) { if ($n.is(s)) { chromeAt = depth; chromeStrong = STRONG_CHROME.test(s); break; } }
    node = node.parent; depth++;
  }
  return decide(chromeAt, chromeStrong, mainAt);
}
export function decide(chromeAt, chromeStrong, mainAt) {
  if (chromeAt < 0) return 'main_content';
  if (mainAt < 0) return 'site_chrome';
  if (chromeAt < mainAt && !chromeStrong) return 'main_content'; // nav inside main → in-page nav
  return chromeAt < mainAt ? 'site_chrome' : 'main_content';
}

/** Short CSS-ish path for an element (cheerio). */
export function cssPathCheerio($, el) {
  const parts = [];
  let node = el, n = 0;
  while (node && node.type === 'tag' && n < 4) {
    const $n = $(node);
    let seg = node.name;
    const id = $n.attr('id');
    if (id) { parts.unshift(`${seg}#${id}`); break; }
    const cls = ($n.attr('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) seg += '.' + cls.join('.');
    const sibs = node.parent ? $(node.parent).children(node.name) : [];
    if (sibs.length > 1) seg += `:nth-of-type(${Array.prototype.indexOf.call(sibs, node) + 1})`;
    parts.unshift(seg); node = node.parent; n++;
  }
  return parts.join(' > ');
}
