import fs from 'node:fs';
import path from 'node:path';

/** Free bytes on the filesystem holding `file` (or its nearest existing parent). Returns null if unknown. */
export function freeBytes(file) {
  let p = path.resolve(file);
  while (!fs.existsSync(p)) { const parent = path.dirname(p); if (parent === p) return null; p = parent; }
  try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}
export const mb = (b) => (b == null ? '?' : (b / 1048576).toFixed(0));

/**
 * Disk guard: returns a message if free space is below the configured minimum, else null.
 * Used by the crawl loops every N pages so a full disk stops the run loudly instead of crashing it.
 */
export function diskGuard(cfg) {
  const min = Number(cfg.storage?.min_free_disk_mb || 0); if (!min) return null;
  const free = freeBytes(cfg.database); if (free == null) return null;
  if (free < min * 1048576) return `LOW DISK: ${mb(free)} MB free on the database volume, below storage.min_free_disk_mb (${min} MB). Stopping so SQLite writes cannot fail mid-page. Free space (or lower inventory.store_html to "hits") and re-run to resume.`;
  return null;
}
