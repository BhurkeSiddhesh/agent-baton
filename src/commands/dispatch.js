import { spawnSync } from 'node:child_process';
import { BatonError, UsageError } from '../lib/errors.js';
import { load, postMessage } from '../lib/engine.js';

export const name = 'dispatch';
export const group = 'Execution';
export const summary = 'Create a GitHub issue from a packet brief so a cloud agent can pick it up';
export const usage = 'baton dispatch <packet> [--to claude|copilot|codex|any] [--repo owner/name] [--dry-run] [--json]';
export const description = 'Runs "gh issue create" with the label "baton" (create it once: gh label create baton). --dry-run prints the command and the issue text and runs nothing.';
export const options = {
  to: { type: 'string', description: 'cloud agent to address: claude | copilot | codex | any', default: 'any' },
  repo: { type: 'string', description: 'owner/name (default: the repository of the current directory)' },
  by: { type: 'string', description: 'who dispatches (default: the orchestrator)' },
  'dry-run': { type: 'boolean', description: 'print what would run, change nothing' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

const TARGETS = ['claude', 'copilot', 'codex', 'any'];
const MENTION = { claude: '@claude', codex: '@codex', copilot: '', any: '' };

/** The issue body: everything an agent with no local state needs. */
export function buildBrief(packet, state, config, to) {
  const cli = config.runtime?.command || 'baton';
  const agent = state.agent || (TARGETS.includes(to) && to !== 'any' ? to : '<your-agent-id>');
  const branch = `${config.branches?.packetPrefix || 'baton/'}${packet.id}`;
  const L = [];
  if (MENTION[to]) L.push(`${MENTION[to]} please take this packet.`, '');
  L.push(`# ${packet.id}: ${packet.title}`, '');
  if (packet.description) L.push(packet.description, '');
  L.push(`- Priority: ${packet.priority}${packet.milestone ? `, milestone ${packet.milestone}` : ''}${packet.track ? `, track ${packet.track}` : ''}`);
  L.push(`- Author: ${state.agent || 'unassigned'}; reviewer: ${state.reviewer || 'unassigned'}`);
  L.push(`- Branch: \`${branch}\``);
  L.push('', '## You may edit only these paths', ...packet.owns.map((o) => `- \`${o}\``));
  if (packet.reads.length) L.push('', '## Read first', ...packet.reads.map((o) => `- \`${o}\``));
  L.push('', '## Done checks (every one must be true)');
  if (packet.done_checks.length) L.push(...packet.done_checks.map((c) => `- [ ] ${c}`));
  else L.push('- [ ] The change is complete and the tests pass');
  L.push('', '## Protocol', 'The repository uses Agent Baton. Read AGENTS.md, then:', '```',
    `export BATON_AGENT=${agent}`, `${cli} begin ${packet.id} --agent ${agent}`, '# ... do the work, commit it ...',
    `${cli} verify ${packet.id}`, `${cli} submit ${packet.id} --agent ${agent}`, '```',
    'Paste the real output of `verify` into the pull request. Do not touch files outside the paths above; post a REQUEST instead:',
    `\`${cli} bus post --from ${agent} --type REQUEST --text "..."\``);
  return L.join('\n');
}

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const to = String(args.to || 'any').toLowerCase();
  if (!TARGETS.includes(to)) throw new UsageError(`--to must be one of ${TARGETS.join('|')}`);
  const { config, plan, state } = load(ctx.root);
  const packet = plan.packets.find((p) => p.id === pid);
  if (!packet) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET' });
  const s = state.packets[pid];
  if (to !== 'any' && s.agent !== to) {
    throw new BatonError(`${pid} is assigned to ${s.agent || 'no agent'}, not ${to}; reassign its author (and ensure a different reviewer) before dispatching to ${to}`, { code: 'DISPATCH_AGENT_MISMATCH' });
  }
  if (['ACCEPTED', 'ACCEPTED_WITH_FIXES', 'READY_FOR_REVIEW'].includes(s.status)) {
    throw new BatonError(`${pid} is ${s.status}; there is nothing left to dispatch`, { code: 'BAD_TRANSITION' });
  }
  const title = `[baton] ${pid}: ${packet.title}`;
  const body = buildBrief(packet, s, config, to);
  const cmd = ['issue', 'create', '--title', title, '--body-file', '-', '--label', 'baton'];
  if (args.repo) cmd.push('--repo', args.repo);
  if (to === 'copilot') cmd.push('--assignee', '@copilot');
  const shown = `gh ${cmd.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

  if (args['dry-run']) {
    if (args.json) ctx.json({ dryRun: true, packet: pid, to, command: ['gh', ...cmd], title, body });
    else ctx.out(`${shown}\n--- issue body (stdin) ---\n${body}`);
    return 0;
  }
  const r = spawnSync('gh', cmd, { cwd: ctx.root, input: body, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new BatonError('the GitHub CLI "gh" is not installed or not on PATH', { code: 'GH_MISSING', hint: 'install it from https://cli.github.com and run "gh auth login"' });
  if (r.status !== 0) {
    throw new BatonError(`gh issue create failed: ${(r.stderr || r.stdout).trim()}`, { code: 'GH_FAILED', hint: 'if the label is missing: gh label create baton' });
  }
  const url = r.stdout.trim().split(/\r?\n/).pop();
  const by = ctx.agent(args.by, { required: false }) || config.orchestrator;
  postMessage(ctx.root, { from: by, to: 'all', type: 'NOTICE', packet: pid, text: `${pid} dispatched to ${to} as ${url}` });
  if (args.json) ctx.json({ dryRun: false, packet: pid, to, url });
  else ctx.out(`created ${url}`);
  return 0;
}
