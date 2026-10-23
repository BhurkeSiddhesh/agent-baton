import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig, planPath } from '../lib/config.js';
import { loadPlan, validatePlan } from '../lib/plan.js';
import { verifyLedger, readEvents } from '../lib/store.js';
import { verifyMarkerPath } from '../lib/engine.js';
import { isGit } from '../lib/git.js';
import { packageVersion } from '../lib/paths.js';
import { loadRegistry } from '../install/registry.js';
import { detectAgents, findOnPath } from '../install/detect.js';
import { loadManifest, hashFileOnDisk, manifestPath } from '../install/manifest.js';
import { extractBlock, blockHash } from '../install/managed-block.js';
import { vendoredVersion, RUNTIME_ENTRY } from '../install/vendor.js';
import { hasGuardHook } from '../install/hooks.js';

export const name = 'doctor';
export const group = 'Setup';
export const summary = 'Check the installation: node, git, config, plan, runtime, adapters, ledger, agent CLIs, hooks';
export const usage = 'baton doctor [--json]';
export const description = 'Exits 1 when any check is an error; warnings and notes exit 0.';
export const options = { json: { type: 'boolean', description: 'print one JSON document' } };

const SHELL_BUILTINS = new Set(['cd', 'echo', 'exit', 'set', 'test', '[', 'true', 'false', ':', 'call', 'type']);

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

export async function run(ctx, args) {
  const root = ctx.root;
  const checks = [];
  const add = (id, status, message, hint) => checks.push({ id, status, message, ...(hint ? { hint } : {}) });
  const guard = (id, fn) => { try { fn(); } catch (e) { add(id, 'error', `check failed: ${e.message}`); } };

  // node
  guard('node', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major >= 18) add('node', 'ok', `node ${process.version}`);
    else add('node', 'error', `node ${process.version} is too old (baton needs >= 18)`, 'install a current Node.js LTS from https://nodejs.org');
  });

  // git
  guard('git', () => {
    if (isGit(root)) add('git', 'ok', 'git repository');
    else add('git', 'info', 'not a git repository (baton uses snapshot scope mode and a local ledger store)', 'run "git init" to enable branch-based scope checks');
  });

  const hasConfig = fs.existsSync(configPath(root));
  let config = null;
  guard('config', () => {
    if (!hasConfig) { add('config', 'error', '.baton/config.json is missing', 'run "baton init"'); return; }
    try {
      config = loadConfig(root);
    } catch (e) {
      add('config', 'error', e.message.split('\n').join(' ').slice(0, 300), 'fix .baton/config.json or restore it from git');
      return;
    }
    add('config', 'ok', `config valid (project "${config.project.name}", ${config.agents.length} agents, orchestrator ${config.orchestrator})`);
  });

  // plan
  guard('plan', () => {
    if (!hasConfig) return;
    if (!fs.existsSync(planPath(root))) { add('plan', 'error', '.baton/plan.json is missing', 'run "baton init" or create it with "baton plan add"'); return; }
    const plan = loadPlan(root);
    if (!config) { add('plan', 'ok', `plan loaded (${plan.packets.length} packets)`); return; }
    const v = validatePlan(plan, config);
    if (v.errors.length) add('plan', 'error', `plan invalid: ${v.errors[0]}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ''}`, 'run "baton plan validate" for the full list');
    else if (v.warnings.length) add('plan', 'warn', `plan valid with ${v.warnings.length} warning(s): ${v.warnings[0]}`, 'run "baton plan validate" for the full list');
    else add('plan', 'ok', `plan valid (${plan.packets.length} packets)`);
  });

  // roster: review needs two different agents with the reviewer role
  guard('roster', () => {
    if (!config) return;
    const reviewers = config.agents.filter((a) => (a.roles || []).includes('reviewer')).length;
    if (reviewers < 2) add('roster', 'warn', `only ${reviewers} agent(s) can review: no packet can be both authored and reviewed by different agents`, 'add another agent: "baton agents add" (baton needs at least two)');
  });

  // test command
  guard('test-command', () => {
    if (!config) return;
    const cmd = (config.test.command || '').trim();
    if (!cmd) { add('test-command', 'warn', 'no test command configured: "baton verify" cannot run tests', 'set test.command in .baton/config.json or re-run "baton init --test-cmd ..."'); return; }
    const first = (cmd.match(/^"([^"]+)"|^'([^']+)'|^\S+/) || [''])[0].replace(/^["']|["']$/g, '');
    if (SHELL_BUILTINS.has(first) || first === 'node' || first === path.basename(process.execPath) || findOnPath(first, ctx.env, root)) add('test-command', 'ok', `test command resolvable: ${cmd}`);
    else add('test-command', 'warn', `test command "${first}" was not found on PATH`, 'install it, or set test.command in .baton/config.json');
  });

  // manifest, runtime, adapters
  const manifest = hasConfig ? loadManifest(root) : null;
  guard('manifest', () => {
    if (!hasConfig) return;
    if (!fs.existsSync(manifestPath(root))) add('manifest', 'warn', '.baton/manifest.json is missing: installed files are not tracked', 'run "baton init" again to rebuild it');
    else add('manifest', 'ok', `manifest tracks ${Object.keys(manifest.files).length} entries`);
  });
  guard('runtime', () => {
    if (!config) return;
    if (config.runtime.vendored === false) { add('runtime', 'info', 'runtime is not vendored (config.runtime.vendored is false): using a global baton'); return; }
    if (!fs.existsSync(path.join(root, RUNTIME_ENTRY))) { add('runtime', 'error', `${RUNTIME_ENTRY} is missing`, 'run "baton init" with the baton package to restore it'); return; }
    const v = vendoredVersion(root);
    const me = packageVersion();
    if (v && v !== me) add('runtime', 'warn', `vendored runtime is ${v} but this baton is ${me}`, 'run "baton upgrade" from the newer baton package');
    else add('runtime', 'ok', `vendored runtime ${v ?? 'unknown version'}`);
    const rt = Object.entries(manifest.files).filter(([, r]) => r.group === 'runtime');
    const gone = rt.filter(([p]) => !fs.existsSync(path.join(root, p))).map(([p]) => p);
    const changed = rt.filter(([p, r]) => fs.existsSync(path.join(root, p)) && hashFileOnDisk(path.join(root, p)) !== r.sha256).map(([p]) => p);
    if (gone.length) add('runtime-files', 'error', `${gone.length} vendored runtime file(s) missing (e.g. ${gone[0]})`, 'run "baton upgrade" to restore them');
    else if (changed.length) add('runtime-files', 'warn', `${changed.length} vendored runtime file(s) were modified (e.g. ${changed[0]})`, 'run "baton upgrade --force" to restore them');
  });
  guard('adapters', () => {
    if (!config) return;
    const problems = [];
    const registry = loadRegistry(ctx.env);
    for (const a of config.agents) {
      const adapter = registry.byId.get(a.kind);
      if (adapter && !adapter.files.length) continue; // registry has nothing to install for it (reported by init)
      const recs = Object.entries(manifest.files).filter(([, r]) => r.group === `adapter:${a.id}`);
      if (!recs.length) { problems.push(`${a.id}: no adapter files installed`); continue; }
      for (const [p, r] of recs) {
        const abs = path.join(root, p);
        const text = readText(abs);
        if (text == null) { problems.push(`${p}: missing`); continue; }
        if (r.mode === 'block') {
          const b = extractBlock(text, r.style || 'html');
          if (b == null) problems.push(`${p}: baton block missing`);
          else if (blockHash(b) !== r.sha256) problems.push(`${p}: managed block was edited`);
        } else if (r.mode === 'file' && hashFileOnDisk(abs) !== r.sha256) problems.push(`${p}: modified`);
      }
    }
    if (problems.length) add('adapters', 'warn', `${problems.length} adapter issue(s): ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? '; ...' : ''}`, 'run "baton agents install" (edited files get a .baton-new sidecar; --force overwrites)');
    else add('adapters', 'ok', `adapter files present and unmodified for ${config.agents.length} agents`);
  });

  // ledger
  guard('ledger', () => {
    if (!config) return;
    const problems = verifyLedger(root).filter((p) => !p.acked);
    const errs = problems.filter((p) => p.severity === 'error');
    if (errs.length) add('ledger', 'error', `${errs.length} ledger integrity problem(s): ${errs[0].id}: ${errs[0].problem}`, 'run "baton ledger verify"; acknowledge known anomalies with an ack event');
    else if (problems.length) add('ledger', 'warn', `${problems.length} ledger note(s): ${problems[0].id}: ${problems[0].problem}`, 'run "baton ledger export" to sync the tracked mirror');
    else add('ledger', 'ok', 'ledger integrity verified');
  });

  // operations
  guard('operations', () => {
    if (!config) return;
    const plan = fs.existsSync(planPath(root)) ? loadPlan(root) : null;
    if (!plan) return;
    const events = readEvents(root);
    const problems = [];
    for (const p of plan.packets) {
      const markerPath = verifyMarkerPath(root, p.id);
      if (fs.existsSync(markerPath)) {
        const verifyEvents = events.filter((e) => e.packet === p.id && e.kind === 'verify');
        const latest = verifyEvents[verifyEvents.length - 1];
        if (!latest || !latest.data?.ok) {
          problems.push(`${p.id}: verify marker on disk has no matching ledger verify event`);
        }
      }
    }
    if (problems.length) add('operations', 'warn', `${problems.length} operation integrity issue(s): ${problems.join('; ')}`, 'run "baton ledger reconcile" to align state');
    else add('operations', 'ok', 'operations and markers consistent');
  });

  // agent CLIs
  guard('agent-clis', () => {
    if (!config) return;
    const registry = loadRegistry(ctx.env);
    const detected = detectAgents(root, registry, ctx.env);
    const found = [];
    const missingHints = [];
    for (const a of config.agents) {
      const d = detected.find((x) => x.id === a.kind);
      const adapter = registry.byId.get(a.kind);
      if (!adapter || !adapter.detect.bins.length) continue;
      if (d?.installed) found.push(a.id);
      else missingHints.push(`${a.id} (${adapter.install || 'see its docs'})`);
    }
    if (found.length) add('agent-clis', 'ok', `agent CLIs found: ${found.join(', ')}`);
    if (missingHints.length) add('agent-clis', 'info', `no CLI on PATH for: ${missingHints.map((m) => m.split(' ')[0]).join(', ')} (fine for IDE or cloud agents)`, `install: ${missingHints.join('; ')}`);
  });

  // hooks and gitignore
  guard('hooks', () => {
    if (!config) return;
    const tracked = Object.values(manifest.files).some((r) => r.group === 'hooks');
    const settingsText = readText(path.join(root, '.claude', 'settings.json'));
    let ok = false;
    try { ok = settingsText != null && hasGuardHook(JSON.parse(settingsText.replace(/^﻿/, ''))); } catch { /* invalid settings */ }
    if (ok) add('hooks', 'ok', 'guard hook configured in .claude/settings.json');
    else if (tracked) add('hooks', 'warn', 'guard hook was installed but is missing from .claude/settings.json', 'run "baton upgrade" to restore it');
    else if (config.agents.some((a) => a.kind === 'claude')) add('hooks', 'info', 'guard hook not configured (optional)', 'run "baton init --hooks" to enforce file ownership inside Claude Code');
  });
  guard('gitignore', () => {
    if (!config || !isGit(root)) return;
    const gi = readText(path.join(root, '.gitignore')) || '';
    if (/^\.baton\/state\/?\s*$/m.test(gi) && /^\.baton\/views\/?\s*$/m.test(gi)) add('gitignore', 'ok', '.gitignore covers .baton/state/ and .baton/views/');
    else add('gitignore', 'warn', '.gitignore does not ignore .baton/state/ and .baton/views/', 'run "baton init" to add them');
  });

  const errors = checks.filter((c) => c.status === 'error').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  if (args.json) {
    ctx.json({ ok: errors === 0, errors, warnings, root: root.replace(/\\/g, '/'), version: packageVersion(), checks });
    return errors ? 1 : 0;
  }
  const tag = { ok: 'ok   ', info: 'note ', warn: 'warn ', error: 'ERROR' };
  const lines = [`baton doctor: ${root.replace(/\\/g, '/')}`];
  for (const c of checks) {
    lines.push(`  ${tag[c.status]} ${c.message}`);
    if (c.hint && c.status !== 'ok') lines.push(`        -> ${c.hint}`);
  }
  lines.push(errors ? `${errors} error(s), ${warnings} warning(s)` : warnings ? `no errors, ${warnings} warning(s)` : 'all checks passed');
  ctx.out(lines.join('\n'));
  return errors ? 1 : 0;
}
