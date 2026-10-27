// Reuses M0's proven offline Wrangler packaging safeguards. No upload path is provided.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
export async function offlinePackage(workerDir, configName, output) {
  assert.ok(['wrangler.toml','wrangler.f1.toml'].includes(configName));
// No production credentials or ambient .env input may participate in packaging.
for (let parent = workerDir; ; parent = dirname(parent)) {
  const names = await readdir(parent);
  assert.ok(!names.some(name => name === '.env' || name.startsWith('.env.') || name === '.dev.vars' || name.startsWith('.dev.vars.')), 'Unexpected dotenv input: stop without reading it');
  if (dirname(parent) === parent) break;
}
assert.equal(existsSync(join(workerDir, '.wrangler/deploy/config.json')), false, 'Generated config override must not redirect packaging');
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));

assert.equal(process.platform, 'darwin', 'This verifier requires macOS sandbox-exec; never fall back to an online build');
const bundleDir = join(output, 'bundle');
const homeDir = join(output, 'home');
const tempDir = join(output, 'tmp');
for (const dir of [bundleDir, homeDir, tempDir]) await mkdir(dir, { mode: 0o700 });
const attemptsPath = join(output, 'packaging-network-attempts.log');
const guardPath = join(output, 'deny-network.cjs');
// Defense in depth: the OS denies network for Wrangler and all its child processes.
// The Node guard also records attempted I/O even if a dependency catches the error.
await writeFile(guardPath, `
const fs = require('node:fs');
const denied = kind => (...args) => {
 fs.appendFileSync(${JSON.stringify(attemptsPath)}, kind + '\\n');
 throw new Error('Offline M0 packaging forbids network: ' + kind);
};
globalThis.fetch = denied('fetch');
for (const [name, methods] of Object.entries({http:['request','get'],https:['request','get'],net:['connect','createConnection'],tls:['connect']})) {
 const mod = require('node:' + name);
 for (const method of methods) mod[method] = denied(name + '.' + method);
}
require('node:net').Socket.prototype.connect = denied('socket.connect');
require('node:module').syncBuiltinESMExports();
`, { mode: 0o600 });
const sandboxPolicy = '(version 1)(allow default)(deny network*)';
const sandboxPath = join(output, 'offline.sb');
await writeFile(sandboxPath, sandboxPolicy + '\n', { mode: 0o600 });
const cleanEnv = {
  PATH: process.env.PATH, HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, 'config'), XDG_CACHE_HOME: join(homeDir, 'cache'),
  TMPDIR: tempDir, CI: 'true', NO_COLOR: '1', TZ: 'UTC', WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true',
  WRANGLER_LOG_PATH: join(output, 'wrangler.log'), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', NODE_OPTIONS: '--require=' + guardPath,
};
const metafilePath = join(output, 'metafile.json');
const command = [process.execPath, join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--outdir', bundleDir, '--metafile', metafilePath, '--config', join(workerDir, configName), '--keep-vars'];
assert.ok(command.includes('--dry-run'));
console.info(JSON.stringify({ output, phase: 'offline-wrangler-dry-run' }));
const packaged = spawnSync('/usr/bin/sandbox-exec', ['-f', sandboxPath, ...command], { cwd: workerDir, env: cleanEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
await writeFile(join(output, 'packaging.log'), (packaged.stdout || '') + (packaged.stderr || ''), { mode: 0o600 });
assert.equal(packaged.status, 0, 'Offline Wrangler dry-run failed; inspect packaging.log. Do not retry online.');
assert.match(packaged.stdout, /--dry-run: exiting now\./);
assert.doesNotMatch(packaged.stdout, /Current Version ID|^Uploaded |^Deployed /m);
const networkAttempts = existsSync(attemptsPath) ? (await readFile(attemptsPath, 'utf8')).trim().split('\n').filter(Boolean) : [];
assert.deepEqual(networkAttempts, [], 'Even attempted network I/O fails this verification');
const built = JSON.parse(await readFile(metafilePath, 'utf8'));
const artifact = join(bundleDir, configName === 'wrangler.toml' ? 'index.f0.js' : 'index.js');
const artifactBytes = await readFile(artifact);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifactText = artifactBytes.toString('utf8');
const ts = require('typescript');
const parsed = ts.createSourceFile('index.js', artifactText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const exportNames = parsed.statements.flatMap(node => ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map(e => e.name.text) : ts.isExportAssignment(node) ? ['default'] : []);
assert.deepEqual(exportNames, ['default'], 'No named business/RPC entrypoint may be exposed');
assert.ok(artifactText.includes(configName === 'wrangler.toml' ? 'MAINTENANCE' : 'CONFIRM_COLLECTION'));
assert.ok(!artifactText.includes('finance-local-only-secret'), 'Synthetic test bindings must not be bundled');
assert.ok(!artifactText.includes('/__test_only_m0_stats'), 'Test driver must not be bundled');
const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/,
  /(?:xkeysib-|sb_secret_)[A-Za-z0-9_-]{25,}/,
];
const bundleFiles = {};
for (const name of await readdir(bundleDir)) {
  const bytes = await readFile(join(bundleDir, name));
  bundleFiles[name] = hash(bytes);
  for (const pattern of credentialPatterns) assert.equal(pattern.test(bytes.toString('utf8')), false, 'Credential-shaped literal detected; never print the match');
}
// Verify the exact prebuilt/no-bundle command that the operator will use after approval.
const prebuiltDir = join(output, 'prebuilt-check');await mkdir(prebuiltDir,{mode:0o700});
const prebuiltCommand = [process.execPath, join(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', artifact, '--no-bundle', '--dry-run', '--outdir', prebuiltDir, '--config', join(workerDir,configName), '--keep-vars'];
const prebuilt = spawnSync('/usr/bin/sandbox-exec',['-f',sandboxPath,...prebuiltCommand],{cwd:workerDir,env:cleanEnv,encoding:'utf8',maxBuffer:8*1024*1024});
await writeFile(join(output,'prebuilt-packaging.log'),(prebuilt.stdout||'')+(prebuilt.stderr||''),{mode:0o600});
assert.equal(prebuilt.status,0,'Prebuilt packaging must succeed offline');
assert.match(prebuilt.stdout,/--dry-run: exiting now\./);
assert.equal(hash(await readFile(join(prebuiltDir,configName==='wrangler.toml'?'index.f0.js':'index.js'))),hash(artifactBytes),'Prebuilt bytes must stay identical');
assert.equal(existsSync(attemptsPath),false,'No packaging network attempt is allowed');
const sourceHashes = {};
const generatedInputs = [];
for (const input of Object.keys(built.inputs)) {
  const absolute = resolve(workerDir, input);
  const rel = relative(workerDir, absolute);
  if (absolute.startsWith(tempDir + '/')) { generatedInputs.push(input); continue; }
  assert.ok(!isAbsolute(rel) && !rel.startsWith('..'), `Build input outside isolated worktree: ${rel}`);
  if (rel.startsWith('node_modules/')) continue;
  assert.ok(rel.startsWith('src/'), `Unexpected source input: ${rel}`);
  assert.doesNotMatch(rel, /partTime|part_time/i);
  sourceHashes[rel] = hash(await readFile(absolute));
  assert.doesNotMatch(await readFile(absolute, 'utf8'), /LUGGAGE_PART_TIME_ACTORS_ENABLED|luggage_part_time_actors|partTimeActor/);
}

const configSha256 = hash(await readFile(join(workerDir, configName)));
const sourceSha256 = hash(JSON.stringify(Object.entries(sourceHashes).filter(([p]) => p !== 'wrangler.toml').sort(([a], [b]) => a.localeCompare(b))));
const packaging = {
  wranglerVersion: require('wrangler/package.json').version, nodeVersion: process.version, command,
  offlinePolicy: sandboxPolicy, isolatedHome: homeDir, inheritedCredentials: false, dotenvFilesRead: false,
  networkAttempts, generatedInputs, exportNames, bundleFiles, prebuiltCommand, prebuiltBytesIdentical: true, credentialPatternMatches: 0,
  secretCheckLimit: 'No real Secret was read or compared; checks establish input isolation and detect selected credential literal formats, not every possible hardcoded token.',
  config: { worker: 'int-center-luggage-api', d1: { name: 'DB', id: 'dfae11bb-0dd9-4e7c-be27-d6e98c7c3b77' }, r2: { name: 'IMAGES', bucket: 'luggage-images' }, workers_dev: true, preview_urls: false, compatibilityDate: '2025-04-01', compatibilityFlags: ['nodejs_compat'], route: 'luggage.flyingjp.com/*', crons: ['0 15 * * *', '0 18 * * *'], keepVars: true },
};


return { artifact, artifactSha256: hash(artifactBytes), sourceHashes, sourceSha256, configSha256, packaging };
}
