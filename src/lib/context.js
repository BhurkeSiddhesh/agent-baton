import { BatonError, UsageError } from './errors.js';
import { findRoot, loadConfig, isKnownActor } from './config.js';
import { loadPlan } from './plan.js';
import { load } from './engine.js';

/** Writable that collects text in memory (tests, in-process command runs). */
export function memoryStream() {
  let buf = '';
  return { write(s) { buf += String(s); return true; }, text() { return buf; }, clear() { buf = ''; } };
}

/**
 * Resolve the acting agent from `--agent` or BATON_AGENT and check the roster (plus reserved "human"/"harness").
 * A BATON_AGENT that disagrees with an explicit claim is refused.
 * @param {any} config
 * @param {Record<string,string|undefined>} env
 * @param {string|undefined} claimed value of --agent
 * @param {{required?: boolean}} [opts]
 * @returns {string|null}
 */
export function resolveAgent(config, env, claimed, { required = true } = {}) {
  const fromEnv = env?.BATON_AGENT || undefined;
  if (claimed && fromEnv && claimed !== fromEnv) throw new BatonError(`BATON_AGENT=${fromEnv} but --agent ${claimed} was given`, { code: 'IDENTITY' });
  const id = claimed || fromEnv;
  if (!id) {
    if (required) throw new UsageError('missing agent: pass --agent <id> (or --from <id> for bus post) or set BATON_AGENT');
    return null;
  }
  if (!isKnownActor(config, id)) throw new BatonError(`unknown agent "${id}" (roster: ${(config.agents || []).map((a) => a.id).join(', ')})`, { code: 'UNKNOWN_AGENT', hint: 'run "baton agents" to list the roster, or "baton agents add"' });
  return id;
}

/**
 * Build the command context (see docs/internals/LIB_API.md). Loaders read from disk on every call (never cached),
 * so a command sees its own writes.
 * @param {{cwd?: string, env?: object, stdout?: {write(s:string):any}, stderr?: {write(s:string):any}, commands?: object[], root?: string}} [o]
 */
export function buildContext({ cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr, commands = [], root } = {}) {
  const base = root ?? findRoot(cwd, env);
  const nl = (t) => (String(t).endsWith('\n') ? String(t) : `${t}\n`);
  return {
    cwd,
    root: base,
    env,
    commands,
    out: (text = '') => { stdout.write(nl(text)); },
    err: (text = '') => { stderr.write(nl(text)); },
    json: (obj) => { stdout.write(`${JSON.stringify(obj, null, 2)}\n`); },
    loadConfig: (opts) => loadConfig(base, opts),
    loadPlan: () => loadPlan(base),
    loadState: () => load(base),
    agent: (claimed, opts) => resolveAgent(loadConfig(base), env, claimed, opts),
  };
}
