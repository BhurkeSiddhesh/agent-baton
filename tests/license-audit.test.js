import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRepo, runCli } from './helpers.js';
import { collectRuntime, readLicense } from '../src/install/vendor.js';
import { walk } from '../src/lib/util.js';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const licensePath = path.join(rootDir, 'LICENSE');
const packageJsonPath = path.join(rootDir, 'package.json');
const templatesDir = path.join(rootDir, 'templates');
const adaptersJsonPath = path.join(templatesDir, 'adapters.json');

// BAT-086: Audit vendored templates and third-party license obligations

test('BAT-086: published contents include valid MIT license and copyright notice', () => {
  assert.ok(fs.existsSync(licensePath), 'LICENSE file must exist at repository root');
  const licenseText = fs.readFileSync(licensePath, 'utf8');

  assert.match(licenseText, /^MIT License/, 'LICENSE must declare MIT License');
  assert.match(licenseText, /Copyright \(c\) 2026 Siddhesh Bhurke/, 'LICENSE must contain copyright notice');
  assert.match(licenseText, /Permission is hereby granted, free of charge/, 'LICENSE must contain standard MIT permission grant');
  assert.match(licenseText, /The above copyright notice and this permission notice shall be included in all/);
  assert.match(licenseText, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.equal(pkg.license, 'MIT', 'package.json must declare MIT license');
  assert.equal(pkg.author, 'Siddhesh Bhurke', 'package.json author must be specified');
  assert.ok(Array.isArray(pkg.files), 'package.json must specify files list for npm publish');
  assert.ok(pkg.files.includes('LICENSE'), 'package.json files list must include LICENSE');
  assert.ok(pkg.files.includes('templates'), 'package.json files list must include templates');
});

test('BAT-086: bundled code has zero runtime dependencies and clean dependency surface', () => {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {}, 'Baton core runtime must have zero runtime dependencies');
  assert.deepEqual(pkg.peerDependencies || {}, {}, 'Baton core runtime must have zero peer dependencies');
  assert.deepEqual(pkg.optionalDependencies || {}, {}, 'Baton core runtime must have zero optional dependencies');
  assert.deepEqual(pkg.bundledDependencies || [], [], 'Baton core runtime must have zero bundled dependencies');
});

test('BAT-086: inventory all adapter templates and verify referenced assets exist', () => {
  assert.ok(fs.existsSync(adaptersJsonPath), 'templates/adapters.json must exist');
  const manifest = JSON.parse(fs.readFileSync(adaptersJsonPath, 'utf8'));

  assert.equal(manifest.version, 1, 'adapters manifest version must be 1');
  assert.ok(Array.isArray(manifest.adapters), 'adapters manifest must list adapters');
  assert.ok(manifest.adapters.length > 0, 'at least one adapter must be defined');

  // Verify all shared template entries exist
  if (manifest.shared) {
    for (const item of manifest.shared) {
      const srcPath = path.join(templatesDir, item.src);
      assert.ok(fs.existsSync(srcPath), `Shared template src "${item.src}" must exist at ${srcPath}`);
    }
  }

  // Verify every adapter and its template files
  let totalAdapterTemplates = 0;
  for (const adapter of manifest.adapters) {
    assert.ok(adapter.id, 'Adapter must have an id');
    assert.ok(adapter.label, `Adapter "${adapter.id}" must have a label`);
    assert.ok(Array.isArray(adapter.files), `Adapter "${adapter.id}" must specify files array`);

    for (const fileDef of adapter.files) {
      const srcPath = path.join(templatesDir, fileDef.src);
      assert.ok(fs.existsSync(srcPath), `Adapter "${adapter.id}" template file "${fileDef.src}" must exist at ${srcPath}`);
      totalAdapterTemplates++;
    }
  }

  assert.ok(totalAdapterTemplates >= 40, `Expected comprehensive adapter coverage, found ${totalAdapterTemplates} template references`);
});

test('BAT-086: scan all templates for incompatible third-party license restrictions', () => {
  const allTemplateFiles = [];
  for (const rel of walk(templatesDir, { skipDirs: ['.git', 'node_modules'], skipPaths: [], maxSize: null })) {
    allTemplateFiles.push(rel);
  }

  assert.ok(allTemplateFiles.length >= 80, `Expected comprehensive template inventory, found ${allTemplateFiles.length} files`);

  // Keywords that would indicate incompatible viral, proprietary, or restrictive licenses
  const incompatiblePatterns = [
    /\bGNU\s+General\s+Public\s+License\b/i,
    /\bGPLv[23]\b/i,
    /\bAGPL\b/i,
    /\bServer\s+Side\s+Public\s+License\b/i,
    /\bSSPL\b/i,
    /\bCommons\s+Clause\b/i,
    /\bNon-Commercial\b/i,
    /\bAll\s+rights\s+reserved\b(?!\s*by\s*the\s*original)/i,
    /\bProprietary\s+and\s+confidential\b/i,
  ];

  for (const rel of allTemplateFiles) {
    const fullPath = path.join(templatesDir, rel);
    const content = fs.readFileSync(fullPath, 'utf8');

    for (const pattern of incompatiblePatterns) {
      assert.doesNotMatch(
        content,
        pattern,
        `Template "${rel}" contains incompatible license pattern: ${pattern}`
      );
    }
  }
});

test('BAT-086: vendored runtime preserves exact MIT license and attribution', () => {
  const runtimeFiles = collectRuntime({ srcRoot: rootDir, templates: templatesDir });
  const runtimeLicense = runtimeFiles.find((f) => f.rel === '.baton/runtime/LICENSE');
  assert.ok(runtimeLicense, 'collectRuntime must include .baton/runtime/LICENSE');

  const rootLicenseBuf = fs.readFileSync(licensePath);
  assert.deepEqual(
    runtimeLicense.data,
    rootLicenseBuf,
    '.baton/runtime/LICENSE must match root LICENSE byte-for-byte'
  );

  const runtimePkg = runtimeFiles.find((f) => f.rel === '.baton/runtime/package.json');
  assert.ok(runtimePkg, 'collectRuntime must include .baton/runtime/package.json');
  const parsedRuntimePkg = JSON.parse(runtimePkg.data.toString());
  assert.equal(parsedRuntimePkg.private, true, 'vendored runtime package.json must be private');
  assert.equal(parsedRuntimePkg.type, 'module', 'vendored runtime must be ESM');
});

test('BAT-086: generated adapter templates preserve Baton protocol attribution and host license sovereignty', () => {
  const repo = makeTempRepo({
    git: true,
    files: {
      LICENSE: 'Custom Proprietary License - Copyright (C) Host Corp\nAll rights reserved.\n',
    },
  });

  try {
    const r = runCli(repo.root, ['init', '--yes', '--agents', 'claude,cursor', '--no-vendor']);
    assert.equal(r.status, 0, r.stderr);

    // Host license must remain intact and unmodified
    const hostLicense = fs.readFileSync(path.join(repo.root, 'LICENSE'), 'utf8');
    assert.match(hostLicense, /Custom Proprietary License - Copyright \(C\) Host Corp/);

    // Baton MIT license is preserved in .baton/LICENSE
    const batonLicense = fs.readFileSync(path.join(repo.root, '.baton', 'LICENSE'), 'utf8');
    assert.match(batonLicense, /^MIT License/);
    assert.match(batonLicense, /Siddhesh Bhurke/);

    // Generated adapter rules cite AGENTS.md protocol without injecting foreign licenses
    const cursorRule = fs.readFileSync(path.join(repo.root, '.cursor', 'rules', 'baton.mdc'), 'utf8');
    assert.match(cursorRule, /This repository uses Agent Baton\. Full text is in AGENTS\.md\./);
  } finally {
    repo.cleanup();
  }
});
