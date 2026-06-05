#!/usr/bin/env node
import express from 'express';
import {
  DEFAULT_SHARED_STATE_DIR,
  DEFAULT_SHARED_WORKSPACES_ROOT,
  ensureWorkspaceSlot,
  readSlotRegistry,
  updateWorkspaceSlotStatus,
} from './lib/shared-workspace-slots.mjs';
import { startSlotRuntime, stopSlotRuntime } from './lib/shared-slot-runtime.mjs';
import path from 'path';

const app = express();
const PORT = Number(process.env.SHARED_NODE_MANAGER_PORT || process.env.PORT || 3100);
const AUTH_TOKEN = String(process.env.SHARED_NODE_MANAGER_AUTH_TOKEN || process.env.BRIDGE_AUTH_TOKEN || '').trim();
const WORKSPACES_ROOT = process.env.TROOPER_SHARED_WORKSPACES_ROOT || DEFAULT_SHARED_WORKSPACES_ROOT;
const STATE_DIR = process.env.TROOPER_SHARED_STATE_DIR || DEFAULT_SHARED_STATE_DIR;
const REGISTRY_PATH = process.env.TROOPER_SHARED_SLOT_REGISTRY || path.join(STATE_DIR, 'slots.json');
const PUBLIC_BASE_URL = String(process.env.TROOPER_SHARED_NODE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_DIR = process.env.TROOPER_BRIDGE_DIR || process.cwd();
const RUNTIME_AUTH_SECRET = process.env.RUNTIME_AUTH_SECRET || '';
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || process.env.TROOPER_CALLBACK_URL || '';

app.use(express.json({ limit: '5mb' }));

function requireManagerAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const header = String(req.headers.authorization || '');
  if (header !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid shared node manager token' });
  }
  return next();
}

function proxyBaseFor(slotId) {
  if (!PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/runtime/workspaces/${encodeURIComponent(slotId)}/proxy`;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    role: 'trooper-shared-user-node-manager',
    workspacesRoot: WORKSPACES_ROOT,
  });
});

app.get('/runtime/workspaces', requireManagerAuth, (_req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  res.json({ slots: Object.values(registry.slots || {}) });
});

app.get('/runtime/workspaces/:slotId/status', requireManagerAuth, (req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slot = registry.slots?.[req.params.slotId];
  if (!slot) return res.status(404).json({ error: 'workspace_slot_not_found' });
  res.json({ ...slot, bridgeUrl: proxyBaseFor(slot.slotId), runtimeUrl: proxyBaseFor(slot.slotId) ? `${proxyBaseFor(slot.slotId)}/runtime-api` : null });
});

app.post('/runtime/workspaces/:slotId/start', requireManagerAuth, async (req, res) => {
  try {
    const slot = ensureWorkspaceSlot({
      orgId: req.body?.orgId || req.params.slotId,
      orgName: req.body?.orgName || '',
      ownerUserId: req.body?.ownerUserId || '',
      workspaceSlotId: req.body?.workspaceSlotId || req.params.slotId,
      root: WORKSPACES_ROOT,
      registryPath: REGISTRY_PATH,
    });
    const starting = updateWorkspaceSlotStatus({
      slotId: slot.slotId,
      status: 'starting',
      registryPath: REGISTRY_PATH,
    });
    const runtime = await startSlotRuntime(starting, {
      bridgeDir: BRIDGE_DIR,
      runtimeAuthSecret: RUNTIME_AUTH_SECRET,
      missionControlUrl: MISSION_CONTROL_URL,
    });
    const next = updateWorkspaceSlotStatus({
      slotId: slot.slotId,
      status: 'ready',
      registryPath: REGISTRY_PATH,
      patch: {
        gatewayToken: runtime.gatewayToken,
        bridgeAuthToken: runtime.bridgeAuthToken,
        containerName: runtime.gateway.containerName,
        bridgePid: runtime.bridge.pid || starting.bridgePid || null,
      },
    });
    const bridgeUrl = proxyBaseFor(next.slotId);
    res.json({
      ok: true,
      status: next.status,
      slot: next,
      bridgeUrl,
      runtimeUrl: bridgeUrl ? `${bridgeUrl}/runtime-api` : null,
      gatewayUrl: bridgeUrl,
    });
  } catch (error) {
    try {
      updateWorkspaceSlotStatus({
        slotId: req.params.slotId,
        status: 'failed',
        registryPath: REGISTRY_PATH,
        patch: { error: error.message },
      });
    } catch {}
    res.status(500).json({ error: 'workspace_slot_start_failed', message: error.message });
  }
});

app.post('/runtime/workspaces/:slotId/pause', requireManagerAuth, async (req, res) => {
  try {
    const registry = readSlotRegistry(REGISTRY_PATH);
    const existing = registry.slots?.[req.params.slotId];
    if (!existing) return res.status(404).json({ error: 'workspace_slot_not_found' });
    await stopSlotRuntime(existing);
    const slot = updateWorkspaceSlotStatus({
      slotId: req.params.slotId,
      status: 'paused',
      registryPath: REGISTRY_PATH,
    });
    res.json({ ok: true, slot });
  } catch (error) {
    res.status(404).json({ error: 'workspace_slot_not_found', message: error.message });
  }
});

app.all('/runtime/workspaces/:slotId/proxy/*', requireManagerAuth, async (req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slot = registry.slots?.[req.params.slotId];
  if (!slot) return res.status(404).json({ error: 'workspace_slot_not_found' });
  if (slot.status !== 'ready') {
    return res.status(503).json({
      error: 'workspace_slot_not_ready',
      message: `Workspace slot ${slot.slotId} is ${slot.status || 'cold'}`,
      slotStatus: slot.status || 'cold',
    });
  }

  const suffix = req.originalUrl.replace(/^\/runtime\/workspaces\/[^/]+\/proxy/, '') || '/';
  const target = `http://127.0.0.1:${slot.ports.bridge}${suffix}`;
  try {
    const response = await fetch(target, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase()))),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(30000),
    });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) res.setHeader(key, value);
    });
    const body = Buffer.from(await response.arrayBuffer());
    res.send(body);
  } catch (error) {
    res.status(502).json({ error: 'workspace_slot_proxy_failed', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[shared-node-manager] listening on ${PORT}; root=${WORKSPACES_ROOT}`);
});
