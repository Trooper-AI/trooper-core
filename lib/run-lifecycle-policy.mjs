const TERMINAL_SUCCESS_PHASES = new Set(['end', 'result', 'completed', 'complete']);
const TERMINAL_FAILURE_PHASES = new Set(['failed', 'aborted', 'cancelled', 'canceled']);
const ASSISTANT_TRANSCRIPT_BOUNDARY_RE = /cannot continue from message role\s*:\s*assistant/i;

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

export function isAssistantTranscriptBoundaryError(error) {
  return ASSISTANT_TRANSCRIPT_BOUNDARY_RE.test(String(error?.message || error || ''));
}

export function shouldRecoverAssistantTranscriptBoundary({ error, attempt = 0 } = {}) {
  return Number(attempt || 0) < 1 && isAssistantTranscriptBoundaryError(error);
}

export function buildPostCompactionRecoveryMessage(originalMessage = '') {
  const original = String(originalMessage || '').trim();
  const requestReference = original && original.length <= 6000
    ? `\n\nOriginal request for reference:\n${original}`
    : '';
  return [
    '[Trooper automatic continuation recovery]',
    'The session was compacted successfully, but OpenClaw stopped at an assistant transcript boundary before continuing.',
    'Resume the same task from the compacted checkpoint. Preserve completed work and existing files, do not repeat successful tool actions, and continue through the remaining steps to a final response.',
  ].join('\n') + requestReference;
}
