// OpenClaw Bridge - Receives requests from Mission Control agents
// and forwards them to OpenClaw for processing

import express from 'express';
import cors from 'cors';
import { EventEmitter } from 'events';

const app = express();
const PORT = process.env.PORT || 3002;
const WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET || '';

app.use(cors());
app.use(express.json());

// Pending requests waiting for OpenClaw to process
const pendingRequests = new Map();
// Async notifications that don't wait for responses (fire-and-forget)
const asyncNotifications = new Map();
const requestEmitter = new EventEmitter();

// Cleanup old requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.timestamp > 120000) { // 2 minutes old
      pendingRequests.delete(id);
    }
  }
  // Cleanup old async notifications (keep for 10 minutes)
  for (const [id, notif] of asyncNotifications) {
    if (now - notif.timestamp > 600000) { // 10 minutes old
      asyncNotifications.delete(id);
    }
  }
}, 300000);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'openclaw-bridge',
    pending: {
      sync: pendingRequests.size,
      async: asyncNotifications.size,
      total: pendingRequests.size + asyncNotifications.size
    },
    uptime: process.uptime()
  });
});

// Receive task requests from Mission Control
app.post('/webhook/mission-control', async (req, res) => {
  // Verify secret if configured
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { task, type, timestamp, source, agentName, context } = req.body;
  
  if (!task) {
    return res.status(400).json({ error: 'Missing task' });
  }

  const requestId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const notificationType = context?.notificationType;
  
  // Determine if this is an async notification (mentions, thread updates)
  // These don't require waiting for a response
  const asyncTypes = ['mention', 'direct', 'thread_update', 'all', 'chat_mention'];
  const isAsync = asyncTypes.includes(notificationType);
  
  console.log(`📥 [${requestId}] ${isAsync ? 'ASYNC' : 'SYNC'} request from ${source || agentName || 'unknown'}: ${task.substring(0, 100)}...`);
  
  if (isAsync) {
    // Fire-and-forget: Store in async queue and return immediately
    asyncNotifications.set(requestId, {
      id: requestId,
      task,
      type: type || 'notification',
      notificationType,
      source: source || agentName || 'mission-control',
      agentName: agentName || source,
      context: context || {},
      timestamp: timestamp || Date.now(),
      status: 'pending'
    });
    
    console.log(`📨 [${requestId}] Queued async notification for ${agentName || source} (${asyncNotifications.size} in queue)`);
    
    // Return immediately - don't wait
    return res.json({ 
      success: true, 
      requestId,
      async: true,
      message: 'Notification queued for processing'
    });
  }
  
  // Synchronous request (task assignments, etc.) - wait for response
  pendingRequests.set(requestId, {
    id: requestId,
    task,
    type: type || 'general',
    source: source || agentName || 'mission-control',
    agentName: agentName || source,
    context: context || {},
    timestamp: timestamp || Date.now(),
    status: 'pending'
  });

  // Wait for OpenClaw to process (max 55 seconds to stay under typical timeouts)
  try {
    const result = await waitForResult(requestId, 55000);
    res.json(result);
  } catch (error) {
    res.status(504).json({ 
      error: 'Request timed out waiting for OpenClaw',
      requestId,
      hint: 'OpenClaw may be busy or not connected. Try again.'
    });
  } finally {
    pendingRequests.delete(requestId);
  }
});

// OpenClaw polls for pending requests (includes both sync and async)
app.get('/requests/pending', (req, res) => {
  // Get sync requests
  const syncRequests = Array.from(pendingRequests.values())
    .filter(r => r.status === 'pending');
  
  // Get async notifications
  const asyncRequests = Array.from(asyncNotifications.values())
    .filter(r => r.status === 'pending');
  
  // Combine and sort by timestamp (oldest first)
  const allRequests = [...syncRequests, ...asyncRequests]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, 10); // Max 10 at a time
  
  res.json({ 
    count: allRequests.length,
    requests: allRequests,
    // Also provide breakdowns
    syncCount: syncRequests.length,
    asyncCount: asyncRequests.length
  });
});

// Get only async notifications (for agents checking their mentions)
app.get('/notifications/pending', (req, res) => {
  const { agentName } = req.query;
  
  let notifications = Array.from(asyncNotifications.values())
    .filter(n => n.status === 'pending');
  
  // Filter by agent name if provided
  if (agentName) {
    notifications = notifications.filter(n => 
      n.agentName?.toLowerCase() === agentName.toLowerCase() ||
      n.source?.toLowerCase() === agentName.toLowerCase()
    );
  }
  
  res.json({
    count: notifications.length,
    notifications: notifications.slice(0, 20) // Max 20 at a time
  });
});

// Get specific request details
app.get('/requests/:id', (req, res) => {
  const request = pendingRequests.get(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  res.json(request);
});

// OpenClaw submits results
app.post('/requests/:id/result', (req, res) => {
  const { id } = req.params;
  const { result, error } = req.body;
  
  // Check sync requests first
  let request = pendingRequests.get(id);
  let isAsync = false;
  
  // If not found in sync, check async notifications
  if (!request) {
    request = asyncNotifications.get(id);
    isAsync = true;
  }
  
  if (!request) {
    return res.status(404).json({ error: 'Request not found or expired' });
  }

  console.log(`📤 [${id}] Result received (${isAsync ? 'async' : 'sync'})`);
  
  request.status = 'completed';
  request.result = error ? { error } : result;
  request.completedAt = Date.now();
  
  if (isAsync) {
    // For async, just mark as done and remove from queue
    asyncNotifications.delete(id);
  } else {
    // For sync, notify waiting handler
    requestEmitter.emit(`result:${id}`, request.result);
  }
  
  res.json({ success: true, async: isAsync });
});

// Mark an async notification as acknowledged (without providing a result)
app.post('/notifications/:id/ack', (req, res) => {
  const { id } = req.params;
  
  const notif = asyncNotifications.get(id);
  if (!notif) {
    return res.status(404).json({ error: 'Notification not found or expired' });
  }
  
  console.log(`✓ [${id}] Notification acknowledged`);
  asyncNotifications.delete(id);
  
  res.json({ success: true });
});

// Helper: wait for result with timeout
function waitForResult(requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      requestEmitter.removeAllListeners(`result:${requestId}`);
      reject(new Error('Timeout'));
    }, timeoutMs);

    requestEmitter.once(`result:${requestId}`, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

// Dashboard UI
app.get('/', (req, res) => {
  const syncPending = Array.from(pendingRequests.values());
  const asyncPending = Array.from(asyncNotifications.values());
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>OpenClaw Bridge</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      padding: 2rem; 
      max-width: 800px; 
      margin: 0 auto;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1 { color: #f97316; }
    h2 { color: #94a3b8; font-size: 1rem; margin-top: 2rem; }
    .status { 
      background: #1e293b; 
      padding: 1rem; 
      border-radius: 8px; 
      margin: 1rem 0;
    }
    .status.ok { border-left: 4px solid #22c55e; }
    .request {
      background: #1e293b;
      padding: 1rem;
      border-radius: 8px;
      margin: 0.5rem 0;
    }
    .request .type { 
      display: inline-block;
      background: #f97316;
      color: #0f172a;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: bold;
    }
    .request .type.async { background: #8b5cf6; }
    .request .task { margin: 0.5rem 0; }
    .request .meta { color: #64748b; font-size: 0.75rem; }
    code { 
      background: #334155; 
      padding: 0.2rem 0.4rem; 
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .empty { color: #64748b; font-style: italic; }
    a { color: #60a5fa; }
    .badge { 
      display: inline-block; 
      background: #334155; 
      padding: 0.2rem 0.5rem; 
      border-radius: 4px; 
      margin-right: 0.5rem;
    }
    .badge.sync { background: #f97316; color: #0f172a; }
    .badge.async { background: #8b5cf6; }
  </style>
</head>
<body>
  <h1>🦞 OpenClaw Bridge</h1>
  
  <div class="status ok">
    <strong>Status:</strong> Online<br>
    <strong>Pending:</strong> 
      <span class="badge sync">${syncPending.length} sync</span>
      <span class="badge async">${asyncPending.length} async</span><br>
    <strong>Uptime:</strong> ${Math.floor(process.uptime() / 60)} minutes
  </div>

  <h2>ENDPOINTS</h2>
  <div class="status">
    <code>POST /webhook/mission-control</code> - Receive tasks (auto-detects sync/async)<br>
    <code>GET /requests/pending</code> - OpenClaw polls for all work<br>
    <code>GET /notifications/pending</code> - Get async notifications only<br>
    <code>POST /requests/:id/result</code> - Submit results<br>
    <code>POST /notifications/:id/ack</code> - Acknowledge notification<br>
    <code>GET /health</code> - Health check
  </div>

  <h2>SYNC REQUESTS (waiting for response)</h2>
  ${syncPending.length === 0 
    ? '<p class="empty">No pending sync requests</p>' 
    : syncPending.map(r => `
      <div class="request">
        <span class="type">${r.type.toUpperCase()}</span>
        <div class="task">${r.task.substring(0, 200)}${r.task.length > 200 ? '...' : ''}</div>
        <div class="meta">ID: ${r.id} | Agent: ${r.agentName || r.source} | Status: ${r.status}</div>
      </div>
    `).join('')}

  <h2>ASYNC NOTIFICATIONS (fire-and-forget)</h2>
  ${asyncPending.length === 0 
    ? '<p class="empty">No pending async notifications</p>' 
    : asyncPending.map(r => `
      <div class="request">
        <span class="type async">${(r.notificationType || r.type).toUpperCase()}</span>
        <div class="task">${r.task.substring(0, 200)}${r.task.length > 200 ? '...' : ''}</div>
        <div class="meta">ID: ${r.id} | For: ${r.agentName || r.source} | Type: ${r.notificationType || 'unknown'}</div>
      </div>
    `).join('')}

  <h2>SETUP</h2>
  <div class="status">
    <p>1. Set <code>OPENCLAW_BRIDGE_URL</code> in Mission Control to this URL</p>
    <p>2. Configure OpenClaw to poll <code>/requests/pending</code> and submit to <code>/requests/:id/result</code></p>
    <p>3. Async notifications (mentions, thread updates) are stored until processed or expire (10 min)</p>
  </div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`
🦞 OpenClaw Bridge
   Port: ${PORT}
   Secret: ${WEBHOOK_SECRET ? 'configured' : 'not set (open)'}

Endpoints:
  POST /webhook/mission-control  - Receive tasks (auto sync/async)
  GET  /requests/pending         - Poll for all pending work
  GET  /notifications/pending    - Poll async notifications only
  POST /requests/:id/result      - Submit results
  POST /notifications/:id/ack    - Acknowledge notification
  GET  /health                   - Health check
  `);
});
