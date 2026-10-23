import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const ADAPTERS_JSON_PATH = path.join(REPO_ROOT, 'templates', 'adapters.json');
const MATRIX_JSON_PATH = path.join(REPO_ROOT, 'templates', 'matrix.json');
const MATRIX_DOC_PATH = path.join(REPO_ROOT, 'docs', 'ADAPTERS_MATRIX.md');

const REQUIRED_9_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'cursor',
  'copilot',
  'windsurf',
  'cline',
  'opencode'
];

test('all adapters in templates/adapters.json exist in templates/matrix.json', () => {
  assert.ok(fs.existsSync(ADAPTERS_JSON_PATH), 'templates/adapters.json must exist');
  assert.ok(fs.existsSync(MATRIX_JSON_PATH), 'templates/matrix.json must exist');

  const adaptersData = JSON.parse(fs.readFileSync(ADAPTERS_JSON_PATH, 'utf8'));
  const matrixData = JSON.parse(fs.readFileSync(MATRIX_JSON_PATH, 'utf8'));

  assert.ok(Array.isArray(adaptersData.adapters), 'adapters.json should contain an adapters array');
  assert.ok(matrixData.adapters && typeof matrixData.adapters === 'object', 'matrix.json should contain an adapters object');

  // Verify all 9 primary adapters are present
  for (const id of REQUIRED_9_ADAPTERS) {
    assert.ok(matrixData.adapters[id], `matrix.json must include required adapter: ${id}`);
    assert.equal(matrixData.adapters[id].id, id, `adapter id in matrix must match ${id}`);
  }

  // Verify every adapter defined in templates/adapters.json has a corresponding entry in matrix.json
  for (const adapter of adaptersData.adapters) {
    assert.ok(
      matrixData.adapters[adapter.id],
      `matrix.json must have an entry for adapter '${adapter.id}' from adapters.json`
    );
    assert.equal(
      matrixData.adapters[adapter.id].id,
      adapter.id,
      `matrix entry id must match adapters.json id: ${adapter.id}`
    );
  }
});

test('matrix.json capability schema validation and structural consistency', () => {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_JSON_PATH, 'utf8'));

  assert.equal(typeof matrix.version, 'number', 'matrix.version must be a number');
  assert.equal(typeof matrix.description, 'string', 'matrix.description must be a string');
  assert.equal(typeof matrix.lastUpdated, 'string', 'matrix.lastUpdated must be a string');
  assert.ok(matrix.schema?.adapterFields?.length > 0, 'matrix.schema must define adapterFields');

  const requiredRoles = ['orchestrator', 'worker', 'reviewer', 'auditor'];
  const validDialects = ['claude', 'cursor', 'generic'];

  for (const [id, entry] of Object.entries(matrix.adapters)) {
    assert.equal(entry.id, id, `entry id mismatch for key ${id}`);
    assert.ok(entry.name && typeof entry.name === 'string', `${id}: name must be a non-empty string`);
    assert.ok(entry.vendor && typeof entry.vendor === 'string', `${id}: vendor must be a non-empty string`);
    assert.ok(entry.category && typeof entry.category === 'string', `${id}: category must be a string`);
    assert.ok(entry.executionType && typeof entry.executionType === 'string', `${id}: executionType must be a string`);
    assert.equal(typeof entry.isUnattendedDaemon, 'boolean', `${id}: isUnattendedDaemon must be boolean`);

    // Instruction surfaces
    assert.ok(Array.isArray(entry.instructionSurfaces), `${id}: instructionSurfaces must be an array`);

    // Executable runner support
    assert.ok(entry.executableRunnerSupport && typeof entry.executableRunnerSupport === 'object', `${id}: executableRunnerSupport missing`);
    assert.equal(typeof entry.executableRunnerSupport.supported, 'boolean', `${id}: executableRunnerSupport.supported must be boolean`);
    assert.equal(typeof entry.executableRunnerSupport.subagentSupport, 'boolean', `${id}: subagentSupport must be boolean`);

    // Roles
    assert.ok(entry.roles && typeof entry.roles === 'object', `${id}: roles object missing`);
    for (const role of requiredRoles) {
      assert.ok(entry.roles[role], `${id}: role '${role}' missing`);
      assert.equal(typeof entry.roles[role].supported, 'boolean', `${id}: role '${role}'.supported must be boolean`);
    }

    // Hook enforcement
    assert.ok(entry.hookEnforcement && typeof entry.hookEnforcement === 'object', `${id}: hookEnforcement object missing`);
    assert.equal(typeof entry.hookEnforcement.preToolUse, 'boolean', `${id}: hookEnforcement.preToolUse must be boolean`);
    assert.equal(typeof entry.hookEnforcement.jsonPermissions, 'boolean', `${id}: hookEnforcement.jsonPermissions must be boolean`);
    assert.equal(typeof entry.hookEnforcement.shellEnvWrappers, 'boolean', `${id}: hookEnforcement.shellEnvWrappers must be boolean`);
    assert.ok(validDialects.includes(entry.hookEnforcement.hookDialect), `${id}: invalid hookDialect '${entry.hookEnforcement.hookDialect}'`);
    assert.ok(entry.hookEnforcement.mechanism && typeof entry.hookEnforcement.mechanism === 'string', `${id}: hook mechanism description missing`);

    // Cloud / CI readiness
    assert.ok(entry.cloudCiReadiness && typeof entry.cloudCiReadiness === 'object', `${id}: cloudCiReadiness missing`);
    assert.ok(['low', 'medium', 'medium-high', 'high'].includes(entry.cloudCiReadiness.tier), `${id}: invalid CI readiness tier`);
    assert.equal(typeof entry.cloudCiReadiness.headlessExecution, 'boolean', `${id}: headlessExecution must be boolean`);

    // Offline CLI execution
    assert.ok(entry.offlineCliExecution && typeof entry.offlineCliExecution === 'object', `${id}: offlineCliExecution missing`);
    assert.equal(entry.offlineCliExecution.supported, true, `${id}: Baton core offline execution must always be supported`);

    // Limitations
    assert.ok(Array.isArray(entry.limitations) && entry.limitations.length > 0, `${id}: limitations must be non-empty array`);
  }
});

test('instruction-only and editor adapters are not misrepresented as unattended background daemons', () => {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_JSON_PATH, 'utf8'));

  // Editor and instruction-only adapters must never claim unattended background daemon execution
  const instructionOnlyAdapters = ['cursor', 'windsurf', 'cline'];
  for (const id of instructionOnlyAdapters) {
    const entry = matrix.adapters[id];
    assert.equal(
      entry.isUnattendedDaemon,
      false,
      `Adapter '${id}' is an editor instruction surface and must NOT be marked as an unattended daemon`
    );
    assert.equal(
      entry.executableRunnerSupport.supported,
      false,
      `Adapter '${id}' does not have an unattended executable runner CLI`
    );
  }

  // Interactive CLI tools must also not claim to be unattended background daemons
  const interactiveCliAdapters = ['claude', 'codex', 'gemini', 'opencode', 'aider'];
  for (const id of interactiveCliAdapters) {
    const entry = matrix.adapters[id];
    assert.equal(
      entry.isUnattendedDaemon,
      false,
      `CLI tool '${id}' requires external task invocation and must NOT claim unattended background daemon status`
    );
    assert.equal(
      entry.executableRunnerSupport.supported,
      true,
      `CLI tool '${id}' must correctly indicate executable runner support`
    );
  }

  // Antigravity has native autonomous subagent runtime & background process capability
  assert.equal(
    matrix.adapters.antigravity.isUnattendedDaemon,
    true,
    'Antigravity runtime supports autonomous background execution and reactive multi-agent bus processing'
  );
});

test('hook enforcement configuration accurately mirrors Baton guard specifications', () => {
  const matrix = JSON.parse(fs.readFileSync(MATRIX_JSON_PATH, 'utf8'));

  // Claude Code has PreToolUse hook
  assert.equal(matrix.adapters.claude.hookEnforcement.preToolUse, true);
  assert.equal(matrix.adapters.claude.hookEnforcement.hookDialect, 'claude');
  assert.equal(matrix.adapters.claude.hookEnforcement.hookConfigFile, '.claude/settings.json');

  // Cursor has JSON permission hook dialect
  assert.equal(matrix.adapters.cursor.hookEnforcement.jsonPermissions, true);
  assert.equal(matrix.adapters.cursor.hookEnforcement.hookDialect, 'cursor');

  // Generic dialect agents
  for (const id of ['codex', 'gemini', 'antigravity', 'copilot', 'windsurf', 'cline', 'opencode', 'aider', 'custom']) {
    assert.equal(
      matrix.adapters[id].hookEnforcement.hookDialect,
      'generic',
      `Adapter '${id}' should use generic hook dialect`
    );
  }
});

test('docs/ADAPTERS_MATRIX.md exists, covers all 9 adapters, and all relative links resolve', () => {
  assert.ok(fs.existsSync(MATRIX_DOC_PATH), 'docs/ADAPTERS_MATRIX.md must exist');

  const content = fs.readFileSync(MATRIX_DOC_PATH, 'utf8');

  // Covers all 9 required adapters
  for (const id of REQUIRED_9_ADAPTERS) {
    assert.match(content, new RegExp(`\`${id}\``), `docs/ADAPTERS_MATRIX.md must cover adapter '${id}'`);
  }

  // Truth in advertising principles are explicitly documented
  assert.match(content, /truth-in-advertising/i, 'Documentation must declare truth-in-advertising principle');
  assert.match(content, /Instruction Surface vs\. Executable Runner/i, 'Documentation must partition instruction vs runner');
  assert.match(content, /Unattended Background Daemon/i, 'Documentation must distinguish unattended daemons');

  // Relative link resolution check
  const docsDir = path.dirname(MATRIX_DOC_PATH);
  const linkRegex = /\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g;
  let match;
  let linkCount = 0;

  while ((match = linkRegex.exec(content)) !== null) {
    const [, label, target] = match;
    // Skip external http/https or anchor-only links
    if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) {
      continue;
    }
    const resolvedPath = path.resolve(docsDir, target);
    assert.ok(
      fs.existsSync(resolvedPath),
      `Relative link '[${label}](${target})' in docs/ADAPTERS_MATRIX.md resolves to non-existent file: ${resolvedPath}`
    );
    linkCount++;
  }

  assert.ok(linkCount >= 5, `Expected at least 5 resolved relative documentation links, found ${linkCount}`);
});
