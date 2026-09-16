// Post-detection policy shared by tier 1 and tier 2: which findings are recorded, and what counts as a "hit"
// that schedules a tier-2 render. Both are config.yaml → detection options.
export function applyDetectionPolicy(findings, cfg) {
  const d = cfg.detection || {};
  return d.record_links === false ? findings.filter(f => f.type !== 'map_link_only') : findings;
}
/** A tier-1 hit is a main-content finding; links count only when detection.links_trigger_render is on. */
export function isHit(findings, cfg) {
  const linksCount = (cfg.detection || {}).links_trigger_render !== false;
  return findings.some(f => f.placement === 'main_content' && (linksCount || f.type !== 'map_link_only'));
}
