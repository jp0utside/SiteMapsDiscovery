// Rolling-window health monitor for page fetches / navigations. Detects a WAF or rate limiter reacting
// mid-run (403 / 429 / 5xx bursts) so the run stops LOUDLY instead of producing a falsely clean inventory.
export const BLOCK_STATUSES = new Set([403, 429, 401, 502, 503, 504]);
export const isBlockStatus = (s) => BLOCK_STATUSES.has(Number(s));
// 401 / 403 can equally be a property of one page (unpublished or access-restricted content) rather than of the host.
export const isDenialStatus = (s) => Number(s) === 401 || Number(s) === 403;

/**
 * Tells a page-level denial from a host-level block by re-fetching a known-good URL (the homepage).
 * If that still answers 2xx the host is not rejecting us, so the denial belongs to the page. Checked fresh
 * for every denial (concurrent callers share one request) so a real block is never masked by an old answer.
 */
export class Canary {
  constructor(http, url) { this.http = http; this.url = url; this.inflight = null; }
  hostOk() {
    if (!this.url) return Promise.resolve(false);
    if (!this.inflight) this.inflight = this.http.get(this.url, { maxBytes: 4096 }).then(r => r.status >= 200 && r.status < 300, () => false).finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

export class HealthMonitor {
  constructor({ window = 25, threshold = 8, errorsCount = true } = {}) { this.window = window; this.threshold = threshold; this.errorsCount = errorsCount; this.recent = []; this.total = new Map(); }
  record(status, { pageLevel = false } = {}) { const k = status == null ? 'error' : pageLevel ? `${status}(page)` : String(status); this.recent.push(k); if (this.recent.length > this.window) this.recent.shift(); this.total.set(k, (this.total.get(k) || 0) + 1); }
  /** True once any page has answered normally (2xx / 3xx) — evidence the host is serving us. */
  sawSuccess() { return [...this.total.keys()].some(k => /^[23]\d\d$/.test(k)); }
  blockedCount() { return this.recent.filter(k => k === 'error' ? this.errorsCount : isBlockStatus(k)).length; }
  isBlocked() { return this.recent.length >= Math.min(this.window, this.threshold) && this.blockedCount() >= this.threshold; }
  summary() {
    const c = new Map(); for (const k of this.recent) c.set(k, (c.get(k) || 0) + 1);
    return `last ${this.recent.length}: ` + [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
  }
  totals() { return [...this.total.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' '); }
}
