import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { correctionBatch, CORRECTION, ORDER, migration, queries, verifyAfter } from '../scripts/correct-087-discount.mjs';
import { splitSql, assertSameSql } from '../scripts/lib/sql-contract.mjs';

const require = createRequire(import.meta.url), deps = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Log, LogLevel } = deps('miniflare'), { build } = deps('esbuild');

test('F1 local preview: exact production batch is atomic, preserves guards and receipts, and unlocks only a paid-up 087', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approved087-preview-'));
  let mf;
  try {
    const bundle = join(dir, 'worker.mjs');
    await build({ entryPoints: ['src/index.tsx'], outfile: bundle, bundle: true, platform: 'browser', format: 'esm',
      target: 'es2022', external: ['node:*'], logLevel: 'silent' });
    const secret = '087-local-preview-only', editor = '11111111-1111-4111-8111-111111111111';
    const profile = { id: editor, display_name: 'Local test operator', username: 'local', role: 'editor', is_active: true, created_at: '' };
    mf = new Miniflare({ modules: true, modulesRoot: dir, scriptPath: bundle, compatibilityDate: '2025-04-01', compatibilityFlags: ['nodejs_compat'],
      log: new Log(LogLevel.ERROR), d1Databases: { DB: '087-local-preview-only' }, r2Buckets: ['IMAGES'],
      bindings: { INTERNAL_API_SECRET: secret, APP_SECRET_KEY: secret, APP_ENV: 'test', SUPABASE_URL: 'https://profiles.invalid',
        SUPABASE_SERVICE_ROLE_KEY: 'local-only', LUGGAGE_FLYING_PASS_REFUNDS_ENABLED: 'true' },
      outboundService: async request => {
        const url = new URL(request.url);
        assert.equal(request.method, 'GET'); assert.equal(url.origin, 'https://profiles.invalid');
        assert.equal(url.pathname, '/rest/v1/user_profiles');
        return Response.json((request.headers.get('accept') || '').includes('object') ? profile : [profile]);
      },
    });
    const db = await mf.getD1Database('DB');
    const run = async statements => db.batch(statements.map(s => typeof s === 'string' ? db.prepare(s) : db.prepare(s.sql).bind(...(s.params || []))));
    const schema = readFileSync('src/schema.sql', 'utf8');
    await run(splitSql(schema.split('-- Operator-only correction policy.')[0]));
    for (const column of ['gross_amount', 'point_discount_amount', 'points_used', 'account_wallet_points_used', 'account_wallet_coupon_discount_amount']) {
      await db.prepare(`ALTER TABLE luggage_orders ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`).run();
    }
    await db.prepare("ALTER TABLE luggage_orders ADD COLUMN point_usage_status TEXT NOT NULL DEFAULT 'NONE'").run();
    await run([
      `INSERT INTO luggage_orders(order_id,created_at,updated_at,status,backpack_qty,expected_pickup_at,expected_storage_days,
        price_per_day,discount_rate,prepaid_amount,final_amount,staff_prepaid_override_amount,payment_method,tag_no,in_warehouse)
        VALUES ('${ORDER}','2026-10-23 08:19:18','2026-10-27 10:44:46','PAID',2,'2026-10-31T08:30:00.000Z',9,1000,0.05,9000,9000,9000,'CASH','146',1)`,
      `INSERT INTO luggage_order_payments(payment_id,order_id,business_date,tender_type,amount,recorded_at)
        VALUES (12067,'${ORDER}','2026-10-23','CASH',8550,'2026-10-23 08:22:42')`,
      `INSERT INTO luggage_audit_logs(log_id,order_id,action,details,timestamp) VALUES
        (53907,'${ORDER}','TOGGLE_PAYMENT','결제 완료','2026-10-23 08:22:42'),
        (54341,'${ORDER}','UPDATE_PRICE','금액: ¥9000','2026-10-24 11:47:11')`,
      "INSERT INTO luggage_orders(order_id,status,prepaid_amount,final_amount) VALUES ('other-review','PAID',9000,9000)",
      "INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount) VALUES ('other-review','2026-10-23','CASH',8550)",
    ]);
    await run(Array.from({ length: 44 }, (_, i) => ({ sql: `INSERT INTO luggage_cash_closings
      (closing_id,business_date,closing_type,actual_amount,check_auto_amount,difference_amount)
      VALUES (?,date('2026-09-29','+' || ? || ' days'),? ,162450,159550,2900)`,
      params: [i + 1, Math.floor(i / 2), i % 2 ? 'FINAL_CLOSE' : 'EVENING'] })));
    const rows = async sql => (await db.prepare(sql).all()).results;
    const definitions = () => rows("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name");
    const oldDefinitions = await definitions();
    const receipts = await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id');
    const audits = await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id');
    const batch = correctionBatch('local-preview-operator', 'b'.repeat(64));
    // Drift in a production-only wallet field aborts even before the approved correction can run.
    await db.prepare(`UPDATE luggage_orders SET account_wallet_points_used=1 WHERE order_id='${ORDER}'`).run();
    await assert.rejects(run(batch), /PRECONDITION|CHECK/);
    assert.deepEqual(await definitions(), oldDefinitions);
    await db.prepare(`UPDATE luggage_orders SET account_wallet_points_used=0 WHERE order_id='${ORDER}'`).run();
    // Fail after all policy DDL and the financial write; D1 rolls back DDL, event, audit and price.
    await assert.rejects(run([...batch, { sql: 'SELECT * FROM deliberately_missing_table' }]), /no such table/);
    assert.deepEqual(await definitions(), oldDefinitions);
    assert.deepEqual(await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'), receipts);
    assert.deepEqual(await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id'), audits);
    assert.equal((await db.prepare(`SELECT final_amount FROM luggage_orders WHERE order_id='${ORDER}'`).first()).final_amount, 9000);

    const request = async (path, method = 'GET', data, staff = false) => {
      const body = data === undefined ? undefined : JSON.stringify(data), timestamp = String(Math.floor(Date.now() / 1000));
      const headers = { 'Content-Type': 'application/json', 'x-internal-timestamp': timestamp,
        'x-internal-signature': createHmac('sha256', secret).update([method,path,timestamp,createHash('sha256').update(body || '').digest('hex')].join('\n')).digest('hex') };
      if (staff) {
        const session = Buffer.from(JSON.stringify({ user_id: editor, exp: Date.now() + 3600000 })).toString('base64');
        headers.Cookie = 'luggage_session=' + session + '.' + createHmac('sha256', secret).update(session).digest('hex');
      }
      return mf.dispatchFetch('https://local.invalid' + path, { method, headers, body });
    };
    const order = async () => {
      const response = await request(`/internal/luggage-orders?search=${ORDER}&limit=1`);
      assert.equal(response.status, 200); return (await response.json()).orders.find(o => o.orderId === ORDER);
    };
    assert.equal((await order()).billing.review_pickup_blocked, 1);
    const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, sql]) => [key, await rows(sql)])));
    const beforeSnapshot = await snapshot();
    await run(batch);
    const afterSnapshot = await snapshot();
    const report = verifyAfter(beforeSnapshot, afterSnapshot);
    assert.equal(report.preservedClosings, 44); assert.equal(report.preservedOtherOrders, 1);
    assert.equal(report.preservedOtherReviews, 1); assert.equal(report.recordedAmount, 8550);
    const tampered = structuredClone(afterSnapshot); tampered.receipts[0].amount += 450;
    assert.throws(() => verifyAfter(beforeSnapshot, tampered), /receipts changed/);
    assert.deepEqual(await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'), receipts);
    assert.deepEqual(await rows("SELECT * FROM luggage_audit_logs WHERE action!='CORRECT_COLLECTED_PRICE' ORDER BY log_id"), audits);
    const corrected = await order();
    assert.equal(corrected.finalAmount, 8550); assert.equal(corrected.prepaidAmount, 8550);
    assert.equal(corrected.staffPrepaidOverrideAmount, null); assert.equal(corrected.billing.recorded_amount, 8550);
    for (const key of ['root_review_amount','root_review_required','outstanding_amount','extension_outstanding_amount',
      'unbilled_amount','unbilled_days','review_pickup_blocked','cash_refunded_amount','discount_credit_amount','pending_refund_count']) {
      assert.equal(corrected.billing[key], 0, key);
    }
    assert.equal((await db.prepare("SELECT root_review_amount FROM luggage_billing_balances WHERE root_id='other-review'").first()).root_review_amount, 450);
    const staffView = await request(`/staff/orders/${ORDER}`, 'GET', undefined, true);
    assert.equal(staffView.status, 200); const html = await staffView.text();
    assert.match(html, /8,550/); assert.doesNotMatch(html, /변경 근거가 불충분하여 픽업을 보류/);
    // Real, authenticated pickup mutation only in this isolated local DB.
    const pickup = await request(`/internal/luggage-orders/${ORDER}/pickup-status`, 'PATCH', {
      action: 'mark_picked_up', expectedUpdatedAt: corrected.updatedAt,
      actor: { userId: 'local-pickup-operator', name: 'Local operator', role: 'center_staff' },
    });
    assert.equal(pickup.status, 200, await pickup.clone().text());
    assert.equal((await db.prepare(`SELECT status FROM luggage_orders WHERE order_id='${ORDER}'`).first()).status, 'PICKED_UP');
    await assert.rejects(run([correctionBatch('local-preview-operator', 'b'.repeat(64)).at(-1)]), /PRECONDITION|UNIQUE/);
    await assert.rejects(db.prepare(`UPDATE luggage_orders SET final_amount=9000 WHERE order_id='${ORDER}'`).run(), /separate correction policy/);
    await assert.rejects(db.prepare("UPDATE luggage_orders SET final_amount=8550 WHERE order_id='other-review'").run(), /separate correction policy/);
    const actual = await definitions();
    for (const object of oldDefinitions.filter(o => o.type !== 'table' && o.type !== 'index' && o.name !== 'luggage_preserve_collected_price')) {
      assertSameSql(object.name, actual.find(o => o.name === object.name).sql, object.sql);
    }
// Compare the correction independently of the later bag and part-time additions.
    const freshCorrection = splitSql(schema.slice(schema.indexOf('-- Operator-only correction policy.')).split('-- Additional bags after payment;')[0]);
    assert.deepEqual(freshCorrection, splitSql(migration));
    assert.equal((await db.prepare(`SELECT correction_id FROM luggage_order_price_corrections`).first()).correction_id, CORRECTION);
  } finally { if (mf) await mf.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
