import fs from 'node:fs';
import path from 'node:path';
import { runInstall, formatResult } from '../install/installer.js';

export const name = 'init';
export const group = 'Setup';
export const summary = 'Install baton into this repository (idempotent, never overwrites your files)';
export const usage = 'baton init [--agents auto|all|claude,codex,...] [--name n] [--test-cmd "..."] [--yes] [--force] [--dry-run] [--no-vendor] [--cloud] [--hooks] [--no-git-ignore]';
export const description = [
  'Detects the stack, test command and installed agent CLIs, then writes .baton/ (config, plan, vendored runtime, manifest),',
  'a managed block in AGENTS.md, and thin adapter files for every agent in the roster. Re-running is safe: managed blocks are',
  'replaced in place, generated files are only replaced when you have not edited them (otherwise a <file>.baton-new sidecar is written).',
].join(' ');
export const examples = ['baton init', 'baton init --agents claude,codex,gemini --yes', 'baton init --dry-run', 'baton init --cloud --hooks'];
export const options = {
  agents: { type: 'string', description: 'auto (default), all, or a comma list of adapter ids' },
  name: { type: 'string', description: 'project name' },
  'test-cmd': { type: 'string', description: 'command that runs the project tests (default: detected)' },
  yes: { type: 'boolean', alias: 'y', description: 'accept detected defaults without asking' },
  force: { type: 'boolean', description: 'overwrite generated files even if you edited them' },
  'dry-run': { type: 'boolean', description: 'print exactly what would be written; write nothing' },
  'no-vendor': { type: 'boolean', description: 'do not copy the runtime into .baton/runtime (use a global "baton")' },
  cloud: { type: 'boolean', description: 'also write CI and cloud-agent workflows under .github/' },
  hooks: { type: 'boolean', description: 'merge the guard hook into .claude/settings.json' },
  'no-git-ignore': { type: 'boolean', description: 'leave .gitignore and .gitattributes alone' },
  docs: { type: 'boolean', description: 'also write docs/BATON.md (written automatically when docs/ exists)' },
  json: { type: 'boolean', description: 'print one JSON document' },
};

export async function run(ctx, args) {
  const result = await runInstall(ctx, {
    mode: 'init',
    agents: args.agents,
    name: args.name,
    testCmd: args.testCmd,
    yes: args.yes || args.json,
    force: args.force,
    dryRun: args.dryRun,
    noVendor: args.noVendor,
    cloud: args.cloud,
    hooks: args.hooks,
    noGitIgnore: args.noGitIgnore,
    docs: args.docs,
  });
  if (args.json) {
    const { config, ...rest } = result;
    ctx.json({ ...rest, project: config.project, test: config.test });
    return 0;
  }
  const cli = result.config.runtime?.command || 'baton';
  const lines = [`baton ${result.version}: ${result.dryRun ? 'dry run for' : 'installed in'} ${result.root}`, formatResult(result)];
  lines.push(`Agents: ${result.config.agents.map((a) => `${a.id}${a.id === result.config.orchestrator ? ' (orchestrator)' : ''}`).join(', ')}`);
  if (result.config.agents.filter((a) => (a.roles || []).includes('reviewer')).length < 2) {
    lines.push('warning: fewer than two agents can review; baton needs at least two (add one with "baton agents add")');
  }
  if (result.config.test?.command) lines.push(`Test command: ${result.config.test.command}`);
  if (ctx.cwd && !result.newProject && path.resolve(ctx.cwd) !== path.resolve(result.root) && fs.existsSync(path.join(result.root, '.baton', 'config.json'))) {
    lines.push(`note: ${ctx.cwd} is inside the existing baton project at ${result.root}; that project was used (run init from a git repository root to start a separate one)`);
  }
  if (!result.dryRun) {
    lines.push('', 'Next steps:',
      `  1. Describe the work:   ${cli} split "<goal>"      (or add packets by hand: ${cli} plan add --title "...")`,
      `  2. Validate the plan:   ${cli} check`,
      `  3. Pick up work:        ${cli} next --agent ${result.config.orchestrator}`,
      `  Health check any time:  ${cli} doctor`);
  }
  ctx.out(lines.join('\n'));
  return 0;
}
