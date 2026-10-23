import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, scanFiles, scanHistory, scanLedgerAndLogs, redactSecrets, SECRET_PATTERNS, formatSecretHit, MAX_SCAN_BYTES } from '../src/lib/secrets.js';
import { makeTempRepo } from './helpers.js';

// Fixtures are assembled at runtime so this file never contains a literal that looks like a secret.
const j = (...p) => p.join('');
const FIXTURES = {
  'aws-access-key': j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  'aws-secret-key': j('aws_secret_', 'access_key = ', 'wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  'aws-session-token': j('aws_session_', 'token = "', 'AQoDYXdzEJr'.repeat(6), '"'),
  'private-key': j('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'google-oauth-token': j('ya', '29.', 'a'.repeat(30)),
  'google-refresh-token': j('1/', '/', 'b'.repeat(40)),
  'google-client-secret': j('GOC', 'SPX-', 'c'.repeat(20)),
  'github-token': j('gh', 'p_', 'd'.repeat(36)),
  'github-fine-grained-token': j('github_', 'pat_', 'A1'.repeat(15)),
  'gitlab-token': j('gl', 'pat-', 'aB3_'.repeat(5)),
  'slack-token': j('xo', 'xb-', '1234567890-abcdef'),
  'anthropic-key': j('sk-', 'ant-api03-', 'aB3_'.repeat(8)),
  'openai-project-key': j('sk-', 'proj-', 'aB3_'.repeat(8)),
  'openai-anthropic-key': j('sk', '-', 'e1'.repeat(15)),
  'google-ai-key': j('AI', 'zaSy', 'aB3_'.repeat(8), 'x'),
  'google-api-key': j('AI', 'za', 'aB3'.repeat(12)),
  'azure-storage-key': j('Account', 'Key=', 'a1+/='.repeat(15)),
  'stripe-restricted-key': j('rk_', 'live_', 'a1'.repeat(12)),
  'stripe-key': j('sk_', 'live_', 'a1'.repeat(10)),
  'npm-token': j('npm', '_', 'a1'.repeat(18)),
  'url-credentials': j('postgres:', '//admin:', 'Sup3rSecret', '@db.example/x'),
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

test('redactSecrets replaces secret patterns without leaking secret values', () => {
  for (const [id, text] of Object.entries(FIXTURES)) {
    const sample = id === 'env-assignment' || id === 'yaml-secret' ? `\n${text}\n` : `prefix ${text} suffix`;
    const redacted = redactSecrets(sample);
    assert.ok(redacted.includes(`[REDACTED:${id}]`), `expected [REDACTED:${id}] in redacted output for ${id}`);
    assert.ok(!redacted.includes(text), `secret value for ${id} leaked in redacted text`);
  }

  // Multiline string with multiple secrets
  const multi = [
    `export TOKEN=${FIXTURES['gitlab-token']}`,
    `Anthropic: ${FIXTURES['anthropic-key']}`,
    'Harmless line',
    `AWS: ${FIXTURES['aws-access-key']}`,
  ].join('\n');
  const redactedMulti = redactSecrets(multi);
  assert.ok(redactedMulti.includes('[REDACTED:gitlab-token]'));
  assert.ok(redactedMulti.includes('[REDACTED:anthropic-key]'));
  assert.ok(redactedMulti.includes('[REDACTED:aws-access-key]'));
  assert.ok(redactedMulti.includes('Harmless line'));
});

test('scanFiles: CRLF, utf-16 with BOM, missing files, directories', () => {
  const repo = makeTempRepo({ files: { 'a.txt': `x\r\n${FIXTURES['aws-access-key']}\r\n`, 'sub/keep.txt': 'fine' } });
  try {
    fs.writeFileSync(path.join(repo.root, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(FIXTURES['github-token'], 'utf16le')]));
    const hits = scanFiles(repo.root, ['a.txt', 'u16.txt', 'sub/keep.txt', 'missing.txt', 'sub']);
    assert.deepEqual(hits.map((h) => `${h.label}:${h.line}:${h.pattern}`).sort(), ['a.txt:2:aws-access-key', 'u16.txt:1:github-token']);
  } finally { repo.cleanup(); }
});

test('scanFiles handles oversized files (> 2MB) with oversized-skipped diagnostic', () => {
  const repo = makeTempRepo({ files: { 'small.txt': `${FIXTURES['aws-access-key']}\n` } });
  try {
    const bigFile = path.join(repo.root, 'big.bin');
    const fd = fs.openSync(bigFile, 'w');
    fs.writeSync(fd, Buffer.from(`harmless\n${FIXTURES['gitlab-token']}\n`));
    fs.ftruncateSync(fd, MAX_SCAN_BYTES + 1);
    fs.closeSync(fd);

    const hits = scanFiles(repo.root, ['small.txt', 'big.bin']);
    assert.deepEqual(hits, [
      { label: 'small.txt', line: 1, pattern: 'aws-access-key' },
      { label: 'big.bin', line: 0, pattern: 'oversized-skipped' },
    ]);
    assert.equal(formatSecretHit(hits[1]), 'big.bin: oversized-skipped');
  } finally { repo.cleanup(); }
});

test('scanFiles handles binary files with NUL bytes gracefully', () => {
  const repo = makeTempRepo({ files: { 'clean.bin': Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x04]) } });
  try {
    // Clean binary file with NUL bytes yields no hits and does not error
    const cleanHits = scanFiles(repo.root, ['clean.bin']);
    assert.deepEqual(cleanHits, []);

    // Binary file with NUL bytes and an embedded credential
    const secretBuf = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00]),
      Buffer.from(`\n${FIXTURES['aws-access-key']}\n`),
      Buffer.from([0x00, 0x02, 0x00]),
    ]);
    fs.writeFileSync(path.join(repo.root, 'secret.bin'), secretBuf);
    const secretHits = scanFiles(repo.root, ['secret.bin']);
    assert.ok(secretHits.some((h) => h.pattern === 'aws-access-key'));
  } finally { repo.cleanup(); }
});

test('scanLedgerAndLogs scans ledger event files and messages', () => {
  const repo = makeTempRepo({
    files: {
      '.baton/ledger/event-1.json': JSON.stringify({ id: 'EV-001', data: { key: FIXTURES['gitlab-token'] } }),
      '.baton/logs/test.log': `Session started\nAuthorization: ${FIXTURES['bearer-header']}\n`,
    },
  });
  try {
    const hits = scanLedgerAndLogs(repo.root);
    assert.ok(hits.some((h) => h.pattern === 'gitlab-token' && h.label === '.baton/ledger/event-1.json'));
    assert.ok(hits.some((h) => h.pattern === 'bearer-header' && h.label === '.baton/logs/test.log'));
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
