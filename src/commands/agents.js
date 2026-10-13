import fs from 'node:fs';
import path from 'node:path';
import { BatonError, UsageError } from '../lib/errors.js';
import { AGENT_ID_RE, RESERVED_AGENTS, validateConfig, planPath } from '../lib/config.js';
import { readJson, list } from '../lib/util.js';
import { runInstall, formatResult, readRawConfig } from '../install/installer.js';
import { loadRegistry, defaultAgentFor, ROLES } from '../install/registry.js';
import { detectAgents, detectTools } from '../install/detect.js';
import { loadManifest } from '../install/manifest.js';

export const name = 'agents';
export const group = 'Setup';
export const summary = 'List, add, remove or change roster agents and (re)write their adapter files';
export const usage = 'baton agents list|add|remove|set|install [<id>] [--name n --kind k --roles a,b --strengths a,b --orchestrator] [--only id] [--force] [--dry-run] [--json]';
export const examples = [
  'baton agents list',
  'baton agents add gemini --roles worker,reviewer --strengths frontend,docs',
  'baton agents set codex --roles worker,reviewer,auditor',
  'baton agents remove gemini',
  'baton agents install --only claude',
];
export const options = {
  id: { type: 'string', description: 'agent id (lowercase, a-z 0-9 _ -); may also be given as a positional' },
  name: { type: 'string', description: 'display name' },
  kind: { type: 'string', description: 'adapter id (claude, codex, gemini, ..., or custom)' },
  roles: { type: 'string', description: 'comma list of orchestrator, worker, reviewer, auditor' },
  strengths: { type: 'string', description: 'comma list of strengths used by "baton assign"' },
  orchestrator: { type: 'boolean', description: 'make this agent the orchestrator' },
  only: { type: 'string', description: 'install: only this agent\'s adapter files' },
  force: { type: 'boolean', description: 'remove: even if the plan references the agent; install: overwrite edited files' },
  'dry-run': { type: 'boolean', description: 'print what would change; write nothing' },
  json: { type: 'boolean', description: 'print one JSON document' },
};

function checkRoles(roles) {
  const bad = roles.filter((r) => !ROLES.includes(r));
  if (bad.length) throw new UsageError(`unknown role${bad.length > 1 ? 's' : ''} ${bad.join(', ')} (one of ${ROLES.join(', ')})`);
  if (!roles.length) throw new UsageError('an agent needs at least one role');
}

function listAgents(ctx, args) {
  const cfg = readRawConfig(ctx.root);
  if (!cfg) throw new BatonError('not a baton project: .baton/config.json is missing', { code: 'NOT_INIT', hint: 'run "baton init" first' });
  const registry = loadRegistry(ctx.env);
  const detected = detectAgents(ctx.root, registry, ctx.env);
  const manifest = loadManifest(ctx.root);
  const rows = (cfg.agents || []).map((a) => {
    const d = detected.find((x) => x.id === a.kind);
    const tracked = Object.entries(manifest.files).filter(([, r]) => r.group === `adapter:${a.id}`).map(([p]) => p);
    const present = tracked.filter((p) => fs.existsSync(path.join(ctx.root, p))).length;
    return { id: a.id, name: a.name, kind: a.kind, roles: a.roles, strengths: a.strengths || [], orchestrator: a.id === cfg.orchestrator,
      cli: { found: !!d?.bins.length, path: d?.bins[0]?.path ?? null }, files: { tracked: tracked.length, present } };
  });
  const rosterKinds = new Set(rows.map((r) => r.kind));
  const extra = detected.filter((d) => (d.installed || d.present) && !rosterKinds.has(d.id));
  if (args.json) {
    ctx.json({ orchestrator: cfg.orchestrator, agents: rows, detectedNotInRoster: extra.map((d) => ({ id: d.id, label: d.label, cli: d.bins[0]?.path ?? null })), tools: detectTools(ctx.root, ctx.env) });
    return 0;
  }
  const w = Math.max(...rows.map((r) => r.id.length), 4);
  const lines = [`Roster (orchestrator: ${cfg.orchestrator})`];
  for (const r of rows) {
    lines.push(`  ${r.id.padEnd(w)}  ${r.name}  [${r.kind}]  roles: ${r.roles.join(',')}  strengths: ${r.strengths.join(',') || '-'}`);
    lines.push(`  ${' '.repeat(w)}  cli: ${r.cli.found ? r.cli.path : 'not found on PATH'}  adapter files: ${r.files.present}/${r.files.tracked}`);
  }
  if (extra.length) lines.push('', `Detected but not in the roster: ${extra.map((d) => d.id).join(', ')} (add with: baton agents add <id>)`);
  ctx.out(lines.join('\n'));
  return 0;
}

export async function run(ctx, args) {
  const sub = args._[0];
  if (!sub || sub === 'list' || sub === 'ls') return listAgents(ctx, args);
  if (!['add', 'remove', 'rm', 'set', 'install'].includes(sub)) throw new UsageError(`unknown subcommand "${sub}" (list, add, remove, set, install)`);

  const raw = readRawConfig(ctx.root);
  if (!raw) throw new BatonError('not a baton project: .baton/config.json is missing', { code: 'NOT_INIT', hint: 'run "baton init" first' });
  const config = JSON.parse(JSON.stringify(raw));
  config.agents = config.agents || [];
  const registry = loadRegistry(ctx.env);
  const id = args.id || args._[1];
  const find = (x) => config.agents.find((a) => a.id === x);
  const needId = () => { if (!id) throw new UsageError(`baton agents ${sub} needs an agent id`); return id; };
  const makeOrchestrator = (a) => {
    config.orchestrator = a.id;
    if (!a.roles.includes('orchestrator')) a.roles = ['orchestrator', ...a.roles];
  };

  if (sub === 'add') {
    needId();
    if (!AGENT_ID_RE.test(id) || RESERVED_AGENTS.includes(id)) throw new UsageError(`invalid agent id "${id}" (lowercase letters, digits, "_" and "-"; "human" and "harness" are reserved)`);
    if (find(id)) throw new BatonError(`agent "${id}" is already in the roster`, { code: 'AGENT_EXISTS', hint: 'use "baton agents set" to change it' });
    const kind = args.kind || (registry.byId.has(id) ? id : 'custom');
    const agent = defaultAgentFor(registry, kind, id);
    if (args.name) agent.name = args.name;
    if (args.roles) agent.roles = list(args.roles);
    if (args.strengths) agent.strengths = list(args.strengths);
    checkRoles(agent.roles);
    config.agents.push(agent);
    if (args.orchestrator) makeOrchestrator(agent);
  } else if (sub === 'remove' || sub === 'rm') {
    needId();
    if (!find(id)) throw new BatonError(`agent "${id}" is not in the roster`, { code: 'UNKNOWN_AGENT' });
    if (config.orchestrator === id) throw new BatonError(`"${id}" is the orchestrator`, { code: 'IS_ORCHESTRATOR', hint: 'make another agent the orchestrator first: baton agents set <id> --orchestrator' });
    if (config.agents.length === 1) throw new BatonError('cannot remove the last agent', { code: 'LAST_AGENT' });
    const plan = readJson(planPath(ctx.root), null);
    const refs = [];
    for (const t of plan?.tracks || []) if (t.owner === id) refs.push(`track ${t.id} owner`);
    for (const p of plan?.packets || []) {
      if (p.agent === id) refs.push(`${p.id} author`);
      if (p.reviewer === id) refs.push(`${p.id} reviewer`);
    }
    if (refs.length && !args.force) {
      throw new BatonError(`the plan still references "${id}": ${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ', ...' : ''}`, { code: 'AGENT_IN_USE', hint: 'hand the work over first (baton handoff / reassign), or use --force' });
    }
    config.agents = config.agents.filter((a) => a.id !== id);
  } else if (sub === 'set') {
    needId();
    const agent = find(id);
    if (!agent) throw new BatonError(`agent "${id}" is not in the roster`, { code: 'UNKNOWN_AGENT' });
    if (args.name) agent.name = args.name;
    if (args.kind) agent.kind = args.kind;
    if (args.roles) { agent.roles = list(args.roles); checkRoles(agent.roles); }
    if (args.strengths) agent.strengths = list(args.strengths);
    if (args.orchestrator) makeOrchestrator(agent);
    if (!(args.name || args.kind || args.roles || args.strengths || args.orchestrator)) throw new UsageError('nothing to set: pass --name, --kind, --roles, --strengths or --orchestrator');
    if (config.orchestrator === id && !agent.roles.includes('orchestrator')) {
      throw new BatonError(`"${id}" is the orchestrator and must keep the orchestrator role`, { code: 'IS_ORCHESTRATOR' });
    }
  } else if (args.only && !find(args.only)) {
    throw new BatonError(`agent "${args.only}" is not in the roster`, { code: 'UNKNOWN_AGENT' });
  }

  const { errors } = validateConfig(config);
  if (errors.length) throw new BatonError(`invalid roster:\n  - ${errors.join('\n  - ')}`, { code: 'BAD_CONFIG' });

  const result = await runInstall(ctx, { mode: 'agents', config, only: sub === 'install' ? args.only : undefined, force: sub === 'install' && args.force, dryRun: args.dryRun, yes: true });
  if (args.json) {
    const { config: c, ...rest } = result;
    ctx.json({ ...rest, orchestrator: c.orchestrator });
    return 0;
  }
  ctx.out([`baton agents ${sub}${id ? ` ${id}` : ''}`, formatResult(result)].join('\n'));
  return 0;
}
