import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';
import { validatePlan } from '../src/lib/plan.js';
import { validateConfig } from '../src/lib/config.js';
import { isProtected, isOrchestratorOnly, isReadOnly } from '../src/lib/glob.js';
import { classify } from '../src/commands/verify.js';
import { buildContext, memoryStream } from '../src/lib/context.js';
import * as guard from '../src/commands/guard.js';

const cfg = sampleConfig();

test('BAT-016: isProtected detects expanded sensitive path categories case-insensitively', () => {
  // Certificates (*.crt, *.cer, *.der, *.p8)
  assert.equal(isProtected('server.crt'), true);
  assert.equal(isProtected('certs/server.crt'), true);
  assert.equal(isProtected('CERTS/SERVER.CRT'), true);
  assert.equal(isProtected('apple.cer'), true);
  assert.equal(isProtected('root.der'), true);
  assert.equal(isProtected('AuthKey_12345.p8'), true);

  // SSH keys (id_ed25519, id_ecdsa)
  assert.equal(isProtected('id_ed25519'), true);
  assert.equal(isProtected('id_ed25519.pub'), true);
  assert.equal(isProtected('ID_ED25519'), true);
  assert.equal(isProtected('id_ecdsa'), true);
  assert.equal(isProtected('id_ecdsa.pub'), true);
  assert.equal(isProtected('.ssh/id_ed25519'), true);

  // Cloud credentials (.aws/credentials, gcloud credentials.db, azure tokens)
  assert.equal(isProtected('.aws/credentials'), true);
  assert.equal(isProtected('aws/credentials'), true);
  assert.equal(isProtected('.AWS/CREDENTIALS'), true);
  assert.equal(isProtected('gcloud/credentials.db'), true);
  assert.equal(isProtected('credentials.db'), true);
  assert.equal(isProtected('.config/gcloud/credentials.db'), true);
  assert.equal(isProtected('azureTokens.json'), true);
  assert.equal(isProtected('azure-tokens.json'), true);
  assert.equal(isProtected('.azure/accessTokens.json'), true);
  assert.equal(isProtected('AZURETOKENS.JSON'), true);

  // Sensitive DBs (*.duckdb, *.kdbx)
  assert.equal(isProtected('analytics.duckdb'), true);
  assert.equal(isProtected('data/app.duckdb'), true);
  assert.equal(isProtected('ANALYTICS.DUCKDB'), true);
  assert.equal(isProtected('vault.kdbx'), true);
  assert.equal(isProtected('SAFE.KDBX'), true);

  // Legitimate open files must NOT be protected
  assert.equal(isProtected('.env.example'), false);
  assert.equal(isProtected('src/env.js'), false);
  assert.equal(isProtected('README.md'), false);
  assert.equal(isProtected('src/cert.js'), false);
  assert.equal(isProtected('docs/credentials.md'), false);
  assert.equal(isProtected('src/duckdb-client.js'), false);
  assert.equal(isProtected('tokens.md'), false);
});

test('BAT-016: validatePlan rejects attempts to claim protected paths across cases and normalization', () => {
  const sensitivePaths = [
    '.env',
    '.ENV',
    '.env.production',
    'id_rsa',
    'id_ed25519',
    'ID_ED25519',
    'id_ecdsa',
    'server.crt',
    'CERTS/SERVER.CRT',
    'ca.cer',
    'auth.p8',
    'cert.der',
    '.aws/credentials',
    'aws/credentials',
    'gcloud/credentials.db',
    'azureTokens.json',
    'data.duckdb',
    'vault.kdbx',
    'secrets/key.txt',
    'SECRETS/KEY.TXT',
  ];

  for (const path of sensitivePaths) {
    const pl = samplePlan();
    pl.packets[0].owns = [path];
    const res = validatePlan(pl, cfg);
    assert.ok(
      res.errors.some((e) => e.includes('owns protected path')),
      `Expected ${path} to be rejected as protected path, got: ${JSON.stringify(res.errors)}`
    );
  }
});

test('BAT-016: validatePlan rejects tracks owning protected paths', () => {
  const pl = samplePlan();
  pl.tracks[0].owns = ['secrets/'];
  const res = validatePlan(pl, cfg);
  assert.ok(res.errors.some((e) => e.includes('track api: owns protected path secrets/')));
});

test('BAT-016: orchestrator-only paths (.baton/config.json, AGENTS.md, docs/GOVERNANCE.md) require orchestrator role', () => {
  const orchPaths = ['.baton/config.json', 'AGENTS.md', 'docs/GOVERNANCE.md', 'agents.md', 'docs/governance.md'];

  for (const path of orchPaths) {
    // 1. Worker packet attempting to claim orchestrator-only path is rejected
    const workerPlan = samplePlan();
    workerPlan.packets[0].agent = 'codex'; // codex lacks orchestrator role
    workerPlan.packets[0].owns = [path];
    const workerRes = validatePlan(workerPlan, cfg);
    assert.ok(
      workerRes.errors.some((e) => e.includes('unauthorized claim of orchestrator-only path') && e.includes('lacks orchestrator role')),
      `Expected ${path} to be rejected for worker, got: ${JSON.stringify(workerRes.errors)}`
    );

    // 2. Unassigned packet attempting to claim orchestrator-only path is rejected
    const unassignedPlan = samplePlan();
    unassignedPlan.packets[0].agent = null;
    unassignedPlan.packets[0].owns = [path];
    const unassignedRes = validatePlan(unassignedPlan, cfg);
    assert.ok(
      unassignedRes.errors.some((e) => e.includes('cannot be claimed without an assigned orchestrator agent')),
      `Expected ${path} to be rejected for unassigned, got: ${JSON.stringify(unassignedRes.errors)}`
    );

    // 3. Orchestrator packet attempting to claim orchestrator-only path is accepted
    const orchPlan = samplePlan();
    orchPlan.packets[0].agent = 'claude'; // claude has orchestrator role
    orchPlan.packets[0].reviewer = 'codex';
    orchPlan.packets[0].owns = [path];
    const orchRes = validatePlan(orchPlan, cfg);
    assert.deepEqual(
      orchRes.errors,
      [],
      `Expected ${path} to be allowed for orchestrator, got: ${JSON.stringify(orchRes.errors)}`
    );
  }
});

test('BAT-016: controlled exceptions for approved migration packets', () => {
  // 1. Worker attempting to use allow_protected exception is rejected
  const workerPlan = samplePlan();
  workerPlan.packets[0].agent = 'codex';
  workerPlan.packets[0].owns = ['.env.production'];
  workerPlan.packets[0].allow_protected = true;
  workerPlan.packets[0].description = 'Migrating production environment template';
  const workerRes = validatePlan(workerPlan, cfg);
  assert.ok(workerRes.errors.some((e) => e.includes('unauthorized protected path exception') && e.includes('lacks orchestrator role')));
  assert.ok(workerRes.errors.some((e) => e.includes('owns protected path .env.production')));

  // 2. Orchestrator attempting allow_protected without description is rejected
  const noDescPlan = samplePlan();
  noDescPlan.packets[0].agent = 'claude';
  noDescPlan.packets[0].reviewer = 'codex';
  noDescPlan.packets[0].owns = ['.env.production'];
  noDescPlan.packets[0].allow_protected = true;
  noDescPlan.packets[0].description = '';
  const noDescRes = validatePlan(noDescPlan, cfg);
  assert.ok(noDescRes.errors.some((e) => e.includes('protected path exception requires documented justification in description')));
  assert.ok(noDescRes.errors.some((e) => e.includes('owns protected path .env.production')));

  // 3. Orchestrator with allow_protected and documented description is accepted
  const validPlan = samplePlan();
  validPlan.packets[0].agent = 'claude';
  validPlan.packets[0].reviewer = 'codex';
  validPlan.packets[0].owns = ['.env.production'];
  validPlan.packets[0].allow_protected = true;
  validPlan.packets[0].description = 'Authorized rotation of production environment configuration';
  const validRes = validatePlan(validPlan, cfg);
  assert.deepEqual(validRes.errors, []);
});

test('BAT-016: prevent plans from silently removing or relaxing protected globs', () => {
  const pl = samplePlan();

  // Attempting to inject protected policies in plan is rejected
  pl.protected = { globs: [] };
  const resProtected = validatePlan(pl, cfg);
  assert.ok(resProtected.errors.some((e) => e.includes('plan must not define "protected"')));

  // Attempting to inject config overrides in plan is rejected
  delete pl.protected;
  pl.config = { protected: { globs: [] } };
  const resConfig = validatePlan(pl, cfg);
  assert.ok(resConfig.errors.some((e) => e.includes('plan must not define "config"')));
});

test('BAT-016: validateConfig strictly validates protected globs and prevents relaxation', () => {
  const baseCfg = sampleConfig();

  // Empty string glob
  const emptyCfg = structuredClone(baseCfg);
  emptyCfg.protected.globs = [''];
  assert.ok(validateConfig(emptyCfg).errors.some((e) => e.includes('must be non-empty strings')));

  // Negative/exclusion pattern attempt to relax protections
  const negCfg = structuredClone(baseCfg);
  negCfg.protected.globs = ['!secrets/**', '!*.key'];
  assert.ok(validateConfig(negCfg).errors.some((e) => e.includes('must not be negative/exclusion patterns')));

  // Backslash in protected globs
  const backslashCfg = structuredClone(baseCfg);
  backslashCfg.protected.globs = ['secrets\\*.key'];
  assert.ok(validateConfig(backslashCfg).errors.some((e) => e.includes('must use forward slashes')));

  // Dotdot traversal in protected globs
  const dotdotCfg = structuredClone(baseCfg);
  dotdotCfg.protected.globs = ['secrets/../keys/*.pem'];
  assert.ok(validateConfig(dotdotCfg).errors.some((e) => e.includes('must not contain ".."')));

  // readOnly and orchestratorOnly validation
  const invalidReadOnly = structuredClone(baseCfg);
  invalidReadOnly.protected.readOnly = ['!docs/GOVERNANCE.md'];
  assert.ok(validateConfig(invalidReadOnly).errors.some((e) => e.includes('config.protected.readOnly')));

  const invalidOrchOnly = structuredClone(baseCfg);
  invalidOrchOnly.protected.orchestratorOnly = ['..'];
  assert.ok(validateConfig(invalidOrchOnly).errors.some((e) => e.includes('config.protected.orchestratorOnly')));

  // Valid configuration passes cleanly
  const validCfg = structuredClone(baseCfg);
  validCfg.protected.globs = ['sensitive/**/*.dat', 'certs/*.crt'];
  validCfg.protected.readOnly = ['docs/LICENSING.md'];
  validCfg.protected.orchestratorOnly = ['.baton/config.json', 'AGENTS.md'];
  assert.deepEqual(validateConfig(validCfg).errors, []);
});

test('BAT-016: classify in verify respects protected paths and authorized migration exceptions', () => {
  const baseCfg = sampleConfig();
  const pl = samplePlan();
  const packet = pl.packets[0];

  // Worker modifying protected file is classified as violation
  packet.agent = 'codex';
  packet.owns = ['secrets/key.txt'];
  const resViolation = classify(['secrets/key.txt'], packet, pl, baseCfg, 'local');
  assert.deepEqual(resViolation.protected, ['secrets/key.txt']);
  assert.deepEqual(resViolation.out_of_scope, ['secrets/key.txt']);
  assert.deepEqual(resViolation.in_scope, []);

  // Authorized orchestrator migration exception allows owned protected file in-scope
  packet.agent = 'claude';
  packet.allow_protected = true;
  packet.description = 'Authorized rotation of secrets key';
  const resException = classify(['secrets/key.txt'], packet, pl, baseCfg, 'local');
  assert.deepEqual(resException.protected, []);
  assert.deepEqual(resException.out_of_scope, []);
  assert.deepEqual(resException.in_scope, ['secrets/key.txt']);
});

test('BAT-016: guard blocks worker from modifying orchestrator-only and protected paths', async () => {
  const r = makeTempRepo({
    git: true,
    config: sampleConfig({ guard: { mode: 'block' } }),
    plan: samplePlan(),
  });
  try {
    const check = async (input, agent = 'codex') => {
      const stdout = memoryStream();
      const stderr = memoryStream();
      const ctx = buildContext({ cwd: r.root, env: {}, stdout, stderr, commands: [] });
      ctx.stdin = JSON.stringify(input);
      const status = await guard.run(ctx, { _: [], agent, hook: 'generic' });
      return { status, stdout: stdout.text(), stderr: stderr.text() };
    };

    // Worker modifying .baton/config.json blocked
    const resConfig = await check({ file: '.baton/config.json' }, 'codex');
    assert.equal(resConfig.status, 2);
    assert.ok(resConfig.stderr.includes('orchestrator-only path') || resConfig.stderr.includes('blocked'));

    // Worker modifying AGENTS.md blocked
    const resAgents = await check({ file: 'AGENTS.md' }, 'codex');
    assert.equal(resAgents.status, 2);
    assert.ok(resAgents.stderr.includes('orchestrator-only path') || resAgents.stderr.includes('blocked'));

    // Worker modifying server.crt blocked as protected path
    const resCert = await check({ file: 'server.crt' }, 'codex');
    assert.equal(resCert.status, 2);
    assert.ok(resCert.stderr.includes('protected path'));

    // Orchestrator allowed to edit .baton/config.json
    const resOrchConfig = await check({ file: '.baton/config.json' }, 'claude');
    assert.equal(resOrchConfig.status, 0);
  } finally {
    r.cleanup();
  }
});
