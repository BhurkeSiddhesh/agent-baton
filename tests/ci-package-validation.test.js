import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED, validatePackage } from '../.github/scripts/validate-package.mjs';

const pkg = { license: 'MIT', bin: { baton: 'bin/baton.js', 'agent-baton': 'bin/baton.js' }, dependencies: {} };
const entry = (extra = [], remove = []) => ({
  files: [...REQUIRED.filter((f) => !remove.includes(f)), ...extra].map((path) => ({ path })),
});

test('packed release has all required files and no runtime dependencies', () => {
  assert.deepEqual(validatePackage(entry(), pkg), []);
  assert.ok(validatePackage(entry([], ['LICENSE']), pkg).some((s) => s.includes('LICENSE')));
  assert.ok(validatePackage(null, pkg).length);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(validatePackage(entry(), { ...pkg, [field]: { unsafe: '*' } }).some((s) => s.includes(field)), field);
  }
  for (const binary of ['baton', 'agent-baton']) {
    assert.ok(validatePackage(entry(), { ...pkg, bin: { ...pkg.bin, [binary]: 'wrong.js' } }).some((s) => s.includes(binary)), binary);
  }
});

test('pack validation rejects credentials, internal metadata and leaked state', () => {
  for (const bad of ['docs/.envrc', '.npmrc', 'private/id_rsa', 'foo/.env.prod', '.git/config', '.baton/ledger/a.json', '.github/workflows/ci.yml', 'node_modules/x.js', 'keys/prod.pem']) {
    assert.ok(validatePackage(entry([bad]), pkg).some((s) => s.includes(bad)), bad);
  }
});

test('optional services never inflate the offline core tarball', () => {
  for (const path of ['dashboard/app.js','daemon/runner.js','mcp-server/index.js','containers/Dockerfile','optional-services/worker.js']) {
    assert.ok(validatePackage(entry([path]), pkg).some(p => p.includes(path)), path);
  }
  assert.deepEqual(validatePackage(entry(['docs/MCP.md']), pkg), []);
});
