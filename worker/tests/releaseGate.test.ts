import { test } from 'node:test';
import assert from 'node:assert/strict';
import f0 from '../src/index.f0';
import f1 from '../src/index';
import { readOnlyDatabase } from '../src/lib/financeReadOnly';
import { normalizeUnifiedWriteActor, resolveInternalActorStaff } from '../src/lib/internalActorStaff';
import { discoverRoutes, concretePath } from './helpers/m0.mjs';

const phase = process.env.FINANCE_RELEASE_TEST_PHASE || 'F0';
assert.ok(['F0', 'F1'].includes(phase));

test(`${phase}: actual fixed entry health and mode cannot be changed by env, cookies or headers`, async () => {
  const worker = phase === 'F0' ? f0 : f1;
  const pending: Promise<unknown>[] = [];
  const context = { waitUntil(p: Promise<unknown>) { pending.push(Promise.resolve(p)); }, passThroughOnException() {}, props: {} };
  const response = await worker.fetch(new Request('https://local.invalid/health?mode=F1', { headers: { 'x-maintenance-mode': 'F1', Cookie: 'mode=F1' } }),
    { MAINTENANCE_MODE: 'F1' } as never, context as never);
  await Promise.all(pending);
  assert.equal(response.status, 200);
  const body = await response.json() as { mode?: string; status: string };
  assert.equal(body.status, phase === 'F0' ? 'maintenance' : 'ok');
  if (phase === 'F0') assert.equal(body.mode, 'F0');
});

test('F0 blocks every mutation and all non-allowlisted GET before credentials, bindings, body and background work', async () => {
  let calls = 0;
  const poisoned = new Proxy({}, { get() { calls++; throw new Error('Unexpected capability access'); } });
  const paths = discoverRoutes(process.cwd());
  const reads = ['/internal/luggage-orders', '/internal/luggage-orders/dashboard-sync', '/internal/luggage-sales-analytics', '/internal/luggage-sales-heatmap', '/internal/luggage-cash-closings'];
  for (const { method, path } of paths) {
    if (method === 'GET' && (path === '/health' || reads.includes(path))) continue;
    const response = await f0.fetch(new Request('https://local.invalid' + concretePath(path), { method }), poisoned as never, poisoned as never);
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const cron of ['0 15 * * *', '0 18 * * *', 'unknown']) await f0.scheduled({ cron } as never, poisoned as never, poisoned as never);
  assert.equal(calls, 0);
});

test('F0 signed-read endpoints still require HMAC; an unsigned read cannot reach D1', async () => {
  let calls = 0;
  const response = await f0.fetch(new Request('https://local.invalid/internal/luggage-orders'),
    { INTERNAL_API_SECRET: 'local-only', DB: new Proxy({}, { get() { calls++; throw new Error('D1 before auth'); } }) } as never, {} as never);
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('F0 D1 capability rejects DML, WITH writes, returning, multiple statements, DDL, batches and background execution', async () => {
  let prepared = 0;
  const stmt = { bind() { return this; }, async first() { return { n: 1 }; }, async all() { return { results: [] }; }, async raw() { return []; } };
  const db = readOnlyDatabase({ prepare() { prepared++; return stmt; } } as never);
  assert.deepEqual(await db.prepare('WITH x AS (SELECT 1 AS n) SELECT n FROM x').bind().first(), { n: 1 });
  for (const sql of ['INSERT INTO t VALUES(1) RETURNING *', 'WITH x AS (SELECT 1) DELETE FROM t RETURNING *', 'SELECT 1; UPDATE t SET a=2', 'PRAGMA writable_schema=ON', 'CREATE TABLE x(a)', 'SELECT 1; ATTACH DATABASE x AS y']) {
    assert.throws(() => db.prepare(sql), /F0_READ_ONLY/);
  }
  assert.throws(() => db.prepare('SELECT 1').run(), /F0_READ_ONLY/);
  assert.throws(() => db.batch([]), /F0_READ_ONLY/);
  assert.throws(() => db.exec('SELECT 1'), /F0_READ_ONLY/);
  assert.equal(prepared, 2);
});

test('general part-time actors still require valid shape and an explicit write switch; F0 remains read-only', async () => {
  const actor = normalizeUnifiedWriteActor({ userId: '11111111-1111-4111-8111-111111111111', name: 'Synthetic', email: 'synthetic@part-time.local', role: 'part_time' });
  assert.deepEqual(await resolveInternalActorStaff({} as never, actor, 'handover.create'), { ok: false, status: 403, error: 'Part-time actors are not enabled' });
  assert.throws(() => normalizeUnifiedWriteActor({ ...actor, userId: 'invalid' }), /lowercase UUID/);
});
