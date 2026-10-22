import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateReleaseTag(tag, version) {
  const semver = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  return typeof tag === 'string' && typeof version === 'string' &&
    semver.test(tag) && tag === 'v' + version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (!validateReleaseTag(tag, pkg.version)) {
    console.error('release blocked: tag must equal v' + pkg.version + ' (got ' + JSON.stringify(tag || '') + ')');
    process.exitCode = 1;
  } else {
    console.log('release tag matches package version: ' + tag);
  }
}
