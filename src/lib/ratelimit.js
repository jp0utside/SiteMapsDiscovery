// Per-host token bucket. Rate limit is per host, not global.
export class HostRateLimiter {
  constructor(rps = 2) { this.interval = 1000 / Math.max(0.01, rps); this.next = new Map(); this.hostInterval = new Map(); }
  /** Force a minimum spacing (ms) for one host, e.g. robots.txt Crawl-delay. Never makes a host faster than the global rate. */
  setHostMinInterval(host, ms) { this.hostInterval.set((host || '').toLowerCase(), Math.max(this.interval, ms)); }
  intervalFor(host) { return this.hostInterval.get(host) || this.interval; }
  async wait(host) {
    host = (host || '').toLowerCase();
    const now = Date.now();
    const t = Math.max(now, this.next.get(host) || 0);
    this.next.set(host, t + this.intervalFor(host));
    if (t > now) await new Promise(r => setTimeout(r, t - now));
  }
}
