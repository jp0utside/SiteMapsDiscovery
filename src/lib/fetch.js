import { Agent, EnvHttpProxyAgent, request } from 'undici';
process.on('warning', (w) => { if (w.name === 'ExperimentalWarning' && /EnvHttpProxyAgent/.test(w.message)) return; });
import { HostRateLimiter } from './ratelimit.js';
import { hostOf } from './url.js';
import zlib from 'node:zlib';

/** Static HTTP client: UA, timeouts, per-host rate limit, redirects, size cap. GET only — never state-changing. */
export class HttpClient {
  constructor(httpCfg) {
    this.cfg = httpCfg;
    this.limiter = new HostRateLimiter(httpCfg.requests_per_second_per_host || 2);
    const opts = { connect: { timeout: httpCfg.timeout_ms || 30000 }, headersTimeout: httpCfg.timeout_ms || 30000, bodyTimeout: httpCfg.timeout_ms || 30000 };
    this.dispatcher = (process.env.HTTPS_PROXY || process.env.https_proxy) ? new EnvHttpProxyAgent(opts) : new Agent(opts);
  }
  async get(url, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', maxBytes, headers = {}, rateLimit = true, maxRedirects = 5, htmlOnly = false } = {}) {
    let current = url; const chain = [];
    for (let i = 0; i <= maxRedirects; i++) {
      if (rateLimit) await this.limiter.wait(hostOf(current));
      const res = await request(current, {
        method: 'GET', dispatcher: this.dispatcher, maxRedirections: 0,
        headers: { 'user-agent': this.cfg.user_agent, accept, 'accept-encoding': 'gzip, deflate, br', ...headers },
      });
      const status = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        await res.body.dump().catch(() => {});
        chain.push(current);
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      const ctype = String(res.headers['content-type'] || '');
      const limit = maxBytes || this.cfg.max_html_bytes || 5_000_000;
      // htmlOnly: the caller discards non-HTML anyway, so don't download the file (PDFs behind extensionless URLs).
      if (htmlOnly && status < 400 && !isHtml(ctype)) { res.body.on('error', () => {}); try { res.body.destroy(); } catch {} return { status, headers: res.headers, contentType: ctype, body: Buffer.alloc(0), finalUrl: current, redirects: chain, truncated: true }; }
      const chunks = []; let size = 0; let truncated = false;
      for await (const c of res.body) { size += c.length; if (size > limit) { truncated = true; break; } chunks.push(c); }
      if (truncated) { try { res.body.destroy(); } catch {} }
      let buf = Buffer.concat(chunks);
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
        else if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
        else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
      } catch { /* partial body; keep raw */ }
      return { status, headers: res.headers, contentType: ctype, body: buf, finalUrl: current, redirects: chain, truncated };
    }
    throw new Error(`too many redirects for ${url}`);
  }
  async getText(url, opts) { const r = await this.get(url, opts); return { ...r, text: r.body.toString('utf8') }; }
  async close() { try { await this.dispatcher.close(); } catch {} }
}
export const isHtml = (ctype) => /text\/html|application\/xhtml/i.test(ctype || '');
