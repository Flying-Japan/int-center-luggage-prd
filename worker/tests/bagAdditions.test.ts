import { test } from 'node:test';
import { calculateStorageDays, formatDateJST } from '../src/services/storage';
import { recalculateOrderPrepaid, type FlyingPassTier } from '../src/services/pricing';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { previewBagAddition, registerBagAddition, collectBagAddition } from '../src/services/bagAdditions';
import { previewFlyingPassRefund, registerFlyingPassRefund, finishFlyingPassRefund } from '../src/services/flyingPassRefunds';
import { confirmCollection, getBillingSummary, createDatedExtension } from '../src/services/luggageBilling';
const NOW = new Date('2031-05-10T03:00:00.000Z'), ROOT = '20310510-001', STAFF = 'synthetic-editor';
function setup(options: {
    createdAt?: string;
    pickupAt?: string;
    now?: Date;
    tier?: FlyingPassTier;
} = {}) {
    const sqlite = new DatabaseSync(':memory:'), clock = { value: (options.now ?? NOW).toISOString() };
    sqlite.function('synthetic_now', () => clock.value);
    sqlite.exec(readFileSync('src/schema.sql', 'utf8').replaceAll("'now'", 'synthetic_now()'));
    const created = options.createdAt ?? '2031-05-10T00:00:00Z', pickup = options.pickupAt ?? '2031-05-10T12:00:00Z';
    const days = calculateStorageDays(created, pickup), tier = options.tier ?? 'NONE', price = recalculateOrderPrepaid(800, days, tier);
    sqlite.prepare(`INSERT INTO luggage_orders(order_id,name,status,created_at,updated_at,expected_pickup_at,expected_storage_days,suitcase_qty,backpack_qty,set_qty,price_per_day,prepaid_amount,final_amount,payment_method,flying_pass_tier,flying_pass_discount_amount,discount_rate)
      VALUES(?,'Synthetic fixture','PAID',?,?,?, ?,1,0,0,800,?,?,'CASH',?,?,?)`).run(ROOT, created, new Date(Date.parse(created) + 1000).toISOString(), pickup, days, price.finalPrepaid, price.finalPrepaid, tier, price.flyingPassDiscountAmount, price.discountRate);
    if (price.finalPrepaid > 0)
        sqlite.prepare(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at)VALUES(?,?,'CASH',?,?,?)`).run(ROOT, formatDateJST(created), price.finalPrepaid, STAFF, new Date(Date.parse(created) + 1000).toISOString());
    const ctx = { sqlite, clock, beforeBatch: undefined as undefined | (() => void | Promise<void>), failAt: -1, db: null as unknown as D1Database };
    function prepare(sql: string) { let args: unknown[] = []; return { bind(...v: unknown[]) { args = v; return this; }, async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; }, async run() { const results = sqlite.prepare(sql).all(...args as never[]); return { results, meta: { changes: sqlite.prepare('SELECT changes() n').get()!.n } }; } }; }
    ctx.db = { prepare, async batch(ss: Array<ReturnType<typeof prepare>>) {
            const hook = ctx.beforeBatch;
            ctx.beforeBatch = undefined;
            await hook?.();
            sqlite.exec('BEGIN');
            try {
                const out = [];
                for (let i = 0; i < ss.length; i++) {
                    if (ctx.failAt === i)
                        throw Error('injected write failure');
                    out.push(await ss[i].run());
                }
                sqlite.exec('COMMIT');
                return out;
            }
            catch (e) {
                sqlite.exec('ROLLBACK');
                throw e;
            }
        } } as unknown as D1Database;
    return ctx;
}
const who = { staffId: STAFF, actor: { userId: 'synthetic-user', name: 'Synthetic Editor', email: 'editor@example.test', role: 'center_staff' } };
const rows = (c: ReturnType<typeof setup>, table: string) => c.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const order = (c: ReturnType<typeof setup>) => c.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id=?').get(ROOT)!;
async function input(c: ReturnType<typeof setup>, paid = false) { const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW); return { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 0, backpackAdded: 1, reason: 'Synthetic additional bag', ...(paid ? { payment: { confirmReceived: true as const, cashAmount: 100, qrAmount: 400 } } : {}) }; }
test('additional batch is priced independently of original bags, original claim/receipt immutable and new debt blocks pickup', async () => { const c = setup(), old = rows(c, 'luggage_order_payments')[0], before = order(c); const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW); assert.equal(q.amount, 500); assert.equal(q.billedAfter, 1300); const r = await registerBagAddition(c.db, ROOT, await input(c), who, NOW); assert.equal(r.amount, 500); assert.equal(order(c).prepaid_amount, 800); assert.equal(order(c).final_amount, 800); assert.equal(order(c).suitcase_qty, 1); assert.equal(order(c).backpack_qty, 1); assert.deepEqual(rows(c, 'luggage_order_payments'), [old]); const b = (await getBillingSummary(c.db, ROOT))!; assert.equal(b.total_billed_amount, 1300); assert.equal(b.root_review_required, 0); assert.equal(b.outstanding_amount, 500); assert.throws(() => c.sqlite.exec(`UPDATE luggage_orders SET status='PICKED_UP' WHERE order_id='${ROOT}'`), /Outstanding/); assert.throws(() => c.sqlite.exec(`UPDATE luggage_orders SET final_amount=1300 WHERE order_id='${ROOT}'`)); assert.equal(before.prepaid_amount, order(c).prepaid_amount); c.sqlite.close(); });
test('immediate actual cash/QR split appends receipts, preserves old tender and uses payment JST day', async () => { const c = setup(), old = rows(c, 'luggage_order_payments')[0], x = await input(c, true); await registerBagAddition(c.db, ROOT, x, who, NOW); const p = rows(c, 'luggage_order_payments'); assert.deepEqual(p[0], old); assert.deepEqual(p.slice(1).map(x => [x.tender_type, x.amount, x.business_date]), [['CASH', 100, '2031-05-10'], ['PAY_QR', 400, '2031-05-10']]); assert.equal(order(c).payment_method, 'MIXED'); const b = (await getBillingSummary(c.db, ROOT))!; assert.equal(b.recorded_amount, 1300); assert.equal(b.outstanding_amount, 0); assert.equal(b.invalid_amount, 0); assert.equal(b.root_review_required, 0); c.sqlite.exec(`UPDATE luggage_orders SET status='PICKED_UP' WHERE order_id='${ROOT}'`); assert.equal(order(c).status, 'PICKED_UP'); const again = await registerBagAddition(c.db, ROOT, x, who, NOW); assert.equal(again.replayed, true); assert.equal(rows(c, 'luggage_order_payments').length, 3); await assert.rejects(registerBagAddition(c.db, ROOT, { ...x, reason: 'different' }, who, NOW), /다른 내용/); c.sqlite.close(); });
test('existing collection flow can collect a pending addition without re-creating the charge', async (t) => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); const c = setup(); await registerBagAddition(c.db, ROOT, await input(c), who, NOW); await confirmCollection(c.db, ROOT, STAFF, { request_id: crypto.randomUUID(), confirm_received: 'yes', expected_amount: 500, cash_amount: 500, qr_amount: 0 }); assert.equal(rows(c, 'luggage_bag_additions').length, 1); assert.equal(rows(c, 'luggage_order_payments').length, 2); assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 0); c.sqlite.close(); });
test('registering two sequential additions prices the current total without applying a fixed discount twice', async () => { const c = setup(); await registerBagAddition(c.db, ROOT, await input(c, true), who, NOW); const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, NOW); assert.equal(q.amount, 800); await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic second addition' }, who, NOW); assert.equal(order(c).price_per_day, 2100); assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 800); c.sqlite.close(); });
test('stale revision and a final-close race reject all writes including audit', async () => {
    for (const mutate of [(c: ReturnType<typeof setup>) => c.sqlite.exec(`UPDATE luggage_orders SET updated_at='2031-05-10 02:00:00' WHERE order_id='${ROOT}'`), (c: ReturnType<typeof setup>) => c.sqlite.exec("INSERT INTO luggage_cash_closings(business_date,closing_type,workflow_status)VALUES('2031-05-10','FINAL_CLOSE','SUBMITTED')")]) {
        const c = setup(), x = await input(c, true);
        c.beforeBatch = () => mutate(c);
        await assert.rejects(registerBagAddition(c.db, ROOT, x, who, NOW));
        assert.equal(rows(c, 'luggage_bag_additions').length, 0);
        assert.equal(rows(c, 'luggage_audit_logs').length, 0);
        assert.equal(rows(c, 'luggage_order_payments').length, 1);
        assert.equal(order(c).backpack_qty, 0);
        c.sqlite.close();
    }
});
test('all transaction interruption points and ignored audit/addition writes roll back', async () => {
    for (const failAt of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const c = setup(), x = await input(c, true), before = order(c), p = rows(c, 'luggage_order_payments');
        c.failAt = failAt;
        await assert.rejects(registerBagAddition(c.db, ROOT, x, who, NOW));
        assert.deepEqual(order(c), before);
        assert.deepEqual(rows(c, 'luggage_order_payments'), p);
        assert.equal(rows(c, 'luggage_bag_additions').length, 0);
        assert.equal(rows(c, 'luggage_audit_logs').length, 0);
        c.sqlite.close();
    }
    for (const table of ['luggage_audit_logs', 'luggage_bag_additions']) {
        const c = setup(), x = await input(c);
        c.sqlite.exec(`CREATE TRIGGER silently_ignore BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END;`);
        await assert.rejects(registerBagAddition(c.db, ROOT, x, who, NOW));
        assert.equal(rows(c, 'luggage_bag_additions').length, 0);
        assert.equal(rows(c, 'luggage_audit_logs').length, 0);
        c.sqlite.close();
    }
});
test('inconsistent periods and paid-up manual overrides, refunds, picked-up and linked orders fail without guessing money', async () => {
    for (const sql of ["UPDATE luggage_orders SET expected_storage_days=3", "UPDATE luggage_orders SET staff_prepaid_override_amount=800", "UPDATE luggage_orders SET status='PICKED_UP'", `INSERT INTO luggage_orders(order_id,parent_order_id,status,prepaid_amount,final_amount,price_per_day,expected_storage_days,created_at,extension_date) VALUES('EXT-20310511-001','${ROOT}','PAYMENT_PENDING',800,800,800,1,'2031-05-10 00:00:00','2031-05-11')`]) {
        const c = setup();
        c.sqlite.exec(sql);
        await assert.rejects(previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW));
        assert.equal(rows(c, 'luggage_bag_additions').length, 0);
        c.sqlite.close();
    }
});
test('invalid quantities, tender allocation and mismatched fingerprints cannot create a charge', async () => {
    const c = setup();
    for (const n of [-1, 0.5, 100, NaN])
        await assert.rejects(previewBagAddition(c.db, ROOT, { suitcaseAdded: n, backpackAdded: 1 }, NOW));
    const x = await input(c, true);
    await assert.rejects(registerBagAddition(c.db, ROOT, { ...x, payment: { confirmReceived: true, cashAmount: 100, qrAmount: 299 } }, who, NOW));
    await assert.rejects(registerBagAddition(c.db, ROOT, { ...x, expectedFingerprint: '0'.repeat(64) }, who, NOW));
    assert.equal(rows(c, 'luggage_bag_additions').length, 0);
    c.sqlite.close();
});
const refundWho = { actor: { userId: 'synthetic-user', name: 'Synthetic Editor', email: 'editor@example.test', role: 'center_staff' as const }, staff: { id: STAFF, displayName: 'Synthetic Editor', email: 'editor@example.test', role: 'editor' as const } };
async function refund(c: ReturnType<typeof setup>, tier: 'BLUE' | 'SILVER' | 'BLACK') { const q = await previewFlyingPassRefund(c.db, ROOT, tier, NOW); const id = crypto.randomUUID(); await registerFlyingPassRefund(c.db, ROOT, { refundId: id, targetTier: tier, reason: 'Synthetic discount refund', expectedFingerprint: q.fingerprint }, refundWho, NOW); await finishFlyingPassRefund(c.db, ROOT, id, { action: 'confirm', cashPaid: true, expectedAmount: q.amount }, refundWho, NOW); return q; }
test('refund after a paid addition includes the added amount once and retains every original receipt', async () => { const c = setup(); await registerBagAddition(c.db, ROOT, await input(c, true), who, NOW); const old = rows(c, 'luggage_order_payments'); const q = await refund(c, 'BLUE'); assert.equal(q.originalAmount, 1300); assert.equal(q.amount, 200); assert.equal(q.afterAmount, 1100); assert.deepEqual(rows(c, 'luggage_order_payments'), old); const b = (await getBillingSummary(c.db, ROOT))!; assert.equal(b.net_received_amount, 1100); assert.equal(b.total_effective_billed_amount, 1100); assert.equal(b.invalid_amount, 0); assert.equal(b.outstanding_amount, 0); c.sqlite.close(); });
test('an addition after a confirmed discount preserves the paid refund and does not repeat its discount', async () => { const c = setup(); await refund(c, 'BLUE'); const history = rows(c, 'luggage_flying_pass_refunds'); const x = await input(c, true); await registerBagAddition(c.db, ROOT, x, who, NOW); assert.deepEqual(rows(c, 'luggage_flying_pass_refunds'), history); const b = (await getBillingSummary(c.db, ROOT))!; assert.equal(b.recorded_amount, 1300); assert.equal(b.net_received_amount, 1100); assert.equal(b.total_effective_billed_amount, 1100); assert.equal(b.outstanding_amount, 0); const q = await refund(c, 'SILVER'); assert.equal(q.originalAmount, 1300); assert.equal(q.amount, 100); assert.equal((await getBillingSummary(c.db, ROOT))!.net_received_amount, 1000); c.sqlite.close(); });
test('a pending cash refund blocks bag registration and full BLACK refund covers a settled added bag', async () => { const c = setup(); const q = await previewFlyingPassRefund(c.db, ROOT, 'BLUE', NOW); const id = crypto.randomUUID(); await registerFlyingPassRefund(c.db, ROOT, { refundId: id, targetTier: 'BLUE', reason: 'Synthetic pending', expectedFingerprint: q.fingerprint }, refundWho, NOW); await assert.rejects(previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW)); assert.equal(rows(c, 'luggage_bag_additions').length, 0); c.sqlite.close(); const d = setup(); await registerBagAddition(d.db, ROOT, await input(d, true), who, NOW); const full = await refund(d, 'BLACK'); assert.equal(full.amount, 1300); const b = (await getBillingSummary(d.db, ROOT))!; assert.equal(b.net_received_amount, 0); assert.equal(b.total_effective_billed_amount, 0); assert.equal(b.invalid_amount, 0); assert.equal(b.outstanding_amount, 0); d.sqlite.close(); });
test('original order, old/new receipts, addition event and audit cannot be replaced or erased', async () => {
    const c = setup();
    await registerBagAddition(c.db, ROOT, await input(c, true), who, NOW);
    for (const sql of [
        `DELETE FROM luggage_orders WHERE order_id='${ROOT}'`,
        `INSERT OR REPLACE INTO luggage_orders(order_id,status)VALUES('${ROOT}','PAID')`,
        `UPDATE luggage_order_payments SET amount=799 WHERE payment_id=1`,
        `INSERT OR REPLACE INTO luggage_order_payments(payment_id,order_id,business_date,tender_type,amount)VALUES(1,'unrelated','2031-05-10','CASH',800)`,
        `DELETE FROM luggage_bag_additions`,
        `UPDATE luggage_audit_logs SET details='modified' WHERE action='BAG_ADDITION_REGISTER'`,
        `INSERT OR REPLACE INTO luggage_audit_logs(log_id,order_id,action)VALUES(1,'unrelated','test')`,
    ])
        assert.throws(() => c.sqlite.exec(sql));
    assert.equal(rows(c, 'luggage_order_payments').length, 3);
    c.sqlite.close();
});
test('explicit period and quantity are bound to the quote; no wrong deadline or invalid calendar quote is accepted', async () => {
    const c = setup();
    const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1, coverageStartDate: '2031-05-10', coverageEndDate: '2031-05-10' }, NOW);
    assert.equal(q.coverageStartDate, '2031-05-10');
    assert.equal(q.amount, 500);
    await assert.rejects(registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 1, reason: 'Synthetic tamper' }, who, NOW));
    for (const dates of [['2031-05-09', '2031-05-10'], ['2031-05-10', '2031-05-11'], ['2031-02-30', '2031-05-10'], ['2031-05-11', '2031-05-10']])
        await assert.rejects(previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1, coverageStartDate: dates[0], coverageEndDate: dates[1] }, NOW));
    assert.equal(rows(c, 'luggage_bag_additions').length, 0);
    c.sqlite.close();
});
import { Hono } from 'hono';
import internalApi from '../src/routes/internalApi';
import { bagAdditionStaffRoutes } from '../src/routes/bagAdditions';
import { signInternalRequest } from '../src/lib/hmac';
function router(c: ReturnType<typeof setup>, enabled = 'true', role = 'admin') {
    const app = new Hono();
    if (role !== 'admin')
        app.use('/staff/*', async (ctx, next) => { ctx.set('staff' as never, { id: STAFF, display_name: 'Synthetic Viewer', username: 'fixture', role, is_active: true } as never); await next(); });
    app.route('/', internalApi).route('/', bagAdditionStaffRoutes);
    const env = { DB: c.db, APP_ENV: 'test', INTERNAL_API_SECRET: 'synthetic-hmac-only', APP_SECRET_KEY: 'synthetic-cookie-only', DEV_STAFF_AUTH_BYPASS: '1', SUPABASE_URL: 'https://profile.fixture', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only', LUGGAGE_BAG_ADDITIONS_ENABLED: enabled };
    return { app, env };
}
async function signed(r: ReturnType<typeof router>, path: string, body?: unknown, auth = true) { const method = body === undefined ? 'GET' : 'POST', url = 'https://luggage.fixture' + path, raw = body === undefined ? '' : JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000)); const { signature } = await signInternalRequest({ secret: r.env.INTERNAL_API_SECRET, method, url, timestamp, body: raw }); return r.app.request(url, { method, body: raw || undefined, headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-internal-timestamp': timestamp, 'x-internal-signature': signature } : {}) } }, r.env); }
const wireActor = { userId: 'synthetic-user', name: 'Synthetic Editor', email: 'editor@example.test', role: 'center_staff' };
async function profiles<T>(fn: () => Promise<T>) {
    const old = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => { assert.ok(String(input).startsWith('https://profile.fixture/rest/v1/user_profiles')); return Response.json([{ id: STAFF, display_name: 'Synthetic Editor', username: 'fixture', email: 'editor@example.test', role: 'editor', is_active: true }]); }) as typeof fetch;
    try {
        return await fn();
    }
    finally {
        globalThis.fetch = old;
    }
}
test('actual HMAC routes enforce flag, authentication, strict body and staff role without producing money', async (t) => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); const c = setup(), r = router(c, 'false'), path = `/internal/luggage-orders/${ROOT}/bag-additions`; assert.equal((await signed(r, path + '/preview', { actor: wireActor, suitcaseAdded: 0, backpackAdded: 1 }, false)).status, 401); assert.equal((await signed(r, path + '/preview', { actor: wireActor, suitcaseAdded: 0, backpackAdded: 1 })).status, 503); assert.equal((await signed(r, path)).status, 200); r.env.LUGGAGE_BAG_ADDITIONS_ENABLED = 'true'; assert.equal((await signed(r, path + '/preview', { actor: { ...wireActor, role: 'viewer' }, suitcaseAdded: 0, backpackAdded: 1 })).status, 403); assert.equal((await signed(r, path + '/preview', { actor: wireActor, suitcaseAdded: 0, backpackAdded: 1, amount: 1 })).status, 400); assert.equal(rows(c, 'luggage_audit_logs').length, 0); c.sqlite.close(); });
test('actual internal preview/create/replay/history routes append a split receipt once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    await profiles(async () => {
        const c = setup(), r = router(c), path = `/internal/luggage-orders/${ROOT}/bag-additions`;
        const q = await signed(r, path + '/preview', { actor: wireActor, suitcaseAdded: 0, backpackAdded: 1 });
        assert.equal(q.status, 200);
        const data = await q.json() as {
            quote: {
                fingerprint: string;
                amount: number;
            };
        };
        assert.equal(data.quote.amount, 500);
        const x = { actor: wireActor, additionId: crypto.randomUUID(), expectedFingerprint: data.quote.fingerprint, suitcaseAdded: 0, backpackAdded: 1, reason: 'Synthetic split', payment: { confirmReceived: true, cashAmount: 100, qrAmount: 400 } };
        assert.equal((await signed(r, path, x)).status, 201);
        assert.equal((await signed(r, path, x)).status, 200);
        const h = await signed(r, path);
        const body = await h.json() as {
            additions: unknown[];
            billing: {
                outstanding_amount: number;
            };
        };
        assert.equal(body.additions.length, 1);
        assert.equal(body.billing.outstanding_amount, 0);
        assert.equal(rows(c, 'luggage_order_payments').length, 3);
        c.sqlite.close();
    });
});
test('staff HTML routes protect editor rights and same-origin and render a real quote', async (t) => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); const c = setup(), path = `https://luggage.fixture/staff/orders/${ROOT}/bag-additions`; const readonly = router(c, 'true', 'viewer'); assert.equal((await readonly.app.request(path, {}, readonly.env)).status, 403); const r = router(c); assert.equal((await r.app.request(path, { method: 'POST', headers: { Origin: 'https://evil.fixture' }, body: new URLSearchParams() }, r.env)).status, 403); const page = await r.app.request(path, {}, r.env); assert.equal(page.status, 200); assert.match(await page.text(), /추가 짐 보관 시작일/); const q = await r.app.request(path + '/preview', { method: 'POST', headers: { Origin: 'https://luggage.fixture' }, body: new URLSearchParams({ suitcaseAdded: '0', backpackAdded: '1', coverageStartDate: '2031-05-10', coverageEndDate: '2031-05-10' }) }, r.env); assert.equal(q.status, 200); const html = await q.text(); assert.match(html, /¥500/); assert.match(html, /expectedFingerprint/); assert.equal(rows(c, 'luggage_bag_additions').length, 0); c.sqlite.close(); });
test('feature OFF keeps authenticated collection recovery open for an already registered addition', async (t) => { t.mock.timers.enable({ apis: ['Date'], now: NOW }); await profiles(async () => { const c = setup(); await registerBagAddition(c.db, ROOT, await input(c), who, NOW); const r = router(c, 'false'), path = `/internal/luggage-orders/${ROOT}/bag-additions/collect`; const response = await signed(r, path, { actor: wireActor, requestId: crypto.randomUUID(), expectedAmount: 500, confirmReceived: true, cashAmount: 0, qrAmount: 500 }); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 0); assert.equal(rows(c, 'luggage_order_payments').length, 2); c.sqlite.close(); }); });
test('collection replay after lost response and pickup keeps receipts and rejects a different split', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const c = setup();
    await registerBagAddition(c.db, ROOT, await input(c), who, NOW);
    const request = { requestId: crypto.randomUUID(), expectedAmount: 500, cashAmount: 100, qrAmount: 400, confirmReceived: true as const };
    await collectBagAddition(c.db, ROOT, who, request);
    const before = rows(c, 'luggage_order_payments');
    c.sqlite.prepare("UPDATE luggage_orders SET status='PICKED_UP',actual_pickup_at=? WHERE order_id=?").run(NOW.toISOString(), ROOT);
    assert.equal((await collectBagAddition(c.db, ROOT, who, request)).replayed, true);
    assert.deepEqual(rows(c, 'luggage_order_payments'), before);
    await assert.rejects(collectBagAddition(c.db, ROOT, who, { ...request, cashAmount: 0, qrAmount: 500 }), /다른 내용/);
    c.sqlite.close();
});
test('a completed refund between preview and transaction invalidates the quote atomically', async () => {
    const c = setup(), x = await input(c, true);
    const snapshotBefore = rows(c, 'luggage_order_payments');
    const q = await previewFlyingPassRefund(c.db, ROOT, 'BLACK', NOW), refundId = crypto.randomUUID();
    const refundWho = { actor: who.actor, staff: { id: STAFF, email: 'editor@example.test', display_name: 'Synthetic', role: 'editor' as const } };
    c.beforeBatch = async () => {
        await registerFlyingPassRefund(c.db, ROOT, { refundId, targetTier: 'BLACK', reason: 'Synthetic race', expectedFingerprint: q.fingerprint }, refundWho, NOW);
        await finishFlyingPassRefund(c.db, ROOT, refundId, { action: 'confirm', cashPaid: true, expectedAmount: 800 }, refundWho, NOW);
    };
    await assert.rejects(registerBagAddition(c.db, ROOT, x, who, NOW), e => e.code === 'STALE');
    assert.equal(rows(c, 'luggage_flying_pass_refunds')[0].status, 'CONFIRMED');
    assert.deepEqual(rows(c, 'luggage_order_payments'), snapshotBefore);
    assert.equal(rows(c, 'luggage_bag_additions').length, 0);
    c.sqlite.close();
});
test('silently ignored collection receipt rolls the entire bag collection back', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const c = setup();
    await registerBagAddition(c.db, ROOT, await input(c), who, NOW);
    const before = rows(c, 'luggage_order_payments'), audits = rows(c, 'luggage_audit_logs');
    c.sqlite.exec("CREATE TRIGGER ignore_receipt BEFORE INSERT ON luggage_order_payments BEGIN SELECT RAISE(IGNORE);END");
    await assert.rejects(collectBagAddition(c.db, ROOT, who, { requestId: crypto.randomUUID(), expectedAmount: 500, cashAmount: 100, qrAmount: 400, confirmReceived: true }));
    assert.deepEqual(rows(c, 'luggage_order_payments'), before);
    assert.deepEqual(rows(c, 'luggage_audit_logs'), audits);
    assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 500);
    c.sqlite.close();
});
test('subsequent dated extension inherits combined bags once and its collection preserves both claims', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const c = setup();
    await registerBagAddition(c.db, ROOT, await input(c, true), who, NOW);
    const extension = await createDatedExtension(c.db, ROOT, '2031-05-11', STAFF, true, NOW);
    assert.ok(extension);
    const child = c.sqlite.prepare('SELECT * FROM luggage_orders WHERE order_id=?').get(extension)!;
    assert.equal(child.price_per_day, 1300);
    assert.equal(child.suitcase_qty, 1);
    assert.equal(child.backpack_qty, 1);
    assert.equal(child.final_amount, 1300);
    assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 1300);
    await collectBagAddition(c.db, ROOT, who, { requestId: crypto.randomUUID(), expectedAmount: 1300, cashAmount: 1300, qrAmount: 0, confirmReceived: true });
    const b = (await getBillingSummary(c.db, ROOT))!;
    assert.equal(b.total_billed_amount, 2600);
    assert.equal(b.recorded_amount, 2600);
    assert.equal(b.outstanding_amount, 0);
    assert.equal(order(c).final_amount, 800);
    c.sqlite.close();
});
test('approved 1st–5th original and 3rd–5th added batch preserve independent periods and claims', async () => {
    const now = new Date('2031-05-03T03:00:00Z'), c = setup({ createdAt: '2031-05-01T00:00:00Z', pickupAt: '2031-05-05T12:00:00Z', now });
    const before = order(c), p = rows(c, 'luggage_order_payments');
    const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, now);
    assert.deepEqual([q.batch.storageDays, q.batch.pricePerDay, q.batch.discountRate, q.amount], [3, 800, 0, 2400]);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic 3-day batch', payment: { confirmReceived: true, cashAmount: 2400, qrAmount: 0 } }, who, now);
    assert.equal(order(c).prepaid_amount, 4000);
    assert.equal(order(c).final_amount, 4000);
    assert.equal(order(c).expected_storage_days, 5);
    assert.equal(order(c).discount_rate, before.discount_rate);
    assert.deepEqual(rows(c, 'luggage_order_payments')[0], p[0]);
    const batch = rows(c, 'luggage_bag_additions')[0];
    assert.deepEqual([batch.coverage_start_date, batch.coverage_end_date, batch.storage_days, batch.batch_price_per_day, batch.discount_rate, batch.amount], ['2031-05-03', '2031-05-05', 3, 800, 0, 2400]);
    assert.equal((await getBillingSummary(c.db, ROOT))!.total_billed_amount, 6400);
    c.sqlite.close();
});
test('repeated additions retain each own long-stay tier, independent rate and immutable original tier', async () => {
    const now = new Date('2031-05-10T03:00:00Z'), c = setup({ createdAt: '2031-05-01T00:00:00Z', pickupAt: '2031-05-20T12:00:00Z', now });
    const one = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, now);
    assert.deepEqual([one.batch.storageDays, one.batch.discountRate, one.amount], [11, .05, 8360]);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: one.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic first batch', payment: { confirmReceived: true, cashAmount: 8360, qrAmount: 0 } }, who, now);
    const next = new Date('2031-05-15T03:00:00Z');
    c.clock.value = next.toISOString();
    const two = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, next);
    assert.deepEqual([two.batch.storageDays, two.batch.discountRate, two.amount], [6, 0, 4800]);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: two.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic second batch' }, who, next);
    assert.equal(order(c).prepaid_amount, 14400);
    assert.equal(order(c).discount_rate, .1);
    assert.deepEqual(rows(c, 'luggage_bag_additions').map(x => [x.storage_days, x.discount_rate, x.amount]), [[11, .05, 8360], [6, 0, 4800]]);
    assert.equal((await getBillingSummary(c.db, ROOT))!.total_billed_amount, 27560);
    c.sqlite.close();
});
test('batch-local set pricing never retroactively pairs with old bags or repeats a fixed pass discount', async () => {
    const now = new Date('2031-05-03T03:00:00Z'), c = setup({ createdAt: '2031-05-01T00:00:00Z', pickupAt: '2031-05-05T12:00:00Z', now, tier: 'BLUE' });
    const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 1 }, now);
    assert.deepEqual([q.batch.pricePerDay, q.batch.setQty, q.batch.storageDays, q.batch.flyingPassDiscountAmount, q.amount], [1200, 1, 3, 0, 3600]);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 1, reason: 'Synthetic set batch', payment: { confirmReceived: true, cashAmount: 3600, qrAmount: 0 } }, who, now);
    assert.equal(order(c).prepaid_amount, 3800);
    assert.equal(order(c).price_per_day, 2000);
    assert.equal(order(c).set_qty, 1);
    const refund = await previewFlyingPassRefund(c.db, ROOT, 'GOLD', now);
    assert.equal(refund.amount, 200);
    assert.equal(refund.afterAmount, 7200);
    c.sqlite.close();
});
test('BLACK full-free addition records a zero claim without any fake receipt or repeat refund', async () => {
    const c = setup();
    await refund(c, 'BLACK');
    const receipts = rows(c, 'luggage_order_payments'), q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW);
    assert.equal(q.amount, 0);
    assert.equal(q.batch.flyingPassDiscountAmount, 500);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 0, backpackAdded: 1, reason: 'Synthetic BLACK bag' }, who, NOW);
    assert.deepEqual(rows(c, 'luggage_order_payments'), receipts);
    assert.equal((await getBillingSummary(c.db, ROOT))!.outstanding_amount, 0);
    assert.equal((await getBillingSummary(c.db, ROOT))!.total_effective_billed_amount, 0);
    c.sqlite.close();
});
test('21:00 JST boundary rejects an expiring same-day batch and calendar deadline rewrites cannot reprice history', async () => {
    const c = setup();
    await registerBagAddition(c.db, ROOT, await input(c, true), who, NOW);
    assert.throws(() => c.sqlite.prepare('UPDATE luggage_orders SET expected_pickup_at=? WHERE order_id=?').run('2031-05-11T12:00:00Z', ROOT), /Preserve/);
    c.sqlite.prepare('UPDATE luggage_orders SET expected_pickup_at=? WHERE order_id=?').run('2031-05-10T11:00:00Z', ROOT);
    const late = new Date('2031-05-10T12:00:00Z');
    c.clock.value = late.toISOString();
    await assert.rejects(previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, late), e => e.code === 'PICKUP_DEADLINE_PASSED');
    c.sqlite.close();
});
test('independent batches and their real collection remain on each receipt JST day in sales and cash reporting', async () => {
    const now = new Date('2031-05-03T03:00:00Z'), c = setup({ createdAt: '2031-05-01T00:00:00Z', pickupAt: '2031-05-05T12:00:00Z', now });
    const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, now);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic separately paid batch', payment: { confirmReceived: true, cashAmount: 1000, qrAmount: 1400 } }, who, now);
    const old = c.sqlite.prepare('SELECT total_amount,cash,qr,suitcase_total FROM luggage_sales_daily WHERE business_date=?').get('2031-05-01')!;
    const added = c.sqlite.prepare('SELECT total_amount,cash,qr,suitcase_total FROM luggage_sales_daily WHERE business_date=?').get('2031-05-03')!;
    assert.deepEqual({ ...old }, { total_amount: 4000, cash: 4000, qr: 0,suitcase_total:1 });
    assert.deepEqual({ ...added }, { total_amount: 2400, cash: 1000, qr: 1400,suitcase_total:1 });
    assert.equal((await getBillingSummary(c.db, ROOT))!.recorded_amount, 6400);
    assert.equal(rows(c, 'luggage_cash_closings').length, 0);
    c.sqlite.close();
});
test('21:00 race is checked inside the transaction even when the quote was issued immediately before close', async () => {
    const now = new Date('2031-05-10T11:59:59Z'), c = setup({ now });
    const q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, now);
    c.beforeBatch = () => { c.clock.value = '2031-05-10T12:00:00Z'; };
    await assert.rejects(registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic closing edge' }, who, now));
    assert.equal(rows(c, 'luggage_bag_additions').length, 0);
    assert.equal(rows(c, 'luggage_audit_logs').length, 0);
    c.sqlite.close();
});
test('an originally BLACK free paid order accepts a free batch with zero receipts and verified original pricing', async () => {
    const c = setup({ tier: 'BLACK' }), q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 1, backpackAdded: 0 }, NOW);
    assert.equal(q.amount, 0);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 1, backpackAdded: 0, reason: 'Synthetic originally free batch' }, who, NOW);
    assert.equal(rows(c, 'luggage_order_payments').length, 0);
    assert.equal(rows(c, 'luggage_bag_additions').length, 1);
    assert.equal((await getBillingSummary(c.db, ROOT))!.invalid_amount, 0);
    c.sqlite.close();
});
test('collecting a later extension of a free BLACK batch still respects FINAL_CLOSE and rolls back', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const c = setup({ tier: 'BLACK' }), q = await previewBagAddition(c.db, ROOT, { suitcaseAdded: 0, backpackAdded: 1 }, NOW);
    await registerBagAddition(c.db, ROOT, { additionId: crypto.randomUUID(), expectedFingerprint: q.fingerprint, suitcaseAdded: 0, backpackAdded: 1, reason: 'Synthetic zero-claim batch' }, who, NOW);
    await createDatedExtension(c.db, ROOT, '2031-05-11', STAFF, true, NOW);
    const before = rows(c, 'luggage_order_payments'), audits = rows(c, 'luggage_audit_logs');
    c.sqlite.exec("INSERT INTO luggage_cash_closings(business_date,closing_type,workflow_status)VALUES('2031-05-10','FINAL_CLOSE','SUBMITTED')");
    await assert.rejects(collectBagAddition(c.db, ROOT, who, { requestId: crypto.randomUUID(), expectedAmount: 1300, cashAmount: 1300, qrAmount: 0, confirmReceived: true }));
    assert.deepEqual(rows(c, 'luggage_order_payments'), before);
    assert.deepEqual(rows(c, 'luggage_audit_logs'), audits);
    c.sqlite.close();
});
