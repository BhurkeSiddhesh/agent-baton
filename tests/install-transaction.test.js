import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './helpers.js';
import { installEnv, makeFixtureTemplates, snapshotTree } from './install-fixture.test.js';
import { runInstall } from '../src/install/installer.js';
import { run as runUninstall } from '../src/commands/uninstall.js';

const options = { mode: 'init', agents: 'claude,codex', yes: true, testCmd: 'node -e 0' };

test('an interrupted initial install rolls every file and created directory back', async () => {
  const repo = makeTempRepo({ git: true, files: { 'README.md': 'user content\n' } });
  try {
    const before = snapshotTree(repo.root);
    await assert.rejects(
      runInstall({ root: repo.root, env: installEnv() }, { ...options, _failAfter: 3 }),
      /injected installer failure/,
    );
    assert.deepEqual(snapshotTree(repo.root), before);
    assert.equal(fs.existsSync(path.join(repo.root, '.baton')), false, 'transaction-created directories are removed');
  } finally { repo.cleanup(); }
});

test('an interrupted upgrade restores the previous manifest, managed blocks and generated files', async () => {
  const repo = makeTempRepo({ git: true, files: { 'AGENTS.md': '# User heading\n' } });
  const nextTemplates = makeFixtureTemplates();
  try {
    await runInstall({ root: repo.root, env: installEnv() }, options);
    const before = snapshotTree(repo.root);
    fs.appendFileSync(path.join(nextTemplates, 'agents-block.md.tpl'), '\nNew protocol text.\n');
    fs.appendFileSync(path.join(nextTemplates, 'adapters/claude/subagent.md.tpl'), '\nNew generated text.\n');
    await assert.rejects(
      runInstall(
        { root: repo.root, env: installEnv({ BATON_TEMPLATES_DIR: nextTemplates }) },
        { mode: 'upgrade', yes: true, _failAfter: 2 },
      ),
      /injected installer failure/,
    );
    assert.deepEqual(snapshotTree(repo.root), before);
  } finally {
    fs.rmSync(nextTemplates, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('an interrupted uninstall restores generated files, managed blocks, manifest and baton data', async () => {
  const repo = makeTempRepo({ git: true, files: { 'AGENTS.md': '# User heading\n' } });
  try {
    await runInstall({ root: repo.root, env: installEnv() }, options);
    fs.mkdirSync(path.join(repo.root, '.baton', 'views'), { recursive: true });
    fs.writeFileSync(path.join(repo.root, '.baton', 'views', 'STATUS.md'), 'derived\n');
    const before = snapshotTree(repo.root);
    await assert.rejects(
      runUninstall({ root: repo.root, stdin: { isTTY: false }, out() {}, json() {} }, { yes: true, _failAfter: 3 }),
      /injected uninstall failure/,
    );
    assert.deepEqual(snapshotTree(repo.root), before);
  } finally { repo.cleanup(); }
});
