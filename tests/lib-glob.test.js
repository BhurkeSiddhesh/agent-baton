import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPath, patternsOverlap, ownedBy, isProtected, isCoordination } from '../src/lib/glob.js';

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
  const protectedPaths = ['.git/config', 'sub/.git/HEAD', '.env', '.env.local', 'app/.env.production', 'k.pem', 'a/b/k.key', 'x.p12', 'x.pfx',
    'id_rsa', 'id_rsa.pub', 'gcp-credentials.json', 'client_secret_123.json', 'token.json', 'token-cache.json', 'a.sqlite', 'a.sqlite3', 'db/app.db',
    'secrets/', 'secrets/x.txt', 'config/secrets/x.txt'];
  for (const p of protectedPaths) assert.equal(isProtected(p), true, p);
  const open = ['.env.example', 'src/env.js', '.gitignore', '.gitattributes', 'README.md', 'src/secrets.js', 'tokens.md', 'docs/key.md', 'a.dbx'];
  for (const p of open) assert.equal(isProtected(p), false, p);
});

test('isProtected honours extra globs', () => {
  assert.equal(isProtected('data/raw.csv', ['data/']), true);
  assert.equal(isProtected('x/y.secret', ['*.secret']), true);
  assert.equal(isProtected('x/y.txt', ['*.secret']), false);
});

test('isCoordination', () => {
  assert.equal(isCoordination('.baton/ledger/e.json'), true);
  assert.equal(isCoordination('.baton/state/lock'), true);
  assert.equal(isCoordination('.baton/views/STATUS.md'), true);
  assert.equal(isCoordination('.baton/config.json'), false);
  assert.equal(isCoordination('CHANGELOG.md', ['CHANGELOG.md']), true);
});
