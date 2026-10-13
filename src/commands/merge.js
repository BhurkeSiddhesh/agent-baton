import { BatonError, UsageError } from '../lib/errors.js';
import { load, postMessage, checkIdentity } from '../lib/engine.js';
import { appendEvent } from '../lib/store.js';
import { git, gitOk, gitOut, isGit, mainRef, listWorktrees } from '../lib/git.js';

export const name = 'merge';
export const group = 'Execution';
export const summary = 'Fast-forward main to an ACCEPTED packet commit (never creates merge commits)';
export const usage = 'baton merge <packet> --by <orchestrator> [--json]';
export const description = 'Only ACCEPTED packets whose begin base is in integration history; main must fast-forward to the exact reviewed commit. Unfinished packets may sync and reverify after main advances; accepted packets need a replacement if main advances. Publish ledger events on main after merge.';
export const options = {
  by: { type: 'string', description: 'the orchestrator (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const root = ctx.root;
  const by = ctx.agent(args.by || args.agent);
  const { config, plan, state } = load(root);
  checkIdentity(by);
  if (by !== config.orchestrator && by !== 'human') throw new BatonError(`only the orchestrator (${config.orchestrator}) or human may merge; got ${by}`, { code: 'NOT_ORCHESTRATOR' });
  if (!plan.packets.some((p) => p.id === pid)) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET' });
  const s = state.packets[pid];
  if (s.status !== 'ACCEPTED') throw new BatonError(`${pid} is ${s.status}; only ACCEPTED packets can be merged`, { code: 'NOT_ACCEPTED' });
  if (!s.commit) throw new BatonError(`${pid} has no recorded commit (shared-tree work); there is nothing to merge`, { code: 'NO_COMMIT' });
  if (!isGit(root)) throw new BatonError('merge needs a git repository', { code: 'NOT_GIT' });
  const main = mainRef(root, config.branches?.main);
  if (!main) throw new BatonError('no main branch found', { code: 'NO_MAIN' });
  if (!gitOk(root, ['cat-file', '-e', `${s.commit}^{commit}`])) throw new BatonError(`commit ${s.commit} is not in this repository`, { code: 'COMMIT_MISSING' });

  const mainSha = gitOut(root, ['rev-parse', `refs/heads/${main}`]);
  let moved = false;
  if (gitOk(root, ['merge-base', '--is-ancestor', s.commit, mainSha])) {
    // Already part of main (merged by hand, or a repeated run): only the ledger may be missing.
    if (s.merged) {
      if (args.json) ctx.json({ packet: pid, commit: s.commit, main, moved: false, alreadyMerged: true });
      else ctx.out(`${pid} is already merged into ${main}`);
      return 0;
    }
  } else {
    if (!gitOk(root, ['merge-base', '--is-ancestor', mainSha, s.commit])) {
      throw new BatonError(`${main} is not an ancestor of ${s.commit}: not a fast-forward. The accepted commit cannot be resubmitted after rebase; plan a replacement packet from updated ${main}, then verify, submit and review that new work.`, { code: 'NOT_FAST_FORWARD' });
    }
    // The original begin base must belong to integration history. This prevents
    // unverified ancestors from a foreign feature branch being fast-forwarded into main,
    // while allowing unfinished packets that were legitimately rebased onto newer main.
    if (s.base && !gitOk(root, ['merge-base', '--is-ancestor', s.base, mainSha])) {
      throw new BatonError(`${pid} began from ${s.base.slice(0, 8)}, which is not in the history of ${main} (${mainSha.slice(0, 8)}); merging could include unverified ancestor commits. Create a packet branch from ${main} and re-run the lifecycle.`, { code: 'UNVERIFIED_ANCESTORS' });
    }
    const wt = listWorktrees(root).find((w) => w.branch === main);
    const r = wt
      ? git(wt.path, ['merge', '--ff-only', s.commit])
      : git(root, ['update-ref', '-m', `baton merge ${pid}`, `refs/heads/${main}`, s.commit, mainSha]);
    if (!r || r.status !== 0) throw new BatonError(`could not fast-forward ${main}: ${(r?.stderr || r?.stdout || 'git missing').trim()}`, { code: 'GIT_FAILED' });
    moved = true;
  }
  appendEvent(root, { packet: pid, kind: 'merged', by, note: `fast-forwarded ${main}`, data: { commit: s.commit, branch: main } });
  postMessage(root, { from: by, to: 'all', type: 'NOTICE', packet: pid, text: `${pid} merged into ${main} at ${s.commit.slice(0, 8)}` });
  if (args.json) ctx.json({ packet: pid, commit: s.commit, main, moved, alreadyMerged: false });
  else {
    ctx.out(`${main} ${moved ? 'fast-forwarded to' : 'already contained'} ${s.commit.slice(0, 8)} (${pid})`);
    ctx.out('IMPORTANT: From the main worktree, run "baton ledger export", then commit .baton/ledger/ to persist the final verify, review and merge events for fresh clones.');
  }
  return 0;
}
