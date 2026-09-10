import { chromium } from 'playwright';
import { log } from './log.js';

/** Browser + context lifecycle. Contexts are recycled every N pages to bound memory growth. */
export class BrowserPool {
  constructor(cfg) { this.cfg = cfg; this.browser = null; this.contexts = new Map(); }
  async launch() {
    if (this.browser) return this.browser;
    if (!this.launching) {   // serialise concurrent workers on a single launch
      this.launching = chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking'] })
        .then(b => { this.browser = b; b.on('disconnected', () => { this.browser = null; this.contexts.clear(); }); return b; })
        .finally(() => { this.launching = null; });
    }
    return this.launching;
  }
  async context(workerId, { cookies } = {}) {
    await this.launch();
    let c = this.contexts.get(workerId);
    if (c && c.pages >= (this.cfg.scan.context_recycle_pages || 200)) { await this.closeContext(workerId); c = null; }
    if (!c) {
      const ctx = await this.browser.newContext({
        userAgent: this.cfg.http.user_agent, viewport: this.cfg.scan.viewport, acceptDownloads: false,
        ignoreHTTPSErrors: false, javaScriptEnabled: true, serviceWorkers: 'block', locale: 'en-US',
      });
      if (cookies && cookies.length) await ctx.addCookies(cookies).catch(() => {});
      c = { ctx, pages: 0 }; this.contexts.set(workerId, c);
    }
    c.pages++;
    return c.ctx;
  }
  async closeContext(workerId) { const c = this.contexts.get(workerId); if (c) { this.contexts.delete(workerId); await c.ctx.close().catch(() => {}); } }
  async close() { for (const id of [...this.contexts.keys()]) await this.closeContext(id); if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; } }
}
export { log };
