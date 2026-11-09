const TRUSTED_NODE_COMMANDS = ['system.run', 'system.which'];

/**
 * Keep bridge startup compatible with current OpenClaw's keyed node-command
 * policy. OpenClaw 2026.11 rejects the retired allowCommands/denyCommands
 * fields, so migrate the old values before ensuring Trooper's trusted node
 * commands are present.
 */
export function migrateGatewayNodeCommands(config) {
  const gateway = config?.gateway;
  if (!gateway || typeof gateway !== 'object' || Array.isArray(gateway)) {
    return { changed: false };
  }
  const nodes = gateway.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
    return { changed: false };
  }

  const commands = nodes.commands && typeof nodes.commands === 'object' && !Array.isArray(nodes.commands)
    ? nodes.commands
    : {};
  const oldAllow = Array.isArray(nodes.allowCommands) ? nodes.allowCommands : [];
  const oldDeny = Array.isArray(nodes.denyCommands) ? nodes.denyCommands : [];
  const currentAllow = Array.isArray(commands.allow) ? commands.allow : [];
  const currentDeny = Array.isArray(commands.deny) ? commands.deny : [];
  const allow = [...new Set([...currentAllow, ...oldAllow, ...TRUSTED_NODE_COMMANDS]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  const deny = [...new Set([...currentDeny, ...oldDeny]
    .map((value) => String(value || '').trim())
    .filter((value) => value && !TRUSTED_NODE_COMMANDS.includes(value)))];

  const changed = !Array.isArray(commands.allow)
    || JSON.stringify(commands.allow) !== JSON.stringify(allow)
    || JSON.stringify(Array.isArray(commands.deny) ? commands.deny : []) !== JSON.stringify(deny)
    || Object.hasOwn(nodes, 'allowCommands')
    || Object.hasOwn(nodes, 'denyCommands');
  if (!changed) return { changed: false };

  commands.allow = allow;
  if (deny.length) commands.deny = deny;
  else delete commands.deny;
  delete nodes.allowCommands;
  delete nodes.denyCommands;
  nodes.commands = commands;
  return { changed: true, allowed: allow };
}
