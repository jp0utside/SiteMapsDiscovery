// URL normalization + crawl-scope decisions. Scope is a three-way config:
// crawl_allowlist (crawl fully) / normalize_to_www (alias) / never_crawl (record, never enqueue).

export function globToRegex(glob, { anchorEnd = true } = {}) {
  const esc = glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*');
  return new RegExp('^' + esc + (anchorEnd ? '$' : ''), 'i');
}

export class Scope {
  constructor(scopeCfg, inventoryCfg = {}) {
    this.allow = new Set((scopeCfg.crawl_allowlist || []).map(h => h.toLowerCase()));
    this.aliases = Object.fromEntries(Object.entries(scopeCfg.normalize_to_www || {}).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    this.never = (scopeCfg.never_crawl || []).map(g => globToRegex(g));
    this.recordAlways = scopeCfg.record_always !== false;
    this.skipExt = new Set((inventoryCfg.skip_extensions || []).map(e => e.toLowerCase().replace(/^\./, '')));
    this.stripParams = (inventoryCfg.strip_query_params || []).map(p => globToRegex(p));
  }
  canonicalHost(host) {
    host = (host || '').toLowerCase();
    return this.aliases[host] || host;
  }
  isCrawlableHost(host) {
    host = this.canonicalHost(host);
    if (this.allow.has(host)) return true;
    return false; // never_crawl patterns cover everything else; the allowlist is the only way in
  }
  /** Normalize for queue insertion. Returns null if the URL should be skipped as an asset / non-http. */
  normalize(input, base) {
    let u;
    try { u = new URL(input, base); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.hostname = this.canonicalHost(u.hostname);
    if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    // drop tracking params, preserve everything else in original order
    if (this.stripParams.length && u.search) {
      const kept = [];
      for (const [k, v] of u.searchParams) if (!this.stripParams.some(re => re.test(k))) kept.push([k, v]);
      const sp = new URLSearchParams(); for (const [k, v] of kept) sp.append(k, v);
      u.search = sp.toString() ? '?' + sp.toString() : '';
    }
    // strip trailing slash consistently (but keep root "/")
    let p = u.pathname.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    u.pathname = p;
    if (u.port === '80' && u.protocol === 'http:') u.port = '';
    if (u.port === '443' && u.protocol === 'https:') u.port = '';
    return u;
  }
  isAsset(u) {
    const m = u.pathname.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
    return !!(m && this.skipExt.has(m[1]));
  }
  /** Full decision for a candidate link: { url, crawl: bool, reason } */
  classify(input, base) {
    const u = this.normalize(input, base);
    if (!u) return { url: null, crawl: false, reason: 'unparseable' };
    const url = u.toString();
    if (!this.isCrawlableHost(u.host)) return { url, crawl: false, reason: 'out_of_scope_host' };
    if (this.isAsset(u)) return { url, crawl: false, reason: 'asset' };
    return { url, crawl: true, reason: 'ok' };
  }
}

export function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
export function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
