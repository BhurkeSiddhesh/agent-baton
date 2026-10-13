import { loadConfig } from '../lib/config.js';
import { loadPlan, validatePlan } from '../lib/plan.js';
import { readEvents, verifyLedger } from '../lib/store.js';
import { derive, auditEvents, flags, DONE } from '../lib/engine.js';
import { isProtected } from '../lib/glob.js';
import { packetsOverlap } from '../lib/plan.js';
import { utcnow } from '../lib/util.js';
import { makePainter } from '../lib/views.js';

export const name = 'check';
export const group = 'Planning';
export const summary = 'Validate plan, ownership, dependencies, ledger integrity and leases';
export const usage = 'baton check [--json]';
export const description = 'Exit 1 when any error is found. Warnings (unassigned packets, stale leases, unsynced ledger copies) do not fail the check.';
export const options = { json: { type: 'boolean' } };

export async function run(ctx, args) {
  const errors = [];
  const warnings = [];
  const err = (area, message) => errors.push({ area, message });
  const warn = (area, message) => warnings.push({ area, message });
  let config = null; let plan = null;
  try { config = loadConfig(ctx.root); } catch (e) { err('config', e.message); }
  try { plan = loadPlan(ctx.root); } catch (e) { err('plan', e.message); }
  if (config && plan) {
    const now = utcnow();
    const events = readEvents(ctx.root);
    const state = derive(plan, events);
    const done = Object.values(state.packets).filter((s) => DONE.has(s.status)).map((s) => s.id);
    const v = validatePlan(plan, config, { done });
    for (const e of v.errors) err(/overlap/.test(e) ? 'ownership' : /cycle|depend/.test(e) ? 'dependencies' : 'plan', e);
    for (const w of v.warnings) warn('plan', w);
    for (const t of plan.tracks) for (const o of t.owns || []) if (isProtected(o, config.protected?.globs || [])) err('protected', `track ${t.id} owns protected path ${o}`);
    const live = plan.packets.filter((p) => state.packets[p.id].status === 'IN_PROGRESS');
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const clash = packetsOverlap(live[i], live[j]);
      if (clash.length) err('ownership', `in-progress packets ${live[i].id} and ${live[j].id} overlap: ${clash.map(([a, b]) => (a === b ? a : `${a} / ${b}`)).join(', ')}`);
    }
    const sink = (list, area) => {
      for (const p of list) {
        const text = `${p.id ? `${p.id}: ` : ''}${p.problem}${p.acked ? ' (acknowledged)' : ''}`;
        if (p.severity === 'error' && !p.acked) err(area, text); else warn(area, text);
      }
    };
    sink(verifyLedger(ctx.root), 'ledger');
    sink(auditEvents(plan, events, config), 'ledger');
    for (const p of plan.packets) {
      const f = flags(p.id, plan, state, { config, now });
      if (f.includes('STALE')) warn('lease', `${p.id}: lease expired (held by ${state.packets[p.id].by || '-'}, until ${state.packets[p.id].leaseUntil})`);
      if (f.includes('NO_LEASE')) warn('lease', `${p.id}: in progress without a lease`);
      if (f.includes('ESCALATE')) warn('escalation', `${p.id}: rejected ${state.packets[p.id].rejections} time(s); orchestrator decision needed`);
    }
  }
  const ok = errors.length === 0;
  if (args.json) ctx.json({ ok, errors, warnings });
  else {
    const paint = makePainter(ctx.env);
    for (const e of errors) ctx.out(`${paint('red', 'error')}   [${e.area}] ${e.message}`);
    for (const w of warnings) ctx.out(`${paint('yellow', 'warning')} [${w.area}] ${w.message}`);
    ctx.out(ok ? `check ok: ${plan.packets.length} packet(s), ${warnings.length} warning(s)` : `check FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }
  return ok ? 0 : 1;
}
