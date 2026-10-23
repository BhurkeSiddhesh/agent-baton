import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../src/lib/plan.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'examples');
const NODE_DIR = path.join(EXAMPLES_DIR, 'node');
const PYTHON_DIR = path.join(EXAMPLES_DIR, 'python');

function cleanChildEnv(extra = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.BATON_AGENT;
  delete env.BATON_ROOT;
  delete env.BATON_NOW;
  delete env.BATON_DEBUG;
  return Object.assign(env, extra);
}

test('all required example files and directory structures exist', () => {
  const expectedFiles = [
    'README.md',
    'node/package.json',
    'node/src/calculator.js',
    'node/test/calculator.test.js',
    'node/.baton/config.json',
    'node/.baton/plan.json',
    'node/README.md',
    'python/pyproject.toml',
    'python/src/calculator.py',
    'python/tests/test_calculator.py',
    'python/.baton/config.json',
    'python/.baton/plan.json',
    'python/README.md',
  ];

  for (const rel of expectedFiles) {
    const fullPath = path.join(EXAMPLES_DIR, rel);
    assert.ok(fs.existsSync(fullPath), `Expected file missing: ${rel}`);
  }
});

test('Node example has valid package.json manifest and structure', () => {
  const pkgPath = path.join(NODE_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'example-node-calculator');
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.scripts?.test, 'package.json must define a test script');
  assert.match(pkg.scripts.test, /node:test|node --test/);
});

test('Python example has valid pyproject.toml manifest', () => {
  const pyprojectPath = path.join(PYTHON_DIR, 'pyproject.toml');
  const content = fs.readFileSync(pyprojectPath, 'utf8');

  assert.match(content, /\[project\]/);
  assert.match(content, /name\s*=\s*"example-python-calculator"/);
  assert.match(content, /\[tool\.pytest\.ini_options\]/);
});

test('Node example Baton plan and config are valid', () => {
  const config = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '.baton', 'config.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(NODE_DIR, '.baton', 'plan.json'), 'utf8'));

  const { errors, warnings } = validatePlan(plan, config);
  assert.deepEqual(errors, [], `Node plan validation failed: ${JSON.stringify(errors)}`);
  assert.equal(plan.version, 1);
  assert.ok(plan.packets.length > 0, 'Plan must contain at least one packet');
  assert.ok(plan.packets[0].owns.includes('src/calculator.js'));
  assert.ok(plan.packets[0].owns.includes('test/calculator.test.js'));
});

test('Python example Baton plan and config are valid', () => {
  const config = JSON.parse(fs.readFileSync(path.join(PYTHON_DIR, '.baton', 'config.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(PYTHON_DIR, '.baton', 'plan.json'), 'utf8'));

  const { errors, warnings } = validatePlan(plan, config);
  assert.deepEqual(errors, [], `Python plan validation failed: ${JSON.stringify(errors)}`);
  assert.equal(plan.version, 1);
  assert.ok(plan.packets.length > 0, 'Plan must contain at least one packet');
  assert.ok(plan.packets[0].owns.includes('src/calculator.py'));
  assert.ok(plan.packets[0].owns.includes('tests/test_calculator.py'));
});

test('Node example test suite executes and passes 100%', () => {
  const res = spawnSync(process.execPath, ['--test', 'test/calculator.test.js'], {
    cwd: NODE_DIR,
    encoding: 'utf8',
    env: cleanChildEnv(),
  });

  assert.equal(res.status, 0, `Node test execution failed:\n${res.stderr}\n${res.stdout}`);
  assert.match(res.stdout, /pass 7/);
});

test('Python example test suite executes and passes 100%', (t) => {
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  const probe = spawnSync(pyCmd, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip(`Python not available in environment (${pyCmd} not found)`);
    return;
  }

  const res = spawnSync(pyCmd, ['tests/test_calculator.py'], {
    cwd: PYTHON_DIR,
    encoding: 'utf8',
    env: cleanChildEnv(),
  });

  assert.equal(res.status, 0, `Python test execution failed:\n${res.stderr}\n${res.stdout}`);
  assert.match(res.stderr + res.stdout, /OK/);
});

test('examples/README.md covers all required documentation topics', () => {
  const readme = fs.readFileSync(path.join(EXAMPLES_DIR, 'README.md'), 'utf8');

  // 1. Initializing Baton
  assert.match(readme, /Initializing Baton/i);
  assert.match(readme, /baton init/);

  // 2. Independent review model
  assert.match(readme, /Independent.*Review Model/i);
  assert.match(readme, /Author vs\. Reviewer Separation/i);

  // 3. Scope protection and guard violations
  assert.match(readme, /Scope Protection and Guard Violations/i);
  assert.match(readme, /owns/);
  assert.match(readme, /guard/i);

  // 4. Lease timeout and recovery
  assert.match(readme, /Lease Timeout and Recovery/i);
  assert.match(readme, /heartbeat/i);
  assert.match(readme, /stale/i);
  assert.match(readme, /reclaim/i);

  // 5. Offline workflow vs cloud/automated runner
  assert.match(readme, /Offline Workflow vs\. Cloud/i);
  assert.match(readme, /Offline-First/i);
});
