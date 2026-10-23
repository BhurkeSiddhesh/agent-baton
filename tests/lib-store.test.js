import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { appendEvent, readEvents, verifyLedger, importLedger, exportLedger, stateDir, eventsDir, ledgerDir, eventSha, EVENT_ID_RE, LEDGER_VERSION, EVENT_KINDS, validateEventSchema } from '../src/lib/store.js';
import { makeTempRepo, REPO } from './helpers.js';

const app = (root, over = {}) => appendEvent(root, { packet: 'WP-001', kind: 'status', to: 'BLOCKED', by: 'codex', ...over });

test('appendEvent fills id/ts/hv/sha and writes local + mirror', () => {
  const repo = makeTempRepo({ git: true, config: true });
  try {
    process.env.BATON_NOW = '2026-10-13T10:15:00Z';
    const ev = app(repo.root, { note: 'hi', data: { a: 1 } });
    assert.match(ev.id, EVENT_ID_RE);
    assert.ok(ev.id.startsWith('20261013T101500Z-'));
    assert.deepEqual([ev.ts, ev.hv, ev.note, ev.data], ['2026-10-13T10:15:00Z', LEDGER_VERSION, 'hi', { a: 1 }]);
    assert.equal(ev.sha, eventSha(ev));
    assert.ok(fs.existsSync(path.join(eventsDir(repo.root), `${ev.id}.json`)));
    assert.ok(fs.existsSync(path.join(ledgerDir(repo.root), `${ev.id}.json`)));
    assert.equal(stateDir(repo.root), path.join(repo.root, '.git', 'baton'));
    assert.deepEqual(readEvents(repo.root), [ev]);
    assert.throws(() => appendEvent(repo.root, { kind: 'nonsense' }), /unknown event kind/);
  } finally { delete process.env.BATON_NOW; repo.cleanup(); }
});

test('non-git repos keep state under .baton/state', () => {
  const repo = makeTempRepo({ config: true });
  try {
    app(repo.root);
    assert.equal(stateDir(repo.root), path.join(repo.root, '.baton', 'state'));
    assert.equal(readEvents(repo.root).length, 1);
  } finally { repo.cleanup(); }
});

test('ids sort in append order even inside one frozen second', () => {
  const repo = makeTempRepo({ config: true });
  try {
    process.env.BATON_NOW = '2026-01-01T00:00:00Z';
    const ids = Array.from({ length: 30 }, (_, i) => app(repo.root, { note: String(i) }).id);
    assert.deepEqual([...ids].sort(), ids);
    assert.deepEqual(readEvents(repo.root).map((e) => e.note), ids.map((_, i) => String(i)));
  } finally { delete process.env.BATON_NOW; repo.cleanup(); }
});

test('mirror can be disabled in config', () => {
  const repo = makeTempRepo({ config: { version: 1, ledger: { mirror: false } } });
  try {
    app(repo.root);
    assert.equal(fs.existsSync(ledgerDir(repo.root)), false);
    assert.deepEqual(verifyLedger(repo.root), []);
  } finally { repo.cleanup(); }
});

test('union of local and mirror, de-duplicated by id and sorted by (ts, id)', () => {
  const repo = makeTempRepo({ config: true });
  try {
    process.env.BATON_NOW = '2026-01-01T00:00:00Z';
    const a = app(repo.root);
    process.env.BATON_NOW = '2026-01-02T00:00:00Z';
    const b = app(repo.root);
    // a fresh clone only has the mirror; a second clone only has local events
    fs.rmSync(path.join(eventsDir(repo.root), `${a.id}.json`));
    fs.rmSync(path.join(ledgerDir(repo.root), `${b.id}.json`));
    assert.deepEqual(readEvents(repo.root).map((e) => e.id), [a.id, b.id]);
    // timestamps decide before ids
    const later = { ...a, id: '20250101T000000Z-ffffff', ts: '2026-03-01T00:00:00Z' };
    later.sha = eventSha(later);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${later.id}.json`), JSON.stringify(later));
    assert.deepEqual(readEvents(repo.root).map((e) => e.id), [a.id, b.id, later.id]);
  } finally { delete process.env.BATON_NOW; repo.cleanup(); }
});

test('verifyLedger detects edits, bad json, id mismatch, divergence, missing mirror; ack marks problems', () => {
  const repo = makeTempRepo({ config: true });
  try {
    const good = app(repo.root);
    assert.deepEqual(verifyLedger(repo.root), []);

    const edited = app(repo.root, { note: 'orig' });
    const f = path.join(eventsDir(repo.root), `${edited.id}.json`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('orig', 'forged'));
    let problems = verifyLedger(repo.root);
    assert.ok(problems.some((p) => p.id === edited.id && p.where === 'local' && /sha mismatch/.test(p.problem)));

    const broken = path.join(ledgerDir(repo.root), '20260101T000000Z-aaaaaa.json');
    fs.writeFileSync(broken, '{nope');
    assert.ok(verifyLedger(repo.root).some((p) => p.id === '20260101T000000Z-aaaaaa' && /unreadable/.test(p.problem)));
    fs.unlinkSync(broken);

    const wrongName = { ...good, id: '20260101T000000Z-bbbbbb' };
    fs.writeFileSync(path.join(ledgerDir(repo.root), '20260101T000000Z-cccccc.json'), JSON.stringify(wrongName));
    assert.ok(verifyLedger(repo.root).some((p) => /does not match event id/.test(p.problem)));
    fs.unlinkSync(path.join(ledgerDir(repo.root), '20260101T000000Z-cccccc.json'));

    const nosha = { ...good, id: '20260101T000000Z-dddddd' };
    delete nosha.sha;
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${nosha.id}.json`), JSON.stringify(nosha));
    assert.ok(verifyLedger(repo.root).some((p) => p.id === nosha.id && /no sha/.test(p.problem)));
    fs.unlinkSync(path.join(ledgerDir(repo.root), `${nosha.id}.json`));

    // local and mirror both valid but different
    const other = { ...good, note: 'different' };
    other.sha = eventSha(other);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${good.id}.json`), JSON.stringify(other));
    assert.ok(verifyLedger(repo.root).some((p) => p.id === good.id && p.where === 'both' && /differ/.test(p.problem)));
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${good.id}.json`), JSON.stringify(good));

    // restore the edited one, then lose its mirror copy
    fs.writeFileSync(f, JSON.stringify(edited));
    fs.unlinkSync(path.join(ledgerDir(repo.root), `${edited.id}.json`));
    problems = verifyLedger(repo.root);
    assert.deepEqual(problems.map((p) => [p.id, p.severity]), [[edited.id, 'warn']]);

    // acknowledge
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('orig', 'forged'));
    appendEvent(repo.root, { kind: 'ack', by: 'claude', note: 'known', data: { event: edited.id } });
    assert.ok(verifyLedger(repo.root).filter((p) => p.id === edited.id).every((p) => p.acked));
  } finally { repo.cleanup(); }
});

test('import copies valid mirror events to local; export the other way; both skip tampered files', () => {
  const repo = makeTempRepo({ config: true });
  try {
    const a = app(repo.root);
    const b = app(repo.root);
    fs.rmSync(eventsDir(repo.root), { recursive: true });
    const tampered = path.join(ledgerDir(repo.root), `${b.id}.json`);
    fs.writeFileSync(tampered, fs.readFileSync(tampered, 'utf8').replace('"codex"', '"mallory"'));
    const res = importLedger(repo.root);
    assert.deepEqual(res.imported, [a.id]);
    assert.deepEqual(res.skipped.map((s) => s.id), [b.id]);
    assert.deepEqual(importLedger(repo.root).imported, []);

    fs.rmSync(ledgerDir(repo.root), { recursive: true });
    const exp = exportLedger(repo.root);
    assert.deepEqual(exp.exported, [a.id]);
    assert.ok(fs.existsSync(path.join(ledgerDir(repo.root), `${a.id}.json`)));
  } finally { repo.cleanup(); }
});

test('a ledger from a newer format refuses writes', () => {
  const repo = makeTempRepo({ config: true });
  try {
    const ev = app(repo.root);
    const future = { ...ev, id: '20990101T000000Z-aaaaaa', ts: '2099-01-01T00:00:00Z', hv: LEDGER_VERSION + 1 };
    future.sha = eventSha(future);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${future.id}.json`), JSON.stringify(future));
    assert.throws(() => app(repo.root), (e) => e.code === 'LEDGER_NEWER');
  } finally { repo.cleanup(); }
});

test('event schemas reject malformed appends and quarantine malformed or future replay', () => {
  const repo = makeTempRepo({ config: true });
  try {
    assert.throws(() => appendEvent(repo.root, { packet: 'WP-001', kind: 'message', by: 'codex', data: { type: 'NOTICE', to: 'all' } }), (e) => e.code === 'BAD_EVENT_SCHEMA' && /text/.test(e.message));
    const good = app(repo.root);
    const malformed = { ...good, id: '20260101T000000Z-111111', data: [], hv: LEDGER_VERSION };
    malformed.sha = eventSha(malformed);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${malformed.id}.json`), JSON.stringify(malformed));
    const future = { ...good, id: '20260101T000000Z-222222', hv: LEDGER_VERSION + 1 };
    future.sha = eventSha(future);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${future.id}.json`), JSON.stringify(future));
    fs.writeFileSync(path.join(ledgerDir(repo.root), '20260101T000000Z-444444.json'), 'null');
    assert.deepEqual(readEvents(repo.root).map((e) => e.id), [good.id]);
    const problems = verifyLedger(repo.root);
    assert.ok(problems.some((p) => p.id === malformed.id && /data must be an object/.test(p.problem)));
    assert.ok(problems.some((p) => p.id === future.id && /newer than supported/.test(p.problem)));
    assert.ok(problems.some((p) => p.id === '20260101T000000Z-444444' && /JSON object/.test(p.problem)));
  } finally { repo.cleanup(); }
});

test('every declared event kind has a valid v1 schema fixture', () => {
  const data = {
    begin: { base: null, lease_until: '2026-01-01T01:00:00Z', dep_commits: {} }, heartbeat: { lease_until: '2026-01-01T01:00:00Z' },
    reclaim: {}, status: {}, ready: { commit: null, tests: '' }, verdict: { commit: null }, reviewer: { reviewer: 'claude' },
    handoff: { agent: 'claude', from: 'codex' }, verify: { ok: true, commit: null, mode: 'snapshot' }, merged: { commit: 'abc' },
    finding: { fid: 'AUD-001', severity: 'MAJOR' }, finding_resolved: { fid: 'AUD-001', resolution: 'fixed', confirm: false },
    message: { type: 'NOTICE', to: 'all', text: 'hello' }, gate: { gate: 'G1', open: true }, plan: { hash: 'abc' },
    init: { version: '0.1.0', agents: ['codex'] }, ack: { event: '20260101T000000Z-abcdef' },
  };
  const transitions = new Set(['begin', 'reclaim', 'status', 'ready', 'verdict']);
  const nonPacket = new Set(['message', 'gate', 'plan', 'init', 'ack']);
  for (const kind of EVENT_KINDS) {
    const ev = {
      id: '20260101T000000Z-000001', ts: '2026-01-01T00:00:00Z', packet: nonPacket.has(kind) ? null : 'WP-001',
      kind, to: transitions.has(kind) ? 'BLOCKED' : null, by: 'codex', note: '', data: data[kind], hv: LEDGER_VERSION, sha: '0'.repeat(64),
    };
    assert.deepEqual(validateEventSchema(ev, { allowLegacy: false }), [], kind);
  }
});

test('schema v0 remains readable but new appends require current schema', () => {
  const repo = makeTempRepo({ config: true });
  try {
    const current = app(repo.root);
    const legacy = { ...current, id: '20260101T000000Z-333333' };
    delete legacy.hv;
    legacy.sha = eventSha(legacy);
    fs.writeFileSync(path.join(ledgerDir(repo.root), `${legacy.id}.json`), JSON.stringify(legacy));
    assert.deepEqual(validateEventSchema(legacy), []);
    assert.ok(readEvents(repo.root).some((e) => e.id === legacy.id));
  } finally { repo.cleanup(); }
});

test('concurrent appends from two processes lose nothing', async () => {
  const repo = makeTempRepo({ git: true, config: true });
  try {
    const url = pathToFileURL(path.join(REPO, 'src', 'lib', 'store.js')).href;
    const script = `
      import { appendEvent } from ${JSON.stringify(url)};
      const [root, who, n] = process.argv.slice(1);
      for (let i = 0; i < Number(n); i++) appendEvent(root, { packet: 'WP-001', kind: 'message', by: who, data: { type: 'NOTICE', to: 'all', text: who + i } });`;
    const run = (who) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, repo.root, who, '12'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([run('a'), run('b')]);
    const events = readEvents(repo.root);
    assert.equal(events.length, 24);
    assert.equal(new Set(events.map((e) => e.id)).size, 24);
    assert.deepEqual(verifyLedger(repo.root), []);
  } finally { repo.cleanup(); }
});

test('a clock that runs backwards never reorders the ledger: ts is clamped to the newest event', () => {
  const repo = makeTempRepo({ git: true, config: true });
  try {
    process.env.BATON_NOW = '2026-10-13T12:00:00Z';
    const a = app(repo.root, { note: 'a' });
    process.env.BATON_NOW = '2026-10-13T11:00:00Z';
    const b = app(repo.root, { note: 'b' });
    process.env.BATON_NOW = '2026-10-13T11:00:01Z';
    const c = app(repo.root, { note: 'c' });
    assert.ok(b.ts >= a.ts && c.ts >= b.ts, `${a.ts} ${b.ts} ${c.ts}`);
    assert.ok(a.id < b.id && b.id < c.id);
    assert.deepEqual(readEvents(repo.root).map((e) => e.note), ['a', 'b', 'c']);
  } finally { delete process.env.BATON_NOW; repo.cleanup(); }
});
