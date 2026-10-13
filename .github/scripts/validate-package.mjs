// Validate the exact npm-pack file list before testing a local/offline tarball install.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = [
  'LICENSE',
  'README.md',
  'package.json',
  'bin/baton.js',
  'src/cli.js',
  'templates/adapters.json',
  'docs/SECURITY_MODEL.md',
];

export function validatePackage(entry, pkg) {
  const problems = [];
  if (!entry || !Array.isArray(entry.files)) return ['npm pack manifest is missing its files list'];
  const paths = new Set(entry.files.map((f) => f.path));
  for (const required of REQUIRED) if (!paths.has(required)) problems.push('missing ' + required);
  const forbidden = [...paths].filter((p) =>
    /(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|\.baton|\.github)(?:\/|$)/i.test(p) ||
    /(?:^|\/)(?:id_rsa|id_ed25519|\.npmrc|\.pypirc|[^/]+\.pem|[^/]+\.key)$/i.test(p));
  for (const item of forbidden) problems.push('unexpected sensitive or development-only file ' + item);
  if (Object.keys(pkg.dependencies || {}).length) problems.push('runtime dependencies must remain empty');
  if (pkg.bin?.baton !== 'bin/baton.js') problems.push('published baton bin entrypoint changed');
  if (pkg.license !== 'MIT') problems.push('MIT license metadata missing');
  return problems;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2] || 'pack.json', 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const problems = Array.isArray(manifest) && manifest.length === 1
    ? validatePackage(manifest[0], pkg)
    : ['expected exactly one packed archive'];
  if (problems.length) {
    for (const p of problems) console.error('package validation: ' + p);
    process.exitCode = 1;
  } else console.log('package validation: archive contains required files and no sensitive paths');
}
