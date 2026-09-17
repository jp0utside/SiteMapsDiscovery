// Rolling-window health monitor for page fetches / navigations. Detects a WAF or rate limiter reacting
// mid-run (403 / 429 / 5xx bursts) so the run stops LOUDLY instead of producing a falsely clean inventory.
export const BLOCK_STATUSES = new Set([403, 429, 401, 502, 503, 504]);
export const isBlockStatus = (s) => BLOCK_STATUSES.has(Number(s));

export class HealthMonitor {
  constructor({ window = 25, threshold = 8, errorsCount = true } = {}) { this.window = window; this.threshold = threshold; this.errorsCount = errorsCount; this.recent = []; this.total = new Map(); }
  record(status) { const k = status == null ? 'error' : String(status); this.recent.push(k); if (this.recent.length > this.window) this.recent.shift(); this.total.set(k, (this.total.get(k) || 0) + 1); }
  blockedCount() { return this.recent.filter(k => k === 'error' ? this.errorsCount : isBlockStatus(k)).length; }
  isBlocked() { return this.recent.length >= Math.min(this.window, this.threshold) && this.blockedCount() >= this.threshold; }
  summary() {
    const c = new Map(); for (const k of this.recent) c.set(k, (c.get(k) || 0) + 1);
    return `last ${this.recent.length}: ` + [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' ');
  }
  totals() { return [...this.total.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(' '); }
}
