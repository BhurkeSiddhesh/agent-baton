import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED, validatePackage } from '../.github/scripts/validate-package.mjs';

const pkg = { license: 'MIT', bin: { baton: 'bin/baton.js' }, dependencies: {} };
const entry = (extra = [], remove = []) => ({
  files: [...REQUIRED.filter((f) => !remove.includes(f)), ...extra].map((path) => ({ path })),
});

test('packed release has all required files and no runtime dependencies', () => {
  assert.deepEqual(validatePackage(entry(), pkg), []);
  assert.ok(validatePackage(entry([], ['LICENSE']), pkg).some((s) => s.includes('LICENSE')));
  assert.ok(validatePackage(null, pkg).length);
  assert.ok(validatePackage(entry(), { ...pkg, dependencies: { unsafe: '*' } }).some((s) => s.includes('runtime dependencies')));
});

test('pack validation rejects credentials, internal metadata and leaked state', () => {
  for (const bad of ['.npmrc', 'private/id_rsa', 'foo/.env.prod', '.git/config', '.baton/ledger/a.json', '.github/workflows/ci.yml', 'node_modules/x.js', 'keys/prod.pem']) {
    assert.ok(validatePackage(entry([bad]), pkg).some((s) => s.includes(bad)), bad);
  }
});
