import zlib from 'node:zlib';
import { log } from './log.js';

/** Fetch a sitemap (index or urlset) recursively. Generic: no assumption about the number of children. */
export async function collectSitemapUrls(http, startUrls, { maxSitemaps = 500, onUrl } = {}) {
  const queue = [...startUrls]; const seen = new Set(); const urls = []; let count = 0;
  while (queue.length && seen.size < maxSitemaps) {
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    let text;
    try {
      const r = await http.get(sm, { accept: 'application/xml,text/xml,*/*', maxBytes: 60_000_000 });
      if (r.status !== 200) { log.warn(`sitemap ${sm} -> HTTP ${r.status}`); continue; }
      let buf = r.body;
      if (/\.gz($|\?)/.test(sm) || /gzip/i.test(r.contentType) || (buf[0] === 0x1f && buf[1] === 0x8b)) { try { buf = zlib.gunzipSync(buf); } catch {} }
      text = buf.toString('utf8');
    } catch (e) { log.warn(`sitemap ${sm} failed: ${e.message}`); continue; }
    const isIndex = /<sitemapindex[\s>]/i.test(text);
    const locRe = isIndex ? /<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi : /<url>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/url>/gi;
    let m, n = 0;
    while ((m = locRe.exec(text))) {
      const loc = decodeXml(m[1]);
      if (isIndex) { queue.push(loc); } else { urls.push(loc); n++; if (onUrl) onUrl(loc, sm); }
    }
    if (!isIndex && n === 0) { // plain text sitemap or loose xml
      for (const line of text.split(/\r?\n/)) { const t = line.trim(); if (/^https?:\/\//.test(t)) { urls.push(t); n++; if (onUrl) onUrl(t, sm); } }
    }
    count++;
    log.info(`sitemap ${sm}: ${isIndex ? 'index' : `${n} urls`}`);
  }
  return { urls, sitemapsFetched: count };
}
const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
