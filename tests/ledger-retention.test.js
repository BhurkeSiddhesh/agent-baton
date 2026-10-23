import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  archiveLedger,
  restoreLedger,
  appendEvent,
  readEvents,
  verifyLedger,
  eventsDir,
  ledgerDir,
  archivesDir,
  eventSha,
  analyzeRetention,
} from '../src/lib/store.js';
import { canonicalJson, sha256 } from '../src/lib/util.js';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';

async function runCli(cwd, args, { env = {} } = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await main(args, { cwd, env, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

test('BAT-031: archiving sealed historical events produces verifiable archives', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    // Record historical sequence for WP-001 leading to ACCEPTED
    const e1 = appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', note: 'start export' });
    const e2 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verify', by: 'codex', data: { ok: true, commit: 'c1' }, note: 'verified' });
    const e3 = appendEvent(repo.root, { packet: 'WP-001', kind: 'ready', to: 'READY_FOR_REVIEW', by: 'codex', data: { commit: 'c1' } });
    const e4 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude', data: { score: 5 }, note: 'lgtm' });

    // 1. Dry run archival
    const dryRes = archiveLedger(repo.root, { dryRun: true });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.counts.archived, 4);
    assert.deepEqual(dryRes.archived, [e1.id, e2.id, e3.id, e4.id]);
    assert.equal(fs.existsSync(dryRes.archiveFile || ''), false);

    // 2. Real archival to canonical JSON
    const res = archiveLedger(repo.root, { dryRun: false });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, false);
    assert.equal(res.counts.archived, 4);
    assert.ok(fs.existsSync(res.archiveFile));

    const archiveContent = JSON.parse(fs.readFileSync(res.archiveFile, 'utf8'));
    assert.equal(archiveContent.format, 'baton-ledger-archive');
    assert.equal(archiveContent.version, 1);
    assert.equal(archiveContent.counts.events, 4);
    assert.equal(archiveContent.checksum, res.checksum);
    assert.equal(archiveContent.checksum, sha256(canonicalJson(archiveContent.events)));

    // Verify all archived events have valid SHAs and match originals
    for (const ev of archiveContent.events) {
      assert.equal(eventSha(ev), ev.sha);
    }
    assert.deepEqual(archiveContent.events.map((e) => e.id), [e1.id, e2.id, e3.id, e4.id]);

    // 3. Compressed archival (.json.gz)
    const gzOut = path.join(repo.root, 'archive-test.json.gz');
    const gzRes = archiveLedger(repo.root, { out: gzOut, dryRun: false });
    assert.equal(gzRes.ok, true);
    assert.ok(fs.existsSync(gzOut));
    const decompressed = JSON.parse(zlib.gunzipSync(fs.readFileSync(gzOut)).toString('utf8'));
    assert.equal(decompressed.format, 'baton-ledger-archive');
    assert.equal(decompressed.checksum, res.checksum);
  } finally {
    repo.cleanup();
  }
});

test('BAT-031: active packets, live claims, and open findings are protected from archival/pruning', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    // 1. Sealed packet WP-001 (ACCEPTED)
    const e1 = appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex' });
    const e2 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude' });

    // 2. Active packet WP-002 (IN_PROGRESS, active claim with unexpired lease)
    const e3 = appendEvent(repo.root, {
      packet: 'WP-002',
      kind: 'begin',
      to: 'IN_PROGRESS',
      by: 'codex',
      data: { lease_until: '2099-01-01T00:00:00Z', lease_token: 1 },
    });
    const e3msg = appendEvent(repo.root, {
      packet: 'WP-002',
      kind: 'message',
      by: 'codex',
      data: { to: 'all', type: 'CLAIM', text: 'WP-002 active claim' },
    });

    // 3. Blocked packet WP-003 (BLOCKED)
    const e4 = appendEvent(repo.root, { packet: 'WP-003', kind: 'status', to: 'BLOCKED', by: 'gemini', note: 'waiting on api' });

    // 4. Accepted packet WP-004, but with an open BLOCKER finding
    const e5 = appendEvent(repo.root, { packet: 'WP-004', kind: 'begin', to: 'IN_PROGRESS', by: 'codex' });
    const e6 = appendEvent(repo.root, { packet: 'WP-004', kind: 'verdict', to: 'ACCEPTED', by: 'claude' });
    const f1 = appendEvent(repo.root, {
      packet: 'WP-004',
      kind: 'finding',
      by: 'claude',
      data: { fid: 'AUD-001', severity: 'BLOCKER', text: 'Security leak in rollout' },
    });

    const analysis = analyzeRetention(repo.root, readEvents(repo.root));
    assert.ok(analysis.activePackets.has('WP-002'));
    assert.ok(analysis.activePackets.has('WP-003'));
    assert.ok(analysis.activePackets.has('WP-004')); // protected due to open finding
    assert.ok(!analysis.activePackets.has('WP-001'));

    // Check protected event IDs
    assert.ok(analysis.protectedEventIds.has(e3.id));
    assert.ok(analysis.protectedEventIds.has(e3msg.id));
    assert.ok(analysis.protectedEventIds.has(e4.id));
    assert.ok(analysis.protectedEventIds.has(e5.id));
    assert.ok(analysis.protectedEventIds.has(e6.id));
    assert.ok(analysis.protectedEventIds.has(f1.id));
    assert.ok(!analysis.protectedEventIds.has(e1.id));
    assert.ok(!analysis.protectedEventIds.has(e2.id));

    // Attempting to archive: WP-002, WP-003, and WP-004 live records are safely skipped
    const archiveRes = archiveLedger(repo.root, { dryRun: false });
    assert.equal(archiveRes.ok, true);
    assert.deepEqual(archiveRes.archived, [e1.id, e2.id]);
    assert.ok(archiveRes.counts.protected >= 6);

    // Prune without --confirm must fail
    assert.throws(
      () => archiveLedger(repo.root, { prune: true, confirm: false }),
      (err) => err.code === 'PRUNE_CONFIRMATION_REQUIRED'
    );

    // Now resolve and confirm closed the finding on WP-004
    const f1Resolved = appendEvent(repo.root, {
      packet: 'WP-004',
      kind: 'finding_resolved',
      by: 'codex',
      data: { fid: 'AUD-001', resolution: 'fixed', confirm: false },
    });
    const f1Closed = appendEvent(repo.root, {
      packet: 'WP-004',
      kind: 'finding_resolved',
      by: 'claude',
      data: { fid: 'AUD-001', resolution: 'fixed', confirm: true },
    });

    // WP-004 is now eligible for archival because finding AUD-001 is closed
    const analysis2 = analyzeRetention(repo.root, readEvents(repo.root));
    assert.ok(!analysis2.activePackets.has('WP-004'));
    assert.ok(analysis2.candidateEvents.some((e) => e.packet === 'WP-004'));
  } finally {
    repo.cleanup();
  }
});

test('BAT-031: pruning preserves causal DAG invariants and leaves active ledger verified', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    // WP-001 is ACCEPTED
    const e1 = appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex' });
    const e2 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude' });

    // WP-002 is IN_PROGRESS and causally depends on e2
    const e3 = appendEvent(repo.root, { packet: 'WP-002', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', parents: [e2.id] });

    // When we archive WP-001:
    // e1 and e2 are archived in the bundle.
    // BUT e2 is an ancestor of active retained event e3!
    // So e2 CANNOT be pruned from the active ledger, preventing broken parent links.
    const archiveRes = archiveLedger(repo.root, { prune: true, confirm: true, dryRun: false });
    assert.equal(archiveRes.ok, true);
    assert.ok(archiveRes.archived.includes(e1.id));
    assert.ok(archiveRes.archived.includes(e2.id));

    // e2 was not pruned because retained e3 depends on it
    assert.equal(fs.existsSync(path.join(eventsDir(repo.root), `${e2.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(eventsDir(repo.root), `${e3.id}.json`)), true);

    // Active ledger remains completely valid
    const problems = verifyLedger(repo.root);
    assert.equal(problems.filter((p) => p.severity === 'error').length, 0);
  } finally {
    repo.cleanup();
  }
});

test('BAT-031: restoring an archive recovers historical state byte-for-byte', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    const e1 = appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', note: 'b1' });
    const e2 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude', note: 'v1' });

    const originalE1Json = fs.readFileSync(path.join(eventsDir(repo.root), `${e1.id}.json`), 'utf8');
    const originalE2Json = fs.readFileSync(path.join(eventsDir(repo.root), `${e2.id}.json`), 'utf8');

    const archivePath = path.join(repo.root, 'archive-full.json');
    const arch = archiveLedger(repo.root, { out: archivePath, prune: true, confirm: true });
    assert.equal(arch.counts.archived, 2);
    assert.equal(arch.counts.pruned, 2);

    // Verify events were pruned from active store
    assert.equal(fs.existsSync(path.join(eventsDir(repo.root), `${e1.id}.json`)), false);
    assert.equal(fs.existsSync(path.join(eventsDir(repo.root), `${e2.id}.json`)), false);
    assert.equal(readEvents(repo.root).length, 0);

    // 1. Dry run restore
    const dryRestore = restoreLedger(repo.root, archivePath, { dryRun: true });
    assert.equal(dryRestore.ok, true);
    assert.equal(dryRestore.dryRun, true);
    assert.equal(dryRestore.restored.length, 2);
    assert.equal(fs.existsSync(path.join(eventsDir(repo.root), `${e1.id}.json`)), false);

    // 2. Real restore
    const realRestore = restoreLedger(repo.root, archivePath, { dryRun: false });
    assert.equal(realRestore.ok, true);
    assert.equal(realRestore.dryRun, false);
    assert.deepEqual(realRestore.restored.sort(), [e1.id, e2.id].sort());

    // Byte-for-byte check
    const restoredE1Json = fs.readFileSync(path.join(eventsDir(repo.root), `${e1.id}.json`), 'utf8');
    const restoredE2Json = fs.readFileSync(path.join(eventsDir(repo.root), `${e2.id}.json`), 'utf8');
    assert.equal(restoredE1Json, originalE1Json);
    assert.equal(restoredE2Json, originalE2Json);

    // Mirrored copy also restored
    assert.equal(fs.existsSync(path.join(ledgerDir(repo.root), `${e1.id}.json`)), true);
    assert.equal(fs.existsSync(path.join(ledgerDir(repo.root), `${e2.id}.json`)), true);

    // Ledger verification passes with no errors
    const problems = verifyLedger(repo.root);
    assert.equal(problems.length, 0);

    // 3. Idempotent repeat restore
    const repeatRestore = restoreLedger(repo.root, archivePath);
    assert.equal(repeatRestore.restored.length, 0);
    assert.equal(repeatRestore.alreadyPresent.length, 2);
  } finally {
    repo.cleanup();
  }
});

test('BAT-031: tampered archives fail closed with integrity errors upon restore', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    const e1 = appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex' });
    const e2 = appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude' });

    const validArchive = path.join(repo.root, 'valid-archive.json');
    archiveLedger(repo.root, { out: validArchive });

    const bundle = JSON.parse(fs.readFileSync(validArchive, 'utf8'));

    // Case 1: Tampered global archive checksum
    const tamperedChecksumPath = path.join(repo.root, 'tampered-checksum.json');
    const t1 = { ...bundle, checksum: '0000000000000000000000000000000000000000000000000000000000000000' };
    fs.writeFileSync(tamperedChecksumPath, JSON.stringify(t1, null, 2));

    assert.throws(
      () => restoreLedger(repo.root, tamperedChecksumPath),
      (err) => err.code === 'ARCHIVE_INTEGRITY_COMPROMISED' && err.message.includes('checksum mismatch')
    );

    // Case 2: Tampered event content (edited note without updating SHA)
    const tamperedEventPath = path.join(repo.root, 'tampered-event.json');
    const t2 = JSON.parse(JSON.stringify(bundle));
    t2.events[0].note = 'malicious alteration';
    t2.checksum = sha256(canonicalJson(t2.events)); // checksum matches tampered array, but event sha fails
    fs.writeFileSync(tamperedEventPath, JSON.stringify(t2, null, 2));

    assert.throws(
      () => restoreLedger(repo.root, tamperedEventPath),
      (err) => err.code === 'ARCHIVE_INTEGRITY_COMPROMISED' && err.message.includes('sha mismatch')
    );

    // Case 3: Tampered event with recalculated SHA but wrong archive checksum
    const tamperedEvent2Path = path.join(repo.root, 'tampered-event2.json');
    const t3 = JSON.parse(JSON.stringify(bundle));
    t3.events[0].note = 'malicious alteration 2';
    t3.events[0].sha = eventSha(t3.events[0]);
    // left bundle.checksum un-updated
    fs.writeFileSync(tamperedEvent2Path, JSON.stringify(t3, null, 2));

    assert.throws(
      () => restoreLedger(repo.root, tamperedEvent2Path),
      (err) => err.code === 'ARCHIVE_INTEGRITY_COMPROMISED'
    );

    // Case 4: Invalid event schema in archive
    const tamperedSchemaPath = path.join(repo.root, 'tampered-schema.json');
    const t4 = JSON.parse(JSON.stringify(bundle));
    t4.events[0].kind = 'unauthorized_kind';
    t4.events[0].sha = eventSha(t4.events[0]);
    t4.checksum = sha256(canonicalJson(t4.events));
    fs.writeFileSync(tamperedSchemaPath, JSON.stringify(t4, null, 2));

    assert.throws(
      () => restoreLedger(repo.root, tamperedSchemaPath),
      (err) => err.code === 'ARCHIVE_INTEGRITY_COMPROMISED' && err.message.includes('schema')
    );

    // Case 5: Corrupt unparseable JSON file
    const corruptPath = path.join(repo.root, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{corrupted-data[');

    assert.throws(
      () => restoreLedger(repo.root, corruptPath),
      (err) => err.code === 'ARCHIVE_CORRUPT'
    );

    // Case 6: Non-existent archive file
    assert.throws(
      () => restoreLedger(repo.root, path.join(repo.root, 'does-not-exist.json')),
      (err) => err.code === 'ARCHIVE_NOT_FOUND'
    );
  } finally {
    repo.cleanup();
  }
});

test('BAT-031: CLI commands `baton ledger archive` and `baton ledger restore` work end-to-end', async () => {
  const repo = makeTempRepo({
    config: sampleConfig(),
    plan: samplePlan(),
  });

  try {
    appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex' });
    appendEvent(repo.root, { packet: 'WP-001', kind: 'verdict', to: 'ACCEPTED', by: 'claude' });

    const archiveFile = path.join(repo.root, 'cli-archive.json');

    // Archive via CLI
    const archCli = await runCli(repo.root, ['ledger', 'archive', '--out', archiveFile, '--prune', '--confirm', '--json']);
    assert.equal(archCli.status, 0);
    const archJson = JSON.parse(archCli.stdout);
    assert.equal(archJson.ok, true);
    assert.equal(archJson.counts.archived, 2);
    assert.equal(archJson.counts.pruned, 2);

    // Pruned from disk
    assert.equal(readEvents(repo.root).length, 0);

    // Restore via CLI
    const restoreCli = await runCli(repo.root, ['ledger', 'restore', archiveFile, '--json']);
    assert.equal(restoreCli.status, 0);
    const restoreJson = JSON.parse(restoreCli.stdout);
    assert.equal(restoreJson.ok, true);
    assert.equal(restoreJson.restored.length, 2);

    // Restored back
    assert.equal(readEvents(repo.root).length, 2);
  } finally {
    repo.cleanup();
  }
});
