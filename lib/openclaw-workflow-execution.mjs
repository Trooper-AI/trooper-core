/**
 * Saved-workflow execution contract, modeled on openclaw-video-execution.mjs.
 *
 * Trooper flattens a user-built workflow graph into an ordered step list and
 * ships it twice: structured on `context.workflow.steps` (preferred) and as a
 * machine-readable JSON block inside the task text (fallback for transports
 * that drop context fields). This module turns that plan into an enforced
 * completion contract: every tool-backed step must show a successful matching
 * tool call in the run's tool log before the run may finalize. Model-internal
 * steps (llm/condition/transform/…) stay advisory — they cannot be evidenced
 * from a tool log and must not block completion.
 */

const WORKFLOW_STEPS_START = '<!-- TROOPER_WORKFLOW_STEPS_START -->';
const WORKFLOW_STEPS_END = '<!-- TROOPER_WORKFLOW_STEPS_END -->';

const WORKFLOW_EXECUTION_RULES_START = '<!-- OPENCLAW_WORKFLOW_EXECUTION_CONTRACT_START -->';
const WORKFLOW_EXECUTION_RULES_END = '<!-- OPENCLAW_WORKFLOW_EXECUTION_CONTRACT_END -->';

export const OPENCLAW_WORKFLOW_EXECUTION_RULES = `${WORKFLOW_EXECUTION_RULES_START}
## Saved workflow execution contract

This run executes a user-built saved workflow. The workflow steps in the task are the required plan, not inspiration.

- Execute the steps in the given order with real tool calls. A tool-backed step (search, fetch, browser, document, email, database, video) is complete only when its tool call succeeded.
- Advisory steps (trigger, condition, filter, transform, llm, agent, chat, output) are satisfied by your reasoning and routing — but never use them as an excuse to skip a tool-backed step.
- Trigger steps describe when this workflow runs; do not wait on them.
- Video steps follow the video execution contract: mutate the timeline with video_* tools and drive renders to a terminal completed status. A queued render is not a deliverable.
- If a step's tool fails, report the exact tool and error. Never claim workflow completion with unexecuted or failed steps.
- Keep progress narration short; the tool calls and their outputs are the work product.
${WORKFLOW_EXECUTION_RULES_END}`;

/** Tool-name evidence per step type. Matching is lowercase substring-tolerant. */
const STEP_EVIDENCE_TOOLS = Object.freeze({
  web_search: Object.freeze({ exact: ['web_search', 'search', 'brave_search', 'google_search', 'tavily_search'], substrings: ['_search'] }),
  web_fetch: Object.freeze({ exact: ['web_fetch', 'fetch', 'http_request', 'curl', 'read_url', 'webfetch'], substrings: ['fetch'] }),
  browser: Object.freeze({ exact: ['navigate', 'screenshot', 'click', 'type_text'], substrings: ['browser', 'computer', 'chrome_'] }),
  document: Object.freeze({ exact: ['write', 'write_file', 'create_file', 'edit', 'edit_file', 'str_replace', 'apply_patch'], substrings: ['docx', 'pdf', 'document', 'file_write'] }),
  email: Object.freeze({ exact: ['send_email', 'gmail_send', 'send_message'], substrings: ['email', 'gmail'] }),
  database: Object.freeze({ exact: ['query', 'sql', 'execute_sql'], substrings: ['database', 'sqlite', 'postgres', 'mysql', 'firestore'] }),
  video: Object.freeze({ exact: [], substrings: ['video_'] }),
});

/** Step types that cannot be evidenced from a tool log — always satisfied. */
const ADVISORY_STEP_TYPES = Object.freeze(new Set([
  'trigger', 'condition', 'filter', 'transform', 'llm', 'agent', 'chat', 'output', 'step',
]));

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isFailurePayload(value) {
  const payload = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error || payload.isError === true || payload.is_error === true) return true;
  const numericStatus = Number(payload.status);
  if (Number.isFinite(numericStatus) && numericStatus >= 400) return true;
  if (payload.success === false || payload.ok === false) return true;
  return ['failed', 'error'].includes(String(payload.status || '').trim().toLowerCase());
}

function successfulToolEntries(toolLog = []) {
  return (Array.isArray(toolLog) ? toolLog : []).filter((entry) => (
    entry
    && entry.success === true
    && !isFailurePayload(entry.result)
    && !isFailurePayload(entry.summary)
  ));
}

function normalizeSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) return [];
  return rawSteps
    .filter((step) => step && typeof step === 'object')
    .map((step, position) => {
      const type = String(step.type || 'step').trim().toLowerCase();
      return {
        id: String(step.id || `step_${position + 1}`),
        index: Number.isFinite(Number(step.index)) ? Number(step.index) : position + 1,
        type,
        label: String(step.label || step.title || `Step ${position + 1}`),
        evidenceKind: ADVISORY_STEP_TYPES.has(type) || !STEP_EVIDENCE_TOOLS[type] ? 'none' : type,
      };
    });
}

function stepsFromTaskText(task = '') {
  const text = String(task || '');
  const start = text.indexOf(WORKFLOW_STEPS_START);
  if (start < 0) return [];
  const end = text.indexOf(WORKFLOW_STEPS_END, start);
  if (end < 0) return [];
  const payload = safeJsonParse(text.slice(start + WORKFLOW_STEPS_START.length, end).trim());
  return normalizeSteps(payload?.steps);
}

export function appendOpenClawWorkflowExecutionRules(markdown = '') {
  const original = String(markdown || '');
  if (original.includes(WORKFLOW_EXECUTION_RULES_START)) return original;
  const current = original.trimEnd();
  return `${current}${current ? '\n\n' : ''}${OPENCLAW_WORKFLOW_EXECUTION_RULES}\n`;
}

export function inferWorkflowExecutionContract({ task = '', context = {} } = {}) {
  const lane = String(context?.executionLane || '').trim().toLowerCase();
  if (lane !== 'workflow') return { enabled: false, steps: [] };
  const contextSteps = normalizeSteps(context?.workflow?.steps);
  const steps = contextSteps.length ? contextSteps : stepsFromTaskText(task);
  if (!steps.length) return { enabled: false, steps: [] };
  return {
    enabled: true,
    workflowId: context?.workflow?.id || context?.workflowId || null,
    workflowName: context?.workflow?.name || context?.workflowName || null,
    steps,
  };
}

function toolMatchesStep(toolName, evidenceKind) {
  const spec = STEP_EVIDENCE_TOOLS[evidenceKind];
  if (!spec) return false;
  if (spec.exact.includes(toolName)) return true;
  return spec.substrings.some((fragment) => toolName.includes(fragment));
}

/**
 * @param {Array} toolLog run tool log (reconciled with history upstream)
 * @param {object} contract from inferWorkflowExecutionContract
 * @param {{ videoEvaluation?: object|null }} options final video completion
 *   evaluation for this run — video steps delegate to it instead of
 *   re-implementing video semantics.
 */
export function evaluateWorkflowExecutionCompletion(toolLog = [], contract = {}, { videoEvaluation = null } = {}) {
  if (contract?.enabled !== true) {
    return { complete: true, satisfiedStepIds: [], missing: [], tools: [] };
  }
  const successful = successfulToolEntries(toolLog);
  const toolNames = successful.map((entry) => String(entry.tool || '').trim().toLowerCase()).filter(Boolean);
  const satisfiedStepIds = [];
  const missing = [];
  for (const step of Array.isArray(contract.steps) ? contract.steps : []) {
    if (step.evidenceKind === 'none') {
      satisfiedStepIds.push(step.id);
      continue;
    }
    if (step.evidenceKind === 'video') {
      const videoSatisfied = videoEvaluation
        ? videoEvaluation.mutation === true && videoEvaluation.missing?.length === 0
        : toolNames.some((name) => toolMatchesStep(name, 'video'));
      if (videoSatisfied) {
        satisfiedStepIds.push(step.id);
      } else {
        missing.push({
          id: step.id,
          index: step.index,
          label: step.label,
          expected: 'a completed video deliverable (timeline mutation + terminal render) via video_* tools',
        });
      }
      continue;
    }
    if (toolNames.some((name) => toolMatchesStep(name, step.evidenceKind))) {
      satisfiedStepIds.push(step.id);
    } else {
      missing.push({
        id: step.id,
        index: step.index,
        label: step.label,
        expected: `a successful ${step.evidenceKind} tool call`,
      });
    }
  }
  return {
    complete: missing.length === 0,
    satisfiedStepIds,
    missing,
    tools: toolNames,
  };
}

export function buildWorkflowExecutionContinuation({ evaluation, attempt = 1 } = {}) {
  const missingLines = Array.isArray(evaluation?.missing) && evaluation.missing.length > 0
    ? evaluation.missing.map((step) => `- Step ${step.index} "${step.label}" — expected ${step.expected}`).join('\n')
    : '- required workflow steps';
  const successfulTools = Array.isArray(evaluation?.tools) && evaluation.tools.length > 0
    ? evaluation.tools.join(', ')
    : 'none';
  return `[SYSTEM CONTINUATION — WORKFLOW RUN INCOMPLETE, ATTEMPT ${attempt}]
Do not provide another plan or status-only answer. These saved-workflow steps still have no successful tool evidence:
${missingLines}
Successful tools so far: ${successfulTools}.

Continue the run now and execute each missing step with its real tool. If a tool fails, report the exact tool and error instead of claiming completion.`;
}

export const __testables = {
  STEP_EVIDENCE_TOOLS,
  ADVISORY_STEP_TYPES,
  WORKFLOW_STEPS_START,
  WORKFLOW_STEPS_END,
  WORKFLOW_EXECUTION_RULES_START,
  WORKFLOW_EXECUTION_RULES_END,
  stepsFromTaskText,
  normalizeSteps,
};
