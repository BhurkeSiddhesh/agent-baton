import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempRepo, sampleConfig, cleanEnv, BIN } from './helpers.js';
import { main } from '../src/cli.js';
import { buildContext, memoryStream } from '../src/lib/context.js';
import { toPosix } from '../src/lib/util.js';
import * as guard from '../src/commands/guard.js';
import { extractPaths, resolveToolPath } from '../src/commands/guard.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

async function cli(cwd, args) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await main(args, { cwd, env: {}, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

/** Repo with codex working on WP-001 (owns src/api/export.js, tests/api/export.test.js). */
async function setup(mode = 'block', { begin = true } = {}) {
  const r = makeTempRepo({ git: true, config: sampleConfig({ guard: { mode }, coordination: ['CHANGELOG.md'] }), plan: true });
  cleanups.push(() => r.cleanup());
  if (begin) assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
  return r;
}

/** Run the guard command in-process with a tool-call payload on stdin. */
async function check(r, input, { agent = 'codex', hook = 'generic', cwd } = {}) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const ctx = buildContext({ cwd: cwd || r.root, env: {}, stdout, stderr, commands: [] });
  ctx.stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const args = { _: [], agent, hook };
  const status = await guard.run(ctx, args);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}
const edit = (file_path, extra = {}) => ({ tool_name: 'Edit', tool_input: { file_path, ...extra } });

test('allows owned files in every spelling; denies everything else in block mode', async () => {
  const r = await setup();
  const abs = path.join(r.root, 'src', 'api', 'export.js');
  const allowed = [
    'src/api/export.js', './src/api/export.js', abs, abs.replace(/\\/g, '/'), 'src\\api\\export.js', 'src/api/../api/export.js',
    'src/api/./export.js', 'SRC/API/EXPORT.JS', 'tests/api/export.test.js', 'src//api///export.js',
  ];
  for (const p of allowed) {
    const d = await check(r, edit(p));
    assert.equal(d.status, 0, `${p} should be allowed: ${d.stderr}`);
  }
  const denied = [
    'src/api/other.js', 'src/api/export.js.bak', 'src/apiX/export.js', 'src/ui/button.js', 'src/api/../ui/button.js', 'README.md',
    'package.json', 'src/api', 'src', '.', 'docs/x.md',
  ];
  for (const p of denied) {
    const d = await check(r, edit(p));
    assert.equal(d.status, 2, `${p} should be denied`);
    assert.match(d.stderr, /baton guard: blocked/);
    assert.match(d.stderr, /REQUEST/);
  }
});

test('traversal: leaving and re-entering the repository is resolved before matching', async () => {
  const r = await setup();
  const name = path.basename(r.root);
  const sneaky = `src/api/../../../${name}/README.md`; // goes up out of the repo and back into it
  assert.equal((await check(r, edit(sneaky))).status, 2);
  assert.equal((await check(r, edit(`../${name}/src/api/export.js`))).status, 0);
  assert.equal((await check(r, edit('src/api/export.js/../../../README.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/../../.env'))).status, 2);
});

test('paths outside the repository are not guarded', async () => {
  const r = await setup();
  const outside = path.join(os.tmpdir(), 'baton-guard-outside.txt');
  assert.equal((await check(r, edit(outside))).status, 0);
  assert.equal((await check(r, edit('../elsewhere/file.txt'))).status, 0);
});

test('protected paths are denied even when listed in no packet, in any case', async () => {
  const r = await setup();
  for (const p of ['.env', '.ENV', '.env.local', 'config/.env.production', 'secrets/key.txt', 'Secrets/key.txt', '.git/config', '.GIT/hooks/pre-commit',
    'certs/server.pem', 'a/b/id_rsa', 'a/token.json', 'data/app.sqlite', 'DATA/APP.DB', 'client_secret_1.json']) {
    const d = await check(r, edit(p));
    assert.equal(d.status, 2, `${p} should be protected`);
    assert.match(d.stderr, /protected/);
  }
  assert.equal((await check(r, edit('.env.example'))).status, 2); // not owned by WP-001, but not "protected"
  assert.doesNotMatch((await check(r, edit('.env.example'))).stderr, /protected/);
  // config.protected.globs extend the list.
  const r2 = makeTempRepo({ git: true, config: sampleConfig({ guard: { mode: 'block' }, protected: { globs: ['*.p8'] } }), plan: true });
  cleanups.push(() => r2.cleanup());
  const d = await check(r2, edit('src/api/AuthKey.p8'), { agent: 'codex' });
  assert.equal(d.status, 2);
  assert.match(d.stderr, /protected/);
});

test('coordination paths are always allowed, also for an agent without a packet', async () => {
  const r = await setup('block', { begin: false });
  for (const p of ['.baton/ledger/x.json', '.baton/state/y', '.baton/views/STATUS.md', 'CHANGELOG.md', 'changelog.md']) {
    assert.equal((await check(r, edit(p), { agent: 'gemini' })).status, 0, p);
  }
});

test('an agent without an in-progress packet is blocked in block mode, silent in warn mode', async () => {
  const r = await setup('block', { begin: false });
  const d = await check(r, edit('src/api/export.js'), { agent: 'codex' });
  assert.equal(d.status, 2);
  assert.match(d.stderr, /no IN_PROGRESS packet/);
  assert.match(d.stderr, /baton begin/);
  const w = await setup('warn', { begin: false });
  const dw = await check(w, edit('src/api/export.js'), { agent: 'codex' });
  assert.equal(dw.status, 0);
  assert.equal(dw.stderr, '');
});

test('warn mode allows but speaks; off mode allows silently', async () => {
  const w = await setup('warn');
  const d = await check(w, edit('README.md'));
  assert.equal(d.status, 0);
  assert.match(d.stderr, /baton guard: warning/);
  assert.match(d.stderr, /README\.md/);
  const off = await setup('off');
  const o = await check(off, edit('README.md'));
  assert.equal(o.status, 0);
  assert.equal(o.stderr, '');
});

test('only the acting agent\'s own packets count; the orchestrator may edit the plan', async () => {
  const r = await setup();
  assert.equal((await check(r, edit('src/api/export.js'), { agent: 'gemini' })).status, 2); // codex holds it
  assert.equal((await check(r, edit('.baton/plan.json'), { agent: 'codex' })).status, 2);
  assert.equal((await check(r, edit('.baton/plan.json'), { agent: 'claude' })).status, 0);
  assert.equal((await check(r, edit('.baton/config.json'), { agent: 'claude' })).status, 0);
  assert.equal((await check(r, edit('src/api/export.js'), { agent: null })).status, 0); // unidentified: only protected paths are checked
  assert.equal((await check(r, edit('.env'), { agent: null })).status, 2);
  const other = await check(r, edit('src/ui/button.js'));
  assert.match(other.stderr, /owned by WP-003/);
});

test('payload shapes: path/file keys, edits arrays, multiple files, non-file tools, junk input', async () => {
  const r = await setup();
  assert.equal((await check(r, { tool_input: { path: 'src/api/export.js' } })).status, 0);
  assert.equal((await check(r, { tool_input: { file: 'README.md' } })).status, 2);
  assert.equal((await check(r, { tool_input: { notebook_path: 'README.ipynb' } })).status, 2);
  assert.equal((await check(r, { file_path: 'README.md' })).status, 2); // cursor style, top level
  assert.equal((await check(r, { tool_input: { edits: [{ file_path: 'src/api/export.js' }, { file_path: 'README.md' }] } })).status, 2);
  assert.equal((await check(r, { tool_input: { files: ['src/api/export.js', 'tests/api/export.test.js'] } })).status, 0);
  assert.equal((await check(r, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } })).status, 0);
  assert.equal((await check(r, '')).status, 0);
  assert.equal((await check(r, 'null')).status, 0);
  const junk = await check(r, '{not json');
  assert.equal(junk.status, 2);
  assert.match(junk.stderr, /not valid JSON/);
  const w = await setup('warn');
  const junkWarn = await check(w, '{not json');
  assert.equal(junkWarn.status, 0);
  assert.match(junkWarn.stderr, /not valid JSON/);
  assert.deepEqual(extractPaths({ tool_input: { file_path: 'a', path: 'b' }, file_path: 'a' }).sort(), ['a', 'b']);
});

test('relative payload paths resolve against the payload cwd', async () => {
  const r = await setup();
  const sub = path.join(r.root, 'src', 'api');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal((await check(r, { cwd: sub, tool_input: { file_path: 'export.js' } }, { cwd: r.root })).status, 0);
  assert.equal((await check(r, { cwd: sub, tool_input: { file_path: '../ui/button.js' } }, { cwd: r.root })).status, 2);
  assert.equal((await check(r, edit('export.js'), { cwd: sub })).status, 0); // process cwd is a subdirectory
});

test('NUL bytes are denied', async () => {
  const r = await setup();
  const d = await check(r, edit('src/api/export.js\u0000.txt'));
  assert.equal(d.status, 2);
  assert.match(d.stderr, /NUL/);
});

test('symlinks are resolved: a link inside an owned folder cannot reach unowned files', async (t) => {
  const r = await setup();
  fs.mkdirSync(path.join(r.root, 'src', 'api'), { recursive: true });
  fs.mkdirSync(path.join(r.root, 'other'), { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-guard-link-'));
  cleanups.push(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  try {
    fs.symlinkSync(path.join(r.root, 'other'), path.join(r.root, 'src', 'api', 'inner'), 'junction');
    fs.symlinkSync(outsideDir, path.join(r.root, 'src', 'api', 'escape'), 'junction');
  } catch (e) {
    t.skip(`cannot create links here: ${e.code}`);
    return;
  }
  const inner = await check(r, edit('src/api/inner/new.js'));
  assert.equal(inner.status, 2);
  assert.match(inner.stderr, /other\/new\.js/);
  const esc = await check(r, edit('src/api/escape/new.js'));
  assert.equal(esc.status, 2);
  assert.match(esc.stderr, /symlink/);
  // A path that lives outside the repo but resolves into it through a link is judged by where it lands.
  fs.mkdirSync(path.join(r.root, 'secrets'), { recursive: true });
  const back = path.join(outsideDir, 'back');
  fs.symlinkSync(path.join(r.root, 'secrets'), back, 'junction');
  assert.equal((await check(r, edit(path.join(back, 'k.txt')))).status, 2);
  // Owned targets reached through a link are fine.
  fs.mkdirSync(path.join(r.root, 'tests', 'api'), { recursive: true });
  fs.symlinkSync(path.join(r.root, 'tests', 'api'), path.join(outsideDir, 'tests-link'), 'junction');
  assert.equal((await check(r, edit(path.join(outsideDir, 'tests-link', 'export.test.js')))).status, 0);
});

test('a dangling symlink is denied', async (t) => {
  const r = await setup();
  fs.mkdirSync(path.join(r.root, 'src', 'api'), { recursive: true });
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-gone-'));
  try { fs.symlinkSync(gone, path.join(r.root, 'src', 'api', 'dead'), 'junction'); } catch (e) { t.skip(`cannot create links here: ${e.code}`); return; }
  fs.rmSync(gone, { recursive: true, force: true });
  const d = await check(r, edit('src/api/dead/new.js'));
  assert.equal(d.status, 2);
  assert.match(d.stderr, /symlink/);
});

test('windows quirks: trailing dots and spaces, alternate data streams', async (t) => {
  if (process.platform !== 'win32') { t.skip('windows only'); return; }
  const r = await setup();
  assert.equal((await check(r, edit('src/api/export.js.'))).status, 0); // same file as export.js
  assert.equal((await check(r, edit('src/api/export.js '))).status, 0);
  assert.equal((await check(r, edit('.env.'))).status, 2);
  assert.equal((await check(r, edit('.env '))).status, 2);
  assert.equal((await check(r, edit('README.md::$DATA'))).status, 2);
  assert.equal((await check(r, edit('src/api/export.js:hidden'))).status, 2);
  assert.equal((await check(r, edit(path.join(r.root, 'SRC', 'API', 'export.js')))).status, 0);
});

test('hook dialects: cursor gets JSON permissions, claude and generic use exit 2 plus stderr', async () => {
  const r = await setup();
  const deny = await check(r, edit('README.md'), { hook: 'cursor' });
  assert.equal(deny.status, 2);
  const j = JSON.parse(deny.stdout);
  assert.equal(j.permission, 'deny');
  assert.match(j.agent_message, /README\.md/);
  const allow = await check(r, edit('src/api/export.js'), { hook: 'cursor' });
  assert.equal(allow.status, 0);
  assert.equal(JSON.parse(allow.stdout).permission, 'allow');
  const w = await setup('warn');
  const warn = await check(w, edit('README.md'), { hook: 'cursor' });
  assert.equal(warn.status, 0);
  assert.equal(JSON.parse(warn.stdout).permission, 'allow');
  const claude = await check(r, edit('README.md'), { hook: 'claude' });
  assert.equal(claude.status, 2);
  assert.equal(claude.stdout, '');
  await assert.rejects(() => check(r, edit('x'), { hook: 'nope' }), /--hook/);
});

test('an uninitialised folder is never guarded', async () => {
  const r = makeTempRepo({ git: true });
  cleanups.push(() => r.cleanup());
  const d = await check(r, edit('anything.txt'));
  assert.equal(d.status, 0);
});

test('real process: the hook contract is exit 2 and a message on stderr, payload on stdin', async () => {
  const r = await setup();
  const run = (file, agent = 'codex') => spawnSync(process.execPath, [BIN, 'guard', '--agent', agent, '--hook', 'claude'], {
    cwd: r.root, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }), encoding: 'utf8', env: cleanEnv(),
  });
  const ok = run(path.join(r.root, 'src', 'api', 'export.js'));
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run(path.join(r.root, 'README.md'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /baton guard: blocked/);
  const viaEnv = spawnSync(process.execPath, [BIN, 'guard'], {
    cwd: r.root, input: JSON.stringify(edit('README.md')), encoding: 'utf8', env: cleanEnv({ BATON_AGENT: 'codex' }),
  });
  assert.equal(viaEnv.status, 2);
});

test('resolveToolPath returns repo-relative posix paths', async () => {
  const r = await setup();
  const a = resolveToolPath(r.root, 'src\\api\\..\\api\\export.js');
  assert.deepEqual(a.rels, ['src/api/export.js']);
  assert.equal(resolveToolPath(r.root, path.join(os.tmpdir(), 'x')).outside, true);
  assert.ok(resolveToolPath(r.root, 'a\0b').deny);
});

test('traversal: URL-encoded and double-encoded directory traversals are resolved and caught', async () => {
  const r = await setup();
  const name = path.basename(r.root);

  // Single and double-encoded ../ sequences trying to reach unowned files
  assert.equal((await check(r, edit('src/api/%2e%2e/%2e%2e/README.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/%252e%252e%252f%252e%252e%252fREADME.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/..%2f..%2fREADME.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/..%5c..%5cREADME.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/%2e%2e%5c%2e%2e%5cREADME.md'))).status, 2);
  assert.equal((await check(r, edit('src/api/%252e%252e%255c%252e%252e%255cREADME.md'))).status, 2);

  // Traversal leaving and re-entering via URL encoding
  assert.equal((await check(r, edit(`src/api/%2e%2e/%2e%2e/%2e%2e/${name}/README.md`))).status, 2);
  assert.equal((await check(r, edit(`src/api/%252e%252e%252f%252e%252e%252f%252e%252e%252f${name}/src/api/export.js`))).status, 0);

  // Double-encoded NUL byte is denied
  const dNul = await check(r, edit('src/api/export.js%2500.txt'));
  assert.equal(dNul.status, 2);
  assert.match(dNul.stderr, /NUL/);
});

test('NTFS alternate data streams: colon stream syntax is denied across platforms', async () => {
  const r = await setup();
  for (const s of [
    'src/api/export.js:hidden',
    'src/api/export.js::$DATA',
    'src/api/export.js:stream:$DATA',
    'src/api/export.js%3ahidden',
    'src/api/export.js%253ahidden',
    'src/api/export.js%3a%3a$DATA',
    '.env:stream',
    'README.md::$DATA',
  ]) {
    const d = await check(r, edit(s));
    assert.equal(d.status, 2, `stream ${s} should be denied`);
    assert.match(d.stderr, /NTFS alternate data stream/);
  }
});

test('Windows UNC and device namespace paths: extended prefixes and local shares', async () => {
  const r = await setup();
  const repoDrive = path.parse(r.root).root.replace(/[\\/]/g, '').toLowerCase();

  // Extended-length drive path (\\?\C:\... and \\.\C:\...)
  if (repoDrive.includes(':')) {
    const driveLetter = repoDrive[0];
    const relFromDrive = toPosix(path.resolve(r.root, 'src/api/export.js')).slice(2);
    const uncExtended = `//?/${driveLetter}:${relFromDrive}`;
    const devExtended = `//./${driveLetter}:${relFromDrive}`;
    assert.equal((await check(r, edit(uncExtended))).status, 0);
    assert.equal((await check(r, edit(devExtended))).status, 0);

    // Unowned via UNC extended
    const unownedUnc = `//?/${driveLetter}:${toPosix(path.resolve(r.root, 'README.md')).slice(2)}`;
    assert.equal((await check(r, edit(unownedUnc))).status, 2);
  }

  // Device namespaces and extended UNC forms are denied
  const devPipe = await check(r, edit('//./pipe/named-pipe'));
  assert.equal(devPipe.status, 2);
  assert.match(devPipe.stderr, /device or extended-length/);

  const devDisk = await check(r, edit('//./PhysicalDrive0'));
  assert.equal(devDisk.status, 2);
  assert.match(devDisk.stderr, /device or extended-length/);

  const devUnc = await check(r, edit('//?/UNC/localhost/c$/file.txt'));
  assert.equal(devUnc.status, 2);
  assert.match(devUnc.stderr, /device or extended-length/);

  // Local shares without administrative C$ are denied
  const localShare = await check(r, edit('//localhost/myshare/export.js'));
  assert.equal(localShare.status, 2);
  assert.match(localShare.stderr, /local network share/);

  // Remote network UNC paths are treated as outside the repository
  const remoteUnc = await check(r, edit('//remote-host/share/export.js'));
  assert.equal(remoteUnc.status, 0);
});

test('redundant trailing slashes, dots, and spaces', async () => {
  const r = await setup();
  // Trailing dots and spaces on owned files resolve to the file (Win32 behavior)
  assert.equal((await check(r, edit('src/api/export.js.'))).status, 0);
  assert.equal((await check(r, edit('src/api/export.js...'))).status, 0);
  assert.equal((await check(r, edit('src/api/export.js   '))).status, 0);
  assert.equal((await check(r, edit('src/api/export.js/'))).status, 0);
  assert.equal((await check(r, edit('src/api/export.js/.'))).status, 0);

  // Trailing dots on unowned and protected files are still denied
  assert.equal((await check(r, edit('README.md.'))).status, 2);
  assert.equal((await check(r, edit('README.md...'))).status, 2);
  assert.equal((await check(r, edit('.env.'))).status, 2);
  assert.equal((await check(r, edit('.env...'))).status, 2);
  assert.equal((await check(r, edit('.env   '))).status, 2);

  // Invalid dot sequences (3+ dots as directory name) are rejected
  const dotSeq = await check(r, edit('src/api/.../export.js'));
  assert.equal(dotSeq.status, 2);
  assert.match(dotSeq.stderr, /invalid dot\/space sequence/);
});

test('nested payload shapes: nested file objects, edits arrays, and file URLs', async () => {
  const r = await setup();

  // Nested file object
  assert.equal((await check(r, { tool_input: { file: { path: 'src/api/export.js' } } })).status, 0);
  assert.equal((await check(r, { tool_input: { target: { file_path: 'README.md' } } })).status, 2);

  // Multiple and nested edits arrays
  assert.equal((await check(r, { tool_input: { edits: [{ edits: [{ file_path: 'src/api/export.js' }] }] } })).status, 0);
  assert.equal((await check(r, { tool_input: { edits: [{ edits: [{ file_path: 'README.md' }] }] } })).status, 2);

  // Files array with objects
  assert.equal((await check(r, { tool_input: { files: [{ path: 'src/api/export.js' }] } })).status, 0);
  assert.equal((await check(r, { tool_input: { files: [{ path: 'README.md' }] } })).status, 2);

  // source_file / dest_file keys
  assert.equal((await check(r, { tool_input: { source_file: 'src/api/export.js', dest_file: 'src/api/export.js' } })).status, 0);
  assert.equal((await check(r, { tool_input: { source_file: 'src/api/export.js', dest_file: 'README.md' } })).status, 2);

  // file:// URI
  const absOwnedPosix = toPosix(path.resolve(r.root, 'src/api/export.js'));
  assert.equal((await check(r, { tool_input: { uri: `file:///${absOwnedPosix.replace(/^\//, '')}` } })).status, 0);
  const absUnownedPosix = toPosix(path.resolve(r.root, 'README.md'));
  assert.equal((await check(r, { tool_input: { uri: `file:///${absUnownedPosix.replace(/^\//, '')}` } })).status, 2);
});

test('fail-closed in block mode vs fail-open in warn mode for unknown payloads and invalid JSON', async () => {
  const r = await setup('block');

  // Block mode fails closed on invalid JSON
  const badJsonBlock = await check(r, '{corrupt json');
  assert.equal(badJsonBlock.status, 2);
  assert.match(badJsonBlock.stderr, /failing closed in block mode/);

  // Block mode fails closed on unknown payload shape with no extractable path
  const unknownBlock = await check(r, { tool_name: 'mystery_mutation_tool', tool_input: { payload: 'xyz' } });
  assert.equal(unknownBlock.status, 2);
  assert.match(unknownBlock.stderr, /unknown payload shape/);

  // Block mode fails closed on write tool without path
  const writeMissingPath = await check(r, { tool_name: 'Write', tool_input: { content: 'hello' } });
  assert.equal(writeMissingPath.status, 2);
  assert.match(writeMissingPath.stderr, /unknown payload shape/);

  // Warn mode fails open with a warning on stderr
  const w = await setup('warn');
  const badJsonWarn = await check(w, '{corrupt json');
  assert.equal(badJsonWarn.status, 0);
  assert.match(badJsonWarn.stderr, /fail open/);

  const unknownWarn = await check(w, { tool_name: 'mystery_mutation_tool', tool_input: { payload: 'xyz' } });
  assert.equal(unknownWarn.status, 0);
  assert.match(unknownWarn.stderr, /fail open/);

  // Explicit config.guard.failClosed override
  const rExplicitFalse = makeTempRepo({ git: true, config: sampleConfig({ guard: { mode: 'block', failClosed: false } }), plan: true });
  cleanups.push(() => rExplicitFalse.cleanup());
  const failOpenOverride = await check(rExplicitFalse, '{corrupt json');
  assert.equal(failOpenOverride.status, 0);
  assert.match(failOpenOverride.stderr, /fail open/);
});

test('protected paths are unconditionally denied in block mode regardless of packet ownership', async () => {
  // Plan packet claiming wildcard '**' and explicit '.env'
  const r = makeTempRepo({
    git: true,
    config: sampleConfig({ guard: { mode: 'block' } }),
    plan: {
      schema: 1,
      title: 'Wildcard Packet',
      orchestrator: 'claude',
      packets: [{ id: 'WP-WILDCARD', title: 'Owns everything', by: 'codex', owns: ['**', '.env', 'secrets/**'] }],
    },
  });
  cleanups.push(() => r.cleanup());
  assert.equal((await cli(r.root, ['begin', 'WP-WILDCARD', '--agent', 'codex'])).status, 0);

  // Even with owns: ['**'], protected paths must be unconditionally denied
  for (const p of ['.env', '.git/config', 'secrets/key.pem', 'certs/server.key', 'data/app.sqlite']) {
    const d = await check(r, edit(p));
    assert.equal(d.status, 2, `${p} must be denied despite packet ownership`);
    assert.match(d.stderr, /protected/);
    assert.match(d.stderr, /Protected paths \(secrets, credentials, databases, \.git\) cannot be edited\./);
  }

  // Normal files owned under '**' remain allowed
  assert.equal((await check(r, edit('src/anything.js'))).status, 0);
});
