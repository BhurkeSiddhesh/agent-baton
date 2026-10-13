import path from 'node:path';
import { toPosix, utcnow, writeFileAtomic } from '../lib/util.js';
import { renderBusMd, renderPlanMd, renderScoreboardMd, renderStatusMd } from '../lib/views.js';

export const name = 'render';
export const group = 'Planning';
export const summary = 'Write STATUS.md, BUS.md, SCOREBOARD.md and PLAN.md views';
export const usage = 'baton render [--out <dir>] [--json]';
export const description = 'Generated, git-ignored views of the ledger. Default directory: .baton/views/. Safe to run at any time.';
export const options = {
  out: { type: 'string', description: 'output directory (default .baton/views)' },
  json: { type: 'boolean' },
};

export async function run(ctx, args) {
  const loaded = ctx.loadState();
  const now = utcnow();
  const dir = args.out ? path.resolve(ctx.cwd, args.out) : path.join(ctx.root, '.baton', 'views');
  const views = { 'STATUS.md': renderStatusMd, 'BUS.md': renderBusMd, 'SCOREBOARD.md': renderScoreboardMd, 'PLAN.md': renderPlanMd };
  const files = [];
  for (const [file, fn] of Object.entries(views)) {
    const target = path.join(dir, file);
    writeFileAtomic(target, `${fn(loaded, now).replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
    files.push(toPosix(target));
  }
  if (args.json) ctx.json({ dir: toPosix(dir), files });
  else ctx.out(`wrote ${files.length} views to ${toPosix(path.relative(ctx.cwd, dir) || '.')}: ${Object.keys(views).join(', ')}`);
  return 0;
}
