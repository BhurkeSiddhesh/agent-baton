import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempRepo, runCli, runNode } from './helpers.js';
import { readEvents } from '../src/lib/store.js';
import { loadManifest, hashContent } from '../src/install/manifest.js';
import { baton, installEnv, isolatedEnv, fakeBin, templates, makeFixtureTemplates, snapshotTree } from './install-fixture.test.js';

const CC = ['--agents', 'claude,codex', '--yes', '--test-cmd', 'node -e 0'];

function withRepo(opts, fn) {
  const repo = makeTempRepo(opts);
  return Promise.resolve(fn(repo)).finally(() => repo.cleanup());
}

test('init on an empty git repo writes the full install and doctor passes', () => withRepo({ git: true }, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  for (const f of ['.baton/config.json', '.baton/plan.json', '.baton/manifest.json', '.baton/runtime/bin/baton.js', '.baton/runtime/src/cli.js',
    '.baton/runtime/package.json', '.baton/baton', '.baton/baton.cmd', 'AGENTS.md', 'CLAUDE.md', '.claude/agents/baton-worker.md', '.claude/commands/baton-digest.md',
    '.codex/agents/baton-reviewer.toml', '.baton/prompts/auditor.md', '.gitignore', '.gitattributes']) assert.ok(repo.exists(f), `${f} should exist`);
  assert.ok(!repo.exists('package.json'), 'must not create package.json');
  assert.ok(!fs.readdirSync(path.join(repo.root, '.baton/runtime')).includes('tests'));
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.deepEqual(cfg.agents.map((a) => a.id), ['claude', 'codex']);
  assert.equal(cfg.orchestrator, 'claude');
  assert.equal(cfg.test.command, 'node -e 0');
  assert.equal(cfg.runtime.command, 'node .baton/runtime/bin/baton.js');
  // templates rendered with project and cli variables
  assert.match(repo.read('.claude/agents/baton-worker.md'), /description: Worker for baton-test-/);
  assert.match(repo.read('AGENTS.md'), /node \.baton\/runtime\/bin\/baton\.js next/);
  assert.match(repo.read('.baton/prompts/worker.md'), /# Worker prompt/);
  assert.match(repo.read('.gitignore'), /\.baton\/state\//);
  assert.match(repo.read('.gitattributes'), /\.baton\/ledger\/\*\* -diff linguist-generated/);
  assert.match(repo.read('.baton/baton.cmd'), /\r\n/);
  // manifest hashes match the files
  const m = loadManifest(repo.root);
  assert.equal(m.files['.claude/agents/baton-worker.md'].sha256, hashContent(repo.read('.claude/agents/baton-worker.md')));
  assert.equal(m.files['AGENTS.md'].managed, true);
  assert.equal(m.files['.baton/runtime/bin/baton.js'].group, 'runtime');
  // init event
  const events = readEvents(repo.root);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'init');
  const d = await baton(repo.root, ['doctor'], installEnv());
  assert.equal(d.code, 0, d.out + d.err);
}));

test('re-running init is idempotent: every byte identical, nothing to change', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--cloud', '--hooks']);
  const before = snapshotTree(repo.root);
  const again = await baton(repo.root, ['init', ...CC, '--cloud', '--hooks']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /nothing to change/);
  assert.deepEqual(snapshotTree(repo.root), before);
  const noFlags = await baton(repo.root, ['init', '--yes']);
  assert.match(noFlags.out, /nothing to change/, 'a plain re-run keeps refreshing cloud files and hooks without changing anything');
  assert.deepEqual(snapshotTree(repo.root), before);
  assert.equal(readEvents(repo.root).length, 1, 'init event is written once');
}));

test('existing Node project with AGENTS.md: content preserved, block added, package.json formatting kept', () => withRepo({
  git: true,
  files: { 'AGENTS.md': '# Team rules\r\n\r\nBe kind.\r\n', 'package.json': '{\n\t"name": "demo-app",\n\t"scripts": {\n\t\t"test": "node --test"\n\t}\n}\n' },
}, async (repo) => {
  const r = await baton(repo.root, ['init', '--agents', 'claude,codex', '--yes']);
  assert.equal(r.code, 0, r.err);
  const agents = repo.read('AGENTS.md');
  assert.ok(agents.startsWith('# Team rules\r\n\r\nBe kind.\r\n'));
  assert.match(agents, /<!-- baton:begin v1 -->\r\n## Baton protocol/);
  assert.equal(agents.includes('\n') && agents.replace(/\r\n/g, '').includes('\n'), false, 'file keeps CRLF endings throughout');
  assert.equal(repo.read('package.json'), '{\n\t"name": "demo-app",\n\t"scripts": {\n\t\t"test": "node --test",\n\t\t"baton": "node .baton/runtime/bin/baton.js"\n\t}\n}\n');
  assert.equal(JSON.parse(repo.read('.baton/config.json')).test.command, 'npm test');
  assert.equal(JSON.parse(repo.read('.baton/config.json')).project.name, 'demo-app');
  const before = snapshotTree(repo.root);
  await baton(repo.root, ['init', '--agents', 'claude,codex', '--yes']);
  assert.deepEqual(snapshotTree(repo.root), before);
  assert.equal(repo.read('AGENTS.md').match(/baton:begin/g).length, 1);
}));

test('package.json script that already exists is left alone with a note', () => withRepo({
  git: true, files: { 'package.json': '{\n  "scripts": { "baton": "my-own thing" }\n}\n' },
}, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(repo.read('package.json')).scripts.baton, 'my-own thing');
  assert.match(r.out, /scripts\.baton is already set/);
}));

test('Python project: detects stack and pytest, writes no package.json', () => withRepo({ git: true, files: { 'pyproject.toml': '[project]\nname = "x"\n' } }, async (repo) => {
  const r = await baton(repo.root, ['init', '--agents', 'claude,codex', '--yes']);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.deepEqual(cfg.project.stack, ['python']);
  assert.equal(cfg.test.command, 'python -m pytest -q');
  assert.ok(!repo.exists('package.json'));
  const d = await baton(repo.root, ['doctor']);
  assert.equal(d.code, 0, d.out);
}));

test('non-git folder: works, keeps state under .baton/state, doctor passes with a note', () => withRepo({ git: false }, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.ok(repo.exists('.baton/state/events'));
  assert.ok(repo.exists('.baton/ledger'));
  const d = await baton(repo.root, ['doctor']);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /not a git repository/);
  const before = snapshotTree(repo.root);
  await baton(repo.root, ['init', ...CC]);
  assert.deepEqual(snapshotTree(repo.root), before);
}));

test('no test command detected: init says so and does not require tests', () => withRepo({ git: true }, async (repo) => {
  const r = await baton(repo.root, ['init', '--agents', 'claude,codex', '--yes']);
  assert.match(r.out, /no test command detected/);
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.equal(cfg.test.command, '');
  assert.equal(cfg.test.required, false);
  assert.equal((await baton(repo.root, ['doctor'])).code, 0);
}));

test('user-modified generated file is kept and a .baton-new sidecar is written; --force overwrites', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', ...CC]);
  const rel = '.claude/commands/baton-plan.md';
  const original = repo.read(rel);
  repo.write(rel, 'my own plan command\n');
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read(rel), 'my own plan command\n');
  assert.equal(repo.read(`${rel}.baton-new`), original);
  assert.match(r.out, /skip\s+\.claude\/commands\/baton-plan\.md/);
  assert.match(r.out, /was modified by you/);
  // stable on the next run
  const snap = snapshotTree(repo.root);
  await baton(repo.root, ['init', ...CC]);
  assert.deepEqual(snapshotTree(repo.root), snap);
  const forced = await baton(repo.root, ['init', ...CC, '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(repo.read(rel), original);
  assert.ok(!repo.exists(`${rel}.baton-new`), 'stale sidecar removed');
}));

test('a pre-existing untracked file is never overwritten', () => withRepo({ git: true, files: { '.claude/commands/baton-status.md': 'mine\n', 'CLAUDE.md': '# Claude notes\n' } }, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read('.claude/commands/baton-status.md'), 'mine\n');
  assert.ok(repo.exists('.claude/commands/baton-status.md.baton-new'));
  assert.ok(repo.read('CLAUDE.md').startsWith('# Claude notes\n'));
  assert.match(repo.read('CLAUDE.md'), /@AGENTS\.md/);
}));

test('unmodified generated files follow template changes without a sidecar', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', ...CC]);
  const next = makeFixtureTemplates();
  try {
    fs.writeFileSync(path.join(next, 'adapters/claude/command.md.tpl'), 'NEW {{cmdTitle}} -> {{cli}} {{cmd}}\n');
    const r = await baton(repo.root, ['init', ...CC], installEnv({ BATON_TEMPLATES_DIR: next }));
    assert.equal(r.code, 0, r.err);
    assert.equal(repo.read('.claude/commands/baton-plan.md'), 'NEW Plan -> node .baton/runtime/bin/baton.js plan\n');
    assert.ok(!repo.exists('.claude/commands/baton-plan.md.baton-new'));
  } finally { fs.rmSync(next, { recursive: true, force: true }); }
}));

test('--dry-run writes nothing and lists exactly what a real run writes', () => withRepo({ git: true, files: { 'package.json': '{"name":"x"}\n' } }, async (repo) => {
  const before = snapshotTree(repo.root);
  const dry = await baton(repo.root, ['init', ...CC, '--cloud', '--hooks', '--dry-run', '--json']);
  assert.equal(dry.code, 0, dry.err);
  assert.deepEqual(snapshotTree(repo.root), before);
  const dryDoc = JSON.parse(dry.out);
  assert.equal(dryDoc.dryRun, true);
  assert.equal(readEvents(repo.root).length, 0);
  const human = await baton(repo.root, ['init', ...CC, '--dry-run']);
  assert.match(human.out, /would create\s+\.baton\/config\.json/);
  assert.match(human.out, /dry run: nothing was written/);
  const real = await baton(repo.root, ['init', ...CC, '--cloud', '--hooks', '--json']);
  const realDoc = JSON.parse(real.out);
  const sig = (doc) => doc.ops.map((o) => `${o.action} ${o.path}`).sort();
  assert.deepEqual(sig(dryDoc), sig(realDoc));
  for (const o of realDoc.ops) if (o.action !== 'unchanged') assert.ok(fs.existsSync(path.join(repo.root, o.path)), o.path);
}));

test('--no-vendor skips the runtime and uses a global baton command', () => withRepo({ git: true, files: { 'package.json': '{"name":"x"}\n' } }, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC, '--no-vendor']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!repo.exists('.baton/runtime'));
  assert.ok(!repo.exists('.baton/baton'));
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.equal(cfg.runtime.vendored, false);
  assert.equal(cfg.runtime.command, 'baton');
  assert.equal(JSON.parse(repo.read('package.json')).scripts.baton, 'baton');
  assert.match(repo.read('AGENTS.md'), /Run `baton next/);
  const d = await baton(repo.root, ['doctor']);
  assert.equal(d.code, 0, d.out);
}));

test('--hooks merges into .claude/settings.json without clobbering existing hooks', () => withRepo({
  git: true,
  files: { '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 4) + '\n' },
}, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC, '--hooks']);
  assert.equal(r.code, 0, r.err);
  const text = repo.read('.claude/settings.json');
  assert.ok(text.includes('\n    "permissions"'), 'indent preserved');
  const s = JSON.parse(text);
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.match(s.hooks.PreToolUse[1].hooks[0].command, /baton\.js guard --hook claude/);
  assert.equal(s.hooks.Stop.length, 1);
  await baton(repo.root, ['init', ...CC, '--hooks']);
  assert.equal(repo.read('.claude/settings.json'), text);
  assert.equal(JSON.parse(repo.read('.claude/settings.json')).hooks.PreToolUse.length, 2);
}));

test('--hooks on invalid settings.json leaves the file untouched', () => withRepo({ git: true, files: { '.claude/settings.json': '{ not json' } }, async (repo) => {
  const r = await baton(repo.root, ['init', ...CC, '--hooks']);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read('.claude/settings.json'), '{ not json');
  assert.match(r.out, /not valid JSON/);
}));

test('--cloud writes workflows, keeps GitHub expressions, and only adds the claude workflow for a claude agent', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--cloud']);
  assert.match(repo.read('.github/workflows/baton-ci.yml'), /run: node \.baton\/runtime\/bin\/baton\.js check/);
  assert.match(repo.read('.github/workflows/baton-ci.yml'), /\$\{\{ github\.sha \}\}/);
  assert.match(repo.read('.github/workflows/baton-ci.yml'), /echo \$\{\{ github\.ref \}\} \$\{\{ matrix\.os == 'x' \}\}/, '$[[ expr ]] is turned into a GitHub expression');
  assert.match(repo.read('.github/workflows/baton-claude.yml'), /\$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.ok(repo.exists('.github/workflows/baton-dispatch.yml'));
  assert.ok(repo.exists('.github/PULL_REQUEST_TEMPLATE.md'));
  const other = makeTempRepo({ git: true });
  try {
    await baton(other.root, ['init', '--agents', 'codex,gemini', '--yes', '--cloud', '--test-cmd', 'node -e 0']);
    assert.ok(!other.exists('.github/workflows/baton-claude.yml'));
    assert.ok(other.exists('.github/workflows/baton-ci.yml'));
  } finally { other.cleanup(); }
}));

test('--cloud never overwrites an existing pull request template (onlyIfAbsent); once created it is yours', () => withRepo({ git: true, files: { '.github/PULL_REQUEST_TEMPLATE.md': 'my template\n' } }, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--cloud']);
  assert.equal(repo.read('.github/PULL_REQUEST_TEMPLATE.md'), 'my template\n');
  assert.ok(!repo.exists('.github/PULL_REQUEST_TEMPLATE.md.baton-new'));
  const other = makeTempRepo({ git: true });
  try {
    await baton(other.root, ['init', ...CC, '--cloud']);
    assert.match(other.read('.github/PULL_REQUEST_TEMPLATE.md'), /Sign-off for/);
    other.write('.github/PULL_REQUEST_TEMPLATE.md', 'edited later\n');
    await baton(other.root, ['init', ...CC, '--cloud']);
    assert.equal(other.read('.github/PULL_REQUEST_TEMPLATE.md'), 'edited later\n', 'created once, then yours');
    const r = await baton(other.root, ['uninstall', '--yes']);
    assert.match(r.out, /kept\s+\.github\/PULL_REQUEST_TEMPLATE\.md/);
  } finally { other.cleanup(); }
}));

test('--no-git-ignore leaves .gitignore and .gitattributes alone', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--no-git-ignore']);
  assert.ok(!repo.exists('.gitignore'));
  assert.ok(!repo.exists('.gitattributes'));
}));

test('auto roster: detected CLIs and existing agent dirs, padded to two agents', () => withRepo({ git: true, files: { '.cursor/rules/old.mdc': '' } }, async (repo) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bin-'));
  try {
    fakeBin(bin, 'gemini');
    const r = await baton(repo.root, ['init', '--yes', '--test-cmd', 'node -e 0'], isolatedEnv(bin));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(repo.read('.baton/config.json')).agents.map((a) => a.id), ['gemini', 'cursor']);
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  const empty = makeTempRepo({ git: true });
  const bin2 = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bin-'));
  try {
    const r = await baton(empty.root, ['init', '--yes', '--test-cmd', 'node -e 0'], isolatedEnv(bin2));
    assert.deepEqual(JSON.parse(empty.read('.baton/config.json')).agents.map((a) => a.id), ['claude', 'codex']);
    assert.match(r.out, /no second agent detected|added claude, codex/);
  } finally { fs.rmSync(bin2, { recursive: true, force: true }); empty.cleanup(); }
}));

test('init refuses an unknown agent id with a clear message', () => withRepo({ git: true }, async (repo) => {
  const r = await baton(repo.root, ['init', '--agents', 'Bad Agent', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid agent id/);
  assert.ok(!repo.exists('.baton'));
}));

test('init from a subdirectory installs at the git root and never outside it', () => withRepo({ git: true, files: { 'sub/dir/file.txt': 'x' } }, async (repo) => {
  const r = await baton(path.join(repo.root, 'sub', 'dir'), ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.ok(repo.exists('.baton/config.json'));
  assert.ok(!repo.exists('sub/dir/.baton'));
  assert.ok(!fs.existsSync(path.join(path.dirname(repo.root), '.baton')));
}));

test('--name and --test-cmd apply to a fresh project and to a re-run', () => withRepo({ git: true }, async (repo) => {
  await baton(repo.root, ['init', '--agents', 'claude,codex', '--yes', '--name', 'Acme', '--test-cmd', 'make check']);
  let cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.equal(cfg.project.name, 'Acme');
  assert.equal(cfg.test.command, 'make check');
  await baton(repo.root, ['init', '--yes', '--test-cmd', 'node -e 1', '--agents', 'gemini']);
  cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.equal(cfg.test.command, 'node -e 1');
  assert.deepEqual(cfg.agents.map((a) => a.id), ['claude', 'codex', 'gemini']);
  assert.equal(cfg.orchestrator, 'claude');
  assert.ok(repo.exists('GEMINI.md'));
}));

test('real CLI: non-TTY init needs no answers, and the vendored runtime works with zero install', () => withRepo({ git: true }, async (repo) => {
  const r = runCli(repo.root, ['init', '--agents', 'claude,codex', '--test-cmd', 'node -e 0'], { BATON_TEMPLATES_DIR: templates() });
  assert.equal(r.status, 0, r.stderr);
  const v = runNode(repo.root, ['.baton/runtime/bin/baton.js', 'version']);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^baton \d+\.\d+\.\d+/);
  const doc = runNode(repo.root, ['.baton/runtime/bin/baton.js', 'doctor', '--json']);
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.equal(JSON.parse(doc.stdout).ok, true);
  const again = runNode(repo.root, ['.baton/runtime/bin/baton.js', 'upgrade']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to change/);
  if (process.platform !== 'win32') {
    const sh = runNode(repo.root, ['-e', 'const {spawnSync}=require("child_process");const r=spawnSync("sh",[".baton/baton","version"],{encoding:"utf8"});process.stdout.write(r.stdout);process.exit(r.status)']);
    assert.match(sh.stdout, /^baton /);
  }
}));
