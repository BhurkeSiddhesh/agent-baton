// Every `baton <command> ...` invocation shown in templates/, docs/ and README.md must name a real command and real flags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.js';
import { discoverCommands, findCommand } from '../src/cli.js';

function listFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((x) => e.name.endsWith(x) || e.name.includes(x + '.'))) out.push(full);
  }
  return out;
}

const PREFIX = /(?:\{\{\s*cli\s*\}\}|(?:node\s+)?(?<![\w./-])[\w./-]*baton\.js|(?<![\w./-])\.baton\/baton|(?<![\w./-])baton|(?<![\w./-])agent-baton)\s+/g;
// A real invocation starts a line or follows a shell operator, `node`, `npx`, a YAML `run:` or a list dash.
const COMMAND_POSITION = /(^|[$>;|&(`"'-]|run:|then|do|node|npx|exec)\s*$/;
const SEGMENT_END = /\s+\|\|?\s+|\s+&&\s+|\s+;\s+|;\s*$|\s+>\s+|\s+#\s.*|\)\s|"\s*$|\.\s+[A-Z]|\s+(?:and|then|or)\s+/;

/** Code snippets of a text file: fenced lines, plus inline `code` spans on other lines. */
function snippets(text, file) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence || /\.(json|toml|yml|yaml)(\.tpl)?$/.test(file)) out.push({ line: i + 1, text: line });
    else for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ line: i + 1, text: m[1] });
  });
  return out;
}

function invocations(text, file) {
  const found = [];
  for (const s of snippets(text, file)) {
    for (const m of s.text.matchAll(PREFIX)) {
      if (!COMMAND_POSITION.test(s.text.slice(0, m.index))) continue;
      const rest = s.text.slice(m.index + m[0].length);
      const seg = rest.split(SEGMENT_END)[0];
      const tokens = seg.split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const cmd = tokens[0];
      if (!/^[a-z][a-z-]*$/.test(cmd)) continue; // placeholder such as <command> or a path
      const flags = [];
      for (const t of tokens.slice(1)) {
        const f = /^(--?[A-Za-z][\w-]*)/.exec(t.replace(/^["'`[(]+/, ''));
        if (f && !/[<>{}[\]]/.test(f[1])) flags.push(f[1]);
      }
      found.push({ file, line: s.line, cmd, flags, text: s.text.trim() });
    }
  }
  return found;
}

/** Words that follow "baton" in code but are not commands (package names, file names, directories). */
const NOT_COMMANDS = new Set(['js', 'json', 'md']);

test('baton invocations in templates, docs and README name real commands and flags', async () => {
  const commands = await discoverCommands();
  const files = [
    ...listFiles(path.join(REPO, 'templates'), ['.md', '.tpl', '.json', '.yml']),
    ...listFiles(path.join(REPO, 'docs'), ['.md']).filter((f) => !f.includes(`${path.sep}internals${path.sep}`)),
    path.join(REPO, 'README.md'),
  ].filter((f) => fs.existsSync(f));
  assert.ok(files.length > 30, `expected many files, found ${files.length}`);
  const problems = [];
  let checked = 0;
  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    for (const inv of invocations(fs.readFileSync(file, 'utf8'), rel)) {
      if (NOT_COMMANDS.has(inv.cmd)) continue;
      checked++;
      const cmd = inv.cmd === 'help' ? { options: {} } : findCommand(commands, inv.cmd);
      if (!cmd) { problems.push(`${rel}:${inv.line}: unknown command "${inv.cmd}" in: ${inv.text}`); continue; }
      const known = new Set(Object.keys(cmd.options || {}));
      const shorts = new Set(Object.values(cmd.options || {}).map((o) => o && o.alias).filter(Boolean));
      for (const f of inv.flags) {
        if (f === '-h' || f === '--help') continue;
        if (f.startsWith('--')) {
          const n = f.slice(2);
          if (known.has(n) || (n.startsWith('no-') && known.has(n.slice(3)))) continue;
        } else if (shorts.has(f.slice(1))) continue;
        problems.push(`${rel}:${inv.line}: "baton ${inv.cmd}" has no option ${f} in: ${inv.text}`);
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} invocations found; the extractor is broken`);
  assert.deepEqual(problems, []);
});

test('the extractor itself understands the forms used in the docs', () => {
  const md = '```sh\nbaton verify WP-1 --no-tests\n{{cli}} finding add --packet X\n```\nUse `node .baton/runtime/bin/baton.js next --agent a` or `baton nope --x`.\n';
  const got = invocations(md, 'x.md').map((i) => `${i.cmd}:${i.flags.join(',')}`);
  assert.deepEqual(got, ['verify:--no-tests', 'finding:--packet', 'next:--agent', 'nope:--x']);
});
