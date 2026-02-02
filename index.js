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
const requestEmitter = new EventEmitter();

// Cleanup old requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pendingRequests) {
    if (now - req.timestamp > 120000) { // 2 minutes old
      pendingRequests.delete(id);
    }
  }
}, 300000);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'openclaw-bridge',
    pending: pendingRequests.size,
    uptime: process.uptime()
  });
});

// Receive task requests from Mission Control
app.post('/webhook/mission-control', async (req, res) => {
  // Verify secret if configured
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { task, type, timestamp, source } = req.body;
  
  if (!task) {
    return res.status(400).json({ error: 'Missing task' });
  }

  const requestId = `mc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  console.log(`📥 [${requestId}] New request from ${source || 'unknown'}: ${task.substring(0, 100)}...`);
  
  // Store request for OpenClaw to pick up
  pendingRequests.set(requestId, {
    id: requestId,
    task,
    type: type || 'general',
    source: source || 'mission-control',
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

// OpenClaw polls for pending requests
app.get('/requests/pending', (req, res) => {
  const requests = Array.from(pendingRequests.values())
    .filter(r => r.status === 'pending')
    .slice(0, 10); // Max 10 at a time
  
  res.json({ 
    count: requests.length,
    requests 
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
  
  const request = pendingRequests.get(id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found or expired' });
  }

  console.log(`📤 [${id}] Result received`);
  
  request.status = 'completed';
  request.result = error ? { error } : result;
  
  // Notify waiting handler
  requestEmitter.emit(`result:${id}`, request.result);
  
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
  const pending = Array.from(pendingRequests.values());
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
  </style>
</head>
<body>
  <h1>🦞 OpenClaw Bridge</h1>
  
  <div class="status ok">
    <strong>Status:</strong> Online<br>
    <strong>Pending Requests:</strong> ${pending.length}<br>
    <strong>Uptime:</strong> ${Math.floor(process.uptime() / 60)} minutes
  </div>

  <h2>ENDPOINTS</h2>
  <div class="status">
    <code>POST /webhook/mission-control</code> - Receive tasks from Mission Control<br>
    <code>GET /requests/pending</code> - OpenClaw polls for work<br>
    <code>POST /requests/:id/result</code> - OpenClaw submits results<br>
    <code>GET /health</code> - Health check
  </div>

  <h2>PENDING REQUESTS</h2>
  ${pending.length === 0 
    ? '<p class="empty">No pending requests</p>' 
    : pending.map(r => `
      <div class="request">
        <span class="type">${r.type.toUpperCase()}</span>
        <div class="task">${r.task.substring(0, 200)}${r.task.length > 200 ? '...' : ''}</div>
        <div class="meta">ID: ${r.id} | Status: ${r.status} | Source: ${r.source}</div>
      </div>
    `).join('')}

  <h2>SETUP</h2>
  <div class="status">
    <p>1. Set <code>OPENCLAW_WEBHOOK_URL</code> in Mission Control to this URL + <code>/webhook/mission-control</code></p>
    <p>2. Configure OpenClaw to poll <code>/requests/pending</code> and submit to <code>/requests/:id/result</code></p>
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
  POST /webhook/mission-control  - Receive tasks from Mission Control
  GET  /requests/pending         - OpenClaw polls for work
  POST /requests/:id/result      - OpenClaw submits results
  GET  /health                   - Health check
  `);
});
