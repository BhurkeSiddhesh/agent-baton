import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, main, discoverCommands, formatGlobalHelp, formatCommandHelp } from '../src/cli.js';
import { UsageError } from '../src/lib/errors.js';
import { memoryStream, buildContext, resolveAgent } from '../src/lib/context.js';
import { packageVersion } from '../src/lib/paths.js';
import { makeTempRepo, runCli, sampleConfig, samplePlan } from './helpers.js';

const OPTS = {
  agent: { type: 'string', alias: 'a' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean', alias: 'n' },
  check: { type: 'string[]' },
  score: { type: 'number' },
  yes: { type: 'boolean', alias: 'y' },
  note: 'string',
  mode: { type: 'string', default: 'warn' },
};

test('parseArgs table', () => {
  const rows = [
    [[], { _: [], json: false, check: [], mode: 'warn' }],
    [['a', 'b'], { _: ['a', 'b'] }],
    [['--agent', 'codex'], { agent: 'codex' }],
    [['--agent=codex'], { agent: 'codex' }],
    [['-a', 'codex'], { agent: 'codex' }],
    [['-acodex'], { agent: 'codex' }],
    [['--json'], { json: true }],
    [['--json=false'], { json: false }],
    [['--no-json'], { json: false }],
    [['--dry-run'], { 'dry-run': true, dryRun: true }],
    [['-n'], { 'dry-run': true }],
    [['-ny'], { 'dry-run': true, yes: true }],
    [['--check', 'a', '--check', 'b'], { check: ['a', 'b'] }],
    [['--check=a,b'], { check: ['a,b'] }],
    [['--score', '7.5'], { score: 7.5 }],
    [['--score=-1'], { score: -1 }],
    [['--note', '-x leading dash'], { note: '-x leading dash' }],
    [['--note=--weird'], { note: '--weird' }],
    [['x', '--agent', 'c', 'y'], { _: ['x', 'y'], agent: 'c' }],
    [['--', '--agent', 'x'], { _: ['--agent', 'x'] }],
    [['-5', 'plan'], { _: ['-5', 'plan'] }],
    [['-h'], { help: true }],
    [['--help'], { help: true }],
    [['--mode', 'block'], { mode: 'block' }],
  ];
  for (const [argv, want] of rows) {
    const got = parseArgs(argv, OPTS);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${argv.join(' ')} -> ${k}`);
  }
});

test('parseArgs errors are UsageErrors with hints', () => {
  const rows = [
    [['--nope'], /unknown option --nope/],
    [['--agnt', 'x'], /did you mean --agent/],
    [['-z'], /unknown option -z/],
    [['--agent'], /needs a value/],
    [['--agent', '--json'], /needs a value/],
    [['-a'], /needs a value/],
    [['--score', 'abc'], /expects a number/],
    [['--json=maybe'], /cannot take the value/],
    [['--no-json=1'], /does not take a value/],
    [['--no-agent'], /unknown option/],
  ];
  for (const [argv, re] of rows) assert.throws(() => parseArgs(argv, OPTS), (e) => e instanceof UsageError && re.test(e.message), argv.join(' '));
});

function fakeCommands(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  // Temporary .js command fixtures must be ESM even outside this package's root.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
}

test('discoverCommands: loads modules, aliases, isolates broken ones', async () => {
  const repo = makeTempRepo();
  try {
    const dir = path.join(repo.root, 'cmds');
    fakeCommands(dir, {
      'hello.js': `export const name='hello'; export const aliases=['hi']; export const summary='Say hello'; export const usage='baton hello [--loud]';
        export const options={loud:{type:'boolean',description:'shout'}}; export async function run(ctx,args){ ctx.out(args.loud?'HELLO':'hello'); return 0; }`,
      'broken.js': 'export const name = ;',
      'norun.js': "export const name='norun';",
      'exit7.js': `export const name='exit7'; export const summary='x'; export const usage='baton exit7'; export const options={}; export async function run(){ return 7; }`,
      'rule.js': `import { BatonError } from ${JSON.stringify(new URL('../src/lib/errors.js', import.meta.url).href)};
        export const name='rule'; export const summary='x'; export const usage='baton rule'; export const options={};
        export async function run(){ throw new BatonError('nope', { hint: 'try yes' }); }`,
      'crash.js': "export const name='crash'; export const summary='x'; export const usage='baton crash'; export const options={}; export async function run(){ throw new TypeError('kaboom'); }",
      'readme.txt': 'ignored',
    });
    const cmds = await discoverCommands(dir);
    assert.deepEqual(cmds.map((c) => c.name).sort(), ['broken', 'crash', 'exit7', 'hello', 'norun', 'rule']);
    assert.ok(cmds.find((c) => c.name === 'broken').error);
    assert.ok(cmds.find((c) => c.name === 'norun').error);

    const run = async (argv) => {
      const stdout = memoryStream();
      const stderr = memoryStream();
      const status = await main(argv, { cwd: repo.root, env: {}, stdout, stderr, commandsDir: dir });
      return { status, out: stdout.text(), err: stderr.text() };
    };
    assert.deepEqual(await run(['hello']), { status: 0, out: 'hello\n', err: '' });
    assert.equal((await run(['hi', '--loud'])).out, 'HELLO\n');
    assert.equal((await run(['exit7'])).status, 7);
    let r = await run(['rule']);
    assert.deepEqual([r.status, r.err], [1, 'baton: nope\nhint: try yes\n']);
    r = await run(['crash']);
    assert.equal(r.status, 3);
    assert.match(r.err, /internal error: kaboom/);
    r = await run(['broken']);
    assert.equal(r.status, 3);
    r = await run(['hello', '--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.err, /unknown option --bogus/);
    r = await run(['helo']);
    assert.equal(r.status, 2);
    assert.match(r.err, /did you mean "hello"/);
    r = await run([]);
    assert.equal(r.status, 0);
    assert.match(r.out, /hello\s+Say hello/);
    assert.match(r.out, /broken\s+\(failed to load\)/);
    r = await run(['hello', '--help']);
    assert.match(r.out, /baton hello \[--loud\]/);
    assert.match(r.out, /--loud\s+shout/);
    assert.match(r.out, /Aliases: hi/);
    r = await run(['help', 'hello']);
    assert.match(r.out, /Say hello/);
    r = await run(['help', 'zzz']);
    assert.equal(r.status, 2);
  } finally { repo.cleanup(); }
});

test('main: --version, --cwd, ctx wiring', async () => {
  const repo = makeTempRepo({ config: true, plan: true });
  try {
    const dir = path.join(repo.root, 'cmds');
    fakeCommands(dir, {
      'where.js': `export const name='where'; export const summary='x'; export const usage='baton where'; export const options={json:{type:'boolean'}};
        export async function run(ctx,args){ const s=ctx.loadState(); ctx.json({root:ctx.root.replace(/\\\\/g,'/'),cwd:ctx.cwd.replace(/\\\\/g,'/'),packets:s.plan.packets.length,agents:ctx.loadConfig().agents.length,json:args.json,n:ctx.commands.length}); }`,
    });
    const stdout = memoryStream();
    assert.equal(await main(['--version'], { stdout, stderr: memoryStream() }), 0);
    assert.equal(stdout.text(), `${packageVersion()}\n`);
    const out = memoryStream();
    fs.mkdirSync(path.join(repo.root, 'sub'));
    assert.equal(await main(['--cwd', 'sub', 'where', '--json'], { cwd: repo.root, env: {}, stdout: out, stderr: memoryStream(), commandsDir: dir }), 0);
    const got = JSON.parse(out.text());
    assert.equal(got.root.toLowerCase(), repo.root.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual([got.cwd.endsWith('/sub'), got.packets, got.agents, got.json, got.n], [true, 4, 3, true, 1]);
  } finally { repo.cleanup(); }
});

test('formatters list every option and group commands', () => {
  const text = formatCommandHelp({ name: 'x', usage: 'baton x', summary: 'S', description: 'D', aliases: ['y'], options: OPTS, examples: ['baton x -a c'] });
  for (const needle of ['--agent <v>', '-a, --agent', '--check <v>...', '--score <n>', '--dry-run', '(default: warn)', 'Aliases: y', 'Examples:', 'baton x -a c', '-h, --help']) assert.ok(text.includes(needle), needle);
  const g = formatGlobalHelp([{ name: 'a', summary: 'A', aliases: [], group: 'Planning' }, { name: 'b', summary: 'B', aliases: [] }, { name: 'h', summary: 'H', aliases: [], hidden: true }], '1.2.3');
  assert.ok(g.includes('baton 1.2.3') && g.includes('Planning:') && g.includes('Commands:') && !g.includes(' h '));
});

test('resolveAgent and buildContext', () => {
  const config = sampleConfig();
  assert.equal(resolveAgent(config, {}, 'codex'), 'codex');
  assert.equal(resolveAgent(config, { BATON_AGENT: 'claude' }, undefined), 'claude');
  assert.equal(resolveAgent(config, {}, 'human'), 'human');
  assert.equal(resolveAgent(config, {}, undefined, { required: false }), null);
  assert.throws(() => resolveAgent(config, {}, undefined), UsageError);
  assert.throws(() => resolveAgent(config, {}, 'zed'), /unknown agent/);
  assert.throws(() => resolveAgent(config, { BATON_AGENT: 'claude' }, 'codex'), /BATON_AGENT=claude/);
  const stdout = memoryStream();
  const stderr = memoryStream();
  const ctx = buildContext({ cwd: process.cwd(), env: {}, stdout, stderr, root: '/nowhere' });
  ctx.out('a');
  ctx.out('b\n');
  ctx.err('e');
  ctx.json({ x: 1 });
  assert.equal(stdout.text(), 'a\nb\n{\n  "x": 1\n}\n');
  assert.equal(stderr.text(), 'e\n');
});

// ---------------------------------------------------------------- the real binary

test('binary: --version, version, help, command --help, unknown command', () => {
  const repo = makeTempRepo();
  try {
    let r = runCli(repo.root, ['--version']);
    assert.deepEqual([r.status, r.stdout.trim()], [0, packageVersion()]);
    r = runCli(repo.root, ['version']);
    assert.equal(r.stdout.trim(), `baton ${packageVersion()}`);
    r = runCli(repo.root, ['version', '--json']);
    assert.equal(JSON.parse(r.stdout).version, packageVersion());
    r = runCli(repo.root, ['help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: baton <command>/);
    assert.match(r.stdout, /version\s+Print the baton version/);
    r = runCli(repo.root, ['version', '--help']);
    assert.match(r.stdout, /baton version \[--json\]/);
    r = runCli(repo.root, ['help', 'version']);
    assert.match(r.stdout, /baton version \[--json\]/);
    r = runCli(repo.root, ['--help']);
    assert.equal(r.status, 0);
    r = runCli(repo.root, ['frobnicate']);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unknown command "frobnicate"/);
    r = runCli(repo.root, ['version', '--wat']);
    assert.equal(r.status, 2);
  } finally { repo.cleanup(); }
});

test('binary prints --json output as exactly one document', () => {
  const repo = makeTempRepo({ config: samplePlan() && true, plan: true });
  try {
    const r = runCli(repo.root, ['version', '--json']);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    assert.equal(r.stderr, '');
  } finally { repo.cleanup(); }
});
