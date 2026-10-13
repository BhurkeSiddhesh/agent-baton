import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyBlock, removeBlock, extractBlock, blockText, blockHash, findBlock } from '../src/install/managed-block.js';
import { mergeJson, unmergeJson, stringifyLike, detectIndent, hasGuardHook } from '../src/install/hooks.js';
import { detectStack, findOnPath, selectRoster, detectAgents } from '../src/install/detect.js';
import { loadRegistry, defaultAgentFor } from '../src/install/registry.js';
import { hashContent } from '../src/install/manifest.js';
import { renderText, safeRel } from '../src/install/installer.js';
import { collectRuntime } from '../src/install/vendor.js';
import { makeTempRepo } from './helpers.js';
import { installEnv, isolatedEnv, fakeBin, templates } from './install-fixture.test.js';

test('managed block: create, append, replace in place, idempotent', () => {
  const created = applyBlock(null, 'hello', 'html');
  assert.equal(created.action, 'create');
  assert.match(created.text, /^<!-- baton:begin v1 -->\nhello\n<!-- baton:end -->\n$/);
  const user = '# My notes\n\nkeep this\n';
  const appended = applyBlock(user, 'one', 'html');
  assert.equal(appended.action, 'append');
  assert.ok(appended.text.startsWith(user));
  const replaced = applyBlock(appended.text, 'two', 'html');
  assert.equal(replaced.action, 'replace');
  assert.ok(replaced.text.includes('two') && !replaced.text.includes('one'));
  assert.ok(replaced.text.startsWith(user));
  assert.equal(applyBlock(replaced.text, 'two', 'html').action, 'unchanged');
});

test('managed block: text around the block is preserved byte for byte and CRLF is respected', () => {
  const before = 'top\r\nline\r\n\r\n';
  const after = '\r\nbottom\r\n';
  const first = applyBlock(`${before}${blockText('a')}${after}`, 'b', 'html');
  assert.equal(first.action, 'replace');
  assert.ok(first.text.startsWith(before));
  assert.ok(first.text.endsWith(after));
  assert.ok(first.text.includes('b\r\n<!-- baton:end -->'));
  const appended = applyBlock('x\r\ny\r\n', 'z', 'html');
  assert.ok(/<!-- baton:begin v1 -->\r\nz\r\n<!-- baton:end -->\r\n$/.test(appended.text));
  // block hash ignores line ending style
  assert.equal(blockHash(extractBlock(appended.text)), blockHash(blockText('z')));
});

test('managed block: hash style, malformed markers and removal', () => {
  const t = applyBlock('node_modules/\n', '.baton/state/', 'hash');
  assert.equal(t.text, 'node_modules/\n\n# baton:begin v1\n.baton/state/\n# baton:end\n');
  assert.equal(removeBlock(t.text, 'hash'), 'node_modules/\n');
  assert.equal(removeBlock(blockText('only') + '\n'), '');
  assert.equal(applyBlock('<!-- baton:begin v1 -->\nno end', 'x').action, 'malformed');
  assert.equal(findBlock('nothing here'), null);
});

test('mergeJson keeps existing hooks, is idempotent and replaces an older baton entry in place', () => {
  const ours = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node .baton/runtime/bin/baton.js guard --hook claude' }] }] } };
  const user = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }], Stop: [{ hooks: [] }] } };
  const merged = mergeJson(user, ours);
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.deepEqual(merged.hooks.Stop, user.hooks.Stop);
  assert.deepEqual(mergeJson(merged, ours), merged);
  const newer = { hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'baton guard --hook claude' }] }] } };
  const upgraded = mergeJson(merged, newer);
  assert.equal(upgraded.hooks.PreToolUse.length, 2);
  assert.equal(upgraded.hooks.PreToolUse[1].matcher, 'Write|Edit');
  assert.ok(hasGuardHook(upgraded));
  const removed = unmergeJson(upgraded, newer);
  assert.deepEqual(removed, user);
});

test('stringifyLike preserves indent, EOL and trailing newline', () => {
  assert.equal(detectIndent('{\n\t"a": 1\n}\n'), '\t');
  assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
  assert.equal(stringifyLike('{\r\n    "a": 1\r\n}\r\n', { a: 1, b: 2 }), '{\r\n    "a": 1,\r\n    "b": 2\r\n}\r\n');
  assert.equal(stringifyLike('{\n  "a": 1\n}', { a: 1 }), '{\n  "a": 1\n}');
});

test('hashContent ignores CRLF differences', () => {
  assert.equal(hashContent('a\r\nb\r\n'), hashContent('a\nb\n'));
  assert.notEqual(hashContent('a\nb\n'), hashContent('a\nc\n'));
});

test('detectStack: node with a real test script, placeholder script, python, go, make, multi-stack', () => {
  const r = makeTempRepo({ files: { 'package.json': JSON.stringify({ name: '@scope/demo', description: 'd', scripts: { test: 'node --test' } }) } });
  try {
    const s = detectStack(r.root);
    assert.deepEqual(s.stack, ['node']);
    assert.equal(s.testCommand, 'npm test');
    assert.equal(s.name, 'demo');
    assert.equal(s.description, 'd');
  } finally { r.cleanup(); }
  const p = makeTempRepo({ files: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) } });
  try { assert.equal(detectStack(p.root).testCommand, ''); } finally { p.cleanup(); }
  const cases = [
    [{ 'pyproject.toml': '' }, 'python', 'python -m pytest -q'],
    [{ 'go.mod': 'module x' }, 'go', 'go test ./...'],
    [{ 'Cargo.toml': '' }, 'rust', 'cargo test'],
    [{ 'pom.xml': '' }, 'java', 'mvn -q test'],
    [{ 'build.gradle': '' }, 'java', 'gradle test'],
    [{ 'App.csproj': '' }, 'dotnet', 'dotnet test'],
    [{ Gemfile: '' }, 'ruby', 'bundle exec rake test'],
    [{ 'composer.json': '{}' }, 'php', 'composer test'],
    [{ Makefile: 'test:\n\techo ok\n' }, 'make', 'make test'],
    [{ Makefile: 'all:\n\techo\n' }, 'make', ''],
  ];
  for (const [files, stack, cmd] of cases) {
    const t = makeTempRepo({ files });
    try {
      const s = detectStack(t.root);
      assert.ok(s.stack.includes(stack), `${Object.keys(files)} -> ${s.stack}`);
      assert.equal(s.testCommand, cmd);
    } finally { t.cleanup(); }
  }
  const multi = makeTempRepo({ files: { 'package.json': '{"scripts":{"test":"x"}}', 'pyproject.toml': '' } });
  try { assert.deepEqual(detectStack(multi.root).stack, ['node', 'python']); } finally { multi.cleanup(); }
});

test('findOnPath resolves fake executables and returns null otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bin-'));
  try {
    fakeBin(dir, 'claude');
    const env = isolatedEnv(dir);
    assert.ok(findOnPath('claude', env));
    assert.equal(findOnPath('codex', env), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('detectAgents and selectRoster: auto pads to two agents, explicit is exact, all lists every adapter', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-bin-'));
  const repo = makeTempRepo({ files: { '.cursor/rules/x.mdc': '' } });
  try {
    const registry = loadRegistry(installEnv());
    assert.ok(registry.byId.get('claude').files.length >= 3);
    fakeBin(bin, 'gemini');
    const detected = detectAgents(repo.root, registry, isolatedEnv(bin));
    assert.ok(detected.find((d) => d.id === 'gemini').installed);
    assert.ok(detected.find((d) => d.id === 'cursor').present);
    const auto = selectRoster(registry, detected, 'auto');
    assert.deepEqual(auto.agents.map((a) => a.id), ['gemini', 'cursor']);
    assert.equal(auto.agents[0].roles[0], 'orchestrator');
    const none = selectRoster(registry, detectAgents(repo.root, registry, isolatedEnv(bin)).map((d) => ({ ...d, installed: false, present: false })), 'auto');
    assert.deepEqual(none.agents.map((a) => a.id), ['claude', 'codex']);
    assert.deepEqual(none.padded, ['claude', 'codex']);
    assert.deepEqual(selectRoster(registry, [], 'codex').agents.map((a) => a.id), ['codex']);
    assert.equal(selectRoster(registry, [], 'all').agents.length, registry.adapters.length);
    assert.throws(() => selectRoster(registry, [], 'Bad Id'), /invalid agent id/);
    assert.throws(() => selectRoster(registry, [], 'human'), /invalid agent id/);
    assert.equal(defaultAgentFor(registry, 'nope', 'mine').kind, 'custom');
  } finally { fs.rmSync(bin, { recursive: true, force: true }); repo.cleanup(); }
});

test('renderText keeps GitHub ${{ }} expressions and renders baton variables', () => {
  const out = renderText('run: {{cli}}\nsha: ${{ github.sha }}\nif: ${{ matrix.os == \'x\' }}\n', { cli: 'baton' });
  assert.equal(out, "run: baton\nsha: ${{ github.sha }}\nif: ${{ matrix.os == 'x' }}\n");
});

test('safeRel rejects paths that leave the repository', () => {
  assert.equal(safeRel('.claude\\agents\\x.md'), '.claude/agents/x.md');
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '']) assert.throws(() => safeRel(bad), /outside the repository/);
});

test('collectRuntime copies bin, src and templates and skips tests and node_modules', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-src-'));
  try {
    for (const [rel, text] of Object.entries({
      'bin/baton.js': '#!/usr/bin/env node\n', 'src/cli.js': 'x', 'src/a.test.js': 'no', 'src/node_modules/m/i.js': 'no', 'src/tests/t.js': 'no',
      'package.json': '{"version":"9.9.9"}',
      'LICENSE': 'MIT License\n\nCopyright (c) Test\n',
    })) { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), text); }
    const files = collectRuntime({ srcRoot: src, templates: templates() });
    const rels = files.map((f) => f.rel);
    assert.ok(rels.includes('.baton/runtime/bin/baton.js'));
    assert.ok(rels.includes('.baton/runtime/src/cli.js'));
    assert.ok(rels.includes('.baton/runtime/templates/adapters.json'));
    assert.ok(rels.includes('.baton/runtime/package.json'));
    assert.ok(rels.includes('.baton/runtime/LICENSE'));
    assert.match(files.find((f) => f.rel === '.baton/runtime/LICENSE').data.toString('utf8'), /^MIT License/);

    assert.ok(!rels.some((r) => /a\.test\.js|node_modules|\/tests\//.test(r)));
    assert.equal(JSON.parse(files.find((f) => f.rel.endsWith('package.json')).data).type, 'module');
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});
