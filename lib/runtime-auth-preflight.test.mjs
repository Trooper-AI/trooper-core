import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'index.mjs'), 'utf8');

test('task auth preflight accepts credentials supplied by the managed runtime environment', () => {
  assert.match(source, /_hasRuntimeCredential = _hasAuthProfileCredential \|\| hasConfiguredProviderKey\(\)/);
  assert.match(source, /if \(!_hasRuntimeCredential\)/);
  assert.match(source, /Auth profiles are unreadable; continuing with an existing runtime provider credential/);
});

test('task auth preflight still fails closed when neither profiles nor runtime keys exist', () => {
  assert.match(source, /code: 'auth_profiles_unreadable'/);
  assert.match(source, /code: 'auth_profiles_empty'/);
});
