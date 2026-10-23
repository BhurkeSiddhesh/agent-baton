import { BatonError } from './errors.js';
import { sha256, canonicalJson, utcnow, stamp, parseTime } from './util.js';

export const GOAL_CONTRACT_VERSION = '1.0.0';

/**
 * Terminal and lifecycle states for a goal.
 */
export const GOAL_STATUS = Object.freeze({
  SATISFIED: 'SATISFIED',
  NEEDS_WORK: 'NEEDS_WORK',
  NEEDS_HUMAN: 'NEEDS_HUMAN',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
});

/**
 * Recognized evidence types.
 */
export const EVIDENCE_TYPE = Object.freeze({
  OBJECTIVE_CHECK: 'objective_check',
  SUBJECTIVE_JUDGMENT: 'subjective_judgment',
  MANUAL_APPROVAL: 'manual_approval',
  EXTERNAL_APPROVAL: 'external_approval',
});

/**
 * Possible status values for individual evidence submissions.
 */
export const EVIDENCE_STATUS = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  INCONCLUSIVE: 'inconclusive',
  PENDING: 'pending',
});

/**
 * Constraint enforcement types.
 */
export const CONSTRAINT_TYPE = Object.freeze({
  HARD: 'hard',
  SOFT: 'soft',
});

/**
 * Computes a deterministic SHA-256 hash of the execution environment.
 * If no object is provided, collects standard runtime markers (node version, platform, arch).
 * @param {Record<string, any>} [customEnv]
 * @returns {string}
 */
export function computeEnvironmentHash(customEnv = null) {
  const envObj = customEnv && typeof customEnv === 'object'
    ? customEnv
    : {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      };
  return sha256(canonicalJson(envObj));
}

/**
 * Normalizes an acceptance criterion.
 * @param {any} c
 * @returns {object}
 */
export function normalizeCriterion(c) {
  if (!c || typeof c !== 'object') {
    throw new BatonError('Criterion must be an object', { code: 'INVALID_CRITERION' });
  }
  if (!c.id || typeof c.id !== 'string') {
    throw new BatonError('Criterion requires a non-empty string id', { code: 'INVALID_CRITERION' });
  }
  return {
    id: c.id,
    title: c.title ?? c.id,
    description: c.description ?? '',
    type: c.type ?? EVIDENCE_TYPE.OBJECTIVE_CHECK,
    required: c.required !== false,
    evaluator: c.evaluator ?? null,
    depends_on: Array.isArray(c.depends_on) ? [...c.depends_on] : [],
    metadata: c.metadata && typeof c.metadata === 'object' ? { ...c.metadata } : {},
  };
}

/**
 * Normalizes a constraint definition.
 * @param {any} c
 * @returns {object}
 */
export function normalizeConstraint(c) {
  if (!c || typeof c !== 'object') {
    throw new BatonError('Constraint must be an object', { code: 'INVALID_CONSTRAINT' });
  }
  return {
    id: c.id ?? '',
    description: c.description ?? '',
    type: c.type === CONSTRAINT_TYPE.SOFT ? CONSTRAINT_TYPE.SOFT : CONSTRAINT_TYPE.HARD,
    metadata: c.metadata && typeof c.metadata === 'object' ? { ...c.metadata } : {},
  };
}

/**
 * Normalizes a goal budget.
 * @param {any} b
 * @returns {object}
 */
export function normalizeBudget(b) {
  const src = b && typeof b === 'object' ? b : {};
  return {
    max_iterations: Number.isFinite(src.max_iterations) ? src.max_iterations : null,
    max_seconds: Number.isFinite(src.max_seconds) ? src.max_seconds : null,
    max_tokens: Number.isFinite(src.max_tokens) ? src.max_tokens : null,
    max_cost_cents: Number.isFinite(src.max_cost_cents) ? src.max_cost_cents : null,
  };
}

/**
 * Normalizes a goal contract, applying defaults.
 * @param {any} raw
 * @returns {object}
 */
export function normalizeGoalContract(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new BatonError('Goal contract must be an object', { code: 'INVALID_GOAL_CONTRACT' });
  }
  return {
    version: raw.version ?? GOAL_CONTRACT_VERSION,
    id: raw.id ?? '',
    title: raw.title ?? '',
    description: raw.description ?? '',
    status: raw.status ?? null,
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map(normalizeConstraint) : [],
    non_goals: Array.isArray(raw.non_goals) ? [...raw.non_goals].map(String) : [],
    budget: normalizeBudget(raw.budget),
    acceptance_criteria: Array.isArray(raw.acceptance_criteria)
      ? raw.acceptance_criteria.map(normalizeCriterion)
      : [],
    metadata: raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
  };
}

/**
 * Validates a goal contract against structural invariants.
 * @param {any} raw
 * @returns {object}
 */
export function validateGoalContract(raw) {
  const contract = normalizeGoalContract(raw);

  if (!contract.id || typeof contract.id !== 'string') {
    throw new BatonError('Goal contract id must be a non-empty string', { code: 'INVALID_GOAL_ID' });
  }
  if (!contract.title || typeof contract.title !== 'string') {
    throw new BatonError('Goal contract title must be a non-empty string', { code: 'INVALID_GOAL_TITLE' });
  }
  if (contract.version !== GOAL_CONTRACT_VERSION) {
    throw new BatonError(`Unsupported goal contract version: ${contract.version}. Expected ${GOAL_CONTRACT_VERSION}`, {
      code: 'UNSUPPORTED_VERSION',
    });
  }
  if (!Array.isArray(contract.acceptance_criteria) || contract.acceptance_criteria.length === 0) {
    throw new BatonError('Goal contract must define at least one acceptance criterion', {
      code: 'MISSING_CRITERIA',
    });
  }

  // Ensure unique criterion IDs
  const seenCriterionIds = new Set();
  for (const c of contract.acceptance_criteria) {
    if (seenCriterionIds.has(c.id)) {
      throw new BatonError(`Duplicate criterion ID: ${c.id}`, { code: 'DUPLICATE_CRITERION_ID' });
    }
    seenCriterionIds.add(c.id);
  }

  // Ensure criterion dependencies exist
  for (const c of contract.acceptance_criteria) {
    for (const depId of c.depends_on) {
      if (!seenCriterionIds.has(depId)) {
        throw new BatonError(`Criterion ${c.id} depends on unknown criterion ${depId}`, {
          code: 'UNKNOWN_CRITERION_DEPENDENCY',
        });
      }
      if (depId === c.id) {
        throw new BatonError(`Criterion ${c.id} cannot depend on itself`, {
          code: 'CIRCULAR_DEPENDENCY',
        });
      }
    }
  }

  return contract;
}

/**
 * Normalizes an evidence submission object.
 * @param {any} raw
 * @returns {object}
 */
export function normalizeEvidence(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new BatonError('Evidence must be an object', { code: 'INVALID_EVIDENCE' });
  }

  const prov = raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {};
  const git = raw.git_binding && typeof raw.git_binding === 'object' ? raw.git_binding : {};

  return {
    id: raw.id ?? `EVD-${sha256(canonicalJson({ ...raw, timestamp: raw.timestamp || stamp() })).slice(0, 12)}`,
    criterion_id: raw.criterion_id ?? '',
    type: raw.type ?? EVIDENCE_TYPE.OBJECTIVE_CHECK,
    status: raw.status ?? EVIDENCE_STATUS.PASSED,
    provenance: {
      evaluator_id: prov.evaluator_id ?? 'unknown',
      evaluator_type: prov.evaluator_type ?? 'agent',
      role: prov.role ?? 'evaluator',
      session_id: prov.session_id ?? null,
      run_id: prov.run_id ?? null,
    },
    timestamp: raw.timestamp ?? stamp(),
    git_binding: {
      commit: git.commit ?? null,
      branch: git.branch ?? null,
      tree_sha: git.tree_sha ?? null,
    },
    env_hash: raw.env_hash ?? null,
    expires_at: raw.expires_at ?? null,
    details: raw.details && typeof raw.details === 'object' ? { ...raw.details } : {},
    invalidated: Boolean(raw.invalidated),
    invalidation_reason: raw.invalidation_reason ?? null,
  };
}

/**
 * Validates an evidence submission object.
 * @param {any} raw
 * @returns {object}
 */
export function validateEvidence(raw) {
  const ev = normalizeEvidence(raw);

  if (!ev.criterion_id) {
    throw new BatonError('Evidence must reference a non-empty criterion_id', { code: 'INVALID_EVIDENCE' });
  }
  if (!Object.values(EVIDENCE_STATUS).includes(ev.status)) {
    throw new BatonError(`Invalid evidence status: ${ev.status}`, { code: 'INVALID_EVIDENCE_STATUS' });
  }
  if (!ev.timestamp || !parseTime(ev.timestamp)) {
    throw new BatonError(`Invalid evidence timestamp: ${ev.timestamp}`, { code: 'INVALID_TIMESTAMP' });
  }
  if (ev.expires_at && !parseTime(ev.expires_at)) {
    throw new BatonError(`Invalid evidence expires_at timestamp: ${ev.expires_at}`, { code: 'INVALID_EXPIRY' });
  }

  return ev;
}

/**
 * Checks if an evidence item is valid and satisfies a given criterion under execution context.
 * Returns detailed validity check status and reason.
 * @param {object} evidence
 * @param {object} criterion
 * @param {object} [context]
 * @returns {{ valid: boolean, reason: string|null }}
 */
export function checkEvidenceValidity(evidence, criterion, context = {}) {
  if (!evidence) {
    return { valid: false, reason: 'NO_EVIDENCE' };
  }

  if (evidence.criterion_id !== criterion.id) {
    return { valid: false, reason: 'CRITERION_MISMATCH' };
  }

  if (evidence.invalidated) {
    return { valid: false, reason: evidence.invalidation_reason || 'EXPLICITLY_INVALIDATED' };
  }

  if (evidence.status !== EVIDENCE_STATUS.PASSED) {
    return { valid: false, reason: `EVIDENCE_STATUS_${evidence.status.toUpperCase()}` };
  }

  const now = context.currentTime ? (context.currentTime instanceof Date ? context.currentTime : parseTime(context.currentTime)) : utcnow();

  // Expiration check (TTL)
  if (evidence.expires_at) {
    const expiry = parseTime(evidence.expires_at);
    if (expiry && now && expiry.getTime() <= now.getTime()) {
      return { valid: false, reason: 'EVIDENCE_EXPIRED' };
    }
  }

  // Git commit revision binding check
  const currentCommit = context.git?.commit ?? context.gitCommit;
  if (currentCommit && evidence.git_binding?.commit) {
    if (evidence.git_binding.commit !== currentCommit) {
      return { valid: false, reason: 'GIT_REVISION_MISMATCH' };
    }
  }

  // Environment hash check
  const currentEnvHash = context.envHash ?? context.env_hash;
  if (currentEnvHash && evidence.env_hash) {
    if (evidence.env_hash !== currentEnvHash) {
      return { valid: false, reason: 'ENV_HASH_MISMATCH' };
    }
  }

  // Upstream dependency check
  if (Array.isArray(criterion.depends_on) && criterion.depends_on.length > 0) {
    const satisfiedSet = context.satisfiedCriteria instanceof Set
      ? context.satisfiedCriteria
      : new Set(context.satisfiedCriteria || []);
    for (const depId of criterion.depends_on) {
      if (!satisfiedSet.has(depId)) {
        return { valid: false, reason: `DEPENDENCY_UNSATISFIED_${depId}` };
      }
    }
  }

  return { valid: true, reason: null };
}

/**
 * Returns a boolean indicating whether an evidence item is currently valid for a criterion.
 * @param {object} evidence
 * @param {object} criterion
 * @param {object} [context]
 * @returns {boolean}
 */
export function isEvidenceValid(evidence, criterion, context = {}) {
  return checkEvidenceValidity(evidence, criterion, context).valid;
}

/**
 * EvidenceStore manages recorded evidence items and invalidation lifecycles.
 */
export class EvidenceStore {
  /**
   * @param {Array<any>} [initialEntries]
   */
  constructor(initialEntries = []) {
    this.entries = [];
    if (Array.isArray(initialEntries)) {
      for (const item of initialEntries) {
        this.add(item);
      }
    }
  }

  /**
   * Record a new evidence entry.
   * @param {any} raw
   * @returns {object}
   */
  add(raw) {
    const ev = validateEvidence(raw);
    this.entries.push(ev);
    return ev;
  }

  /**
   * Return all stored evidence entries.
   * @returns {Array<object>}
   */
  getAll() {
    return [...this.entries];
  }

  /**
   * Retrieve all entries for a specific criterion ID.
   * @param {string} criterionId
   * @returns {Array<object>}
   */
  getByCriterion(criterionId) {
    return this.entries.filter((e) => e.criterion_id === criterionId);
  }

  /**
   * Retrieve the most recently submitted evidence for a criterion ID.
   * @param {string} criterionId
   * @returns {object|null}
   */
  getLatest(criterionId) {
    const items = this.getByCriterion(criterionId);
    return items.length > 0 ? items[items.length - 1] : null;
  }

  /**
   * Retrieve the most recent valid evidence item satisfying the given criterion.
   * @param {object} criterion
   * @param {object} [context]
   * @returns {object|null}
   */
  getLatestValid(criterion, context = {}) {
    const items = this.getByCriterion(criterion.id);
    for (let i = items.length - 1; i >= 0; i--) {
      if (isEvidenceValid(items[i], criterion, context)) {
        return items[i];
      }
    }
    return null;
  }

  /**
   * Invalidate matching evidence entries.
   * @param {string|((ev: object) => boolean)|object} matcher
   * @param {string} [reason]
   * @returns {number} count of entries marked invalidated
   */
  invalidate(matcher, reason = 'manual_invalidation') {
    let count = 0;
    for (const ev of this.entries) {
      if (ev.invalidated) continue;
      let matches = false;
      if (typeof matcher === 'string') {
        matches = ev.id === matcher || ev.criterion_id === matcher;
      } else if (typeof matcher === 'function') {
        matches = Boolean(matcher(ev));
      } else if (matcher && typeof matcher === 'object') {
        if (matcher.criterion_id && ev.criterion_id === matcher.criterion_id) matches = true;
        if (matcher.git_commit && ev.git_binding?.commit === matcher.git_commit) matches = true;
        if (matcher.id && ev.id === matcher.id) matches = true;
      }

      if (matches) {
        ev.invalidated = true;
        ev.invalidation_reason = reason;
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate entries on git commit changes.
   * @param {string} currentCommit
   * @param {string} [reason]
   * @returns {number}
   */
  invalidateOnGitChange(currentCommit, reason = 'GIT_REVISION_CHANGED') {
    if (!currentCommit) return 0;
    return this.invalidate((e) => Boolean(e.git_binding?.commit && e.git_binding.commit !== currentCommit), reason);
  }

  /**
   * Invalidate entries on environment changes.
   * @param {string} currentEnvHash
   * @param {string} [reason]
   * @returns {number}
   */
  invalidateOnEnvChange(currentEnvHash, reason = 'ENV_HASH_CHANGED') {
    if (!currentEnvHash) return 0;
    return this.invalidate((e) => Boolean(e.env_hash && e.env_hash !== currentEnvHash), reason);
  }

  /**
   * Invalidate downstream criteria evidence when dependencies mutate.
   * @param {object} goalContract
   * @param {string|Array<string>} modifiedCriterionIds
   * @param {string} [reason]
   * @returns {number}
   */
  invalidateOnDependencyChange(goalContract, modifiedCriterionIds, reason = 'DEPENDENCY_MUTATED') {
    const directSet = new Set(Array.isArray(modifiedCriterionIds) ? modifiedCriterionIds : [modifiedCriterionIds]);
    const cascadeSet = new Set(directSet);
    const contract = normalizeGoalContract(goalContract);

    let changed = true;
    while (changed) {
      changed = false;
      for (const c of contract.acceptance_criteria) {
        if (!cascadeSet.has(c.id)) {
          const hasDep = c.depends_on.some((depId) => cascadeSet.has(depId));
          if (hasDep) {
            cascadeSet.add(c.id);
            changed = true;
          }
        }
      }
    }

    return this.invalidate((e) => cascadeSet.has(e.criterion_id), reason);
  }

  /**
   * Export internal state to a plain serializable JSON object.
   * @returns {Array<object>}
   */
  toJSON() {
    return this.getAll();
  }
}

/**
 * Registry for evaluator hooks.
 */
const hookRegistry = new Map();

/**
 * Registers an evaluator hook function.
 * @param {string} name
 * @param {(criterion: object, context: object) => any} fn
 */
export function registerEvaluatorHook(name, fn) {
  if (!name || typeof name !== 'string') {
    throw new BatonError('Evaluator hook name must be a non-empty string', { code: 'INVALID_HOOK_NAME' });
  }
  if (typeof fn !== 'function') {
    throw new BatonError(`Evaluator hook for '${name}' must be a function`, { code: 'INVALID_HOOK_FN' });
  }
  hookRegistry.set(name, fn);
}

/**
 * Retrieves a registered evaluator hook.
 * @param {string} name
 * @returns {((criterion: object, context: object) => any)|null}
 */
export function getEvaluatorHook(name) {
  return hookRegistry.get(name) || null;
}

/**
 * Clears all registered evaluator hooks.
 */
export function clearEvaluatorHooks() {
  hookRegistry.clear();
}

/**
 * Lists the names of all registered evaluator hooks.
 * @returns {Array<string>}
 */
export function listEvaluatorHooks() {
  return Array.from(hookRegistry.keys());
}

/**
 * Evaluates a goal contract deterministically against an evidence store and execution context.
 *
 * @param {any} goalContractInput
 * @param {EvidenceStore|Array<any>} evidenceStoreInput
 * @param {object} [options]
 * @returns {object} Evaluation result with status, counts, unmet criteria, requiresHuman, and details.
 */
export function evaluateGoal(goalContractInput, evidenceStoreInput, options = {}) {
  const contract = validateGoalContract(goalContractInput);
  const store = evidenceStoreInput instanceof EvidenceStore
    ? evidenceStoreInput
    : new EvidenceStore(Array.isArray(evidenceStoreInput) ? evidenceStoreInput : []);

  const evalTime = options.currentTime
    ? (options.currentTime instanceof Date ? options.currentTime : parseTime(options.currentTime) || utcnow())
    : utcnow();
  const evalStamp = stamp(evalTime);

  const context = {
    ...options,
    currentTime: evalTime,
    git: options.git || (options.gitCommit ? { commit: options.gitCommit } : null),
    envHash: options.envHash || options.env_hash || null,
    satisfiedCriteria: new Set(),
  };

  const reasons = [];
  const details = {
    contract: {
      id: contract.id,
      title: contract.title,
      version: contract.version,
    },
    criteriaResults: {},
    budgetConsumed: options.budgetConsumed || options.budget_consumed || null,
    budgetExceeded: false,
    violatedConstraints: [],
    reasons: [],
  };

  // 1. CANCELED state check
  if (options.isCanceled === true || options.is_canceled === true || contract.status === GOAL_STATUS.CANCELED) {
    const summary = `Goal '${contract.id}' is CANCELED.`;
    return createResult(GOAL_STATUS.CANCELED, contract, 0, 0, contract.acceptance_criteria.length, contract.acceptance_criteria.map((c) => c.id), false, {
      ...details,
      summary,
      reasons: ['Goal was explicitly canceled.'],
    });
  }

  // 2. BUDGET EXHAUSTION check
  const budget = contract.budget;
  const consumed = options.budgetConsumed || options.budget_consumed || {};
  let budgetExhausted = false;
  const budgetViolations = [];

  if (budget.max_iterations != null && (consumed.iterations ?? 0) > budget.max_iterations) {
    budgetExhausted = true;
    budgetViolations.push(`iterations consumed (${consumed.iterations}) exceeded limit (${budget.max_iterations})`);
  }
  if (budget.max_seconds != null && (consumed.seconds ?? 0) > budget.max_seconds) {
    budgetExhausted = true;
    budgetViolations.push(`seconds consumed (${consumed.seconds}s) exceeded limit (${budget.max_seconds}s)`);
  }
  if (budget.max_tokens != null && (consumed.tokens ?? 0) > budget.max_tokens) {
    budgetExhausted = true;
    budgetViolations.push(`tokens consumed (${consumed.tokens}) exceeded limit (${budget.max_tokens})`);
  }
  if (budget.max_cost_cents != null && (consumed.cost_cents ?? 0) > budget.max_cost_cents) {
    budgetExhausted = true;
    budgetViolations.push(`cost consumed (${consumed.cost_cents}¢) exceeded limit (${budget.max_cost_cents}¢)`);
  }

  if (budgetExhausted) {
    details.budgetExceeded = true;
    details.reasons.push(...budgetViolations);
    const summary = `Budget exhausted for goal '${contract.id}': ${budgetViolations.join('; ')}`;
    return createResult(
      GOAL_STATUS.BUDGET_EXHAUSTED,
      contract,
      0,
      0,
      contract.acceptance_criteria.length,
      contract.acceptance_criteria.map((c) => c.id),
      false,
      { ...details, summary }
    );
  }

  // 3. HARD CONSTRAINT check
  const violatedConstraintsInput = Array.isArray(options.violatedConstraints) ? options.violatedConstraints : [];
  const violatedSet = new Set(violatedConstraintsInput);
  const hardViolations = [];

  for (const constraint of contract.constraints) {
    if (constraint.type === CONSTRAINT_TYPE.HARD && violatedSet.has(constraint.id)) {
      hardViolations.push(`Hard constraint violated: [${constraint.id}] ${constraint.description || constraint.id}`);
    }
  }

  if (hardViolations.length > 0) {
    details.violatedConstraints = hardViolations;
    details.reasons.push(...hardViolations);
    const summary = `Hard constraints violated for goal '${contract.id}': ${hardViolations.join('; ')}`;
    return createResult(
      GOAL_STATUS.FAILED,
      contract,
      0,
      0,
      contract.acceptance_criteria.length,
      contract.acceptance_criteria.map((c) => c.id),
      false,
      { ...details, summary }
    );
  }

  // 4. CRITERIA EVALUATION (topological / dependency-aware ordering)
  const criteriaMap = new Map(contract.acceptance_criteria.map((c) => [c.id, c]));
  const evaluatedOrder = resolveCriteriaOrder(contract.acceptance_criteria);

  let satisfiedCount = 0;
  let requiredSatisfiedCount = 0;
  let totalRequiredCount = 0;
  const unmetCriteria = [];
  const unmetRequiredCriteria = [];
  let requiresHuman = false;
  let hasTerminalFatalError = false;

  for (const criterion of evaluatedOrder) {
    if (criterion.required) {
      totalRequiredCount++;
    }

    // Check upstream dependencies
    let dependenciesMet = true;
    let unsatisfiedDepId = null;
    for (const depId of criterion.depends_on) {
      if (!context.satisfiedCriteria.has(depId)) {
        dependenciesMet = false;
        unsatisfiedDepId = depId;
        break;
      }
    }

    let criterionResult = {
      criterion_id: criterion.id,
      title: criterion.title,
      type: criterion.type,
      required: criterion.required,
      satisfied: false,
      status: 'missing',
      evidence: null,
      reason: null,
    };

    if (!dependenciesMet) {
      criterionResult.status = 'dependency_unmet';
      criterionResult.reason = `Upstream dependency '${unsatisfiedDepId}' is not satisfied`;
    } else {
      // Find latest valid evidence
      const validEvidence = store.getLatestValid(criterion, context);
      if (validEvidence) {
        criterionResult.satisfied = true;
        criterionResult.status = 'satisfied';
        criterionResult.evidence = validEvidence;
        context.satisfiedCriteria.add(criterion.id);
        satisfiedCount++;
        if (criterion.required) {
          requiredSatisfiedCount++;
        }
      } else {
        // Inspect the latest evidence (even if invalid/failed) to diagnose why
        const latestAny = store.getLatest(criterion.id);
        if (latestAny) {
          criterionResult.evidence = latestAny;
          const validity = checkEvidenceValidity(latestAny, criterion, context);
          criterionResult.reason = validity.reason;
          if (latestAny.status === EVIDENCE_STATUS.FAILED) {
            criterionResult.status = 'failed';
            if (latestAny.details?.fatal === true) {
              hasTerminalFatalError = true;
            }
          } else if (latestAny.status === EVIDENCE_STATUS.INCONCLUSIVE) {
            criterionResult.status = 'inconclusive';
          } else if (validity.reason === 'EVIDENCE_EXPIRED') {
            criterionResult.status = 'expired';
          } else if (validity.reason === 'GIT_REVISION_MISMATCH') {
            criterionResult.status = 'stale_git';
          } else if (validity.reason === 'ENV_HASH_MISMATCH') {
            criterionResult.status = 'stale_env';
          } else {
            criterionResult.status = 'invalid';
          }
        } else {
          criterionResult.status = 'missing';
          criterionResult.reason = 'No evidence recorded for criterion';
        }
      }
    }

    // Human involvement check
    if (!criterionResult.satisfied && criterion.required) {
      if (
        criterion.type === EVIDENCE_TYPE.MANUAL_APPROVAL ||
        criterion.type === EVIDENCE_TYPE.EXTERNAL_APPROVAL ||
        criterion.metadata?.requires_human === true ||
        criterionResult.evidence?.details?.requires_human === true
      ) {
        requiresHuman = true;
      }
    }

    if (!criterionResult.satisfied) {
      unmetCriteria.push(criterion.id);
      if (criterion.required) {
        unmetRequiredCriteria.push(criterion.id);
      }
    }

    details.criteriaResults[criterion.id] = criterionResult;
  }

  // 5. DETERMINE FINAL STATUS
  let finalStatus;
  if (hasTerminalFatalError) {
    finalStatus = GOAL_STATUS.FAILED;
    details.reasons.push('Criterion reported unrecoverable fatal failure.');
  } else if (unmetRequiredCriteria.length === 0) {
    finalStatus = GOAL_STATUS.SATISFIED;
  } else {
    // Check if remaining unmet required criteria are only waiting on human/manual approval
    const nonHumanBlockers = unmetRequiredCriteria.filter((id) => {
      const c = criteriaMap.get(id);
      const res = details.criteriaResults[id];
      const isManual = c.type === EVIDENCE_TYPE.MANUAL_APPROVAL || c.type === EVIDENCE_TYPE.EXTERNAL_APPROVAL;
      return !isManual && !c.metadata?.requires_human;
    });

    if (nonHumanBlockers.length === 0 && requiresHuman) {
      finalStatus = GOAL_STATUS.NEEDS_HUMAN;
    } else {
      finalStatus = GOAL_STATUS.NEEDS_WORK;
    }
  }

  const summary = `Goal '${contract.id}': ${finalStatus} (${satisfiedCount}/${contract.acceptance_criteria.length} criteria satisfied, ${unmetRequiredCriteria.length} required unmet).`;
  details.summary = summary;

  return createResult(
    finalStatus,
    contract,
    satisfiedCount,
    requiredSatisfiedCount,
    contract.acceptance_criteria.length,
    unmetCriteria,
    requiresHuman,
    details
  );
}

/**
 * Topologically sorts criteria according to their `depends_on` graph.
 * @param {Array<object>} criteria
 * @returns {Array<object>}
 */
function resolveCriteriaOrder(criteria) {
  const result = [];
  const visited = new Set();
  const visiting = new Set();
  const map = new Map(criteria.map((c) => [c.id, c]));

  function visit(c) {
    if (visited.has(c.id)) return;
    if (visiting.has(c.id)) {
      throw new BatonError(`Cyclic criterion dependency detected at ${c.id}`, { code: 'CYCLIC_DEPENDENCY' });
    }
    visiting.add(c.id);
    for (const depId of c.depends_on) {
      const dep = map.get(depId);
      if (dep) visit(dep);
    }
    visiting.delete(c.id);
    visited.add(c.id);
    result.push(c);
  }

  for (const c of criteria) {
    visit(c);
  }

  return result;
}

/**
 * Builds the canonical evaluation return object supporting both camelCase and snake_case properties.
 */
function createResult(status, contract, satisfiedCount, requiredSatisfiedCount, totalCount, unmetCriteria, requiresHuman, details) {
  return {
    status,
    satisfiedCount,
    satisfied_count: satisfiedCount,
    requiredSatisfiedCount,
    required_satisfied_count: requiredSatisfiedCount,
    totalCount,
    total_count: totalCount,
    unmetCriteria,
    unmet_criteria: unmetCriteria,
    requiresHuman,
    requires_human: requiresHuman,
    details,
    summary: details.summary || `Goal evaluation: ${status}`,
  };
}
