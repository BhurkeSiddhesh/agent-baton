import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempRepo } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { stateDir, eventsDir, ledgerDir, assertSensitiveReplay, appendEvent } from '../src/lib/store.js';
import { createEventAttestation, verifyEventAttestation, signEvent } from '../src/lib/attestation.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const repos = [];
afterEach(() => { while (repos.length) repos.pop().cleanup(); delete process.env.BATON_NOW; });

async function cli(cwd, args, now) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  if (now) process.env.BATON_NOW = now;
  try {
    const status = await main(args, { cwd, env: {}, stdout, stderr });
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (now) delete process.env.BATON_NOW;
  }
}
const json = (r) => JSON.parse(r.stdout);
function repo(opts = {}) {
  const r = makeTempRepo({ git: true, config: true, plan: true, ...opts });
  repos.push(r);
  return r;
}

test('BAT-029: tampered event file refuses baton merge and reports concrete remediation', async () => {
  const r = repo();
  // Worker begins, writes, verifies, submits
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  r.write('src/api/export.js', '// export logic\n');
  r.write('tests/api/export.test.js', '// test\n');
  await cli(r.root, ['verify', 'WP-001']);
  await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);

  // Reviewer accepts
  const acc = await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  assert.equal(acc.status, 0, acc.stderr);

  // Now tamper with the verdict event on disk (alter note without updating sha)
  const evDir = eventsDir(r.root);
  const files = fs.readdirSync(evDir).filter((f) => f.endsWith('.json')).sort();
  const lastFile = path.join(evDir, files[files.length - 1]);
  const text = fs.readFileSync(lastFile, 'utf8');
  fs.writeFileSync(lastFile, text.replace('"claude"', '"impostor"'));

  // Attempting merge must fail closed
  const mergeAttempt = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(mergeAttempt.status, 1);
  assert.match(mergeAttempt.stderr, /ledger integrity check failed before merge/i);
  assert.match(mergeAttempt.stderr, /tampered, corrupted or conflicting/i);
  assert.match(mergeAttempt.stderr, /baton ledger verify/i);
});

test('BAT-029: tampered event file refuses sensitive transitions (submit and accept)', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  r.write('src/api/export.js', '// work\n');
  await cli(r.root, ['verify', 'WP-001']);

  // Tamper with the begin event
  const evDir = eventsDir(r.root);
  const files = fs.readdirSync(evDir).filter((f) => f.endsWith('.json')).sort();
  const beginFile = path.join(evDir, files[0]);
  fs.writeFileSync(beginFile, fs.readFileSync(beginFile, 'utf8').replace('"codex"', '"mallory"'));

  // submit must fail closed because packet history is corrupted
  const submitAttempt = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);
  assert.equal(submitAttempt.status, 1);
  assert.match(submitAttempt.stderr, /ledger integrity check failed before transition/i);
});

test('BAT-029: mirror disagreement fails sensitive replay until aligned', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  r.write('src/api/export.js', '// work\n');
  await cli(r.root, ['verify', 'WP-001']);
  await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);

  // Tamper with mirror copy only (valid JSON, but different hash than local copy)
  const mDir = ledgerDir(r.root);
  const mFiles = fs.readdirSync(mDir).filter((f) => f.endsWith('.json')).sort();
  const mirrorTarget = path.join(mDir, mFiles[0]);
  const ev = JSON.parse(fs.readFileSync(mirrorTarget, 'utf8'));
  ev.note = 'mirror-tampered';
  // Compute valid sha for the tampered mirror file so it's a mirror disagreement
  const { sha, ...rest } = ev;
  ev.sha = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  fs.writeFileSync(mirrorTarget, JSON.stringify(ev, null, 2));

  // Accept must fail closed on mirror disagreement
  const acc = await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  assert.equal(acc.status, 1);
  assert.match(acc.stderr, /tampered, corrupted or conflicting|local and mirror copies differ|sha mismatch/i);
});

test('BAT-029: acknowledged anomalies (ack event) allow sensitive replay', () => {
  const r = repo();
  const ev = appendEvent(r.root, { packet: 'WP-001', kind: 'status', to: 'IN_PROGRESS', by: 'codex' });

  // Tamper with file
  const f = path.join(eventsDir(r.root), `${ev.id}.json`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"codex"', '"altered"'));

  // Without ack, assertSensitiveReplay throws
  assert.throws(() => assertSensitiveReplay(r.root, { packet: 'WP-001', action: 'test' }), (e) => e.code === 'LEDGER_INTEGRITY_COMPROMISED');

  // Add ack event acknowledging the anomaly
  appendEvent(r.root, { kind: 'ack', by: 'claude', note: 'acknowledged historical test anomaly', data: { event: ev.id } });

  // With ack, assertSensitiveReplay succeeds
  assert.deepEqual(assertSensitiveReplay(r.root, { packet: 'WP-001', action: 'test' }), { ok: true });
});

test('BAT-029: cryptographic attestation sign and verify', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const ev = {
    id: '20261023T120000Z-000001',
    ts: '2026-10-23T12:00:00Z',
    packet: 'WP-001',
    kind: 'verdict',
    to: 'ACCEPTED',
    by: 'claude',
    note: 'looks good',
    data: { commit: 'abc1234' },
    hv: 1,
  };

  // Sign event
  signEvent(ev, privPem, { keyId: 'key-1' });
  assert.ok(ev.sig);
  assert.equal(ev.sig.key, 'key-1');
  assert.ok(typeof ev.sig.sig === 'string');

  // Verify valid signature
  const v = verifyEventAttestation(ev, pubPem);
  assert.equal(v.valid, true);

  // Tamper with payload
  const tampered = { ...ev, note: 'altered verdict' };
  const vBad = verifyEventAttestation(tampered, pubPem);
  assert.equal(vBad.valid, false);

  // Verification with wrong key fails
  const otherKeys = crypto.generateKeyPairSync('ed25519');
  const otherPubPem = otherKeys.publicKey.export({ type: 'spki', format: 'pem' });
  const vWrongKey = verifyEventAttestation(ev, otherPubPem);
  assert.equal(vWrongKey.valid, false);
});

test('BAT-029: optional requireAttestation config enforces signatures during sensitive replay and check', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const r = repo();
  // Configure requireAttestation
  const cfgPath = path.join(r.root, '.baton', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.security = {
    requireAttestation: true,
    keys: {
      'key-1': pubPem,
    },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  // Append unsigned verdict event
  const unsignedVerdict = appendEvent(r.root, {
    packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude', data: { commit: 'c123456' },
  });

  // check command flags missing attestation
  const chk = await cli(r.root, ['check', '--json']);
  const chkJson = json(chk);
  assert.equal(chkJson.ok, false);
  assert.ok(chkJson.errors.some((e) => e.area === 'attestation' && /missing required cryptographic attestation/.test(e.message)));

  // assertSensitiveReplay throws ATTESTATION_MISSING
  assert.throws(
    () => assertSensitiveReplay(r.root, { packet: 'WP-001', action: 'merge', config: cfg }),
    (e) => e.code === 'ATTESTATION_MISSING'
  );

  // Sign the verdict event file on disk
  const vFile = path.join(eventsDir(r.root), `${unsignedVerdict.id}.json`);
  const rawEv = JSON.parse(fs.readFileSync(vFile, 'utf8'));
  signEvent(rawEv, privPem, { keyId: 'key-1' });
  fs.writeFileSync(vFile, JSON.stringify(rawEv, null, 2));
  fs.writeFileSync(path.join(ledgerDir(r.root), `${unsignedVerdict.id}.json`), JSON.stringify(rawEv, null, 2));

  // Now assertSensitiveReplay passes!
  assert.deepEqual(assertSensitiveReplay(r.root, { packet: 'WP-001', action: 'merge', config: cfg }), { ok: true });
});
