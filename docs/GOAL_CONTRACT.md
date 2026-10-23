# Goal Contract & Evidence-Based Completion Evaluator Specification

**Version:** 1.0.0  
**Specification Key:** `BAT-089`  
**Status:** Canonical / Active  

---

## 1. Executive Summary

Autonomous agents collaborating on complex software engineering tasks must never rely on self-reported assertions or unverified claims to determine when a task or goal is complete. The **Agent Baton Goal Contract and Evidence-Based Completion Evaluator** establishes a deterministic, immutable, and versioned protocol for specifying goals and validating their completion.

Under this protocol:
1. **A Goal cannot transition to `SATISFIED` while any required criterion lacks valid, current, cryptographically bound evidence.**
2. **Evidence is strictly bound** to the git revision (commit SHA), execution environment hash, and provenance metadata (evaluator ID, evaluator type, session ID).
3. **Evidence automatically invalidates** when the underlying git revision changes, environment mutates, upstream dependencies change, or an optional time-to-live (TTL) expires.
4. **Terminal states** are evaluated with mathematical determinism, preventing race conditions, subjective hallucinations, and unverified handoffs.

---

## 2. Goal Contract Schema (`GOAL_CONTRACT_VERSION = '1.0.0'`)

A Goal Contract is a declarative specification of what must be achieved, the operational constraints and non-goals that bound the work, and the acceptance criteria that must be proven before completion.

### Contract Object Structure

```json
{
  "version": "1.0.0",
  "id": "GOAL-AUTH-V2",
  "title": "Migrate Session Authentication to Ed25519 Tokens",
  "description": "Refactor token signing to use Ed25519 with full test coverage and zero regressions.",
  "status": null,
  "constraints": [
    {
      "id": "C-ZERO-DEPS",
      "description": "No external runtime npm dependencies may be added",
      "type": "hard"
    },
    {
      "id": "C-BACKWARDS-COMPAT",
      "description": "Legacy token verification must remain supported until v2 deprecation",
      "type": "soft"
    }
  ],
  "non_goals": [
    "Do not implement OAuth2 provider endpoints in this phase",
    "Do not alter user profile database schemas"
  ],
  "budget": {
    "max_iterations": 15,
    "max_seconds": 3600,
    "max_tokens": 500000,
    "max_cost_cents": 1500
  },
  "acceptance_criteria": [
    {
      "id": "AC-TEST-UNIT",
      "title": "Unit tests pass with 100% assertion success",
      "type": "objective_check",
      "required": true,
      "depends_on": [],
      "evaluator": "node-test-runner"
    },
    {
      "id": "AC-SEC-REVIEW",
      "title": "Cryptographic review rubric signed off",
      "type": "subjective_judgment",
      "required": true,
      "depends_on": ["AC-TEST-UNIT"],
      "evaluator": "security-reviewer"
    },
    {
      "id": "AC-HUMAN-GATE",
      "title": "Production migration clearance by SecOps lead",
      "type": "manual_approval",
      "required": true,
      "depends_on": ["AC-SEC-REVIEW"],
      "evaluator": "human-gatekeeper"
    }
  ],
  "metadata": {
    "epic": "AUTH-2026",
    "owner": "security-team"
  }
}
```

### Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | String | Yes | Goal contract schema version; must equal `'1.0.0'`. |
| `id` | String | Yes | Unique identifier (e.g., `GOAL-001`). |
| `title` | String | Yes | Clear, concise description of the objective. |
| `description` | String | No | Detailed specification, motivation, and context. |
| `status` | String | No | Optional override status (e.g., `'CANCELED'`). |
| `constraints` | Array\<Constraint\> | No | Invariants and operational guardrails. |
| `non_goals` | Array\<String\> | No | Explicitly excluded scope to prevent creep. |
| `budget` | Budget | No | Resource bounds (iterations, seconds, tokens, cost). |
| `acceptance_criteria` | Array\<Criterion\> | Yes | Acceptance criteria that must be satisfied. |
| `metadata` | Object | No | Key-value pairs for integration and tracking. |

---

## 3. Acceptance Criteria & Evidence Models

### 3.1 Criterion Types

| Criterion Type | Key | Description | Typical Evaluator |
|---|---|---|---|
| **Objective Check** | `objective_check` | Deterministic verification through automated tests, linters, exit codes, or byte-for-byte comparisons. | Automated test suite, CLI compiler, linter. |
| **Subjective Judgment** | `subjective_judgment` | Structured qualitative evaluation against architectural, UX, or security rubrics. | Specialized reviewer agent or peer auditor. |
| **Manual / External Approval** | `manual_approval` / `external_approval` | Explicit authorization or compliance sign-off required from a designated human gatekeeper. | Human team lead, security officer, release manager. |

### 3.2 Evidence Submission Schema

Every assertion submitted to satisfy a criterion must be encapsulated in a structured evidence record:

```json
{
  "id": "EVD-a9f4c3b2180e",
  "criterion_id": "AC-TEST-UNIT",
  "type": "objective_check",
  "status": "passed",
  "provenance": {
    "evaluator_id": "agent-qa-4",
    "evaluator_type": "automated_test",
    "role": "verifier",
    "session_id": "sess-20261023-01",
    "run_id": "run-4029"
  },
  "timestamp": "2026-10-23T22:15:00Z",
  "git_binding": {
    "commit": "c12ef56949d68445dc55a80a370f146222e51b45",
    "branch": "main",
    "tree_sha": "d8e3b1c97a2..."
  },
  "env_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "expires_at": "2026-10-24T22:15:00Z",
  "details": {
    "passed_count": 15,
    "failed_count": 0,
    "duration_ms": 128,
    "output_summary": "All unit tests completed with zero errors."
  },
  "invalidated": false,
  "invalidation_reason": null
}
```

---

## 4. Evidence Invalidation Protocol

Evidence is transient and conditional. It remains valid **only** as long as the underlying workspace state has not changed.

### Invalidation Triggers

```
                         [ New Evidence Submitted ]
                                     │
                                     ▼
                      ┌─────────────────────────────┐
                      │    Valid for Criterion      │
                      └──────────────┬──────────────┘
                                     │
      ┌──────────────────────────────┼──────────────────────────────┐
      │                              │                              │
      ▼                              ▼                              ▼
[ Git Revision Changes ]   [ Environment Mutates ]        [ TTL Expiry Passes ]
(commit SHA mismatch)     (OS, Node, env_hash change)     (now >= expires_at)
      │                              │                              │
      └──────────────────────────────┼──────────────────────────────┘
                                     ▼
                      ┌─────────────────────────────┐
                      │    EVIDENCE INVALIDATED     │
                      └──────────────┬──────────────┘
                                     │
                                     ▼
                      [ Cascade to Downstream Criteria ]
                      (Criteria depending on this one
                       are marked unmet)
```

1. **Git Revision Mismatch (`GIT_REVISION_MISMATCH`):**
   If evidence was produced against commit `A`, and the workspace advances to commit `B`, the evidence is immediately considered stale and will not satisfy the criterion under commit `B`.
2. **Environment Hash Mismatch (`ENV_HASH_MISMATCH`):**
   Computed via `computeEnvironmentHash(envConfig)`:
   $$\text{env\_hash} = \text{SHA256}(\text{canonicalJson}(\text{envConfig}))$$
   If Node version, platform, arch, or critical environment variables change, evidence is invalidated.
3. **Time-To-Live Expiration (`EVIDENCE_EXPIRED`):**
   If `expires_at` is specified and current evaluation timestamp exceeds it, the evidence is expired.
4. **Dependency Cascades (`DEPENDENCY_MUTATED`):**
   If criterion `AC-B` depends on `AC-A`, mutating or invalidating `AC-A` automatically cascades invalidation to `AC-B`.
5. **Non-Passing Evidence Status:**
   Submissions with status `failed`, `inconclusive`, or `pending` cannot satisfy a criterion.

---

## 5. Lifecycle State Machine & Terminal Evaluation

The evaluator function `evaluateGoal(contract, evidenceStore, options)` evaluates the current state and returns one of six deterministic terminal/lifecycle states:

```
                      ┌───────────────────────────┐
                      │    Goal Contract Input    │
                      └─────────────┬─────────────┘
                                    │
                         Is Canceled explicitly?
                                    ├──────────────────────────► [ CANCELED ]
                                    │ No
                        Budget limits exceeded?
                                    ├──────────────────────────► [ BUDGET_EXHAUSTED ]
                                    │ No
                       Hard constraint violated?
                                    ├──────────────────────────► [ FAILED ]
                                    │ No
                    Evaluate Acceptance Criteria
                                    │
           ┌────────────────────────┴────────────────────────┐
           ▼                                                 ▼
All required criteria satisfied?             Any required criteria unmet?
           │ Yes                                             │ Yes
           ▼                                                 │
     [ SATISFIED ]                        Only human approval remaining?
                                                    ├────────► [ NEEDS_HUMAN ]
                                                    │ No
                                                    └────────► [ NEEDS_WORK ]
```

### State Definitions

| State | Classification | Entry Conditions |
|---|---|---|
| `SATISFIED` | Terminal (Success) | 100% of required acceptance criteria possess valid, current, non-expired evidence bound to the active git commit and environment hash. No hard constraints violated. |
| `NEEDS_WORK` | Iteration Required | One or more required criteria have failed, have missing evidence, or have stale/invalidated evidence, and non-human remediation is required. |
| `NEEDS_HUMAN` | Gated / Pending Auth | All automated and objective checks pass, but one or more required criteria require manual/human approval (or a reviewer flagged human review). |
| `BUDGET_EXHAUSTED` | Terminal (Resource Limit) | Consumed iterations, duration, tokens, or financial cost exceeds the ceiling defined in `contract.budget`. |
| `FAILED` | Terminal (Violation) | A hard constraint is violated, or a criterion reports an unrecoverable fatal failure. |
| `CANCELED` | Terminal (Aborted) | The contract or execution context was explicitly marked canceled by an operator. |

---

## 6. JavaScript / Node.js Engine API

The module `src/lib/goal.js` provides a zero-dependency ESM API:

### Evaluation Call Example

```js
import {
  evaluateGoal,
  EvidenceStore,
  computeEnvironmentHash,
  GOAL_STATUS,
} from './src/lib/goal.js';

// 1. Initialize evidence store
const store = new EvidenceStore();

// 2. Add verified evidence
store.add({
  criterion_id: 'AC-TEST-UNIT',
  status: 'passed',
  provenance: { evaluator_type: 'automated_test', evaluator_id: 'test-runner' },
  git_binding: { commit: 'c12ef56949d68445dc55a80a370f146222e51b45' },
  env_hash: computeEnvironmentHash(),
});

// 3. Evaluate goal
const result = evaluateGoal(goalContract, store, {
  git: { commit: 'c12ef56949d68445dc55a80a370f146222e51b45' },
  envHash: computeEnvironmentHash(),
  budgetConsumed: { iterations: 3, seconds: 45, tokens: 12000, cost_cents: 35 },
});

console.log(result.status); // SATISFIED, NEEDS_WORK, NEEDS_HUMAN, etc.
console.log(result.satisfiedCount, result.totalCount);
console.log(result.unmetCriteria);
```

### Evaluator Hook Registry

Custom automated evaluators (e.g. CI test runners, linter checks, benchmark profilers) can be registered into the evaluator registry:

```js
import { registerEvaluatorHook, getEvaluatorHook } from './src/lib/goal.js';

registerEvaluatorHook('node-test-runner', async (criterion, context) => {
  // Execute test command and produce evidence payload
  return {
    criterion_id: criterion.id,
    status: 'passed',
    details: { passed: 42, failed: 0 }
  };
});
```

---

## 7. Integration with Agent Baton Plans & Worktrees

- **Packet-to-Criterion Mapping:** Baton packets can define `done_checks` that directly reference Goal Acceptance Criteria IDs (`criterion_id`).
- **Worktree Verification Gate:** Before merging or signing off a worktree branch, the orchestrator invokes `evaluateGoal()`. If status is `NEEDS_WORK` or `NEEDS_HUMAN`, the branch merge is blocked.
- **Audit Trails:** Serialized `EvidenceStore` exports are persisted in the append-only event ledger under `.baton/state/` to form an unforgeable compliance audit trail.
