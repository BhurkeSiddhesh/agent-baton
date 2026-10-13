import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, samplePlan } from './helpers.js';
import { readEvents } from '../src/lib/store.js';
import { loadManifest, saveManifest, hashContent } from '../src/install/manifest.js';
import os from 'node:os';
import { baton, isolatedEnv, snapshotTree } from './install-fixture.test.js';

const CC = ['--agents', 'claude,codex', '--yes', '--test-cmd', 'node -e 0'];

async function withInstalled(opts, fn) {
  const repo = makeTempRepo({ git: true, ...opts });
  try {
    const r = await baton(repo.root, ['init', ...CC]);
    assert.equal(r.code, 0, r.err);
    await fn(repo);
  } finally { repo.cleanup(); }
}

/* ------------------------------------------------------------------ upgrade */

test('upgrade refreshes the runtime, restores deleted files, removes stale tracked files and reports versions', () => withInstalled({}, async (repo) => {
  // an old vendored version with a leftover tracked file and a drifted runtime file
  fs.writeFileSync(path.join(repo.root, '.baton/runtime/package.json'), '{"name":"baton-runtime","version":"0.0.1","type":"module"}\n');
  fs.writeFileSync(path.join(repo.root, '.baton/runtime/src/old-module.js'), 'export {};\n');
  fs.writeFileSync(path.join(repo.root, '.baton/runtime/src/cli.js'), '// tampered\n');
  fs.rmSync(path.join(repo.root, '.claude/commands/baton-next.md'));
  const m = loadManifest(repo.root);
  m.files['.baton/runtime/src/old-module.js'] = { mode: 'file', group: 'runtime', sha256: hashContent('export {};\n') };
  saveManifest(repo.root, m);

  const dry = await baton(repo.root, ['upgrade', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /dry run: nothing was written/);
  assert.ok(repo.exists('.baton/runtime/src/old-module.js'));
  assert.ok(!repo.exists('.claude/commands/baton-next.md'));

  const r = await baton(repo.root, ['upgrade']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /vendored runtime 0\.0\.1 -> 0\.1\.0/);
  assert.ok(!repo.exists('.baton/runtime/src/old-module.js'));
  assert.notEqual(repo.read('.baton/runtime/src/cli.js'), '// tampered\n');
  assert.ok(repo.exists('.claude/commands/baton-next.md'));
  assert.equal(JSON.parse(repo.read('.baton/runtime/package.json')).version, '0.1.0');
  const second = await baton(repo.root, ['upgrade']);
  assert.match(second.out, /nothing to change/);
}));

test('upgrade keeps user-edited files (sidecar) and a user-edited block is replaced in place', () => withInstalled({ files: { 'AGENTS.md': '# Mine\n' } }, async (repo) => {
  const rel = '.codex/agents/baton-worker.toml';
  const original = repo.read(rel);
  repo.write(rel, '# edited\n');
  repo.write('AGENTS.md', repo.read('AGENTS.md').replace('## Baton protocol', '## Baton protocol (edited by hand)'));
  const r = await baton(repo.root, ['upgrade']);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read(rel), '# edited\n');
  assert.equal(repo.read(`${rel}.baton-new`), original);
  assert.ok(!repo.read('AGENTS.md').includes('edited by hand'));
  assert.ok(repo.read('AGENTS.md').startsWith('# Mine\n'));
}));

test('upgrade keeps refreshing cloud files and hooks that were installed earlier', () => withInstalled({}, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--cloud', '--hooks']);
  fs.rmSync(path.join(repo.root, '.github/workflows/baton-ci.yml'));
  const r = await baton(repo.root, ['upgrade', '--json']);
  const doc = JSON.parse(r.out);
  assert.equal(doc.cloud, true);
  assert.equal(doc.hooks, true);
  assert.ok(repo.exists('.github/workflows/baton-ci.yml'));
}));

test('upgrade outside a baton project fails with a hint', async () => {
  const repo = makeTempRepo({ git: true });
  try {
    const r = await baton(repo.root, ['upgrade']);
    assert.equal(r.code, 1);
    assert.match(r.err, /not a baton project/);
    assert.match(r.err, /baton init/);
  } finally { repo.cleanup(); }
});

/* ------------------------------------------------------------------ doctor */

test('doctor: healthy install reports ok and --json is a single document', () => withInstalled({}, async (repo) => {
  const r = await baton(repo.root, ['doctor', '--json']);
  assert.equal(r.code, 0, r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.ok, true);
  assert.equal(doc.errors, 0);
  const ids = doc.checks.map((c) => c.id);
  for (const id of ['node', 'git', 'config', 'plan', 'test-command', 'runtime', 'adapters', 'ledger']) assert.ok(ids.includes(id), id);
  assert.ok(doc.checks.every((c) => ['ok', 'info', 'warn', 'error'].includes(c.status)));
  assert.equal(r.err, '');
}));

test('doctor: errors exit 1 (no config, missing runtime, corrupt config, tampered ledger)', async () => {
  const bare = makeTempRepo({ git: true });
  try {
    const r = await baton(bare.root, ['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR .*config\.json is missing/);
  } finally { bare.cleanup(); }

  await withInstalled({}, async (repo) => {
    fs.rmSync(path.join(repo.root, '.baton/runtime/bin/baton.js'));
    const r = await baton(repo.root, ['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /ERROR .*baton\.js is missing/);
  });

  await withInstalled({}, async (repo) => {
    repo.write('.baton/config.json', '{ broken');
    const r = await baton(repo.root, ['doctor', '--json']);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out).checks.find((c) => c.id === 'config').status, 'error');
  });

  await withInstalled({}, async (repo) => {
    const ev = readEvents(repo.root)[0];
    const file = path.join(repo.root, '.baton/ledger', `${ev.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...ev, note: 'tampered' }, null, 2) + '\n');
    const r = await baton(repo.root, ['doctor']);
    assert.equal(r.code, 1);
    assert.match(r.out, /ledger integrity problem/);
  });
});

test('doctor: modified adapter files, an invalid plan and a missing test tool are warnings or errors with hints', () => withInstalled({}, async (repo) => {
  repo.write('.claude/agents/baton-worker.md', 'changed\n');
  let r = await baton(repo.root, ['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warn .*adapter issue/);
  assert.match(r.out, /-> run "baton agents install"/);
  repo.write('.baton/plan.json', JSON.stringify(samplePlan({ packets: [{ id: 'WP-001', title: 't', agent: 'ghost', reviewer: 'claude', owns: ['a.js'] }] })));
  r = await baton(repo.root, ['doctor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /plan invalid/);
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  cfg.test.command = 'definitely-not-a-real-tool-xyz --run';
  repo.write('.baton/config.json', JSON.stringify(cfg, null, 2));
  repo.write('.baton/plan.json', JSON.stringify({ version: 1, goal: '', tracks: [], gates: [], milestones: [], packets: [] }));
  r = await baton(repo.root, ['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /warn .*"definitely-not-a-real-tool-xyz" was not found/);
}));

test('doctor: a vendored runtime older than this baton is a warning', () => withInstalled({}, async (repo) => {
  fs.writeFileSync(path.join(repo.root, '.baton/runtime/package.json'), '{"name":"baton-runtime","version":"0.0.1","type":"module"}\n');
  const r = await baton(repo.root, ['doctor']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /vendored runtime is 0\.0\.1 but this baton is 0\.1\.0/);
}));

/* ------------------------------------------------------------------ agents */

test('agents list shows the roster, files installed and detected agents not in it (--json too)', () => withInstalled({ files: { '.gemini/settings.json': '{}' } }, async (repo) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bin-'));
  const env = isolatedEnv(bin);
  const r = await baton(repo.root, ['agents', 'list'], env);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Roster \(orchestrator: claude\)/);
  assert.match(r.out, /claude\s+Claude\s+\[claude\]/);
  assert.match(r.out, /Detected but not in the roster: gemini/);
  const doc = JSON.parse((await baton(repo.root, ['agents', 'list', '--json'], env)).out);
  assert.deepEqual(doc.agents.map((a) => a.id), ['claude', 'codex']);
  const claude = doc.agents.find((a) => a.id === 'claude');
  assert.equal(claude.orchestrator, true);
  assert.ok(claude.files.tracked >= 10 && claude.files.present === claude.files.tracked);
  assert.deepEqual(doc.detectedNotInRoster.map((d) => d.id), ['gemini']);
  fs.rmSync(bin, { recursive: true, force: true });
}));

test('agents add writes config and adapter files and refreshes the roster in AGENTS.md; remove prunes them', () => withInstalled({}, async (repo) => {
  const r = await baton(repo.root, ['agents', 'add', 'gemini', '--roles', 'worker,reviewer', '--strengths', 'frontend,docs']);
  assert.equal(r.code, 0, r.err);
  const cfg = JSON.parse(repo.read('.baton/config.json'));
  const g = cfg.agents.find((a) => a.id === 'gemini');
  assert.deepEqual(g.roles, ['worker', 'reviewer']);
  assert.deepEqual(g.strengths, ['frontend', 'docs']);
  assert.ok(repo.exists('GEMINI.md'));
  assert.match(repo.read('AGENTS.md'), /- gemini \(Gemini\): worker, reviewer/);
  assert.ok(loadManifest(repo.root).files['GEMINI.md']);

  const dup = await baton(repo.root, ['agents', 'add', 'gemini']);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /already in the roster/);

  const rm = await baton(repo.root, ['agents', 'remove', 'gemini']);
  assert.equal(rm.code, 0, rm.err);
  assert.ok(!repo.exists('GEMINI.md'), 'file that only held the baton block is deleted');
  assert.ok(!JSON.parse(repo.read('.baton/config.json')).agents.some((a) => a.id === 'gemini'));
  assert.ok(!repo.read('AGENTS.md').includes('gemini'));
  assert.ok(!loadManifest(repo.root).files['GEMINI.md']);
}));

test('agents remove keeps user content around a removed block and files the user edited', () => withInstalled({ files: { 'GEMINI.md': '# my gemini notes\n' } }, async (repo) => {
  await baton(repo.root, ['agents', 'add', 'gemini']);
  assert.ok(repo.read('GEMINI.md').startsWith('# my gemini notes\n'));
  await baton(repo.root, ['agents', 'add', 'cursor']);
  repo.write('.cursor/rules/baton.mdc', 'my cursor rule\n');
  const r = await baton(repo.root, ['agents', 'remove', 'gemini']);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read('GEMINI.md'), '# my gemini notes\n');
  const r2 = await baton(repo.root, ['agents', 'remove', 'cursor']);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(repo.read('.cursor/rules/baton.mdc'), 'my cursor rule\n');
  assert.match(r2.out, /modified by you; left in place/);
}));

test('agents add validates ids, roles and duplicates', () => withInstalled({}, async (repo) => {
  for (const [args, code, re] of [
    [['agents', 'add', 'Bad_ID'], 2, /invalid agent id/],
    [['agents', 'add', 'human'], 2, /invalid agent id/],
    [['agents', 'add', 'newbie', '--roles', 'wizard'], 2, /unknown role/],
    [['agents', 'add'], 2, /needs an agent id/],
    [['agents', 'frobnicate'], 2, /unknown subcommand/],
  ]) {
    const r = await baton(repo.root, args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, re);
  }
  assert.equal(JSON.parse(repo.read('.baton/config.json')).agents.length, 2);
}));

test('agents remove refuses the orchestrator, the last agent and agents the plan still uses (unless --force)', () => withInstalled({}, async (repo) => {
  let r = await baton(repo.root, ['agents', 'remove', 'claude']);
  assert.equal(r.code, 1);
  assert.match(r.err, /is the orchestrator/);
  repo.write('.baton/plan.json', JSON.stringify(samplePlan({
    tracks: [], gates: [], milestones: [],
    packets: [{ id: 'WP-001', title: 't', agent: 'codex', reviewer: 'claude', owns: ['a.js'] }],
  })));
  r = await baton(repo.root, ['agents', 'remove', 'codex']);
  assert.equal(r.code, 1);
  assert.match(r.err, /plan still references "codex": WP-001 author/);
  assert.ok(JSON.parse(repo.read('.baton/config.json')).agents.some((a) => a.id === 'codex'));
  r = await baton(repo.root, ['agents', 'remove', 'codex', '--force']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!repo.exists('.codex/agents/baton-worker.toml'));
  r = await baton(repo.root, ['agents', 'remove', 'claude']);
  assert.match(r.err, /orchestrator|last agent/);
}));

test('agents set changes roles and the orchestrator, and keeps the orchestrator role', () => withInstalled({}, async (repo) => {
  let r = await baton(repo.root, ['agents', 'set', 'codex', '--roles', 'worker', '--strengths', 'db,api']);
  assert.equal(r.code, 0, r.err);
  let cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.deepEqual(cfg.agents[1].roles, ['worker']);
  assert.match(repo.read('AGENTS.md'), /- codex \(Codex\): worker\n/);
  r = await baton(repo.root, ['agents', 'set', 'claude', '--roles', 'worker']);
  assert.equal(r.code, 1);
  assert.match(r.err, /must keep the orchestrator role/);
  r = await baton(repo.root, ['agents', 'set', 'codex', '--orchestrator']);
  assert.equal(r.code, 0, r.err);
  cfg = JSON.parse(repo.read('.baton/config.json'));
  assert.equal(cfg.orchestrator, 'codex');
  assert.ok(cfg.agents[1].roles.includes('orchestrator'));
  r = await baton(repo.root, ['agents', 'set', 'codex']);
  assert.equal(r.code, 2);
}));

test('agents install restores adapter files (optionally only one agent) and --dry-run writes nothing', () => withInstalled({}, async (repo) => {
  fs.rmSync(path.join(repo.root, '.claude/agents/baton-worker.md'));
  fs.rmSync(path.join(repo.root, '.codex/agents/baton-worker.toml'));
  const before = snapshotTree(repo.root);
  const dry = await baton(repo.root, ['agents', 'install', '--dry-run']);
  assert.match(dry.out, /would create\s+\.claude\/agents\/baton-worker\.md/);
  assert.deepEqual(snapshotTree(repo.root), before);
  const only = await baton(repo.root, ['agents', 'install', '--only', 'claude']);
  assert.equal(only.code, 0, only.err);
  assert.ok(repo.exists('.claude/agents/baton-worker.md'));
  assert.ok(!repo.exists('.codex/agents/baton-worker.toml'));
  await baton(repo.root, ['agents', 'install']);
  assert.ok(repo.exists('.codex/agents/baton-worker.toml'));
  const bad = await baton(repo.root, ['agents', 'install', '--only', 'nope']);
  assert.equal(bad.code, 1);
}));

test('custom agents declared in .baton/agents.json get an instruction block', () => withInstalled({ files: { '.baton/agents.json': JSON.stringify([{ id: 'mybot', label: 'My Bot', instructionFile: 'MYBOT.md' }]) } }, async (repo) => {
  const r = await baton(repo.root, ['agents', 'add', 'mybot', '--kind', 'custom']);
  assert.equal(r.code, 0, r.err);
  assert.match(repo.read('MYBOT.md'), /next --agent mybot/);
  assert.match(repo.read('MYBOT.md'), /<!-- baton:begin v1 -->/);
}));

/* ------------------------------------------------------------------ uninstall */

test('uninstall restores the repository: blocks stripped, script removed, generated files gone', async () => {
  const pkg = '{\n  "name": "demo",\n  "scripts": {\n    "test": "node --test"\n  }\n}\n';
  const repo = makeTempRepo({ git: true, files: { 'AGENTS.md': '# Mine\n', 'package.json': pkg, '.gitignore': 'node_modules/\n' } });
  try {
    await baton(repo.root, ['init', ...CC, '--cloud', '--hooks']);
    assert.notEqual(repo.read('package.json'), pkg);
    const r = await baton(repo.root, ['uninstall', '--yes']);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(repo.read('AGENTS.md'), '# Mine\n');
    assert.equal(repo.read('package.json'), pkg);
    assert.equal(repo.read('.gitignore'), 'node_modules/\n');
    for (const gone of ['.baton', 'CLAUDE.md', '.claude', '.codex', '.github', '.gitattributes']) assert.ok(!repo.exists(gone), `${gone} should be gone`);
    // the local ledger store inside .git is removed too
    assert.ok(!fs.existsSync(path.join(repo.root, '.git', 'baton')));
  } finally { repo.cleanup(); }
});

test('uninstall keeps modified files and edited blocks, and lists them', () => withInstalled({ files: { 'CLAUDE.md': '# c\n' } }, async (repo) => {
  repo.write('.claude/agents/baton-worker.md', 'my worker\n');
  repo.write('AGENTS.md', repo.read('AGENTS.md').replace('Roster:', 'Roster (hand edited):'));
  const r = await baton(repo.root, ['uninstall', '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read('.claude/agents/baton-worker.md'), 'my worker\n');
  assert.match(repo.read('AGENTS.md'), /hand edited/);
  assert.match(r.out, /kept\s+\.claude\/agents\/baton-worker\.md\s+\(modified by you\)/);
  assert.match(r.out, /kept\s+AGENTS\.md\s+\(managed block was edited by you\)/);
  assert.equal(repo.read('CLAUDE.md'), '# c\n');
  assert.ok(!repo.exists('.claude/agents/baton-reviewer.md'));
  assert.ok(!repo.exists('.baton'));
}));

test('uninstall without --yes refuses in a non-interactive shell; --dry-run lists and removes nothing', () => withInstalled({}, async (repo) => {
  const before = snapshotTree(repo.root);
  const refuse = await baton(repo.root, ['uninstall']);
  assert.equal(refuse.code, 1);
  assert.match(refuse.err, /without confirmation/);
  const dry = await baton(repo.root, ['uninstall', '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /would remove\s+CLAUDE\.md/);
  assert.deepEqual(snapshotTree(repo.root), before);
  const doc = JSON.parse((await baton(repo.root, ['uninstall', '--dry-run', '--json'])).out);
  assert.equal(doc.dryRun, true);
  assert.ok(doc.removed.includes('.baton/manifest.json'));
}));

test('uninstall --keep-ledger keeps the ledger, config and plan', () => withInstalled({}, async (repo) => {
  const r = await baton(repo.root, ['uninstall', '--yes', '--keep-ledger']);
  assert.equal(r.code, 0, r.err);
  assert.ok(repo.exists('.baton/ledger'));
  assert.ok(repo.exists('.baton/config.json'));
  assert.ok(repo.exists('.baton/plan.json'));
  assert.ok(!repo.exists('.baton/runtime'));
  assert.ok(!repo.exists('.baton/manifest.json'));
  assert.ok(!repo.exists('CLAUDE.md'));
  // re-installing afterwards works and does not add a second init event
  const again = await baton(repo.root, ['init', ...CC]);
  assert.equal(again.code, 0, again.err);
  assert.equal(readEvents(repo.root).filter((e) => e.kind === 'init').length, 1);
}));

test('uninstall in a repository without baton fails cleanly', async () => {
  const repo = makeTempRepo({ git: true });
  try {
    const r = await baton(repo.root, ['uninstall', '--yes']);
    assert.equal(r.code, 1);
    assert.match(r.err, /nothing to uninstall/);
  } finally { repo.cleanup(); }
});

test('uninstall removes an unedited hooks file but keeps the user settings when they exist', () => withInstalled({ files: { '.claude/settings.json': '{\n  "model": "opus"\n}\n' } }, async (repo) => {
  await baton(repo.root, ['init', ...CC, '--hooks']);
  assert.ok(JSON.parse(repo.read('.claude/settings.json')).hooks);
  const r = await baton(repo.root, ['uninstall', '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.equal(repo.read('.claude/settings.json'), '{\n  "model": "opus"\n}\n');
}));
