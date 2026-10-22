import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Protective ceilings, not representative user benchmarks.
export const BUDGET = Object.freeze({
  archiveBytes: 10 * 1024 * 1024, unpackedBytes: 50 * 1024 * 1024, startupP95Ms: 3000,
});

export function inspectFootprint(entry, budget = BUDGET) {
  if (!entry || !Array.isArray(entry.files) || !Number.isFinite(entry.size) ||
      !Number.isFinite(entry.unpackedSize) || entry.size < 0 || entry.unpackedSize < 0) {
    return { problems: ['missing or invalid pack sizes'], archiveBytes: null, unpackedBytes: null, files: 0 };
  }
  const problems = [];
  if (entry.size > budget.archiveBytes) problems.push('archive exceeds core budget');
  if (entry.unpackedSize > budget.unpackedBytes) problems.push('unpacked package exceeds core budget');
  return { archiveBytes: entry.size, unpackedBytes: entry.unpackedSize, files: entry.files.length, problems };
}

export function summarizeStartup(samples, limitMs = BUDGET.startupP95Ms) {
  if (!Array.isArray(samples) || !samples.length || samples.some(x => !Number.isFinite(x) || x < 0)) {
    return { samplesMs: [], p95Ms: null, problems: ['invalid startup measurements'] };
  }
  const ordered = [...samples].sort((a,b) => a-b);
  const p95Ms = ordered[Math.ceil(samples.length * 0.95) - 1];
  return { samplesMs: samples, p95Ms, problems: p95Ms > limitMs ? ['CLI startup exceeds core budget'] : [] };
}

export function measureStartup(binary, iterations = 5) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [binary, 'version'], { encoding:'utf8', timeout: 5000, windowsHide: true });
    const elapsed = Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
    if (result.error || result.status !== 0) throw new Error('CLI startup failed: ' + (result.error?.message || result.stderr || result.status));
    samples.push(elapsed);
  }
  return summarizeStartup(samples);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2] || 'pack.json', 'utf8'));
  const footprint = inspectFootprint(Array.isArray(manifest) && manifest.length === 1 ? manifest[0] : null);
  const startup = measureStartup(fileURLToPath(new URL('../../bin/baton.js', import.meta.url)));
  const report = { budgets: BUDGET, footprint, startup };
  fs.writeFileSync(process.argv[3] || 'offline-core-metrics.json', JSON.stringify(report, null, 2) + '\n');
  console.log('offline core metrics: ' + JSON.stringify(report));
  if (footprint.problems.length || startup.problems.length) {
    console.error('offline core budget exceeded');
    process.exitCode = 1;
  }
}
