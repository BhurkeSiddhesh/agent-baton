import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from '../lib/errors.js';
import { git, isGit, gitOk, mainRef, listWorktrees } from '../lib/git.js';
import { toPosix } from '../lib/util.js';

export const name = 'worktrees';
export const group = 'Execution';
export const summary = 'List (or create) one git worktree per track so agents never share a tree';
export const usage = 'baton worktrees [--create] [--base-dir <dir>] [--json]';
export const description = 'Each plan track gets a branch (branches.trackPrefix + track id) and a worktree directory. All worktrees share one ledger store, so claims are visible immediately.';
export const options = {
  create: { type: 'boolean', description: 'create the missing branches and worktrees' },
  'base-dir': { type: 'string', description: 'parent directory for worktrees (default: <repo>-worktrees next to the repo)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const root = ctx.root;
  if (!isGit(root)) throw new BatonError('worktrees need a git repository', { code: 'NOT_GIT' });
  const { config, plan } = ctx.loadState();
  const main = mainRef(root, config.branches?.main);
  const prefix = config.branches?.trackPrefix || 'track/';
  const baseDir = args['base-dir'] ? path.resolve(ctx.cwd, args['base-dir']) : path.join(path.dirname(root), `${path.basename(root)}-worktrees`);
  const existing = listWorktrees(root);
  const rows = [];
  for (const t of plan.tracks) {
    const branch = t.branch || `${prefix}${t.id}`;
    const dir = path.join(baseDir, t.id);
    const found = existing.find((w) => w.branch === branch);
    const row = { track: t.id, owner: t.owner || null, branch, path: toPosix(found ? found.path : dir), exists: !!found, created: false };
    if (!found && args.create) {
      if (!main) throw new BatonError('no main branch to start the worktrees from; make an initial commit first', { code: 'NO_MAIN' });
      fs.mkdirSync(baseDir, { recursive: true });
      const hasBranch = gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      const r = git(root, hasBranch ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, main]);
      if (!r || r.status !== 0) throw new BatonError(`git worktree add failed for ${branch}: ${(r?.stderr || 'git missing').trim()}`, { code: 'GIT_FAILED' });
      row.exists = true;
      row.created = true;
    }
    rows.push(row);
  }
  if (args.json) { ctx.json({ main, baseDir: toPosix(baseDir), worktrees: rows }); return 0; }
  if (!rows.length) { ctx.out('the plan has no tracks'); return 0; }
  for (const r of rows) ctx.out(`${r.track.padEnd(14)} ${r.branch.padEnd(24)} ${r.exists ? (r.created ? 'created' : 'ok     ') : 'missing'} ${r.path}`);
  if (rows.some((r) => !r.exists)) ctx.out('Run "baton worktrees --create" to create the missing ones.');
  else ctx.out('Each agent: cd into its track worktree, then baton begin/verify/submit there.');
  return 0;
}
