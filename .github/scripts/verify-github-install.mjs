import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReleaseTag } from './assert-release-tag.mjs';
import { validatePackage } from './validate-package.mjs';

function npmInvocation() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!cli) throw new Error('could not locate npm-cli.js beside the active Node runtime');
  return { command: process.execPath, prefix: [cli] };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout;
}

function pack(cwd, spec) {
  const { command, prefix } = npmInvocation();
  const output = run(command, [...prefix, 'pack', ...(spec ? [spec] : []), '--json'], { cwd });
  const entries = JSON.parse(output);
  if (entries.length !== 1) throw new Error('expected exactly one packed archive');
  return entries[0];
}

export function comparePackEntries(local, remote) {
  const problems = [];
  for (const field of ['name', 'version', 'integrity', 'shasum', 'size', 'unpackedSize']) {
    if (local?.[field] !== remote?.[field]) problems.push(`${field} differs between tagged checkout and GitHub source`);
  }
  const files = (entry) => (entry?.files || []).map(({ path: file, size, mode }) => `${file}\0${size}\0${mode || ''}`).sort();
  if (JSON.stringify(files(local)) !== JSON.stringify(files(remote))) problems.push('archive file manifest differs between tagged checkout and GitHub source');
  return problems;
}

export function githubSpec(repository, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('invalid repository name');
  if (!/^v[0-9A-Za-z.+-]+$/.test(tag || '')) throw new Error('invalid release tag');
  return `git+https://github.com/${repository}.git#${tag}`;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const repository = process.argv[2];
  const tag = process.argv[3];
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!validateReleaseTag(tag, pkg.version)) throw new Error(`tag ${tag} does not match package version ${pkg.version}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-release-'));
  try {
    const localDir = path.join(temp, 'local');
    const remoteDir = path.join(temp, 'remote');
    const installDir = path.join(temp, 'install');
    fs.mkdirSync(localDir); fs.mkdirSync(remoteDir); fs.mkdirSync(installDir);
    const local = pack(localDir, root);
    const remote = pack(remoteDir, githubSpec(repository, tag));
    const problems = [...validatePackage(remote, pkg), ...comparePackEntries(local, remote)];
    if (problems.length) throw new Error(problems.join('\n'));

    fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"release-smoke","private":true}\n');
    const { command, prefix } = npmInvocation();
    run(command, [...prefix, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(remoteDir, remote.filename)], { cwd: installDir });
    const bin = path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'agent-baton.cmd' : 'agent-baton');
    const version = run(bin, ['version'], { cwd: installDir }).trim();
    if (!version.includes(pkg.version)) throw new Error(`installed binary did not report ${pkg.version}: ${version}`);
    console.log(`GitHub install verified: ${repository}@${tag} (${remote.integrity})`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
