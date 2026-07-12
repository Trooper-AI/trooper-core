const TERMINAL_SUCCESS_PHASES = new Set(['end', 'result', 'completed', 'complete']);
const TERMINAL_FAILURE_PHASES = new Set(['failed', 'aborted', 'cancelled', 'canceled']);

export function classifyOpenClawLifecycleSignal(payload = {}) {
  const phase = String(payload?.phase || '').trim().toLowerCase();
  if (TERMINAL_SUCCESS_PHASES.has(phase)) {
    return { phase, terminal: true, successful: true };
  }
  if (TERMINAL_FAILURE_PHASES.has(phase)) {
    return { phase, terminal: true, successful: false };
  }
  // OpenClaw emits lifecycle:error for recoverable model, tool, and compaction
  // attempts while the parent run can remain active. It is telemetry, not EOF.
  return { phase, terminal: false, successful: null };
}
