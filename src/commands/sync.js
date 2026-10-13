import { BatonError } from '../lib/errors.js';
import { git, isGit, currentBranch, headCommit, isDirty, mainRef } from '../lib/git.js';
import { BUILTIN_COORDINATION } from '../lib/glob.js';

export const name = 'sync';
export const group = 'Execution';
export const summary = 'Rebase the current track branch onto main';
export const usage = 'baton sync [--json]';
export const description = 'Refuses on main, with uncommitted work, or in detached HEAD. A conflicting rebase is aborted and the branch is left untouched. Verify again afterwards: the commit changed.';
export const options = { json: { type: 'boolean', description: 'print a JSON document' } };

export async function run(ctx, args) {
  const root = ctx.root;
  if (!isGit(root)) throw new BatonError('sync needs a git repository', { code: 'NOT_GIT' });
  const { config } = ctx.loadState();
  const main = mainRef(root, config.branches?.main);
  const branch = currentBranch(root);
  if (!main) throw new BatonError('no main branch found', { code: 'NO_MAIN' });
  if (!branch) throw new BatonError('detached HEAD: check out your track branch first', { code: 'DETACHED' });
  if (branch === main) throw new BatonError(`you are on ${main}; sync is for track branches`, { code: 'ON_MAIN' });
  if (isDirty(root, { exclude: BUILTIN_COORDINATION })) throw new BatonError('commit or stash your changes before syncing', { code: 'DIRTY_TREE' });
  const before = headCommit(root);
  const r = git(root, ['rebase', main]);
  if (!r || r.status !== 0) {
    git(root, ['rebase', '--abort']);
    throw new BatonError(`rebase of ${branch} onto ${main} hit conflicts and was aborted; nothing changed. Resolve by hand: git rebase ${main}`, { code: 'REBASE_CONFLICT', hint: (r?.stderr || '').trim().split('\n').slice(-2).join(' ') });
  }
  const after = headCommit(root);
  const changed = before !== after;
  if (args.json) ctx.json({ branch, main, before, after, changed });
  else ctx.out(changed ? `${branch} rebased onto ${main}: ${before.slice(0, 8)} -> ${after.slice(0, 8)}. Run "baton verify" again before submitting.` : `${branch} is already up to date with ${main}`);
  return 0;
}
