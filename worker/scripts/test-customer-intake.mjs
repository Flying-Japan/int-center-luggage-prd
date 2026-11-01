import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const temp = await mkdtemp(join(tmpdir(), 'luggage-customer-intake-tests-'));
try {
  const outputs = [];
  for (const name of ['customerIntakeDraft', 'customerIntakeRequests', 'customerGuestContract', 'customerRenewal', 'customerRenewalHardening']) {
    const output = join(temp, `${name}.test.cjs`);
    await build({ entryPoints: [`tests/${name}.test.ts`], outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
    outputs.push(output);
  }
  // Workers/SQLite datetime('now') use UTC; match that runtime when testing legacy receipts.
  const result = spawnSync(process.execPath, ['--test', ...outputs, 'tests/customerDraftCipher.test.mjs'], { stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
  process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
