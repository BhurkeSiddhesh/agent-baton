import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('public entry points explicitly disclose that Baton is not a sandbox', () => {
  const readme = doc('README.md');
  const security = doc('SECURITY.md');
  const spec = doc('docs/internals/SPEC.md');
  assert.match(readme, /not a sandbox/i);
  assert.match(security, /not a sandbox/i);
  assert.match(spec, /not a sandbox/i);
  assert.match(readme, /\]\(docs\/SECURITY_MODEL\.md\)/);
  assert.match(security, /\]\(docs\/SECURITY_MODEL\.md\)/);
  assert.match(spec, /\]\(\.\.\/SECURITY_MODEL\.md\)/);
});

test('security model retains explicit enforcement and residual-risk disclosures', () => {
  const model = doc('docs/SECURITY_MODEL.md');
  for (const heading of [
    'Trust boundaries and crossing points',
    'Control inventory: enforcement vs guidance',
    'Threat scenarios and mitigations',
    'Minimum safe deployment policy',
    'Reproducible security review checklist',
    'Residual risks and ownership',
  ]) {
    assert.ok(model.includes(heading), `Missing security section: ${heading}`);
  }
  for (const phrase of [
    /not a sandbox/i,
    /caller assertions/i,
    /shell: true/i,
    /fail/i,
    /SHA-256/i,
    /GitHub branch/i,
    /prompt injection/i,
    /independent/i,
  ]) {
    assert.match(model, phrase);
  }
});
