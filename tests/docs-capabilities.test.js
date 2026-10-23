import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('README distinguishes supported coordination from unattended execution', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /## What Baton actually does today/);
  assert.match(readme, /does not create or manage live agent processes/i);
  assert.match(readme, /issue alone does not guarantee execution/);
  assert.match(readme, /security model/);
});

test('FAQ explicitly refuses to promise automatic issue-to-PR orchestration', () => {
  const faq = fs.readFileSync(new URL('../docs/FAQ.md', import.meta.url), 'utf8');
  assert.match(faq, /will agents automatically start and open a PR/);
  assert.match(faq, /No, not in the current CLI/);
  assert.match(faq, /baton next/);
});

test('product vision defines autonomous goal-to-outcome orchestration without inflating v0.1.0', () => {
  const vision = fs.readFileSync(new URL('../docs/PRODUCT_VISION.md', import.meta.url), 'utf8');
  assert.match(vision, /turns a human product goal into verified working software/i);
  assert.match(vision, /deterministic controller/i);
  assert.match(vision, /lead orchestrator agent/i);
  assert.match(vision, /v0\.1\.0 CLI implements much of the governance substrate/i);
  assert.match(vision, /remain roadmap work/i);
});

test('enterprise architecture covers portable deployments, isolation and commercial boundaries', () => {
  const enterprise = fs.readFileSync(new URL('../docs/ENTERPRISE_CLOUD.md', import.meta.url), 'utf8');
  for (const required of ['AWS', 'Azure', 'tenant isolation', 'worker plane', 'subscription']) {
    assert.ok(enterprise.includes(required), 'missing enterprise architecture topic: ' + required);
  }
  assert.match(enterprise, /Do not put hard subscription checks in the MIT coordination core/i);
  assert.match(enterprise, /require actual controls and independent evidence/i);
});
