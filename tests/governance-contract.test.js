import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('governance discloses review limitations, schema compatibility and release ownership', () => {
  const doc = fs.readFileSync(new URL('../docs/GOVERNANCE.md', import.meta.url), 'utf8');
  for (const title of ['Roles and authority', 'Compatibility contracts', 'Deprecation and migration', 'Releases and exceptions']) {
    assert.ok(doc.includes(title), 'missing governance area: ' + title);
  }
  assert.match(doc, /not an authenticated review/);
  assert.match(doc, /does not.*automatically protect branches/i);
  assert.match(doc, /Closes #N/);
  assert.match(doc, /rollback/);
});

test('contributor and security entrypoints route to the governance policy', () => {
  for (const file of ['CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
    const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.match(text, /GOVERNANCE\.md/);
  }
});
