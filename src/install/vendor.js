import fs from 'node:fs';
import path from 'node:path';
import { walk } from '../lib/util.js';
import { packageRoot, packageVersion } from '../lib/paths.js';

export const RUNTIME_DIR = '.baton/runtime';
export const RUNTIME_ENTRY = '.baton/runtime/bin/baton.js';
export const RUNTIME_COMMAND = 'node .baton/runtime/bin/baton.js';

const SKIP_DIRS = ['node_modules', '.git', 'tests', 'test', '__pycache__', '.baton'];

function copyTree(srcDir, destPrefix, out) {
  if (!fs.existsSync(srcDir)) return;
  for (const rel of walk(srcDir, { skipDirs: SKIP_DIRS, skipPaths: [], maxSize: null })) {
    if (/\.test\.[cm]?js$/.test(rel)) continue;
    out.push({ rel: `${destPrefix}/${rel}`, data: fs.readFileSync(path.join(srcDir, rel)) });
  }
}

/** The package.json stub that makes `.baton/runtime/*.js` ESM and records the vendored version. */
export function runtimePackageJson(version = packageVersion()) {
  return `${JSON.stringify({
    name: 'baton-runtime',
    version,
    private: true,
    type: 'module',
    description: 'Vendored copy of agent-baton. Managed by "baton upgrade"; do not edit.',
    engines: { node: '>=18' },
  }, null, 2)}\n`;
}

/**
 * Everything that goes into `.baton/runtime/` plus the shims. Tests and node_modules are excluded.
 * @param {{srcRoot?: string, templates?: string}} [o] srcRoot: directory with bin/ and src/ (default: this package);
 *   templates: the templates directory to vendor.
 * @returns {{rel: string, data: Buffer|string, exec?: boolean}[]}
 */
export function collectRuntime({ srcRoot = packageRoot(), templates = path.join(srcRoot, 'templates') } = {}) {
  const out = [];
  copyTree(path.join(srcRoot, 'bin'), `${RUNTIME_DIR}/bin`, out);
  copyTree(path.join(srcRoot, 'src'), `${RUNTIME_DIR}/src`, out);
  copyTree(templates, `${RUNTIME_DIR}/templates`, out);
  // The vendored runtime redistributes substantial MIT-licensed source code.
  // Keep the upstream permission and warranty notice with each installed copy.
  const license = path.join(srcRoot, 'LICENSE');
  if (fs.existsSync(license)) out.push({ rel: `${RUNTIME_DIR}/LICENSE`, data: fs.readFileSync(license) });
  out.push({ rel: `${RUNTIME_DIR}/package.json`, data: runtimePackageJson() });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export const SH_SHIM = '#!/bin/sh\n# baton shim: runs the vendored runtime, no install needed.\nexec node "$(dirname "$0")/runtime/bin/baton.js" "$@"\n';
export const CMD_SHIM = '@echo off\r\nrem baton shim: runs the vendored runtime, no install needed.\r\nnode "%~dp0runtime\\bin\\baton.js" %*\r\n';

export function shims() {
  return [
    { rel: '.baton/baton', data: SH_SHIM, exec: true },
    { rel: '.baton/baton.cmd', data: CMD_SHIM },
  ];
}

/** Version recorded in a vendored runtime (null when absent). */
export function vendoredVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, RUNTIME_DIR, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** True when the running code is the vendored runtime of `root` (so there is nothing newer to copy from). */
export function runningFromRuntime(root) {
  try {
    return fs.realpathSync(packageRoot()) === fs.realpathSync(path.join(root, RUNTIME_DIR));
  } catch {
    return false;
  }
}
