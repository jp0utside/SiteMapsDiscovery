// Runs INSIDE the page via page.evaluate(). Must be self-contained (no imports, no closures over Node scope).
// Returns DOM-level findings: globals, selector matches, iframes, links, images — all with placement.
export function pageScript(R) {
  const STRONG = /^(header|footer|\[role=banner\]|\[role=contentinfo\]|\.region-|\.site-|\.mega|\.megamenu|#header|#footer|#mega|\.block-|\.layout-container|\.dialog-off-canvas)/i;
  const embeds = R.embeds.map(e => ({ ...e, re: new RegExp(e.regex, 'i') }));
  const staticApis = R.staticApis.map(e => ({ ...e, re: new RegExp(e.regex, 'i') }));
  const nonGeo = new RegExp(R.nonGeoRegex, 'i');
  const ignoreText = R.ignoreLinkTextRegex ? new RegExp(R.ignoreLinkTextRegex, 'i') : null;
  function isAttribution(el, text) {
    if (ignoreText && text && ignoreText.test(text)) return true;
    let n = el; while (n && n.nodeType === 1) { for (const s of R.ignoreLinkSelectors || []) if (safeMatches(n, s)) return true; n = parentOf(n); }
    return false;
  }
  const out = { title: document.title || '', globals: [], selectors: [], iframes: [], links: [], images: [], shadowRoots: 0 };

  function parentOf(n) { if (!n) return null; if (n.parentElement) return n.parentElement; const p = n.parentNode; if (p && p.nodeType === 11 && p.host) return p.host; return null; }
  function safeMatches(el, sel) { try { return el.matches(sel); } catch { return false; } }
  function placement(el) {
    let node = el, depth = 0, chromeAt = -1, chromeStrong = false, mainAt = -1;
    while (node && node.nodeType === 1 && depth < 200) {
      if (mainAt < 0) for (const s of R.mainSelectors) if (safeMatches(node, s)) { mainAt = depth; break; }
      if (chromeAt < 0) for (const s of R.chromeSelectors) if (safeMatches(node, s)) { chromeAt = depth; chromeStrong = STRONG.test(s); break; }
      node = parentOf(node); depth++;
    }
    if (chromeAt < 0) return 'main_content';
    if (mainAt < 0) return 'site_chrome';
    if (chromeAt < mainAt && !chromeStrong) return 'main_content';
    return chromeAt < mainAt ? 'site_chrome' : 'main_content';
  }
  function cssPath(el) {
    const parts = []; let node = el, n = 0;
    while (node && node.nodeType === 1 && n < 4) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${seg}#${CSS.escape(node.id)}`); break; }
      const cls = Array.from(node.classList || []).slice(0, 2).map(c => CSS.escape(c));
      if (cls.length) seg += '.' + cls.join('.');
      const parent = node.parentElement;
      if (parent) { const sibs = Array.from(parent.children).filter(c => c.tagName === node.tagName); if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(node) + 1})`; }
      parts.unshift(seg); node = parentOf(node); n++;
    }
    return parts.join(' > ');
  }
  function bbox(el) { try { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }; } catch { return { x: 0, y: 0, w: 0, h: 0 }; } }
  function ctxText(el) {
    const bits = [el.getAttribute && el.getAttribute('title'), el.getAttribute && el.getAttribute('aria-label')];
    let p = parentOf(el); let hops = 0;
    while (p && hops < 3) { const h = p.querySelector && p.querySelector('h1,h2,h3,h4,figcaption,caption'); if (h) { bits.push(h.textContent); break; } p = parentOf(p); hops++; }
    return bits.filter(Boolean).join(' ').slice(0, 400);
  }
  // Deep DOM walk piercing open shadow roots.
  function walk(root, fn) {
    if (root.nodeType === 1) { fn(root); if (root.shadowRoot) { out.shadowRoots++; walk(root.shadowRoot, fn); } }
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = it.nextNode())) { fn(node); if (node.shadowRoot) { out.shadowRoots++; walk(node.shadowRoot, fn); } }
  }
  const all = []; walk(document.documentElement, el => all.push(el));

  // Globals
  for (const g of R.globals) { let ok = false; try { ok = !!(0, eval)(g.expr); } catch { ok = false; } if (ok) out.globals.push({ id: g.id, name: g.name, vendor: g.vendor, type: g.type, confidence: g.confidence }); }
  // Selectors
  const selSeen = new Set();
  for (const s of R.selectors) for (const el of all) {
    if (!safeMatches(el, s.selector)) continue;
    // report the outermost matching container: skip if an ancestor already matched this rule
    let a = parentOf(el), nested = false; while (a) { if (safeMatches(a, s.selector)) { nested = true; break; } a = parentOf(a); } if (nested) continue;
    const path = cssPath(el); const k = s.id + '|' + path; if (selSeen.has(k)) continue; selSeen.add(k);
    const b = bbox(el);
    out.selectors.push({ id: s.id, selector: s.selector, vendor: s.vendor, type: s.type, confidence: s.confidence, container: path, bbox: b, placement: placement(el), nonGeo: nonGeo.test(ctxText(el)), visible: b.w > 0 && b.h > 0 });
  }
  // Iframes (DOM-visible; cross-origin content is enumerated separately via page.frames())
  for (const el of all) {
    const tag = el.tagName.toLowerCase(); if (tag !== 'iframe' && tag !== 'object' && tag !== 'embed') continue;
    const src = el.getAttribute('src') || el.getAttribute('data-src') || el.getAttribute('data') || (el.src) || '';
    if (!src || src === 'about:blank') continue;
    let abs; try { abs = new URL(src, location.href).toString(); } catch { continue; }
    const rule = embeds.find(e => e.re.test(abs));
    const b = bbox(el);
    out.iframes.push({ src: abs, matched: rule ? { id: rule.id, vendor: rule.vendor, type: rule.type, confidence: rule.confidence, label: rule.label } : null, container: cssPath(el), bbox: b, placement: placement(el), title: el.getAttribute('title') || null, nonGeo: nonGeo.test(ctxText(el)) });
  }
  // Links
  const linkSeen = new Set();
  for (const el of all) {
    if (el.tagName.toLowerCase() !== 'a' || !el.getAttribute('href')) continue;
    let abs; try { abs = new URL(el.getAttribute('href'), location.href).toString(); } catch { continue; }
    if (/^(mailto|tel|javascript):/i.test(abs)) continue;
    const rule = embeds.find(e => e.re.test(abs)); if (!rule) continue;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || el.getAttribute('aria-label') || el.getAttribute('title') || null;
    if (isAttribution(el, text)) continue;
    const pl = placement(el); const k = abs + '|' + pl; if (linkSeen.has(k)) continue; linkSeen.add(k);
    out.links.push({ href: abs, matched: { id: rule.id, vendor: rule.vendor, type: rule.type, confidence: rule.confidence, label: rule.label, identity_key: rule.identity_key || null }, text, container: cssPath(el), placement: pl });
  }
  // Static map images
  for (const el of all) {
    if (el.tagName.toLowerCase() !== 'img') continue;
    const src = el.currentSrc || el.src || el.getAttribute('data-src') || ''; if (!src) continue;
    const rule = staticApis.find(e => e.re.test(src)); if (!rule) continue;
    const b = bbox(el);
    out.images.push({ src, matched: { id: rule.id, vendor: rule.vendor, type: rule.type, confidence: rule.confidence }, container: cssPath(el), bbox: b, placement: placement(el), alt: el.getAttribute('alt') || null });
  }
  return out;
}

/** Runs in page: tag click candidates with data-smcinv-click=N and return their count + descriptions. */
export function clickCandidatesScript(R) {
  const textRe = new RegExp(R.clickTextRegex, 'i');
  const cands = []; const seen = new Set();
  function parentOf(n) { if (!n) return null; if (n.parentElement) return n.parentElement; const p = n.parentNode; if (p && p.nodeType === 11 && p.host) return p.host; return null; }
  function walk(root, fn) { if (root.nodeType === 1 && root.shadowRoot) walk(root.shadowRoot, fn); const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let node; while ((node = it.nextNode())) { fn(node); if (node.shadowRoot) walk(node.shadowRoot, fn); } }
  function inForm(el) { let p = el; while (p) { if (p.tagName && p.tagName.toLowerCase() === 'form') return true; p = parentOf(p); } return false; }
  function navigates(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') { const h = el.getAttribute('href'); if (h && !/^(#|javascript:)/i.test(h.trim())) return true; }
    if (tag === 'button' && (el.type === 'submit' || !el.type) && inForm(el)) return true;
    if (tag === 'input') return true;
    return false;
  }
  function visible(el) { try { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; } catch { return false; } }
  function consider(el, why) {
    if (seen.has(el) || cands.length >= R.max) return; if (navigates(el) || !visible(el)) return;
    seen.add(el); const n = cands.length; el.setAttribute('data-smcinv-click', String(n));
    cands.push({ n, why, text: (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60), tag: el.tagName.toLowerCase() });
  }
  walk(document.documentElement, el => {
    const tag = el.tagName.toLowerCase();
    const clickable = tag === 'button' || tag === 'a' || tag === 'summary' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab' || el.hasAttribute('onclick') || el.tabIndex >= 0;
    if (clickable) {
      const blob = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.id, el.className && el.className.baseVal !== undefined ? '' : el.className, el.getAttribute('data-target'), el.getAttribute('href')].filter(Boolean).join(' ');
      if (textRe.test(blob) && blob.length < 400) consider(el, 'text');
    }
  });
  for (const sel of R.controlSelectors) { let els = []; walk(document.documentElement, el => { try { if (el.matches(sel)) els.push(el); } catch {} }); for (const el of els) consider(el, 'control'); }
  return cands;
}

/** Runs in page: CMP presence probes. */
export function cmpScript(R) {
  const found = [];
  for (const g of R.globals) { try { if (typeof window[g] !== 'undefined') found.push('window.' + g); } catch {} }
  try { if (window.dataLayer && JSON.stringify(window.dataLayer).includes('"consent"')) found.push('dataLayer:consent'); } catch {}
  const html = document.documentElement.outerHTML;
  if (new RegExp(R.gtagConsentRegex).test(html)) found.push('gtag(consent,default)');
  return found;
}
