import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseTag } from './assert-release-tag.mjs';

export function changelogSection(markdown, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`, 'm'));
  return match?.[1]?.trim() || '';
}

export function validateReleaseMetadata(release, pkg, changelog) {
  const problems = [];
  const tag = release?.tagName;
  if (!validateReleaseTag(tag, pkg?.version)) problems.push(`release tag must equal v${pkg?.version}`);
  if (release?.isDraft) problems.push('release must not be a draft');
  const section = changelogSection(changelog, pkg?.version || '');
  if (!section) problems.push(`CHANGELOG.md is missing a [${pkg?.version}] section`);
  const summary = section.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
  if (summary && !String(release?.body || '').includes(summary)) {
    problems.push('release notes do not include the first changelog summary line: ' + summary);
  }
  if (!String(release?.name || '').includes(pkg?.version || '')) problems.push('release name does not include package version');
  return problems;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const release = JSON.parse(fs.readFileSync(process.argv[2] || 'release.json', 'utf8'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
  const problems = validateReleaseMetadata(release, pkg, changelog);
  if (problems.length) {
    for (const problem of problems) console.error('release metadata: ' + problem);
    process.exitCode = 1;
  } else console.log(`release metadata: ${release.tagName} matches package and changelog`);
}
