import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';
import { main } from '../src/cli.js';
import { buildContext, memoryStream } from '../src/lib/context.js';
import { validatePlan, normalizePlan } from '../src/lib/plan.js';
import { validateConfig, PERMISSION_PROFILES } from '../src/lib/config.js';
import * as guard from '../src/commands/guard.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const repos = [];
afterEach(() => { while (repos.length) repos.pop().cleanup(); });

function repo(opts = {}) {
  const r = makeTempRepo({ git: true, config: true, plan: true, ...opts });
  repos.push(r);
  return r;
}

async function cli(cwd, args) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await main(args, { cwd, env: {}, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

async function checkGuard(r, input, { agent = 'codex', hook = 'generic' } = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const ctx = buildContext({ cwd: r.root, env: {}, stdout, stderr, commands: [] });
  ctx.stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const args = { _: [], agent, hook };
  const status = await guard.run(ctx, args);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

test('BAT-012: standard permission profiles define least-privilege matrix', () => {
  assert.equal(PERMISSION_PROFILES['read-only'].allowWrite, false);
  assert.equal(PERMISSION_PROFILES['read-only'].allowShell, false);
  assert.equal(PERMISSION_PROFILES['read-only'].allowNetwork, false);

  assert.equal(PERMISSION_PROFILES['review-only'].allowWrite, false);
  assert.equal(PERMISSION_PROFILES['review-only'].allowShell, false);

  assert.equal(PERMISSION_PROFILES['workspace-write'].allowWrite, true);
  assert.equal(PERMISSION_PROFILES['workspace-write'].allowShell, true);
  assert.equal(PERMISSION_PROFILES['workspace-write'].allowNetwork, false);

  assert.equal(PERMISSION_PROFILES['privileged'].allowWrite, true);
  assert.equal(PERMISSION_PROFILES['privileged'].allowShell, true);
  assert.equal(PERMISSION_PROFILES['privileged'].allowNetwork, true);
  assert.equal(PERMISSION_PROFILES['privileged'].privileged, true);
});

test('BAT-012: validatePlan enforces profile validity and rejects unauthorized escalation', () => {
  const cfg = sampleConfig();
  const pl = samplePlan();

  // Unknown profile is rejected
  pl.packets[0].profile = 'super-root-9000';
  const bad = validatePlan(pl, cfg);
  assert.ok(bad.errors.some((e) => /unknown permission profile "super-root-9000"/.test(e)));

  // Valid standard profile succeeds
  pl.packets[0].profile = 'read-only';
  assert.deepEqual(validatePlan(pl, cfg).errors, []);

  // Worker attempting to escalate to privileged is rejected
  pl.packets[0].agent = 'codex'; // codex lacks orchestrator role
  pl.packets[0].profile = 'privileged';
  const escalated = validatePlan(pl, cfg);
  assert.ok(escalated.errors.some((e) => /unauthorized profile escalation.*lacks orchestrator role/i.test(e)));

  // Orchestrator allowed privileged profile
  pl.packets[0].agent = 'claude'; // claude is orchestrator
  pl.packets[0].reviewer = 'codex';
  assert.deepEqual(validatePlan(pl, cfg).errors, []);
});

test('BAT-012: validateConfig surfaces unsupported kernel/network sandbox enforcement', () => {
  const cfg = sampleConfig();
  cfg.security = {
    profiles: {
      'hard-jail': {
        isolation: 'kernel',
        allowWrite: true,
      },
    },
  };
  const res = validateConfig(cfg);
  assert.ok(res.errors.some((e) => /unsupported isolation "kernel"; Baton runs in user space without kernel\/network sandboxing/i.test(e)));
});

test('BAT-012: read-only profile blocks workspace edits and shell execution in guard', async () => {
  const r = repo();
  // Enable block mode
  const cfg = sampleConfig({ guard: { mode: 'block' } });
  r.write('.baton/config.json', JSON.stringify(cfg, null, 2));

  // Set WP-001 to read-only profile in plan
  const plan = samplePlan();
  plan.packets[0].profile = 'read-only';
  r.write('.baton/plan.json', JSON.stringify(plan, null, 2));

  // Begin packet
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);

  // Attempt file edit under read-only profile (even on an owned file)
  const fileAttempt = await checkGuard(r, { tool_name: 'Edit', tool_input: { file_path: 'src/api/export.js' } });
  assert.equal(fileAttempt.status, 2);
  assert.match(fileAttempt.stderr, /operates under "read-only" profile which forbids workspace file modifications/i);

  // Attempt shell command under read-only profile
  const bashAttempt = await checkGuard(r, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
  assert.equal(bashAttempt.status, 2);
  assert.match(bashAttempt.stderr, /operates under "read-only" profile which forbids shell execution/i);
});

test('BAT-012: review-only profile blocks code modifications in guard', async () => {
  const r = repo();
  const cfg = sampleConfig({ guard: { mode: 'block' } });
  r.write('.baton/config.json', JSON.stringify(cfg, null, 2));

  const plan = samplePlan();
  plan.packets[0].profile = 'review-only';
  r.write('.baton/plan.json', JSON.stringify(plan, null, 2));

  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);

  const editAttempt = await checkGuard(r, { tool_name: 'Edit', tool_input: { file_path: 'src/api/export.js' } });
  assert.equal(editAttempt.status, 2);
  assert.match(editAttempt.stderr, /operates under "review-only" profile which forbids workspace file modifications/i);
});

test('BAT-012: guard fails closed when unsupported sandbox isolation is requested', async () => {
  const r = repo();
  // Begin valid packet first
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);

  // Now inject custom profile with unsupported isolation into config and plan
  const cfg = sampleConfig({
    guard: { mode: 'block' },
    security: {
      profiles: {
        'custom-kernel-sandbox': {
          isolation: 'kernel',
          allowWrite: true,
        },
      },
    },
  });
  r.write('.baton/config.json', JSON.stringify(cfg, null, 2));

  const plan = samplePlan();
  plan.packets[0].profile = 'custom-kernel-sandbox';
  r.write('.baton/plan.json', JSON.stringify(plan, null, 2));

  const attempt = await checkGuard(r, { tool_name: 'Edit', tool_input: { file_path: 'src/api/export.js' } });
  assert.equal(attempt.status, 2);
  assert.match(attempt.stderr, /unsupported (enforcement|isolation).*Baton runs in user space without kernel\/network sandboxing/i);
});
