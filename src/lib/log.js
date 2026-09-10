const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const log = {
  info: (...a) => console.log(`[${ts()}]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] WARN`, ...a),
  error: (...a) => console.error(`[${ts()}] ERROR`, ...a),
  loud: (msg) => {
    const bar = '!'.repeat(Math.min(78, msg.length + 4));
    console.warn(`\n${bar}\n!! ${msg}\n${bar}\n`);
  },
};
export function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '?';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}
