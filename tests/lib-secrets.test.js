import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, scanFiles, scanHistory, SECRET_PATTERNS, formatSecretHit } from '../src/lib/secrets.js';
import { makeTempRepo } from './helpers.js';

// Fixtures are assembled at runtime so this file never contains a literal that looks like a secret.
const j = (...p) => p.join('');
const FIXTURES = {
  'aws-access-key': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'private-key': j('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'google-oauth-token': j('ya', '29.', 'a'.repeat(30)),
  'google-refresh-token': j('1/', '/', 'b'.repeat(40)),
  'google-client-secret': j('GOC', 'SPX-', 'c'.repeat(20)),
  'github-token': j('gh', 'p_', 'd'.repeat(36)),
  'slack-token': j('xo', 'xb-', '1234567890-abcdef'),
  'openai-anthropic-key': j('sk', '-', 'e1'.repeat(15)),
  'google-api-key': j('AI', 'za', 'aB3'.repeat(12)),
  'github-fine-grained-token': j('github_', 'pat_', 'A1'.repeat(15)),
  'stripe-key': j('sk_', 'live_', 'a1'.repeat(10)),
  'npm-token': j('npm', '_', 'a1'.repeat(18)),
  'url-credentials': j('postgres:', '//admin:', 'Sup3rSecret', '@db.example/x'),
  'aws-secret-key': j('aws_secret_', 'access_key = ', 'wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  'bearer-header': j('Authorization: Bea', 'rer ', 'a1'.repeat(20)),
  jwt: j('ey', 'JhbGciOiJI', '.', 'ey', 'JzdWIiOiIx', '.', 'abcdefgh1234'),
  'env-assignment': j('MY_API_', 'KEY=', 'abcdef0123456789abcdef'),
  'yaml-secret': j('pass', 'word: ', 'hunter2hunter2hunter2'),
  'token-assignment': j('access_', 'token = "', 'f'.repeat(30), '"'),
  'secret-assignment': j('client_', 'secret: "', 'g'.repeat(20), '"'),
};

test('every pattern has a fixture and is detected exactly once on its line', () => {
  assert.deepEqual(Object.keys(FIXTURES).sort(), SECRET_PATTERNS.map((p) => p.id).sort());
  for (const [id, text] of Object.entries(FIXTURES)) {
    const hits = scanText('f.txt', `harmless\n${text}\n`);
    assert.ok(hits.some((h) => h.pattern === id && h.line === 2), `${id} not detected`);
  }
});

test('clean text yields no hits', () => {
  const text = ['const a = 1;', 'token: "short"', '// sk-short', 'password = getPassword()', 'const x = process.env.API_KEY;'].join('\n');
  assert.deepEqual(scanText('ok.js', text), []);
});

test('allow marker suppresses a line', () => {
  const line = `${FIXTURES['aws-access-key']} // baton:allow-secret example from docs`;
  assert.deepEqual(scanText('d.md', line), []);
  assert.equal(scanText('d.md', `${FIXTURES['aws-access-key']}\n${line}`).length, 1);
});

test('hits never contain the secret text', () => {
  const [hit] = scanText('f', FIXTURES['github-token']);
  assert.ok(!JSON.stringify(hit).includes('ddddd'));
  assert.match(formatSecretHit(hit), /f:1: matches secret pattern github-token/);
});

test('scanFiles: CRLF, utf-16 with BOM, missing files, directories', () => {
  const repo = makeTempRepo({ files: { 'a.txt': `x\r\n${FIXTURES['aws-access-key']}\r\n`, 'sub/keep.txt': 'fine' } });
  try {
    fs.writeFileSync(path.join(repo.root, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(FIXTURES['github-token'], 'utf16le')]));
    const hits = scanFiles(repo.root, ['a.txt', 'u16.txt', 'sub/keep.txt', 'missing.txt', 'sub']);
    assert.deepEqual(hits.map((h) => `${h.label}:${h.line}:${h.pattern}`).sort(), ['a.txt:2:aws-access-key', 'u16.txt:1:github-token']);
  } finally { repo.cleanup(); }
});

test('scanHistory finds secrets added then removed in later commits', () => {
  const repo = makeTempRepo({ git: true, files: { 'a.txt': 'one\n' } });
  try {
    const base = repo.git('rev-parse', 'HEAD');
    repo.write('a.txt', `one\n${FIXTURES['openai-anthropic-key']}\n`);
    repo.commitAll('add');
    repo.write('a.txt', 'one\n');
    repo.commitAll('remove');
    const hits = scanHistory(repo.root, base);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].pattern, 'openai-anthropic-key');
    assert.deepEqual(scanHistory(repo.root, repo.git('rev-parse', 'HEAD')), []);
    assert.deepEqual(scanHistory(repo.root, null), []);
  } finally { repo.cleanup(); }
});

test('sk- matching ignores plain words; the allow marker only counts as a trailing comment', () => {
  assert.deepEqual(scanText('a.md', ['import sk-learn-something-long-name-here', 'commit sk-the-quick-brown-fox-jumps-over'].join('\n')), []);
  const key = FIXTURES['aws-access-key'];
  assert.equal(scanText('a.js', 'const m = "// baton:allow-secret"; const k = "' + key + '";').length, 1);
});
