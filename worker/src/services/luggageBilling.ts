import { buildOrderId } from './orderNumber';
import { normalizePaymentAllocation, type PaymentAllocation } from '../lib/payments';

export type BillingSummary = {
  refund_settlement_version: 2;
  effective_flying_pass_tier: string;
  latest_confirmed_refund_id: string | null;
  pending_refund_id: string | null;
  discount_credit_amount: number;
  cash_refunded_amount: number;
  net_received_amount: number;
  total_effective_billed_amount: number;
  pending_refund_count: number;
  refund_count: number;
  root_id: string;
  extension_count: number;
  total_billed_amount: number;
  recorded_amount: number;
  legacy_paid_estimate: number;
  overpaid_amount: number;
  /** Confirmed collection target only; excludes the separately retained root review difference. */
  outstanding_amount: number;
  unbilled_amount: number;
  unbilled_days: number;
  invalid_amount: number;
  extension_outstanding_amount: number;
  root_review_required: number;
  root_review_amount: number;
  /** Signed original claim minus recorded tender; never implicitly written off or credited. */
  root_review_difference: number;
  root_review_reason: 'AUDITED_POST_PAYMENT_REPRICE' | 'UNVERIFIED_ROOT_DIFFERENCE' | null;
  reprice_audit_log_id: number | null;
  review_pickup_blocked: number;
};

export class BillingConflict extends Error {}

// Each ID-only SELECT binds at most 75 values, below D1's 100-parameter limit.
const BILLING_QUERY_CHUNK_SIZE = 75;

export async function getBillingSummary(db: D1Database, orderId: string): Promise<BillingSummary | null> {
  const order = await db.prepare(`SELECT COALESCE(parent_order_id, order_id) AS root_id
    FROM luggage_orders WHERE order_id = ?`).bind(orderId).first<{ root_id: string }>();
  if (!order) return null;
  // Bind the resolved root as a value: joining orders outside the aggregate View
  // prevents SQLite from restricting the family before calculating billing totals.
  return db.prepare('SELECT * FROM luggage_billing_balances WHERE root_id = ?')
    .bind(order.root_id).first<BillingSummary>();
}

/** Resolve families first; off-page children still contribute through the unchanged View. */
export async function getBillingSummaries(db: D1Database, orderIds: string[]): Promise<Map<string, BillingSummary>> {
  const requestedIds = [...new Set(orderIds)];
  const rootsByOrder = new Map<string, string>();
  for (let i = 0; i < requestedIds.length; i += BILLING_QUERY_CHUNK_SIZE) {
    const ids = requestedIds.slice(i, i + BILLING_QUERY_CHUNK_SIZE);
    const rows = await db.prepare(`SELECT order_id, COALESCE(parent_order_id, order_id) AS root_id
      FROM luggage_orders WHERE order_id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
      .all<{ order_id: string; root_id: string }>();
    for (const row of rows.results) rootsByOrder.set(row.order_id, row.root_id);
  }
  const rootIds = [...new Set(rootsByOrder.values())];
  const billingsByRoot = new Map<string, BillingSummary>();
  for (let i = 0; i < rootIds.length; i += BILLING_QUERY_CHUNK_SIZE) {
    const ids = rootIds.slice(i, i + BILLING_QUERY_CHUNK_SIZE);
    const rows = await db.prepare(`SELECT * FROM luggage_billing_balances
      WHERE root_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<BillingSummary>();
    for (const row of rows.results) billingsByRoot.set(row.root_id, row);
  }
  const result = new Map<string, BillingSummary>();
  for (const orderId of requestedIds) {
    const rootId = rootsByOrder.get(orderId);
    const billing = rootId === undefined ? undefined : billingsByRoot.get(rootId);
    if (billing) {
      // Preserve the former SELECT's requested_order_id and every View column.
      const row = { requested_order_id: orderId, ...billing };
      result.set(orderId, row);
    }
  }
  return result;
}

/** Physical pickup and monetary reconciliation are separate decisions. Nothing here waives a stored claim. */
export function pickupBillingError(summary: BillingSummary | null): string | null {
  if (!summary) return '주문 금액을 확인해주세요';
  if (summary.pending_refund_count > 0) return '진행 중 현금 환급의 지급 여부를 먼저 확인해주세요. 현금을 다시 지급하지 마세요';
  if (summary.extension_outstanding_amount > 0) return '추가 보관료 미수납 · 추가 결제 필요: 원주문에서 수납 후 수령 처리해주세요';
  if (summary.invalid_amount) return '금액 확인 필요: 기존 원주문 정산 또는 비정상 금액을 확인해주세요';
  if (summary.review_pickup_blocked) return '기존 원주문 정산 확인 필요: 변경 근거가 불충분하여 픽업을 보류합니다';
  if (summary.outstanding_amount > 0) return '추가 결제 필요: 원주문에서 미수납액을 확인해주세요';
  return null;
}

export type CancellationBlock = 'COLLECTED_EXTENSION' | 'EXTENSION_POLICY_REQUIRED' | 'ROOT_SETTLEMENT_REVIEW_REQUIRED';
export async function getCancellationBlock(db: D1Database, orderId: string): Promise<CancellationBlock | null> {
  const row = await db.prepare('SELECT block_reason FROM luggage_cancellation_policy WHERE order_id = ?')
    .bind(orderId).first<{ block_reason: CancellationBlock | null }>();
  return row?.block_reason ?? null;
}

/** No implicit collection through the old destructive payment toggles. */
export async function requiresCollectionFlow(db: D1Database, orderId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM luggage_orders o WHERE o.order_id = ? AND (
    o.parent_order_id IS NOT NULL OR EXISTS (SELECT 1 FROM luggage_orders e WHERE e.parent_order_id = o.order_id)
    OR EXISTS (SELECT 1 FROM luggage_unbilled_extension_days d WHERE d.root_id = o.order_id AND d.amount > 0)
    OR EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = o.order_id AND p.receipt_request_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM luggage_billing_lines l WHERE l.order_id = o.order_id AND (l.root_review_required = 1 OR l.payment_count > 0 AND l.collectible_amount > 0)))`)
    .bind(orderId).first();
  return !!row;
}

/** UTC, in the existing SQLite seconds format. JST conversion belongs in date queries. */
export function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** One date, one charge, with the eligibility/dedup check inside the INSERT transaction. */
export async function createDatedExtension(
  db: D1Database, rootId: string, billingDate: string, staffId: string | null = null, manual = false,
  now: Date = new Date(),
): Promise<string | null> {
  // Capture the creation instant once for the ID, row and audit. billingDate can
  // refer to an older missed day and must never supply the creation timestamp.
  const createdAt = toSqliteDateTime(now);
  const id = `EXT-${await buildOrderId(db, now, false, 'ext')}`;
  const results = await db.batch([
    db.prepare(`INSERT INTO luggage_orders (
      order_id, created_at, updated_at, name, phone, email, suitcase_qty, backpack_qty, set_qty,
      expected_pickup_at, expected_storage_days, price_per_day, prepaid_amount, final_amount,
      status, tag_no, note, consent_checked, manual_entry, staff_id, parent_order_id, in_warehouse, extension_date
    ) SELECT ?, ?, ?, r.name, r.phone, r.email, r.suitcase_qty, r.backpack_qty, r.set_qty,
      ? || 'T12:00:00.000Z', 1, r.price_per_day, r.price_per_day, r.price_per_day,
      'PAYMENT_PENDING', r.tag_no, ?, 1, ?, ?, r.order_id, r.in_warehouse, ?
    FROM luggage_orders r WHERE r.order_id = ? AND r.parent_order_id IS NULL
      AND r.status IN ('PAID', 'PAYMENT_PENDING')
      AND r.price_per_day BETWEEN 0 AND 500000 AND r.price_per_day = CAST(r.price_per_day AS INTEGER)
      AND ? > date(r.expected_pickup_at, '+9 hours')
      AND (? = 1 OR EXISTS (SELECT 1 FROM luggage_unbilled_extension_days d
        WHERE d.root_id = r.order_id AND d.billing_date = ?))
      AND NOT EXISTS (SELECT 1 FROM luggage_billing_lines e WHERE e.parent_order_id = r.order_id
        AND ? BETWEEN date(e.coverage_end, '-' || (MAX(1, e.expected_storage_days) - 1) || ' days') AND e.coverage_end)
    RETURNING order_id`).bind(id, createdAt, createdAt, billingDate, `${manual ? '수기' : '자동'}연장 (${rootId}, ${billingDate})`,
      manual ? 1 : 0, staffId, billingDate, rootId, billingDate, manual ? 1 : 0, billingDate, billingDate),
    db.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details, timestamp)
      SELECT ?, ?, 'CREATE_DATED_EXTENSION', json_set(?, '$.amount', final_amount, '$.tagNo', tag_no), ? FROM luggage_orders WHERE order_id = ? AND changes() = 1`)
      .bind(id, staffId, JSON.stringify({ rootId, extensionOrderId: id, billingDate, createdAt, manual }), createdAt, id),
    db.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details, timestamp)
      SELECT ?, ?, 'CREATE_DATED_EXTENSION', json_set(?, '$.amount', final_amount, '$.tagNo', tag_no), ? FROM luggage_orders WHERE order_id = ? AND changes() = 1`)
      .bind(rootId, staffId, JSON.stringify({ rootId, extensionOrderId: id, billingDate, createdAt, manual }), createdAt, id),
  ]);
  return results[0].results?.length ? id : null;
}

/** Used by cron and explicit staff collection; safe to retry after a partial backlog run. */
export async function materializeOutstandingDays(db: D1Database, rootId?: string): Promise<string[]> {
  const days = await db.prepare(`SELECT root_id, billing_date FROM luggage_unbilled_extension_days
    ${rootId ? 'WHERE root_id = ?' : ''} ORDER BY billing_date, root_id`)
    .bind(...(rootId ? [rootId] : [])).all<{ root_id: string; billing_date: string }>();
  const ids: string[] = [];
  for (const day of days.results) {
    const id = await createDatedExtension(db, day.root_id, day.billing_date);
    if (id) ids.push(id);
  }
  return ids;
}

export async function nextManualExtensionDate(db: D1Database, rootId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT date(MAX(date(r.expected_pickup_at, '+9 hours'),
    COALESCE((SELECT MAX(e.coverage_end) FROM luggage_billing_lines e WHERE e.parent_order_id = r.order_id),
      date(r.expected_pickup_at, '+9 hours'))), '+1 day') AS billing_date
    FROM luggage_orders r WHERE r.order_id = ? AND r.parent_order_id IS NULL
      AND r.status IN ('PAID', 'PAYMENT_PENDING')`).bind(rootId).first<{ billing_date: string | null }>();
  return row?.billing_date ?? null;
}

type CollectionLine = {
  order_id: string; status: string; billed_amount: number; recorded_amount: number; legacy_paid_estimate: number; collectible_amount: number; root_review_required: number;
};

export function collectionAllocation(body: Record<string, unknown>, outstanding: number): PaymentAllocation {
  if (!Number.isSafeInteger(outstanding) || outstanding <= 0 || outstanding > 500000) {
    throw new BillingConflict('미수납액을 확인해주세요 (1~500000엔)');
  }
  // This endpoint accepts exact integer amounts, never rounded decimals/NaN/Infinity.
  for (const key of ['cash_amount', 'qr_amount']) {
    if (body[key] !== undefined && body[key] !== '') {
      const value = body[key];
      if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))
        || !Number.isSafeInteger(Number(value)) || Number(value) > 500000) throw new BillingConflict('수납액은 정수 엔 단위로 입력해주세요');
    }
  }
  if (!/^\d+$/.test(String(body.expected_amount)) || Number(body.expected_amount) !== outstanding) throw new BillingConflict('미수납액이 변경되었습니다. 새로고침 후 확인해주세요');
  const allocation = normalizePaymentAllocation(body, outstanding);
  if ('error' in allocation) throw new BillingConflict(allocation.error);
  return allocation;
}

/** A confirmation of money already received on site, not a payment-provider charge. */
export async function confirmCollection(db: D1Database, orderId: string, staffId: string, body: Record<string, unknown>) {
  const requestId = String(body.request_id ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new BillingConflict('유효한 수납 요청 ID가 필요합니다');
  if (body.confirm_received !== 'yes') throw new BillingConflict('현장 수납 확인이 필요합니다');
  if (await db.prepare("SELECT 1 FROM luggage_audit_logs WHERE action = 'CONFIRM_COLLECTION' AND device_id = ?").bind(requestId).first()) {
    throw new BillingConflict('이미 처리된 수납 요청입니다');
  }
  let summary = await getBillingSummary(db, orderId);
  if (!summary || summary.invalid_amount) throw new BillingConflict('주문 금액을 확인해주세요');
  if (summary.root_review_required && summary.outstanding_amount === 0) throw new BillingConflict('기존 원주문 정산 차이는 추가 수납으로 확정할 수 없습니다');
  collectionAllocation(body, summary.outstanding_amount);
  const root = await db.prepare("SELECT status FROM luggage_orders WHERE order_id = ?").bind(summary.root_id).first<{ status: string }>();
  if (!root || !['PAID', 'PAYMENT_PENDING'].includes(root.status)) throw new BillingConflict('보관 중인 주문만 수납할 수 있습니다');
  await materializeOutstandingDays(db, summary.root_id);
  summary = await getBillingSummary(db, orderId);
  if (!summary || summary.invalid_amount || summary.unbilled_days) throw new BillingConflict('연장 일자를 확인해주세요');
  const allocation = collectionAllocation(body, summary.outstanding_amount);
  const lines = await db.prepare(`SELECT order_id, status, billed_amount, recorded_amount, legacy_paid_estimate, collectible_amount, root_review_required
    FROM luggage_billing_lines WHERE root_id = ? AND collectible_amount > 0
    ORDER BY parent_order_id IS NOT NULL, coverage_end, order_id`).bind(summary.root_id).all<CollectionLine>();
  const now = new Date().toISOString();
  const businessDate = new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 10);
  let cashLeft = allocation.cashAmount;
  const receipts = lines.results.flatMap(line => {
    const due = line.collectible_amount;
    const cash = Math.min(cashLeft, due);
    cashLeft -= cash;
    return [{ orderId: line.order_id, tender: 'CASH', amount: cash },
      { orderId: line.order_id, tender: 'PAY_QR', amount: due - cash }].filter(r => r.amount > 0);
  });
  if (receipts.reduce((s, r) => s + r.amount, 0) !== allocation.totalAmount) throw new BillingConflict('수납 대상이 변경되었습니다');
  const details = JSON.stringify({ requestId, rootId: summary.root_id, staffId, businessDate, recordedAt: now,
    before: summary, lines: lines.results, receipts });
  const statements = [db.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp)
    SELECT ?, ?, ?, 'CONFIRM_COLLECTION', ?, ? FROM luggage_billing_balances b
    WHERE b.root_id = ? AND b.total_billed_amount = ? AND b.recorded_amount = ? AND b.legacy_paid_estimate = ?
      AND b.outstanding_amount = ? AND b.root_review_amount = ? AND b.review_pickup_blocked = ?
      AND b.unbilled_days = 0 AND b.invalid_amount = 0
      AND EXISTS (SELECT 1 FROM luggage_orders r WHERE r.order_id = b.root_id AND r.status IN ('PAID', 'PAYMENT_PENDING'))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) snapshot
        LEFT JOIN luggage_billing_lines l ON l.order_id = json_extract(snapshot.value, '$.order_id')
        WHERE l.order_id IS NULL OR l.status IS NOT json_extract(snapshot.value, '$.status')
          OR l.billed_amount IS NOT json_extract(snapshot.value, '$.billed_amount')
          OR l.recorded_amount IS NOT json_extract(snapshot.value, '$.recorded_amount')
          OR l.legacy_paid_estimate IS NOT json_extract(snapshot.value, '$.legacy_paid_estimate')
          OR l.collectible_amount IS NOT json_extract(snapshot.value, '$.collectible_amount')
          OR l.root_review_required IS NOT json_extract(snapshot.value, '$.root_review_required'))
      RETURNING log_id`).bind(summary.root_id, staffId, requestId, details, now,
      summary.root_id, summary.total_billed_amount, summary.recorded_amount, summary.legacy_paid_estimate,
      summary.outstanding_amount, summary.root_review_amount, summary.review_pickup_blocked, JSON.stringify(lines.results))];
  // Chaining changes() means a failed initial compare writes neither receipts nor statuses.
  for (const receipt of receipts) statements.push(db.prepare(`INSERT INTO luggage_order_payments
    (order_id, business_date, tender_type, amount, staff_id, recorded_at, receipt_request_id)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(receipt.orderId, businessDate, receipt.tender, receipt.amount, staffId, now, requestId));
  for (const line of lines.results) statements.push(db.prepare(`UPDATE luggage_orders SET status = 'PAID',
    payment_method = CASE WHEN EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = luggage_orders.order_id AND p.tender_type = 'CASH')
      AND EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = luggage_orders.order_id AND p.tender_type = 'PAY_QR') THEN 'MIXED'
      WHEN EXISTS (SELECT 1 FROM luggage_order_payments p WHERE p.order_id = luggage_orders.order_id AND p.tender_type = 'PAY_QR') THEN 'PAY_QR' ELSE 'CASH' END,
    updated_at = ? WHERE order_id = ? AND EXISTS (SELECT 1 FROM luggage_order_payments p
      WHERE p.order_id = luggage_orders.order_id AND p.receipt_request_id = ?)`)
    .bind(now, line.order_id, requestId));
  // Existing zero-priced lines need no money; acknowledge them with this same audited confirmation.
  statements.push(db.prepare(`UPDATE luggage_orders SET status = 'PAID', updated_at = ?
    WHERE (order_id = ? OR parent_order_id = ?) AND status = 'PAYMENT_PENDING'
      AND COALESCE(final_amount, prepaid_amount, 0) + COALESCE(extra_amount, 0) = 0
      AND EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.action = 'CONFIRM_COLLECTION'
        AND a.device_id = ? AND a.timestamp = ?)`)
    .bind(now, summary.root_id, summary.root_id, requestId, now));
  // Refresh the parent's visible revision after linked collection without changing its claim or status.
  statements.push(db.prepare(`UPDATE luggage_orders SET updated_at = ? WHERE order_id = ?
    AND EXISTS (SELECT 1 FROM luggage_audit_logs a WHERE a.action = 'CONFIRM_COLLECTION'
      AND a.device_id = ? AND a.timestamp = ?)`)
    .bind(now, summary.root_id, requestId, now));
  const result = await db.batch(statements);
  if (!result[0].results?.length) throw new BillingConflict('주문이 변경되었습니다. 새로고침 후 확인해주세요');
  return { request_id: requestId, collected_amount: allocation.totalAmount, business_date: businessDate };
}
