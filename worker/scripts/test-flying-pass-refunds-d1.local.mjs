#!/usr/bin/env node
// Fresh Miniflare/workerd D1 only. Never loads Wrangler config, .env, existing databases or remote bindings.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
assert.deepEqual(process.argv.slice(2), ['--run-local'], 'Usage: node scripts/test-flying-pass-refunds-d1.local.mjs --run-local');
assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22+ required');
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
const temp = await mkdtemp(join(tmpdir(), 'luggage-refund-tests-'));
try {
  const bundle = join(temp, 'flyingPassRefunds.test.cjs');
  await build({ entryPoints: [join(workerDir, 'tests/flyingPassRefunds.test.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const result = spawnSync(process.execPath, ['--test', bundle], { cwd: workerDir, stdio: 'inherit',
    env: { ...process.env, REFUND_TEST_MINIFLARE_PATH: wranglerRequire.resolve('miniflare') } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
