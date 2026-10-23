import { BatonError, UsageError } from './errors.js';
import { loadConfig, isKnownActor, hasRole } from './config.js';
import { loadPlan } from './plan.js';
import { readEvents, appendEvent, stateDir } from './store.js';
import { derive } from './engine.js';
import { withLock } from './lock.js';
import { headCommit } from './git.js';
import { resolveExecutionProvenance } from './provenance.js';
import { sha256, canonicalJson } from './util.js';

export const RISK_TIERS = ['read-only', 'normal', 'privileged', 'destructive'];
export const APPROVAL_STATUSES = ['REQUESTED', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED'];

export function computeActionFingerprint({ action, target, risk, session_id = null, commit = null }) {
  return sha256(canonicalJson({
    action,
    target,
    risk,
    session_id: session_id ?? null,
    commit: commit ?? null,
  }));
}

export function classifyOperation(action, target = '', config = null) {
  if (!action || typeof action !== 'string') return 'normal';
  const act = action.toLowerCase().trim();
  const tgt = (target || '').toLowerCase().trim();

  const destructiveActions = new Set([
    'delete', 'destroy', 'drop', 'rm', 'purge', 'reset', 'uninstall',
    'clean', 'force-push', 'rollback', 'revert', 'truncate', 'kill',
  ]);
  if (destructiveActions.has(act)) return 'destructive';

  const privilegedActions = new Set([
    'deploy', 'publish', 'release', 'merge', 'config', 'admin',
    'secret', 'sudo', 'execute', 'exec', 'install', 'upgrade', 'reassign',
  ]);
  if (privilegedActions.has(act)) return 'privileged';

  if (/\b(prod|production|main|master)\b/.test(tgt)) {
    if (['write', 'update', 'modify', 'push', 'apply', 'migrate'].includes(act)) {
      return 'privileged';
    }
  }
  if (tgt.includes('.baton/config.json') || tgt.includes('.git/') || tgt.includes('.github/workflows/')) {
    return 'privileged';
  }

  const readOnlyActions = new Set([
    'read', 'query', 'list', 'check', 'inspect', 'show', 'status',
    'scores', 'digest', 'get', 'cat', 'diff', 'log', 'find', 'search',
  ]);
  if (readOnlyActions.has(act)) return 'read-only';

  return 'normal';
}

export function getApprovalStatus(approval, now = new Date()) {
  if (!approval) return null;
  if (['DENIED', 'CANCELLED'].includes(approval.status)) return approval.status;
  if (approval.expires_at) {
    const exp = new Date(approval.expires_at).getTime();
    const curr = (typeof now === 'string' || typeof now === 'number' ? new Date(now) : now).getTime();
    if (Number.isFinite(exp) && curr > exp) {
      return 'EXPIRED';
    }
  }
  return approval.status;
}

export function requireActor(config, id, what = 'actor') {
  if (!id) throw new BatonError(`${what} is required`, { code: 'NO_ACTOR' });
  if (!isKnownActor(config, id)) throw new BatonError(`unknown ${what} "${id}" (not in the roster)`, { code: 'UNKNOWN_AGENT' });
}

function generateGateId(approvals = {}) {
  let n = Object.keys(approvals).length + 1;
  let id = `GATE-${String(n).padStart(3, '0')}`;
  while (approvals[id]) {
    n++;
    id = `GATE-${String(n).padStart(3, '0')}`;
  }
  return id;
}

export function requestGate(root, {
  action,
  target,
  risk = null,
  reason = '',
  ttl = null,
  by = null,
  commit = null,
  session_id = null,
  id = null,
  opId = null,
} = {}) {
  if (!action || typeof action !== 'string') throw new UsageError('gate request requires an action');
  if (!target || typeof target !== 'string') throw new UsageError('gate request requires a target');

  const effectiveRisk = risk || classifyOperation(action, target);
  if (!RISK_TIERS.includes(effectiveRisk)) {
    throw new UsageError(`invalid risk tier "${effectiveRisk}"; must be one of: ${RISK_TIERS.join(', ')}`);
  }

  return withLock(stateDir(root), () => {
    const config = loadConfig(root);
    const plan = loadPlan(root);
    const events = readEvents(root);
    const state = derive(plan, events);

    const requester = by || 'human';
    requireActor(config, requester, 'requester');

    const commitId = commit || headCommit(root) || null;
    const prov = resolveExecutionProvenance();
    const sessionId = session_id || prov?.session || null;

    let expiresAt = null;
    if (ttl != null) {
      const ttlSec = Number(ttl);
      if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
        throw new UsageError(`invalid ttl "${ttl}"; must be a positive number of seconds`);
      }
      expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
    }

    const gateId = id || generateGateId(state.approvals || {});
    if (state.approvals?.[gateId]) {
      throw new BatonError(`gate "${gateId}" already exists`, { code: 'DUPLICATE_GATE' });
    }

    const contextSha = computeActionFingerprint({
      action,
      target,
      risk: effectiveRisk,
      session_id: sessionId,
      commit: commitId,
    });

    const ev = appendEvent(root, {
      packet: null,
      kind: 'approval',
      by: requester,
      note: reason,
      op_id: opId,
      data: {
        gate_id: gateId,
        action,
        target,
        risk: effectiveRisk,
        status: 'REQUESTED',
        session_id: sessionId,
        commit: commitId,
        reason,
        expires_at: expiresAt,
        context_sha: contextSha,
      },
    });

    return {
      id: gateId,
      gate_id: gateId,
      action,
      target,
      risk: effectiveRisk,
      status: 'REQUESTED',
      session_id: sessionId,
      commit: commitId,
      reason,
      expires_at: expiresAt,
      context_sha: contextSha,
      requested_by: requester,
      event_id: ev.id,
    };
  });
}

export function approveGate(root, gateId, { by, reason = '', note = '', opId = null } = {}) {
  if (!gateId) throw new UsageError('gate approve requires a gate id');
  if (!by) throw new UsageError('gate approve requires an approving actor (--by <actor>)');

  return withLock(stateDir(root), () => {
    const config = loadConfig(root);
    const plan = loadPlan(root);
    const events = readEvents(root);
    const state = derive(plan, events);

    const gate = state.approvals?.[gateId];
    if (!gate) {
      throw new BatonError(`unknown gate "${gateId}"`, { code: 'UNKNOWN_GATE' });
    }

    if (gate.status === 'DENIED') {
      throw new BatonError(`gate "${gateId}" has been denied and cannot be approved`, { code: 'APPROVAL_DENIED' });
    }
    if (gate.status === 'CANCELLED') {
      throw new BatonError(`gate "${gateId}" has been cancelled`, { code: 'APPROVAL_CANCELLED' });
    }
    const currentStatus = getApprovalStatus(gate);
    if (currentStatus === 'EXPIRED') {
      throw new BatonError(`gate "${gateId}" has expired`, { code: 'APPROVAL_EXPIRED' });
    }
    if (gate.status === 'APPROVED') {
      return { id: gateId, ...gate };
    }

    requireActor(config, by, 'approver');

    // Role enforcement for privileged and destructive gates
    if (gate.risk === 'privileged' || gate.risk === 'destructive') {
      const isOrchestrator = by === config.orchestrator || hasRole(config, by, 'orchestrator');
      const isHuman = by === 'human';
      if (!isHuman && !isOrchestrator) {
        throw new BatonError(
          `actor "${by}" lacks orchestrator role to approve ${gate.risk} gate ${gateId}`,
          { code: 'UNAUTHORIZED_APPROVER' }
        );
      }
      if (!isHuman && gate.requested_by && gate.requested_by === by) {
        throw new BatonError(
          `agent "${by}" cannot self-approve ${gate.risk} gate ${gateId}`,
          { code: 'SELF_APPROVAL_DISALLOWED' }
        );
      }
    }

    // Verify immutable action context fingerprint
    if (gate.context_sha) {
      const checkSha = computeActionFingerprint(gate);
      if (checkSha !== gate.context_sha) {
        throw new BatonError(`action context for gate "${gateId}" was mutated`, { code: 'CONTEXT_MUTATED' });
      }
    }

    const decisionReason = reason || note || gate.reason || '';
    const ev = appendEvent(root, {
      packet: null,
      kind: 'approval',
      by,
      note: decisionReason,
      op_id: opId,
      data: {
        gate_id: gateId,
        action: gate.action,
        target: gate.target,
        risk: gate.risk,
        status: 'APPROVED',
        session_id: gate.session_id,
        commit: gate.commit,
        reason: decisionReason,
        expires_at: gate.expires_at,
        approver: by,
        context_sha: gate.context_sha,
      },
    });

    return {
      ...gate,
      status: 'APPROVED',
      approver: by,
      reason: decisionReason,
      event_id: ev.id,
    };
  });
}

export function denyGate(root, gateId, { by, reason = '', note = '', opId = null } = {}) {
  if (!gateId) throw new UsageError('gate deny requires a gate id');
  if (!by) throw new UsageError('gate deny requires an actor (--by <actor>)');

  return withLock(stateDir(root), () => {
    const config = loadConfig(root);
    const plan = loadPlan(root);
    const events = readEvents(root);
    const state = derive(plan, events);

    const gate = state.approvals?.[gateId];
    if (!gate) {
      throw new BatonError(`unknown gate "${gateId}"`, { code: 'UNKNOWN_GATE' });
    }

    requireActor(config, by, 'denier');

    const decisionReason = reason || note || gate.reason || 'denied';
    const ev = appendEvent(root, {
      packet: null,
      kind: 'approval',
      by,
      note: decisionReason,
      op_id: opId,
      data: {
        gate_id: gateId,
        action: gate.action,
        target: gate.target,
        risk: gate.risk,
        status: 'DENIED',
        session_id: gate.session_id,
        commit: gate.commit,
        reason: decisionReason,
        expires_at: gate.expires_at,
        approver: by,
        context_sha: gate.context_sha,
      },
    });

    return {
      ...gate,
      status: 'DENIED',
      approver: by,
      reason: decisionReason,
      event_id: ev.id,
    };
  });
}

export function checkGate(root, gateId, { now = new Date() } = {}) {
  if (!gateId) throw new UsageError('gate check requires a gate id');

  const plan = loadPlan(root);
  const events = readEvents(root);
  const state = derive(plan, events);

  // Check approval gates first
  const gate = state.approvals?.[gateId];
  if (gate) {
    const effStatus = getApprovalStatus(gate, now);
    const valid = effStatus === 'APPROVED';
    let code = 'APPROVAL_OK';
    if (effStatus === 'DENIED') code = 'APPROVAL_DENIED';
    else if (effStatus === 'EXPIRED') code = 'APPROVAL_EXPIRED';
    else if (effStatus === 'REQUESTED') code = 'APPROVAL_PENDING';
    else if (effStatus === 'CANCELLED') code = 'APPROVAL_CANCELLED';

    return {
      gate: gateId,
      id: gateId,
      valid,
      status: effStatus,
      code,
      action: gate.action,
      target: gate.target,
      risk: gate.risk,
      reason: gate.reason,
      approver: gate.approver,
      requested_by: gate.requested_by,
      session_id: gate.session_id,
      commit: gate.commit,
      expires_at: gate.expires_at,
    };
  }

  // Check plan gates fallback
  const planGate = state.gates?.[gateId];
  if (planGate) {
    const valid = !!planGate.open;
    return {
      gate: gateId,
      id: gateId,
      valid,
      status: valid ? 'APPROVED' : 'REQUESTED',
      code: valid ? 'APPROVAL_OK' : 'GATE_CLOSED',
      action: 'plan-gate',
      target: planGate.title || gateId,
      risk: 'privileged',
      owner: planGate.owner,
      open: planGate.open,
    };
  }

  throw new BatonError(`unknown gate "${gateId}"`, { code: 'UNKNOWN_GATE' });
}

export function assertGateApproved(root, gateId, opts = {}) {
  const res = checkGate(root, gateId, opts);
  if (!res.valid) {
    throw new BatonError(
      `gate "${gateId}" is ${res.status}${res.reason ? `: ${res.reason}` : ''}`,
      { code: res.code }
    );
  }
  return res;
}

export function assertOperationPermitted(root, {
  action,
  target,
  commit = null,
  risk = null,
  now = new Date(),
} = {}) {
  if (!action || !target) throw new UsageError('assertOperationPermitted requires action and target');

  const plan = loadPlan(root);
  const events = readEvents(root);
  const state = derive(plan, events);

  const matching = Object.values(state.approvals || {})
    .filter((a) => a.action === action && a.target === target)
    .sort((a, b) => (b.last_event || '').localeCompare(a.last_event || '') || (b.id || '').localeCompare(a.id || ''));

  if (!matching.length) {
    const effectiveRisk = risk || classifyOperation(action, target);
    if (effectiveRisk === 'read-only' || effectiveRisk === 'normal') {
      return { allowed: true, risk: effectiveRisk, gate: null };
    }
    throw new BatonError(
      `operation "${action}" on "${target}" requires approval (risk: ${effectiveRisk})`,
      { code: 'APPROVAL_REQUIRED' }
    );
  }

  const latest = matching[0];
  const effStatus = getApprovalStatus(latest, now);

  if (effStatus === 'DENIED') {
    throw new BatonError(
      `operation "${action}" on "${target}" was denied and cannot proceed without a new approval (${latest.gate_id})`,
      { code: 'APPROVAL_DENIED' }
    );
  }

  if (effStatus === 'EXPIRED') {
    throw new BatonError(
      `approval for operation "${action}" on "${target}" has expired (${latest.gate_id})`,
      { code: 'APPROVAL_EXPIRED' }
    );
  }

  if (effStatus === 'REQUESTED') {
    throw new BatonError(
      `operation "${action}" on "${target}" is pending approval (${latest.gate_id})`,
      { code: 'APPROVAL_PENDING' }
    );
  }

  if (effStatus === 'CANCELLED') {
    throw new BatonError(
      `approval for operation "${action}" on "${target}" was cancelled (${latest.gate_id})`,
      { code: 'APPROVAL_CANCELLED' }
    );
  }

  if (effStatus === 'APPROVED') {
    if (commit && latest.commit && latest.commit !== commit) {
      throw new BatonError(
        `approval for operation "${action}" on "${target}" was bound to commit ${latest.commit}, got ${commit}`,
        { code: 'APPROVAL_COMMIT_MISMATCH' }
      );
    }
    return { allowed: true, risk: latest.risk, gate: latest };
  }

  throw new BatonError(`unexpected approval status "${effStatus}" for gate "${latest.gate_id}"`, { code: 'UNKNOWN_GATE_STATUS' });
}

export function listGates(root, { status = null, now = new Date() } = {}) {
  const plan = loadPlan(root);
  const events = readEvents(root);
  const state = derive(plan, events);

  let approvals = Object.values(state.approvals || {}).map((a) => {
    const effStatus = getApprovalStatus(a, now);
    return {
      ...a,
      status: effStatus,
    };
  });

  if (status) {
    const s = String(status).toUpperCase();
    approvals = approvals.filter((a) => a.status === s);
  }

  return approvals;
}
