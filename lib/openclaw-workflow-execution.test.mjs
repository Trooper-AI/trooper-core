import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_WORKFLOW_EXECUTION_RULES,
  appendOpenClawWorkflowExecutionRules,
  buildWorkflowExecutionContinuation,
  evaluateWorkflowExecutionCompletion,
  inferWorkflowExecutionContract,
  __testables,
} from './openclaw-workflow-execution.mjs';

const contextSteps = [
  { id: 'n0', index: 1, type: 'trigger', label: 'Every Monday' },
  { id: 'n1', index: 2, type: 'web_search', label: 'Find sources' },
  { id: 'n2', index: 3, type: 'document', label: 'Write summary' },
  { id: 'n3', index: 4, type: 'email', label: 'Send report' },
];

function workflowContext(steps = contextSteps) {
  return {
    executionLane: 'workflow',
    workflow: { id: 'wf_1', name: 'Research and Report', steps },
  };
}

test('contract enables from structured context steps on the workflow lane', () => {
  const contract = inferWorkflowExecutionContract({ task: 'run it', context: workflowContext() });
  assert.equal(contract.enabled, true);
  assert.equal(contract.workflowId, 'wf_1');
  assert.equal(contract.steps.length, 4);
  assert.equal(contract.steps[0].evidenceKind, 'none');
  assert.equal(contract.steps[1].evidenceKind, 'web_search');
});

test('contract falls back to the machine-readable block in the task text', () => {
  const { WORKFLOW_STEPS_START, WORKFLOW_STEPS_END } = __testables;
  const task = [
    'Run the workflow.',
    WORKFLOW_STEPS_START,
    JSON.stringify({ workflowId: 'wf_2', steps: [{ id: 'a', index: 1, type: 'web_fetch', label: 'Fetch pricing' }] }),
    WORKFLOW_STEPS_END,
  ].join('\n');
  const contract = inferWorkflowExecutionContract({ task, context: { executionLane: 'workflow' } });
  assert.equal(contract.enabled, true);
  assert.equal(contract.steps[0].evidenceKind, 'web_fetch');
});

test('contract stays disabled off the workflow lane or without steps', () => {
  assert.equal(inferWorkflowExecutionContract({ task: 'x', context: { executionLane: 'media' } }).enabled, false);
  assert.equal(inferWorkflowExecutionContract({ task: 'x', context: { executionLane: 'workflow' } }).enabled, false);
});

test('evaluation satisfies tool-backed steps only with successful matching calls', () => {
  const contract = inferWorkflowExecutionContract({ task: '', context: workflowContext() });
  const evaluation = evaluateWorkflowExecutionCompletion([
    { tool: 'web_search', success: true, result: { results: [1] } },
    { tool: 'write_file', success: true, result: { ok: true } },
  ], contract);
  assert.equal(evaluation.complete, false);
  // trigger auto-satisfied; search + document satisfied; email missing
  assert.deepEqual(evaluation.satisfiedStepIds, ['n0', 'n1', 'n2']);
  assert.equal(evaluation.missing.length, 1);
  assert.equal(evaluation.missing[0].label, 'Send report');
  assert.match(evaluation.missing[0].expected, /email tool call/);
});

test('failure payloads do not count as evidence', () => {
  const contract = inferWorkflowExecutionContract({ task: '', context: workflowContext([
    { id: 'n1', index: 1, type: 'web_search', label: 'Find sources' },
  ]) });
  const evaluation = evaluateWorkflowExecutionCompletion([
    { tool: 'web_search', success: true, result: { error: 'quota exceeded' } },
    { tool: 'web_search', success: false, result: { results: [] } },
  ], contract);
  assert.equal(evaluation.complete, false);
});

test('video steps delegate to the video evaluation', () => {
  const contract = inferWorkflowExecutionContract({ task: '', context: workflowContext([
    { id: 'v1', index: 1, type: 'video', label: 'Cut promo' },
  ]) });
  const unsatisfied = evaluateWorkflowExecutionCompletion([], contract, {
    videoEvaluation: { mutation: false, missing: ['timeline mutation'] },
  });
  assert.equal(unsatisfied.complete, false);
  assert.match(unsatisfied.missing[0].expected, /video deliverable/);

  const satisfied = evaluateWorkflowExecutionCompletion([], contract, {
    videoEvaluation: { mutation: true, missing: [] },
  });
  assert.equal(satisfied.complete, true);
});

test('video steps fall back to video_* tool evidence without a video evaluation', () => {
  const contract = inferWorkflowExecutionContract({ task: '', context: workflowContext([
    { id: 'v1', index: 1, type: 'video', label: 'Cut promo' },
  ]) });
  const evaluation = evaluateWorkflowExecutionCompletion([
    { tool: 'video_cut_range', success: true, result: { ok: true } },
  ], contract);
  assert.equal(evaluation.complete, true);
});

test('disabled contract always evaluates complete', () => {
  const evaluation = evaluateWorkflowExecutionCompletion([], { enabled: false });
  assert.equal(evaluation.complete, true);
});

test('continuation names missing steps and attempt number', () => {
  const text = buildWorkflowExecutionContinuation({
    evaluation: {
      missing: [{ id: 'n3', index: 4, label: 'Send report', expected: 'a successful email tool call' }],
      tools: ['web_search'],
    },
    attempt: 2,
  });
  assert.match(text, /WORKFLOW RUN INCOMPLETE, ATTEMPT 2/);
  assert.match(text, /Step 4 "Send report" — expected a successful email tool call/);
  assert.match(text, /Successful tools so far: web_search/);
});

test('rules block appends once and carries the contract markers', () => {
  const appended = appendOpenClawWorkflowExecutionRules('# Agents');
  assert.ok(appended.includes(OPENCLAW_WORKFLOW_EXECUTION_RULES));
  assert.equal(appendOpenClawWorkflowExecutionRules(appended), appended);
});
