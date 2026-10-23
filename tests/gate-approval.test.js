import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import {
  RISK_TIERS,
  APPROVAL_STATUSES,
  classifyOperation,
  getApprovalStatus,
  requestGate,
  approveGate,
  denyGate,
  checkGate,
  assertGateApproved,
  assertOperationPermitted,
  listGates,
  computeActionFingerprint,
} from '../src/lib/gate.js';
import { readEvents } from '../src/lib/store.js';

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

async function cli(cwd, args, env = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await main(args, { cwd, env, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

// ---------------------------------------------------------------------------
// 1. Operation Risk Classification
// ---------------------------------------------------------------------------

test('BAT-019: operation risk classification categorizes actions into 4 tiers', () => {
  // Read-only actions
  assert.equal(classifyOperation('read', 'README.md'), 'read-only');
  assert.equal(classifyOperation('query', 'db'), 'read-only');
  assert.equal(classifyOperation('list', 'gates'), 'read-only');
  assert.equal(classifyOperation('check', 'G1'), 'read-only');
  assert.equal(classifyOperation('inspect', 'state'), 'read-only');
  assert.equal(classifyOperation('status'), 'read-only');
  assert.equal(classifyOperation('scores'), 'read-only');
  assert.equal(classifyOperation('digest'), 'read-only');

  // Normal actions
  assert.equal(classifyOperation('write', 'src/api/export.js'), 'normal');
  assert.equal(classifyOperation('edit', 'src/utils.js'), 'normal');
  assert.equal(classifyOperation('format', 'docs/'), 'normal');

  // Privileged actions
  assert.equal(classifyOperation('deploy', 'staging'), 'privileged');
  assert.equal(classifyOperation('publish', 'npm'), 'privileged');
  assert.equal(classifyOperation('release', 'v1.0.0'), 'privileged');
  assert.equal(classifyOperation('merge', 'main'), 'privileged');
  assert.equal(classifyOperation('config', 'settings'), 'privileged');
  assert.equal(classifyOperation('admin', 'roles'), 'privileged');
  assert.equal(classifyOperation('secret', 'api-key'), 'privileged');
  assert.equal(classifyOperation('execute', 'script.sh'), 'privileged');

  // Target-based privilege escalation
  assert.equal(classifyOperation('write', 'production'), 'privileged');
  assert.equal(classifyOperation('apply', 'main'), 'privileged');
  assert.equal(classifyOperation('write', '.baton/config.json'), 'privileged');
  assert.equal(classifyOperation('write', '.github/workflows/ci.yml'), 'privileged');

  // Destructive actions
  assert.equal(classifyOperation('delete', 'database'), 'destructive');
  assert.equal(classifyOperation('destroy', 'cluster'), 'destructive');
  assert.equal(classifyOperation('drop', 'tables'), 'destructive');
  assert.equal(classifyOperation('rm', 'src/legacy.js'), 'destructive');
  assert.equal(classifyOperation('purge', 'cache'), 'destructive');
  assert.equal(classifyOperation('reset', 'HEAD~1'), 'destructive');
  assert.equal(classifyOperation('uninstall', 'package'), 'destructive');
  assert.equal(classifyOperation('force-push', 'main'), 'destructive');
  assert.equal(classifyOperation('rollback', 'v0.9'), 'destructive');

  // Defined constants
  assert.deepEqual(RISK_TIERS, ['read-only', 'normal', 'privileged', 'destructive']);
  assert.deepEqual(APPROVAL_STATUSES, ['REQUESTED', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED']);
});

test('BAT-019: gate request validates risk tiers and supports explicit overrides', () => {
  const r = repo();

  // Explicit override to privileged
  const g1 = requestGate(r.root, { action: 'write', target: 'notes.txt', risk: 'privileged', by: 'human' });
  assert.equal(g1.risk, 'privileged');

  // Auto classification
  const g2 = requestGate(r.root, { action: 'rm', target: 'legacy.js', by: 'human' });
  assert.equal(g2.risk, 'destructive');

  // Invalid risk tier rejected
  assert.throws(
    () => requestGate(r.root, { action: 'read', target: 'file.txt', risk: 'ultra-danger' }),
    /invalid risk tier "ultra-danger"/
  );
});

// ---------------------------------------------------------------------------
// 2. Approval Recording with Immutable Session & Commit Identifiers
// ---------------------------------------------------------------------------

test('BAT-019: approval recording captures session, commit and immutable fingerprint in append-only ledger', () => {
  const r = repo();
  const commitSha = r.git('rev-parse', 'HEAD');

  const gate = requestGate(r.root, {
    action: 'deploy',
    target: 'production',
    risk: 'destructive',
    reason: 'Ship v1.0.0 release',
    by: 'codex',
    session_id: 'sess-test-12345',
  });

  assert.equal(gate.id, 'GATE-001');
  assert.equal(gate.status, 'REQUESTED');
  assert.equal(gate.session_id, 'sess-test-12345');
  assert.equal(gate.commit, commitSha);
  assert.ok(gate.context_sha);

  // Verify event written to append-only ledger
  const events = readEvents(r.root);
  const reqEvent = events.find((e) => e.kind === 'approval' && e.data?.gate_id === 'GATE-001');
  assert.ok(reqEvent, 'approval event must exist in ledger');
  assert.equal(reqEvent.kind, 'approval');
  assert.equal(reqEvent.by, 'codex');
  assert.equal(reqEvent.data.status, 'REQUESTED');
  assert.equal(reqEvent.data.session_id, 'sess-test-12345');
  assert.equal(reqEvent.data.commit, commitSha);
  assert.equal(reqEvent.data.context_sha, gate.context_sha);

  // Approve gate by authorized human
  const approved = approveGate(r.root, 'GATE-001', { by: 'human', reason: 'Release verified' });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.approver, 'human');
  assert.equal(approved.session_id, 'sess-test-12345');
  assert.equal(approved.commit, commitSha);
  assert.equal(approved.context_sha, gate.context_sha);

  // Verify approval decision recorded in ledger
  const eventsAfter = readEvents(r.root);
  const appEvent = eventsAfter[eventsAfter.length - 1];
  assert.equal(appEvent.kind, 'approval');
  assert.equal(appEvent.by, 'human');
  assert.equal(appEvent.data.status, 'APPROVED');
  assert.equal(appEvent.data.gate_id, 'GATE-001');
  assert.equal(appEvent.data.commit, commitSha);
  assert.equal(appEvent.data.session_id, 'sess-test-12345');
  assert.equal(appEvent.data.context_sha, gate.context_sha);

  // Action fingerprint computation is deterministic
  const expectedFingerprint = computeActionFingerprint({
    action: 'deploy',
    target: 'production',
    risk: 'destructive',
    session_id: 'sess-test-12345',
    commit: commitSha,
  });
  assert.equal(gate.context_sha, expectedFingerprint);
});

// ---------------------------------------------------------------------------
// 3. Expiration / TTL Enforcement
// ---------------------------------------------------------------------------

test('BAT-019: TTL enforcement invalidates expired approvals dynamically and prevents execution', () => {
  const r = repo();

  const nowBase = new Date('2026-10-23T12:00:00Z');

  // Request gate with 300 second TTL
  const gate = requestGate(r.root, {
    action: 'deploy',
    target: 'production',
    risk: 'privileged',
    reason: 'Time-sensitive maintenance',
    ttl: 300,
    by: 'codex',
  });

  assert.ok(gate.expires_at);
  const expTime = new Date(gate.expires_at).getTime();
  assert.ok(expTime > Date.now());

  // Approve it
  approveGate(r.root, gate.id, { by: 'claude' });

  // 1. Immediately after approval: valid and usable
  const checkFresh = checkGate(r.root, gate.id, { now: new Date(gate.expires_at).getTime() - 10000 });
  assert.equal(checkFresh.status, 'APPROVED');
  assert.equal(checkFresh.valid, true);

  // 2. After expiration time: status is EXPIRED
  const checkExpired = checkGate(r.root, gate.id, { now: new Date(gate.expires_at).getTime() + 10000 });
  assert.equal(checkExpired.status, 'EXPIRED');
  assert.equal(checkExpired.valid, false);
  assert.equal(checkExpired.code, 'APPROVAL_EXPIRED');

  // 3. assertGateApproved fails for expired gate
  assert.throws(
    () => assertGateApproved(r.root, gate.id, { now: new Date(gate.expires_at).getTime() + 10000 }),
    (err) => err.code === 'APPROVAL_EXPIRED' && /EXPIRED/.test(err.message)
  );

  // 4. assertOperationPermitted rejects expired approval
  assert.throws(
    () => assertOperationPermitted(r.root, {
      action: 'deploy',
      target: 'production',
      now: new Date(gate.expires_at).getTime() + 10000,
    }),
    (err) => err.code === 'APPROVAL_EXPIRED'
  );

  // 5. Cannot approve an already expired request
  const expiredReq = requestGate(r.root, {
    action: 'merge',
    target: 'release-branch',
    ttl: 1, // 1 second
    by: 'codex',
  });
  // Simulate time passed past TTL
  const pastTtl = new Date(Date.now() + 5000);
  assert.equal(getApprovalStatus(expiredReq, pastTtl), 'EXPIRED');
});

// ---------------------------------------------------------------------------
// 4. Explicit Denial Blocking Execution Across Retries
// ---------------------------------------------------------------------------

test('BAT-019: explicit denial blocks execution across repeated retries until new approval', () => {
  const r = repo();
  const commitSha = r.git('rev-parse', 'HEAD');

  // Request privileged operation
  const gate = requestGate(r.root, {
    action: 'deploy',
    target: 'production',
    risk: 'destructive',
    reason: 'Attempt risky deployment',
    by: 'codex',
  });

  // Explicitly deny the request
  denyGate(r.root, gate.id, { by: 'human', reason: 'Database migrations are not backward compatible' });

  // Check gate reports DENIED
  const checkRes = checkGate(r.root, gate.id);
  assert.equal(checkRes.status, 'DENIED');
  assert.equal(checkRes.valid, false);
  assert.equal(checkRes.code, 'APPROVAL_DENIED');

  // Attempting to approve a denied gate must fail
  assert.throws(
    () => approveGate(r.root, gate.id, { by: 'human' }),
    (err) => err.code === 'APPROVAL_DENIED'
  );

  // Multiple consecutive retry attempts to execute the denied operation remain strictly blocked
  for (let retry = 1; retry <= 3; retry++) {
    assert.throws(
      () => assertOperationPermitted(r.root, { action: 'deploy', target: 'production', commit: commitSha }),
      (err) => {
        assert.equal(err.code, 'APPROVAL_DENIED');
        assert.match(err.message, /was denied and cannot proceed without a new approval/);
        return true;
      },
      `Retry #${retry} must remain blocked with APPROVAL_DENIED`
    );
  }

  // Create a NEW request for the same operation (new plan/fix applied)
  const newGate = requestGate(r.root, {
    action: 'deploy',
    target: 'production',
    risk: 'destructive',
    reason: 'Fixed migration scripts, ready for retry',
    by: 'codex',
  });
  assert.notEqual(newGate.id, gate.id);

  // Pending new approval blocks with APPROVAL_PENDING (not allowed yet)
  assert.throws(
    () => assertOperationPermitted(r.root, { action: 'deploy', target: 'production', commit: commitSha }),
    (err) => err.code === 'APPROVAL_PENDING'
  );

  // Approve the new gate
  approveGate(r.root, newGate.id, { by: 'human', reason: 'Verified migration script fix' });

  // Now execution is permitted!
  const permitted = assertOperationPermitted(r.root, { action: 'deploy', target: 'production', commit: commitSha });
  assert.equal(permitted.allowed, true);
  assert.equal(permitted.gate.id, newGate.id);
  assert.equal(permitted.gate.status, 'APPROVED');
});

// ---------------------------------------------------------------------------
// 5. Role Enforcement
// ---------------------------------------------------------------------------

test('BAT-019: role enforcement prevents unauthorized agents and self-approval on privileged/destructive gates', () => {
  const r = repo();

  // codex is a worker (not orchestrator)
  // claude is orchestrator
  // human is human

  // 1. Worker cannot approve privileged gate
  const privGate = requestGate(r.root, { action: 'deploy', target: 'staging', risk: 'privileged', by: 'gemini' });
  assert.throws(
    () => approveGate(r.root, privGate.id, { by: 'codex' }),
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_APPROVER');
      assert.match(err.message, /lacks orchestrator role/);
      return true;
    }
  );

  // 2. Worker cannot approve destructive gate
  const destGate = requestGate(r.root, { action: 'drop', target: 'users_table', risk: 'destructive', by: 'gemini' });
  assert.throws(
    () => approveGate(r.root, destGate.id, { by: 'codex' }),
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED_APPROVER');
      assert.match(err.message, /lacks orchestrator role/);
      return true;
    }
  );

  // 3. Orchestrator CANNOT self-approve own privileged gate
  const claudePriv = requestGate(r.root, { action: 'release', target: 'v1.0', risk: 'privileged', by: 'claude' });
  assert.throws(
    () => approveGate(r.root, claudePriv.id, { by: 'claude' }),
    (err) => {
      assert.equal(err.code, 'SELF_APPROVAL_DISALLOWED');
      assert.match(err.message, /cannot self-approve/);
      return true;
    }
  );

  // 4. Orchestrator CAN approve another agent's privileged gate
  const claudeApproved = approveGate(r.root, privGate.id, { by: 'claude' });
  assert.equal(claudeApproved.status, 'APPROVED');

  // 5. Human CAN approve any gate (including claude's request)
  const humanApproved = approveGate(r.root, claudePriv.id, { by: 'human' });
  assert.equal(humanApproved.status, 'APPROVED');

  // 6. Unknown agent is rejected
  assert.throws(
    () => approveGate(r.root, destGate.id, { by: 'unknown-bot' }),
    /unknown approver "unknown-bot"/
  );
});

// ---------------------------------------------------------------------------
// 6. CLI Command Integration (`baton gate`)
// ---------------------------------------------------------------------------

test('BAT-019: baton gate CLI command implements request, approve, deny, check, list', async () => {
  const r = repo();

  // 1. baton gate request
  const req = await cli(r.root, ['gate', 'request', 'deploy', 'production', '--risk', 'destructive', '--reason', 'Initial release', '--json']);
  assert.equal(req.status, 0, req.stderr);
  const reqData = JSON.parse(req.stdout);
  assert.equal(reqData.action, 'deploy');
  assert.equal(reqData.target, 'production');
  assert.equal(reqData.risk, 'destructive');
  assert.equal(reqData.status, 'REQUESTED');
  const gateId = reqData.gate;

  // 2. baton gate check while pending fails with exit 1
  const checkPending = await cli(r.root, ['gate', 'check', gateId, '--json']);
  assert.equal(checkPending.status, 1);
  assert.equal(JSON.parse(checkPending.stdout).status, 'REQUESTED');

  // 3. baton gate list --status REQUESTED
  const listReq = await cli(r.root, ['gate', 'list', '--status', 'REQUESTED', '--json']);
  assert.equal(listReq.status, 0);
  const listData = JSON.parse(listReq.stdout);
  assert.ok(listData.approvals.some((a) => a.id === gateId));

  // 4. Unauthorized worker approval via CLI fails with exit 1
  const badApprove = await cli(r.root, ['gate', 'approve', gateId, '--by', 'codex']);
  assert.equal(badApprove.status, 1);
  assert.match(badApprove.stderr, /lacks orchestrator role/);

  // 5. baton gate deny
  const denyRes = await cli(r.root, ['gate', 'deny', gateId, '--by', 'human', '--reason', 'Not ready']);
  assert.equal(denyRes.status, 0);
  assert.match(denyRes.stdout, new RegExp(`gate ${gateId} denied by human`));

  // 6. baton gate check on denied gate fails
  const checkDenied = await cli(r.root, ['gate', 'check', gateId]);
  assert.equal(checkDenied.status, 1);
  assert.match(checkDenied.stderr, /DENIED/);

  // 7. Request a new gate and approve it
  const req2 = await cli(r.root, ['gate', 'request', 'deploy', 'production', '--risk', 'destructive', '--reason', 'Ready now']);
  assert.equal(req2.status, 0);
  assert.match(req2.stdout, /gate GATE-002 requested/);

  const approveRes = await cli(r.root, ['gate', 'approve', 'GATE-002', '--by', 'human', '--json']);
  assert.equal(approveRes.status, 0);
  assert.equal(JSON.parse(approveRes.stdout).status, 'APPROVED');

  // 8. baton gate check on approved gate succeeds
  const checkOk = await cli(r.root, ['gate', 'check', 'GATE-002']);
  assert.equal(checkOk.status, 0);
  assert.match(checkOk.stdout, /is APPROVED/);

  // 9. baton gate list human table output
  const listTable = await cli(r.root, ['gate', 'list']);
  assert.equal(listTable.status, 0);
  assert.match(listTable.stdout, /GATE-001/);
  assert.match(listTable.stdout, /GATE-002/);
  assert.match(listTable.stdout, /APPROVED/);
  assert.match(listTable.stdout, /DENIED/);

  // 10. Backward compatibility with plan gates: open and close
  const openPlanGate = await cli(r.root, ['gate', 'open', 'G1', '--by', 'human']);
  assert.equal(openPlanGate.status, 0);
  assert.match(openPlanGate.stdout, /gate G1 opened by human/);

  const checkPlanGate = await cli(r.root, ['gate', 'check', 'G1', '--json']);
  assert.equal(checkPlanGate.status, 0);
  assert.equal(JSON.parse(checkPlanGate.stdout).valid, true);

  const closePlanGate = await cli(r.root, ['gate', 'close', 'G1', '--by', 'human']);
  assert.equal(closePlanGate.status, 0);
  assert.match(closePlanGate.stdout, /gate G1 closed by human/);
});
