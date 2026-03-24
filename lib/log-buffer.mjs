/**
 * log-buffer.mjs — Structured log capture + ring buffer
 * 
 * Captures logs in memory (last 1000 entries) and exposes them via API.
 * Replaces raw console.log/error for important events.
 */

const MAX_LOGS = 1000;
const logs = [];
const stats = {
  startedAt: Date.now(),
  totalErrors: 0,
  totalWarns: 0,
  totalRuns: 0,
  lastError: null,
  lastActivity: Date.now(),
};

/**
 * Capture a structured log entry.
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} message
 * @param {object} meta - Additional context (agentId, runId, taskId, etc.)
 */
export function captureLog(level, message, meta = {}) {
  const entry = {
    level,
    message,
    meta,
    timestamp: Date.now(),
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();

  // Update stats
  stats.lastActivity = Date.now();
  if (level === 'error') {
    stats.totalErrors++;
    stats.lastError = { message, meta, timestamp: Date.now() };
  }
  if (level === 'warn') stats.totalWarns++;

  // Also print to stdout (existing behavior)
  const prefix = `[${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`, meta.stack ? `\n${meta.stack.slice(0, 500)}` : '');
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

/**
 * Record a run (for stats).
 */
export function recordRun() {
  stats.totalRuns++;
  stats.lastActivity = Date.now();
}

/**
 * Query logs with optional filters.
 * @param {object} opts - { level?, limit?, since?, search? }
 * @returns {Array}
 */
export function getLogs({ level, limit = 100, since, search } = {}) {
  let filtered = logs;
  if (level) filtered = filtered.filter(l => l.level === level);
  if (since) filtered = filtered.filter(l => l.timestamp > since);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(l => 
      l.message.toLowerCase().includes(q) || 
      JSON.stringify(l.meta).toLowerCase().includes(q)
    );
  }
  return filtered.slice(-limit);
}

/**
 * Get health/stats snapshot.
 */
export function getStats() {
  return {
    ...stats,
    uptime: Math.floor(process.uptime()),
    uptimeHuman: formatUptime(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    logBufferSize: logs.length,
    errorsLast24h: logs.filter(l => l.level === 'error' && l.timestamp > Date.now() - 86400000).length,
    warnsLast24h: logs.filter(l => l.level === 'warn' && l.timestamp > Date.now() - 86400000).length,
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
