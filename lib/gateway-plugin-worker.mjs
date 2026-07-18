import { workerData, parentPort } from 'worker_threads';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import {
  installOpenClawNpmPlugin,
  installOpenClawPlugin,
  runAllowlistedGatewayExec,
  syncGatewayPlugin,
} from './gateway-plugins.mjs';

function serializeError(error) {
 return {
  message: String(error?.message || error || 'Gateway plugin worker failed'),
  code: error?.code || null,
  stdout: String(error?.stdout || ''),
  stderr: String(error?.stderr || ''),
 };
}

try {
 const operation = String(workerData?.operation || '');
 const payload = workerData?.payload || {};
 let result;
 if (operation === 'sync') {
  result = syncGatewayPlugin({
   pluginId: payload.pluginId,
   files: payload.files,
   install: payload.install !== false,
   mkdirSync,
   writeFileSync,
   execSync,
  });
 } else if (operation === 'install') {
  result = installOpenClawPlugin({
   pluginPath: payload.pluginPath,
   pluginId: payload.pluginId,
   execSync,
  });
 } else if (operation === 'install-package') {
  result = installOpenClawNpmPlugin({
   packageName: payload.packageName,
   execSync,
  });
 } else if (operation === 'exec') {
  result = runAllowlistedGatewayExec({
   command: payload.command,
   cwd: payload.cwd,
   execSync,
  });
 } else {
  throw new Error(`Unsupported gateway plugin worker operation: ${operation}`);
 }
 parentPort?.postMessage({ ok: true, result });
} catch (error) {
 parentPort?.postMessage({ ok: false, error: serializeError(error) });
}
