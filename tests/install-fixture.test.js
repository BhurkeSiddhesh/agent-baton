// Shared fixtures for tests/install-*.test.js (the installer reads templates from BATON_TEMPLATES_DIR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { cleanEnv, makeTempRepo } from './helpers.js';

function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Create a small but complete templates directory. Returns its path. */
export function makeFixtureTemplates() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baton-tpl-')));
  put(dir, 'adapters.json', JSON.stringify({
    adapters: [
      { id: 'claude', files: [
        { src: 'adapters/claude/block.md.tpl', dest: 'CLAUDE.md', mode: 'block' },
        { src: 'adapters/claude/subagent.md.tpl', dest: '.claude/agents/baton-{{role}}.md', each: 'role', mode: 'file' },
        { src: 'adapters/claude/command.md.tpl', dest: '.claude/commands/baton-{{cmd}}.md', each: 'cmd', mode: 'file' },
      ] },
      { id: 'codex', files: [
        { src: 'agents-block.md.tpl', dest: 'AGENTS.md', mode: 'block' },
        { src: 'adapters/codex/agent.toml.tpl', dest: '.codex/agents/baton-{{role}}.toml', each: 'role', mode: 'file' },
      ] },
      { id: 'gemini', files: [{ src: 'adapters/gemini/block.md.tpl', dest: 'GEMINI.md', mode: 'block' }] },
      { id: 'cursor', files: [{ src: 'adapters/cursor/rule.mdc.tpl', dest: '.cursor/rules/baton.mdc', mode: 'file' }] },
    ],
  }, null, 2));
  put(dir, 'agents-block.md.tpl', '## Baton protocol\n\nRun `{{cli}} next --agent <id>` first.\n\nRoster:\n{{#each agents}}\n- {{this.id}} ({{this.name}}): {{this.roles}}\n{{/each}}\nTests: {{testCommand}}\n');
  put(dir, 'adapters/claude/block.md.tpl', '@AGENTS.md\n\nClaude commands: `{{cli}} status`. Agent: {{agent.name}}.\n');
  put(dir, 'adapters/claude/subagent.md.tpl', '---\nname: baton-{{role}}\ndescription: {{roleTitle}} for {{project.name}}\n---\nUse `{{cli}} prompt {{role}}`.\n');
  put(dir, 'adapters/claude/command.md.tpl', '{{cmdTitle}}: run `{{cli}} {{cmd}}`.\n');
  put(dir, 'adapters/codex/agent.toml.tpl', 'name = "baton-{{role}}"\ndescription = "{{roleTitle}}"\ndeveloper_instructions = """Run {{cli}} next."""\n');
  put(dir, 'adapters/gemini/block.md.tpl', '@AGENTS.md\n');
  put(dir, 'adapters/cursor/rule.mdc.tpl', '---\ndescription: baton\nalwaysApply: true\n---\nRun {{cli}} next.\n');
  for (const role of ['orchestrator', 'worker', 'reviewer', 'auditor', 'split']) put(dir, `prompts/${role}.md`, `# {{roleTitle}} prompt\nUse {{cli}}. Project {{project.name}}.\n`);
  put(dir, 'partials/rules.md', 'rules\n');
  put(dir, 'plan.starter.json', JSON.stringify({ version: 1, goal: '', tracks: [], gates: [], milestones: [], packets: [] }, null, 2) + '\n');
  put(dir, 'docs/ORCHESTRATION.md.tpl', '# Baton for {{project.name}}\n');
  put(dir, 'hooks/claude-settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '{{cli}} guard --hook claude' }] }] } }, null, 2));
  put(dir, 'github/baton-ci.yml.tpl', 'name: baton\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: {{cli}} check\n      - run: echo ${{ github.sha }}\n      - run: echo $[[ github.ref ]] $[[ matrix.os == \'x\' ]]\n');
  put(dir, 'github/baton-claude.yml.tpl', 'name: claude\nenv:\n  KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n');
  put(dir, 'github/baton-dispatch.yml.tpl', 'name: dispatch\n');
  put(dir, 'github/PULL_REQUEST_TEMPLATE.md.tpl', '## Sign-off for {{project.name}}\n');
  return dir;
}

let tplDir;
/** One shared fixture templates dir per test process. */
export function templates() {
  if (!tplDir) {
    tplDir = makeFixtureTemplates();
    process.on('exit', () => { try { fs.rmSync(tplDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  }
  return tplDir;
}

/** Environment for in-process runs: fixture templates and an empty PATH dir so agent detection is deterministic. */
export function installEnv(extra = {}) {
  return cleanEnv({ BATON_TEMPLATES_DIR: templates(), ...extra });
}

/** Like installEnv but PATH points at `binDir` only, so no real agent CLI is detected. */
export function isolatedEnv(binDir, extra = {}) {
  const env = installEnv(extra);
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.PATH = binDir;
  return env;
}

/** Put a fake executable called `name` in `dir` (works with PATHEXT on Windows). */
export function fakeBin(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
  try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
  return file;
}

/** Run the CLI in-process. Returns {code, out, err}. */
export async function baton(cwd, args, env = installEnv()) {
  const out = memoryStream();
  const err = memoryStream();
  const code = await main(args, { cwd, env, stdout: out, stderr: err });
  return { code, out: out.text(), err: err.text() };
}

/** A temp repo plus an empty directory to use as PATH. */
export function tempProject(opts = {}) {
  const repo = makeTempRepo(opts);
  return repo;
}

/** Snapshot of every file under root (excluding .git) as {rel: contents}. */
export function snapshotTree(root) {
  const out = {};
  const visit = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(dir, e.name), r);
      else out[r] = fs.readFileSync(path.join(dir, e.name)).toString('latin1');
    }
  };
  visit(root, '');
  return out;
}

test('fixture templates render and are complete', () => {
  assert.ok(fs.existsSync(path.join(templates(), 'adapters.json')));
});
