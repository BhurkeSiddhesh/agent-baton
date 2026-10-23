import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { readEvents, eventSha } from '../src/lib/store.js';
import { writeJsonAtomic } from '../src/lib/util.js';
import { verifyMarkerPath } from '../src/lib/engine.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;
delete process.env.GITHUB_ACTIONS;
delete process.env.GITHUB_ACTOR;

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
  const env = { ...process.env, GITHUB_ACTIONS: '', GITHUB_ACTOR: '', ...envOver };
  const status = await main(args, { cwd, env, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

async function submitOnBranch(r, pid = 'WP-001', agent = 'codex', files = { 'src/api/export.js': 'export const x = 1;\n' }, envOver = {}) {
  r.git('checkout', '-q', '-b', `track/${pid === 'WP-003' ? 'ui' : 'api'}`);
  const b = await cli(r.root, ['begin', pid, '--agent', agent], envOver);
  assert.equal(b.status, 0, b.stderr);
  for (const [f, content] of Object.entries(files)) {
    r.write(f, content);
  }
  r.commitAll('packet implementation');
  const v = await cli(r.root, ['verify', pid], envOver);
  assert.equal(v.status, 0, v.stderr);
  const s = await cli(r.root, ['submit', pid, '--agent', agent], envOver);
  assert.equal(s.status, 0, s.stderr);
  return r.git('rev-parse', 'HEAD');
}

test('BAT-014: merge blocked if commit hash does not match verified marker', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);

  // Tamper with the verified marker to simulate commit moving or mismatch
  const markerFile = verifyMarkerPath(r.root, 'WP-001');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  const fakeSha = '0123456789abcdef0123456789abcdef01234567';
  writeJsonAtomic(markerFile, { ...marker, commit: fakeSha });

  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /does not match verified marker/i);
});

test('BAT-014: merge blocked if verification failed or missing evidence', async () => {
  const r = repo();
  await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);

  // Set ok: false in verify marker
  const markerFile = verifyMarkerPath(r.root, 'WP-001');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  writeJsonAtomic(markerFile, { ...marker, ok: false });

  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /verification failed|unverified/i);
});

test('BAT-014: local self-asserted reviewer rejected when platform review required', async () => {
  const cfg = sampleConfig();
  cfg.agents.find((a) => a.id === 'claude').github = 'claude-bot';
  cfg.agents.find((a) => a.id === 'codex').github = 'codex-bot';
  const r = repo({ config: cfg });

  await submitOnBranch(r);
  // Accepted locally without platform provenance
  const acc = await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  assert.equal(acc.status, 0, acc.stderr);

  // 1. Rejected with --hosted flag
  const mHosted = await cli(r.root, ['merge', 'WP-001', '--by', 'claude', '--hosted']);
  assert.equal(mHosted.status, 1);
  assert.match(mHosted.stderr, /self-asserted locally/i);
  assert.match(mHosted.stderr, /hosted platform review approval is required/i);

  // 2. Rejected when config.merge.requireCi is enabled
  const cfgWithCi = { ...cfg, merge: { requireCi: true } };
  r.write('.baton/config.json', JSON.stringify(cfgWithCi, null, 2));
  const mCi = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(mCi.status, 1);
  assert.match(mCi.stderr, /self-asserted locally/i);

  // 3. Rejected when config.merge.requirePlatformReview is enabled
  const cfgWithPr = { ...cfg, merge: { requirePlatformReview: true } };
  r.write('.baton/config.json', JSON.stringify(cfgWithPr, null, 2));
  const mPr = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(mPr.status, 1);
  assert.match(mPr.stderr, /self-asserted locally/i);
});

test('BAT-014: platform review and CI verification evidence permit hosted merge', async () => {
  const cfg = sampleConfig({
    merge: { requireCi: true },
  });
  cfg.agents.find((a) => a.id === 'claude').github = 'claude-bot';
  cfg.agents.find((a) => a.id === 'codex').github = 'codex-bot';
  const r = repo({ config: cfg });

  // Perform lifecycle with GitHub Actions CI provenance
  const ghEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'codex-bot',
    GITHUB_RUN_ID: '1001',
    GITHUB_WORKFLOW: 'agent-ci',
  };
  await submitOnBranch(r, 'WP-001', 'codex', { 'src/api/export.js': 'export const x = 1;\n' }, ghEnv);

  // Acceptance verdict executed in verified GitHub Actions runner
  const revEnv = {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'claude-bot',
    GITHUB_RUN_ID: '1002',
    GITHUB_WORKFLOW: 'agent-review',
  };
  const acc = await cli(r.root, ['accept', 'WP-001', '--by', 'claude'], revEnv);
  assert.equal(acc.status, 0, acc.stderr);

  // Merge in hosted mode with matching orchestrator actor
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude', '--hosted'], revEnv);
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /fast-forwarded/i);
});

test('BAT-014: human review requirement enforced for risky changes', async () => {
  // Case A: Packet touching sensitive path accepted by agent is BLOCKED
  const cfgAgent = sampleConfig({
    security: { requireHumanReview: true },
  });
  const planAgent = samplePlan();
  planAgent.packets[0].owns.push('src/security/auth.js');

  const rAgent = repo({ config: cfgAgent, plan: planAgent });
  await submitOnBranch(rAgent, 'WP-001', 'codex', {
    'src/api/export.js': 'export const x = 1;\n',
    'src/security/auth.js': 'export const secret = "none";\n',
  });

  // Agent claude accepts
  const accAgent = await cli(rAgent.root, ['accept', 'WP-001', '--by', 'claude']);
  assert.equal(accAgent.status, 0, accAgent.stderr);

  // Merge is blocked because packet touches sensitive files and was accepted by an agent
  const mBlocked = await cli(rAgent.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(mBlocked.status, 1);
  assert.match(mBlocked.stderr, /sensitive\/risky changes.*requiring human review/i);
  assert.match(mBlocked.stderr, /accepted by agent "claude"/i);

  // Case B: Packet touching sensitive path accepted by human SUCCEEDS
  const cfgHuman = sampleConfig({
    security: { requireHumanReview: true },
  });
  const planHuman = samplePlan();
  planHuman.packets[0].owns.push('src/security/auth.js');

  const rHuman = repo({ config: cfgHuman, plan: planHuman });
  await submitOnBranch(rHuman, 'WP-001', 'codex', {
    'src/api/export.js': 'export const x = 1;\n',
    'src/security/auth.js': 'export const secret = "none";\n',
  });

  // Human accepts
  const accHuman = await cli(rHuman.root, ['accept', 'WP-001', '--by', 'human']);
  assert.equal(accHuman.status, 0, accHuman.stderr);

  // Merge succeeds
  const mAllowed = await cli(rHuman.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(mAllowed.status, 0, mAllowed.stderr);
});

test('BAT-014: forged or mismatched actor rejected', async () => {
  const cfg = sampleConfig();
  cfg.agents.find((a) => a.id === 'claude').github = 'claude-bot';
  cfg.agents.find((a) => a.id === 'codex').github = 'codex-bot';
  const r = repo({ config: cfg });

  await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);

  // 1. Mallory attempts to merge as orchestrator claude in GitHub Actions
  const spoofMerger = await cli(r.root, ['merge', 'WP-001', '--by', 'claude'], {
    GITHUB_ACTIONS: 'true',
    GITHUB_ACTOR: 'mallory',
  });
  assert.equal(spoofMerger.status, 1);
  assert.match(spoofMerger.stderr, /GitHub actor "mallory" does not match orchestrator "claude"/i);

  // 2. Acceptance verdict recorded by mismatched reviewer actor
  const r2 = repo({ config: cfg });
  await submitOnBranch(r2);
  assert.equal((await cli(r2.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);

  const vEv = readEvents(r2.root).find((e) => e.packet === 'WP-001' && e.kind === 'verdict');
  vEv.prov = {
    session: 'gh-999-1',
    trust: 'github-verified',
    runner: 'github-actions',
    adapter: 'cli',
    gh: { actor: 'mallory' },
  };
  vEv.sha = eventSha(vEv);

  const evFile = path.join(r2.root, '.baton', 'ledger', `${vEv.id}.json`);
  fs.writeFileSync(evFile, JSON.stringify(vEv, null, 2) + '\n');
  const localEvFile = path.join(r2.root, '.git', 'baton', 'events', `${vEv.id}.json`);
  if (fs.existsSync(localEvFile)) {
    fs.writeFileSync(localEvFile, JSON.stringify(vEv, null, 2) + '\n');
  }

  const spoofReviewer = await cli(r2.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(spoofReviewer.status, 1);
  assert.match(spoofReviewer.stderr, /identity mismatch|does not match/i);
});
