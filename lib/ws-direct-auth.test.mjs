import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const wsSource = readFileSync(join(process.cwd(), 'lib', 'ws-server.mjs'), 'utf8');
const authSource = readFileSync(join(process.cwd(), 'lib', 'firebase-auth.mjs'), 'utf8');
const indexSource = readFileSync(join(process.cwd(), 'index.mjs'), 'utf8');

test('WS identify: anonymous fallthrough is closed when a bridge token exists', () => {
  // Secured deployments require Firebase verification for non-bridge clients…
  assert.match(wsSource, /if \(!client\.authenticated && \(isAuthEnabled\(\) \|\| this\.bridgeAuthToken\)\)/);
  // …and reject outright when Firebase is not configured instead of accepting anonymous.
  assert.match(wsSource, /Firebase auth not configured/);
  assert.match(wsSource, /ws\.close\(4003/);
  // The 'none' mode only survives with neither credential configured.
  assert.match(wsSource, /Genuine dev mode — neither a bridge token nor Firebase configured/);
});

test('WS identify: verified identities must also be org members (4004)', () => {
  assert.match(wsSource, /this\.memberCheck && !this\.memberCheck\(user\.uid\)/);
  assert.match(wsSource, /ws\.close\(4004, 'not_a_member'\)/);
});

test('REST /api auth enforces membership for Firebase identities', () => {
  assert.match(authSource, /memberCheck = null/);
  assert.match(authSource, /memberCheck\(user\.uid\)\) \{\s*return res\.status\(403\)\.json\(\{ error: 'not_a_member'/);
  assert.match(indexSource, /firebaseRestAuth\(BRIDGE_AUTH_TOKEN, getApiKeys, \(uid\) => isOrgMember\(uid\)\)/);
});

test('bridge wires membership + env overrides before Firebase init', () => {
  assert.match(indexSource, /loadRuntimeEnvOverridesAtBoot\(\);/);
  assert.match(indexSource, /memberCheck: \(uid\) => isOrgMember\(uid\)/);
  // Overrides load before initFirebaseAuth so a pushed FIREBASE_PROJECT_ID works at boot
  const overridesIdx = indexSource.indexOf('loadRuntimeEnvOverridesAtBoot()');
  const initIdx = indexSource.indexOf('initFirebaseAuth()');
  assert.ok(overridesIdx > 0 && overridesIdx < initIdx);
});

test('control-plane push endpoints stay behind the bridge token', () => {
  assert.match(indexSource, /app\.post\('\/org\/members', \(req, res\) => \{\s*if \(!requireBridgeAuth\(req, res\)\) return;/);
  assert.match(indexSource, /app\.post\('\/config\/runtime-env', \(req, res\) => \{\s*if \(!requireBridgeAuth\(req, res\)\) return;/);
  // Applying FIREBASE_PROJECT_ID re-initializes Firebase without a restart
  assert.match(indexSource, /result\.applied\.includes\('FIREBASE_PROJECT_ID'\)/);
});

test('provisioning ships FIREBASE_PROJECT_ID to the bridge service', () => {
  const setupSource = readFileSync(join(process.cwd(), 'setup-openclaw-full.sh'), 'utf8');
  assert.match(setupSource, /FIREBASE_PROJECT_ID="\$\(_resolve_input/);
  assert.match(setupSource, /Environment=FIREBASE_PROJECT_ID=\$\{FIREBASE_PROJECT_ID\}/);
});
