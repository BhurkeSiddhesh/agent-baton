// Every file `baton init --agents all --cloud --hooks --docs` renders from the REAL templates must parse:
// JSON as JSON, TOML as TOML, workflow YAML as YAML, Markdown front matter as simple YAML, and nothing may contain
// leftover template tags or non-ASCII text. TOML and YAML are checked with python3 (tomllib, PyYAML) when available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempRepo, runCli } from './helpers.js';

function pythonWith(mod) {
  for (const bin of ['python3', 'python', 'py']) {
    const r = spawnSync(bin, ['-c', `import ${mod}`], { encoding: 'utf8', cwd: os.tmpdir() });
    if (r.status === 0) return bin;
  }
  return null;
}

function pyParse(py, kind, file) {
  const code = kind === 'toml'
    ? 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))'
    : 'import sys,yaml;list(yaml.safe_load_all(open(sys.argv[1],encoding="utf-8")))';
  return spawnSync(py, ['-c', code, file], { encoding: 'utf8', cwd: os.tmpdir() });
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'runtime' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

test('all rendered adapter, prompt, workflow and hook files parse', () => {
  const t = makeTempRepo({ git: true, files: { 'docs/README.md': '# docs\n' } });
  try {
    const r = runCli(t.root, ['init', '--yes', '--agents', 'all', '--cloud', '--hooks', '--docs', '--test-cmd', 'npm test']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const pyToml = pythonWith('tomllib');
    const pyYaml = pythonWith('yaml');
    const files = listFiles(t.root);
    const counts = { json: 0, toml: 0, yaml: 0, front: 0, md: 0 };
    const generated = new Set(JSON.parse(t.read('.baton/manifest.json')).files ? Object.keys(JSON.parse(t.read('.baton/manifest.json')).files) : []);
    for (const file of files) {
      const rel = path.relative(t.root, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      const isBaton = generated.size ? generated.has(rel) : true;
      if (!isBaton && rel !== 'AGENTS.md') continue;
      if (rel.startsWith('.baton/ledger/') || rel.startsWith('.baton/state/')) continue;
      assert.doesNotMatch(text, /(?<!\$)\{\{[^}]*\}\}/, `${rel}: leftover template tag`);
      assert.doesNotMatch(text, /\$\[\[/, `${rel}: unconverted GitHub expression`);
      assert.doesNotMatch(text, /[^\x00-\x7f]/, `${rel}: non-ASCII character`);
      if (rel.endsWith('.json')) {
        assert.doesNotThrow(() => JSON.parse(text), `${rel}: invalid JSON`);
        counts.json++;
      } else if (rel.endsWith('.toml')) {
        counts.toml++;
        if (pyToml) { const p = pyParse(pyToml, 'toml', file); assert.equal(p.status, 0, `${rel}: invalid TOML\n${p.stderr}`); }
        assert.match(text, /^\s*(description|name)\s*=/m, `${rel}: expected a description or name key`);
      } else if (/\.ya?ml$/.test(rel) && !rel.endsWith('.baton-new')) {
        counts.yaml++;
        if (pyYaml) { const p = pyParse(pyYaml, 'yaml', file); assert.equal(p.status, 0, `${rel}: invalid YAML\n${p.stderr}`); }
      } else if (rel.endsWith('.md') || rel.endsWith('.mdc')) {
        counts.md++;
        if (text.startsWith('---')) {
          const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
          assert.ok(m, `${rel}: front matter is not closed`);
          counts.front++;
          if (pyYaml) {
            fs.writeFileSync(path.join(t.root, '.fm.yml'), m[1]);
            const p = pyParse(pyYaml, 'yaml', path.join(t.root, '.fm.yml'));
            assert.equal(p.status, 0, `${rel}: invalid front matter\n${p.stderr}`);
            fs.rmSync(path.join(t.root, '.fm.yml'));
          } else {
            for (const line of m[1].split(/\r?\n/)) assert.match(line, /^([A-Za-z_][\w-]*:(\s.*)?|\s+.*|\s*-\s.*)$/, `${rel}: odd front matter line "${line}"`);
          }
        }
      }
    }
    assert.ok(counts.json >= 3, `json files: ${counts.json}`);
    assert.ok(counts.toml >= 8, `toml files: ${counts.toml}`);
    assert.ok(counts.yaml >= 2, `yaml files: ${counts.yaml}`);
    assert.ok(counts.front >= 10, `front matter files: ${counts.front}`);
    // role prompts for agents without native slash commands
    for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor']) {
      const p = runCli(t.root, ['prompt', role, '--agent', 'codex']);
      assert.equal(p.status, 0, p.stderr);
      assert.doesNotMatch(p.stdout, /\{\{|\}\}/);
    }
    assert.equal(runCli(t.root, ['prompt', 'split']).status, 0);
  } finally {
    t.cleanup();
  }
});
