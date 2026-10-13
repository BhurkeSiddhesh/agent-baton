import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BatonError, UsageError } from '../lib/errors.js';
import { render } from '../lib/template.js';
import { ensureDir, stamp, toPosix, utcnow, writeFileAtomic, writeJsonAtomic } from '../lib/util.js';
import { buildPromptVars, loadPromptTemplate } from '../lib/views.js';
import { diffValidation, mergeProposal } from './plan.js';

export const name = 'split';
export const group = 'Planning';
export const summary = 'Build the planning prompt for a goal, optionally run an agent CLI on it';
export const usage = 'baton split "<goal>" [--run <claude|codex|gemini|command>] [--allow-shell] [--out file] [--dry-run]';
export const description = [
  'Builds the orchestrator prompt (goal, repo tree, roster, rules, plan schema) from templates/prompts/split.md.',
  'Without --run the prompt is printed (or written to --out). With --run the named agent CLI is started non-interactively,',
  'the prompt goes to its stdin, the first JSON object of its output is validated as a proposal and saved to',
  '.baton/proposals/<timestamp>.json. Nothing is applied: run "baton plan import <file>" to apply it.',
  'Known runners: claude, codex and gemini run with fixed argument arrays (without a shell).',
  'Custom commands require --allow-shell before execution; treat them as trusted local code.',
].join('\n');
export const examples = [
  'baton split "Ship invoice export" --out prompt.md',
  'baton split "Ship invoice export" --run claude --dry-run',
  'baton split "Ship invoice export" --run claude',
];
export const options = {
  run: { type: 'string', description: 'agent CLI to run: claude|codex|gemini or a custom shell command' },
  'allow-shell': { type: 'boolean', description: 'explicitly permit running custom --run through the OS shell' },
  out: { type: 'string', description: 'write the prompt to this file' },
  'dry-run': { type: 'boolean', description: 'with --run: print the command and do not execute it' },
  timeout: { type: 'number', description: 'with --run: seconds to wait for the agent', default: 900 },
  json: { type: 'boolean' },
};

export const RUNNERS = {
  claude: 'claude -p',
  codex: 'codex exec -',
  gemini: 'gemini -p "Follow the instructions given on stdin and answer with the JSON object only."',
};

// Goal and proposal text always go through stdin, never interpolated into command arguments.
const KNOWN_RUNNERS = {
  claude: ['claude', ['-p']],
  codex: ['codex', ['exec', '-']],
  gemini: ['gemini', ['-p', 'Follow the instructions given on stdin and answer with the JSON object only.']],
};

/** Known agents use literal argument arrays. Only an explicitly approved custom command uses a shell. */
export function resolveRunner(name) {
  const known = Object.hasOwn(KNOWN_RUNNERS, name) ? KNOWN_RUNNERS[name] : null;
  if (known) return { file: known[0], args: [...known[1]], command: RUNNERS[name], shell: false, custom: false };
  return { file: String(name), args: [], command: String(name), shell: true, custom: true };
}

/** All JSON objects found in text (fenced blocks first, then any balanced {...}), in order of appearance. */
export function extractJsonObjects(text) {
  const found = [];
  const tryParse = (s) => { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const src = String(text);
  for (const m of src.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)) { const v = tryParse(m[1].trim()); if (v) found.push(v); }
  let i = 0;
  while (i < src.length) {
    const start = src.indexOf('{', i);
    if (start < 0) break;
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let k = start; k < src.length; k++) {
      const c = src[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end < 0) { i = start + 1; continue; }
    const v = tryParse(src.slice(start, end + 1));
    if (v) { found.push(v); i = end + 1; } else i = start + 1;
  }
  return found;
}

/** The first object that looks like a proposal (has packets or tracks), else the first object. */
export function extractProposal(text) {
  const all = extractJsonObjects(text);
  return all.find((o) => Array.isArray(o.packets) || (o.plan && Array.isArray(o.plan.packets))) || all.find((o) => Array.isArray(o.tracks)) || null;
}

function proposalPath(root, now) {
  const dir = ensureDir(path.join(root, '.baton', 'proposals'));
  const base = stamp(now).replace(/[-:]/g, '');
  let file = path.join(dir, `${base}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}.json`);
  return file;
}

export async function run(ctx, args) {
  const goal = args._.join(' ').trim();
  if (!goal) throw new UsageError('split needs a goal, e.g. baton split "Ship invoice export"');
  const loaded = ctx.loadState();
  const tpl = loadPromptTemplate('split', ctx.env);
  const prompt = render(tpl.text, buildPromptVars({ root: ctx.root, ...loaded, env: ctx.env }, { role: 'split', goal }), { partialsDir: path.join(tpl.dir, 'partials') });
  let outFile = null;
  if (args.out) {
    outFile = path.resolve(ctx.cwd, args.out);
    writeFileAtomic(outFile, prompt.endsWith('\n') ? prompt : `${prompt}\n`);
  }
  if (!args.run) {
    if (args.json) ctx.json({ goal, prompt, out: outFile ? toPosix(outFile) : null });
    else if (outFile) ctx.out(`prompt written to ${toPosix(path.relative(ctx.cwd, outFile) || outFile)} (${prompt.length} chars)`);
    else ctx.out(prompt);
    return 0;
  }
  const runner = resolveRunner(args.run);
  const command = runner.command;
  if (runner.custom && !args['allow-shell'] && !args['dry-run']) {
    throw new UsageError('custom --run commands execute through the shell; pass --allow-shell to authorize explicitly (or use --dry-run first)');
  }
  const proposalFile = args['dry-run'] ? null : proposalPath(ctx.root, utcnow());
  if (args['dry-run']) {
    const rel = '.baton/proposals/<timestamp>.json';
    if (args.json) ctx.json({ goal, dryRun: true, command, shell: runner.shell, requiresAllowShell: runner.custom, stdin: `prompt (${prompt.length} chars)`, proposal: rel, out: outFile ? toPosix(outFile) : null });
    else ctx.out([`command: ${command}`, `execution: ${runner.custom ? 'CUSTOM SHELL (requires --allow-shell)' : 'direct executable, no shell'}`, `stdin: the split prompt (${prompt.length} chars)${outFile ? `, also written to ${toPosix(outFile)}` : ''}`, `output: first JSON object is validated and saved to ${rel}`, 'dry run: nothing was executed'].join('\n'));
    return 0;
  }
  if (runner.custom) ctx.err(`baton: executing explicitly authorized custom SHELL command: ${command}`);
  // Windows npm-installed CLIs expose .cmd launchers: use a fixed command line through cmd.exe.
  // No untrusted goal or proposal data is ever placed into this static command.
  const windowsShim = process.platform === 'win32' && !runner.custom;
  const file = windowsShim ? (process.env.ComSpec || 'cmd.exe') : runner.file;
  const argv = windowsShim ? ['/d', '/s', '/c', runner.command] : runner.args;
  const r = spawnSync(file, argv, { shell: runner.shell, input: prompt, encoding: 'utf8', cwd: ctx.root, env: ctx.env, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: Math.max(1, Number(args.timeout) || 900) * 1000 });
  if (r.error) throw new BatonError(`could not run "${command}": ${r.error.code || r.error.message}`, { code: 'RUN_FAILED', hint: 'is the agent CLI installed and on PATH? use --dry-run to see the command' });
  const output = r.stdout || '';
  const rawFile = proposalFile.replace(/\.json$/, '.raw.txt');
  if (r.status !== 0) {
    writeFileAtomic(rawFile, output);
    throw new BatonError(`"${command}" exited with ${r.status}: ${String(r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ') || 'no stderr'}`, { code: 'RUN_FAILED', hint: `raw output kept in ${toPosix(path.relative(ctx.root, rawFile))}` });
  }
  const proposal = extractProposal(output);
  if (!proposal) {
    writeFileAtomic(rawFile, output);
    throw new BatonError('the agent output contained no JSON object with packets', { code: 'NO_PROPOSAL', hint: `raw output kept in ${toPosix(path.relative(ctx.root, rawFile))}` });
  }
  writeJsonAtomic(proposalFile, proposal);
  const rel = toPosix(path.relative(ctx.root, proposalFile));
  let errors = []; let warnings = []; let added = []; let notes = [];
  try {
    const m = mergeProposal(loaded.plan, proposal, 'merge');
    const v = diffValidation(loaded.plan, m.plan, loaded.config, loaded.state);
    errors = v.errors; warnings = v.warnings; added = m.added; notes = m.notes;
  } catch (e) {
    if (!(e instanceof BatonError)) throw e;
    errors = [e.message];
  }
  const apply = `${loaded.config.runtime?.command || 'baton'} plan import ${rel}`;
  if (args.json) ctx.json({ goal, proposal: rel, ok: errors.length === 0, packets: added.length, errors, warnings, notes, apply });
  else {
    ctx.out(`proposal saved to ${rel}: ${added.length} packet(s)`);
    for (const e of errors) ctx.out(`error: ${e}`);
    for (const n of notes) ctx.out(`note: ${n}`);
    for (const w of warnings.slice(0, 12)) ctx.out(`warning: ${w}`);
    if (warnings.length > 12) ctx.out(`... ${warnings.length - 12} more warning(s)`);
    ctx.out(errors.length ? 'the proposal is invalid; fix it by hand or re-run' : `review it, then apply with: ${apply}`);
  }
  return errors.length ? 1 : 0;
}
