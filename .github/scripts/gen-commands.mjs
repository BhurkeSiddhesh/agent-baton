// Regenerates docs/COMMANDS.md from the real --help output. Run from the repository root: node .github/scripts/gen-commands.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const bin = 'bin/baton.js';
const run = (a) => spawnSync(process.execPath, [bin, ...a], { encoding: 'utf8' }).stdout.replace(/\r/g, '').trimEnd();
const groups = {
  Setup: ['init', 'upgrade', 'doctor', 'agents', 'uninstall', 'version'],
  Planning: ['plan', 'split', 'assign', 'gate', 'prompt'],
  Queries: ['status', 'next', 'scores', 'release', 'digest', 'check', 'render'],
  'Working a packet': ['begin', 'heartbeat', 'reclaim', 'block', 'verify', 'submit'],
  Review: ['review', 'accept', 'fix', 'reject', 'finding', 'reassign', 'handoff', 'carry'],
  'Coordination and git': ['bus', 'guard', 'worktrees', 'sync', 'merge', 'dispatch', 'ledger'],
};
const top = run(['--help']);
const summaries = {};
for (const l of top.split('\n')) { const m = l.match(/^  (\w+)\s{2,}(.+)$/); if (m) summaries[m[1]] = m[2]; }
let o = `[Agent Baton](../README.md) / [Docs](../README.md#documentation) / Commands

# Commands

Reference for every command, generated from the real \`--help\` output of baton ${run(['version']).replace(/^baton /, '')}. Below, \`baton\` is
shorthand for \`node .baton/runtime/bin/baton.js\` (or \`npx agent-baton\` outside an installed repo).

## Conventions

- \`baton <command> --help\` (or \`-h\`) prints the same help you see here; \`baton help <command>\` also works.
- \`--cwd <dir>\` runs as if started in \`<dir>\`. \`--version\` / \`-v\` prints the version.
- Query commands take \`--json\` and print exactly one JSON document on stdout; errors go to stderr.
- Colour is used only when stdout is a TTY and \`NO_COLOR\` is unset or empty.
- Identity: \`--agent <id>\` (alias \`-a\`) or the environment variable \`BATON_AGENT\`. Commands that record a decision
  take \`--by\` with \`--agent\` as an alias. Ids come from the roster plus \`human\` and \`harness\`.
- Exit codes: \`0\` ok, \`1\` rule violation or failed check, \`2\` usage error, \`3\` internal error.
- Environment: \`BATON_AGENT\` (identity), \`BATON_NOW\` (ISO time override, used by tests and for reproducible views),
  \`BATON_TEMPLATES_DIR\` (alternative templates directory), \`BATON_TEMPLATE_STRICT=1\` (missing template variables fail),
  \`NO_COLOR\`.

## Index

`;
for (const [g, cs] of Object.entries(groups)) {
  o += `**${g}**\n\n| Command | Summary |\n|---|---|\n`;
  for (const c of cs) o += `| [\`${c}\`](#baton-${c}) | ${summaries[c] || 'Print the baton version'} |\n`;
  o += '\n';
}
o += '`help` shows help for baton or one command.\n\n';
for (const [g, cs] of Object.entries(groups)) {
  o += `## ${g}\n\n`;
  for (const c of cs) o += `### baton ${c}\n\n\`\`\`text\n${run([c, '--help'])}\n\`\`\`\n\n`;
}
o += `## Global help

\`\`\`text
${top}
\`\`\`
`;
fs.writeFileSync('docs/COMMANDS.md', o);
