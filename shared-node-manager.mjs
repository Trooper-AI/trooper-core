#!/usr/bin/env node
import express from 'express';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { pathToFileURL } from 'url';
import {
  DEFAULT_SHARED_STATE_DIR,
  DEFAULT_SHARED_WORKSPACES_ROOT,
  ensureWorkspaceSlot,
  normalizeWorkspaceSlotId,
  readSlotRegistry,
  updateWorkspaceSlotStatus,
} from './lib/shared-workspace-slots.mjs';
import { startSlotRuntime, stopSlotRuntime } from './lib/shared-slot-runtime.mjs';
import {
  authorizeSlotAccess,
  hasManagerAuthHeaders,
  isBridgeCandidatePath,
  resolveProxyTarget,
} from './lib/shared-node-routing.mjs';
import { resolveSlotResourceLimits } from './lib/shared-slot-runtime.mjs';
import path from 'path';

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.SHARED_NODE_MANAGER_PORT || process.env.PORT || 3100);
const AUTH_TOKEN = String(process.env.SHARED_NODE_MANAGER_AUTH_TOKEN || process.env.BRIDGE_AUTH_TOKEN || '').trim();
const WORKSPACES_ROOT = process.env.TROOPER_SHARED_WORKSPACES_ROOT || DEFAULT_SHARED_WORKSPACES_ROOT;
const STATE_DIR = process.env.TROOPER_SHARED_STATE_DIR || DEFAULT_SHARED_STATE_DIR;
const REGISTRY_PATH = process.env.TROOPER_SHARED_SLOT_REGISTRY || path.join(STATE_DIR, 'slots.json');
const PUBLIC_BASE_URL = String(process.env.TROOPER_SHARED_NODE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_DIR = process.env.TROOPER_BRIDGE_DIR || process.cwd();
const RUNTIME_AUTH_SECRET = process.env.RUNTIME_AUTH_SECRET || '';
const MISSION_CONTROL_URL = process.env.MISSION_CONTROL_URL || process.env.TROOPER_CALLBACK_URL || '';
/** Auto-wake paused/cold slots when traffic hits the proxy (density P3). */
const AUTO_WAKE_ON_PROXY = String(process.env.TROOPER_SLOT_AUTO_WAKE_ON_PROXY || '1').trim() !== '0';
const AUTO_WAKE_WAIT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.TROOPER_SLOT_WAKE_WAIT_MS || '45000', 10) || 45_000,
);
const CAPACITY_SLOTS = Math.max(0, Number.parseInt(process.env.TROOPER_SHARED_CAPACITY_SLOTS || '0', 10) || 0);
const RESERVED_SLOTS = Math.max(0, Number.parseInt(process.env.TROOPER_SHARED_RESERVED_SLOTS || '0', 10) || 0);
const MAX_CONCURRENT_DESKTOPS = Math.max(0, Number.parseInt(process.env.TROOPER_SHARED_MAX_DESKTOPS || '0', 10) || 0);
const startTasks = new Map();

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countSlotsByStatus(slots = []) {
  const counts = { cold: 0, starting: 0, ready: 0, paused: 0, failed: 0, other: 0 };
  for (const slot of slots) {
    const status = String(slot?.status || 'cold').trim().toLowerCase();
    if (counts[status] !== undefined) counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * If slot is paused/cold/failed, kick start and optionally wait until ready.
 * Returns the latest slot record from the registry.
 */
async function ensureSlotAwakeForProxy(slot, { waitMs = AUTO_WAKE_WAIT_MS } = {}) {
  const status = String(slot?.status || 'cold').trim().toLowerCase();
  if (status === 'ready') return slot;
  if (!AUTO_WAKE_ON_PROXY) return slot;
  if (!['paused', 'cold', 'failed'].includes(status) && status !== 'starting') return slot;

  console.log(`[shared-node-manager] auto-wake slot ${slot.slotId} from status=${status}`);
  ensureWorkspaceSlotStartTask(slot);

  const deadline = Date.now() + Math.max(0, waitMs);
  let current = slot;
  while (Date.now() < deadline) {
    await sleepMs(1500);
    const registry = readSlotRegistry(REGISTRY_PATH);
    current = registry.slots?.[slot.slotId] || current;
    if (String(current.status || '').toLowerCase() === 'ready') return current;
    if (String(current.status || '').toLowerCase() === 'failed' && Date.now() > deadline - 3000) break;
  }
  return readSlotRegistry(REGISTRY_PATH).slots?.[slot.slotId] || current;
}

app.use(express.json({ limit: '5mb' }));

function requireManagerAuth(req, res, next) {
  if (!AUTH_TOKEN) {
    return res.status(503).json({
      error: 'shared_node_manager_auth_not_configured',
      message: 'Shared node manager authorization is not configured',
    });
  }
  const auth = authorizeSlotAccess({
    headers: req.headers,
    managerAuthToken: AUTH_TOKEN,
    requireManager: true,
  });
  if (!auth.ok) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid shared node manager token',
      reason: auth.reason,
    });
  }
  return next();
}

/** Manager token OR this slot's bridge token (status / own-slot reads only). */
function requireManagerOrSlotAuth(req, res, next) {
  if (!AUTH_TOKEN) {
    return res.status(503).json({
      error: 'shared_node_manager_auth_not_configured',
      message: 'Shared node manager authorization is not configured',
    });
  }
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slotId = normalizeWorkspaceSlotId(req.params.slotId || '');
  const slot = registry.slots?.[slotId] || null;
  const auth = authorizeSlotAccess({
    headers: req.headers,
    managerAuthToken: AUTH_TOKEN,
    slot,
    requireManager: false,
  });
  if (!auth.ok) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or invalid token for this workspace slot',
      reason: auth.reason,
    });
  }
  req.slotAuthRole = auth.role;
  req.workspaceSlot = slot;
  return next();
}

function proxyBaseFor(slotId) {
  if (!PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/runtime/workspaces/${encodeURIComponent(slotId)}/proxy`;
}

function hasManagerAuth(req) {
  return hasManagerAuthHeaders(req.headers, AUTH_TOKEN);
}

function shouldRouteToBridge(suffix = '') {
  return isBridgeCandidatePath(suffix);
}

function isGatewayProxyFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('fetch failed')
    || message.includes('socket')
    || message.includes('econnrefused')
    || message.includes('terminated')
    || message.includes('timeout')
  );
}

function getProxySuffix(rawUrl = '') {
  const value = String(rawUrl || '');
  return value.replace(/^\/runtime\/workspaces\/[^/]+\/proxy/, '') || '/';
}

function buildSlotResponse(slot) {
  const bridgeUrl = proxyBaseFor(slot.slotId);
  return {
    ok: slot.status !== 'failed',
    status: slot.status,
    slot,
    bridgeUrl,
    runtimeUrl: bridgeUrl ? `${bridgeUrl}/runtime-api` : null,
    gatewayUrl: bridgeUrl,
    gatewayToken: slot.gatewayToken || null,
    error: slot.error || null,
  };
}

function prepareSlotRuntimeTokens(slot) {
  const gatewayToken = String(slot.gatewayToken || '').trim() || `oc-${crypto.randomBytes(16).toString('hex')}`;
  const bridgeAuthToken = String(slot.bridgeAuthToken || '').trim() || crypto.createHash('sha256').update(`${gatewayToken}:bridge`).digest('hex');
  return { gatewayToken, bridgeAuthToken };
}

async function runWorkspaceSlotStart(slot) {
  const tokens = prepareSlotRuntimeTokens(slot);
  const limits = resolveSlotResourceLimits(slot);
  const starting = updateWorkspaceSlotStatus({
    slotId: slot.slotId,
    status: 'starting',
    registryPath: REGISTRY_PATH,
    patch: {
      error: null,
      gatewayToken: tokens.gatewayToken,
      bridgeAuthToken: tokens.bridgeAuthToken,
      cpuLimit: limits.cpuLimit,
      memoryLimitMb: limits.memoryLimitMb,
      pidsLimit: limits.pidsLimit,
      startRequestedAt: Date.now(),
    },
  });
  try {
    const runtime = await startSlotRuntime(starting, {
      gatewayToken: tokens.gatewayToken,
      bridgeAuthToken: tokens.bridgeAuthToken,
      bridgeDir: BRIDGE_DIR,
      runtimeAuthSecret: RUNTIME_AUTH_SECRET,
      missionControlUrl: MISSION_CONTROL_URL,
      cpuLimit: limits.cpuLimit,
      memoryLimitMb: limits.memoryLimitMb,
      pidsLimit: limits.pidsLimit,
    });
    return updateWorkspaceSlotStatus({
      slotId: slot.slotId,
      status: 'ready',
      registryPath: REGISTRY_PATH,
      patch: {
        error: null,
        readyAt: Date.now(),
        gatewayToken: runtime.gatewayToken,
        bridgeAuthToken: runtime.bridgeAuthToken,
        containerName: runtime.gateway.containerName,
        bridgePid: runtime.bridge.pid || starting.bridgePid || null,
        cpuLimit: limits.cpuLimit,
        memoryLimitMb: limits.memoryLimitMb,
        pidsLimit: limits.pidsLimit,
        verifiedAt: Date.now(),
        verification: runtime.verification || null,
      },
    });
  } catch (error) {
    updateWorkspaceSlotStatus({
      slotId: slot.slotId,
      status: 'failed',
      registryPath: REGISTRY_PATH,
      patch: {
        error: error.message,
        failedAt: Date.now(),
      },
    });
    throw error;
  } finally {
    startTasks.delete(slot.slotId);
  }
}

function ensureWorkspaceSlotStartTask(slot) {
  const existing = startTasks.get(slot.slotId);
  if (existing) return existing;
  const task = runWorkspaceSlotStart(slot).catch((error) => {
    console.error(`[shared-node-manager] workspace slot ${slot.slotId} failed: ${error.message}`);
    return null;
  });
  startTasks.set(slot.slotId, task);
  return task;
}

async function forwardWorkspaceProxyRequest({ req, res, slot, suffix, routeToBridge, targetPort }) {
  const target = `http://127.0.0.1:${targetPort}${suffix}`;
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'authorization'].includes(key.toLowerCase())));
  if (routeToBridge && slot.bridgeAuthToken) headers.Authorization = `Bearer ${slot.bridgeAuthToken}`;
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    signal: AbortSignal.timeout(30000),
  });
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (!['content-encoding', 'content-length'].includes(key.toLowerCase())) res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.send(body);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    role: 'trooper-shared-user-node-manager',
    workspacesRoot: WORKSPACES_ROOT,
  });
});

app.get('/runtime/capacity', requireManagerAuth, (_req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slots = Object.values(registry.slots || {});
  const byStatus = countSlotsByStatus(slots);
  const capacitySlots = CAPACITY_SLOTS > 0 ? CAPACITY_SLOTS : Math.max(slots.length, 0);
  const freeSlots = CAPACITY_SLOTS > 0
    ? Math.max(0, CAPACITY_SLOTS - RESERVED_SLOTS - slots.length)
    : null;
  res.json({
    ok: true,
    nodeId: process.env.TROOPER_SHARED_NODE_ID || process.env.HOSTNAME || 'shared-node',
    capacitySlots: CAPACITY_SLOTS || null,
    reservedSlots: RESERVED_SLOTS,
    slotsUsed: slots.length,
    freeSlots,
    maxConcurrentDesktops: MAX_CONCURRENT_DESKTOPS || null,
    desktopsUsed: null,
    freeDesktops: null,
    byStatus,
    hotSlots: byStatus.ready + byStatus.starting,
    sleepingSlots: byStatus.paused + byStatus.cold,
    autoWakeOnProxy: AUTO_WAKE_ON_PROXY,
  });
});

app.get('/runtime/workspaces', requireManagerAuth, (_req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  res.json({ slots: Object.values(registry.slots || {}) });
});

app.get('/runtime/workspaces/:slotId/status', requireManagerOrSlotAuth, (req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slotId = normalizeWorkspaceSlotId(req.params.slotId);
  const slot = req.workspaceSlot || registry.slots?.[slotId];
  if (!slot) return res.status(404).json({ error: 'workspace_slot_not_found', slotId });
  res.json(buildSlotResponse(slot));
});

app.post('/runtime/workspaces/:slotId/start', requireManagerAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const cpuLimit = body.cpuLimit ?? body.cpus ?? undefined;
    const memoryLimitMb = body.memoryLimitMb ?? body.memoryMb ?? undefined;
    const pidsLimit = body.pidsLimit ?? undefined;

    let slot = ensureWorkspaceSlot({
      orgId: body.orgId || req.params.slotId,
      orgName: body.orgName || '',
      ownerUserId: body.ownerUserId || '',
      workspaceSlotId: body.workspaceSlotId || req.params.slotId,
      publicBaseUrl: PUBLIC_BASE_URL,
      root: WORKSPACES_ROOT,
      registryPath: REGISTRY_PATH,
    });

    // Persist requested resource caps before boot (used by docker --cpus/--memory).
    if (cpuLimit != null || memoryLimitMb != null || pidsLimit != null) {
      slot = updateWorkspaceSlotStatus({
        slotId: slot.slotId,
        status: slot.status,
        registryPath: REGISTRY_PATH,
        patch: {
          ...(cpuLimit != null ? { cpuLimit: String(cpuLimit) } : {}),
          ...(memoryLimitMb != null ? { memoryLimitMb: Number(memoryLimitMb) || undefined } : {}),
          ...(pidsLimit != null ? { pidsLimit: Number(pidsLimit) || undefined } : {}),
        },
      });
    }

    if (slot.status === 'ready') {
      return res.json(buildSlotResponse(slot));
    }
    const asyncRequested = body.async === true || req.query?.async === '1' || req.query?.async === 'true';
    if (asyncRequested) {
      ensureWorkspaceSlotStartTask(slot);
      const registry = readSlotRegistry(REGISTRY_PATH);
      const current = registry.slots?.[slot.slotId] || { ...slot, status: 'starting' };
      return res.status(202).json({
        ...buildSlotResponse(current),
        ok: true,
        accepted: true,
      });
    }
    const next = await runWorkspaceSlotStart(slot);
    return res.json(buildSlotResponse(next));
  } catch (error) {
    try {
      updateWorkspaceSlotStatus({
        slotId: normalizeWorkspaceSlotId(req.params.slotId),
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
    const slotId = normalizeWorkspaceSlotId(req.params.slotId);
    const existing = registry.slots?.[slotId];
    if (!existing) return res.status(404).json({ error: 'workspace_slot_not_found', slotId });
    await stopSlotRuntime(existing);
    const slot = updateWorkspaceSlotStatus({
      slotId,
      status: 'paused',
      registryPath: REGISTRY_PATH,
    });
    res.json({ ok: true, slot });
  } catch (error) {
    res.status(404).json({ error: 'workspace_slot_not_found', message: error.message });
  }
});

app.all('/runtime/workspaces/:slotId/proxy/*', async (req, res) => {
  const registry = readSlotRegistry(REGISTRY_PATH);
  const slotId = normalizeWorkspaceSlotId(req.params.slotId);
  let slot = registry.slots?.[slotId];
  if (!slot) return res.status(404).json({ error: 'workspace_slot_not_found', slotId });

  const suffix = getProxySuffix(req.originalUrl);
  let targetInfo = resolveProxyTarget({
    slot,
    suffix,
    headers: req.headers,
    authToken: AUTH_TOKEN,
    managerAuthToken: AUTH_TOKEN,
  });
  if (targetInfo.error === 'unauthorized') {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Shared workspace bridge routes require manager or slot token',
      reason: targetInfo.reason || 'unauthorized',
    });
  }
  let { routeToBridge, targetPort } = targetInfo;

  // Density P3: auto-wake sleeping slots on traffic instead of hard 503.
  if (slot.status !== 'ready') {
    slot = await ensureSlotAwakeForProxy(slot);
    targetInfo = resolveProxyTarget({
      slot,
      suffix,
      headers: req.headers,
      authToken: AUTH_TOKEN,
      managerAuthToken: AUTH_TOKEN,
    });
    if (targetInfo.error === 'unauthorized') {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Shared workspace bridge routes require manager or slot token',
        reason: targetInfo.reason || 'unauthorized',
      });
    }
    routeToBridge = targetInfo.routeToBridge;
    targetPort = targetInfo.targetPort;
  }

  if (slot.status !== 'ready' && !routeToBridge) {
    return res.status(503).json({
      error: 'workspace_slot_not_ready',
      message: `Workspace slot ${slot.slotId} is ${slot.status || 'cold'}`,
      slotStatus: slot.status || 'cold',
      autoWakeAttempted: AUTO_WAKE_ON_PROXY,
    });
  }

  try {
    await forwardWorkspaceProxyRequest({ req, res, slot, suffix, routeToBridge, targetPort });
  } catch (error) {
    if (!routeToBridge && isGatewayProxyFailure(error)) {
      console.warn(`[shared-node-manager] gateway proxy failed for ${slotId}; restarting slot runtime: ${error.message}`);
      const recovered = await ensureWorkspaceSlotStartTask(slot);
      const retrySlot = recovered || readSlotRegistry(REGISTRY_PATH).slots?.[slotId] || slot;
      if (retrySlot.status === 'ready' && !res.headersSent) {
        try {
          const retryTargetInfo = resolveProxyTarget({
            slot: retrySlot,
            suffix,
            headers: req.headers,
            authToken: AUTH_TOKEN,
            managerAuthToken: AUTH_TOKEN,
          });
          await forwardWorkspaceProxyRequest({
            req,
            res,
            slot: retrySlot,
            suffix,
            routeToBridge: retryTargetInfo.routeToBridge,
            targetPort: retryTargetInfo.targetPort,
          });
          return;
        } catch (retryError) {
          if (!res.headersSent) {
            return res.status(502).json({
              error: 'workspace_slot_proxy_failed',
              message: retryError.message,
              recovered: Boolean(recovered),
              slotStatus: retrySlot.status,
            });
          }
          return;
        }
      }
    }
    if (!res.headersSent) res.status(502).json({ error: 'workspace_slot_proxy_failed', message: error.message });
  }
});

function writeUpgradeError(socket, statusCode, message) {
  const statusText = statusCode === 401 ? 'Unauthorized' : statusCode === 404 ? 'Not Found' : statusCode === 503 ? 'Service Unavailable' : 'Bad Gateway';
  const body = JSON.stringify({ error: message });
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', 'http://shared-node.local');
    const match = url.pathname.match(/^\/runtime\/workspaces\/([^/]+)\/proxy(?:\/.*)?$/);
    if (!match) return writeUpgradeError(socket, 404, 'not_found');
    const registry = readSlotRegistry(REGISTRY_PATH);
    const slotId = normalizeWorkspaceSlotId(match[1]);
    let slot = registry.slots?.[slotId];
    if (!slot) return writeUpgradeError(socket, 404, 'workspace_slot_not_found');
    if (slot.status !== 'ready') {
      // Best-effort async wake; WS upgrade cannot wait long without client timeout.
      if (AUTO_WAKE_ON_PROXY && ['paused', 'cold', 'failed'].includes(String(slot.status || '').toLowerCase())) {
        ensureWorkspaceSlotStartTask(slot);
      }
      return writeUpgradeError(socket, 503, `Workspace slot ${slot.slotId} is ${slot.status || 'cold'}`);
    }

    const suffix = getProxySuffix(req.url);
    const targetInfo = resolveProxyTarget({
      slot,
      suffix,
      headers: req.headers,
      authToken: AUTH_TOKEN,
      managerAuthToken: AUTH_TOKEN,
    });
    if (targetInfo.error === 'unauthorized') return writeUpgradeError(socket, 401, 'unauthorized');

    const upstream = net.connect(targetInfo.targetPort, '127.0.0.1');
    upstream.on('connect', () => {
      const headers = {
        ...req.headers,
        host: `127.0.0.1:${targetInfo.targetPort}`,
      };
      if (targetInfo.routeToBridge && slot.bridgeAuthToken) headers.authorization = `Bearer ${slot.bridgeAuthToken}`;
      const requestLine = `${req.method} ${suffix} HTTP/${req.httpVersion}\r\n`;
      const headerLines = Object.entries(headers)
        .filter(([key, value]) => value !== undefined && value !== null && String(key).toLowerCase() !== 'upgrade-insecure-requests')
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      upstream.write(`${requestLine}${headerLines}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', (error) => {
      console.error(`[shared-node-manager] websocket proxy failed for ${slotId}: ${error.message}`);
      if (!socket.destroyed) writeUpgradeError(socket, 502, 'workspace_slot_websocket_proxy_failed');
    });
    socket.on('error', () => upstream.destroy());
  } catch (error) {
    console.error(`[shared-node-manager] websocket upgrade error: ${error.message}`);
    if (!socket.destroyed) writeUpgradeError(socket, 502, 'workspace_slot_websocket_proxy_failed');
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, () => {
    console.log(`[shared-node-manager] listening on ${PORT}; root=${WORKSPACES_ROOT}`);
  });
}
