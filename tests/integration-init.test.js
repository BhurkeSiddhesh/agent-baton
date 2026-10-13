// Integration tests for `baton init` and friends against the REAL templates, through the real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeTempRepo, runCli, runNode } from './helpers.js';

const TEST_CMD = 'node -e "process.exit(0)"';

function ok(root, args, env = {}) {
  const r = runCli(root, args, env);
  assert.equal(r.status, 0, `baton ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** relative posix path -> sha256 for every file under root (skipping .git). */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** Files that legitimately change between runs: the ledger gets no new events on a no-op re-run, but state may. */
const volatile = (k) => k.startsWith('.baton/state/') || k.startsWith('.baton/views/');
function stable(root) {
  return Object.fromEntries(Object.entries(tree(root)).filter(([k]) => !volatile(k)));
}

function withRepo(opts, fn) {
  const t = makeTempRepo(opts);
  try {
    return fn(t);
  } finally {
    t.cleanup();
  }
}

const BLOCK_RE = /<!-- baton:begin[^>]*-->[\s\S]*?<!-- baton:end[^>]*-->/;

test('init in an empty git repo, idempotent, doctor passes', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--test-cmd', TEST_CMD]);
    for (const f of ['.baton/config.json', '.baton/plan.json', '.baton/manifest.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore', '.gitattributes', '.baton/runtime/bin/baton.js', '.baton/runtime/templates/adapters.json']) {
      assert.ok(t.exists(f), `${f} exists`);
    }
    assert.match(t.read('.gitignore'), /\.baton\/state\//);
    assert.match(t.read('.gitignore'), /\.baton\/views\//);
    ok(t.root, ['doctor']);
    ok(t.root, ['check']);

    const before = stable(t.root);
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--test-cmd', TEST_CMD]);
    assert.deepEqual(stable(t.root), before, 'second init changes nothing (manifest stable)');
    ok(t.root, ['doctor']);
  });
});

test('init in an existing Node project preserves AGENTS.md and CLAUDE.md outside managed blocks', () => {
  const agents = '# My project rules\r\n\r\nAlways use tabs.\n\nNo trailing newline here';
  const claude = '# Claude notes\n\nKeep it short.\n';
  const pkg = JSON.stringify({ name: 'n', scripts: { test: TEST_CMD, lint: 'echo lint' } }, null, 4) + '\n';
  withRepo({ git: true, files: { 'AGENTS.md': agents, 'CLAUDE.md': claude, 'package.json': pkg } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    for (const [file, original] of [['AGENTS.md', agents], ['CLAUDE.md', claude]]) {
      const now = fs.readFileSync(path.join(t.root, file), 'utf8');
      assert.match(now, BLOCK_RE, `${file} has a managed block`);
      assert.equal(now.replace(BLOCK_RE, ''), original.length ? now.replace(BLOCK_RE, '') : '', 'sanity');
      assert.ok(now.startsWith(original), `${file} starts with the original bytes`);
      // the remainder after the original is only the managed block (plus separators)
      assert.equal(now.slice(original.length).replace(BLOCK_RE, '').trim(), '', `${file} gained only the managed block`);
    }
    const p = JSON.parse(t.read('package.json'));
    assert.equal(p.scripts.lint, 'echo lint');
    assert.ok(p.scripts.baton);
    assert.equal(JSON.parse(t.read('.baton/config.json')).test.command, 'npm test');

    // a re-run must not duplicate the block or touch the user text
    const once = t.read('AGENTS.md');
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    assert.equal(t.read('AGENTS.md'), once);
    assert.equal((t.read('AGENTS.md').match(/baton:begin/g) || []).length, 1);
    ok(t.root, ['doctor']);

    // uninstall restores the user's files
    ok(t.root, ['uninstall', '--yes']);
    assert.ok(t.read('AGENTS.md').startsWith(agents));
    assert.doesNotMatch(t.read('AGENTS.md'), /baton:begin/);
    assert.equal(t.read('CLAUDE.md').trim(), claude.trim());
    assert.equal(JSON.parse(t.read('package.json')).scripts.baton, undefined);
    assert.equal(JSON.parse(t.read('package.json')).scripts.lint, 'echo lint');
  });
});

test('init in a Python project detects pytest', () => {
  withRepo({ git: true, files: { 'pyproject.toml': '[project]\nname = "x"\n', 'src/x.py': 'print(1)\n' } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    const cfg = JSON.parse(t.read('.baton/config.json'));
    assert.match(cfg.test.command, /pytest/);
    assert.ok(cfg.project.stack.includes('python'));
    assert.ok(!t.exists('package.json'), 'no package.json invented');
    ok(t.root, ['doctor']);
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
  });
});

test('init in a non-git folder uses .baton/state and works end to end', () => {
  withRepo({ git: false, files: { 'README.md': '# plain\n' } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--test-cmd', TEST_CMD]);
    assert.ok(!t.exists('.git'));
    ok(t.root, ['doctor']);
    ok(t.root, ['plan', 'add', '--title', 'One', '--owns', 'a.txt', '--agent', 'codex', '--reviewer', 'claude', '--by', 'claude']);
    ok(t.root, ['begin', 'WP-001', '--agent', 'codex']);
    t.write('a.txt', 'x\n');
    const v = JSON.parse(ok(t.root, ['verify', 'WP-001', '--json'], { BATON_AGENT: 'codex' }).stdout);
    assert.equal(v.ok, true);
    assert.ok(t.exists('.baton/state'), 'state lives under .baton/state outside git');
    const before = stable(t.root);
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--test-cmd', TEST_CMD]);
    const after = stable(t.root);
    for (const k of Object.keys(before)) if (!k.startsWith('.baton/ledger/')) assert.equal(after[k], before[k], k);
  });
});

test('a user-modified generated file is kept and a .baton-new sidecar is written', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    const f = '.claude/commands/baton-next.md';
    const mine = t.read(f) + '\nMY OWN LINE\n';
    t.write(f, mine);
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    assert.equal(t.read(f), mine, 'user edit preserved');
    assert.ok(t.exists(f + '.baton-new'), 'sidecar written');
    // --force replaces it
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--force']);
    assert.doesNotMatch(t.read(f), /MY OWN LINE/);
  });
});

test('--dry-run writes nothing', () => {
  withRepo({ git: true, files: { 'AGENTS.md': '# mine\n' } }, (t) => {
    const before = tree(t.root);
    const r = ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--dry-run']);
    assert.match(r.stdout, /AGENTS\.md/);
    assert.deepEqual(tree(t.root), before);
  });
});

test('--agents subset installs only those adapters', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,gemini']);
    assert.ok(t.exists('.claude/agents/baton-worker.md'));
    assert.ok(t.exists('GEMINI.md'));
    assert.ok(t.exists('.gemini/commands/baton/next.toml'));
    assert.ok(!t.exists('.codex'));
    assert.ok(!t.exists('.cursor'));
    assert.ok(!t.exists('.windsurf'));
    assert.deepEqual(JSON.parse(t.read('.baton/config.json')).agents.map((a) => a.id).sort(), ['claude', 'gemini']);
    ok(t.root, ['doctor']);
  });
});

test('--agents all installs every adapter with parseable output', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'all']);
    for (const f of ['.cursor/rules/baton.mdc', '.windsurf/rules/baton.md', '.clinerules/baton.md', '.agent/rules/baton.md', 'CONVENTIONS.md', '.github/copilot-instructions.md', '.opencode/agent/baton-worker.md']) {
      assert.ok(t.exists(f), f);
    }
    ok(t.root, ['doctor']);
  });
});

test('--cloud adds CI and cloud-agent workflows with valid GitHub expressions', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--cloud']);
    const wf = fs.readdirSync(path.join(t.root, '.github/workflows')).filter((f) => /baton/.test(f));
    assert.ok(wf.length >= 2, `workflows: ${wf}`);
    for (const f of wf) {
      const text = t.read(`.github/workflows/${f}`);
      assert.doesNotMatch(text, /\$\[\[/, `${f} has no unconverted expression markers`);
      assert.doesNotMatch(text, /(?<!\$)\{\{/, `${f} has no leftover template tags`);
    }
    ok(t.root, ['doctor']);
  });
});

test('--hooks merges into an existing .claude/settings.json without losing user settings', () => {
  const existing = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    model: 'sonnet',
  };
  withRepo({ git: true, files: { '.claude/settings.json': JSON.stringify(existing, null, 2) + '\n' } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--hooks']);
    const s = JSON.parse(t.read('.claude/settings.json'));
    assert.deepEqual(s.permissions, existing.permissions);
    assert.equal(s.model, 'sonnet');
    const all = JSON.stringify(s.hooks.PreToolUse);
    assert.match(all, /echo mine/);
    assert.match(all, /guard/);
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--hooks']);
    const again = JSON.parse(t.read('.claude/settings.json'));
    assert.deepEqual(again, s, 'merge is idempotent (no duplicate hook)');
    ok(t.root, ['doctor']);
    ok(t.root, ['uninstall', '--yes']);
    const gone = JSON.parse(t.read('.claude/settings.json'));
    assert.equal(gone.model, 'sonnet');
    assert.match(JSON.stringify(gone.hooks.PreToolUse), /echo mine/);
    assert.doesNotMatch(JSON.stringify(gone), /guard/);
  });
});

test('upgrade refreshes the vendored runtime and leaves state alone', () => {
  withRepo({ git: true }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    const planBefore = t.read('.baton/plan.json');
    // simulate an old vendored runtime
    const pkgFile = '.baton/runtime/package.json';
    const pkg = JSON.parse(t.read(pkgFile));
    pkg.version = '0.0.1';
    t.write(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    t.write('.baton/runtime/src/lib/util.js', '// tampered\n');
    ok(t.root, ['upgrade']);
    assert.notEqual(JSON.parse(t.read(pkgFile)).version, '0.0.1');
    assert.notEqual(t.read('.baton/runtime/src/lib/util.js'), '// tampered\n');
    assert.equal(t.read('.baton/plan.json'), planBefore);
    ok(t.root, ['doctor']);
  });
});

test('uninstall leaves user files and removes baton files', () => {
  withRepo({ git: true, files: { 'src/app.js': 'x\n', 'AGENTS.md': '# mine\n' } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    t.write('.claude/commands/my-own.md', 'mine\n');
    ok(t.root, ['uninstall', '--yes']);
    assert.equal(t.read('src/app.js'), 'x\n');
    assert.equal(t.read('AGENTS.md').trim(), '# mine');
    assert.equal(t.read('.claude/commands/my-own.md'), 'mine\n');
    assert.ok(!t.exists('.baton/runtime'));
    assert.ok(!t.exists('.claude/commands/baton-next.md'));
    assert.ok(!t.exists('.codex'));
  });
});

test('the vendored runtime works with no access to the source repo', () => {
  withRepo({ git: true, files: { 'package.json': JSON.stringify({ name: 'v', scripts: { test: TEST_CMD } }) + '\n' } }, (t) => {
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex']);
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'baton');
    // copy the project to a place that shares nothing with the baton source checkout
    const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baton-vendored-')));
    try {
      fs.cpSync(t.root, copy, { recursive: true });
      const st = runNode(copy, ['.baton/runtime/bin/baton.js', 'status', '--json']);
      assert.equal(st.status, 0, st.stderr);
      assert.equal(JSON.parse(st.stdout).packets.length, 0);
      const doc = runNode(copy, ['.baton/runtime/bin/baton.js', 'doctor']);
      assert.equal(doc.status, 0, doc.stdout + doc.stderr);
      const pr = runNode(copy, ['.baton/runtime/bin/baton.js', 'prompt', 'worker', '--agent', 'codex']);
      assert.equal(pr.status, 0, pr.stderr);
      assert.ok(pr.stdout.length > 200);
      // the shim and package script work too
      const shim = process.platform === 'win32' ? ['cmd', ['/c', '.baton\\baton.cmd', 'status']] : ['sh', ['.baton/baton', 'status']];
      const s = runNode(copy, ['-e', `const r=require('node:child_process').spawnSync(${JSON.stringify(shim[0])},${JSON.stringify(shim[1])},{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status??1)`]);
      assert.equal(s.status, 0, s.stdout + s.stderr);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
