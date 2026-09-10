// Per-host token bucket. Rate limit is per host, not global.
export class HostRateLimiter {
  constructor(rps = 2) { this.interval = 1000 / Math.max(0.01, rps); this.next = new Map(); }
  async wait(host) {
    host = (host || '').toLowerCase();
    const now = Date.now();
    const t = Math.max(now, this.next.get(host) || 0);
    this.next.set(host, t + this.interval);
    if (t > now) await new Promise(r => setTimeout(r, t - now));
  }
}
