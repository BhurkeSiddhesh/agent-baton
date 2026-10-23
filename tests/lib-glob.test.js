import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPath, patternsOverlap, ownedBy, isProtected, isCoordination, isOrchestratorOnly, isReadOnly } from '../src/lib/glob.js';

test('matchPath table', () => {
  const rows = [
    // pattern, path, expected
    ['src/a.js', 'src/a.js', true],
    ['src/a.js', 'src/b.js', false],
    ['src/', 'src/a.js', true],
    ['src/', 'src/deep/er/a.js', true],
    ['src/', 'src', false],
    ['src/', 'srcx/a.js', false],
    ['src/*.js', 'src/a.js', true],
    ['src/*.js', 'src/deep/a.js', false],
    ['src/**', 'src/deep/a.js', true],
    ['src/**/a.js', 'src/a.js', true],
    ['src/**/a.js', 'src/x/y/a.js', true],
    ['src/**/a.js', 'src/x/b.js', false],
    ['**/*.test.js', 'tests/x/a.test.js', true],
    ['**/*.test.js', 'a.test.js', true],
    ['a?c', 'abc', true],
    ['a?c', 'a/c', false],
    ['a?c', 'ac', false],
    ['*.pem', 'x.pem', true],
    ['*.pem', 'dir/x.pem', false],
    ['./src/a.js', 'src/a.js', true],
    ['src\\a.js', 'src/a.js', true],
    ['a.b', 'axb', false],
    ['a+b(1)', 'a+b(1)', true],
    ['', 'x', false],
  ];
  for (const [pattern, p, want] of rows) assert.equal(matchPath(pattern, p), want, `${pattern} vs ${p}`);
});

test('patternsOverlap table', () => {
  const rows = [
    ['src/a.js', 'src/a.js', true],
    ['src/a.js', 'src/b.js', false],
    ['src/', 'src/a.js', true],
    ['src/', 'src/', true],
    ['src/api/', 'src/ui/', false],
    ['src/api/', 'src/api/deep/', true],
    ['src/', 'srcx/', false],
    ['src/*.js', 'src/a.js', true],
    ['src/*.js', 'src/a.py', false],
    ['src/*.js', 'src/deep/a.js', false],
    ['src/**', 'src/deep/a.js', true],
    ['src/**/a.js', 'src/b/a.js', true],
    ['src/**/a.js', 'lib/a.js', false],
    ['**/*.test.js', 'tests/x.test.js', true],
    ['*.js', '*.py', false],
    ['a*', '*b', true],
    ['a?', 'ab', true],
    ['a?', 'abc', false],
    ['**', 'anything/at/all', true],
    ['docs/', 'src/', false],
  ];
  for (const [a, b, want] of rows) {
    assert.equal(patternsOverlap(a, b), want, `${a} ~ ${b}`);
    assert.equal(patternsOverlap(b, a), want, `${b} ~ ${a} (symmetry)`);
  }
});

test('ownedBy', () => {
  assert.equal(ownedBy('src/api/x.js', ['docs/', 'src/api/']), true);
  assert.equal(ownedBy('src/ui/x.js', ['docs/', 'src/api/']), false);
  assert.equal(ownedBy('a.js', []), false);
  assert.equal(ownedBy('a.js', undefined), false);
});

test('isProtected table', () => {
  const protectedPaths = [
    '.git/config', 'sub/.git/HEAD', '.env', '.env.local', 'app/.env.production', 'k.pem', 'a/b/k.key', 'x.p12', 'x.pfx',
    'id_rsa', 'id_rsa.pub', 'gcp-credentials.json', 'client_secret_123.json', 'token.json', 'token-cache.json', 'a.sqlite', 'a.sqlite3', 'db/app.db',
    'secrets/', 'secrets/x.txt', 'config/secrets/x.txt',
    // BAT-016: Certificates
    'server.crt', 'certs/tls.cer', 'ca.der', 'apple.p8', 'CERTS/SERVER.CRT',
    // BAT-016: SSH keys
    'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_ecdsa.pub', 'ID_ED25519',
    // BAT-016: Cloud credentials
    '.aws/credentials', 'aws/credentials', 'sub/.aws/credentials', '.aws/config',
    'gcloud/credentials.db', 'credentials.db', '.config/gcloud/credentials.db',
    'azureTokens.json', 'azure-tokens.json', '.azure/accessTokens.json', 'AZURETOKENS.JSON',
    // BAT-016: Sensitive DBs
    'analytics.duckdb', 'data/metrics.duckdb', 'ANALYTICS.DUCKDB',
    'vault.kdbx', 'passwords.kdbx', 'VAULT.KDBX',
    // BAT-016: Case normalization
    '.ENV', '.ENV.LOCAL', 'SECRETS/passwords.txt', 'K.PEM', 'ID_RSA',
  ];
  for (const p of protectedPaths) assert.equal(isProtected(p), true, p);
  const open = [
    '.env.example', 'src/env.js', '.gitignore', '.gitattributes', 'README.md', 'src/secrets.js', 'tokens.md', 'docs/key.md', 'a.dbx',
    'src/cert.js', 'docs/credentials.md', 'src/duckdb-client.js',
  ];
  for (const p of open) assert.equal(isProtected(p), false, p);
});

test('isProtected honours extra globs and case insensitivity', () => {
  assert.equal(isProtected('data/raw.csv', ['data/']), true);
  assert.equal(isProtected('DATA/RAW.CSV', ['data/']), true);
  assert.equal(isProtected('data/raw.csv', ['DATA/']), true);
  assert.equal(isProtected('x/y.secret', ['*.secret']), true);
  assert.equal(isProtected('X/Y.SECRET', ['*.secret']), true);
  assert.equal(isProtected('x/y.secret', ['*.SECRET']), true);
  assert.equal(isProtected('x/y.txt', ['*.secret']), false);
  assert.equal(isProtected('deploy/keys/prod.txt', ['deploy/keys/**']), true);
  assert.equal(isProtected('deploy/keys', ['deploy/keys/']), true);
  assert.equal(isProtected('deploy/keys/', ['deploy/keys/']), true);
});

test('isOrchestratorOnly and isReadOnly', () => {
  assert.equal(isOrchestratorOnly('.baton/config.json'), true);
  assert.equal(isOrchestratorOnly('.baton/CONFIG.json'), true);
  assert.equal(isOrchestratorOnly('AGENTS.md'), true);
  assert.equal(isOrchestratorOnly('agents.md'), true);
  assert.equal(isOrchestratorOnly('docs/GOVERNANCE.md'), true);
  assert.equal(isOrchestratorOnly('docs/governance.md'), true);
  assert.equal(isOrchestratorOnly('src/index.js'), false);
  assert.equal(isOrchestratorOnly('custom/policy.md', ['custom/policy.md']), true);
  assert.equal(isOrchestratorOnly('CUSTOM/POLICY.MD', ['custom/policy.md']), true);

  assert.equal(isReadOnly('.baton/config.json'), true);
  assert.equal(isReadOnly('AGENTS.md'), true);
  assert.equal(isReadOnly('docs/GOVERNANCE.md'), true);
  assert.equal(isReadOnly('src/index.js'), false);
  assert.equal(isReadOnly('docs/POLICY.md', ['docs/POLICY.md']), true);
  assert.equal(isReadOnly('docs/policy.md', ['docs/POLICY.md']), true);
});

test('isCoordination', () => {
  assert.equal(isCoordination('.baton/ledger/e.json'), true);
  assert.equal(isCoordination('.baton/state/lock'), true);
  assert.equal(isCoordination('.baton/views/STATUS.md'), true);
  assert.equal(isCoordination('.baton/config.json'), false);
  assert.equal(isCoordination('CHANGELOG.md', ['CHANGELOG.md']), true);
});
