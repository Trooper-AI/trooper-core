// The trooper-acp-event-relay OpenClaw gateway plugin: registers tool and
// terminal hooks inside the gateway and POSTs batched activity events to the
// bridge. This is the PUSH lane for ACP child-session activity — without it
// the bridge only learns what a child did by polling chat.history once per
// tick. The shared ACP event stream (lib/acp-event-stream.mjs) ingests these
// posts through the same dedupe line as polling, so the poller degrades to a
// backstop whenever push is flowing.
//
// Hook names vary across gateway builds; each registration is wrapped in its
// own try/catch so an unknown hook can never break the plugin — whatever
// subset registers still delivers value (agent_end alone gives instant
// terminality).

export const ACP_EVENT_RELAY_PLUGIN_ID = 'trooper-acp-event-relay';
export const ACP_EVENT_RELAY_BATCH_MS = 500;
export const ACP_EVENT_RELAY_CONTENT_CAP = 2000;
export const ACP_EVENT_RELAY_HOOKS = Object.freeze([
  'before_tool_call',
  'after_tool_call',
  'agent_end',
  'session_end',
]);

export function buildAcpEventRelayPluginFiles({ bridgePort = 3002, token = '' } = {}) {
  const endpoint = `http://host.docker.internal:${bridgePort}/internal/acp-event`;
  const fallbackEndpoint = `http://172.17.0.1:${bridgePort}/internal/acp-event`;

  const manifest = {
    id: ACP_EVENT_RELAY_PLUGIN_ID,
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
    name: ACP_EVENT_RELAY_PLUGIN_ID,
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    openclaw: { extensions: ['./index.js'] },
  };

  const entry = `// trooper-acp-event-relay — POSTs batched session activity to the Trooper bridge.
const DEFAULT_ENDPOINT = ${JSON.stringify(endpoint)};
const FALLBACK_ENDPOINT = ${JSON.stringify(fallbackEndpoint)};
const TOKEN = ${JSON.stringify(String(token || ''))};
const BATCH_MS = ${ACP_EVENT_RELAY_BATCH_MS};
const CONTENT_CAP = ${ACP_EVENT_RELAY_CONTENT_CAP};
const MAX_QUEUE = 200;

let queue = [];
let flushTimer = null;

async function postBatch(events) {
  const body = JSON.stringify({ events });
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

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  const events = queue;
  queue = [];
  void postBatch(events);
}

function enqueue(event) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(event);
  if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS);
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function cap(value) {
  const text = typeof value === 'string' ? value : (value == null ? '' : JSON.stringify(value));
  return text.length > CONTENT_CAP ? text.slice(0, CONTENT_CAP) : text;
}

function relayEvent(kind, event, ctx) {
  const scope = ctx || (event && event.ctx) || {};
  enqueue({
    kind,
    sessionKey: pick(scope.sessionKey, event && event.sessionKey),
    runId: pick(event && event.runId, scope.runId),
    tool: pick(event && event.toolName, event && event.tool, event && event.name),
    toolCallId: pick(event && event.toolCallId, event && event.callId, event && event.id),
    contentText: cap(pick(event && event.content, event && event.output, event && event.result, event && event.params, event && event.input) || ''),
    success: event ? event.success !== false && !event.is_error : true,
    reason: pick(event && event.reason, scope.reason),
    ts: Date.now(),
  });
}

export default function register(api) {
  const on = api && typeof api.on === 'function' ? api.on.bind(api) : null;
  if (!on) return;

  for (const hook of ${JSON.stringify([...ACP_EVENT_RELAY_HOOKS])}) {
    try {
      on(hook, (event, ctx) => {
        try {
          relayEvent(hook, event, ctx);
        } catch {
          // never let telemetry failures affect the run
        }
      });
    } catch {
      // unknown hook on this gateway build — register the rest
    }
  }
}
`;

  return [
    { path: 'openclaw.plugin.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'index.js', content: entry },
  ];
}
