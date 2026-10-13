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
