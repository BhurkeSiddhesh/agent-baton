import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUDGET, inspectFootprint, summarizeStartup, measureStartup } from '../.github/scripts/offline-core-metrics.mjs';

test('actual package metrics report size and reject invalid and bloated archives', () => {
  const e = { files:[{path:'bin/baton.js'}, {path:'LICENSE'}], size: 10000, unpackedSize: 20000 };
  assert.deepEqual(inspectFootprint(e).problems, []);
  assert.equal(inspectFootprint(e).files, 2);
  assert.equal(inspectFootprint({...e,size:BUDGET.archiveBytes + 1}).problems.length, 1);
  assert.equal(inspectFootprint({...e,unpackedSize:BUDGET.unpackedBytes + 1}).problems.length, 1);
  for (const invalid of [null,{}, {...e,size:-1}, {...e,unpackedSize:Infinity}]) assert.ok(inspectFootprint(invalid).problems.length);
});

test('p95 cold startup summary measures without hiding failures', () => {
  assert.equal(summarizeStartup([1,3,2,5,4]).p95Ms,5);
  assert.deepEqual(summarizeStartup([1,2,3],3).problems, []);
  assert.equal(summarizeStartup([1,2,3],2).problems.length,1);
  for (const invalid of [[],[-1],[NaN]]) assert.ok(summarizeStartup(invalid).problems.length);
});

test('CLI version runs with Node network activity denied', () => {
  const binary = fileURLToPath(new URL('../bin/baton.js',import.meta.url));
  const shim = fileURLToPath(new URL('../.github/scripts/deny-network.mjs',import.meta.url));
  const run = spawnSync(process.execPath,['--import',shim,binary,'version'],{encoding:'utf8',timeout:5000});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout, /baton|0\.1\.0/i);
  assert.deepEqual(measureStartup(binary,1).problems,[]);
});

test('CI checks actual offline package and publishes footprint diagnostics', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job = ci.split(/^  package:\s*$/m)[1].split(/^  smoke:\s*$/m)[0];
  assert.ok(job.indexOf('validate-package.mjs') < job.indexOf('offline-core-metrics.mjs'));
  assert.match(job, /offline-core-metrics\.json/);
  assert.match(job, /npm install --offline/);
  assert.match(job, /deny-network\.mjs/);
});
