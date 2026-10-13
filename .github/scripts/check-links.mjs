// Checks that every relative Markdown link and anchor in the repository docs resolves.
// Run from the repository root: node .github/scripts/check-links.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skip = new Set(['node_modules', '.git', '.baton']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function slug(heading) {
  return heading.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const text = fs.readFileSync(file, 'utf8');
  const set = new Set();
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) {
      let s = slug(m[1]);
      let n = s; let i = 1;
      while (set.has(n)) n = `${s}-${i++}`;
      set.add(n);
    }
    for (const a of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(a[1]);
  }
  anchorCache.set(file, set);
  return set;
}

let bad = 0;
const files = walk(root);
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let fence = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const targets = [];
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.push(m[1]);
    for (const m of line.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) targets.push(m[1]);
    for (const t of targets) {
      if (/^(https?:|mailto:|data:)/i.test(t)) continue;
      const [rel, frag] = t.split('#');
      const target = rel ? path.resolve(path.dirname(file), decodeURIComponent(rel)) : file;
      const shown = path.relative(root, file).split(path.sep).join('/');
      if (!fs.existsSync(target)) { console.error(`${shown}:${idx + 1}: missing file ${t}`); bad++; continue; }
      if (frag && target.endsWith('.md') && !anchorsOf(target).has(frag.toLowerCase())) {
        console.error(`${shown}:${idx + 1}: missing anchor ${t}`); bad++;
      }
    }
  });
}
console.log(`checked ${files.length} Markdown file(s), ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
