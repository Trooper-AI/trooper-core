import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRON_JOB_PATCHABLE_FIELDS,
  normalizeCronJobInput,
  upsertCronJob,
  applyCronJobPatch,
} from './cron-jobs-store.mjs';

const input = (overrides = {}) => ({
  name: 'Daily digest',
  schedule: '0 9 * * *',
  message: 'Send the digest',
  ...overrides,
});

test('normalize requires name, schedule, and message', () => {
  assert.equal(normalizeCronJobInput({}).ok, false);
  assert.equal(normalizeCronJobInput(input({ name: ' ' })).ok, false);
  assert.equal(normalizeCronJobInput(input()).ok, true);
});

test('normalize applies safe defaults and never writes announce-without-channel', () => {
  const { job } = normalizeCronJobInput(input({ delivery: { mode: 'announce' } }));
  assert.deepEqual(job.delivery, { mode: 'none' });
  assert.equal(job.sessionTarget, 'isolated');
  assert.equal(job.wakeMode, 'now');
  assert.equal(job.enabled, true);
  const announced = normalizeCronJobInput(input({ delivery: { mode: 'announce', channel: 'general' } }));
  assert.deepEqual(announced.job.delivery, { mode: 'announce', channel: 'general' });
});

test('upsert creates a job with the supplied id and timestamps', () => {
  const result = upsertCronJob({ jobs: [] }, input(), { id: 'trooper-abc', now: () => 1000 });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.job.id, 'trooper-abc');
  assert.equal(result.job.createdAtMs, 1000);
  assert.equal(result.store.jobs.length, 1);
});

test('upsert is idempotent by id and preserves unknown fields on the existing job', () => {
  const store = { version: 3, jobs: [{ id: 'trooper-abc', name: 'Old', schedule: '* * * * *', message: 'old', gatewayOwned: { secret: true }, enabled: false }] };
  const result = upsertCronJob(store, input(), { id: 'trooper-abc', now: () => 2000 });
  assert.equal(result.created, false);
  assert.equal(result.store.jobs.length, 1);
  assert.equal(result.job.name, 'Daily digest');
  assert.deepEqual(result.job.gatewayOwned, { secret: true });
  assert.equal(result.store.version, 3);
  assert.equal(result.job.enabled, true);
});

test('upsert does not mutate its input document', () => {
  const store = { jobs: [] };
  upsertCronJob(store, input(), { id: 'trooper-abc' });
  assert.equal(store.jobs.length, 0);
});

test('patch touches only whitelisted fields and preserves the rest', () => {
  const store = {
    jobs: [{ id: 'j1', name: 'A', schedule: '* * * * *', message: 'm', gatewayOwned: 'keep', lastRunAtMs: 5 }],
  };
  const result = applyCronJobPatch(store, 'j1', {
    name: 'B',
    enabled: false,
    lastRunAtMs: 999,
    gatewayOwned: 'clobber',
    id: 'evil-rename',
  }, { now: () => 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.job.name, 'B');
  assert.equal(result.job.enabled, false);
  assert.equal(result.job.gatewayOwned, 'keep');
  assert.equal(result.job.lastRunAtMs, 5);
  assert.equal(result.job.id, 'j1');
  assert.equal(result.job.updatedAtMs, 3000);
  assert.equal(CRON_JOB_PATCHABLE_FIELDS.includes('lastRunAtMs'), false);
});

test('patch of a missing job reports not_found', () => {
  const result = applyCronJobPatch({ jobs: [] }, 'nope', { name: 'X' });
  assert.deepEqual(result, { ok: false, error: 'not_found' });
});

test('patch demotes announce-without-channel like the reader side does', () => {
  const store = { jobs: [{ id: 'j1', name: 'A', schedule: '* * * * *', message: 'm', delivery: { mode: 'announce', channel: 'general' } }] };
  const result = applyCronJobPatch(store, 'j1', { delivery: { mode: 'announce' } });
  assert.deepEqual(result.job.delivery, { mode: 'none' });
});
