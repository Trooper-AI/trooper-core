import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';

export const DEFAULT_RUNTIME_UPGRADE_STATE_PATH = '/opt/openclaw-data/runtime-upgrade-state.json';

export function runtimeUpgradeStatePath(env = process.env) {
  return env.TROOPER_UPGRADE_STATE_PATH
    || (existsSync('/opt/openclaw-data')
      ? DEFAULT_RUNTIME_UPGRADE_STATE_PATH
      : path.resolve('data/runtime-upgrade-state.json'));
}

export function readRuntimeUpgradeState(statePath = runtimeUpgradeStatePath()) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRuntimeUpgradeState(nextState, statePath = runtimeUpgradeStatePath()) {
  const directory = path.dirname(statePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  const state = {
    ...nextState,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
  return state;
}

export function patchRuntimeUpgradeState(patch, statePath = runtimeUpgradeStatePath()) {
  const current = readRuntimeUpgradeState(statePath) || {};
  return writeRuntimeUpgradeState({ ...current, ...patch }, statePath);
}

export function beginRuntimeUpgradeState({ operationId, scope, target }, statePath = runtimeUpgradeStatePath()) {
  return writeRuntimeUpgradeState({
    operationId,
    scope,
    target,
    status: 'staging',
    phase: 'preflight',
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    rollbackError: null,
    verifier: null,
  }, statePath);
}

export function isRuntimeUpgradeActive(state) {
  return ['staging', 'restart_scheduled', 'restarting', 'verifying', 'rolling_back'].includes(state?.status);
}
