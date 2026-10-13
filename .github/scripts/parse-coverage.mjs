import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseCoverage(text) {
  // Node's built-in test coverage table has an "all files" summary row.
  const match = String(text).match(/^\s*[#ℹ]?\s*all files\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)/m);
  if (!match) return null;
  const [line, branch, functionPct] = match.slice(1).map(Number);
  if ([line, branch, functionPct].some((n) => n < 0 || n > 100 || !Number.isFinite(n))) return null;
  return { line, branch, function: functionPct, source: 'node --test --experimental-test-coverage', thresholdsEnforced: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metrics = parseCoverage(fs.readFileSync(process.argv[2], 'utf8'));
  if (!metrics) {
    console.error('no aggregate Node coverage row found in test output; inspect coverage-summary.txt');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(process.argv[3] || 'coverage-summary.json', JSON.stringify(metrics, null, 2) + '\n');
    console.log('coverage baseline: ' + JSON.stringify(metrics));
  }
}
