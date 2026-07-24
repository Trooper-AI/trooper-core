// The trooper-run-completion OpenClaw gateway plugin: registers typed
// agent_end / session_end hooks inside the gateway and POSTs a completion
// payload to the bridge the moment a run terminates. This is the PUSH-based
// completion signal — independent of the WS request/response frame that the
// bridge otherwise relies on (and which can be dropped, stranding a finished
// run in "Working" forever).
//
// Docs: typed plugin hooks `agent_end` ("observe final messages, success
// state, and run duration"; fire-and-forget after turn completion, carries
// runId/sessionKey) and `session_end` (reason: idle/reset/compaction/...).

export const RUN_COMPLETION_PLUGIN_ID = 'trooper-run-completion';

/** Terminal markers keyed by runId AND sessionKey so pollers can read
 *  completion even after the SSE stream is long gone. */
export class RunTerminalMarkerStore {
  constructor({ ttlMs = 60 * 60_000, maxEntries = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.byRunId = new Map();
    this.bySessionKey = new Map();
  }

  record({ runId = null, sessionKey = null, kind = 'agent_end', success = true, reason = null, endedAt = Date.now() } = {}) {
    const marker = { runId, sessionKey, kind, success: success !== false, reason, endedAt };
    if (runId) this.byRunId.set(String(runId), marker);
    if (sessionKey) this.bySessionKey.set(String(sessionKey), marker);
    this.prune();
    return marker;
  }

  get({ runId = null, sessionKey = null } = {}) {
    this.prune();
    if (runId && this.byRunId.has(String(runId))) return this.byRunId.get(String(runId));
    if (sessionKey && this.bySessionKey.has(String(sessionKey))) return this.bySessionKey.get(String(sessionKey));
    return null;
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const map of [this.byRunId, this.bySessionKey]) {
      for (const [key, marker] of map.entries()) {
        if ((marker?.endedAt || 0) < cutoff) map.delete(key);
      }
      while (map.size > this.maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  }
}

/**
 * Build the plugin's on-disk files. The entry is dependency-free and
 * defensive: hook registration shapes vary slightly across gateway versions
 * (single event arg vs (event, ctx)), and a plugin failure must never affect
 * the agent run itself.
 */
export function buildRunCompletionPluginFiles({ bridgePort = 3002, token = '' } = {}) {
  const endpoint = `http://host.docker.internal:${bridgePort}/internal/run-complete`;
  const fallbackEndpoint = `http://172.17.0.1:${bridgePort}/internal/run-complete`;

  const manifest = {
    id: RUN_COMPLETION_PLUGIN_ID,
    configSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string' },
        fallbackEndpoint: { type: 'string' },
        token: { type: 'string' },
      },
      additionalProperties: true,
    },
  };

  const packageJson = {
    name: RUN_COMPLETION_PLUGIN_ID,
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    openclaw: { extensions: ['./index.js'] },
  };

  const entry = `// trooper-run-completion — POSTs run terminal signals to the Trooper bridge.
const DEFAULT_ENDPOINT = ${JSON.stringify(endpoint)};
const FALLBACK_ENDPOINT = ${JSON.stringify(fallbackEndpoint)};
const TOKEN = ${JSON.stringify(String(token || ''))};

async function postCompletion(payload) {
  const body = JSON.stringify(payload);
  for (const url of [DEFAULT_ENDPOINT, FALLBACK_ENDPOINT]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(TOKEN ? { 'x-trooper-bridge-token': TOKEN } : {}),
        },
        body,
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
      if (res && res.ok) return true;
    } catch {
      // try the fallback endpoint
    }
  }
  return false;
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

export default function register(api) {
  const on = api && typeof api.on === 'function' ? api.on.bind(api) : null;
  if (!on) return;

  on('agent_end', (event, ctx) => {
    try {
      const scope = ctx || event?.ctx || {};
      void postCompletion({
        kind: 'agent_end',
        runId: pick(event?.runId, scope.runId),
        sessionKey: pick(scope.sessionKey, event?.sessionKey),
        agentId: pick(scope.agentId, event?.agentId),
        success: event?.success !== false,
        endedAt: Date.now(),
      });
    } catch {
      // never let telemetry failures affect the run
    }
  });

  on('session_end', (event, ctx) => {
    try {
      const scope = ctx || event?.ctx || {};
      void postCompletion({
        kind: 'session_end',
        reason: pick(event?.reason, scope.reason),
        sessionKey: pick(scope.sessionKey, event?.sessionKey),
        endedAt: Date.now(),
      });
    } catch {
      // never let telemetry failures affect the run
    }
  });
}
`;

  return [
    { path: 'openclaw.plugin.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'index.js', content: entry },
  ];
}
