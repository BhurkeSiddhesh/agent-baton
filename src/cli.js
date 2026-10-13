import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BatonError, UsageError, exitCodeFor } from './lib/errors.js';
import { levenshtein } from './lib/util.js';
import { packageVersion } from './lib/paths.js';
import { buildContext } from './lib/context.js';

const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');

const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function normSpec(spec) {
  return typeof spec === 'string' ? { type: spec } : { type: 'boolean', ...spec };
}

/**
 * Parse argv against a command's declarative option table.
 * Table: {"dry-run": {type: "boolean"|"string"|"string[]"|"number", alias?: "n", description?: "...", default?: any}}.
 * Supports `--k v`, `--k=v`, `-a v`, clustered boolean short flags, `--no-k`, repeated `string[]`, and `--` (rest is positional).
 * Result: `{_: [positionals], <name>: value, <camelCaseName>: value}`; `-h/--help` always sets `help: true`.
 * @param {string[]} argv
 * @param {Record<string, any>} [options]
 */
export function parseArgs(argv, options = {}) {
  const table = {};
  const shorts = {};
  for (const [name, raw] of Object.entries(options)) {
    const spec = normSpec(raw);
    table[name] = spec;
    if (spec.alias) shorts[spec.alias] = name;
  }
  const out = { _: [] };
  const set = (name, value) => {
    const spec = table[name];
    if (spec.type === 'string[]') out[name] = [...(out[name] || []), value];
    else out[name] = value;
  };
  const coerce = (name, value) => {
    const spec = table[name];
    if (spec.type === 'number') {
      const n = Number(value);
      if (value === '' || Number.isNaN(n)) throw new UsageError(`--${name} expects a number, got "${value}"`);
      return n;
    }
    if (spec.type === 'boolean') {
      if (['true', '1', 'yes'].includes(String(value))) return true;
      if (['false', '0', 'no'].includes(String(value))) return false;
      throw new UsageError(`--${name} is a flag and cannot take the value "${value}"`);
    }
    return value;
  };
  const unknown = (flag) => {
    const names = Object.keys(table);
    const near = names.map((n) => [n, levenshtein(flag, n)]).sort((a, b) => a[1] - b[1])[0];
    return new UsageError(`unknown option ${flag.length === 1 ? '-' : '--'}${flag}${near && near[1] <= 2 ? ` (did you mean --${near[0]}?)` : ''}`);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    if (arg.startsWith('--') && arg.length > 2) {
      let name = arg.slice(2);
      let inline;
      const eq = name.indexOf('=');
      if (eq >= 0) { inline = name.slice(eq + 1); name = name.slice(0, eq); }
      if (!(name in table) && name.startsWith('no-') && table[name.slice(3)]?.type === 'boolean') {
        if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
        out[name.slice(3)] = false;
        continue;
      }
      if (!(name in table)) throw unknown(name);
      const spec = table[name];
      if (spec.type === 'boolean') {
        set(name, inline === undefined ? true : coerce(name, inline));
      } else if (inline !== undefined) {
        set(name, coerce(name, inline));
      } else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) throw new UsageError(`--${name} needs a value`);
        set(name, coerce(name, next));
        i++;
      }
    } else if (arg.length > 1 && arg.startsWith('-') && !/^-\d/.test(arg)) {
      const letters = arg.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const name = shorts[letters[k]];
        if (!name) throw unknown(letters[k]);
        if (table[name].type === 'boolean') { set(name, true); continue; }
        const rest = letters.slice(k + 1);
        const value = rest || argv[++i];
        if (value === undefined) throw new UsageError(`-${letters[k]} needs a value`);
        set(name, coerce(name, value));
        break;
      }
    } else {
      out._.push(arg);
    }
  }
  for (const [name, spec] of Object.entries(table)) {
    if (!(name in out)) {
      if ('default' in spec) out[name] = spec.default;
      else if (spec.type === 'string[]') out[name] = [];
      else if (spec.type === 'boolean') out[name] = false;
    }
  }
  for (const name of Object.keys(out)) {
    const c = camel(name);
    if (c !== name && !(c in out)) out[c] = out[name];
  }
  return out;
}

/** Import every src/commands/*.js. A broken module is kept as {name, error} so help still works. */
export async function discoverCommands(dir = COMMANDS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort(); } catch { /* no commands yet */ }
  const mods = await Promise.all(files.map(async (f) => {
    const base = f.slice(0, -3);
    try {
      const m = await import(pathToFileURL(path.join(dir, f)).href);
      if (typeof m.run !== 'function') return { name: base, aliases: [], summary: '(not a command module)', usage: '', options: {}, error: new Error(`${f} does not export run()`) };
      return { ...m, name: m.name || base, aliases: m.aliases || [], options: m.options || {}, summary: m.summary || '', usage: m.usage || `baton ${m.name || base}` };
    } catch (error) {
      return { name: base, aliases: [], summary: '(failed to load)', usage: '', options: {}, error };
    }
  }));
  return mods;
}

export function findCommand(commands, name) {
  return commands.find((c) => c.name === name) || commands.find((c) => c.aliases.includes(name)) || null;
}

/** Text of `baton help`. */
export function formatGlobalHelp(commands, version = packageVersion()) {
  const visible = commands.filter((c) => !c.hidden);
  const width = Math.max(8, ...visible.map((c) => c.name.length)) + 2;
  const groups = new Map();
  for (const c of visible) {
    const g = c.group || 'Commands';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const lines = [`baton ${version}: portable multi-agent orchestration`, '', 'Usage: baton <command> [options]', ''];
  for (const [g, list] of groups) {
    lines.push(`${g}:`);
    for (const c of list) lines.push(`  ${c.name.padEnd(width)}${c.summary}`);
    lines.push('');
  }
  lines.push('Global options:', '  --version, -v   print the version', '  --cwd <dir>     run as if started in <dir>', '  -h, --help      help (also: baton <command> --help)', '',
    'Exit codes: 0 ok, 1 rule violation or failed check, 2 usage error, 3 internal error.');
  return lines.join('\n');
}

/** Text of `baton <command> --help`. */
export function formatCommandHelp(cmd) {
  const lines = [`${cmd.usage}`, '', cmd.summary];
  if (cmd.description) lines.push('', cmd.description);
  if (cmd.aliases?.length) lines.push('', `Aliases: ${cmd.aliases.join(', ')}`);
  const entries = Object.entries(cmd.options || {}).map(([n, raw]) => [n, normSpec(raw)]);
  const label = ([n, s]) => `${s.alias ? `-${s.alias}, ` : '    '}--${n}${s.type === 'boolean' ? '' : s.type === 'number' ? ' <n>' : s.type === 'string[]' ? ' <v>...' : ' <v>'}`;
  const w = Math.max(14, ...entries.map((e) => label(e).length)) + 2;
  lines.push('', 'Options:');
  for (const e of entries) lines.push(`  ${label(e).padEnd(w)}${e[1].description || ''}${e[1].default !== undefined ? ` (default: ${e[1].default})` : ''}`);
  lines.push(`  ${'-h, --help'.padEnd(w)}show this help`);
  if (cmd.examples?.length) lines.push('', 'Examples:', ...cmd.examples.map((e) => `  ${e}`));
  return lines.join('\n');
}

/**
 * Run the CLI. Never calls process.exit: returns the exit code.
 * @param {string[]} argv arguments after `node baton.js`
 * @param {{cwd?: string, env?: object, stdout?: {write(s:string):any}, stderr?: {write(s:string):any}, commandsDir?: string}} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  let cwd = io.cwd || process.cwd();
  const say = (s) => stdout.write(`${s}\n`);
  const args = [...argv];
  try {
    while (args[0] === '--cwd') {
      if (!args[1]) throw new UsageError('--cwd needs a directory');
      cwd = path.resolve(cwd, args[1]);
      args.splice(0, 2);
    }
    if (args[0]?.startsWith('--cwd=')) { cwd = path.resolve(cwd, args[0].slice(6)); args.shift(); }
    // --cwd is global: also accepted after the command name (not past a "--" terminator)
    for (let i = 0; i < args.length && args[i] !== '--'; i++) {
      if (args[i] === '--cwd') {
        if (!args[i + 1]) throw new UsageError('--cwd needs a directory');
        cwd = path.resolve(cwd, args[i + 1]);
        args.splice(i, 2); i--;
      } else if (args[i].startsWith('--cwd=')) { cwd = path.resolve(cwd, args[i].slice(6)); args.splice(i, 1); i--; }
    }
    if (args[0] === '--version' || args[0] === '-v' || args[0] === '-V') { say(packageVersion()); return 0; }
    const commands = await discoverCommands(io.commandsDir);
    if (!args.length || args[0] === '-h' || args[0] === '--help') { say(formatGlobalHelp(commands)); return 0; }
    const name = args.shift();
    if (name === 'help' || name === '--help') {
      const target = args[0] && !args[0].startsWith('-') ? args[0] : null;
      if (target) {
        const c = findCommand(commands, target);
        if (!c) throw new UsageError(`unknown command "${target}"`, { hint: 'run "baton help" for the list' });
        say(formatCommandHelp(c));
      } else say(formatGlobalHelp(commands));
      return 0;
    }
    const cmd = findCommand(commands, name);
    if (!cmd) {
      const near = commands.map((c) => [c.name, levenshtein(name, c.name)]).sort((a, b) => a[1] - b[1])[0];
      throw new UsageError(`unknown command "${name}"${near && near[1] <= 3 ? ` (did you mean "${near[0]}"?)` : ''}`, { hint: 'run "baton help" for the list' });
    }
    if (cmd.error) throw cmd.error;
    const parsed = parseArgs(args, cmd.options);
    if (parsed.help) { say(formatCommandHelp(cmd)); return 0; }
    const ctx = buildContext({ cwd, env, stdout, stderr, commands });
    const code = await cmd.run(ctx, parsed);
    return Number.isInteger(code) ? code : 0;
  } catch (err) {
    const code = exitCodeFor(err);
    if (code === 3) {
      stderr.write(`baton: internal error: ${env.BATON_DEBUG ? err?.stack || err : err?.message || err}\n`);
    } else {
      stderr.write(`baton: ${err.message}\n`);
      if (err.hint) stderr.write(`hint: ${err.hint}\n`);
      if (err instanceof UsageError) stderr.write('Try "baton help" or "baton <command> --help".\n');
    }
    return code;
  }
}

export { BatonError };
