// Cross-platform, offline integration smoke: no user files or global git config are altered.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const baton = fileURLToPath(new URL('../../bin/baton.js', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-compat-'));
const root = path.join(tmp, 'space Unicode naïve 測試');
fs.mkdirSync(root, { recursive: true });

function run(file, args) {
  const r = spawnSync(file, args, { cwd: root, encoding: 'utf8', windowsHide: true, env: process.env });
  if (r.error || r.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${r.status}): ${r.error?.message || ''}\n${r.stdout || ''}\n${r.stderr || ''}`);
  }
  return r.stdout.trim();
}
try {
  run('git', ['init', '--quiet', '--initial-branch=main']);
  run('git', ['config', 'user.name', 'baton-ci']);
  run('git', ['config', 'user.email', 'baton-ci@example.invalid']);
  run('git', ['config', 'core.longpaths', 'true']);

  const rel = path.join('src with spaces', 'café', 'line-ending.md');
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'before\r\nafter\r\n', 'utf8');
  let longRel = null;
  if (process.platform === 'win32') {
    const parts = [];
    while (path.join(root, ...parts, 'long-path.txt').length <= 280) {
      parts.push(`segment-${String(parts.length + 1).padStart(2, '0')}-abcdefghij`);
    }
    longRel = path.join(...parts, 'long-path.txt');
    fs.mkdirSync(path.dirname(path.join(root, longRel)), { recursive: true });
    fs.writeFileSync(path.join(root, longRel), 'windows extended path\r\n', 'utf8');
    if (path.join(root, longRel).length <= 260) throw new Error('long-path fixture did not exceed 260 characters');
  }
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'platform-smoke', private: true, scripts: { test: 'node -e "process.exit(0)"' },
  }));
  run('git', ['add', '-A']);
  run('git', ['commit', '--quiet', '-m', 'seed']);
  run(process.execPath, [baton, 'init', '--yes', '--agents', 'claude,codex', '--test-cmd', 'node -e "process.exit(0)"']);
  run(process.execPath, [baton, 'init', '--yes', '--agents', 'claude,codex', '--test-cmd', 'node -e "process.exit(0)"']);
  run(process.execPath, [baton, 'doctor']);
  run(process.execPath, [baton, 'check']);
  const status = JSON.parse(run(process.execPath, [baton, 'status', '--json']));
  if (!status || typeof status !== 'object') throw new Error('status JSON not an object');
  if (fs.readFileSync(path.join(root, rel), 'utf8') !== 'before\r\nafter\r\n') throw new Error('CRLF or Unicode fixture was altered');
  if (longRel && fs.readFileSync(path.join(root, longRel), 'utf8') !== 'windows extended path\r\n') {
    throw new Error('Windows extended-path fixture was altered');
  }
  console.log(`PASS: ${process.platform} Node ${process.version}, ${run('git', ['--version'])}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
