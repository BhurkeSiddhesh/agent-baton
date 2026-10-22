// Fail closed on missing, failed, cancelled or skipped required CI jobs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CI_JOBS = Object.freeze(['test', 'unit', 'integration', 'security', 'package', 'smoke', 'docs']);

export function evaluateRequiredResults(results) {
  if (!Array.isArray(results) || results.length !== REQUIRED_CI_JOBS.length) {
    return { ok: false, failed: ['expected ' + REQUIRED_CI_JOBS.length + ' job results'] };
  }
  const failed = results.flatMap((value, index) =>
    value === 'success' ? [] : [REQUIRED_CI_JOBS[index] + '=' + (value || '(missing)')]);
  return { ok: failed.length === 0, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = evaluateRequiredResults(process.argv.slice(2));
  if (!verdict.ok) {
    console.error('branch protection blocked: ' + verdict.failed.join(', '));
    process.exitCode = 1;
  } else {
    console.log('All required CI jobs passed for ' + (process.env.GITHUB_SHA || 'local execution') + '.');
  }
}
