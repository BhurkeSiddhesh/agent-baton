import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, sampleConfig } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { resolveExecutionProvenance } from '../src/lib/provenance.js';
import { readEvents, appendEvent, eventSha } from '../src/lib/store.js';
import { validateEventSchema } from '../src/lib/event-schema.js';
import { auditEvents } from '../src/lib/engine.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const repos = [];
const originalEnv = { ...process.env };
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  Object.assign(process.env, originalEnv);
});

function repo(opts = {}) {
  const r = makeTempRepo({ git: true, config: true, plan: true, ...opts });
  repos.push(r);
  return r;
}

async function cli(cwd, args, envOver = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const env = { ...process.env, ...envOver };
  const status = await main(args, { cwd, env, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

test('BAT-013: resolveExecutionProvenance identifies environment trust and runner context', () => {
  // Local environment
  const local = resolveExecutionProvenance({});
  assert.equal(local.trust, 'local-unverified');
  assert.equal(local.runner, 'local');
  assert.match(local.session, /^sess-/);

  // GitHub Actions environment
  const ghEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'octocat',
    GITHUB_WORKFLOW: 'agent-ci',
    GITHUB_JOB: 'worker-job',
    GITHUB_RUN_ID: '987654321',
    GITHUB_SHA: 'abc1234567890',
  };
  const gh = resolveExecutionProvenance(ghEnv);
  assert.equal(gh.trust, 'github-verified');
  assert.equal(gh.runner, 'github-actions');
  assert.equal(gh.session, 'gh-987654321-1');
  assert.equal(gh.gh.actor, 'octocat');
  assert.equal(gh.gh.runId, '987654321');

  // Generic CI
  const ci = resolveExecutionProvenance({ CI: 'true' });
  assert.equal(ci.trust, 'ci-environment');
  assert.equal(ci.runner, 'ci');
});

test('BAT-013: events record provenance and session identifiers into tamper-evident SHA', () => {
  const r = repo();
  const ev = appendEvent(r.root, {
    packet: 'WP-001',
    kind: 'status',
    to: 'IN_PROGRESS',
    by: 'codex',
    prov: {
      session: 'sess-test-12345',
      trust: 'local-unverified',
      runner: 'local',
      adapter: 'cli',
    },
  });

  assert.ok(ev.prov);
  assert.equal(ev.prov.session, 'sess-test-12345');
  assert.equal(ev.prov.trust, 'local-unverified');
  assert.equal(validateEventSchema(ev).length, 0);

  // Provenance is checksum-bound in canonical eventSha
  assert.equal(ev.sha, eventSha(ev));
  const tamperedProv = { ...ev, prov: { ...ev.prov, trust: 'github-verified' } };
  assert.notEqual(ev.sha, eventSha(tamperedProv));
});

test('BAT-013: requireActorMatch prevents GitHub Actions identity spoofing', async () => {
  const r = repo();
  // Configure requireActorMatch and map agent github usernames
  const cfg = sampleConfig({
    security: { requireActorMatch: true },
  });
  cfg.agents.find((a) => a.id === 'codex').github = 'codex-bot';
  cfg.agents.find((a) => a.id === 'claude').github = 'claude-bot';
  r.write('.baton/config.json', JSON.stringify(cfg, null, 2));

  // Mallory tries to act as codex in GitHub Actions
  const spoofAttempt = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'mallory',
  });
  assert.equal(spoofAttempt.status, 1);
  assert.match(spoofAttempt.stderr, /GitHub actor "mallory" does not match assigned agent "codex"/i);

  // Legitimate runner with matching GITHUB_ACTOR succeeds
  const legit = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'codex-bot',
  });
  assert.equal(legit.status, 0, legit.stderr);
});

test('BAT-013: auditEvents detects provenance actor mismatches in historical verdicts', () => {
  const cfg = sampleConfig();
  cfg.agents.find((a) => a.id === 'claude').github = 'claude-bot';

  const plan = {
    version: 1,
    goal: 'test',
    tracks: [],
    gates: [],
    milestones: [],
    packets: [
      {
        id: 'WP-001',
        title: 'test',
        agent: 'codex',
        reviewer: 'claude',
        owns: ['src/api/export.js'],
        deps: [],
        needs_done: [],
        gate: null,
        gate_mode: 'start',
        priority: 'P2',
        milestone: null,
        stretch: false,
        test: null,
        description: '',
        done_checks: [],
      },
    ],
  };

  const events = [
    {
      id: '20261023T100000Z-000001',
      ts: '2026-10-23T10:00:00Z',
      packet: 'WP-001',
      kind: 'begin',
      to: 'IN_PROGRESS',
      by: 'codex',
      note: '',
      data: { base: 'c123456', lease_until: '2026-10-23T18:00:00Z', lease_token: 1 },
      hv: 1,
      rev: 1,
      parents: [],
      sha: '0'.repeat(64),
    },
    {
      id: '20261023T110000Z-000002',
      ts: '2026-10-23T11:00:00Z',
      packet: 'WP-001',
      kind: 'verify',
      by: 'harness',
      note: '',
      data: { ok: true, commit: 'c123456' },
      hv: 1,
      rev: 2,
      parents: ['20261023T100000Z-000001'],
      sha: '0'.repeat(64),
    },
    {
      id: '20261023T113000Z-000003',
      ts: '2026-10-23T11:30:00Z',
      packet: 'WP-001',
      kind: 'ready',
      to: 'READY_FOR_REVIEW',
      by: 'codex',
      note: '',
      data: { commit: 'c123456', tests: 'ok' },
      hv: 1,
      rev: 3,
      parents: ['20261023T110000Z-000002'],
      sha: '0'.repeat(64),
    },
    {
      id: '20261023T120000Z-000004',
      ts: '2026-10-23T12:00:00Z',
      packet: 'WP-001',
      kind: 'verdict',
      to: 'ACCEPTED',
      by: 'claude',
      note: 'looks good',
      data: { commit: 'c123456', score: 5 },
      prov: {
        session: 'gh-12345-1',
        trust: 'github-verified',
        runner: 'github-actions',
        adapter: 'cli',
        gh: { actor: 'mallory-impostor' }, // mismatch: claude's github is claude-bot
      },
      hv: 1,
      rev: 4,
      parents: ['20261023T113000Z-000003'],
      sha: '0'.repeat(64),
    },
  ];

  const problems = auditEvents(plan, events, cfg);
  assert.ok(problems.some((p) => /has identity mismatch: GitHub actor "mallory-impostor" does not match reviewer "claude"/i.test(p.problem)));
});
