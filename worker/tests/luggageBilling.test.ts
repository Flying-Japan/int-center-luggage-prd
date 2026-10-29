import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { AppType } from '../src/types';
import staffApi from '../src/routes/staffApi';
import staffOrders from '../src/routes/staffOrders';
import internalApi from '../src/routes/internalApi';
import adminRoutes from '../src/routes/admin';
import { signInternalRequest } from '../src/lib/hmac';
import { payableAmountFromOrder } from '../src/lib/payments';
import { collectionAllocation, confirmCollection, createDatedExtension, getBillingSummary, getBillingSummaries, materializeOutstandingDays } from '../src/services/luggageBilling';
import { generateExtensionOrders } from '../src/services/extension';
import { runMidnightRollover } from '../src/services/midnightRollover';
import { resolveAutoSalesSummaryForDate } from '../src/services/cashClosingSales';

const open: DatabaseSync[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => { for (const db of open.splice(0)) db.close(); globalThis.fetch = originalFetch; });
const ROOT = '20261024-001';
const STAFF = 'test-editor';
const SECRET = 'billing-tests-only';

const CORRECTED_ORDER = '20261023-087';
const correctionInsert = `INSERT INTO luggage_order_price_corrections
  (correction_id, order_id, approval_reference, operator_reference, evidence_sha256)
  VALUES ('087-long-stay-discount-20261029', '20261023-087', 'user-approved:087-normal-discount:2026-10-29', 'local-test-operator', '${'a'.repeat(64)}')`;

function seed087(ctx: Fixture, options: { receiptAmount?: number; extraAmount?: number } = {}) {
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, updated_at, status, tag_no,
    backpack_qty, expected_pickup_at, expected_storage_days, price_per_day, discount_rate,
    prepaid_amount, final_amount, staff_prepaid_override_amount, payment_method, in_warehouse)
    VALUES (?, '2026-10-23 08:19:18', '2026-10-27 10:44:46', 'PAID', '146', 2,
      '2026-10-31T08:30:00.000Z', 9, 1000, 0.05, 9000, 9000, 9000, 'CASH', 1)`).run(CORRECTED_ORDER);
  ctx.sqlite.prepare('UPDATE luggage_orders SET extra_amount = ? WHERE order_id = ?').run(options.extraAmount ?? 0, CORRECTED_ORDER);
  ctx.sqlite.exec(`INSERT INTO luggage_order_payments(payment_id, order_id, business_date, tender_type, amount, recorded_at)
    VALUES (12067, '${CORRECTED_ORDER}', '2026-10-23', 'CASH', ${options.receiptAmount ?? 8550}, '2026-10-23 08:22:42');
    INSERT INTO luggage_audit_logs(log_id, order_id, action, details, timestamp) VALUES
      (53907, '${CORRECTED_ORDER}', 'TOGGLE_PAYMENT', '결제 완료', '2026-10-23 08:22:42'),
      (54341, '${CORRECTED_ORDER}', 'UPDATE_PRICE', '금액: ¥9000', '2026-10-24 11:47:11');`);
}

test('approved 087 correction restores 5% price without changing receipts, audits, 44 closings or another review', async () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx);
  seedRoot(ctx, { billed: 9000, daysAgo: 0 });
  // Seed a separate unresolved root without modifying any collected amount.
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, status, prepaid_amount, final_amount)
    VALUES ('other-review', 'PAID', 9000, 9000)`).run();
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount)
    VALUES ('other-review', '2026-10-29', 'CASH', 8550)`).run();
  for (let i = 1; i <= 44; i++) ctx.sqlite.prepare(`INSERT INTO luggage_cash_closings(closing_id, business_date,
    closing_type, actual_amount, check_auto_amount, difference_amount, actual_qr_amount)
    VALUES (?, date('2026-09-01', '+' || ? || ' days'), 'EVENING', 162450, 159550, 2900, 12300)`).run(i, i);
  const receiptsBefore = payments(ctx);
  const auditsBefore = ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id').all();
  const closingsBefore = ctx.sqlite.prepare('SELECT * FROM luggage_cash_closings ORDER BY closing_id').all();
  const otherBefore = ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id != ? ORDER BY order_id').all(CORRECTED_ORDER);
  const salesBefore = ctx.sqlite.prepare('SELECT * FROM luggage_sales_daily ORDER BY business_date').all();
  assert.equal((await getBillingSummary(ctx.db, CORRECTED_ORDER))?.review_pickup_blocked, 1);
  ctx.sqlite.exec(correctionInsert);
  const b = (await getBillingSummary(ctx.db, CORRECTED_ORDER))!;
  assert.equal(b.total_billed_amount, 8550); assert.equal(b.recorded_amount, 8550);
  assert.equal(b.root_review_required, 0); assert.equal(b.root_review_amount, 0);
  assert.equal(b.outstanding_amount, 0); assert.equal(b.review_pickup_blocked, 0);
  assert.equal(b.refund_count, 0); assert.equal(b.cash_refunded_amount, 0); assert.equal(b.discount_credit_amount, 0);
  assert.equal(ctx.sqlite.prepare('SELECT staff_prepaid_override_amount FROM luggage_orders WHERE order_id = ?').get(CORRECTED_ORDER)?.staff_prepaid_override_amount, null);
  assert.deepEqual(payments(ctx), receiptsBefore);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs WHERE log_id <= 54341 ORDER BY log_id').all(), auditsBefore);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_cash_closings ORDER BY closing_id').all(), closingsBefore);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id != ? ORDER BY order_id').all(CORRECTED_ORDER), otherBefore);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_sales_daily ORDER BY business_date').all(), salesBefore);
  assert.equal((await getBillingSummary(ctx.db, 'other-review'))?.root_review_amount, 450);
  const audit = ctx.sqlite.prepare("SELECT * FROM luggage_audit_logs WHERE action = 'CORRECT_COLLECTED_PRICE'").get()!;
  const evidence = JSON.parse(String(audit.details));
  assert.equal(evidence.before.finalAmount, 9000); assert.equal(evidence.after.finalAmount, 8550);
  assert.equal(evidence.longStayDiscountAmount, 450); assert.equal(evidence.paymentId, 12067); assert.equal(audit.staff_id, null);
  // Exercise the actual pickup service/DB protections locally; production is never picked up by this task.
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?").run(CORRECTED_ORDER);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(CORRECTED_ORDER)?.status, 'PICKED_UP');
});

test('087 correction does not authorize direct price edits or corrections for any other order', () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx); seedRoot(ctx);
  assert.throws(() => ctx.sqlite.exec(`UPDATE luggage_orders SET prepaid_amount = 8550, final_amount = 8550 WHERE order_id = '${CORRECTED_ORDER}'`), /separate correction policy/);
  assert.throws(() => ctx.sqlite.exec(correctionInsert.replaceAll(CORRECTED_ORDER, ROOT)), /PRECONDITION|CHECK/);
  assert.throws(() => ctx.sqlite.exec(correctionInsert.replace('user-approved:', 'not-approved:')), /CHECK/);
  ctx.sqlite.exec(correctionInsert);
  assert.throws(() => ctx.sqlite.exec(correctionInsert), /PRECONDITION|UNIQUE/);
  assert.throws(() => ctx.sqlite.exec(`UPDATE luggage_orders SET final_amount = 9000 WHERE order_id = '${CORRECTED_ORDER}'`), /separate correction policy/);
  assert.throws(() => ctx.sqlite.exec(`UPDATE luggage_orders SET final_amount = 8550 WHERE order_id = '${ROOT}'`), /separate correction policy/);
});

for (const [name, change] of [
  ['stale order', "UPDATE luggage_orders SET updated_at = '2026-10-29 01:00:00' WHERE order_id = '20261023-087'"],
  ['wrong period', "UPDATE luggage_orders SET expected_storage_days = 8 WHERE order_id = '20261023-087'"],
  ['different manual price', "UPDATE luggage_orders SET staff_prepaid_override_amount = 8750 WHERE order_id = '20261023-087'"],
  ['wrong discount', "UPDATE luggage_orders SET discount_rate = 0 WHERE order_id = '20261023-087'"],
  ['new price audit', "INSERT INTO luggage_audit_logs(order_id, action, details) VALUES ('20261023-087', 'UPDATE_PRICE', 'another price')"],
] as const) test(`087 correction aborts and appends no audit when ${name}`, () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx); ctx.sqlite.exec(change);
  assert.throws(() => ctx.sqlite.exec(correctionInsert), /PRECONDITION/);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_order_price_corrections').get()?.n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'CORRECT_COLLECTED_PRICE'").get()?.n, 0);
  assert.equal(ctx.sqlite.prepare('SELECT final_amount FROM luggage_orders WHERE order_id = ?').get(CORRECTED_ORDER)?.final_amount, 9000);
});

test('087 correction event, real receipt and all old/new audits resist update/delete/replace', () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx); ctx.sqlite.exec(correctionInsert);
  for (const sql of [
    "UPDATE luggage_order_price_corrections SET operator_reference = 'other'",
    'DELETE FROM luggage_order_price_corrections',
    correctionInsert.replace('INSERT INTO', 'INSERT OR REPLACE INTO'),
    'UPDATE luggage_order_payments SET amount = 9000 WHERE payment_id = 12067',
    'DELETE FROM luggage_order_payments WHERE payment_id = 12067',
    "INSERT OR REPLACE INTO luggage_order_payments(payment_id, order_id, business_date, tender_type, amount) VALUES (12067, '20261023-087', '2026-10-23', 'CASH', 9000)",
    "UPDATE luggage_audit_logs SET details = 'changed' WHERE order_id = '20261023-087'",
    "DELETE FROM luggage_audit_logs WHERE order_id = '20261023-087'",
    "INSERT OR REPLACE INTO luggage_audit_logs(log_id, action) VALUES (53907, 'REPLACE')",
  ]) assert.throws(() => ctx.sqlite.exec(sql), /Preserve|PRECONDITION/);
});

test('087 correction rejects a different receipt or a genuine extra charge', () => {
  for (const options of [{ receiptAmount: 8500 }, { extraAmount: 1000 }]) {
    const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx, options);
    assert.throws(() => ctx.sqlite.exec(correctionInsert), /PRECONDITION/);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_order_price_corrections').get()?.n, 0);
  }
});

test('087 correction failure rolls back its event, audit and price together', () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx);
  ctx.sqlite.exec("CREATE TRIGGER simulate_failure AFTER UPDATE OF final_amount ON luggage_orders BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  assert.throws(() => ctx.sqlite.exec(correctionInsert), /simulated write failure/);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_order_price_corrections').get()?.n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action='CORRECT_COLLECTED_PRICE'").get()?.n, 0);
  assert.equal(ctx.sqlite.prepare('SELECT final_amount FROM luggage_orders WHERE order_id=?').get(CORRECTED_ORDER)?.final_amount, 9000);
});

test('genuine later automatic extension remains collectible and blocks pickup after 087 correction', async () => {
  const ctx = setup('2026-10-29T06:00:00Z'); seed087(ctx); ctx.sqlite.exec(correctionInsert);
  // Advance the projection clock only, keeping the policy and extension service unchanged.
  const views = ctx.sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql LIKE '%2026-10-29T06:00:00Z%'").all();
  for (const view of views) { ctx.sqlite.exec(`DROP VIEW ${view.name}`); ctx.sqlite.exec(String(view.sql).replaceAll('2026-10-29T06:00:00Z', '2026-11-01T13:00:00Z')); }
  await materializeOutstandingDays(ctx.db, CORRECTED_ORDER);
  const b = (await getBillingSummary(ctx.db, CORRECTED_ORDER))!;
  assert.ok(b.extension_outstanding_amount > 0); assert.equal(b.root_review_amount, 0);
  assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?").run(CORRECTED_ORDER), /Outstanding collection/);
});

function setup(projectionNow?: string | false, role = 'editor', correctionPolicy = true) {
  const sqlite = new DatabaseSync(':memory:');
  open.push(sqlite);
  let schema = readFileSync('src/schema.sql', 'utf8');
  if (!correctionPolicy) schema = schema.split('-- Operator-only correction policy.')[0];
  // Keep ordinary fixtures before the 21:00 accrual boundary; boundary cases pass their own clock.
  // Actual receipt timestamps still come from the service.
  if (projectionNow !== false) {
    const projectionClock = projectionNow ?? `${new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}T06:00:00Z`;
    schema = schema.replaceAll("'now'", `'${projectionClock}'`);
  }
  sqlite.exec(schema);
  // Historical fixtures explicitly opt into accrual; production cutover never does.
  sqlite.exec("UPDATE luggage_automatic_billing_policy SET starts_at = '1970-01-01T00:00:00Z'");
  const queries: Array<{ sql: string; bindings: number }> = [];
  const statement = (sql: string) => {
    const query = { sql, bindings: 0 };
    queries.push(query);
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        assert.ok(values.length <= 100, `D1 binding limit exceeded: ${values.length}`);
        query.bindings = values.length;
        args = values;
        return this;
      },
      async run() {
        const rows = sqlite.prepare(sql).all(...(args as never[]));
        const changes = (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n;
        return { results: rows, success: true, meta: { changes } };
      },
      async all() { return { results: sqlite.prepare(sql).all(...(args as never[])) }; },
      async first() { return sqlite.prepare(sql).get(...(args as never[])) ?? null; },
    };
  };
  let queue: Promise<unknown> = Promise.resolve();
  const adapter = {
    prepare: statement,
    batch(statements: Array<ReturnType<typeof statement>>) {
      const result = queue.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const db = adapter as unknown as D1Database;
  const app = new Hono<AppType>();
  app.use('/staff/*', async (c, next) => {
    c.set('staff', { id: STAFF, role, is_active: true, display_name: 'Test Editor', username: 'test', created_at: '' });
    await next();
  });
  // Production mounts internalApi before the staff routers' catch-all staffAuth middleware.
  app.route('/', internalApi).route('/', staffApi).route('/', staffOrders).route('/', adminRoutes);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, APP_ENV: 'test', SUPABASE_URL: 'https://billing-profiles.test', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };
  return { sqlite, db, app, env, queries };
}
type Fixture = ReturnType<typeof setup>;

function seedRoot(ctx: Fixture, options: { daysAgo?: number; billed?: number; daily?: number; status?: string } = {}) {
  const today = (ctx.sqlite.prepare("SELECT date('now', '+9 hours') AS d").get() as { d: string }).d;
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (options.daysAgo ?? 1));
  const pickup = date.toISOString();
  const billed = options.billed ?? 1600;
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, expected_storage_days,
    price_per_day, prepaid_amount, final_amount, status, tag_no, suitcase_qty)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, '12', 2)`)
    .run(ROOT, pickup, pickup, options.daily ?? 1600, billed, billed, options.status ?? 'PAID');
  if ((options.status ?? 'PAID') === 'PAID' && billed > 0) ctx.sqlite.prepare(`INSERT INTO luggage_order_payments
    (order_id, business_date, tender_type, amount, staff_id, recorded_at) VALUES (?, ?, 'CASH', ?, ?, ?)`)
    .run(ROOT, pickup.slice(0, 10), billed, STAFF, pickup);
  return { today, pickup };
}

function body(amount = 1600, changes: Record<string, unknown> = {}) {
  return { request_id: crypto.randomUUID(), expected_amount: amount, cash_amount: amount, qr_amount: 0, confirm_received: 'yes', ...changes };
}
function payments(ctx: Fixture) { return ctx.sqlite.prepare('SELECT * FROM luggage_order_payments ORDER BY payment_id').all(); }
async function post(ctx: Fixture, path: string, payload: Record<string, unknown>) {
  return ctx.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, ctx.env);
}

function pickupPayload(ctx: Fixture) {
  const current = ctx.sqlite.prepare('SELECT status, updated_at FROM luggage_orders WHERE order_id = ?').get(ROOT);
  assert.ok(current);
  return {
    action: 'mark_picked_up', expectedUpdatedAt: current.updated_at,
    // Pickup actors have a narrower schema than phone/cancellation actors: email is not accepted.
    actor: { userId: 'pickup-user', name: 'Pickup Tester', role: 'center_staff' },
  };
}

async function internalPickup(ctx: Fixture, payload: Record<string, unknown>, secret = SECRET) {
  const url = `https://internal.invalid/internal/luggage-orders/${ROOT}/pickup-status`;
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ method: 'PATCH', body: raw, secret, timestamp, url });
  return ctx.app.request(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature }, body: raw,
  }, ctx.env);
}

test('¥1,600 original receipt + ¥1,600 unpaid extension = ¥1,600 outstanding, including PAID root + PAYMENT_PENDING child', async () => {
  const ctx = setup(); seedRoot(ctx);
  const original = payments(ctx)[0];
  await materializeOutstandingDays(ctx.db, ROOT);
  const b = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(b.total_billed_amount, 3200);
  assert.equal(b.recorded_amount, 1600);
  assert.equal(b.outstanding_amount, 1600);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE parent_order_id = ?').get(ROOT)?.status, 'PAYMENT_PENDING');
  assert.deepEqual(payments(ctx)[0], original);
  const list = await ctx.app.request('/staff/api/orders?limit=1', {}, ctx.env);
  assert.equal((await list.json() as any).orders[0].billing.outstanding_amount, 1600);
  const detail = await ctx.app.request(`/staff/orders/${ROOT}`, {}, ctx.env);
  const html = await detail.text();
  assert.equal(detail.status, 200);
  assert.match(html, /추가 결제 필요/);
  assert.match(html, /미수납 ¥1,600/);
  assert.match(html, /실제 수납 ¥1,600/);
  assert.match(html, /현장 수납 확인 확정/);
});

test('both ¥1,600 receipts collected -> zero outstanding; root and child history and linkage preserved', async () => {
  const ctx = setup(); seedRoot(ctx);
  const before = payments(ctx)[0];
  const request = body();
  await confirmCollection(ctx.db, ROOT, STAFF, request);
  const b = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(b.recorded_amount, 3200);
  assert.equal(b.outstanding_amount, 0);
  assert.deepEqual(payments(ctx)[0], before);
  const log = ctx.sqlite.prepare("SELECT * FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION'").get()!;
  assert.equal(log.staff_id, STAFF);
  const details = JSON.parse(String(log.details));
  assert.equal(details.rootId, ROOT);
  assert.equal(details.receipts[0].amount, 1600);
  assert.notEqual(details.receipts[0].orderId, ROOT);
});

test('repeated identical request and a different concurrent request cannot collect twice', async () => {
  const ctx = setup(); seedRoot(ctx);
  await materializeOutstandingDays(ctx.db, ROOT);
  const request = body();
  const results = await Promise.allSettled([
    confirmCollection(ctx.db, ROOT, STAFF, request), confirmCollection(ctx.db, ROOT, STAFF, body()),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const count = payments(ctx).length;
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, request));
  assert.equal(payments(ctx).length, count);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.recorded_amount, 3200);
});

test('two or more missed days accumulate per date and repeated/concurrent cron runs never duplicate dates', async () => {
  const ctx = setup(); seedRoot(ctx, { daysAgo: 3 });
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 4800);
  const startedAt = new Date().toISOString();
  await Promise.all([generateExtensionOrders(ctx.db), generateExtensionOrders(ctx.db)]);
  await generateExtensionOrders(ctx.db);
  const finishedAt = new Date().toISOString();
  const rows = ctx.sqlite.prepare('SELECT extension_date, COUNT(*) AS n FROM luggage_orders WHERE parent_order_id = ? GROUP BY extension_date').all(ROOT);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.n === 1));
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 4800);
  const dates = ctx.sqlite.prepare('SELECT created_at FROM luggage_orders WHERE parent_order_id = ?').all(ROOT);
  assert.ok(dates.every(r => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(r.created_at))));
  assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM luggage_orders WHERE parent_order_id = ?
    AND (datetime(created_at) < datetime(?) OR datetime(created_at) > datetime(?))`).get(ROOT, startedAt, finishedAt)!.n, 0);
});

test('automatic extension creator stores actual UTC creation/audit time across JST midnight, separately from a backdated billing day', async () => {
  for (const [instant, expectedUtc, expectedJstDay, expectedIdDate] of [
    ['2026-10-24T14:59:59.789Z', '2026-10-24 14:59:59', '2026-10-24', '20261024'],
    ['2026-10-24T15:00:00.321Z', '2026-10-24 15:00:00', '2026-10-25', '20261025'],
  ]) {
    const ctx = setup(instant);
    const rootId = '20261022-001';
    const billingDate = '2026-10-23';
    ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, expected_storage_days,
      status, price_per_day, prepaid_amount, final_amount, tag_no)
      VALUES (?, '2026-10-22 01:00:00', '2026-10-22T12:00:00Z', 1, 'PAID', 1600, 1600, 1600, '12')`).run(rootId);
    ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id, recorded_at)
      VALUES (?, '2026-10-22', 'CASH', 1600, ?, '2026-10-22T01:00:00Z')`).run(rootId, STAFF);
    const ledger = payments(ctx);
    const before = (await getBillingSummary(ctx.db, rootId))!;
    // This is the shared creator reached by materializeOutstandingDays/generateExtensionOrders.
    const id = await createDatedExtension(ctx.db, rootId, billingDate, null, false, new Date(instant));
    assert.ok(id);
    assert.ok(id.startsWith(`EXT-${expectedIdDate}-`));
    const stored = ctx.sqlite.prepare(`SELECT created_at, updated_at, extension_date, manual_entry,
      date(created_at, '+9 hours') AS created_jst_day FROM luggage_orders WHERE order_id = ?`).get(id)!;
    assert.equal(stored.created_at, expectedUtc);
    assert.equal(stored.updated_at, expectedUtc);
    assert.equal(stored.created_jst_day, expectedJstDay);
    assert.equal(stored.extension_date, billingDate);
    assert.equal(stored.manual_entry, 0);
    assert.equal(ctx.sqlite.prepare('SELECT coverage_end FROM luggage_billing_lines WHERE order_id = ?').get(id)!.coverage_end, billingDate);
    const logs = ctx.sqlite.prepare("SELECT timestamp, details FROM luggage_audit_logs WHERE action = 'CREATE_DATED_EXTENSION'").all();
    assert.equal(logs.length, 2);
    for (const log of logs) {
      assert.equal(log.timestamp, expectedUtc);
      const details = JSON.parse(String(log.details));
      assert.equal(details.createdAt, expectedUtc);
      assert.equal(details.billingDate, billingDate);
    }
    const after = (await getBillingSummary(ctx.db, rootId))!;
    assert.equal(after.outstanding_amount, before.outstanding_amount);
    assert.equal(after.unbilled_days, before.unbilled_days - 1);
    assert.equal(await createDatedExtension(ctx.db, rootId, billingDate, null, false, new Date(instant)), null);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_orders WHERE parent_order_id = ?').get(rootId)!.n, 1);
    assert.deepEqual(payments(ctx), ledger);
    assert.equal(ctx.sqlite.prepare('SELECT SUM(total_amount) AS n FROM luggage_sales_daily').get()!.n, 1600);
    assert.equal(ctx.sqlite.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM luggage_receipt_sales WHERE business_date = ?').get(expectedJstDay)!.n, 0);
  }
});

test('picked-up order cannot gain an automatic/manual extension, including a stale insert', async () => {
  const ctx = setup(); const { today } = seedRoot(ctx, { daysAgo: 0 });
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?").run(ROOT);
  assert.equal(await createDatedExtension(ctx.db, ROOT, today), null);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  assert.throws(() => ctx.sqlite.prepare("INSERT INTO luggage_orders(order_id, parent_order_id, extension_date) VALUES ('EXT-stale', ?, ?)").run(ROOT, today));
});

test('outstanding blocks JSON pickup, HTML pickup, internal pickup, direct update, bulk paid/cancel and legacy toggles', async () => {
  const ctx = setup(); seedRoot(ctx);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 409);
  const html = await ctx.app.request(`/staff/orders/${ROOT}/mark-picked-up`, { method: 'POST' }, ctx.env);
  assert.equal(html.status, 302);
  assert.match(decodeURIComponent(html.headers.get('location')!), /추가 결제 필요/);
  for (const action of ['mark_paid', 'cancel']) assert.equal((await post(ctx, '/staff/api/orders/bulk-action', { order_ids: [ROOT], action, payment_method: 'CASH' })).status, 409);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/toggle-payment`, {})).status, 409);
  const before = ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id = ?').get(ROOT);
  assert.equal(before!.status, 'PAID');
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
  const ledger = payments(ctx);
  const internal = await internalPickup(ctx, pickupPayload(ctx));
  assert.equal(internal.status, 409, 'signed internal pickup must reach the financial guard, not staff-login middleware');
  assert.match((await internal.json() as { error: string }).error, /추가 결제 필요/);
  assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?").run(ROOT));
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id = ?').get(ROOT), before);
  assert.deepEqual(payments(ctx), ledger);
});

test('internal pickup preserves HMAC, strict actor/payload validation and version/status checks before the financial guard', async () => {
  const ctx = setup(); seedRoot(ctx);
  const valid = pickupPayload(ctx);
  const before = ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id = ?').get(ROOT);
  const ledger = payments(ctx);
  assert.equal((await internalPickup(ctx, valid, 'wrong-secret')).status, 401);
  const { expectedUpdatedAt: _expected, ...withoutVersion } = valid;
  for (const payload of [
    { ...valid, actor: { ...valid.actor, email: 'extra@example.test' } },
    { ...valid, actor: { ...valid.actor, role: 'viewer' } },
    { ...valid, expectedUpdatedAt: '' },
    { ...valid, action: 'mark_paid' },
    withoutVersion,
  ]) {
    const response = await internalPickup(ctx, payload);
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.doesNotMatch((await response.json() as { error: string }).error, /추가 결제 필요/);
  }
  const stale = await internalPickup(ctx, { ...valid, expectedUpdatedAt: '2000-01-01 00:00:00' });
  assert.equal(stale.status, 409);
  assert.match((await stale.json() as { error: string }).error, /changed by another request/);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id = ?').get(ROOT), before);
  assert.deepEqual(payments(ctx), ledger);
  const pending = setup(); seedRoot(pending, { status: 'PAYMENT_PENDING' });
  const wrongStatus = await internalPickup(pending, pickupPayload(pending));
  assert.equal(wrongStatus.status, 409);
  assert.match((await wrongStatus.json() as { error: string }).error, /transition is not allowed/);
});

test('staff unauthenticated pickup keeps the login redirect; unsigned internal pickup keeps HMAC 401', async () => {
  const ctx = setup(); seedRoot(ctx);
  const unsigned = await ctx.app.request(`https://internal.invalid/internal/luggage-orders/${ROOT}/pickup-status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, ctx.env);
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.headers.get('location'), null);
  const staffOnly = new Hono<AppType>().route('/', staffApi);
  const unauthenticated = await staffOnly.request(`/staff/api/orders/${ROOT}/pickup`, { method: 'POST' }, ctx.env);
  assert.equal(unauthenticated.status, 302);
  assert.equal(unauthenticated.headers.get('location'), '/staff/login');
  assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT)!.status, 'PAID');
});

test('normal original order with no extension has no regression; pickup does not create extra charges', async () => {
  const ctx = setup(); seedRoot(ctx, { daysAgo: 0 });
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 200);
  assert.equal(ctx.sqlite.prepare('SELECT extra_amount FROM luggage_orders WHERE order_id = ?').get(ROOT)!.extra_amount, 0);
  assert.equal(payments(ctx).length, 1);
});

test('00:00–03:00 JST shows unpaid projected extension before cron/tag assignment; reads have no writes', async () => {
  const ctx = setup('2026-10-24T15:30:00Z');
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, price_per_day, prepaid_amount, final_amount, status, tag_no)
    VALUES (?, '2026-10-24T01:00:00Z', '2026-10-24T12:00:00Z', 1600, 1600, 1600, 'PAID', '12')`).run(ROOT);
  ctx.sqlite.prepare("INSERT INTO luggage_audit_logs(order_id, action, timestamp) VALUES (?, 'MARK_PAID', '2026-10-24T01:00:00Z')").run(ROOT);
  const b = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(b.outstanding_amount, 1600);
  assert.equal(b.unbilled_days, 1);
  assert.equal(b.legacy_paid_estimate, 1600);
  assert.equal(b.recorded_amount, 0); // An old PAID flag is not an actual receipt.
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_orders').get()!.n, 1);
});

function closeTimeRoot(ctx: Fixture, status = 'PAID', daily = 1600) {
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at,
    expected_storage_days, price_per_day, prepaid_amount, final_amount, status, tag_no)
    VALUES (?, '2026-10-23T01:00:00Z', '2026-10-23T12:00:00Z', 1, ?, ?, ?, ?, '12')`)
    .run(ROOT, daily, daily, daily, status);
  if (status === 'PAID' && daily > 0) ctx.sqlite.prepare(`INSERT INTO luggage_order_payments
    (order_id, business_date, tender_type, amount, staff_id, recorded_at)
    VALUES (?, '2026-10-23', 'CASH', ?, ?, '2026-10-23T01:00:00Z')`).run(ROOT, daily, STAFF);
}
function projectionClock(ctx: Fixture, utc: string) {
  ctx.sqlite.exec('DROP VIEW luggage_unbilled_extension_days');
  const sql = readFileSync('migrations/20261028_close_time_extension.sql', 'utf8');
  ctx.sqlite.exec(sql.slice(sql.indexOf('CREATE VIEW luggage_unbilled_extension_days'))
    .replaceAll("'now'", `'${utc}'`));
}

test('Tokyo 21:00 is the charge boundary; midnight never charges the same overnight twice', async () => {
  for (const [utc, days] of [
    ['2026-10-23T11:59:00Z', 0], ['2026-10-23T12:00:00Z', 1],
    ['2026-10-23T12:01:00Z', 1], ['2026-10-23T15:01:00Z', 1],
    ['2026-10-24T11:59:00Z', 1], ['2026-10-24T12:01:00Z', 2],
  ] as const) {
    const ctx = setup(utc); closeTimeRoot(ctx, 'PAID', 1730);
    const b = (await getBillingSummary(ctx.db, ROOT))!;
    assert.equal(b.unbilled_days, days, utc);
    assert.equal(b.outstanding_amount, days * 1730, utc);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_orders').get()!.n, 1);
  }
});

test('20:59 pickup never gains a later charge; an inconsistent recorded pickup is also excluded', async () => {
  const ctx = setup('2026-10-23T11:59:00Z'); closeTimeRoot(ctx);
  const receipts = payments(ctx);
  ctx.sqlite.prepare("UPDATE luggage_orders SET status='PICKED_UP', actual_pickup_at='2026-10-23T11:59:00Z' WHERE order_id=?").run(ROOT);
  projectionClock(ctx, '2026-10-25T12:01:00Z');
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
  ctx.sqlite.prepare("UPDATE luggage_orders SET status='PAID' WHERE order_id=?").run(ROOT);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  assert.deepEqual(payments(ctx), receipts);
});

test('cutover excludes unverified pre-existing orders from projection, cron and direct automatic insertion', async () => {
  const ctx = setup('2026-10-24T18:00:00Z'); closeTimeRoot(ctx, 'PAYMENT_PENDING', 2400);
  ctx.sqlite.exec("UPDATE luggage_automatic_billing_policy SET starts_at='2026-10-24T00:00:00Z'");
  const orders = ctx.sqlite.prepare('SELECT * FROM luggage_orders').all();
  const receipts = payments(ctx);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 2400);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.unbilled_days, 0);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  assert.equal(await createDatedExtension(ctx.db, ROOT, '2026-10-24'), null);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders').all(), orders);
  assert.deepEqual(payments(ctx), receipts);
});

test('unconfirmed new pending intake is excluded; recorded partial tender enables only the remaining amounts', async () => {
  const ctx = setup('2026-10-23T12:01:00Z'); closeTimeRoot(ctx, 'PAYMENT_PENDING');
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.unbilled_days, 0);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at)
    VALUES (?, '2026-10-23', 'CASH', 600, ?, '2026-10-23T01:00:00Z')`).run(ROOT, STAFF);
  const before = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(before.outstanding_amount, 1000 + 1600);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 1);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 2600);
  assert.equal(payments(ctx).length, 1);
});

test('21:01 projection becomes one invoice, duplicate cron adds nothing, and a missed day catches up', async () => {
  const ctx = setup('2026-10-23T12:01:00Z'); closeTimeRoot(ctx);
  const before = (await getBillingSummary(ctx.db, ROOT))!;
  await Promise.all([generateExtensionOrders(ctx.db), generateExtensionOrders(ctx.db)]);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  const after = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(after.total_billed_amount, before.total_billed_amount);
  assert.equal(after.outstanding_amount, before.outstanding_amount);
  assert.equal(after.unbilled_days, 0);
  projectionClock(ctx, '2026-10-25T18:00:00Z');
  assert.equal((await generateExtensionOrders(ctx.db)).created, 2);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 4800);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  const dates = ctx.sqlite.prepare('SELECT extension_date, COUNT(*) AS n FROM luggage_orders WHERE parent_order_id=? GROUP BY extension_date').all(ROOT);
  assert.equal(dates.length, 3);
  assert.ok(dates.every(r => r.n === 1));
});

test('partial extension receipt reduces only its remaining debt and never bills its covered date again', async () => {
  const ctx = setup('2026-10-23T12:01:00Z'); closeTimeRoot(ctx);
  await generateExtensionOrders(ctx.db);
  const child = ctx.sqlite.prepare('SELECT order_id FROM luggage_orders WHERE parent_order_id=?').get(ROOT)!.order_id;
  const request = crypto.randomUUID();
  ctx.sqlite.prepare(`INSERT INTO luggage_audit_logs(order_id,staff_id,device_id,action) VALUES (?, ?, ?, 'CONFIRM_COLLECTION')`).run(ROOT, STAFF, request);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at,receipt_request_id)
    VALUES (?, '2026-10-23', 'PAY_QR', 600, ?, '2026-10-23T12:01:00Z', ?)`).run(child, STAFF, request);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.extension_outstanding_amount, 1000);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
});

test('late confirmation never retroactively bills unverified nights before actual intake', async () => {
  const ctx = setup('2026-10-25T12:01:00Z'); closeTimeRoot(ctx, 'PAYMENT_PENDING');
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at)
    VALUES (?, '2026-10-25', 'CASH', 1600, ?, '2026-10-25T01:00:00Z')`).run(ROOT, STAFF);
  ctx.sqlite.prepare("UPDATE luggage_orders SET status='PAID' WHERE order_id=?").run(ROOT);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.unbilled_days, 1);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 1);
  const row = ctx.sqlite.prepare('SELECT extension_date FROM luggage_orders WHERE parent_order_id=?').get(ROOT);
  assert.equal(row!.extension_date, '2026-10-26');
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
});

test('a paid flag without tender or audited confirmation cannot prove a chargeable intake', async () => {
  const ctx = setup('2026-10-25T12:01:00Z'); closeTimeRoot(ctx, 'PAYMENT_PENDING');
  ctx.sqlite.prepare("UPDATE luggage_orders SET status='PAID' WHERE order_id=?").run(ROOT);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  ctx.sqlite.prepare(`INSERT INTO luggage_audit_logs(order_id,action,timestamp)
    VALUES (?, 'MARK_PAID', '2026-10-25T01:00:00Z')`).run(ROOT);
  assert.equal((await generateExtensionOrders(ctx.db)).created, 1);
});

test('invalid chronology, future creation and cancellation do not accrue new automatic debt', async () => {
  for (const patch of [
    "expected_pickup_at='2026-10-22T12:00:00Z'",
    "created_at='2026-10-26T01:00:00Z'",
    "status='CANCELLED'",
  ]) {
    const ctx = setup('2026-10-25T18:00:00Z'); closeTimeRoot(ctx, patch.includes('CANCELLED') ? 'CANCELLED' : 'PAID');
    if (!patch.includes('CANCELLED')) ctx.sqlite.exec(`UPDATE luggage_orders SET ${patch}`);
    assert.equal((await generateExtensionOrders(ctx.db)).created, 0, patch);
  }
});

test('cash/QR split uses actual receipt JST date for cash closing and sales; old receipt date and amount stay intact', async () => {
  const ctx = setup(); const { today, pickup } = seedRoot(ctx);
  await confirmCollection(ctx.db, ROOT, STAFF, body(1600, { cash_amount: 600, qr_amount: 1000 }));
  const rows = payments(ctx);
  assert.equal(rows[0].business_date, pickup.slice(0, 10));
  assert.equal(rows[0].amount, 1600);
  assert.deepEqual(rows.slice(1).map(r => [r.tender_type, r.amount, r.staff_id, r.business_date]), [['CASH', 600, STAFF, today], ['PAY_QR', 1000, STAFF, today]]);
  const closing = await resolveAutoSalesSummaryForDate(ctx.db, today);
  assert.equal(closing!.cashAmount, 600);
  assert.equal(closing!.qrAmount, 1000);
  assert.equal(closing!.totalAmount, 1600);
  const old = await resolveAutoSalesSummaryForDate(ctx.db, pickup.slice(0, 10));
  assert.equal(old!.totalAmount, 1600);
  assert.equal(ctx.sqlite.prepare('SELECT SUM(total_amount) AS n FROM luggage_sales_daily').get()!.n, 3200);
});

test('exhausted 146–150 tags do not hide debt or prevent billing; rollover retry preserves all charges', async () => {
  const ctx = setup(); seedRoot(ctx);
  for (let tag = 146; tag <= 150; tag++) ctx.sqlite.prepare("INSERT INTO luggage_orders(order_id, status, tag_no) VALUES (?, 'PAID', ?)").run(`tag-${tag}`, String(tag));
  const first = await runMidnightRollover(ctx.db);
  assert.ok(first.errors >= 1);
  assert.equal(ctx.sqlite.prepare('SELECT tag_no FROM luggage_orders WHERE order_id = ?').get(ROOT)!.tag_no, '12');
  await materializeOutstandingDays(ctx.db, ROOT);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = 'tag-146'").run();
  await runMidnightRollover(ctx.db);
  await runMidnightRollover(ctx.db);
  await materializeOutstandingDays(ctx.db, ROOT);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_orders WHERE parent_order_id = ?').get(ROOT)!.n, 1);
  assert.equal(ctx.sqlite.prepare('SELECT tag_no FROM luggage_orders WHERE order_id = ?').get(ROOT)!.tag_no, '146');
});

test('discounted original, free daily rate and manually corrected extension charge never double count', async () => {
  assert.equal(payableAmountFromOrder({ prepaid_amount: 1600, final_amount: 0 }), 0);
  const ctx = setup(); const { today } = seedRoot(ctx, { billed: 1400 });
  const id = (await createDatedExtension(ctx.db, ROOT, today, STAFF, true))!;
  ctx.sqlite.prepare('UPDATE luggage_orders SET final_amount = 900, staff_prepaid_override_amount = 900 WHERE order_id = ?').run(id);
  await generateExtensionOrders(ctx.db);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 900);
  await confirmCollection(ctx.db, ROOT, STAFF, body(900));
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 200);
  assert.equal(ctx.sqlite.prepare('SELECT extra_amount FROM luggage_orders WHERE order_id = ?').get(ROOT)!.extra_amount, 0);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.total_billed_amount, 2300);
  const free = setup(); seedRoot(free, { billed: 0, daily: 0, daysAgo: 2 });
  await generateExtensionOrders(free.db);
  assert.equal((await getBillingSummary(free.db, ROOT))!.outstanding_amount, 0);
});

test('legacy manual extension coverage prevents auto charge duplication for both timestamp formats', async () => {
  for (const created of ['2026-10-24 16:00:00', '2026-10-24T16:00:00.000Z']) {
    const ctx = setup('2026-10-24T16:30:00Z');
    ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, expected_pickup_at, status, price_per_day, prepaid_amount, final_amount)
      VALUES (?, '2026-10-24 01:00:00', '2026-10-24T12:00:00Z', 'PAID', 1600, 1600, 1600)`).run(ROOT);
    ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, parent_order_id, created_at, expected_pickup_at, expected_storage_days, price_per_day, prepaid_amount, final_amount)
      VALUES ('EXT-old', ?, ?, '2026-10-26T12:00:00Z', 1, 1600, 1600, 1600)`).run(ROOT, created);
    assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
    assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  }
});

test('editor/admin collection only; abnormal/stale amounts and missing actual receipt acknowledgement rejected', async () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    const ctx = setup(undefined, role); seedRoot(ctx);
    const res = await post(ctx, `/staff/api/orders/${ROOT}/confirm-collection`, body());
    assert.equal(res.status, role === 'viewer' ? 403 : 200);
  }
  for (const amount of [-1, 1.5, 'NaN', 'Infinity', '1e3', true, null, 500001]) {
    assert.throws(() => collectionAllocation(body(1600, { cash_amount: amount }), 1600));
  }
  const ctx = setup(); seedRoot(ctx);
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(1500)));
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(1600, { confirm_received: 'no' })));
  assert.equal(payments(ctx).length, 1);
});

test('ledger deletion, collected-price mutation, cancellation and due-date edits cannot erase extension debt', async () => {
  const ctx = setup(); seedRoot(ctx);
  await materializeOutstandingDays(ctx.db, ROOT);
  assert.throws(() => ctx.sqlite.prepare('DELETE FROM luggage_order_payments WHERE order_id = ?').run(ROOT));
  assert.throws(() => ctx.sqlite.prepare('UPDATE luggage_orders SET final_amount = 0 WHERE order_id = ?').run(ROOT));
  assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'CANCELLED' WHERE parent_order_id = ?").run(ROOT));
  assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET expected_pickup_at = '2099-01-01T12:00:00Z' WHERE order_id = ?").run(ROOT));
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
});

test('a failure after the audit/first tender rolls the entire receipt transaction back', async () => {
  const ctx = setup(); seedRoot(ctx);
  await materializeOutstandingDays(ctx.db, ROOT);
  ctx.sqlite.exec(`CREATE TRIGGER fail_qr BEFORE INSERT ON luggage_order_payments WHEN NEW.tender_type = 'PAY_QR'
    BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(1600, { cash_amount: 800, qr_amount: 800 })));
  assert.equal(payments(ctx).length, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION'").get()!.n, 0);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 1600);
});

test('settled family pickup closes extension rows, preserves receipts and prevents subsequent cron charges', async () => {
  const ctx = setup(); seedRoot(ctx, { daysAgo: 2 });
  await confirmCollection(ctx.db, ROOT, STAFF, body(3200));
  const before = payments(ctx);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 200);
  const rows = ctx.sqlite.prepare('SELECT status, extra_amount FROM luggage_orders WHERE order_id = ? OR parent_order_id = ?').all(ROOT, ROOT);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.status === 'PICKED_UP' && r.extra_amount === 0));
  assert.equal((await generateExtensionOrders(ctx.db)).created, 0);
  assert.deepEqual(payments(ctx), before);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
});

test('already-free pending original and free extensions can use the existing zero-yen confirmation without a waiver', async () => {
  const ctx = setup(); seedRoot(ctx, { billed: 0, daily: 0, status: 'PAYMENT_PENDING' });
  await materializeOutstandingDays(ctx.db, ROOT);
  const res = await ctx.app.request(`/staff/orders/${ROOT}/mark-paid`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'payment_method=CASH',
  }, ctx.env);
  assert.equal(res.status, 302);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 200);
  assert.equal(payments(ctx).length, 0);
});

test('prepared migration preserves historical original, manual-extension and payment rows', () => {
  const sqlite = new DatabaseSync(':memory:'); open.push(sqlite);
  const current = readFileSync('src/schema.sql', 'utf8');
  // Reconstruct the pre-change schema solely for this migration test fixture.
  const oldSchema = current.slice(0, current.indexOf('-- Extension billing and receipt guards'))
    .replace('  extension_date TEXT,\n', '').replace('  receipt_request_id TEXT,\n', '');
  sqlite.exec(oldSchema);
  sqlite.exec(`INSERT INTO luggage_orders(order_id, status, prepaid_amount, final_amount) VALUES ('original', 'PAID', 1600, 1600);
    INSERT INTO luggage_orders(order_id, parent_order_id, status, prepaid_amount, final_amount) VALUES ('manual', 'original', 'PAYMENT_PENDING', 1600, 1600);
    INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id) VALUES ('original', '2026-10-24', 'CASH', 1600, 'old-staff');`);
  const paymentsBefore = sqlite.prepare('SELECT * FROM luggage_order_payments').all();
  const ordersBefore = sqlite.prepare('SELECT order_id, parent_order_id, status, prepaid_amount, final_amount FROM luggage_orders ORDER BY order_id').all();
  sqlite.exec(readFileSync('migrations/20261025_extension_receipts.sql', 'utf8'));
  assert.deepEqual(sqlite.prepare('SELECT order_id, parent_order_id, status, prepaid_amount, final_amount FROM luggage_orders ORDER BY order_id').all(), ordersBefore);
  const paymentsAfter = sqlite.prepare('SELECT payment_id, order_id, business_date, tender_type, amount, staff_id, recorded_at FROM luggage_order_payments').all();
  assert.deepEqual(paymentsAfter, paymentsBefore);
  assert.equal(sqlite.prepare("SELECT outstanding_amount FROM luggage_billing_balances WHERE root_id = 'original'").get()!.outstanding_amount, 1600);
});

test('fresh schema and prepared migration have identical billing views, indexes and triggers', () => {
  const fresh = new DatabaseSync(':memory:'); open.push(fresh);
  const migrated = new DatabaseSync(':memory:'); open.push(migrated);
  const schema = readFileSync('src/schema.sql', 'utf8').split('-- Flying Pass phase 2:')[0].trimEnd() + '\n';
  const migration = readFileSync('migrations/20261025_extension_receipts.sql', 'utf8');
  const objectsStart = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_extension_date';
  assert.ok(schema.includes(objectsStart));
  assert.ok(migration.includes(objectsStart));
  // Keep the complete shared definitions byte-identical, not just similar trigger names.
  assert.equal(schema.slice(schema.indexOf(objectsStart), schema.indexOf("-- 21:00 JST automatic extension cutover")).trim(), migration.slice(migration.indexOf(objectsStart)).trim());
  fresh.exec(schema);
  migrated.exec(schema.slice(0, schema.indexOf('-- Extension billing and receipt guards'))
    .replace('  extension_date TEXT,\n', '').replace('  receipt_request_id TEXT,\n', ''));
  migrated.exec(migration);
  migrated.exec(readFileSync('migrations/20261028_close_time_extension.sql', 'utf8'));
  migrated.exec(readFileSync('migrations/20261028_confirmed_intake_extension.sql', 'utf8'));
  const definitions = (db: DatabaseSync) => db.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('view', 'trigger') OR name IN ('idx_luggage_extension_date', 'idx_luggage_receipt_request', 'idx_luggage_collection_request')
    ORDER BY type, name`).all();
  assert.deepEqual(definitions(fresh), definitions(migrated));
});

test('ledger and legacy PAID estimates are mutually exclusive in daily sales without inventing cash receipts', async () => {
  const ctx = setup(); const { pickup } = seedRoot(ctx);
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, status, price_per_day, prepaid_amount, final_amount)
    VALUES ('legacy-no-ledger', ?, 'PAID', 700, 700, 700)`).run(pickup);
  const sources = ctx.sqlite.prepare('SELECT order_id, estimated, amount FROM luggage_receipt_sales ORDER BY order_id').all();
  assert.deepEqual(sources.map(r => [r.order_id, r.estimated, r.amount]), [[ROOT, 0, 1600], ['legacy-no-ledger', 1, 700]]);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_order_payments').get()!.n, 1);
  const legacy = (await getBillingSummary(ctx.db, 'legacy-no-ledger'))!;
  assert.equal(legacy.recorded_amount, 0);
  assert.equal(legacy.legacy_paid_estimate, 700);
  assert.equal(ctx.sqlite.prepare('SELECT SUM(total_amount) AS n FROM luggage_sales_daily').get()!.n, 2300);
  const closing = await resolveAutoSalesSummaryForDate(ctx.db, pickup.slice(0, 10));
  assert.equal(closing!.totalAmount, 2300); // Existing reconciliation estimate, never an INSERTed cash receipt.
  assert.equal(closing!.estimatedAmount, 700);
  assert.equal(closing!.recordedAmount, 1600);
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_order_payments').get()!.n, 1);
});

test('historical overpayment requires reconciliation and cannot cause another collection or automatic offset', async () => {
  const ctx = setup(); const { today } = seedRoot(ctx);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id)
    VALUES (?, ?, 'CASH', 400, ?)`).run(ROOT, today, STAFF);
  const billing = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(billing.overpaid_amount, 400);
  assert.equal(billing.invalid_amount, 1);
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body()));
  assert.equal(payments(ctx).length, 2);
});

type ReviewEvidence = 'verified' | 'none' | 'text' | 'before-mismatch' | 'early' | 'same-second' | 'no-staff';
function seedRootReview(ctx: Fixture, options: { id?: string; status?: string; evidence?: ReviewEvidence; paid?: number; overdue?: boolean } = {}) {
  const id = options.id ?? ROOT;
  const paid = options.paid ?? 8550;
  const status = options.status ?? 'PAID';
  const evidence = options.evidence ?? 'verified';
  // Synthetic copy of a legacy post-payment price edit. INSERT the historical end state;
  // do not disable collected-price guards or perform a new post-payment monetary edit.
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, updated_at, name, status,
    expected_pickup_at, expected_storage_days, price_per_day, discount_rate, prepaid_amount, final_amount,
    staff_prepaid_override_amount, extra_amount, payment_method, actual_pickup_at)
    VALUES (?, '2026-10-20 00:00:00', '2026-10-20 02:00:00', 'Synthetic Settlement', ?,
      date('now', '+9 hours', ?) || 'T12:00:00Z', 6, 1600, 0.05, 9000, 9000, 9000, 0, 'CASH', ?)`)
    .run(id, status, options.overdue ? '-1 day' : '+0 days', status === 'PICKED_UP' ? '2026-10-20T03:00:00Z' : null);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id, recorded_at)
    VALUES (?, '2026-10-20', 'CASH', ?, ?, '2026-10-20 01:00:00')`).run(id, paid, STAFF);
  if (evidence !== 'none') {
    const details = evidence === 'text' ? '패스: NONE, 결제수단: CASH, 금액: ¥9000' : JSON.stringify({
      before: { prepaid_amount: evidence === 'before-mismatch' ? 9000 : paid, final_amount: evidence === 'before-mismatch' ? 9000 : paid, extra_amount: 0 },
      after: { finalAmount: 9000, overrideAmount: 9000 }, staffId: STAFF,
    });
    const at = evidence === 'early' ? '2026-10-20 00:30:00' : evidence === 'same-second' ? '2026-10-20 01:00:00' : '2026-10-20 02:00:00';
    ctx.sqlite.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details, timestamp)
      VALUES (?, ?, 'UPDATE_PRICE', ?, ?)`).run(id, evidence === 'no-staff' ? null : STAFF, details, at);
  }
  return id;
}

function stubReviewStaffNames() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://billing-profiles.test/rest/v1/user_profiles')) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify([{ id: STAFF, display_name: 'Settlement Editor', username: 'editor' }]), {
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

test('¥9,000 claim / ¥8,550 ledger after a proven price edit remains a ¥450 review item, never an automatic collection', async () => {
  const ctx = setup(); seedRootReview(ctx);
  const ledger = payments(ctx);
  const billing = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(billing.total_billed_amount, 9000);
  assert.equal(billing.recorded_amount, 8550);
  assert.equal(billing.legacy_paid_estimate, 0);
  assert.equal(billing.root_review_required, 1);
  assert.equal(billing.root_review_amount, 450);
  assert.equal(billing.root_review_difference, 450);
  assert.equal(billing.root_review_reason, 'AUDITED_POST_PAYMENT_REPRICE');
  assert.equal(billing.review_pickup_blocked, 0);
  assert.equal(billing.outstanding_amount, 0);
  assert.equal(billing.extension_outstanding_amount, 0);
  const cancellation = await post(ctx, `/staff/api/orders/${ROOT}/cancel`, {});
  assert.equal(cancellation.status, 409);
  assert.equal((await cancellation.json() as { code: string }).code, 'ROOT_SETTLEMENT_REVIEW_REQUIRED');
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(450)), /정산 차이는 추가 수납/);
  assert.deepEqual(payments(ctx), ledger);
  const list = await ctx.app.request('/staff/api/orders', {}, ctx.env);
  assert.equal((await list.json() as any).orders[0].billing.root_review_amount, 450);
  stubReviewStaffNames();
  const detail = await ctx.app.request(`/staff/orders/${ROOT}`, {}, ctx.env);
  const html = await detail.text();
  assert.equal(detail.status, 200);
  assert.match(html, /기존 원주문 정산 확인 필요/);
  assert.match(html, /차이 ¥450/);
  assert.doesNotMatch(html, /action="[^" ]*confirm-collection"/);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 200);
  const after = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(after.root_review_amount, 450); // Physical pickup did not settle/write off the monetary claim.
  assert.equal(ctx.sqlite.prepare('SELECT final_amount FROM luggage_orders WHERE order_id = ?').get(ROOT)!.final_amount, 9000);
  assert.deepEqual(payments(ctx), ledger);
  assert.equal((await resolveAutoSalesSummaryForDate(ctx.db, '2026-10-20'))!.totalAmount, 8550);
});

test('HTML and signed internal pickup share the proven-reprice policy without editing receipts', async () => {
  for (const route of ['html', 'internal']) {
    const ctx = setup(); seedRootReview(ctx);
    const ledger = payments(ctx);
    const response = route === 'html'
      ? await ctx.app.request(`/staff/orders/${ROOT}/mark-picked-up`, { method: 'POST' }, ctx.env)
      : await internalPickup(ctx, pickupPayload(ctx));
    assert.equal(response.status, route === 'html' ? 302 : 200);
    if (route === 'html') assert.equal(response.headers.get('location'), `/staff/orders/${ROOT}`);
    assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT)!.status, 'PICKED_UP');
    assert.equal((await getBillingSummary(ctx.db, ROOT))!.root_review_amount, 450);
    assert.deepEqual(payments(ctx), ledger);
  }
});

test('missing/ambiguous price evidence does not waive a paid original shortfall or authorize extra collection', async () => {
  for (const evidence of ['none', 'text', 'before-mismatch', 'early', 'same-second', 'no-staff'] as const) {
    const ctx = setup(); seedRootReview(ctx, { evidence });
    const ledger = payments(ctx);
    const billing = (await getBillingSummary(ctx.db, ROOT))!;
    assert.equal(billing.root_review_amount, 450, evidence);
    assert.equal(billing.root_review_reason, 'UNVERIFIED_ROOT_DIFFERENCE');
    assert.equal(billing.review_pickup_blocked, 1);
    assert.equal(billing.outstanding_amount, 0); // Unconfirmed claim; not zeroed/forgiven in root_review_difference.
    const json = await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {});
    assert.equal(json.status, 409);
    assert.match((await json.json() as { error: string }).error, /원주문 정산 확인/);
    const html = await ctx.app.request(`/staff/orders/${ROOT}/mark-picked-up`, { method: 'POST' }, ctx.env);
    assert.equal(html.status, 302);
    assert.match(decodeURIComponent(html.headers.get('location')!), /원주문 정산 확인/);
    assert.equal((await internalPickup(ctx, pickupPayload(ctx))).status, 409);
    assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP' WHERE order_id = ?").run(ROOT));
    await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(450)), /정산 차이는 추가 수납/);
    assert.throws(() => ctx.sqlite.prepare('DELETE FROM luggage_order_payments WHERE order_id = ?').run(ROOT));
    assert.throws(() => ctx.sqlite.prepare('UPDATE luggage_order_payments SET amount = 9000 WHERE order_id = ?').run(ROOT));
    assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAYMENT_PENDING' WHERE order_id = ?").run(ROOT));
    assert.throws(() => ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'CANCELLED' WHERE order_id = ?").run(ROOT));
    assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/toggle-payment`, {})).status, 409);
    assert.equal((await post(ctx, '/staff/api/orders/bulk-action', { order_ids: [ROOT], action: 'cancel' })).status, 409);
    assert.deepEqual(payments(ctx), ledger);
    assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT)!.status, 'PAID');
  }
});

test('a ¥450 original review and ¥1,600 extension debt stay separate through cash/QR collection and retry', async () => {
  for (const evidence of ['verified', 'text'] as const) {
    const ctx = setup(); seedRootReview(ctx, { evidence, overdue: true });
    const original = payments(ctx)[0];
    const before = (await getBillingSummary(ctx.db, ROOT))!;
    assert.equal(before.root_review_amount, 450);
    assert.equal(before.extension_outstanding_amount, 1600);
    assert.equal(before.outstanding_amount, 1600);
    await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(2050))); // Never bundle the review amount.
    await materializeOutstandingDays(ctx.db, ROOT);
    assert.equal((await internalPickup(ctx, pickupPayload(ctx))).status, 409);
    const request = body(1600, { cash_amount: 600, qr_amount: 1000 });
    await confirmCollection(ctx.db, ROOT, STAFF, request);
    const after = (await getBillingSummary(ctx.db, ROOT))!;
    assert.equal(after.total_billed_amount, 10600);
    assert.equal(after.recorded_amount, 10150);
    assert.equal(after.root_review_amount, 450);
    assert.equal(after.outstanding_amount, 0);
    assert.equal(after.extension_outstanding_amount, 0);
    assert.deepEqual(payments(ctx)[0], original);
    assert.ok(payments(ctx).slice(1).every(p => p.order_id !== ROOT));
    await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, request));
    await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(450)));
    // Even a valid collection request for the child cannot be reused to collect the review amount on its parent.
    assert.throws(() => ctx.sqlite.prepare(`INSERT INTO luggage_order_payments
      (order_id, business_date, tender_type, amount, staff_id, receipt_request_id)
      VALUES (?, date('now', '+9 hours'), 'CASH', 450, ?, ?)` ).run(ROOT, STAFF, request.request_id));
    const today = (ctx.sqlite.prepare("SELECT date('now', '+9 hours') AS d").get() as { d: string }).d;
    const closing = (await resolveAutoSalesSummaryForDate(ctx.db, today))!;
    assert.equal(closing.cashAmount, 600);
    assert.equal(closing.qrAmount, 1000);
    assert.equal(closing.totalAmount, 1600);
    assert.equal(ctx.sqlite.prepare('SELECT SUM(total_amount) AS n FROM luggage_sales_daily').get()!.n, 10150);
    const pickup = await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {});
    assert.equal(pickup.status, evidence === 'verified' ? 200 : 409);
    assert.equal((await getBillingSummary(ctx.db, ROOT))!.root_review_amount, 450);
  }
});

test('a genuine pending-original partial payment is still collectible and retains the first receipt', async () => {
  const ctx = setup(); seedRootReview(ctx, { status: 'PAYMENT_PENDING' });
  const original = payments(ctx)[0];
  const before = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(before.root_review_required, 0);
  assert.equal(before.outstanding_amount, 450);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/toggle-payment`, { payment_method: 'CASH' })).status, 409);
  await confirmCollection(ctx.db, ROOT, STAFF, body(450));
  assert.deepEqual(payments(ctx)[0], original);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.recorded_amount, 9000);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
});

test('an audited downward price edit keeps its overpayment for review and never automatically offsets an extension', async () => {
  const ctx = setup(); seedRootReview(ctx, { paid: 9250, overdue: true });
  const ledger = payments(ctx);
  const billing = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(billing.root_review_reason, 'AUDITED_POST_PAYMENT_REPRICE');
  assert.equal(billing.root_review_difference, -250);
  assert.equal(billing.overpaid_amount, 250);
  assert.equal(billing.extension_outstanding_amount, 1600);
  assert.equal(billing.outstanding_amount, 1600); // No automatic 250 credit or 1,350 collection.
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(1350)));
  await assert.rejects(confirmCollection(ctx.db, ROOT, STAFF, body(1600)));
  assert.deepEqual(payments(ctx), ledger);
});

test('a modern receipt cannot turn a partially paid original into an automatic legacy reprice exception', async () => {
  const ctx = setup();
  const requestId = crypto.randomUUID();
  ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, status, prepaid_amount, final_amount, price_per_day)
    VALUES (?, 'PAYMENT_PENDING', 9000, 9000, 1600)`).run(ROOT);
  ctx.sqlite.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details)
    VALUES (?, ?, ?, 'CONFIRM_COLLECTION', '{}')`).run(ROOT, STAFF, requestId);
  ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id, recorded_at, receipt_request_id)
    VALUES (?, '2026-10-20', 'CASH', 8550, ?, '2026-10-20 01:00:00', ?)`).run(ROOT, STAFF, requestId);
  // Simulate a legacy/out-of-band wrong status flag without deleting or editing the real receipt.
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAID' WHERE order_id = ?").run(ROOT);
  ctx.sqlite.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details, timestamp)
    VALUES (?, ?, 'UPDATE_PRICE', ?, '2026-10-20 02:00:00')`).run(ROOT, STAFF, JSON.stringify({
    before: { prepaid_amount: 8550, final_amount: 8550, extra_amount: 0 }, after: { finalAmount: 9000 },
  }));
  const billing = (await getBillingSummary(ctx.db, ROOT))!;
  assert.equal(billing.root_review_amount, 450);
  assert.equal(billing.root_review_reason, 'UNVERIFIED_ROOT_DIFFERENCE');
  assert.equal(billing.review_pickup_blocked, 1);
  assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/pickup`, {})).status, 409);
  assert.equal(payments(ctx).length, 1);
});

test('92 picked-up original mismatches totalling ¥76,009 remain read-only reconciliation history', async () => {
  const ctx = setup(undefined, 'admin');
  for (let i = 0; i < 92; i++) seedRootReview(ctx, {
    id: `20261020-${String(i + 1).padStart(3, '0')}`, status: 'PICKED_UP', evidence: 'text', paid: 9000 - (i === 91 ? 3209 : 800),
  });
  const orders = ctx.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all();
  const ledger = payments(ctx);
  const logs = ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id').all();
  const review = ctx.sqlite.prepare('SELECT COUNT(*) AS n, SUM(root_review_amount) AS amount, SUM(collectible_amount) AS due FROM luggage_billing_lines WHERE root_review_required = 1').get()!;
  assert.deepEqual([review.n, review.amount, review.due], [92, 76009, 0]);
  const response = await ctx.app.request('/staff/admin/billing-reviews', {}, ctx.env);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /총 92건/);
  assert.match(html, /76,009/);
  assert.doesNotMatch(html, /action="[^"]*(confirm-collection|update-price|waive|refund)/);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all(), orders);
  assert.deepEqual(payments(ctx), ledger);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id').all(), logs);
  const editor = setup();
  assert.equal((await editor.app.request('/staff/admin/billing-reviews', {}, editor.env)).status, 403);
});

test('ledger-backed price edits return an explicit review conflict; method-only edits never change money or cash closing', async () => {
  const ctx = setup(); seedRootReview(ctx);
  const ledger = payments(ctx);
  const financials = () => ctx.sqlite.prepare(`SELECT prepaid_amount, final_amount, extra_amount,
    staff_prepaid_override_amount, discount_rate, flying_pass_tier, flying_pass_discount_amount
    FROM luggage_orders WHERE order_id = ?`).get(ROOT)!;
  const originalFinancials = financials();
  const logCount = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n;
  const staff = await post(ctx, `/staff/api/orders/${ROOT}/update-price`, { staff_prepaid_override_amount: 8800, payment_method: 'CASH' });
  assert.equal(staff.status, 409);
  assert.equal((await staff.json() as { code: string }).code, 'COLLECTED_PRICE_REVIEW_REQUIRED');
  const url = `https://internal.invalid/internal/luggage-orders/${ROOT}/price`;
  // Unlike pickup-status, /price uses the shared note actor contract and requires email.
  const actor = { userId: 'price-user', name: 'Price Tester', email: 'price-editor@example.test', role: 'center_staff' };
  const callPrice = async (payload: Record<string, unknown>, secret = SECRET) => {
    const raw = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const { signature } = await signInternalRequest({ method: 'PATCH', url, body: raw, secret, timestamp });
    return ctx.app.request(url, { method: 'PATCH', headers: {
      'Content-Type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature,
    }, body: raw }, ctx.env);
  };
  const { email: _email, ...withoutEmail } = actor;
  const missingEmail = await callPrice({ staffPrepaidOverrideAmount: 8800, actor: withoutEmail });
  assert.equal(missingEmail.status, 400);
  assert.equal((await missingEmail.json() as { error: string }).error, 'actor.email is required');
  for (const payload of [
    { staffPrepaidOverrideAmount: 8800, actor: { ...actor, role: 'viewer' } },
    { staffPrepaidOverrideAmount: 8800.5, actor },
    { paymentMethod: 'MIXED', actor },
  ]) {
    const invalid = await callPrice(payload);
    const error = await invalid.json() as { error: string; code?: string };
    assert.equal(invalid.status, 400, JSON.stringify(error));
    assert.notEqual(error.code, 'COLLECTED_PRICE_REVIEW_REQUIRED');
  }
  const validPriceRequest = { staffPrepaidOverrideAmount: 8800, actor };
  assert.equal((await callPrice(validPriceRequest, 'wrong-secret')).status, 401);
  const internal = await callPrice(validPriceRequest);
  const conflict = await internal.json() as { code: string; error?: string };
  assert.equal(internal.status, 409, JSON.stringify(conflict));
  assert.equal(conflict.code, 'COLLECTED_PRICE_REVIEW_REQUIRED');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n, logCount);
  assert.deepEqual(payments(ctx), ledger);
  const metadata = await post(ctx, `/staff/api/orders/${ROOT}/update-price`, { payment_method: 'PAY_QR' });
  assert.equal(metadata.status, 200);
  const order = financials();
  assert.deepEqual(order, originalFinancials);
  assert.deepEqual([order.prepaid_amount, order.final_amount, order.staff_prepaid_override_amount, order.discount_rate], [9000, 9000, 9000, 0.05]);
  assert.equal(ctx.sqlite.prepare('SELECT payment_method FROM luggage_orders WHERE order_id = ?').get(ROOT)!.payment_method, 'PAY_QR');
  // Exercise the same method-only contract through the signed internal endpoint.
  const internalMetadata = await callPrice({ paymentMethod: 'CASH', actor });
  const methodResult = await internalMetadata.json() as { paymentMethod?: string; error?: string };
  assert.equal(internalMetadata.status, 200, JSON.stringify(methodResult));
  assert.equal(methodResult.paymentMethod, 'CASH');
  assert.deepEqual(financials(), originalFinancials);
  assert.deepEqual(payments(ctx), ledger);
  const closing = (await resolveAutoSalesSummaryForDate(ctx.db, '2026-10-20'))!;
  assert.equal(closing.cashAmount, 8550);
  assert.equal(closing.qrAmount, 0);
  assert.equal((await getBillingSummary(ctx.db, ROOT))!.root_review_amount, 450);
});

test('a receipt arriving during price correction is preserved and the guarded transaction creates no price audit', async () => {
  const ctx = setup(); seedRoot(ctx, { status: 'PAYMENT_PENDING', billed: 8550, daysAgo: 0 });
  const batch = ctx.db.batch.bind(ctx.db);
  ctx.db.batch = async statements => {
    ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id)
      VALUES (?, date('now', '+9 hours'), 'CASH', 8550, ?)`).run(ROOT, STAFF);
    return batch(statements);
  };
  const result = await post(ctx, `/staff/api/orders/${ROOT}/update-price`, { staff_prepaid_override_amount: 9000, payment_method: 'CASH' });
  assert.equal(result.status, 409);
  assert.equal((await result.json() as { code: string }).code, 'COLLECTED_PRICE_REVIEW_REQUIRED');
  assert.equal(ctx.sqlite.prepare('SELECT final_amount FROM luggage_orders WHERE order_id = ?').get(ROOT)!.final_amount, 8550);
  assert.equal(payments(ctx).length, 1);
  assert.equal(payments(ctx)[0].amount, 8550);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'UPDATE_PRICE'").get()!.n, 0);
});

test('prepared policy upgrade preserves claim/receipt/audit rows and matches all fresh-schema financial guards', () => {
  const ctx = setup(false, 'editor', false); seedRootReview(ctx, { status: 'PICKED_UP', evidence: 'text' });
  const orders = ctx.sqlite.prepare('SELECT * FROM luggage_orders').all();
  const ledger = payments(ctx);
  const logs = ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs').all();
  const schema = readFileSync('src/schema.sql', 'utf8').split('-- Flying Pass phase 2:')[0].trimEnd() + '\n';
  const upgrade = readFileSync('migrations/20261026_root_settlement_review.sql', 'utf8');
  const start = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_luggage_extension_date';
  assert.equal(upgrade.slice(upgrade.indexOf(start)).trim(), schema.slice(schema.indexOf(start), schema.indexOf("-- 21:00 JST automatic extension cutover")).trim());
  const definitions = () => ctx.sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name").all();
  const fresh = setup(false);
  const expected = fresh.sqlite.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name").all();
  ctx.sqlite.exec(upgrade);
  ctx.sqlite.exec("DROP TABLE luggage_automatic_billing_policy");
  ctx.sqlite.exec(readFileSync('migrations/20261028_close_time_extension.sql', 'utf8'));
  ctx.sqlite.exec(readFileSync('migrations/20261028_confirmed_intake_extension.sql', 'utf8'));
  ctx.sqlite.exec(readFileSync('migrations/20261028_flying_pass_refund_settlement.sql', 'utf8'));
  ctx.sqlite.exec(readFileSync('migrations/20261029_087_discount_correction.sql', 'utf8'));
  // The handover/late-confirm migration replaces the sales view and two closing triggers (refund attribution by payout day).
  ctx.sqlite.exec(readFileSync('migrations/20261029_flying_pass_refund_handover.sql', 'utf8'));
  assert.deepEqual(definitions(), expected);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_orders').all(), orders);
  assert.deepEqual(payments(ctx), ledger);
  assert.deepEqual(ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs').all(), logs);
  assert.equal(ctx.sqlite.prepare('SELECT root_review_amount FROM luggage_billing_balances WHERE root_id = ?').get(ROOT)!.root_review_amount, 450);
});

// Exercise the actual routers, including the HTML redirect contract and signed internal transport.
type PickupHttpKind = 'json' | 'html' | 'internal';
async function pickupHttp(ctx: Fixture, kind: PickupHttpKind, undo = false, overrides: Record<string, unknown> = {}) {
  if (kind === 'internal') return internalPickup(ctx, {
    ...pickupPayload(ctx), action: undo ? 'undo_picked_up' : 'mark_picked_up', ...overrides,
  });
  return post(ctx, kind === 'json'
    ? `/staff/api/orders/${ROOT}/${undo ? 'undo-pickup' : 'pickup'}`
    : `/staff/orders/${ROOT}/${undo ? 'undo-picked-up' : 'mark-picked-up'}`, {});
}
function pickupMoney(ctx: Fixture) {
  return {
    ledger: payments(ctx),
    claims: ctx.sqlite.prepare(`SELECT order_id, parent_order_id, extension_date, prepaid_amount, final_amount,
      extra_amount, price_per_day, discount_rate, staff_prepaid_override_amount, payment_method
      FROM luggage_orders ORDER BY order_id`).all(),
  };
}
function pickupState(ctx: Fixture) {
  return {
    orders: ctx.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all(),
    ledger: payments(ctx), audits: ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id').all(),
  };
}
async function seedCollectedPickupFamily(ctx: Fixture) {
  seedRoot(ctx);
  await confirmCollection(ctx.db, ROOT, STAFF, body());
  return String(ctx.sqlite.prepare('SELECT order_id FROM luggage_orders WHERE parent_order_id = ?').get(ROOT)!.order_id);
}
function assertPickupHttp(response: Response, kind: PickupHttpKind, success: boolean) {
  assert.equal(response.status, kind === 'html' ? 302 : success ? 200 : 409);
  if (kind === 'html') assert.equal(response.headers.get('location')!.includes('?error='), !success);
}

for (const kind of ['json', 'html', 'internal'] as const) {
  test(`${kind} HTTP pickup/undo keeps family timestamps, audited before images and all money intact`, async () => {
    const ctx = setup();
    const child = await seedCollectedPickupFamily(ctx);
    ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, parent_order_id, status, final_amount, prepaid_amount)
      VALUES ('cancelled-draft', ?, 'CANCELLED', 0, 0)`).run(ROOT);
    const cancelled = ctx.sqlite.prepare("SELECT * FROM luggage_orders WHERE order_id = 'cancelled-draft'").get();
    const money = pickupMoney(ctx);
    const collectionLogs = ctx.sqlite.prepare("SELECT * FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION'").all();
    const count = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n;
    const previous = ctx.sqlite.prepare('SELECT updated_at FROM luggage_orders WHERE order_id = ?').get(ROOT)!.updated_at;
    assertPickupHttp(await pickupHttp(ctx, kind), kind, true);
    const picked = ctx.sqlite.prepare('SELECT status, actual_pickup_at, updated_at FROM luggage_orders WHERE order_id IN (?, ?) ORDER BY order_id').all(ROOT, child);
    assert.ok(picked.every(row => row.status === 'PICKED_UP' && row.actual_pickup_at && row.actual_pickup_at === picked[0].actual_pickup_at));
    assert.notEqual(picked[0].updated_at, previous);
    const log = ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id DESC LIMIT 1').get()!;
    const details = JSON.parse(String(log.details));
    assert.equal(details.pickupTransition.action, 'mark_picked_up');
    assert.equal(details.pickupTransition.before.find((row: { order_id: string }) => row.order_id === child).status, 'PAID');
    assert.equal(log.staff_id, kind === 'internal' ? null : STAFF);
    if (kind === 'internal') assert.equal(details.actor.userId, 'pickup-user');
    assert.deepEqual(pickupMoney(ctx), money);
    assertPickupHttp(await pickupHttp(ctx, kind, true), kind, true);
    const undone = ctx.sqlite.prepare('SELECT status, actual_pickup_at, actual_storage_days, extra_days FROM luggage_orders WHERE order_id IN (?, ?)').all(ROOT, child);
    assert.ok(undone.every(row => row.status === 'PAID' && row.actual_pickup_at === null && row.actual_storage_days === 0 && row.extra_days === 0));
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n, Number(count) + 2);
    assert.deepEqual(pickupMoney(ctx), money);
    assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM luggage_orders WHERE order_id = 'cancelled-draft'").get(), cancelled);
    assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION'").all(), collectionLogs);
    assert.equal((await getBillingSummary(ctx.db, ROOT))!.outstanding_amount, 0);
  });

  test(`${kind} HTTP pickup and undo roll back on rejected or silently skipped audit writes`, async () => {
    for (const undo of [false, true]) for (const mode of ['ABORT', 'IGNORE']) {
      const ctx = setup(); await seedCollectedPickupFamily(ctx);
      if (undo) assertPickupHttp(await pickupHttp(ctx, kind), kind, true);
      ctx.sqlite.exec(`CREATE TRIGGER fail_pickup_audit BEFORE INSERT ON luggage_audit_logs
        WHEN NEW.action IN ('PICKUP', 'UNDO_PICKUP', 'MARK_PICKED_UP', 'UNDO_PICKED_UP', 'UNIFIED_ADMIN_PICKUP_STATUS_UPDATE')
        BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'test audit failure'" : ''}); END;`);
      const before = pickupState(ctx);
      const response = await pickupHttp(ctx, kind, undo);
      assert.equal(response.status, 500, `${kind}, undo=${undo}, mode=${mode}`);
      assert.match(kind === 'html' ? await response.text() : (await response.json() as { error: string }).error, /audit log/);
      assert.deepEqual(pickupState(ctx), before);
    }
  });

  test(`${kind} HTTP pickup and undo roll back root and audit when a child write fails`, async () => {
    for (const undo of [false, true]) {
      const ctx = setup(); await seedCollectedPickupFamily(ctx);
      if (undo) assertPickupHttp(await pickupHttp(ctx, kind), kind, true);
      ctx.sqlite.exec(`CREATE TRIGGER fail_child_pickup BEFORE UPDATE OF status ON luggage_orders
        WHEN OLD.parent_order_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test child write failure'); END;`);
      const before = pickupState(ctx);
      assert.equal((await pickupHttp(ctx, kind, undo)).status, 500);
      assert.deepEqual(pickupState(ctx), before);
    }
  });

  test(`${kind} HTTP duplicate/concurrent pickups and undos produce exactly one event per transition`, async () => {
    const ctx = setup(); await seedCollectedPickupFamily(ctx);
    for (const undo of [false, true]) {
      const before = Number(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n);
      const results = await Promise.all([pickupHttp(ctx, kind, undo), pickupHttp(ctx, kind, undo)]);
      if (kind === 'html') {
        assert.equal(results.filter(response => !response.headers.get('location')!.includes('?error=')).length, 1);
      } else assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
      const state = pickupState(ctx);
      assertPickupHttp(await pickupHttp(ctx, kind, undo), kind, false);
      assert.deepEqual(pickupState(ctx), state);
      assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n, before + 1);
    }
  });

  test(`${kind} HTTP keeps unpaid-extension pickup and historical-review undo blocked without altering claims`, async () => {
    const debt = setup(); seedRoot(debt);
    await materializeOutstandingDays(debt.db, ROOT);
    const beforeDebt = pickupState(debt);
    assertPickupHttp(await pickupHttp(debt, kind), kind, false);
    assert.deepEqual(pickupState(debt), beforeDebt);
    const review = setup(); seedRootReview(review, { status: 'PICKED_UP', evidence: 'verified' });
    const beforeReview = pickupState(review);
    assertPickupHttp(await pickupHttp(review, kind, true), kind, false);
    assert.deepEqual(pickupState(review), beforeReview);
    assert.equal((await getBillingSummary(review.db, ROOT))!.root_review_amount, 450);
  });
}

test('signed HTTP stale snapshot and same-second ABA retries cannot reapply a pickup', async () => {
  const ctx = setup(); seedRoot(ctx, { daysAgo: 0 });
  const first = pickupPayload(ctx);
  assert.equal((await internalPickup(ctx, first)).status, 200);
  assert.equal((await pickupHttp(ctx, 'internal', true)).status, 200);
  const before = pickupState(ctx);
  assert.equal((await internalPickup(ctx, first)).status, 409);
  assert.deepEqual(pickupState(ctx), before);
});

test('HTTP undo refuses mismatched child pickup time and legacy families without a before image', async () => {
  const ctx = setup(); const child = await seedCollectedPickupFamily(ctx);
  assert.equal((await pickupHttp(ctx, 'json')).status, 200);
  ctx.sqlite.prepare("UPDATE luggage_orders SET actual_pickup_at = '2026-01-01T00:00:00Z' WHERE order_id = ?").run(child);
  const mismatched = pickupState(ctx);
  assert.equal((await pickupHttp(ctx, 'json', true)).status, 409);
  assert.deepEqual(pickupState(ctx), mismatched);
  const legacy = setup(); await seedCollectedPickupFamily(legacy);
  // Actual DB pickup trigger preserves family timestamps, but old code wrote no recoverable before image.
  legacy.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP', actual_pickup_at = datetime('now') WHERE order_id = ?").run(ROOT);
  const before = pickupState(legacy);
  assert.equal((await pickupHttp(legacy, 'internal', true)).status, 409);
  assert.deepEqual(pickupState(legacy), before);
});

test('HTTP pickup detects a linked-order race before writing any state or event', async () => {
  const ctx = setup(); const child = await seedCollectedPickupFamily(ctx);
  const batch = ctx.db.batch.bind(ctx.db);
  ctx.db.batch = async statements => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET updated_at = '2099-01-01 00:00:00' WHERE order_id = ?").run(child);
    return batch(statements);
  };
  const money = pickupMoney(ctx);
  const count = ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n;
  assert.equal((await pickupHttp(ctx, 'internal')).status, 409);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT)!.status, 'PAID');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get()!.n, count);
  assert.deepEqual(pickupMoney(ctx), money);
});

test('pickup/undo preserves staff roles, internal HMAC and actor/input validation', async () => {
  const ctx = setup(undefined, 'viewer'); seedRoot(ctx, { daysAgo: 0 });
  const before = pickupState(ctx);
  assert.equal((await pickupHttp(ctx, 'json')).status, 403);
  assert.equal((await pickupHttp(ctx, 'json', true)).status, 403);
  assert.equal((await pickupHttp(ctx, 'html')).status, 403);
  assert.equal((await pickupHttp(ctx, 'html', true)).status, 403);
  assert.equal((await internalPickup(ctx, pickupPayload(ctx), 'wrong-secret')).status, 401);
  assert.equal((await pickupHttp(ctx, 'internal', false, { expectedUpdatedAt: undefined })).status, 400);
  assert.equal((await pickupHttp(ctx, 'internal', false, { actor: { userId: 'viewer', name: 'Viewer', role: 'viewer' } })).status, 400);
  assert.deepEqual(pickupState(ctx), before);
});

// Read-path regression fixtures: historical end states only, never bypass the financial guards.
function seedReadOrders(ctx: Fixture, count: number): string[] {
  const ids = Array.from({ length: count }, (_, i) => `20261020-${String(i + 1).padStart(6, '0')}`);
  const order = ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, created_at, name, expected_pickup_at,
    expected_storage_days, price_per_day, prepaid_amount, final_amount, status)
    VALUES (?, '2026-10-20T00:00:00Z', 'Boundary Guest', date('now', '+9 hours') || 'T12:00:00Z', 1, 1600, 1600, 1600, 'PAID')`);
  const receipt = ctx.sqlite.prepare(`INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id)
    VALUES (?, '2026-10-20', 'CASH', 1600, ?)`);
  for (const id of ids) { order.run(id); receipt.run(id, STAFF); }
  return ids;
}

function readSnapshot(ctx: Fixture) {
  return {
    orders: ctx.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all(),
    receipts: payments(ctx),
    audits: ctx.sqlite.prepare('SELECT * FROM luggage_audit_logs ORDER BY log_id').all(),
  };
}

function formerBillingRows(ctx: Fixture, ids: string[]) {
  const rows: Array<Record<string, unknown>> = [];
  const uniqueIds = [...new Set(ids)];
  for (let i = 0; i < uniqueIds.length; i += 75) {
    const part = uniqueIds.slice(i, i + 75);
    rows.push(...ctx.sqlite.prepare(`SELECT o.order_id AS requested_order_id, b.* FROM luggage_orders o
      JOIN luggage_billing_balances b ON b.root_id = COALESCE(o.parent_order_id, o.order_id)
      WHERE o.order_id IN (${part.map(() => '?').join(',')})`).all(...part));
  }
  return new Map(rows.map(row => [String(row.requested_order_id), { ...row }]));
}

test('scoped billing preserves every former column for paid, unpaid-extension, review, combined and mixed child reads', async () => {
  const ctx = setup(); seedRoot(ctx);
  const normal = seedReadOrders(ctx, 1)[0];
  const review = seedRootReview(ctx, { id: '20261020-900001', evidence: 'none' });
  const combined = seedRootReview(ctx, { id: '20261020-900002', evidence: 'none', overdue: true });
  await materializeOutstandingDays(ctx.db, ROOT);
  await materializeOutstandingDays(ctx.db, combined);
  const child = String(ctx.sqlite.prepare('SELECT order_id FROM luggage_orders WHERE parent_order_id = ?').get(ROOT)!.order_id);
  const combinedChild = String(ctx.sqlite.prepare('SELECT order_id FROM luggage_orders WHERE parent_order_id = ?').get(combined)!.order_id);
  ctx.sqlite.exec(`INSERT INTO luggage_orders(order_id, status, expected_pickup_at, price_per_day, prepaid_amount, final_amount)
    VALUES ('legacy-read', 'PAID', datetime('now', '+1 day'), 700, 700, 700),
      ('free-read', 'PAYMENT_PENDING', datetime('now', '+1 day'), 0, 0, 0),
      ('cancelled-read', 'CANCELLED', datetime('now', '+1 day'), 0, 0, 0)`);
  const ids = [combinedChild, ROOT, normal, review, child, combined, 'missing-read', ROOT, 'legacy-read', 'free-read', 'cancelled-read'];
  const before = readSnapshot(ctx);
  const expected = formerBillingRows(ctx, ids);
  const actual = await getBillingSummaries(ctx.db, ids);
  assert.deepEqual([...actual.keys()], [...new Set(ids)].filter(id => expected.has(id)));
  for (const [id, row] of actual) {
    assert.deepEqual({ ...row }, expected.get(id), id);
    const { requested_order_id: _requested, ...billing } = { ...row } as Record<string, unknown>;
    assert.deepEqual(billing, { ...await getBillingSummary(ctx.db, id) }, id);
  }
  assert.equal(actual.get(normal)!.outstanding_amount, 0);
  assert.equal(actual.get(ROOT)!.extension_outstanding_amount, 1600);
  assert.equal(actual.get(review)!.root_review_amount, 450);
  assert.equal(actual.get(review)!.outstanding_amount, 0);
  assert.equal(actual.get(review)!.review_pickup_blocked, 1);
  assert.equal(actual.get(combined)!.root_review_amount, 450);
  assert.equal(actual.get(combined)!.extension_outstanding_amount, 1600);
  assert.equal(actual.get(combined)!.outstanding_amount, 1600);
  assert.equal(actual.get('legacy-read')!.recorded_amount, 0);
  assert.equal(actual.get('legacy-read')!.legacy_paid_estimate, 700);
  assert.equal(actual.get('free-read')!.outstanding_amount, 0);
  assert.equal(await getBillingSummary(ctx.db, 'missing-read'), null);
  assert.equal(await getBillingSummary(ctx.db, 'cancelled-read'), null);
  assert.deepEqual(readSnapshot(ctx), before);
});

test('billing reads skip empty input, deduplicate IDs and stay below D1 binds at 100/101/500 and beyond', async () => {
  const ctx = setup(); const ids = seedReadOrders(ctx, 501);
  assert.equal((await getBillingSummaries(ctx.db, [])).size, 0);
  assert.equal(ctx.queries.length, 0);
  const before = readSnapshot(ctx);
  for (const count of [100, 101, 500, 501]) {
    ctx.queries.length = 0;
    const requested = [...ids.slice(0, count).reverse(), ids[0], 'missing-read', ids[0]];
    const rows = await getBillingSummaries(ctx.db, requested);
    assert.deepEqual([...rows.keys()], [...new Set(requested)].filter(id => id !== 'missing-read'));
    const expected = formerBillingRows(ctx, requested);
    for (const [id, row] of rows) assert.deepEqual({ ...row }, expected.get(id));
    assert.ok(ctx.queries.every(q => q.bindings <= 75));
    assert.ok(ctx.queries.every(q => !/IN\s*\(\s*\)/i.test(q.sql)));
  }
  ctx.queries.length = 0;
  assert.equal((await getBillingSummaries(ctx.db, Array(500).fill(ids[0]))).size, 1);
  assert.equal(ctx.queries.length, 2, 'a repeated ID resolves and reads its family once');
  assert.deepEqual(readSnapshot(ctx), before);
});

test('scoped reads preserve 366 historical/current reviews and ¥348,839 without changing any ledger or audit', async () => {
  const ctx = setup();
  const ids = [seedRootReview(ctx, { evidence: 'text' })];
  for (let i = 0; i < 365; i++) ids.push(seedRootReview(ctx, {
    id: `20261020-${String(910000 + i)}`, status: 'PICKED_UP', evidence: 'text', paid: 9000 - (i === 364 ? 2589 : 950),
  }));
  const before = readSnapshot(ctx);
  const expected = formerBillingRows(ctx, ids);
  const rows = await getBillingSummaries(ctx.db, ids.reverse());
  assert.equal(rows.size, 366);
  assert.equal([...rows.values()].reduce((sum, row) => sum + row.root_review_amount, 0), 348839);
  for (const [id, row] of rows) {
    assert.deepEqual({ ...row }, expected.get(id));
    assert.equal(row.root_review_required, 1);
    assert.equal(row.review_pickup_blocked, 1);
    assert.equal(row.outstanding_amount, 0);
  }
  assert.deepEqual(readSnapshot(ctx), before);
});

type ReadList = {
  orders: Array<{ orderId: string; billing: { outstanding_amount: number } | null;
    extensions: Array<{ orderId: string; parentOrderId: string }> }>;
  total: number; limit: number; offset: number;
  statusCounts: { paid: number; paymentPending: number; pickedUp: number; cancelled: number };
};
async function internalList(ctx: Fixture, query: string): Promise<ReadList> {
  const url = `https://internal.invalid/internal/luggage-orders?${query}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ method: 'GET', body: '', secret: SECRET, timestamp, url });
  const response = await ctx.app.request(url, { headers: { 'x-internal-timestamp': timestamp, 'x-internal-signature': signature } }, ctx.env);
  assert.equal(response.status, 200);
  return response.json() as Promise<ReadList>;
}

test('signed list returns 100/101/500 rows with full extension ordering, pagination/search/counts and the existing >500 clamp', async () => {
  const ctx = setup(); const ids = seedReadOrders(ctx, 505);
  const insert = ctx.sqlite.prepare(`INSERT INTO luggage_orders(order_id, parent_order_id, created_at, name, status,
    expected_pickup_at, expected_storage_days, extension_date, price_per_day, prepaid_amount, final_amount)
    VALUES (?, ?, ?, 'Boundary Guest', 'PAYMENT_PENDING', datetime('now', ?), 1, date('now', '+9 hours', ?), 1600, 1600, 1600)`);
  for (const i of [0, 74, 75, 99, 100, 499]) {
    insert.run(`EXT-${ids[i]}`, ids[i], '2026-10-20T01:00:00Z', '+1 day', '+1 day');
  }
  insert.run('EXT-20261020-999999', ids[499], '2026-10-20T02:00:00Z', '+2 days', '+2 days');
  const before = readSnapshot(ctx);
  for (const limit of [0, 100, 101, 500, 501]) {
    ctx.queries.length = 0;
    const actual = await internalList(ctx, `status=PAID&search=Boundary&dateFrom=2026-10-20&dateTo=2026-10-20&limit=${limit}&offset=2`);
    const capped = Math.min(limit, 500);
    const expected = ctx.sqlite.prepare(`SELECT order_id FROM luggage_orders WHERE status = 'PAID'
      ORDER BY created_at DESC, order_id DESC LIMIT ? OFFSET 2`).all(capped).map(r => r.order_id);
    assert.equal(actual.limit, capped);
    assert.equal(actual.offset, 2);
    assert.equal(actual.total, 505);
    assert.deepEqual(actual.orders.map(o => o.orderId), expected);
    assert.deepEqual(actual.statusCounts, { paid: 505, paymentPending: 7, pickedUp: 0, cancelled: 0 });
    for (const order of actual.orders) {
      const children = ctx.sqlite.prepare(`SELECT order_id FROM luggage_orders WHERE parent_order_id = ?
        ORDER BY created_at DESC, order_id DESC`).all(order.orderId).map(r => r.order_id);
      assert.deepEqual(order.extensions.map(e => e.orderId), children);
      assert.ok(order.extensions.every(e => e.parentOrderId === order.orderId));
      assert.equal(order.billing!.outstanding_amount, children.length * 1600);
    }
    assert.ok(ctx.queries.every(q => q.bindings <= 100));
    const extensionQueries = ctx.queries.filter(q => /WHERE o\.parent_order_id IN/.test(q.sql));
    assert.equal(extensionQueries.length, Math.ceil(capped / 75));
    assert.ok(extensionQueries.every(q => q.bindings <= 75));
  }
  ctx.queries.length = 0;
  const empty = await internalList(ctx, 'search=NoSuchBoundaryGuest&limit=500');
  assert.deepEqual(empty.orders, []);
  assert.equal(empty.total, 0);
  assert.ok(ctx.queries.every(q => !/IN\s*\(\s*\)/i.test(q.sql)));
  assert.deepEqual(readSnapshot(ctx), before);
});

async function internalPaymentStatus(ctx: Fixture, payload: Record<string, unknown>) {
  const url = `https://internal.invalid/internal/luggage-orders/${ROOT}/payment-status`;
  const raw = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ method: 'PATCH', body: raw, secret: SECRET, timestamp, url });
  return ctx.app.request(url, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature }, body: raw,
  }, ctx.env);
}

test('a payment recorded as PAID is never reverted: single and split payments are refused with 409 PAYMENT_REVERT_NOT_ALLOWED and nothing changes (internal and legacy staff paths)', async () => {
  const actor = { userId: 'pay-user', name: 'Pay Tester', email: 'pay@test.local', role: 'center_staff' };
  const snapshot = (ctx: Fixture) => JSON.stringify([
    ctx.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id = ?').get(ROOT),
    payments(ctx),
    ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_audit_logs').get(),
  ]);
  const expectRefused = async (ctx: Fixture, label: string) => {
    const before = snapshot(ctx);
    const internal = await internalPaymentStatus(ctx, { targetStatus: 'PAYMENT_PENDING', actor });
    assert.equal(internal.status, 409, `${label}: internal`);
    assert.equal((await internal.json() as { code?: string }).code, 'PAYMENT_REVERT_NOT_ALLOWED', `${label}: internal code`);
    const staff = await post(ctx, `/staff/api/orders/${ROOT}/toggle-payment`, {});
    assert.equal(staff.status, 409, `${label}: legacy staff toggle`);
    assert.equal((await staff.json() as { code?: string }).code, 'PAYMENT_REVERT_NOT_ALLOWED', `${label}: staff code`);
    assert.equal(snapshot(ctx), before, `${label}: order, payment rows and audit rows are untouched`);
  };

  // single payment row (seedRoot records the receipt for a PAID order)
  const single = setup(); seedRoot(single, { daysAgo: 0 });
  assert.equal(payments(single).length, 1);
  await expectRefused(single, 'single payment row');

  // split cash/QR payment recorded through the real PAYMENT_PENDING → PAID path (two payment rows)
  const split = setup(); seedRoot(split, { daysAgo: 0, status: 'PAYMENT_PENDING' });
  const paid = await internalPaymentStatus(split, { targetStatus: 'PAID', payment: { cashAmount: 1000, qrAmount: 600 }, actor });
  assert.equal(paid.status, 200, 'the PAID transition itself is unchanged');
  assert.equal(payments(split).length, 2);
  await expectRefused(split, 'split payment rows');
});

function ledgerSnapshot(ctx: Fixture) {
  return JSON.stringify([
    ctx.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all(),
    payments(ctx),
    ctx.sqlite.prepare('SELECT order_id, staff_id, action, details FROM luggage_audit_logs ORDER BY log_id').all(),
  ]);
}
const markPaidForm = (ctx: Fixture) => ctx.app.request(`/staff/orders/${ROOT}/mark-paid`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'payment_method=CASH',
}, ctx.env);

test('mark-paid refuses PAID, PICKED_UP and CANCELLED orders and never rewrites a recorded payment; a pending order is marked paid exactly once', async () => {
  // PAID with a recorded payment: the ledger row, the order and the audit trail stay byte-for-byte identical
  const paid = setup(); seedRoot(paid, { daysAgo: 0 });
  const before = ledgerSnapshot(paid);
  const paidRows = payments(paid);
  const res = await markPaidForm(paid);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')!), /error=/);
  assert.equal(ledgerSnapshot(paid), before, 'PAID: payment row is not deleted and re-created');
  assert.deepEqual(payments(paid), paidRows);

  // PICKED_UP / CANCELLED: never revived as PAID, no payment rows created
  for (const status of ['PICKED_UP', 'CANCELLED']) {
    const ctx = setup(); seedRoot(ctx, { daysAgo: 0, status });
    const snapshot = ledgerSnapshot(ctx);
    const refused = await markPaidForm(ctx);
    assert.equal(refused.status, 302, status);
    assert.match(decodeURIComponent(refused.headers.get('location')!), /error=/, status);
    assert.equal(ledgerSnapshot(ctx), snapshot, `${status}: nothing changed`);
  }

  // PAYMENT_PENDING: marked paid once, then a repeated submit changes nothing
  const pending = setup(); seedRoot(pending, { daysAgo: 0, status: 'PAYMENT_PENDING' });
  const first = await markPaidForm(pending);
  assert.equal(first.status, 302);
  assert.doesNotMatch(decodeURIComponent(first.headers.get('location')!), /error=/);
  const row = pending.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT);
  assert.equal(row!.status, 'PAID');
  const recorded = payments(pending);
  assert.equal(recorded.length, 1);
  assert.equal(pending.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE action = 'MARK_PAID'").get()!.n, 1);
  const afterFirst = ledgerSnapshot(pending);
  const repeat = await markPaidForm(pending);
  assert.match(decodeURIComponent(repeat.headers.get('location')!), /error=/);
  assert.equal(ledgerSnapshot(pending), afterFirst, 'repeated mark-paid: same payment_id/recorded_at, no extra audit row');
  assert.deepEqual(payments(pending), recorded);
});

test('payment writes re-check PAYMENT_PENDING where they write: a request whose earlier SELECT is stale (the order was paid in between) changes nothing', async () => {
  // Simulates a concurrent request that completes after this request's SELECT and before its batch.
  const interleave = (ctx: Fixture) => {
    const realBatch = ctx.db.batch.bind(ctx.db);
    let injected = false;
    (ctx.db as unknown as { batch: typeof ctx.db.batch }).batch = (async (statements: D1PreparedStatement[]) => {
      if (!injected) {
        injected = true;
        // same order as the real flow: payment row first, then the status change
        ctx.sqlite.prepare("INSERT INTO luggage_order_payments(order_id, business_date, tender_type, amount, staff_id) VALUES (?, '2026-10-24', 'CASH', 1600, 'other-request')").run(ROOT);
        ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAID' WHERE order_id = ?").run(ROOT);
      }
      return realBatch(statements);
    }) as typeof ctx.db.batch;
  };

  const cases: Array<[string, (ctx: Fixture) => Promise<void>]> = [
    ['mark-paid', async (ctx) => {
      const res = await markPaidForm(ctx);
      assert.equal(res.status, 302);
      assert.match(decodeURIComponent(res.headers.get('location')!), /error=/);
    }],
    ['toggle-payment', async (ctx) => {
      assert.equal((await post(ctx, `/staff/api/orders/${ROOT}/toggle-payment`, { payment_method: 'CASH' })).status, 409);
    }],
    ['bulk mark_paid', async (ctx) => {
      const res = await post(ctx, '/staff/api/orders/bulk-action', { order_ids: [ROOT], action: 'mark_paid', payment_method: 'CASH' });
      assert.equal(res.status, 200);
      assert.equal((await res.json() as { updated: number }).updated, 0);
    }],
  ];
  for (const [label, run] of cases) {
    const ctx = setup(); seedRoot(ctx, { daysAgo: 0, status: 'PAYMENT_PENDING' });
    interleave(ctx);
    await run(ctx);
    const rows = payments(ctx);
    assert.equal(rows.length, 1, `${label}: the other request's payment row is not deleted or duplicated`);
    assert.equal((rows[0] as { staff_id: string }).staff_id, 'other-request', label);
    assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_audit_logs").get()!.n, 0, `${label}: no audit row for the refused write`);
  }
});

test('mark-paid commits the audit row with the payment: a failing audit insert rolls back the payment rows and the status', async () => {
  const ctx = setup(); seedRoot(ctx, { daysAgo: 0, status: 'PAYMENT_PENDING' });
  const before = ledgerSnapshot(ctx);
  ctx.sqlite.exec("CREATE TRIGGER fail_mark_paid_audit BEFORE INSERT ON luggage_audit_logs WHEN NEW.action = 'MARK_PAID' BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
  assert.equal((await markPaidForm(ctx)).status, 500, 'Hono turns the aborted batch into a 500');
  assert.equal(ledgerSnapshot(ctx), before, 'no payment rows, still PAYMENT_PENDING, no audit row');
  ctx.sqlite.exec('DROP TRIGGER fail_mark_paid_audit');
  assert.equal((await markPaidForm(ctx)).status, 302);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM luggage_orders WHERE order_id = ?').get(ROOT)!.status, 'PAID');
});
