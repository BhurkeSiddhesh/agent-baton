import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_CONTRACT_VERSION,
  GOAL_STATUS,
  EVIDENCE_TYPE,
  EVIDENCE_STATUS,
  CONSTRAINT_TYPE,
  computeEnvironmentHash,
  normalizeGoalContract,
  validateGoalContract,
  normalizeEvidence,
  validateEvidence,
  checkEvidenceValidity,
  isEvidenceValid,
  EvidenceStore,
  evaluateGoal,
  registerEvaluatorHook,
  getEvaluatorHook,
  clearEvaluatorHooks,
  listEvaluatorHooks,
} from '../src/lib/goal.js';
import { BatonError } from '../src/lib/errors.js';

// BAT-089: Versioned goal contract and evidence-based completion evaluator

test('BAT-089: constants and schema contracts adhere to version 1.0.0', () => {
  assert.equal(GOAL_CONTRACT_VERSION, '1.0.0');

  // Verify all 6 terminal states exist
  assert.equal(GOAL_STATUS.SATISFIED, 'SATISFIED');
  assert.equal(GOAL_STATUS.NEEDS_WORK, 'NEEDS_WORK');
  assert.equal(GOAL_STATUS.NEEDS_HUMAN, 'NEEDS_HUMAN');
  assert.equal(GOAL_STATUS.BUDGET_EXHAUSTED, 'BUDGET_EXHAUSTED');
  assert.equal(GOAL_STATUS.FAILED, 'FAILED');
  assert.equal(GOAL_STATUS.CANCELED, 'CANCELED');

  // Verify evidence types
  assert.equal(EVIDENCE_TYPE.OBJECTIVE_CHECK, 'objective_check');
  assert.equal(EVIDENCE_TYPE.SUBJECTIVE_JUDGMENT, 'subjective_judgment');
  assert.equal(EVIDENCE_TYPE.MANUAL_APPROVAL, 'manual_approval');
  assert.equal(EVIDENCE_TYPE.EXTERNAL_APPROVAL, 'external_approval');

  // Verify evidence statuses
  assert.equal(EVIDENCE_STATUS.PASSED, 'passed');
  assert.equal(EVIDENCE_STATUS.FAILED, 'failed');
  assert.equal(EVIDENCE_STATUS.INCONCLUSIVE, 'inconclusive');
  assert.equal(EVIDENCE_STATUS.PENDING, 'pending');
});

test('BAT-089: goal contract validation and schema normalization', () => {
  const minimal = {
    id: 'GOAL-001',
    title: 'Implement Core Feature',
    acceptance_criteria: [
      { id: 'AC-1', title: 'Unit tests pass' },
    ],
  };

  const normalized = normalizeGoalContract(minimal);
  assert.equal(normalized.version, '1.0.0');
  assert.equal(normalized.id, 'GOAL-001');
  assert.equal(normalized.title, 'Implement Core Feature');
  assert.equal(normalized.acceptance_criteria.length, 1);
  assert.equal(normalized.acceptance_criteria[0].required, true);
  assert.equal(normalized.acceptance_criteria[0].type, 'objective_check');
  assert.deepEqual(normalized.constraints, []);
  assert.deepEqual(normalized.non_goals, []);

  const validated = validateGoalContract(minimal);
  assert.ok(validated);

  // Validation failures
  assert.throws(() => validateGoalContract(null), BatonError);
  assert.throws(() => validateGoalContract({}), /id must be a non-empty string/);
  assert.throws(() => validateGoalContract({ id: 'G-1' }), /title must be a non-empty string/);
  assert.throws(() => validateGoalContract({ id: 'G-1', title: 'Test', version: '2.0.0' }), /Unsupported goal contract version/);
  assert.throws(() => validateGoalContract({ id: 'G-1', title: 'Test', acceptance_criteria: [] }), /must define at least one acceptance criterion/);

  // Duplicate criterion IDs
  assert.throws(() => validateGoalContract({
    id: 'G-1',
    title: 'Test',
    acceptance_criteria: [
      { id: 'AC-1' },
      { id: 'AC-1' },
    ],
  }), /Duplicate criterion ID: AC-1/);

  // Unknown dependency
  assert.throws(() => validateGoalContract({
    id: 'G-1',
    title: 'Test',
    acceptance_criteria: [
      { id: 'AC-1', depends_on: ['AC-999'] },
    ],
  }), /depends on unknown criterion AC-999/);

  // Self dependency
  assert.throws(() => validateGoalContract({
    id: 'G-1',
    title: 'Test',
    acceptance_criteria: [
      { id: 'AC-1', depends_on: ['AC-1'] },
    ],
  }), /cannot depend on itself/);
});

test('BAT-089: environment hash computation is deterministic and sensitive to environment changes', () => {
  const envA = { node: 'v20.0.0', platform: 'linux', arch: 'x64' };
  const envB = { platform: 'linux', arch: 'x64', node: 'v20.0.0' };
  const envC = { node: 'v22.0.0', platform: 'linux', arch: 'x64' };

  const hashA = computeEnvironmentHash(envA);
  const hashB = computeEnvironmentHash(envB);
  const hashC = computeEnvironmentHash(envC);

  assert.equal(hashA, hashB, 'Environment hash must be order-invariant and deterministic');
  assert.notEqual(hashA, hashC, 'Environment hash must vary when environment details change');

  // Default environment hash from process
  const defaultHash = computeEnvironmentHash();
  assert.equal(typeof defaultHash, 'string');
  assert.equal(defaultHash.length, 64);
});

test('BAT-089: evidence normalization and provenance validation', () => {
  const rawEv = {
    criterion_id: 'AC-1',
    status: 'passed',
    provenance: {
      evaluator_id: 'agent-42',
      evaluator_type: 'agent',
      role: 'verifier',
      session_id: 'sess-001',
    },
    git_binding: {
      commit: 'abc1234',
      branch: 'main',
    },
  };

  const ev = normalizeEvidence(rawEv);
  assert.ok(ev.id.startsWith('EVD-'));
  assert.equal(ev.criterion_id, 'AC-1');
  assert.equal(ev.provenance.evaluator_id, 'agent-42');
  assert.equal(ev.git_binding.commit, 'abc1234');
  assert.equal(ev.invalidated, false);

  const validated = validateEvidence(ev);
  assert.ok(validated);

  // Negative tests
  assert.throws(() => validateEvidence({}), /must reference a non-empty criterion_id/);
  assert.throws(() => validateEvidence({ criterion_id: 'AC-1', status: 'unknown_status' }), /Invalid evidence status/);
  assert.throws(() => validateEvidence({ criterion_id: 'AC-1', timestamp: 'not-a-date' }), /Invalid evidence timestamp/);
  assert.throws(() => validateEvidence({ criterion_id: 'AC-1', expires_at: 'bad-expiry' }), /Invalid evidence expires_at/);
});

test('BAT-089: evidence validity checking under git revision, env hash, and TTL expiration', () => {
  const criterion = { id: 'AC-1', title: 'Test', depends_on: [] };
  const baseEv = {
    id: 'EVD-1',
    criterion_id: 'AC-1',
    status: 'passed',
    timestamp: '2026-10-23T20:00:00Z',
    git_binding: { commit: 'commit-aaa' },
    env_hash: 'env-hash-111',
    expires_at: '2026-10-23T22:00:00Z',
  };

  // Valid scenario
  const contextValid = {
    currentTime: new Date('2026-10-23T21:00:00Z'),
    git: { commit: 'commit-aaa' },
    envHash: 'env-hash-111',
  };
  assert.equal(isEvidenceValid(baseEv, criterion, contextValid), true);

  // Expired TTL
  const contextExpired = {
    currentTime: new Date('2026-10-23T22:30:00Z'),
    git: { commit: 'commit-aaa' },
    envHash: 'env-hash-111',
  };
  const expCheck = checkEvidenceValidity(baseEv, criterion, contextExpired);
  assert.equal(expCheck.valid, false);
  assert.equal(expCheck.reason, 'EVIDENCE_EXPIRED');

  // Git revision mismatch
  const contextGitMismatch = {
    currentTime: new Date('2026-10-23T21:00:00Z'),
    git: { commit: 'commit-bbb' },
    envHash: 'env-hash-111',
  };
  const gitCheck = checkEvidenceValidity(baseEv, criterion, contextGitMismatch);
  assert.equal(gitCheck.valid, false);
  assert.equal(gitCheck.reason, 'GIT_REVISION_MISMATCH');

  // Environment hash mismatch
  const contextEnvMismatch = {
    currentTime: new Date('2026-10-23T21:00:00Z'),
    git: { commit: 'commit-aaa' },
    envHash: 'env-hash-222',
  };
  const envCheck = checkEvidenceValidity(baseEv, criterion, contextEnvMismatch);
  assert.equal(envCheck.valid, false);
  assert.equal(envCheck.reason, 'ENV_HASH_MISMATCH');

  // Explicitly invalidated evidence
  const invalidatedEv = { ...baseEv, invalidated: true, invalidation_reason: 'TEST_MANUAL' };
  const invCheck = checkEvidenceValidity(invalidatedEv, criterion, contextValid);
  assert.equal(invCheck.valid, false);
  assert.equal(invCheck.reason, 'TEST_MANUAL');

  // Non-passed evidence
  const failedEv = { ...baseEv, status: 'failed' };
  assert.equal(isEvidenceValid(failedEv, criterion, contextValid), false);
});

test('BAT-089: EvidenceStore management, invalidation cascades, and latest-valid retrieval', () => {
  const store = new EvidenceStore();
  store.add({
    id: 'EVD-1',
    criterion_id: 'AC-1',
    status: 'passed',
    git_binding: { commit: 'c1' },
    env_hash: 'env1',
  });
  store.add({
    id: 'EVD-2',
    criterion_id: 'AC-1',
    status: 'failed',
    git_binding: { commit: 'c2' },
    env_hash: 'env1',
  });
  store.add({
    id: 'EVD-3',
    criterion_id: 'AC-1',
    status: 'passed',
    git_binding: { commit: 'c2' },
    env_hash: 'env1',
  });

  const criterion = { id: 'AC-1', depends_on: [] };

  // When context commit is c2, latest valid should be EVD-3
  const validForC2 = store.getLatestValid(criterion, { git: { commit: 'c2' }, envHash: 'env1' });
  assert.equal(validForC2.id, 'EVD-3');

  // Invalidate on git change: when git changes to c3, entries bound to older commits are invalidated
  const invalidatedCount = store.invalidateOnGitChange('c3', 'BRANCH_REBASED');
  assert.equal(invalidatedCount, 3);
  assert.equal(store.getLatestValid(criterion, { git: { commit: 'c3' }, envHash: 'env1' }), null);

  // Test dependency invalidation cascade
  const storeCascade = new EvidenceStore();
  storeCascade.add({ id: 'E1', criterion_id: 'AC-A', status: 'passed' });
  storeCascade.add({ id: 'E2', criterion_id: 'AC-B', status: 'passed' });
  storeCascade.add({ id: 'E3', criterion_id: 'AC-C', status: 'passed' });

  const contract = {
    id: 'G-1',
    title: 'Cascade Contract',
    acceptance_criteria: [
      { id: 'AC-A' },
      { id: 'AC-B', depends_on: ['AC-A'] },
      { id: 'AC-C', depends_on: ['AC-B'] },
    ],
  };

  // Mutating AC-A should invalidate AC-A, AC-B, and AC-C
  const cascadeCount = storeCascade.invalidateOnDependencyChange(contract, 'AC-A', 'SOURCE_FILE_MODIFIED');
  assert.equal(cascadeCount, 3);
  assert.equal(storeCascade.getAll().every((e) => e.invalidated), true);
});

test('BAT-089: deterministic evaluation returns SATISFIED when all required criteria met with valid evidence', () => {
  const contract = {
    id: 'GOAL-SAT',
    title: 'Satisfied Goal',
    acceptance_criteria: [
      { id: 'AC-1', title: 'Automated test suite passes', type: 'objective_check', required: true },
      { id: 'AC-2', title: 'Code review rubric signed off', type: 'subjective_judgment', required: true },
      { id: 'AC-3', title: 'Optional performance benchmark', type: 'objective_check', required: false },
    ],
  };

  const store = new EvidenceStore();
  store.add({
    criterion_id: 'AC-1',
    status: 'passed',
    git_binding: { commit: 'sha-main-1' },
    provenance: { evaluator_type: 'automated_test', evaluator_id: 'node-test' },
  });
  store.add({
    criterion_id: 'AC-2',
    status: 'passed',
    git_binding: { commit: 'sha-main-1' },
    provenance: { evaluator_type: 'agent', evaluator_id: 'agent-reviewer', role: 'verifier' },
  });

  const res = evaluateGoal(contract, store, { git: { commit: 'sha-main-1' } });
  assert.equal(res.status, GOAL_STATUS.SATISFIED);
  assert.equal(res.satisfiedCount, 2);
  assert.equal(res.requiredSatisfiedCount, 2);
  assert.equal(res.totalCount, 3);
  assert.deepEqual(res.unmetCriteria, ['AC-3'], 'Optional unmet criterion does not prevent SATISFIED');
  assert.equal(res.requiresHuman, false);
});

test('BAT-089: deterministic evaluation returns NEEDS_WORK when required criteria lack valid evidence or failed', () => {
  const contract = {
    id: 'GOAL-WORK',
    title: 'Needs Work Goal',
    acceptance_criteria: [
      { id: 'AC-1', title: 'Unit tests', type: 'objective_check', required: true },
      { id: 'AC-2', title: 'Lint clean', type: 'objective_check', required: true },
    ],
  };

  const store = new EvidenceStore();
  store.add({
    criterion_id: 'AC-1',
    status: 'passed',
    git_binding: { commit: 'sha-1' },
  });
  store.add({
    criterion_id: 'AC-2',
    status: 'failed',
    git_binding: { commit: 'sha-1' },
    details: { errors: ['Syntax error at line 4'] },
  });

  const res = evaluateGoal(contract, store, { git: { commit: 'sha-1' } });
  assert.equal(res.status, GOAL_STATUS.NEEDS_WORK);
  assert.equal(res.satisfiedCount, 1);
  assert.deepEqual(res.unmetCriteria, ['AC-2']);
  assert.equal(res.details.criteriaResults['AC-2'].status, 'failed');
});

test('BAT-089: deterministic evaluation returns NEEDS_HUMAN when all machine checks pass but manual approval is pending', () => {
  const contract = {
    id: 'GOAL-HUMAN',
    title: 'Needs Human Gate',
    acceptance_criteria: [
      { id: 'AC-1', title: 'Automated tests', type: 'objective_check', required: true },
      { id: 'AC-2', title: 'Security officer approval', type: 'manual_approval', required: true },
    ],
  };

  const store = new EvidenceStore();
  store.add({
    criterion_id: 'AC-1',
    status: 'passed',
    git_binding: { commit: 'sha-prod-1' },
  });

  // AC-2 has no evidence yet
  const res = evaluateGoal(contract, store, { git: { commit: 'sha-prod-1' } });
  assert.equal(res.status, GOAL_STATUS.NEEDS_HUMAN);
  assert.equal(res.requiresHuman, true);
  assert.equal(res.satisfiedCount, 1);
  assert.deepEqual(res.unmetCriteria, ['AC-2']);

  // Now submit manual approval
  store.add({
    criterion_id: 'AC-2',
    type: 'manual_approval',
    status: 'passed',
    git_binding: { commit: 'sha-prod-1' },
    provenance: { evaluator_type: 'human', evaluator_id: 'security-lead' },
  });

  const resAfterApproval = evaluateGoal(contract, store, { git: { commit: 'sha-prod-1' } });
  assert.equal(resAfterApproval.status, GOAL_STATUS.SATISFIED);
  assert.equal(resAfterApproval.requiresHuman, false);
});

test('BAT-089: evaluation returns BUDGET_EXHAUSTED when consumed resource limits are exceeded', () => {
  const contract = {
    id: 'GOAL-BUDGET',
    title: 'Budget Constrained',
    budget: {
      max_iterations: 5,
      max_seconds: 60,
      max_tokens: 10000,
      max_cost_cents: 50,
    },
    acceptance_criteria: [
      { id: 'AC-1', title: 'Test criterion' },
    ],
  };

  const store = new EvidenceStore();
  store.add({ criterion_id: 'AC-1', status: 'passed' });

  // Exceed iterations
  const resIter = evaluateGoal(contract, store, {
    budgetConsumed: { iterations: 6, seconds: 10, tokens: 100, cost_cents: 5 },
  });
  assert.equal(resIter.status, GOAL_STATUS.BUDGET_EXHAUSTED);
  assert.equal(resIter.details.budgetExceeded, true);

  // Exceed tokens
  const resTokens = evaluateGoal(contract, store, {
    budgetConsumed: { iterations: 2, seconds: 10, tokens: 20000, cost_cents: 5 },
  });
  assert.equal(resTokens.status, GOAL_STATUS.BUDGET_EXHAUSTED);

  // Exceed seconds
  const resSeconds = evaluateGoal(contract, store, {
    budgetConsumed: { iterations: 2, seconds: 75, tokens: 100, cost_cents: 5 },
  });
  assert.equal(resSeconds.status, GOAL_STATUS.BUDGET_EXHAUSTED);
});

test('BAT-089: evaluation returns FAILED when hard constraints are violated or fatal failure occurs', () => {
  const contract = {
    id: 'GOAL-HARD',
    title: 'Hard Constraint Test',
    constraints: [
      { id: 'C-NO-DEPS', description: 'Zero runtime dependencies', type: 'hard' },
      { id: 'C-DOCS', description: 'Docs updated', type: 'soft' },
    ],
    acceptance_criteria: [
      { id: 'AC-1', title: 'Everything passes' },
    ],
  };

  const store = new EvidenceStore();
  store.add({ criterion_id: 'AC-1', status: 'passed' });

  // Soft constraint violation does not fail the goal
  const resSoft = evaluateGoal(contract, store, {
    violatedConstraints: ['C-DOCS'],
  });
  assert.equal(resSoft.status, GOAL_STATUS.SATISFIED);

  // Hard constraint violation fails the goal
  const resHard = evaluateGoal(contract, store, {
    violatedConstraints: ['C-NO-DEPS'],
  });
  assert.equal(resHard.status, GOAL_STATUS.FAILED);
  assert.ok(resHard.details.violatedConstraints.some((v) => v.includes('C-NO-DEPS')));

  // Fatal criterion failure
  const storeFatal = new EvidenceStore();
  storeFatal.add({
    criterion_id: 'AC-1',
    status: 'failed',
    details: { fatal: true, message: 'Unrecoverable schema corruption' },
  });
  const resFatal = evaluateGoal(contract, storeFatal);
  assert.equal(resFatal.status, GOAL_STATUS.FAILED);
});

test('BAT-089: evaluation returns CANCELED when goal is canceled explicitly', () => {
  const contract = {
    id: 'GOAL-CANCEL',
    title: 'Cancel Test',
    acceptance_criteria: [
      { id: 'AC-1', title: 'Work' },
    ],
  };
  const store = new EvidenceStore();

  const resOption = evaluateGoal(contract, store, { isCanceled: true });
  assert.equal(resOption.status, GOAL_STATUS.CANCELED);

  const contractCanceled = { ...contract, status: GOAL_STATUS.CANCELED };
  const resContract = evaluateGoal(contractCanceled, store);
  assert.equal(resContract.status, GOAL_STATUS.CANCELED);
});

test('BAT-089: dependency ordering gates downstream criteria satisfaction', () => {
  const contract = {
    id: 'GOAL-GRAPH',
    title: 'Dependency Graph Test',
    acceptance_criteria: [
      { id: 'AC-BUILD', title: 'Build succeeds' },
      { id: 'AC-TEST', title: 'Unit tests run', depends_on: ['AC-BUILD'] },
      { id: 'AC-E2E', title: 'E2E tests run', depends_on: ['AC-TEST'] },
    ],
  };

  const store = new EvidenceStore();
  // Provide evidence for AC-TEST and AC-E2E, but NOT AC-BUILD
  store.add({ criterion_id: 'AC-TEST', status: 'passed' });
  store.add({ criterion_id: 'AC-E2E', status: 'passed' });

  const res1 = evaluateGoal(contract, store);
  assert.equal(res1.status, GOAL_STATUS.NEEDS_WORK);
  assert.equal(res1.details.criteriaResults['AC-BUILD'].status, 'missing');
  assert.equal(res1.details.criteriaResults['AC-TEST'].status, 'dependency_unmet');
  assert.equal(res1.details.criteriaResults['AC-E2E'].status, 'dependency_unmet');

  // Now satisfy AC-BUILD
  store.add({ criterion_id: 'AC-BUILD', status: 'passed' });
  const res2 = evaluateGoal(contract, store);
  assert.equal(res2.status, GOAL_STATUS.SATISFIED);
  assert.equal(res2.satisfiedCount, 3);
});

test('BAT-089: evaluator hooks registry allows custom evaluator hooks', () => {
  clearEvaluatorHooks();
  assert.equal(listEvaluatorHooks().length, 0);

  registerEvaluatorHook('npm-test-runner', (criterion, context) => ({
    status: 'passed',
    details: { passed: 42 },
  }));

  assert.equal(listEvaluatorHooks().includes('npm-test-runner'), true);
  const hook = getEvaluatorHook('npm-test-runner');
  assert.equal(typeof hook, 'function');

  const result = hook({ id: 'AC-1' }, {});
  assert.equal(result.status, 'passed');
  assert.equal(result.details.passed, 42);

  assert.throws(() => registerEvaluatorHook('', () => {}), /must be a non-empty string/);
  assert.throws(() => registerEvaluatorHook('bad', null), /must be a function/);

  clearEvaluatorHooks();
  assert.equal(listEvaluatorHooks().length, 0);
});

test('BAT-089: deterministic reproducibility across multiple evaluation runs', () => {
  const contract = {
    id: 'GOAL-REPRO',
    title: 'Deterministic Test',
    constraints: [{ id: 'C-1', description: 'Deterministic', type: 'hard' }],
    non_goals: ['Non-goal item'],
    acceptance_criteria: [
      { id: 'AC-A', title: 'Criterion A', required: true },
      { id: 'AC-B', title: 'Criterion B', required: true, depends_on: ['AC-A'] },
    ],
  };

  const store = new EvidenceStore([
    {
      criterion_id: 'AC-A',
      status: 'passed',
      git_binding: { commit: 'hash1' },
      env_hash: 'env1',
      timestamp: '2026-10-23T22:00:00Z',
    },
    {
      criterion_id: 'AC-B',
      status: 'passed',
      git_binding: { commit: 'hash1' },
      env_hash: 'env1',
      timestamp: '2026-10-23T22:05:00Z',
    },
  ]);

  const ctx = {
    currentTime: new Date('2026-10-23T22:10:00Z'),
    git: { commit: 'hash1' },
    envHash: 'env1',
  };

  const run1 = evaluateGoal(contract, store, ctx);
  const run2 = evaluateGoal(contract, store, ctx);

  assert.deepEqual(run1, run2, 'Subsequent evaluation runs with identical inputs must be strictly identical');
});
