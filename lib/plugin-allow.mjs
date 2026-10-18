/**
 * plugins.allow is exclusive. Keep this list in lockstep with
 * OPENCLAW_PLUGIN_ALLOW_IDS in Trooper server/lib/openclaw-config.js.
 * Once a list exists, every plugin we ship stays on it. Do not create a
 * list when one is absent — that would start excluding plugins.
 */
export const OPENCLAW_PLUGIN_ALLOW_IDS = Object.freeze([
  'acpx',
  'brave',
  'discord',
  'imessage',
  'signal',
  'slack',
  'telegram',
  'whatsapp',
  'trooper-acp-event-relay',
  'trooper-browser-control-bridge',
  'trooper-composio-bridge',
  'trooper-daytona-bridge',
  'trooper-html-render-bridge',
  'trooper-image-generation-defaults',
  'trooper-jev-bridge',
  'trooper-run-completion',
  'trooper-treg-bridge',
  'trooper-video-bridge',
]);

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function ensureOpenClawPluginAllowList(openclawConfig) {
  if (!openclawConfig || typeof openclawConfig !== 'object' || Array.isArray(openclawConfig)) {
    return { changed: false, added: [] };
  }
  const allow = openclawConfig.plugins?.allow;
  if (!Array.isArray(allow)) return { changed: false, added: [] };
  const removed = uniqueStrings(allow);
  delete openclawConfig.plugins.allow;
  if (Array.isArray(openclawConfig.plugins.deny)) {
    const required = new Set(OPENCLAW_PLUGIN_ALLOW_IDS);
    const deny = openclawConfig.plugins.deny.filter((id) => !required.has(String(id || '').trim()));
    if (deny.length !== openclawConfig.plugins.deny.length) {
      openclawConfig.plugins.deny = deny;
    }
  }
  if (Array.isArray(openclawConfig.tools?.allow)) delete openclawConfig.tools.allow;
  return { changed: removed.length > 0, added: removed };
}
