import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
// Reuse Wrangler's installed bundler without adding runtime dependencies.
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const temp = await mkdtemp(join(tmpdir(), 'luggage-tests-'));
try {
  const output = join(temp, 'experience.test.cjs');
  await build({ entryPoints: ['tests/experience.test.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node22' });
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(temp, { recursive: true, force: true }); }
