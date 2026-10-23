import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BatonError } from '../lib/errors.js';
import { commonDir } from '../lib/git.js';
import { removeTracked, SIDECAR_SUFFIX } from '../install/installer.js';
import { loadManifest, manifestPath } from '../install/manifest.js';
import { captureTransaction } from '../install/transaction.js';

export const name = 'uninstall';
export const group = 'Setup';
export const summary = 'Remove what baton installed (only files that still match the manifest)';
export const usage = 'baton uninstall [--keep-ledger] [--yes] [--dry-run] [--json]';
export const description = [
  'Removes manifest-tracked files whose content still matches what baton wrote, strips managed blocks you did not edit and',
  'removes the baton hook and package.json script. Files you edited are kept and listed. The ledger, config and plan are deleted',
  'unless --keep-ledger is given. .baton/agents.json (yours) is never touched.',
].join(' ');
export const options = {
  'keep-ledger': { type: 'boolean', description: 'keep .baton/ledger, config.json and plan.json (the history and the plan)' },
  yes: { type: 'boolean', alias: 'y', description: 'do not ask for confirmation' },
  'dry-run': { type: 'boolean', description: 'print what would be removed; remove nothing' },
  json: { type: 'boolean', description: 'print one JSON document' },
};

function confirm(question, input) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: process.stdout });
    let done = false;
    rl.question(`${question} [y/N] `, (a) => { done = true; rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
    rl.once('close', () => { if (!done) resolve(false); });
  });
}

export async function run(ctx, args) {
  const root = ctx.root;
  if (!fs.existsSync(manifestPath(root)) && !fs.existsSync(path.join(root, '.baton', 'config.json'))) {
    throw new BatonError('nothing to uninstall: no .baton/ found', { code: 'NOT_INIT' });
  }
  const manifest = loadManifest(root);
  const items = [];

  const tracked = Object.entries(manifest.files).filter(([, r]) => !['config', 'plan'].includes(r.mode));
  // plain files first, then block/merge edits
  tracked.sort((a, b) => (a[1].mode === 'file' ? 0 : 1) - (b[1].mode === 'file' ? 0 : 1) || (a[0] < b[0] ? -1 : 1));
  for (const [rel, rec] of tracked) {
    const r = removeTracked(root, rel, rec, { dryRun: true });
    if (r.action === 'missing') continue;
    items.push({ path: rel, action: r.action === 'removed' ? 'remove' : 'keep', detail: r.detail, rel, rec });
  }
  for (const [rel] of tracked) {
    if (fs.existsSync(path.join(root, rel + SIDECAR_SUFFIX))) items.push({ path: rel + SIDECAR_SUFFIX, action: 'remove', detail: 'sidecar', sidecar: true });
  }
  const dirs = [];
  if (!args.keepLedger) {
    for (const rel of ['.baton/ledger', '.baton/state', '.baton/views']) if (fs.existsSync(path.join(root, rel))) dirs.push(rel);
    for (const rel of ['.baton/config.json', '.baton/plan.json']) if (fs.existsSync(path.join(root, rel))) items.push({ path: rel, action: 'remove', detail: 'baton data', plain: true });
    const common = commonDir(root);
    if (common && fs.existsSync(path.join(common, 'baton'))) items.push({ path: `${path.relative(root, path.join(common, 'baton')).replace(/\\/g, '/')}`, action: 'remove', detail: 'local ledger store', abs: path.join(common, 'baton') });
  }
  if (fs.existsSync(manifestPath(root))) items.push({ path: '.baton/manifest.json', action: 'remove', detail: 'manifest', plain: true });
  for (const d of dirs) items.push({ path: `${d}/`, action: 'remove', detail: 'directory', dir: d });

  const removals = items.filter((i) => i.action === 'remove');
  if (!args.dryRun && !args.yes && removals.length) {
    const input = ctx.stdin ?? process.stdin;
    if (!input.isTTY) throw new BatonError('refusing to uninstall without confirmation', { hint: 'review with --dry-run, then pass --yes' });
    ctx.out(items.map((i) => `  ${i.action === 'remove' ? 'remove' : 'keep  '} ${i.path}${i.detail ? `  (${i.detail})` : ''}`).join('\n'));
    if (!(await confirm('Remove these?', input))) { ctx.out('aborted: nothing removed'); return 1; }
  }

  if (!args.dryRun) {
    const transaction = captureTransaction(removals.map((i) => i.abs || path.join(root, i.dir || i.path)));
    let mutations = 0;
    try {
      for (const i of removals) {
        if (i.rec) removeTracked(root, i.rel, i.rec);
        else if (i.dir) fs.rmSync(path.join(root, i.dir), { recursive: true, force: true });
        else fs.rmSync(i.abs || path.join(root, i.path), { recursive: true, force: true });
        mutations++;
        if (Number.isInteger(args._failAfter) && args._failAfter === mutations) throw new Error(`injected uninstall failure after mutation ${mutations}`);
      }
      // drop .baton itself when nothing of yours is left in it
      const baton = path.join(root, '.baton');
      const sweep = (d) => {
        for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) if (e.isDirectory()) sweep(path.join(d, e.name));
        try { if (!fs.readdirSync(d).length) fs.rmdirSync(d); } catch { /* not empty */ }
      };
      sweep(baton);
      transaction.commit();
    } catch (err) {
      const failures = transaction.rollback();
      if (failures.length) throw new BatonError(`uninstall failed and rollback was incomplete: ${failures.join('; ')}`, { code: 'ROLLBACK_FAILED' });
      throw err;
    }
  }

  const kept = items.filter((i) => i.action === 'keep');
  if (args.json) {
    ctx.json({ dryRun: !!args.dryRun, removed: removals.map((i) => i.path), kept: kept.map((i) => ({ path: i.path, reason: i.detail })) });
    return 0;
  }
  const lines = [`baton uninstall${args.dryRun ? ' (dry run)' : ''}`];
  for (const i of items) lines.push(`  ${i.action === 'remove' ? (args.dryRun ? 'would remove' : 'removed') : 'kept'}  ${i.path}${i.detail ? `  (${i.detail})` : ''}`);
  if (!items.length) lines.push('  nothing to remove');
  if (kept.length) lines.push('note: kept files you changed; delete them by hand if you no longer want them');
  ctx.out(lines.join('\n'));
  return 0;
}
