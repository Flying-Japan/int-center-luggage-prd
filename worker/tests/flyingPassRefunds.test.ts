import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { createFlyingPassRefundRoutes } from '../src/routes/flyingPassRefunds';
import internalApi from '../src/routes/internalApi';
import { internalAuth } from '../src/middleware/internalAuth';
import { signInternalRequest } from '../src/lib/hmac';
import { writePickupTransition } from '../src/services/orderPickupWrites';
import { getBillingSummary, confirmCollection } from '../src/services/luggageBilling';
import { getDashboardSyncToken } from '../src/lib/dashboardSync';
import opsRoutes from '../src/routes/operations';
import { resolveAutoSalesSummaryForDate } from '../src/services/cashClosingSales';
import { finishFlyingPassRefund } from '../src/services/flyingPassRefunds';

const ID = '20261028-001', SECRET = 'synthetic-refund-tests-only';
const actor = { userId: 'unified-test-editor', name: 'Synthetic Editor', email: 'editor@example.test', role: 'center_staff' };
const profile = { id: '11111111-1111-4111-8111-111111111111', display_name: 'Synthetic Editor', email: actor.email, role: 'editor', is_active: true };
const staffB = { userId: 'unified-test-editor-b', name: 'Synthetic Editor B', email: 'editor-b@example.test', role: 'center_staff' };
const profileB = { id: '33333333-3333-4333-8333-333333333333', display_name: 'Synthetic Editor B', email: staffB.email, role: 'editor', is_active: true };
const partTime = { userId: 'abcdef22-2222-4222-8222-2222222222ab', name: 'Synthetic Part Time', email: 'pt-synthetic@part-time.local', role: 'part_time' };
const manager = { userId: 'unified-test-manager', name: 'Synthetic Manager', email: 'manager@example.test', role: 'manager' };
const profileM = { id: '44444444-4444-4444-8444-444444444444', display_name: 'Synthetic Manager', email: manager.email, role: 'admin', is_active: true };
const superAdmin = { userId: 'unified-test-super', name: 'Synthetic Super', email: 'super@example.test', role: 'super_admin' };
const profileS = { id: '55555555-5555-4555-8555-555555555555', display_name: 'Synthetic Super', email: superAdmin.email, role: 'admin', is_active: true };
const staffIdOf = (who: { userId: string; role: string }) => who.role === 'part_time' ? `pt:${who.userId}` : who === staffB ? profileB.id : who === manager ? profileM.id : who === superAdmin ? profileS.id : profile.id;
const originalFetch = globalThis.fetch;
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { globalThis.fetch = originalFetch; for (const fn of cleanup.splice(0)) await fn(); });
const schema = readFileSync('src/schema.sql', 'utf8');
// Historical migration contract excludes the later, independently tested bag-addition upgrade.
const preBagSchema = schema.split('-- Additional bags after payment;')[0];
const migration = readFileSync('migrations/20261028_flying_pass_refunds.sql', 'utf8');
const settlementMigration = readFileSync('migrations/20261028_flying_pass_refund_settlement.sql', 'utf8');
const handoverMigration = readFileSync('migrations/20261029_flying_pass_refund_handover.sql', 'utf8');
const phase1Schema = schema.slice(0, schema.indexOf('-- Flying Pass phase 2:'));
// schema.sql carries the refund block in its post-handover form (in place); strip that block to get the pre-refund base.
const refundBlockStart = phase1Schema.indexOf(migration.slice(0, migration.indexOf('\n')));
const refundBlockEnd = phase1Schema.indexOf('END;\n', phase1Schema.indexOf('luggage_refund_phase1_closing_update', refundBlockStart)) + 5;
assert.ok(refundBlockStart > 0 && refundBlockEnd > refundBlockStart);
const preRefundSchema = phase1Schema.slice(0, refundBlockStart) + phase1Schema.slice(refundBlockEnd);
// Reuse the existing, tested local-D1 SQL splitter, including trigger and CASE nesting.
const splitter = readFileSync('scripts/verify-d1-pickup.local.mjs', 'utf8');
const start = splitter.indexOf('function sqlTokens('), end = splitter.indexOf('function canonicalSqlTokens(');
assert.ok(start >= 0 && end > start);
const splitSql: (sql: string) => string[] = new Function(splitter.slice(start, end) + '\nreturn splitSql;')();
const day = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

async function setup(options: { status?: string; manual?: number | null; receipts?: Array<[string, number]>; amount?: number; method?: string; originalTier?: string; days?: number; discount?: number; migrate?: boolean; handover?: boolean } = {}) {
  const compiled = new DatabaseSync(':memory:');
  const base = options.migrate ? preRefundSchema : schema;
  const migrations = [migration, settlementMigration, ...(options.handover === false ? [] : [handoverMigration])];
  let db: D1Database;
  if (process.env.REFUND_TEST_MINIFLARE_PATH) {
    compiled.close();
    const modulePath = process.env.REFUND_TEST_MINIFLARE_PATH;
    const { Miniflare } = createRequire(modulePath)(modulePath);
    const rootPath = await mkdtemp(join(tmpdir(), 'luggage-refund-d1-'));
    const mf = new Miniflare({ rootPath, name: 'refund-local-only', modules: true, host: '127.0.0.1', port: 0,
      compatibilityDate: '2025-04-01', script: 'export default { fetch() { return new Response("local D1 test only"); } };',
      d1Databases: { DB: 'refund-local-only' }, d1Persist: false,
      outboundService() { throw new Error('No external requests allowed'); },
    });
    cleanup.push(async () => { await mf.dispose(); await rm(rootPath, { recursive: true, force: true }); });
    db = await mf.getD1Database('DB');
    for (const sql of splitSql(base)) await db.prepare(sql).run();
    if (options.migrate) for (const sql of migrations.flatMap(splitSql)) await db.prepare(sql).run();
  } else {
    compiled.exec(base);
    if (options.migrate) for (const sql of migrations) compiled.exec(sql);
    cleanup.push(() => compiled.close());
    const statement = (sql: string) => {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { assert.ok(values.length <= 100); args = values; return this; },
        async run() { const results = compiled.prepare(sql).all(...args as never[]); return { results, success: true, meta: { changes: (compiled.prepare('SELECT changes() AS n').get() as { n: number }).n } }; },
        async all() { return { results: compiled.prepare(sql).all(...args as never[]) }; },
        async first() { return compiled.prepare(sql).get(...args as never[]) ?? null; },
      };
    };
    let queue = Promise.resolve();
    const adapter = { prepare: statement, batch(statements: ReturnType<typeof statement>[]) {
      const next = queue.then(async () => { compiled.exec('BEGIN'); try { const rows = []; for (const s of statements) rows.push(await s.run()); compiled.exec('COMMIT'); return rows; } catch (e) { compiled.exec('ROLLBACK'); throw e; } });
      queue = next.then(() => undefined, () => undefined); return next;
    } };
    db = adapter as unknown as D1Database;
  }
  // Existing operational closing columns are outside the historical base schema, as in cashClosing.test.ts.
  await db.prepare('ALTER TABLE luggage_cash_closings ADD COLUMN rental_cash INTEGER DEFAULT 0').run();
  await db.prepare('ALTER TABLE luggage_cash_closings ADD COLUMN wand_refund INTEGER DEFAULT 0').run();
  const amount = options.amount ?? 1600;
  await db.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, expected_storage_days, price_per_day, suitcase_qty,
    prepaid_amount, final_amount, status, payment_method, staff_prepaid_override_amount, flying_pass_tier, flying_pass_discount_amount)
    VALUES (?, datetime('now'), '2099-01-01T12:00:00Z', ?, 800, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ID, options.days ?? 2, amount, amount, options.status ?? 'PAID', options.method ?? 'CASH', options.manual ?? null, options.originalTier ?? 'NONE', options.discount ?? 0).run();
  for (const [tender, value] of options.receipts ?? [['CASH', amount]]) {
    await db.prepare('INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount) VALUES (?, ?, ?, ?)').bind(ID, day(), tender, value).run();
  }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input instanceof Request ? input.url : input), /^https:\/\/supabase.test\/rest\/v1\/user_profiles/);
    return Response.json([profile, profileB, profileM, profileS]);
  }) as typeof fetch;
  const app = new Hono().use('/internal/*', internalAuth).route('/', createFlyingPassRefundRoutes(true));
  const env: Record<string, unknown> = { DB: db, INTERNAL_API_SECRET: SECRET, APP_ENV: 'test', LUGGAGE_FLYING_PASS_REFUNDS_ENABLED: 'true', LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED: 'true', SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key' };
  async function call(operation: string, payload: Record<string, unknown> = {}, targetApp = app, urlOrder = ID, signed = true) {
    const url = `https://luggage.test/internal/luggage-orders/${urlOrder}/flying-pass-refunds/${operation}`;
    const body = JSON.stringify({ actor, ...payload }), timestamp = String(Math.floor(Date.now() / 1000));
    const { signature } = await signInternalRequest({ secret: SECRET, method: 'POST', url, timestamp, body });
    const response = await targetApp.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signed ? { 'x-internal-timestamp': timestamp, 'x-internal-signature': signature } : {}) }, body }, env);
    return { status: response.status, body: await response.json() as any };
  }
  async function reserve(tier = 'GOLD', refundId = crypto.randomUUID(), by: Record<string, string> = actor) {
    const preview = await call('preview', { targetTier: tier, actor: by });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const input = { refundId, targetTier: tier, reason: '카페 등급 확인 후 현금 환급', expectedFingerprint: preview.body.quote.fingerprint };
    return { input, result: await call('register', { ...input, actor: by }) };
  }
  const scalar = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).first<{ n: number }>())!.n;
  const original = async () => JSON.stringify((await db.batch([db.prepare('SELECT * FROM luggage_orders ORDER BY order_id'), db.prepare('SELECT * FROM luggage_order_payments ORDER BY payment_id')])).map(r => r.results));
  return { db, app, env, call, reserve, scalar, original };
}

for (const receipts of [[['CASH', 1600]], [['PAY_QR', 1600]], [['CASH', 800], ['PAY_QR', 800]]] as Array<Array<[string, number]>>) {
  test(`cash-only refund preserves original ${receipts.map(r => r[0]).join('+')} receipts, prices and status`, async () => {
    const s = await setup({ receipts, method: receipts.length === 2 ? 'MIXED' : receipts[0][0], migrate: true });
    const before = await s.original();
    const { input, result } = await s.reserve();
    assert.equal(result.status, 201);
    assert.equal(result.body.refund.amount, 400);
    assert.equal(result.body.refund.refund_method, 'CASH');
    assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 200);
    assert.equal(await s.original(), before);
    assert.equal(await s.scalar('SELECT SUM(amount) AS n FROM luggage_flying_pass_refunds WHERE status = \'CONFIRMED\''), 400);
    assert.equal(await s.scalar('SELECT SUM(total_amount) AS n FROM luggage_sales_daily'), 1200, 'phase 2 recognizes confirmed cash payout once');
  });
}

test('incremental BLUE → GOLD refunds pay only the additional discount; no repeated or downward payout', async () => {
  const s = await setup();
  for (const tier of ['BLUE', 'GOLD']) {
    const { input, result } = await s.reserve(tier);
    assert.equal(result.status, 201);
    assert.equal(result.body.refund.amount, 200);
    assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 200 })).status, 200);
  }
  assert.equal(await s.scalar("SELECT SUM(amount) AS n FROM luggage_flying_pass_refunds WHERE status='CONFIRMED'"), 400);
  for (const tier of ['GOLD','BLUE']) assert.equal((await s.call('preview', { targetTier: tier })).body.code, 'NO_REFUND_DUE');
});

test('BLACK refunds all remaining principal; long-stay and existing initial tier use pricing.ts', async () => {
  const s = await setup({ days: 7, amount: 5120, originalTier: 'BLUE', discount: 200 });
  const gold = await s.reserve('GOLD');
  assert.equal(gold.result.body.refund.amount, 200);
  assert.equal((await s.call(`${gold.input.refundId}/confirm`, { cashPaid: true, expectedAmount: 200 })).status, 200);
  const black = await s.reserve('BLACK');
  assert.equal(black.result.body.refund.amount, 4920);
  assert.equal((await s.call(`${black.input.refundId}/confirm`, { cashPaid: true, expectedAmount: 4920 })).status, 200);
});

test('stable refund ID recovers a lost registration/confirmation response, including after flag OFF', async () => {
  const s = await setup();
  const { input } = await s.reserve();
  assert.equal((await s.call('register', input)).body.replayed, true);
  assert.equal((await s.call('register', { ...input, reason: '다른 요청' })).status, 409);
  await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }); // discard the response
  s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'false';
  const lookup = await s.call(`${input.refundId}/lookup`);
  assert.equal(lookup.body.refund.status, 'CONFIRMED');
  assert.match(lookup.body.instruction, /다시 지급하지/);
  const again = await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 });
  assert.equal(again.body.replayed, true);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action='FLYING_PASS_REFUND_CONFIRM'"), 1);
});

test('simultaneous registrations: different IDs permit one pending payout; same-ID confirmations are idempotent', async () => {
  const s = await setup();
  const q = (await s.call('preview', { targetTier: 'GOLD' })).body.quote;
  const inputs = Array.from({ length: 3 }, () => ({ refundId: crypto.randomUUID(), targetTier: 'GOLD', reason: '동시 요청', expectedFingerprint: q.fingerprint }));
  const responses = await Promise.all(inputs.map(i => s.call('register', i)));
  assert.equal(responses.filter(r => r.status === 201).length, 1);
  assert.ok(responses.every(r => [201,409].includes(r.status)), JSON.stringify(responses));
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 1);
  const winner = responses.find(r => r.status === 201)!.body.refund.refund_id;
  const confirms = await Promise.all([1,2,3].map(() => s.call(`${winner}/confirm`, { cashPaid: true, expectedAmount: 400 })));
  assert.ok(confirms.every(r => r.status === 200), JSON.stringify(confirms));
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action='FLYING_PASS_REFUND_CONFIRM'"), 1);
});

test('simultaneous same-ID registrations return one saved operation', async () => {
  const s = await setup(); const q = (await s.call('preview', { targetTier: 'GOLD' })).body.quote;
  const input = { refundId: crypto.randomUUID(), targetTier: 'GOLD', reason: '동일 요청', expectedFingerprint: q.fingerprint };
  const res = await Promise.all([s.call('register', input), s.call('register', input)]);
  assert.ok(res.every(r => [200,201].includes(r.status)), JSON.stringify(res));
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 1);
});

for (const action of ['REGISTER','CONFIRM','CANCEL']) {
  test(`${action} audit failure rolls back state and audit, retry succeeds`, async () => {
    const s = await setup();
    const pending = action === 'REGISTER' ? null : await s.reserve();
    const q = action === 'REGISTER' ? (await s.call('preview', { targetTier: 'GOLD' })).body.quote : null;
    const id = pending?.input.refundId ?? crypto.randomUUID();
    const operation = action === 'REGISTER' ? 'register' : `${id}/${action.toLowerCase()}`;
    const body = action === 'REGISTER' ? { refundId: id, targetTier: 'GOLD', reason: '감사 검증', expectedFingerprint: q.fingerprint }
      : action === 'CONFIRM' ? { cashPaid: true, expectedAmount: 400 } : { confirmNotPaid: true, reason: '현금 미지급 확인' };
    const before = await s.original();
    await s.db.prepare(`CREATE TRIGGER fail_refund_audit BEFORE INSERT ON luggage_audit_logs WHEN NEW.action = 'FLYING_PASS_REFUND_${action}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`).run();
    assert.equal((await s.call(operation, body)).status, 500);
    assert.equal(await s.scalar(`SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'FLYING_PASS_REFUND_${action}'`), 0);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), action === 'REGISTER' ? 0 : 1);
    if (pending) assert.equal((await s.call(`${id}/lookup`)).body.refund.status, 'PAYOUT_PENDING');
    assert.equal(await s.original(), before);
    await s.db.prepare('DROP TRIGGER fail_refund_audit').run();
    assert.ok([200,201].includes((await s.call(operation, body)).status));
  });
}

test('silent state-write IGNORE rolls back the newly inserted audit', async () => {
  const s = await setup(); const { input } = await s.reserve();
  await s.db.prepare("CREATE TRIGGER ignore_refund BEFORE UPDATE ON luggage_flying_pass_refunds BEGIN SELECT RAISE(IGNORE); END").run();
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 500);
  assert.equal((await s.call(`${input.refundId}/lookup`)).body.refund.status, 'PAYOUT_PENDING');
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action='FLYING_PASS_REFUND_CONFIRM'"), 0);
});

test('cancel requires explicit non-payment and a reason; terminal cancellation cannot be confirmed', async () => {
  const s = await setup(); const { input } = await s.reserve();
  assert.equal((await s.call(`${input.refundId}/cancel`, { reason: '미지급' })).status, 400);
  assert.equal((await s.call(`${input.refundId}/cancel`, { confirmNotPaid: true, reason: ' ' })).status, 400);
  const payload = { confirmNotPaid: true, reason: '실제 현금 미지급 확인' };
  assert.equal((await s.call(`${input.refundId}/cancel`, payload)).body.refund.status, 'CANCELLED');
  assert.equal((await s.call(`${input.refundId}/cancel`, payload)).body.replayed, true);
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 409);
  assert.equal((await s.reserve()).result.status, 201, 'a new ID can reserve after non-payment cancellation');
});

test('original receipts, pricing/status, confirmed row and audit cannot be changed through SQL bypasses', async () => {
  const s = await setup(); const { input } = await s.reserve();
  for (const sql of ["UPDATE luggage_orders SET flying_pass_tier='GOLD'", "UPDATE luggage_orders SET expected_storage_days=3", "UPDATE luggage_orders SET status='PAYMENT_PENDING'", "UPDATE luggage_orders SET final_amount=1200", "DELETE FROM luggage_order_payments", "UPDATE luggage_order_payments SET amount=1400", "UPDATE luggage_order_payments SET order_id='other'", "DELETE FROM luggage_orders", "DELETE FROM luggage_flying_pass_refunds"]) await assert.rejects(s.db.prepare(sql).run(), undefined, sql);
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 200);
  for (const sql of ["UPDATE luggage_flying_pass_refunds SET status='CANCELLED'", "UPDATE luggage_flying_pass_refunds SET amount=1", "DELETE FROM luggage_flying_pass_refunds", "UPDATE luggage_audit_logs SET details='{}'", "DELETE FROM luggage_audit_logs", `INSERT INTO luggage_cash_closings(business_date, closing_type) VALUES ('${day()}', 'FINAL_CLOSE')`]) await assert.rejects(s.db.prepare(sql).run(), undefined, sql);
});

test('unpaid extensions block refunds, paid extensions retain full charges and child requests are refused', async () => {
  const s = await setup();
  await s.db.prepare(`INSERT INTO luggage_orders(order_id,parent_order_id,created_at,expected_pickup_at,expected_storage_days,price_per_day,prepaid_amount,final_amount,status)
    VALUES ('EXT-20261028-002', ?, datetime('now'), '2099-01-02T12:00:00Z', 1, 800, 800, 800, 'PAYMENT_PENDING')`).bind(ID).run();
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).body.code, 'OUTSTANDING');
  await confirmCollection(s.db, ID, profile.id, { request_id: crypto.randomUUID(), confirm_received: 'yes', expected_amount: 800, cash_amount: 800, qr_amount: 0 });
  assert.equal((await s.call('preview', { targetTier: 'GOLD' }, s.app, 'EXT-20261028-002')).status, 400);
  const before = await s.original(), pending = await s.reserve();
  assert.equal(pending.result.body.refund.amount, 400);
  assert.equal((await s.call(`${pending.input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 200);
  assert.equal(await s.original(), before);
});

for (const [name, options] of [
  ['no receipts', { receipts: [] }], ['manual amount', { manual: 1600 }], ['pending status', { status: 'PAYMENT_PENDING' }],
  ['collected mismatch', { receipts: [['CASH', 1500]] }], ['unknown original price', { amount: 1500 }],
  ['no storage days', { days: 0 }], ['cancelled', { status: 'CANCELLED' }],
] as const) {
  test(`eligibility blocks ${name}`, async () => {
    const s = await setup(options as Parameters<typeof setup>[0]);
    assert.equal((await s.call('preview', { targetTier: 'GOLD' })).status, 409);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 0);
  });
}

test('past payment-day closing is preserved; payout-day closing blocks preview/reserve', async () => {
  const s = await setup();
  await s.db.prepare("UPDATE luggage_order_payments SET business_date=date('now','+9 hours','-1 day'), recorded_at=datetime('now','-1 day')").run();
  await s.db.prepare("INSERT INTO luggage_cash_closings(business_date, closing_type, total_amount) VALUES (date('now','+9 hours','-1 day'),'FINAL_CLOSE',41600)").run();
  const q = (await s.call('preview', { targetTier: 'GOLD' })).body.quote;
  assert.equal(q.amount, 400);
  await s.db.prepare("INSERT INTO luggage_cash_closings(business_date, closing_type) VALUES (?,'FINAL_CLOSE')").bind(day()).run();
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).body.code, 'CLOSING_CLOSED');
  assert.equal((await s.call('register', { refundId: crypto.randomUUID(), targetTier: 'GOLD', reason: '마감 경합', expectedFingerprint: q.fingerprint })).body.code, 'CLOSING_CLOSED');
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 0);
});

test('confirm revalidates exact amount, actual payout acknowledgement and JST day', async () => {
  const s = await setup(); const { input } = await s.reserve();
  for (const payload of [{ cashPaid: false, expectedAmount: 400 }, { expectedAmount: 400 }]) assert.equal((await s.call(`${input.refundId}/confirm`, payload)).status, 400);
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 399 })).body.code, 'AMOUNT_CHANGED');
  await assert.rejects(finishFlyingPassRefund(s.db, ID, input.refundId, { action: 'confirm', cashPaid: true, expectedAmount: 400 }, {
    actor, staff: { id: profile.id, displayName: profile.display_name, email: profile.email, role: 'editor' },
  }, new Date(Date.now()+86400000)), /지급일/);
});

test('production mount: new payouts default OFF, flag ON opens them, recovery lookup is not flag-gated', async () => {
  const s = await setup(); const productionMount = new Hono().route('/', internalApi);
  s.env.APP_ENV = 'production'; delete (s.env as Record<string, unknown>).LUGGAGE_FLYING_PASS_REFUNDS_ENABLED;
  for (const op of ['preview', 'register'] as const) assert.equal((await s.call(op, { targetTier: 'GOLD' }, productionMount)).body.code, 'REFUNDS_DISABLED');
  const lookup = await s.call(`${crypto.randomUUID()}/lookup`, {}, productionMount);
  assert.ok(![503, 401].includes(lookup.status), `lookup must reach the handler, got ${lookup.status}`);
  s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'true';
  assert.ok((await s.call('preview', { targetTier: 'GOLD' }, productionMount)).body.quote, 'flag ON opens preview on the production mount');
  s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'false';
  assert.equal((await s.call('preview', { targetTier: 'GOLD' }, productionMount)).body.code, 'REFUNDS_DISABLED');
});

test('production mount keeps HMAC, the actor role allowlist, one-pending-refund and replay protection when the flag is ON', async () => {
  const s = await setup(); const productionMount = new Hono().route('/', internalApi);
  s.env.APP_ENV = 'production'; s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'true'; delete s.env.LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED;
  const refundId = crypto.randomUUID();
  for (const op of ['preview', 'register', `${refundId}/lookup`, `${refundId}/confirm`, `${refundId}/cancel`]) assert.equal((await s.call(op, {}, productionMount, ID, false)).status, 401, `unsigned ${op}`);
  // part_time stays refused on the production mount until LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED is set.
  for (const [op, payload] of [['preview', { targetTier: 'GOLD' }], [`${refundId}/lookup`, {}], [`${refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }], [`${refundId}/cancel`, { confirmNotPaid: true, reason: '테스트' }]] as Array<[string, Record<string, unknown>]>)
    assert.equal((await s.call(op, { ...payload, actor: partTime }, productionMount)).status, 403, `part_time ${op}`);
  const preview = await s.call('preview', { targetTier: 'GOLD' }, productionMount);
  const input = { refundId, targetTier: 'GOLD', reason: '카페 가입·등급 확인', expectedFingerprint: preview.body.quote.fingerprint };
  assert.equal((await s.call('register', input, productionMount)).status, 201);
  assert.equal((await s.call('register', input, productionMount)).body.replayed, true, 'same refund ID replays instead of registering twice');
  const second = await s.call('register', { ...input, refundId: crypto.randomUUID() }, productionMount);
  assert.notEqual(second.status, 201, 'a second payout for the same order while one is pending is refused');
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 1);
  s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'false'; // confirm is recovery: not gated by the flag
  assert.equal((await s.call(`${refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }, productionMount)).status, 200);
  assert.equal((await s.call(`${refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }, productionMount)).body.replayed, true);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED'"), 1);
});

test('test-only router refuses outside APP_ENV=test; local default flag OFF, HMAC and staff verification enforced', async () => {
  const s = await setup();
  s.env.APP_ENV = 'production';
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).body.code, 'REFUND_SETTLEMENT_NOT_READY');
  s.env.APP_ENV = 'test'; s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = '';
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).body.code, 'REFUNDS_DISABLED');
  s.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED = 'true';
  assert.equal((await s.call('preview', { targetTier: 'GOLD' }, s.app, ID, false)).status, 401);
  globalThis.fetch = (async () => Response.json([{ ...profile, role: 'viewer' }])) as typeof fetch;
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).status, 403);
  globalThis.fetch = (async () => Response.json({ message: 'down' }, { status: 500 })) as typeof fetch;
  assert.equal((await s.call('preview', { targetTier: 'GOLD' })).status, 503);
});

test('invalid input cannot choose non-cash tender, amount, arbitrary actor or bypass preview', async () => {
  const s = await setup(); const q = (await s.call('preview', { targetTier: 'GOLD' })).body.quote;
  const base = { refundId: crypto.randomUUID(), targetTier: 'GOLD', reason: '검증', expectedFingerprint: q.fingerprint };
  for (const delta of [{ refundMethod: 'PAY_QR' }, { amount: 1 }, { reason: '' }, { targetTier: 'gold' }, { expectedFingerprint: '0'.repeat(64) }]) {
    assert.ok([400,409].includes((await s.call('register', { ...base, ...delta })).status));
  }
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds'), 0);
});

test('fresh schema and one-time migration create identical refund tables, indexes and guards', async () => {
  const fresh = new DatabaseSync(':memory:'), upgrade = new DatabaseSync(':memory:');
  try {
    // Real order: refunds → settlement → handover (handover also replaces the paid-day sales view and two closing triggers).
    fresh.exec(preBagSchema); upgrade.exec(preRefundSchema); upgrade.exec(migration); upgrade.exec(migration); upgrade.exec(settlementMigration);
    upgrade.exec(handoverMigration); upgrade.exec(handoverMigration);
    const sql = "SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%refund%' AND sql IS NOT NULL ORDER BY type,name";
    assert.deepEqual(upgrade.prepare(sql).all(), fresh.prepare(sql).all());
  } finally { fresh.close(); upgrade.close(); }
});

test('REPLACE cannot bypass immutable refunds, original orders/receipts or audit references', async () => {
  const s = await setup(); const { input } = await s.reserve();
  await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 });
  for (const sql of [
    'INSERT OR REPLACE INTO luggage_flying_pass_refunds SELECT * FROM luggage_flying_pass_refunds',
    'INSERT OR REPLACE INTO luggage_orders SELECT * FROM luggage_orders',
    'INSERT OR REPLACE INTO luggage_order_payments SELECT * FROM luggage_order_payments',
    'INSERT OR REPLACE INTO luggage_audit_logs SELECT * FROM luggage_audit_logs',
  ]) await assert.rejects(s.db.prepare(sql).run(), undefined, sql);
  assert.equal((await s.call(`${input.refundId}/lookup`)).body.refund.status, 'CONFIRMED');
});

test('confirmation rechecks closing inside the write transaction, even after the early read passed', async () => {
  const s = await setup(); const { input } = await s.reserve();
  // Fault injection removes only the outer hold; the confirmation guard must still catch the race.
  await s.db.prepare('DROP TRIGGER luggage_refund_closing_insert_guard').run();
  await s.db.prepare(`CREATE TRIGGER closing_race BEFORE INSERT ON luggage_audit_logs WHEN NEW.action='FLYING_PASS_REFUND_CONFIRM'
    BEGIN INSERT INTO luggage_cash_closings(business_date,closing_type) VALUES (date('now','+9 hours'),'FINAL_CLOSE'); END`).run();
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 409);
  assert.equal((await s.call(`${input.refundId}/lookup`)).body.refund.status, 'PAYOUT_PENDING');
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closings'), 0);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action='FLYING_PASS_REFUND_CONFIRM'"), 0);
});

test('confirmation rechecks original pricing snapshot inside the write transaction', async () => {
  const s = await setup(); const { input } = await s.reserve();
  await s.db.prepare('DROP TRIGGER luggage_refund_preserve_order').run();
  await s.db.prepare(`CREATE TRIGGER price_race BEFORE INSERT ON luggage_audit_logs WHEN NEW.action='FLYING_PASS_REFUND_CONFIRM'
    BEGIN UPDATE luggage_orders SET expected_storage_days=3; END`).run();
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 409);
  assert.equal((await s.call(`${input.refundId}/lookup`)).body.refund.status, 'PAYOUT_PENDING');
  assert.equal(await s.scalar('SELECT expected_storage_days AS n FROM luggage_orders'), 2);
});

test('confirmation and cancellation race to exactly one terminal state and one terminal audit', async () => {
  const s = await setup(); const { input } = await s.reserve();
  const outcomes = await Promise.all([
    s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }),
    s.call(`${input.refundId}/cancel`, { confirmNotPaid: true, reason: '미지급 확인' }),
  ]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200,409]);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action IN ('FLYING_PASS_REFUND_CONFIRM','FLYING_PASS_REFUND_CANCEL')"), 1);
});

test('part_time refund actors: OFF by default (the unrelated global part-time flag does not open them), strict shape, no user_profiles lookup', async () => {
  const s = await setup(); const { input } = await s.reserve();
  const ops = [
    ['preview', { targetTier: 'GOLD' }],
    ['register', { refundId: crypto.randomUUID(), targetTier: 'GOLD', reason: '카페 확인', expectedFingerprint: '0'.repeat(64) }],
    [`${input.refundId}/lookup`, {}],
    [`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }],
    [`${input.refundId}/cancel`, { confirmNotPaid: true, reason: '미지급 확인' }],
  ] as const;
  for (const env of [{ LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED: undefined }, { LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED: 'false', LUGGAGE_PART_TIME_ACTORS_ENABLED: 'true' }]) {
    Object.assign(s.env, env);
    for (const [path, body] of ops) assert.equal((await s.call(path, { ...body, actor: partTime })).status, 403, path);
  }
  s.env.LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED = 'true';
  for (const bad of [{ ...partTime, userId: 'not-a-uuid' }, { ...partTime, userId: partTime.userId.toUpperCase() }, { ...partTime, email: 'pt@example.test' },
    { ...partTime, role: ' part_time' }, { ...partTime, staffId: profile.id }]) {
    for (const [path, body] of ops) assert.equal((await s.call(path, { ...body, actor: bad })).status, 403, `${JSON.stringify(bad)} ${path}`);
  }
  assert.equal((await s.call(`${input.refundId}/lookup`)).body.refund.status, 'PAYOUT_PENDING');
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds"), 1);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE staff_id LIKE 'pt:%'"), 0);
  // A part_time actor is never looked up in (or written to) user_profiles.
  globalThis.fetch = (async () => { throw new Error('part_time must not query user_profiles'); }) as typeof fetch;
  assert.equal((await s.call(`${input.refundId}/lookup`, { actor: partTime })).status, 200);
});

test('refund-only opening: with the refund switch ON and general switch OFF, other internal writes refuse part_time and write nothing', async () => {
  const s = await setup(); Object.assign(s.env, { APP_ENV: 'production', LUGGAGE_PART_TIME_ACTORS_ENABLED: 'false' });
  const before = await s.original(), audits = await s.scalar('SELECT COUNT(*) AS n FROM luggage_audit_logs');
  for (const [path, payload, method] of [
    ['/internal/luggage-handovers/1/read', {}, 'POST'],
    [`/internal/luggage-orders/${ID}/cancel`, { requestId: crypto.randomUUID(), reason: '우회 시도' }, 'POST'],
    [`/internal/luggage-orders/${ID}/note`, { note: '우회' }, 'PATCH'],
    ['/internal/luggage-cash-closings', closingInput(1600), 'POST'],
  ] as const) {
    const response = await internalRequest(s, path, { ...payload, actor: partTime }, method);
    assert.ok([400, 403].includes(response.status), `${path} ${response.status}`);
  }
  // The general switch refuses actor-only routes before any database work.
  assert.match(((await (await internalRequest(s, '/internal/luggage-handovers/1/read', { actor: partTime })).json()) as any).error, /Part-time actors are not enabled/);
  assert.notEqual((await internalRequest(s, '/internal/luggage-handovers/1/read', {})).status, 400);
  assert.equal(await s.original(), before);
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_audit_logs'), audits);
});

async function refundAudits(s: Awaited<ReturnType<typeof setup>>, refundId: string) {
  return (await s.db.prepare(`SELECT action, staff_id, json_extract(details,'$.actor.userId') AS user_id, json_extract(details,'$.actor.role') AS role,
    json_extract(details,'$.legacyStaff.id') AS legacy_id FROM luggage_audit_logs WHERE device_id = ? ORDER BY log_id`).bind(refundId).all<Record<string, string>>()).results.map(r => ({ ...r }));
}
const auditOf = (action: string, who: { userId: string; role: string }) => ({ action, staff_id: staffIdOf(who), user_id: who.userId, role: who.role, legacy_id: staffIdOf(who) });

for (const [label, registrant, finisher] of [
  ['center_staff registers and confirms', actor, actor], ['part_time registers and confirms', partTime, partTime],
  ['center_staff registers → part_time confirms', actor, partTime], ['part_time registers → center_staff confirms', partTime, actor],
  ['center_staff A registers → center_staff B confirms', actor, staffB],
  ['center_staff registers → manager confirms', actor, manager], ['part_time registers → super_admin confirms', partTime, superAdmin],
  ['manager registers → part_time confirms', manager, partTime],
] as const) {
  test(`shift handover: ${label}; each actor audited, originals unchanged, no second payout`, async () => {
    const s = await setup({ migrate: true }); const before = await s.original();
    const { input, result } = await s.reserve('GOLD', crypto.randomUUID(), registrant);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.notEqual((await s.reserve('GOLD', crypto.randomUUID(), finisher).catch(() => null))?.result.status, 201, 'one pending payout per order');
    const confirm = { cashPaid: true, expectedAmount: 400, actor: finisher };
    const done = await s.call(`${input.refundId}/confirm`, confirm);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await s.call(`${input.refundId}/confirm`, confirm)).body.replayed, true);
    for (const other of [registrant, finisher, staffB]) {
      if (other === finisher) continue;
      const late = await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400, actor: other });
      assert.deepEqual([late.status, late.body.code], [409, 'TERMINAL_CONFLICT'], 'a second staff cannot confirm again');
      const cancel = await s.call(`${input.refundId}/cancel`, { confirmNotPaid: true, reason: '이미 지급된 건 취소 시도', actor: other });
      assert.deepEqual([cancel.status, cancel.body.code], [409, 'TERMINAL_CONFLICT'], 'a paid refund cannot be cancelled as unpaid');
    }
    const row = await s.db.prepare('SELECT * FROM luggage_flying_pass_refunds WHERE refund_id = ?').bind(input.refundId).first<any>();
    assert.deepEqual([row.status, row.registered_by_staff_id, row.actor_user_id, row.terminal_by_staff_id], ['CONFIRMED', staffIdOf(registrant), registrant.userId, staffIdOf(finisher)]);
    assert.deepEqual(await refundAudits(s, input.refundId), [auditOf('FLYING_PASS_REFUND_REGISTER', registrant), auditOf('FLYING_PASS_REFUND_CONFIRM', finisher)]);
    assert.equal(await s.scalar("SELECT SUM(amount) AS n FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED'"), 400);
    assert.equal(await s.original(), before, 'original order and receipts unchanged');
  });
}

test('shift handover: another staff (center_staff or part_time) cancels an unpaid payout; the registrant cannot confirm it afterwards', async () => {
  for (const [registrant, finisher] of [[actor, partTime], [partTime, actor], [superAdmin, actor], [actor, manager]] as const) {
    const s = await setup(); const before = await s.original();
    const { input } = await s.reserve('GOLD', crypto.randomUUID(), registrant);
    const cancelled = await s.call(`${input.refundId}/cancel`, { confirmNotPaid: true, reason: '교대 후 미지급 확인', actor: finisher });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const row = await s.db.prepare('SELECT * FROM luggage_flying_pass_refunds WHERE refund_id = ?').bind(input.refundId).first<any>();
    assert.deepEqual([row.status, row.registered_by_staff_id, row.terminal_by_staff_id, row.cancel_reason, row.paid_at], ['CANCELLED', staffIdOf(registrant), staffIdOf(finisher), '교대 후 미지급 확인', null]);
    assert.deepEqual(await refundAudits(s, input.refundId), [auditOf('FLYING_PASS_REFUND_REGISTER', registrant), auditOf('FLYING_PASS_REFUND_CANCEL', finisher)]);
    assert.deepEqual((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400, actor: registrant })).body.code, 'TERMINAL_CONFLICT');
    assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds WHERE status = 'CONFIRMED'"), 0);
    assert.equal(await s.original(), before);
  }
});

test('shift handover race: registrant confirms while another staff cancels → exactly one terminal state and audit', async () => {
  const s = await setup(); const { input } = await s.reserve();
  const outcomes = await Promise.all([
    s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400 }),
    s.call(`${input.refundId}/cancel`, { confirmNotPaid: true, reason: '미지급 확인', actor: partTime }),
  ]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action IN ('FLYING_PASS_REFUND_CONFIRM','FLYING_PASS_REFUND_CANCEL')"), 1);
});

test('date-changed pending payout: ordinary confirm is refused on a later JST day (PAYOUT_DAY_CHANGED); another staff can still cancel it as unpaid', async () => {
  const s = await setup(); const { input } = await s.reserve();
  const tomorrow = new Date(Date.now() + 86400000);
  const asPartTime = { actor: { ...partTime, role: 'part_time' as const }, staff: { id: staffIdOf(partTime), displayName: partTime.name, email: partTime.email, role: 'part_time' as const } };
  await assert.rejects(finishFlyingPassRefund(s.db, ID, input.refundId, { action: 'confirm', cashPaid: true, expectedAmount: 400 }, asPartTime, tomorrow), /지급일/);
  const cancelled = await finishFlyingPassRefund(s.db, ID, input.refundId, { action: 'cancel', confirmNotPaid: true, reason: '익일 확인: 미지급' }, asPartTime, tomorrow);
  assert.equal(cancelled.refund.status, 'CANCELLED');
  assert.equal(cancelled.refund.terminal_by_staff_id, staffIdOf(partTime));
  assert.equal(cancelled.refund.paid_at, null);
});

const jstWall = (ms: number, seconds = false) => new Date(ms + 9 * 3600000).toISOString().slice(0, seconds ? 19 : 16);
const isoOfJst = (wall: string) => new Date(Date.parse(`${wall.length === 16 ? `${wall}:00` : wall}+09:00`)).toISOString();
const jstDayOf = (ms: number) => jstWall(ms).slice(0, 10);
// LOCAL TEST ONLY. SQLite 'now' cannot be mocked and the insert guard pins business_date to today, so a past-day PAYOUT_PENDING is
// made by registering today and shifting created_at/business_date back while the transition guard is briefly removed.
async function pastPending(s: Awaited<ReturnType<typeof setup>>, days: number, registrant: Record<string, string> = actor) {
  await s.db.prepare(`UPDATE luggage_order_payments SET business_date=date('now','+9 hours','-${days} days'), recorded_at=datetime('now','-${days} days')`).run();
  const { input, result } = await s.reserve('GOLD', crypto.randomUUID(), registrant);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const guard = (await s.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'luggage_refund_transition_guard'").first<{ sql: string }>())!.sql;
  await s.db.prepare('DROP TRIGGER luggage_refund_transition_guard').run();
  await s.db.prepare(`UPDATE luggage_flying_pass_refunds SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-${days} days'),
    business_date = date(created_at, '-${days} days', '+9 hours') WHERE refund_id = ?`).bind(input.refundId).run();
  await s.db.prepare(guard).run();
  const row = (await s.db.prepare('SELECT * FROM luggage_flying_pass_refunds WHERE refund_id = ?').bind(input.refundId).first<any>())!;
  assert.equal(row.business_date, jstDayOf(Date.now() - days * 86400000));
  return { refundId: input.refundId as string, row };
}
const lateConfirm = (s: Awaited<ReturnType<typeof setup>>, refundId: string, who: Record<string, string>, paidAtJst: string | undefined, extra: Record<string, unknown> = {}) =>
  s.call(`${refundId}/late-confirm`, { cashPaid: true, expectedAmount: 400, paidAtJst, reason: '전일 현금 지급 확인(등록 직원 진술)', actor: who, ...extra });
const salesOf = async (s: Awaited<ReturnType<typeof setup>>, date: string) => (await s.db.prepare('SELECT cash, gross_cash, cash_refund_amount, refund_count FROM luggage_sales_daily WHERE business_date = ?').bind(date).first<any>()) ?? null;
const finalClose = (s: Awaited<ReturnType<typeof setup>>, date: string, expected: number) =>
  s.db.prepare("INSERT INTO luggage_cash_closings(business_date, closing_type, expected_amount, check_auto_amount, qr_difference_amount) VALUES (?, 'FINAL_CLOSE', ?, ?, 0)").bind(date, expected, expected).run();
const ledgerState = async (s: Awaited<ReturnType<typeof setup>>) => JSON.stringify((await s.db.batch(['luggage_cash_closings ORDER BY closing_id', 'luggage_cash_closing_refund_snapshots ORDER BY closing_id',
  'luggage_cash_closing_audits ORDER BY audit_id', 'luggage_flying_pass_refunds ORDER BY refund_id', 'luggage_audit_logs ORDER BY log_id', 'luggage_orders ORDER BY order_id',
  'luggage_order_payments ORDER BY payment_id'].map(t => s.db.prepare(`SELECT * FROM ${t}`)))).map(r => r.results));

for (const finisher of [manager, superAdmin]) {
  test(`late confirm (${finisher.role}): past-day payout paid on the registration day; staff roles refused, strict paid time, audited, billing/sales/closing follow the payout day`, async () => {
    const s = await setup({ migrate: true });
    const { refundId, row } = await pastPending(s, 1); const before = await s.original();
    const R = row.business_date, created = Date.parse(row.created_at);
    for (const who of [actor, partTime, manager, superAdmin]) {
      const r = await s.call(`${refundId}/confirm`, { cashPaid: true, expectedAmount: 400, actor: who });
      assert.deepEqual([r.status, r.body.code], [409, 'PAYOUT_DAY_CHANGED'], 'ordinary confirm never backdates');
    }
    await assert.rejects(finalClose(s, R, 1200), /REFUND_PAYOUT_PENDING/, 'a past-day pending payout still blocks that day');
    const paidMs = created + 90_000, paidAtJst = finisher === manager ? jstWall(paidMs) : jstWall(paidMs, true);
    for (const who of [actor, staffB, partTime]) {
      const r = await lateConfirm(s, refundId, who, paidAtJst);
      assert.deepEqual([r.status, r.body.code], [403, 'MANAGER_REQUIRED'], who.role);
    }
    for (const [extra, status, code] of [
      [{ paidAtJst: undefined }, 400, 'INVALID_REQUEST'], [{ paidAtJst: '2026-02-30T10:00' }, 400, 'INVALID_REQUEST'],
      [{ paidAtJst: paidAtJst.replace('T', ' ') }, 400, 'INVALID_REQUEST'], [{ paidAtJst: `${jstWall(paidMs, true)}Z` }, 400, 'INVALID_REQUEST'],
      [{ reason: '   ' }, 400, 'INVALID_REQUEST'], [{ reason: 'x'.repeat(201) }, 400, 'INVALID_REQUEST'], [{ cashPaid: false }, 400, 'INVALID_REQUEST'],
      [{ staffId: profileM.id }, 400, 'INVALID_REQUEST'],
      [{ paidAtJst: jstWall(Date.now() + 3600000) }, 400, 'PAID_AT_INVALID'], [{ paidAtJst: jstWall(created - 3600000) }, 400, 'PAID_AT_INVALID'],
      [{ expectedAmount: 399 }, 409, 'AMOUNT_CHANGED'],
    ] as const) {
      const r = await lateConfirm(s, refundId, finisher, paidAtJst, extra as Record<string, unknown>);
      assert.deepEqual([r.status, r.body.code], [status, code], JSON.stringify(extra));
    }
    if (created % 60000 !== 0) assert.equal((await lateConfirm(s, refundId, finisher, jstWall(created))).body.code, 'PAID_AT_INVALID', 'same minute but before the registration second');
    assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'FLYING_PASS_REFUND_CONFIRM'"), 0, 'refusals write nothing');

    const ok = await lateConfirm(s, refundId, finisher, paidAtJst);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const paidAt = isoOfJst(paidAtJst), done = ok.body.refund;
    assert.deepEqual([done.status, done.paid_at, done.business_date, done.registered_by_staff_id, done.actor_user_id, done.terminal_by_staff_id],
      ['CONFIRMED', paidAt, R, profile.id, actor.userId, staffIdOf(finisher)]);
    assert.ok(Date.parse(done.terminal_at) > Date.parse(done.paid_at), 'recorded later than paid');
    const audit = JSON.parse((await s.db.prepare("SELECT details FROM luggage_audit_logs WHERE device_id = ? AND action = 'FLYING_PASS_REFUND_CONFIRM'").bind(refundId).first<{ details: string }>())!.details);
    assert.deepEqual([audit.lateConfirm, audit.settlementDate, audit.businessDate, audit.cashPaid, audit.actor.role, audit.actor.userId, audit.legacyStaff.id],
      [{ paidAt, reason: '전일 현금 지급 확인(등록 직원 진술)' }, R, R, true, finisher.role, finisher.userId, staffIdOf(finisher)]);
    assert.deepEqual(await refundAudits(s, refundId), [auditOf('FLYING_PASS_REFUND_REGISTER', actor), auditOf('FLYING_PASS_REFUND_CONFIRM', finisher)]);
    assert.equal((await lateConfirm(s, refundId, finisher, paidAtJst)).body.replayed, true, 'same request replays');
    for (const [path, payload] of [['late-confirm', { cashPaid: true, expectedAmount: 400, paidAtJst: jstWall(paidMs + 60000), reason: '중복', actor: finisher === manager ? superAdmin : manager }],
      ['confirm', { cashPaid: true, expectedAmount: 400, actor }], ['cancel', { confirmNotPaid: true, reason: '이미 지급된 건', actor: partTime }]] as const) {
      assert.equal((await s.call(`${refundId}/${path}`, payload)).body.code, 'TERMINAL_CONFLICT', path);
    }
    const b = (await getBillingSummary(s.db, ID))!;
    assert.deepEqual([b.pending_refund_count, b.pending_refund_id, b.cash_refunded_amount, b.outstanding_amount], [0, null, 400, 0]);
    assert.deepEqual({ ...await salesOf(s, R) }, { cash: 1200, gross_cash: 1600, cash_refund_amount: 400, refund_count: 1 });
    assert.equal((await salesOf(s, day()))?.refund_count ?? 0, 0, 'nothing attributed to the confirmation day');
    assert.equal(await s.original(), before, 'original order and receipts unchanged');
    await finalClose(s, R, 1200);
    const snap = await s.db.prepare('SELECT * FROM luggage_cash_closing_refund_snapshots').first<any>();
    assert.deepEqual([snap.business_date, JSON.parse(snap.refund_ids), snap.cash_refund_amount, snap.net_total], [R, [refundId], 400, 1200]);
    assert.equal((await writePickupTransition(s.db, ID, 'mark_picked_up', { action: 'PICKUP', staffId: profile.id })).status, 'PICKED_UP', 'pickup reopens');
  });
}

test('late confirm attributes the refund to the real payout day (not registration); registration day closes without it', async () => {
  for (const [label, paidMs] of [['R < P < today', Date.now() - 86400000], ['P = today', Date.now() - 60000]] as const) {
    const s = await setup({ migrate: true });
    const { refundId, row } = await pastPending(s, 2);
    const R = row.business_date, P = jstDayOf(paidMs);
    assert.ok(R < P, label);
    const ok = await lateConfirm(s, refundId, manager, jstWall(paidMs));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(JSON.parse((await s.db.prepare("SELECT details FROM luggage_audit_logs WHERE device_id = ? AND action = 'FLYING_PASS_REFUND_CONFIRM'").bind(refundId).first<{ details: string }>())!.details).settlementDate, P);
    assert.deepEqual({ ...await salesOf(s, R) }, { cash: 1600, gross_cash: 1600, cash_refund_amount: 0, refund_count: 0 }, `${label}: registration day keeps its receipts only`);
    assert.deepEqual({ ...await salesOf(s, P) }, { cash: -400, gross_cash: 0, cash_refund_amount: 400, refund_count: 1 }, `${label}: payout day carries the refund`);
    await finalClose(s, R, 1600);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closing_refund_snapshots'), 0, 'no refund snapshot on the registration day');
    await finalClose(s, P, -400);
    const snap = await s.db.prepare('SELECT * FROM luggage_cash_closing_refund_snapshots').first<any>();
    assert.deepEqual([snap.business_date, JSON.parse(snap.refund_ids), snap.net_cash], [P, [refundId], -400]);
    await s.db.prepare('UPDATE luggage_cash_closings SET note = ? WHERE business_date = ?').bind('수정', R).run(); // registration-day closing stays editable (no snapshot required)
  }
});

test('late confirm into a payout day whose FINAL_CLOSE exists is refused (CLOSING_ALREADY_FINALIZED); closings, snapshots and ledgers unchanged', async () => {
  const s = await setup({ migrate: true });
  const { refundId } = await pastPending(s, 2);
  const P = jstDayOf(Date.now() - 86400000);
  await finalClose(s, P, 0);
  const before = await ledgerState(s);
  const r = await lateConfirm(s, refundId, manager, jstWall(Date.now() - 86400000));
  assert.deepEqual([r.status, r.body.code], [409, 'CLOSING_ALREADY_FINALIZED']);
  assert.equal(await ledgerState(s), before, 'no automatic past closing/ledger rewrite');
  assert.equal((await lateConfirm(s, refundId, manager, jstWall(Date.now() - 60000))).status, 200, 'a payout day that is still open is accepted');
});

test('late confirm is only for past days: a same-day pending payout uses the ordinary confirm (manager included); past-day unpaid can be cancelled by staff', async () => {
  const s = await setup({ migrate: true }); const { input } = await s.reserve();
  assert.equal((await lateConfirm(s, input.refundId, manager, jstWall(Date.now() - 1000))).body.code, 'LATE_CONFIRM_NOT_NEEDED');
  assert.equal((await s.call(`${input.refundId}/confirm`, { cashPaid: true, expectedAmount: 400, actor: manager })).status, 200);
  const t = await setup({ migrate: true }); const { refundId } = await pastPending(t, 1);
  const cancelled = await t.call(`${refundId}/cancel`, { confirmNotPaid: true, reason: '전일 건: 현금 미지급 확인', actor: partTime });
  assert.deepEqual([cancelled.status, cancelled.body.refund.status, cancelled.body.refund.paid_at], [200, 'CANCELLED', null]);
  assert.equal((await getBillingSummary(t.db, ID))!.pending_refund_count, 0);
});

test('late confirm keeps the billing guards: new extension debt blocks it (OUTSTANDING, nothing written); collecting the extension then allows it', async () => {
  const s = await setup({ migrate: true }); const { refundId } = await pastPending(s, 1);
  await s.db.prepare(`INSERT INTO luggage_orders(order_id,parent_order_id,created_at,expected_pickup_at,expected_storage_days,price_per_day,prepaid_amount,final_amount,status)
    VALUES ('EXT-20261028-009',?,datetime('now'),'2099-01-02T12:00:00Z',1,800,800,800,'PAYMENT_PENDING')`).bind(ID).run();
  const blocked = await lateConfirm(s, refundId, manager, jstWall(Date.now() - 60000));
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'OUTSTANDING']);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'FLYING_PASS_REFUND_CONFIRM'"), 0);
  await confirmCollection(s.db, ID, profile.id, { request_id: crypto.randomUUID(), confirm_received: 'yes', expected_amount: 800, cash_amount: 800, qr_amount: 0 });
  assert.equal((await lateConfirm(s, refundId, manager, jstWall(Date.now() - 60000))).status, 200);
});

test('DB guard: a late CONFIRMED needs a manager/super_admin terminal audit with the same paidAt and a reason, paid_at within registration..now, and an open payout day', async () => {
  const s = await setup({ migrate: true }); const { refundId, row } = await pastPending(s, 2);
  const created = Date.parse(row.created_at), paid = new Date(created + 60000).toISOString(), laterPaid = new Date(Date.now() - 86400000).toISOString();
  const attempt = (o: { role?: string; late?: unknown; paidAt?: string; at?: string }) => {
    const hash = 'a'.repeat(64), at = o.at ?? new Date().toISOString(), paidAt = o.paidAt ?? paid;
    const late = o.late === undefined ? { paidAt, reason: '전일 지급' } : o.late;
    const details = JSON.stringify({ refundId, action: 'confirm', cashPaid: true, expectedAmount: 400, ...(late === null ? {} : { lateConfirm: late }),
      terminalHash: hash, actor: { userId: 'raw-sql', role: o.role ?? 'manager' }, legacyStaff: { id: profileM.id } });
    return s.db.batch([
      s.db.prepare('INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)').bind(ID, profileM.id, refundId, 'FLYING_PASS_REFUND_CONFIRM', details, at),
      s.db.prepare(`UPDATE luggage_flying_pass_refunds SET status = 'CONFIRMED', terminal_hash = ?, terminal_by_staff_id = ?, terminal_at = ?, paid_at = ?,
        terminal_audit_id = (SELECT log_id FROM luggage_audit_logs WHERE device_id = ? AND action = 'FLYING_PASS_REFUND_CONFIRM') WHERE refund_id = ?`).bind(hash, profileM.id, at, paidAt, refundId, refundId),
    ]);
  };
  const future = new Date(Date.now() + 3600000).toISOString(), early = new Date(created - 1000).toISOString();
  await finalClose(s, jstDayOf(Date.parse(laterPaid)), 0);
  for (const bad of [{ role: 'center_staff' }, { role: 'part_time' }, { late: null }, { late: { paidAt: paid } }, { late: { paidAt: paid, reason: ' ' } },
    { late: { paidAt: new Date(created + 61000).toISOString(), reason: 'x' } }, { paidAt: early }, { paidAt: future, at: new Date(Date.now() + 7200000).toISOString() },
    { paidAt: laterPaid }]) {
    await assert.rejects(attempt(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_flying_pass_refunds WHERE status = 'PAYOUT_PENDING'"), 1);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'FLYING_PASS_REFUND_CONFIRM'"), 0, 'each refused batch rolled back');
  await attempt({});
  assert.equal(await s.scalar("SELECT paid_at AS n FROM luggage_flying_pass_refunds WHERE refund_id = ?", refundId), paid, 'the evidenced manager late confirmation is the only accepted shape');
});

test('deploy order: the new Worker on a schema without the handover migration cannot record a late confirmation (DB refuses, nothing written)', async () => {
  const s = await setup({ migrate: true, handover: false }); const { refundId } = await pastPending(s, 1);
  const before = await ledgerState(s);
  const r = await lateConfirm(s, refundId, manager, jstWall(Date.now() - 60000));
  // Old trigger raises REFUND_IMMUTABLE_OR_INVALID_TRANSITION/CHECK → WRITE_FAILED (admin: RESULT_UNKNOWN → lookup shows still pending).
  assert.deepEqual([r.status, r.body.code], [500, 'WRITE_FAILED']);
  assert.equal(await ledgerState(s), before);
});

test('handover migration: rebuilds only the refund table and its own guards, keeps existing rows, repeatable; old same-actor flow still valid', async () => {
  const s = await setup({ migrate: true, handover: false });
  const confirmedId = (await s.reserve()).input.refundId;
  assert.equal((await s.call(`${confirmedId}/confirm`, { cashPaid: true, expectedAmount: 400 })).status, 200);
  const pending = await s.reserve('BLACK'); const pendingId = pending.input.refundId, pendingAmount = pending.result.body.refund.amount;
  const master = async () => (await s.db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all<Record<string, string>>()).results;
  const rows = async () => JSON.stringify((await s.db.batch([s.db.prepare('SELECT * FROM luggage_flying_pass_refunds ORDER BY refund_id'), s.db.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id')])).map(r => r.results));
  const beforeMaster = await master(), beforeRows = await rows();
  for (let i = 0; i < 2; i++) for (const sql of splitSql(handoverMigration)) await s.db.prepare(sql).run();
  const afterMaster = await master();
  const changed = new Set(['luggage_flying_pass_refunds', 'luggage_refund_transition_guard', 'luggage_sales_daily', 'luggage_refund_closing_snapshot', 'luggage_refund_closing_update_guard']);
  assert.deepEqual(afterMaster.filter(r => !changed.has(r.name)), beforeMaster.filter(r => !changed.has(r.name)), 'every other view/trigger/index is byte-identical');
  assert.deepEqual(afterMaster.map(r => r.name), beforeMaster.map(r => r.name));
  assert.equal(await rows(), beforeRows, 'refund rows and audit preserved');
  assert.equal(await s.scalar('SELECT total_amount AS n FROM luggage_sales_daily'), 1200);
  // Pending payout registered under the old schema can now be finished by another staff.
  assert.equal((await s.call(`${pendingId}/confirm`, { cashPaid: true, expectedAmount: pendingAmount, actor: partTime })).status, 200);
  const fresh = new DatabaseSync(':memory:');
  try { fresh.exec(preBagSchema); const sql = "SELECT type,name,sql FROM sqlite_master WHERE name LIKE '%refund%' AND sql IS NOT NULL ORDER BY type,name";
    assert.deepEqual((await s.db.prepare(sql).all()).results.map(r => ({ ...r })), fresh.prepare(sql).all().map(r => ({ ...r })), 'fresh schema.sql equals the migrated database');
  } finally { fresh.close(); }
});

test('existing PAID /price and /pricing restrictions remain in force', async () => {
  const s = await setup(); const app = new Hono().route('/', internalApi);
  const current = await s.db.prepare('SELECT * FROM luggage_orders WHERE order_id=?').bind(ID).first<any>();
  const before = await s.original();
  for (const [path, payload] of [
    ['price', { flyingPassTier: 'GOLD' }],
    ['pricing', { requestId: crypto.randomUUID(), reason: '우회 시도', changes: { flyingPassTier: 'GOLD' }, expected: {
      updatedAt: current.updated_at, suitcaseQty: 1, backpackQty: 0, flyingPassTier: 'NONE', staffPrepaidOverrideAmount: null, prepaidAmount: 1600,
    } }],
  ] as const) {
    const url = `https://luggage.test/internal/luggage-orders/${ID}/${path}`;
    const timestamp = String(Math.floor(Date.now()/1000)), body = JSON.stringify({ ...payload, actor });
    const { signature } = await signInternalRequest({ secret: SECRET, method: 'PATCH', url, timestamp, body });
    const response = await app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature }, body }, s.env);
    assert.equal(response.status, 409, path);
  }
  assert.equal(await s.original(), before);
});

async function internalRequest(s: Awaited<ReturnType<typeof setup>>, path: string, payload?: unknown, overrideMethod?: string) {
  const method = overrideMethod ?? (payload === undefined ? 'GET' : 'POST'), url = `https://luggage.test${path}`;
  const timestamp = String(Math.floor(Date.now()/1000)), body = payload === undefined ? '' : JSON.stringify({ actor, ...payload as object });
  const { signature } = await signInternalRequest({ secret: SECRET, method, url, timestamp, body });
  return new Hono().route('/', internalApi).request(url, { method, headers: { 'content-type':'application/json','x-internal-timestamp':timestamp,'x-internal-signature':signature }, ...(method !== 'GET' ? { body } : {}) }, s.env);
}
function closingInput(cash: number, qr = 0) {
  let rest = cash;
  const counts = Object.fromEntries([10000,5000,2000,1000,500,100,50,10,5,1].map(d => { const n = Math.floor(rest/d); rest -= n*d; return [d,n]; }));
  return { requestId: crypto.randomUUID(), closingType:'FINAL_CLOSE', counts, paypayAmount:qr, actualQrAmount:qr, rentalCash:0, wandRefund:0, floor4fCount:0, floor8fCount:0, note:'환급 정산 검증' };
}
async function confirmed(s: Awaited<ReturnType<typeof setup>>) {
  const pending = await s.reserve(); assert.equal(pending.result.status,201);
  const done = await s.call(`${pending.input.refundId}/confirm`,{ cashPaid:true,expectedAmount:400 });
  assert.equal(done.status,200,JSON.stringify(done)); return pending.input.refundId;
}

for (const receipts of [[['CASH',1600]],[['PAY_QR',1600]],[['CASH',800],['PAY_QR',800]]] as Array<Array<[string,number]>>) {
  test(`phase2 ${receipts.map(r=>r[0]).join('+')}: billing, actual cash count, refund snapshot, admin projection and pickup agree`,async()=>{
    const s = await setup({receipts,migrate:true}); const original = await s.original(); const id = await confirmed(s);
    const b = (await getBillingSummary(s.db,ID))!;
    assert.equal(b.effective_flying_pass_tier,'GOLD');assert.equal(b.latest_confirmed_refund_id,id);assert.equal(b.pending_refund_id,null);
    assert.deepEqual([b.total_billed_amount,b.recorded_amount,b.discount_credit_amount,b.cash_refunded_amount,b.total_effective_billed_amount,b.net_received_amount,b.outstanding_amount,b.pending_refund_count],[1600,1600,400,400,1200,1200,0,0]);
    const cash = receipts.filter(r=>r[0]==='CASH').reduce((sum,r)=>sum+r[1],0), qr = 1600-cash;
    const close = await internalRequest(s,'/internal/luggage-cash-closings',closingInput(40000+cash-400,qr));
    assert.equal(close.status,201,await close.clone().text()); const saved = await close.json() as any;
    assert.deepEqual([saved.closing.actualAmount,saved.closing.expectedAmount,saved.closing.differenceAmount],[1200,1200,0]);
    const snapshot = await s.db.prepare('SELECT * FROM luggage_cash_closing_refund_snapshots').first<any>();
    assert.deepEqual([snapshot.gross_cash,snapshot.gross_qr,snapshot.cash_refund_amount,snapshot.net_total],[cash,qr,400,1200]);
    assert.deepEqual(JSON.parse(snapshot.refund_ids),[id]);
    const projection = await internalRequest(s,`/internal/luggage-sales-analytics?startDate=${day()}&endDate=${day()}`);
    assert.equal(projection.status,200); const sales = await projection.json() as any;
    assert.deepEqual([sales.summary.cash,sales.summary.qr,sales.summary.luggage],[cash-400,qr,1200]);
    const detail = await internalRequest(s,`/internal/luggage-cash-closings/${saved.closing.closingId}`);
    assert.equal(detail.status,200); assert.equal((await detail.json() as any).closing.refundSnapshot.netTotalAmount,1200);
    assert.equal(await s.original(),original,'closing never changes original order or receipt');
    const pickup = await writePickupTransition(s.db,ID,'mark_picked_up',{action:'PICKUP',staffId:profile.id});
    assert.equal(pickup.status,'PICKED_UP');
    assert.equal((await s.call(`${id}/confirm`,{cashPaid:true,expectedAmount:400})).body.replayed,true,'retry after close and pickup cannot pay twice');
  });
}

test('phase2 refund-only JST date stays negative after close, including historical source selection and Sheets refresh',async()=>{
  const s = await setup({migrate:true});
  await s.db.prepare("UPDATE luggage_order_payments SET business_date=date('now','+9 hours','-1 day'),recorded_at=datetime('now','-1 day')").run();
  await s.db.prepare("INSERT INTO luggage_cash_closings(business_date,closing_type,total_amount,actual_amount) VALUES (date('now','+9 hours','-1 day'),'FINAL_CLOSE',41600,1600)").run();
  const previous = await s.db.prepare("SELECT * FROM luggage_cash_closings WHERE business_date != ?").bind(day()).first();
  await confirmed(s);
  assert.deepEqual(await s.db.prepare("SELECT * FROM luggage_cash_closings WHERE business_date != ?").bind(day()).first(),previous);
  await s.db.prepare('INSERT OR REPLACE INTO luggage_daily_sales(sale_date,cash,qr,luggage_total) VALUES (?,9999,0,9999)').bind(day()).run();
  assert.equal((await resolveAutoSalesSummaryForDate(s.db,day()))!.totalAmount,-400);
  const result = await internalRequest(s,'/internal/luggage-cash-closings',closingInput(39600));
  assert.equal(result.status,201,await result.clone().text()); const closing = (await result.json() as any).closing;
  assert.deepEqual([closing.actualAmount,closing.expectedAmount,closing.differenceAmount],[-400,-400,0]);
  const savedDay = day(), realDate = globalThis.Date;
  // Read-only clock advance proves a refund-only day remains present after it becomes historical.
  globalThis.Date = class extends realDate { constructor(value?: any){super(value === undefined ? realDate.now()+86400000 : value);} static now(){return realDate.now()+86400000;} } as DateConstructor;
  try {
    assert.equal((await resolveAutoSalesSummaryForDate(s.db,savedDay))!.totalAmount,-400);
    const response = await internalRequest(s,`/internal/luggage-sales-analytics?startDate=${savedDay}&endDate=${savedDay}`);
    assert.equal(response.status,200); const projected = await response.json() as any;
    assert.deepEqual([projected.dailyRows[0].cash,projected.dailyRows[0].luggage,projected.dailyRows[0].luggageSource],[-400,-400,'final_close']);
    assert.equal(projected.summary.dailyAverage,-400);
    const staffApp = new Hono().use('/staff/*',async(c,next)=>{c.set('staff',{...profile,username:'editor',created_at:''});await next();}).route('/',(await import('../src/routes/admin')).default);
    const html = await staffApp.request(`https://luggage.test/staff/admin/sales?start_date=${savedDay}&end_date=${savedDay}`,{},s.env);
    assert.equal(html.status,200); assert.match(await html.text(),/-400/);
  } finally {globalThis.Date=realDate;}
});

test('phase2 pending payout and new extension debt keep pickup blocked; collecting the extension restores pickup',async()=>{
  const s = await setup(); const pending = await s.reserve();
  await assert.rejects(writePickupTransition(s.db,ID,'mark_picked_up',{action:'PICKUP',staffId:profile.id}),/진행 중 현금 환급/);
  assert.equal((await internalRequest(s,'/internal/luggage-cash-closings',closingInput(41600))).status,409);
  await s.call(`${pending.input.refundId}/confirm`,{cashPaid:true,expectedAmount:400});
  await s.db.prepare(`INSERT INTO luggage_orders(order_id,parent_order_id,created_at,expected_pickup_at,expected_storage_days,price_per_day,prepaid_amount,final_amount,status)
    VALUES ('EXT-20261028-009',?,datetime('now'),'2099-01-02T12:00:00Z',1,800,800,800,'PAYMENT_PENDING')`).bind(ID).run();
  await assert.rejects(writePickupTransition(s.db,ID,'mark_picked_up',{action:'PICKUP',staffId:profile.id}),/추가 보관료/);
  assert.equal((await getBillingSummary(s.db,ID))!.outstanding_amount,800);
  await confirmCollection(s.db,ID,profile.id,{request_id:crypto.randomUUID(),confirm_received:'yes',expected_amount:800,cash_amount:800,qr_amount:0});
  const b=(await getBillingSummary(s.db,ID))!;
  assert.deepEqual([b.total_billed_amount,b.total_effective_billed_amount,b.recorded_amount,b.net_received_amount,b.outstanding_amount],[2400,2000,2400,2000,0]);
  assert.equal((await writePickupTransition(s.db,ID,'mark_picked_up',{action:'PICKUP',staffId:profile.id})).status,'PICKED_UP');
});

test('phase2 concurrent confirmation and final close either capture the correct net snapshot or refuse the stale close',async()=>{
  const s = await setup(); const pending = await s.reserve();
  const [confirmation,close]=await Promise.all([
    s.call(`${pending.input.refundId}/confirm`,{cashPaid:true,expectedAmount:400}),
    internalRequest(s,'/internal/luggage-cash-closings',closingInput(41200)),
  ]);
  assert.equal(confirmation.status,200);
  assert.ok([201,409].includes(close.status),await close.clone().text());
  if(close.status===409) assert.equal((await internalRequest(s,'/internal/luggage-cash-closings',closingInput(41200))).status,201);
  assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closing_refund_snapshots'),1);
  assert.equal(await s.scalar('SELECT net_total AS n FROM luggage_cash_closing_refund_snapshots'),1200);
});

test('phase2 snapshot/audit failure and silently ignored snapshot insertion roll back the whole closing',async()=>{
  const s = await setup(); await confirmed(s);
  for (const sql of [
    "CREATE TRIGGER fail_closing BEFORE INSERT ON luggage_cash_closing_audits WHEN NEW.action='REFUND_SNAPSHOT' BEGIN SELECT RAISE(ABORT,'snapshot audit down'); END",
    "CREATE TRIGGER fail_closing BEFORE INSERT ON luggage_cash_closing_audits WHEN NEW.action='REFUND_SNAPSHOT' BEGIN SELECT RAISE(IGNORE); END",
    "CREATE TRIGGER fail_closing BEFORE INSERT ON luggage_cash_closing_refund_snapshots BEGIN SELECT RAISE(IGNORE); END",
    "CREATE TRIGGER fail_closing BEFORE INSERT ON luggage_cash_closing_audits WHEN NEW.action='SUBMIT' BEGIN SELECT RAISE(IGNORE); END",
  ]) {
    await s.db.prepare(sql).run();
    assert.equal((await internalRequest(s,'/internal/luggage-cash-closings',closingInput(41200))).status,500);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closings'),0);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closing_audits'),0);
    assert.equal(await s.scalar('SELECT COUNT(*) AS n FROM luggage_cash_closing_refund_snapshots'),0);
    await s.db.prepare('DROP TRIGGER fail_closing').run();
  }
});

test('phase2 legacy staff closing uses net receipts once and atomically preserves refund snapshot and staff audit',async()=>{
  const s=await setup();await confirmed(s);
  const app=new Hono().use('/staff/*',async(c,next)=>{c.set('staff',{...profile,username:'editor',created_at:''});await next();}).route('/',opsRoutes);
  const input=closingInput(41200), form=new URLSearchParams({...Object.fromEntries(Object.entries(input.counts).map(([d,n])=>[`count_${d}`,String(n)])),closing_type:'FINAL_CLOSE',paypay_amount:'0',actual_qr_amount:'0'});
  const res=await app.request('https://luggage.test/staff/cash-closing',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form},s.env);
  assert.equal(res.status,302);
  assert.equal(await s.scalar('SELECT difference_amount AS n FROM luggage_cash_closings'),0);
  assert.equal(await s.scalar("SELECT COUNT(*) AS n FROM luggage_cash_closing_audits WHERE action IN ('REFUND_SNAPSHOT','SUBMIT')"),2);
});

test('phase2 migration preserves phase1 records, matches fresh definitions, and is repeatable',async()=>{
  const a=new DatabaseSync(':memory:'),b=new DatabaseSync(':memory:');
  try{
    a.exec(schema.split('-- Operator-only correction policy.')[0]);b.exec(phase1Schema);b.exec(settlementMigration);b.exec(settlementMigration);b.exec(handoverMigration);b.exec(handoverMigration);
    const sql="SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name";
    assert.deepEqual(b.prepare(sql).all(),a.prepare(sql).all());
  }finally{a.close();b.close();}
});

test('phase2 recount keeps the immutable refund basis, protects audit/REPLACE, and rolls back a failed edit audit',async()=>{
  const s=await setup(); await confirmed(s);
  const created=await internalRequest(s,'/internal/luggage-cash-closings',closingInput(41200));assert.equal(created.status,201);
  const closing=(await created.json() as any).closing;
  const snapshot=await s.db.prepare('SELECT * FROM luggage_cash_closing_refund_snapshots').first();
  const {snapshot:expected}=await (await internalRequest(s,`/internal/luggage-cash-closings/${closing.closingId}/edit-snapshot`)).json() as any;
  const fields=closingInput(41100); const {requestId,closingType,...edit}=fields;
  await s.db.prepare("CREATE TRIGGER fail_edit BEFORE INSERT ON luggage_cash_closing_audits WHEN NEW.action='EDIT' BEGIN SELECT RAISE(IGNORE); END").run();
  assert.equal((await internalRequest(s,`/internal/luggage-cash-closings/${closing.closingId}`,{...edit,expected},'PATCH')).status,500);
  assert.equal(await s.scalar('SELECT actual_amount AS n FROM luggage_cash_closings'),1200);
  await s.db.prepare('DROP TRIGGER fail_edit').run();
  const changed=await internalRequest(s,`/internal/luggage-cash-closings/${closing.closingId}`,{...edit,expected},'PATCH');
  assert.equal(changed.status,200,await changed.clone().text());
  assert.equal((await changed.json() as any).closing.differenceAmount,-100);
  assert.deepEqual(await s.db.prepare('SELECT * FROM luggage_cash_closing_refund_snapshots').first(),snapshot);
  const realNow=Date.now;
  Date.now=()=>realNow()+86400000;
  try {
    const response=await internalRequest(s,`/internal/luggage-sales-analytics?startDate=${snapshot!.business_date}&endDate=${snapshot!.business_date}`);
    assert.equal(response.status,200);const row=(await response.json() as any).dailyRows[0];
    assert.deepEqual([row.luggage,row.closingDifferenceAmount],[1200,-100]);
  }finally{Date.now=realNow;}

  for(const sql of [
    'DELETE FROM luggage_cash_closing_refund_snapshots', 'UPDATE luggage_cash_closing_refund_snapshots SET net_total=0',
    'INSERT OR REPLACE INTO luggage_cash_closings SELECT * FROM luggage_cash_closings',
    "DELETE FROM luggage_cash_closing_audits WHERE action='REFUND_SNAPSHOT'",'DELETE FROM luggage_cash_closings',
    "UPDATE luggage_cash_closings SET business_date='2099-01-01'",
  ]) await assert.rejects(s.db.prepare(sql).run(),undefined,sql);
});

test('phase2 dashboard token changes on payout registration and confirmation without rewriting the original order',async()=>{
  const s=await setup(), scope={q:'',status:'UNPICKED',showAllPickedUp:false,dateFrom:'',dateTo:''};
  const original=await s.original(),before=await getDashboardSyncToken(s.db,scope);
  const pending=await s.reserve();const during=await getDashboardSyncToken(s.db,scope);assert.notEqual(during,before);
  await s.call(`${pending.input.refundId}/confirm`,{cashPaid:true,expectedAmount:400});
  assert.notEqual(await getDashboardSyncToken(s.db,scope),during);
  assert.equal(await s.original(),original);
});

test('phase2 actual migration upgrades existing phase1-format confirmed refunds without changing any financial records',async()=>{
  const s=await setup();await confirmed(s);
  const names=['luggage_billing_lines','luggage_billing_balances','luggage_sales_daily','luggage_refund_preserve_order','luggage_pickup_balance_guard'];
  const oldDefinitions=splitSql(phase1Schema);
  for(const name of names){
    const definition=oldDefinitions.find(sql=>new RegExp(`^CREATE (VIEW|TRIGGER) IF NOT EXISTS ${name}\\b`).test(sql));assert.ok(definition,name);
    await s.db.prepare(`DROP ${definition.startsWith('CREATE VIEW')?'VIEW':'TRIGGER'} ${name}`).run();await s.db.prepare(definition).run();
  }
  for(const sql of oldDefinitions.filter(sql=>/^CREATE TRIGGER IF NOT EXISTS luggage_refund_phase1_closing_(insert|update)\b/.test(sql)))await s.db.prepare(sql).run();
  assert.equal(await s.scalar('SELECT total_amount AS n FROM luggage_sales_daily'),1600);
  const capture=async()=>JSON.stringify((await s.db.batch([
    s.db.prepare('SELECT * FROM luggage_orders'),s.db.prepare('SELECT * FROM luggage_order_payments'),
    s.db.prepare('SELECT * FROM luggage_flying_pass_refunds'),s.db.prepare('SELECT * FROM luggage_audit_logs'),
  ])).map(r=>r.results));
  const before=await capture();
  for(const sql of splitSql(settlementMigration))await s.db.prepare(sql).run();
  assert.equal(await capture(),before);
  const b=(await getBillingSummary(s.db,ID))!;
  assert.deepEqual([b.total_effective_billed_amount,b.net_received_amount,b.outstanding_amount],[1200,1200,0]);
  assert.equal(await s.scalar('SELECT total_amount AS n FROM luggage_sales_daily'),1200);
});
