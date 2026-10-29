// D1 Write credentials are required only by this operator CLI. No application route calls it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSql, assertSameSql } from './lib/sql-contract.mjs';

export const ORDER = '20261023-087';
export const SOURCE = '36a722eff52c465062f7f984aa1fe3b74fcfccda';
export const CORRECTION = '087-long-stay-discount-20261029';
export const migration = readFileSync(new URL('../migrations/20261029_087_discount_correction.sql', import.meta.url), 'utf8');
const account = '6efe0c5d58f6e8bb28165c599fa36c33';
const database = 'dfae11bb-0dd9-4e7c-be27-d6e98c7c3b77';
const sourceVersion = 'e7b5bc2f-b3a7-41e1-ba76-eb1e4fb9d06b';
const unifiedVersion = '2fbaa7da-c22a-4a97-88f4-71ac930353c7';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(label); };

export function correctionStatement(operator, evidenceHash, production = true) {
  assert.match(operator, /^[a-zA-Z0-9:_-]{1,120}$/);
  assert.match(evidenceHash, /^[a-f0-9]{64}$/);
  // These newer wallet columns are absent from the F1 fresh schema. Check them in the
  // same production transaction, in addition to the policy's independent core guards.
  const order = production ? `CASE WHEN EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = '${ORDER}'
    AND gross_amount = 0 AND point_discount_amount = 0 AND points_used = 0 AND account_wallet_points_used = 0
    AND account_wallet_coupon_discount_amount = 0 AND point_usage_status = 'NONE')
    THEN '${ORDER}' ELSE 'UNEXPECTED_WALLET_STATE' END` : `'${ORDER}'`;
  return { sql: `INSERT INTO luggage_order_price_corrections
    (correction_id, order_id, approval_reference, operator_reference, evidence_sha256)
    VALUES ('${CORRECTION}', ${order}, 'user-approved:087-normal-discount:2026-10-29', ?, ?)`, params: [operator, evidenceHash] };
}

export function correctionBatch(operator, evidenceHash, production = true) {
  return [...splitSql(migration).map(sql => ({ sql })), correctionStatement(operator, evidenceHash, production)];
}

export const queries = {
  schema: `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('view','trigger') OR name='luggage_order_price_corrections' ORDER BY type,name`,
  orders: `SELECT order_id,created_at,expected_pickup_at,actual_pickup_at,expected_storage_days,actual_storage_days,extra_days,
    suitcase_qty,backpack_qty,set_qty,price_per_day,discount_rate,prepaid_amount,final_amount,extra_amount,
    flying_pass_tier,flying_pass_discount_amount,staff_prepaid_override_amount,parent_order_id,extension_date,payment_method,
    gross_amount,point_discount_amount,points_used,account_wallet_points_used,account_wallet_coupon_discount_amount,point_usage_status
    FROM luggage_orders ORDER BY order_id`,
  receipts: 'SELECT * FROM luggage_order_payments ORDER BY payment_id',
  refunds: 'SELECT * FROM luggage_flying_pass_refunds ORDER BY refund_id',
  closingSnapshots: 'SELECT * FROM luggage_cash_closing_refund_snapshots ORDER BY closing_id',
  closings: `SELECT * FROM luggage_cash_closings WHERE business_date BETWEEN '2026-09-29' AND '2026-10-28' ORDER BY closing_id`,
  closingAudits: `SELECT * FROM luggage_cash_closing_audits WHERE closing_id IN
    (SELECT closing_id FROM luggage_cash_closings WHERE business_date BETWEEN '2026-09-29' AND '2026-10-28') ORDER BY audit_id`,
  dailySales: `SELECT * FROM luggage_daily_sales WHERE sale_date BETWEEN '2026-09-29' AND '2026-10-28' ORDER BY sale_date`,
  sales: `SELECT * FROM luggage_sales_daily WHERE business_date BETWEEN '2026-09-29' AND '2026-10-28' ORDER BY business_date`,
  order: `SELECT order_id,status,updated_at,prepaid_amount,final_amount,staff_prepaid_override_amount,discount_rate,extra_amount FROM luggage_orders WHERE order_id='${ORDER}'`,
  billing: `SELECT * FROM luggage_billing_balances WHERE root_id='${ORDER}'`,
  reviews: `SELECT root_id,root_review_required,root_review_amount,root_review_difference,review_pickup_blocked FROM luggage_billing_balances WHERE root_review_required>0 ORDER BY root_id`,
  audits: `SELECT * FROM luggage_audit_logs WHERE order_id='${ORDER}' ORDER BY log_id`,
};

function verifyBefore(before) {
  assert.equal(before.order.length, 1); assert.equal(before.closings.length, 44);
  same(before.order[0], { order_id: ORDER, status: 'PAID', updated_at: '2026-10-27 10:44:46', prepaid_amount: 9000,
    final_amount: 9000, staff_prepaid_override_amount: 9000, discount_rate: 0.05, extra_amount: 0 }, '087 before state changed');
  const financial = before.orders.find(o => o.order_id === ORDER);
  assert.ok(financial); assert.equal(financial.gross_amount, 0); assert.equal(financial.point_discount_amount, 0);
  assert.equal(financial.points_used, 0); assert.equal(financial.account_wallet_points_used, 0);
  assert.equal(financial.account_wallet_coupon_discount_amount, 0); assert.equal(financial.point_usage_status, 'NONE');
  const b = before.billing[0]; assert.ok(b); assert.equal(b.recorded_amount, 8550); assert.equal(b.root_review_amount, 450);
  assert.equal(b.outstanding_amount, 0); assert.equal(b.unbilled_amount, 0); assert.equal(b.refund_count, 0);
  assert.ok(!before.schema.some(o => o.name === 'luggage_order_price_corrections'), 'Policy is already installed; read its outcome, never reapply');
  // All deployed financial definitions must match the release base, before adding this policy.
  const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8').split('-- Operator-only correction policy.')[0];
  const expected = splitSql(schema);
  for (const object of before.schema) {
    const definitions = expected.filter(sql => new RegExp(`^CREATE (?:VIEW|TRIGGER) (?:IF NOT EXISTS )?${object.name}\\b`).test(sql));
    if (object.type === 'trigger') assert.ok(definitions.length, 'Unexpected production trigger: ' + object.name);
    if (definitions.length) assertSameSql(object.name, object.sql, definitions.at(-1), 'production', SOURCE);
  }
}

export function verifyAfter(before, after) {
  same(before.orders.filter(o => o.order_id !== ORDER), after.orders.filter(o => o.order_id !== ORDER), 'Other order financial state changed');
  for (const key of ['receipts','refunds','closingSnapshots','closings','closingAudits','dailySales','sales']) same(before[key], after[key], `${key} changed`);
  same(before.reviews.filter(o => o.root_id !== ORDER), after.reviews, 'Other settlement reviews changed');
  same(before.audits, after.audits.filter(a => a.action !== 'CORRECT_COLLECTED_PRICE'), 'Existing 087 audits changed');
  const audits = after.audits.filter(a => a.action === 'CORRECT_COLLECTED_PRICE'); assert.equal(audits.length, 1);
  assert.equal(audits[0].device_id, CORRECTION); assert.equal(audits[0].staff_id, null);
  same({ ...before.orders.find(o => o.order_id === ORDER), prepaid_amount: 8550, final_amount: 8550,
    staff_prepaid_override_amount: null }, after.orders.find(o => o.order_id === ORDER), 'Unexpected 087 financial change');
  const b = after.billing[0]; assert.ok(b); assert.equal(b.total_billed_amount, 8550); assert.equal(b.recorded_amount, 8550);
  for (const key of ['root_review_required','root_review_amount','review_pickup_blocked','outstanding_amount','unbilled_amount',
    'unbilled_days','invalid_amount','refund_count','pending_refund_count','discount_credit_amount','cash_refunded_amount']) assert.equal(b[key], 0, key);
  assert.equal(after.order[0].status, 'PAID'); assert.equal(after.order[0].prepaid_amount, 8550); assert.equal(after.order[0].final_amount, 8550);
  // Preserve every pre-existing trigger and View except the deliberately extended price policy.
  for (const object of before.schema.filter(o => o.name !== 'luggage_preserve_collected_price')) {
    same(object, after.schema.find(o => o.name === object.name), 'Existing financial schema changed: ' + object.name);
  }
  for (const sql of splitSql(migration)) {
    const name = sql.match(/^CREATE (?:TRIGGER|TABLE) (\w+)/)?.[1];
    if (name) assertSameSql(name, after.schema.find(o => o.name === name)?.sql || '', sql);
  }
  return { orderId: ORDER, beforeBilled: 9000, afterBilled: 8550, longStayDiscount: 450, recordedAmount: 8550,
    reviewAmount: b.root_review_amount, outstandingAmount: b.outstanding_amount, pickupBlocked: b.review_pickup_blocked,
    auditId: audits[0].log_id, correctionId: CORRECTION, preservedClosings: after.closings.length,
    preservedOtherOrders: after.orders.length - 1, preservedReceipts: after.receipts.length, preservedOtherReviews: after.reviews.length };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply-approved-087');
  const value = name => args[args.indexOf(name) + 1];
  assert.ok(args.includes('--evidence-dir') && args.includes('--operator'), 'Provide --evidence-dir and --operator');
  assert.equal(args.length, apply ? 5 : 4, 'Unexpected CLI arguments');
  const dir = resolve(value('--evidence-dir')), operator = value('--operator');
  assert.match(operator, /^[a-zA-Z0-9:_-]{1,120}$/);
  const token = process.env.CLOUDFLARE_API_TOKEN; assert.ok(token, 'D1 operator credential required');
  const request = async (path, body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error(`Cloudflare HTTP ${response.status}; inspect outcome read-only before any retry`);
    const result = await response.json();
    if (!result.success || result.result?.some?.(r => !r.success)) throw Error('Cloudflare operation failed; inspect outcome read-only before any retry');
    return result.result;
  };
  const query = async batch => request(`/d1/database/${database}/query`, { batch });
  const snapshot = async () => {
    const entries = Object.entries(queries), results = await query(entries.map(([, sql]) => ({ sql })));
    assert.equal(results.length, entries.length);
    assert.ok(results.every(r => r.meta.rows_written === 0), 'Snapshot must be read-only');
    return Object.fromEntries(entries.map(([key], i) => [key, results[i].results]));
  };
  const deployment = async (name, expectedVersion) => {
    const data = await request(`/workers/scripts/${name}/deployments`);
    const latest = [...data.deployments].sort((a,b) => b.created_on.localeCompare(a.created_on))[0];
    assert.equal(latest.versions.length, 1, 'Split deployment: ' + name);
    assert.equal(latest.versions[0].version_id, expectedVersion, 'Deployment drift: ' + name);
    assert.equal(latest.versions[0].percentage, 100, 'Partial deployment: ' + name);
  };
  await deployment('int-center-luggage-api', sourceVersion); await deployment('int-unified-admin-prod', unifiedVersion);
  const before = await snapshot(); verifyBefore(before);
  mkdirSync(dir, { mode: 0o700 });
  const evidence = JSON.stringify({ source: SOURCE, sourceVersion, unifiedVersion, operator,
    migrationSha256: sha256(migration), operatorScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    capturedAt: new Date().toISOString(), before }, null, 2);
  writeFileSync(resolve(dir, 'before.json'), evidence, { mode: 0o600, flag: 'wx' });
  const evidenceHash = sha256(evidence);
  if (!apply) { console.log(JSON.stringify({ mode: 'SELECT_ONLY', orderId: ORDER, billed: 9000, recorded: 8550, review: 450,
    closings: before.closings.length, otherReviews: before.reviews.length - 1, evidenceHash })); return; }
  // One atomic REST batch: install the guarded policy and apply its one immutable event.
  // Never retry this write automatically, even after a lost HTTP response.
  await query(correctionBatch(operator, evidenceHash));
  const after = await snapshot();
  writeFileSync(resolve(dir, 'after.json'), JSON.stringify(after, null, 2), { mode: 0o600, flag: 'wx' });
  const report = { ...verifyAfter(before, after), sourceVersion, unifiedVersion, evidenceHash, migrationSha256: sha256(migration) };
  await deployment('int-center-luggage-api', sourceVersion); await deployment('int-unified-admin-prod', unifiedVersion);
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error('087 correction stopped:', error.message); process.exitCode = 1; });
}
