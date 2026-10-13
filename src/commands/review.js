import { UsageError, BatonError } from '../lib/errors.js';
import { load, findingsOf, readVerifyMarker } from '../lib/engine.js';
import { gitOut } from '../lib/git.js';

export const name = 'review';
export const group = 'Execution';
export const summary = 'Reviewer brief: packet, done checks, verify result, changed files, findings';
export const usage = 'baton review <packet> [--json]';
export const options = { json: { type: 'boolean', description: 'print a JSON document' } };

function changedFiles(root, s, marker) {
  if (marker) return [...(marker.in_scope || []), ...(marker.coordination || []), ...(marker.foreign_owned_unattributed || [])];
  if (s.base && s.commit) {
    const out = gitOut(root, ['diff', '--name-only', s.base, s.commit]);
    if (out) return out.split(/\r?\n/).filter(Boolean);
  }
  return [];
}

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const { config, plan, events, state } = load(ctx.root);
  const p = plan.packets.find((x) => x.id === pid);
  if (!p) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET' });
  const s = state.packets[pid];
  const marker = readVerifyMarker(ctx.root, pid);
  const findings = findingsOf(events, pid);
  const open = findings.filter((f) => f.status !== 'closed');
  const reviewer = s.reviewer || '<reviewer>';
  const testCmd = p.test || config.test?.command || '';
  const cli = config.runtime?.command || 'baton';
  const commands = [];
  if (s.commit) {
    commands.push(s.base && s.base !== s.commit ? `git diff ${s.base} ${s.commit}` : `git show ${s.commit}`);
    commands.push(`git checkout ${s.commit}   # or the packet branch, to run the checks on exactly the reviewed commit`);
  }
  if (testCmd) commands.push(testCmd);
  commands.push(
    `${cli} finding add --packet ${pid} --by ${reviewer} --severity MAJOR --text "..." --file <f> --line <n> --evidence "..." --fix "..."`,
    `${cli} accept ${pid} --by ${reviewer} --score <0-10>`,
    `${cli} fix ${pid} --by ${reviewer} --note "..."`,
    `${cli} reject ${pid} --by ${reviewer} --note "..."`,
  );
  const brief = {
    packet: pid, title: p.title, status: s.status, description: p.description || '',
    author: s.agent, contributors: s.contributors, reviewer: s.reviewer, commit: s.commit, base: s.base,
    owns: p.owns, reads: p.reads, done_checks: p.done_checks,
    verify: marker ? {
      ok: marker.ok, mode: marker.mode, commit: marker.commit, ts: marker.ts || null, tests: marker.tests || null,
      out_of_scope: marker.out_of_scope || [], secrets: marker.secrets || [], problems: marker.problems || [],
    } : null,
    changed_files: changedFiles(ctx.root, s, marker),
    open_findings: open, findings_total: findings.length,
    reviewable: s.status === 'READY_FOR_REVIEW',
    commands,
  };
  if (args.json) { ctx.json(brief); return 0; }
  const L = [];
  L.push(`Review ${pid}: ${p.title}`);
  L.push(`Status ${s.status}; author ${s.agent || 'n/a'}${s.contributors.length ? ` (worked on by ${s.contributors.join(', ')})` : ''}; reviewer ${s.reviewer || 'n/a'}`);
  if (s.status !== 'READY_FOR_REVIEW') L.push(`Note: ${pid} is not READY_FOR_REVIEW, so a verdict is not possible yet.`);
  if (p.description) L.push('', p.description);
  L.push('', `Reviewed artifact: ${s.commit ? `commit ${s.commit}` : 'n/a (shared-tree work: review the files below)'}`);
  L.push(`Owned paths: ${p.owns.join(', ')}`);
  if (p.reads.length) L.push(`Reads: ${p.reads.join(', ')}`);
  L.push('', 'Done checks (every one must be true):');
  if (p.done_checks.length) for (const c of p.done_checks) L.push(`  [ ] ${c}`);
  else L.push('  (none declared)');
  L.push('', 'Verify result:');
  if (!marker) L.push('  no verify marker (never verified, or reopened since)');
  else {
    L.push(`  ${marker.ok ? 'PASS' : 'FAIL'} (${marker.mode}) at ${marker.commit || 'no commit'}`);
    if (marker.tests?.ran) L.push(`  tests ${marker.tests.ok ? 'passed' : 'FAILED'}: ${String(marker.tests.tail || '').split('\n').pop()}`);
    for (const x of marker.out_of_scope || []) L.push(`  out of scope: ${x}`);
    for (const x of marker.secrets || []) L.push(`  secret: ${x}`);
    for (const x of marker.problems || []) L.push(`  problem: ${x}`);
  }
  L.push('', `Changed files (${brief.changed_files.length}): ${brief.changed_files.join(', ') || 'none recorded'}`);
  L.push('', `Open findings (${open.length}):`);
  if (!open.length) L.push('  none');
  for (const f of open) L.push(`  ${f.fid} ${f.severity} ${f.status}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.text}`);
  L.push('', 'Commands:', ...commands.map((c) => `  ${c}`));
  ctx.out(L.join('\n'));
  return 0;
}
