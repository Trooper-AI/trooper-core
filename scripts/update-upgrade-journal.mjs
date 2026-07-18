#!/usr/bin/env node
import { patchRuntimeUpgradeState } from '../lib/runtime-upgrade-journal.mjs';

const [status, phase = status, error = ''] = process.argv.slice(2);
if (!status) {
  console.error('usage: update-upgrade-journal.mjs <status> [phase] [error]');
  process.exit(2);
}

patchRuntimeUpgradeState({
  status,
  phase,
  error: error || null,
  completedAt: ['completed', 'rolled_back', 'rollback_failed', 'failed'].includes(status)
    ? new Date().toISOString()
    : null,
});
