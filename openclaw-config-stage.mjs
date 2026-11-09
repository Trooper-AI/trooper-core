#!/usr/bin/env node
// Temporarily park Trooper-managed ACP plugin declarations while OpenClaw
// repairs legacy config. Doctor may otherwise install those plugins and run
// their state migrations against a config it is changing in the same pass.
import fs from 'node:fs';
import path from 'node:path';

const [action, configPath, sidecarOrStateRoot, pluginIdOrPackage, stateRootArgument] = process.argv.slice(2);
const managedPluginIds = ['acpx', 'lobster'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeAtomic(filePath, value, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, mode);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function pluginEnabled(config, pluginId) {
  const entryEnabled = config.plugins?.entries?.[pluginId]?.enabled === true;
  return pluginId === 'acpx'
    ? entryEnabled || (config.acp?.enabled === true && config.acp?.backend === 'acpx')
    : entryEnabled;
}

function installedPluginVersion(stateRoot, packageName) {
  const projectsRoot = path.join(stateRoot, 'npm', 'projects');
  let projectNames;
  try {
    projectNames = fs.readdirSync(projectsRoot);
  } catch {
    return '';
  }
  for (const projectName of projectNames) {
    const manifestPath = path.join(projectsRoot, projectName, 'node_modules', ...packageName.split('/'), 'package.json');
    try {
      const manifest = readJson(manifestPath);
      if (manifest.name === packageName && typeof manifest.version === 'string') return manifest.version;
    } catch {}
  }
  return '';
}

try {
  if (action === 'park') {
    const config = readJson(configPath);
    const saved = { entries: {} };
    if (Object.hasOwn(config, 'acp')) {
      saved.acp = config.acp;
      delete config.acp;
    }
    const entries = config.plugins?.entries;
    for (const pluginId of managedPluginIds) {
      if (entries && Object.hasOwn(entries, pluginId)) {
        saved.entries[pluginId] = entries[pluginId];
        delete entries[pluginId];
      }
    }
    const mode = fs.statSync(configPath).mode & 0o777;
    writeAtomic(sidecarOrStateRoot, saved, 0o600);
    writeAtomic(configPath, config, mode);
    console.log('[config-stage] Parked managed ACP/plugin declarations for schema repair');
    process.exit(0);
  }

  if (action === 'restore') {
    const config = readJson(configPath);
    const saved = readJson(sidecarOrStateRoot);
    if (saved.acp && typeof saved.acp === 'object' && !Array.isArray(saved.acp)) {
      const acp = { ...saved.acp };
      // OpenClaw removed this retired tuning option; restoring it would make
      // the config invalid again and keep the gateway in a restart loop.
      delete acp.maxConcurrentSessions;
      delete acp.permissions;
      delete acp.sessionTimeout;
      if (acp.dispatch && typeof acp.dispatch === 'object') delete acp.dispatch.prefix;
      config.acp = acp;
    }
    config.plugins ??= {};
    config.plugins.entries ??= {};
    for (const [pluginId, entry] of Object.entries(saved.entries ?? {})) {
      config.plugins.entries[pluginId] = entry;
    }
    const mode = fs.statSync(configPath).mode & 0o777;
    writeAtomic(configPath, config, mode);
    console.log('[config-stage] Restored managed ACP/plugin declarations; removed retired ACP tuning');
    process.exit(0);
  }

  if (action === 'plugin-enabled') {
    const config = readJson(configPath);
    process.exit(pluginEnabled(config, sidecarOrStateRoot) ? 0 : 1);
  }

  if (action === 'plugin-version') {
    process.stdout.write(installedPluginVersion(configPath, sidecarOrStateRoot));
    process.exit(0);
  }

  if (action === 'assert-plugin-version') {
    const config = readJson(configPath);
    const pluginId = sidecarOrStateRoot;
    const expectedVersion = pluginIdOrPackage;
    if (!pluginEnabled(config, pluginId)) process.exit(0);
    const packageName = pluginId === 'acpx' ? '@openclaw/acpx' : '@openclaw/lobster';
    const actualVersion = installedPluginVersion(stateRootArgument || path.dirname(configPath), packageName);
    if (actualVersion !== expectedVersion) {
      console.error(`[config-stage] ${pluginId} package version is ${actualVersion || 'missing'}; expected ${expectedVersion}`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error('[config-stage] Unknown command');
  process.exit(2);
} catch (error) {
  console.error(`[config-stage] ${error instanceof Error ? error.message : 'operation failed'}`);
  process.exit(1);
}
