import fs from 'node:fs';
import path from 'node:path';
import { screenshotName } from './identity.js';
import { log } from './log.js';

/** One screenshot per unique identity_key (default), clipped to the map container. Hard cap on image count. */
export class ScreenshotPolicy {
  constructor(cfg, db) {
    this.cfg = cfg.screenshots; this.db = db; this.dir = path.resolve(this.cfg.dir || './screenshots');
    if (this.cfg.mode !== 'none') fs.mkdirSync(this.dir, { recursive: true });
    this.count = fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter(f => f.endsWith('.jpg')).length : 0;
    this.capWarned = false;
  }
  shouldCapture(identityKey, isNewIdentity) {
    if (this.cfg.mode === 'none') return false;
    if (this.count >= (this.cfg.max_images || 1000)) { if (!this.capWarned) { log.warn(`screenshot cap of ${this.cfg.max_images} reached; continuing scan without screenshots`); this.capWarned = true; } return false; }
    if (this.cfg.mode === 'all') return true;
    return isNewIdentity;
  }
  async capture(page, identityKey, containerSelector, bbox) {
    const file = path.join(this.dir, this.cfg.mode === 'all' ? `${screenshotName(identityKey + '|' + page.url())}` : screenshotName(identityKey));
    const opts = { path: file, type: 'jpeg', quality: this.cfg.jpeg_quality || 70, timeout: 8000 };
    try {
      let done = false;
      if (containerSelector && containerSelector !== '*') {
        const loc = page.locator(containerSelector).first();
        try { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }); await loc.screenshot(opts); done = true; } catch { done = false; }
      }
      if (!done && bbox && bbox.w > 20 && bbox.h > 20) {
        try { await page.screenshot({ ...opts, fullPage: true, clip: { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h } }); done = true; } catch { done = false; }
      }
      if (!done) await page.screenshot({ ...opts, fullPage: false });
      this.count++;
      return path.relative(process.cwd(), file);
    } catch (e) { log.warn(`screenshot failed for ${identityKey}: ${e.message}`); return null; }
  }
}
