import { UsageError, BatonError } from '../lib/errors.js';
import { setGate, DONE } from '../lib/engine.js';
import {
  requestGate,
  approveGate,
  denyGate,
  checkGate,
  listGates,
} from '../lib/gate.js';
import { makePainter, renderTable } from '../lib/views.js';

export const name = 'gate';
export const group = 'Planning';
export const summary = 'Request, approve, deny, check or list risk-tiered human approval gates';
export const usage = 'baton gate <request|approve|deny|check|list|open|close> [args...] [--by <actor>] [--risk <tier>] [--reason <msg>] [--status <status>] [--ttl <sec>] [--json]';
export const description = 'Gates control risk-tiered operations. Privileged and destructive operations require human or orchestrator approval with immutable action context.';
export const examples = [
  'baton gate request deploy production --risk destructive --reason "Production release"',
  'baton gate approve GATE-001 --by human',
  'baton gate deny GATE-001 --by human --reason "Unverified migration"',
  'baton gate check GATE-001',
  'baton gate list --status REQUESTED',
  'baton gate open G1 --by human --note "key provisioned"',
];
export const options = {
  by: { type: 'string', description: 'actor approving, denying or opening the gate (human or orchestrator)' },
  risk: { type: 'string', description: 'risk tier (read-only, normal, privileged, destructive)' },
  reason: { type: 'string', description: 'reason recorded with the request, approval or denial' },
  status: { type: 'string', description: 'filter gate list by lifecycle status (REQUESTED, APPROVED, DENIED, EXPIRED, CANCELLED)' },
  ttl: { type: 'number', description: 'time-to-live in seconds before the approval expires' },
  note: { type: 'string', description: 'alias for reason (for backwards compatibility)' },
  'op-id': { type: 'string', description: 'idempotent operation id' },
  json: { type: 'boolean', description: 'print output as JSON' },
};

function planGateRows(plan, state) {
  return (plan.gates || []).map((g) => {
    const s = state.gates?.[g.id];
    const pending = (mode) => (plan.packets || []).filter((p) => p.gate === g.id && (p.gate_mode === 'live_only') === (mode === 'live') && !DONE.has(state.packets[p.id]?.status)).map((p) => p.id);
    return { id: g.id, title: g.title ?? '', owner: g.owner ?? 'human', open: !!s?.open, by: s?.by ?? null, ts: s?.ts ?? null, note: s?.note ?? '', neededBy: g.needed_by ?? null, blocks: pending('start'), liveOnly: pending('live') };
  });
}

export async function run(ctx, args) {
  const [sub = 'list', firstArg, secondArg] = args._;
  const validSubs = ['list', 'open', 'close', 'request', 'approve', 'deny', 'check'];
  if (!validSubs.includes(sub)) {
    throw new UsageError(`unknown gate subcommand "${sub}" (${validSubs.join('|')})`);
  }

  if (sub === 'request') {
    const action = firstArg;
    const target = secondArg;
    if (!action || !target) throw new UsageError('gate request needs <action> and <target>');
    const risk = args.risk || null;
    const reason = args.reason || args.note || '';
    const ttl = args.ttl || null;
    const by = args.by || ctx.env.BATON_AGENT || 'human';
    const opId = args['op-id'] || null;

    const gate = requestGate(ctx.root, {
      action,
      target,
      risk,
      reason,
      ttl,
      by,
      opId,
    });

    if (args.json) {
      ctx.json({
        gate: gate.id,
        id: gate.id,
        action: gate.action,
        target: gate.target,
        risk: gate.risk,
        status: gate.status,
        reason: gate.reason,
        expires_at: gate.expires_at,
        session_id: gate.session_id,
        commit: gate.commit,
      });
    } else {
      ctx.out(`gate ${gate.id} requested for ${gate.action} on ${gate.target} (risk: ${gate.risk})`);
    }
    return 0;
  }

  if (sub === 'approve') {
    const gateId = firstArg;
    if (!gateId) throw new UsageError('gate approve needs a gate id');
    const by = ctx.agent(args.by, { required: true });
    const reason = args.reason || args.note || '';
    const opId = args['op-id'] || null;

    const gate = approveGate(ctx.root, gateId, { by, reason, opId });
    if (args.json) {
      ctx.json({ gate: gateId, id: gateId, status: 'APPROVED', by, event: gate.event_id });
    } else {
      ctx.out(`gate ${gateId} approved by ${by}`);
    }
    return 0;
  }

  if (sub === 'deny') {
    const gateId = firstArg;
    if (!gateId) throw new UsageError('gate deny needs a gate id');
    const by = ctx.agent(args.by, { required: true });
    const reason = args.reason || args.note || '';
    const opId = args['op-id'] || null;

    const gate = denyGate(ctx.root, gateId, { by, reason, opId });
    if (args.json) {
      ctx.json({ gate: gateId, id: gateId, status: 'DENIED', by, reason, event: gate.event_id });
    } else {
      ctx.out(`gate ${gateId} denied by ${by}${reason ? `: ${reason}` : ''}`);
    }
    return 0;
  }

  if (sub === 'check') {
    const gateId = firstArg;
    if (!gateId) throw new UsageError('gate check needs a gate id');

    const res = checkGate(ctx.root, gateId, { now: ctx.env.BATON_NOW });
    if (args.json) {
      ctx.json(res);
      return res.valid ? 0 : 1;
    }
    if (!res.valid) {
      throw new BatonError(
        `gate ${gateId} is ${res.status}${res.reason ? `: ${res.reason}` : ''}`,
        { code: res.code }
      );
    }
    ctx.out(`gate ${gateId} is APPROVED (${res.action} on ${res.target})`);
    return 0;
  }

  if (sub === 'open' || sub === 'close') {
    const gateId = firstArg;
    if (!gateId) throw new UsageError(`gate ${sub} needs a gate id`);
    const by = ctx.agent(args.by, { required: true });
    const opId = args['op-id'] || null;
    const ev = setGate(ctx.root, gateId, sub === 'open', { by, note: args.note || args.reason || '', opId });
    if (args.json) ctx.json({ gate: gateId, open: sub === 'open', by, event: ev.id });
    else ctx.out(`gate ${gateId} ${sub === 'open' ? 'opened' : 'closed'} by ${by}`);
    return 0;
  }

  // sub === 'list'
  const { plan, state } = ctx.loadState();
  const pRows = planGateRows(plan, state);
  const approvals = listGates(ctx.root, { status: args.status, now: ctx.env.BATON_NOW });

  if (args.json) {
    ctx.json({ gates: pRows, approvals });
    return 0;
  }

  const paint = makePainter(ctx.env);
  const lines = [];

  if (pRows.length && (!args.status || ['OPEN', 'CLOSED', 'APPROVED', 'REQUESTED'].includes(String(args.status).toUpperCase()))) {
    lines.push(renderTable(pRows, [
      { key: 'id', label: 'GATE' },
      { get: (g) => (g.open ? 'open' : 'closed'), label: 'STATE', paint: (v) => (v === 'open' ? 'green' : 'red') },
      { key: 'owner', label: 'OWNER' },
      { key: 'title', label: 'TITLE', max: 44 },
      { get: (g) => [g.blocks.length ? `blocks ${g.blocks.join(',')}` : '', g.liveOnly.length ? `live-only ${g.liveOnly.join(',')}` : '', g.neededBy ? `needed by ${g.neededBy}` : ''].filter(Boolean).join('; '), label: 'EFFECT' },
    ], paint).join('\n'));
  }

  if (approvals.length) {
    if (lines.length) lines.push('');
    lines.push(renderTable(approvals, [
      { key: 'id', label: 'GATE' },
      { key: 'risk', label: 'RISK', paint: (v) => (v === 'destructive' || v === 'privileged' ? 'yellow' : 'gray') },
      { key: 'status', label: 'STATUS', paint: (v) => (v === 'APPROVED' ? 'green' : v === 'DENIED' ? 'red' : v === 'EXPIRED' ? 'yellow' : 'blue') },
      { key: 'action', label: 'ACTION' },
      { key: 'target', label: 'TARGET', max: 30 },
      { get: (g) => g.approver || g.requested_by || '-', label: 'ACTOR' },
      { get: (g) => g.expires_at || '-', label: 'EXPIRES' },
    ], paint).join('\n'));
  }

  if (!lines.length) {
    ctx.out('no gates in the plan or ledger');
  } else {
    ctx.out(lines.join('\n'));
  }
  return 0;
}
