import { recalculateOrderPrepaid, calculatePrepaidAmount, flyingPassDiscountAmount, FLYING_PASS_TIERS, type FlyingPassTier } from './pricing';
import type { BillingSummary } from './luggageBilling';
import type { RefundActorStaff, RefundWriteActor } from '../lib/internalActorStaff';
import { unifiedActorAuditSnapshot } from '../lib/internalActorStaff';

export class FlyingPassRefundError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 403 | 404 | 409 | 500 | 503 = 409) { super(message); }
}
const fail = (code: string, message: string, status: FlyingPassRefundError['status'] = 409): never => { throw new FlyingPassRefundError(code, message, status); };
const jstDay = (now: Date) => new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
const yen = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 500000;
export const REFUND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Root = { order_id: string; parent_order_id: string | null; status: string; created_at: string;
  prepaid_amount: number; final_amount: number; extra_amount: number; price_per_day: number; expected_storage_days: number;
  flying_pass_tier: FlyingPassTier; flying_pass_discount_amount: number; staff_prepaid_override_amount: number | null;
  suitcase_qty: number; backpack_qty: number; set_qty: number; expected_pickup_at: string | null; extension_date: string | null };
type Receipt = { payment_id: number; tender_type: string; amount: number; business_date: string; recorded_at: string; staff_id: string | null; receipt_request_id: string | null };
type History = { refund_id: string; sequence: number; status: string; amount: number; after_tier: FlyingPassTier };
export type FlyingPassRefund = { refund_id: string; order_id: string; sequence: number; previous_refund_id: string | null;
  status: 'PAYOUT_PENDING' | 'CONFIRMED' | 'CANCELLED'; currency: 'JPY'; refund_method: 'CASH'; before_tier: FlyingPassTier; after_tier: FlyingPassTier;
  original_amount: number; before_amount: number; after_amount: number; amount: number; reason: string; request_hash: string;
  root_snapshot: string; receipt_snapshot: string; registered_by_staff_id: string; actor_user_id: string; business_date: string; created_at: string;
  register_audit_id: number; terminal_hash: string | null; terminal_by_staff_id: string | null; terminal_at: string | null;
  terminal_audit_id: number | null; paid_at: string | null; cancel_reason: string | null };
type Context = { root: Root; receipts: Receipt[]; billing: BillingSummary; history: History[]; snapshots: string[]; snapshotQueries: string[] };
export type RefundQuote = { orderId: string; fingerprint: string; previousRefundId: string | null; beforeTier: FlyingPassTier; afterTier: FlyingPassTier;
  originalAmount: number; beforeAmount: number; afterAmount: number; amount: number; businessDate: string; currency: 'JPY'; refundMethod: 'CASH' };
export type RefundActor = { actor: RefundWriteActor; staff: RefundActorStaff };
const rootKeys = ['order_id','parent_order_id','status','created_at','prepaid_amount','final_amount','extra_amount','price_per_day','expected_storage_days',
  'flying_pass_tier','flying_pass_discount_amount','staff_prepaid_override_amount','suitcase_qty','backpack_qty','set_qty','expected_pickup_at','extension_date'];
const billingKeys = ['root_id','total_billed_amount','recorded_amount','legacy_paid_estimate','invalid_amount','root_review_required','review_pickup_blocked','outstanding_amount','unbilled_days','extension_count','discount_credit_amount','cash_refunded_amount','net_received_amount','total_effective_billed_amount','pending_refund_count','refund_count'];
const receiptKeys = ['payment_id','tender_type','amount','business_date','recorded_at','staff_id','receipt_request_id'];
const historyKeys = ['refund_id','sequence','status','amount','after_tier'];
const objectSql = (keys: string[]) => `json_object(${keys.map(k => `'${k}', ${k}`).join(',')})`;
// These same SQL snapshots are re-checked inside each transaction, including same-second changes.
const buildSnapshotQueries = (includeBagAdditions: boolean) => [
  `SELECT ${objectSql(rootKeys)} AS snapshot FROM luggage_orders WHERE order_id = ?`,
  `SELECT json_group_array(${objectSql(receiptKeys)}) AS snapshot FROM (SELECT * FROM luggage_order_payments WHERE order_id = ? ORDER BY payment_id)`,
  `SELECT ${objectSql(includeBagAdditions ? [...billingKeys, 'bag_addition_amount','bag_addition_count','bag_addition_daily_rate','bag_addition_discounted_amount','bag_addition_pass_discount','bag_original_price_per_day'] : billingKeys)} AS snapshot FROM luggage_billing_balances WHERE root_id = ?`,
  `SELECT json_group_array(${objectSql(historyKeys)}) AS snapshot FROM (SELECT * FROM luggage_flying_pass_refunds WHERE order_id = ? ORDER BY sequence)`,
];
async function sha256(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
async function context(db: D1Database, orderId: string): Promise<Context> {
  // Existing refund recovery remains available while an additive schema rollout is staged.
  const columns = await db.prepare("PRAGMA table_info(luggage_billing_balances)").all<{ name: string }>();
  const snapshotQueries = buildSnapshotQueries(columns.results.some(column => column.name === 'bag_addition_amount'));
  const results = await db.batch<{ snapshot: string }>(snapshotQueries.map(sql => db.prepare(sql).bind(orderId)));
  const snapshots = results.map(r => r.results[0]?.snapshot);
  if (!snapshots[0]) return fail('NOT_FOUND', '주문을 찾을 수 없습니다', 404);
  if (snapshots.some(s => !s)) return fail('BILLING_UNKNOWN', '재무 정보를 확인할 수 없습니다');
  return { root: JSON.parse(snapshots[0]), receipts: JSON.parse(snapshots[1]), billing: JSON.parse(snapshots[2]), history: JSON.parse(snapshots[3]), snapshots, snapshotQueries };
}
function guard(db: D1Database, orderId: string, c: Context): D1PreparedStatement {
  return db.prepare(`SELECT json_extract('{}', CASE WHEN ${c.snapshotQueries.map(sql => `(${sql}) IS ?`).join(' AND ')} THEN '$' ELSE 'REFUND_STALE' END)`)
    .bind(...c.snapshots.flatMap(snapshot => [orderId, snapshot]));
}
async function openDay(db: D1Database, day: string, late = false) {
  if (await db.prepare("SELECT 1 FROM luggage_cash_closings WHERE business_date = ? AND closing_type = 'FINAL_CLOSE'").bind(day).first()) {
    // Late confirmation never rewrites a finished day's closing, refund snapshot or ledger (policy: block and escalate).
    if (late) fail('CLOSING_ALREADY_FINALIZED', `실제 지급일(${day}, JST)의 최종 현금마감이 이미 완료되어 지연 확정할 수 없습니다. 과거 마감·원장은 자동으로 수정하지 않습니다. 현금을 다시 지급하지 말고 책임자에게 보고하세요`);
    fail('CLOSING_CLOSED', '환급 지급일의 최종 현금마감이 완료되어 지급을 시작하거나 확정할 수 없습니다');
  }
}
const LATE_CONFIRM_ROLES = new Set(['manager', 'super_admin']);
const jstTime = (ms: number) => new Date(ms + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
function eligibility(c: Context, pendingId?: string) {
  const r = c.root, b = c.billing;
  if (r.parent_order_id !== null) fail('ROOT_ORDER_REQUIRED', '원주문에서 환급을 처리해주세요');
  if (r.status !== 'PAID') fail('STATUS_NOT_EDITABLE', '결제 완료(PAID) 원주문만 환급할 수 있습니다');
  if (r.staff_prepaid_override_amount !== null) fail('MANUAL_AMOUNT', '수동 금액 주문은 별도 정산 확인이 필요합니다');
  if (!c.receipts.length) fail('RECEIPT_REQUIRED', '실제 원 수납 근거가 필요합니다');
  if (b.invalid_amount !== 0 || b.root_review_required !== 0 || b.review_pickup_blocked !== 0 || b.legacy_paid_estimate !== 0) {
    fail('BILLING_REVIEW_REQUIRED', '불명확한 수납 또는 정산 상태를 먼저 확인해주세요');
  }
  if (b.outstanding_amount !== 0 || b.unbilled_days !== 0) fail('OUTSTANDING', '원주문·연장 미수납을 먼저 수납해주세요');
  if (c.history.some(h => h.status === 'PAYOUT_PENDING' && h.refund_id !== pendingId)) fail('REFUND_PENDING', '진행 중인 지급 건이 있습니다. 지급 여부를 조회·확인하세요. 현금을 다시 지급하지 마세요');
  if (!yen(r.final_amount) || r.final_amount + (b.bag_addition_amount ?? 0) === 0 || r.prepaid_amount !== r.final_amount || !yen(r.extra_amount)
    || !yen(r.price_per_day) || r.price_per_day === 0 || !Number.isSafeInteger(r.expected_storage_days) || r.expected_storage_days < 1
    || !FLYING_PASS_TIERS.includes(r.flying_pass_tier)) fail('NORMAL_PRICE_NOT_VERIFIED', '최초 정상 요금의 계산 근거를 확인할 수 없습니다');
  const initial = recalculateOrderPrepaid(b.bag_original_price_per_day ?? r.price_per_day, r.expected_storage_days, r.flying_pass_tier);
  if (initial.finalPrepaid !== r.final_amount || initial.flyingPassDiscountAmount !== r.flying_pass_discount_amount) fail('NORMAL_PRICE_NOT_VERIFIED', '최초 정상 요금과 할인 근거가 일치하지 않습니다');
  for (const p of c.receipts) {
    const time = new Date(p.recorded_at.includes('T') ? p.recorded_at : `${p.recorded_at.replace(' ', 'T')}Z`);
    if (!yen(p.amount) || p.amount === 0 || !['CASH','PAY_QR'].includes(p.tender_type) || !Number.isFinite(time.getTime()) || p.business_date !== jstDay(time)) {
      fail('RECEIPT_INVALID', '원 수납 금액·수단·지급일 근거가 올바르지 않습니다');
    }
  }
  if (c.receipts.reduce((sum, p) => sum + p.amount, 0) !== r.final_amount + r.extra_amount + (b.bag_addition_amount ?? 0)) fail('RECEIPT_INVALID', '원 청구액과 실제 수납액이 일치하지 않습니다');
}
async function quote(c: Context, target: FlyingPassTier, now: Date): Promise<RefundQuote> {
  const confirmed = c.history.filter(h => h.status === 'CONFIRMED');
  const last = confirmed.at(-1);
  const originalAmount = c.root.final_amount + (c.billing.bag_addition_amount ?? 0);
  const beforeAmount = originalAmount - confirmed.reduce((sum, h) => sum + h.amount, 0);
  // Original and each added batch retain their own duration/long-stay tier. Fixed pass discount remains once per order.
  const base = calculatePrepaidAmount(c.billing.bag_original_price_per_day ?? c.root.price_per_day, c.root.expected_storage_days).prepaidAmount
    + (c.billing.bag_addition_discounted_amount ?? 0);
  const afterAmount = Math.max(0,base-flyingPassDiscountAmount(base,target));
  const amount = beforeAmount - afterAmount;
  if (!yen(afterAmount) || !yen(amount) || amount === 0) fail('NO_REFUND_DUE', '추가 환급 가능한 할인 차액이 없습니다');
  return { orderId: c.root.order_id, fingerprint: await sha256(c.snapshots), previousRefundId: last?.refund_id ?? null,
    beforeTier: last?.after_tier ?? c.root.flying_pass_tier, afterTier: target, originalAmount,
    beforeAmount, afterAmount, amount, businessDate: jstDay(now), currency: 'JPY', refundMethod: 'CASH' };
}
export async function previewFlyingPassRefund(db: D1Database, orderId: string, target: FlyingPassTier, now = new Date()): Promise<RefundQuote> {
  const c = await context(db, orderId);
  eligibility(c);
  await openDay(db, jstDay(now));
  return quote(c, target, now);
}
export async function getFlyingPassRefund(db: D1Database, orderId: string, refundId: string): Promise<FlyingPassRefund> {
  const row = await db.prepare('SELECT * FROM luggage_flying_pass_refunds WHERE order_id = ? AND refund_id = ?').bind(orderId, refundId).first<FlyingPassRefund>();
  return row ?? fail('NOT_FOUND', '환급 기록을 찾을 수 없습니다', 404);
}
function writeError(error: unknown): never {
  if (error instanceof FlyingPassRefundError) throw error;
  const message = [error, error instanceof Error ? error.cause : null].map(String).join(' ');
  if (/REFUND_STALE|REFUND_REGISTRATION_CONFLICT|REFUND_CONFIRMATION_CONFLICT|UNIQUE constraint/.test(message)) fail('STALE', '환급·주문·마감 상태가 변경되었습니다. 같은 환급 ID로 결과를 먼저 조회해주세요');
  return fail('WRITE_FAILED', '환급 저장 결과를 확인할 수 없습니다. 같은 환급 ID로 조회하고 현금을 다시 지급하지 마세요', 500);
}
export async function registerFlyingPassRefund(db: D1Database, orderId: string, input: {
  refundId: string; targetTier: FlyingPassTier; reason: string; expectedFingerprint: string;
}, who: RefundActor, now = new Date()): Promise<{ refund: FlyingPassRefund; replayed: boolean }> {
  const requestHash = await sha256({ orderId, ...input, userId: who.actor.userId, staffId: who.staff.id });
  const replay = async () => {
    const found = await db.prepare('SELECT * FROM luggage_flying_pass_refunds WHERE refund_id = ?').bind(input.refundId).first<FlyingPassRefund>();
    if (!found) return null;
    if (found.order_id !== orderId || found.request_hash !== requestHash) return fail('IDEMPOTENCY_CONFLICT', '환급 ID가 다른 요청에 사용되었습니다');
    return { refund: found, replayed: true };
  };
  const previous = await replay();
  if (previous) return previous;
  try {
    const c = await context(db, orderId);
    eligibility(c);
    const q = await quote(c, input.targetTier, now);
    if (q.fingerprint !== input.expectedFingerprint) fail('STALE', '미리보기 이후 주문·재무 정보가 변경되었습니다');
    await openDay(db, q.businessDate);
    const action = 'FLYING_PASS_REFUND_REGISTER', at = now.toISOString();
    const details = JSON.stringify({ ...q, reason: input.reason, requestHash, ...unifiedActorAuditSnapshot(who.actor, who.staff) });
    await db.batch([
      guard(db, orderId, c),
      db.prepare('INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(orderId, who.staff.id, input.refundId, action, details, at),
      db.prepare(`INSERT INTO luggage_flying_pass_refunds(refund_id, order_id, sequence, previous_refund_id, status,
        before_tier, after_tier, original_amount, before_amount, after_amount, amount, reason, request_hash, root_snapshot, receipt_snapshot,
        registered_by_staff_id, actor_user_id, business_date, created_at, register_audit_id)
        VALUES (?, ?, ?, ?, 'PAYOUT_PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          (SELECT log_id FROM luggage_audit_logs WHERE device_id = ? AND action = ?))`)
        .bind(input.refundId, orderId, (c.history.at(-1)?.sequence ?? 0) + 1, q.previousRefundId, q.beforeTier, q.afterTier,
          q.originalAmount, q.beforeAmount, q.afterAmount, q.amount, input.reason, requestHash, c.snapshots[0], c.snapshots[1],
          who.staff.id, who.actor.userId, q.businessDate, at, input.refundId, action),
      db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds f JOIN luggage_audit_logs a ON a.log_id = f.register_audit_id
        WHERE f.refund_id = ? AND f.request_hash = ? AND f.status = 'PAYOUT_PENDING' AND a.details = ?) THEN '$' ELSE 'REFUND_ATOMICITY_FAILED' END)`)
        .bind(input.refundId, requestHash, details),
    ]);
    return { refund: await getFlyingPassRefund(db, orderId, input.refundId), replayed: false };
  } catch (error) {
    const found = await replay();
    if (found) return found;
    return writeError(error);
  }
}
export type LateConfirm = { paidAt: string; reason: string };
export async function finishFlyingPassRefund(db: D1Database, orderId: string, refundId: string, input:
  { action: 'confirm'; cashPaid: true; expectedAmount: number; lateConfirm?: LateConfirm } | { action: 'cancel'; confirmNotPaid: true; reason: string },
  who: RefundActor, now = new Date()): Promise<{ refund: FlyingPassRefund; replayed: boolean }> {
  // Late confirmation = recording a past JST day's real cash payout. Manager/super_admin only (signed actor role; the DB re-checks the audited role).
  const late = input.action === 'confirm' ? input.lateConfirm : undefined;
  if (late && !LATE_CONFIRM_ROLES.has(who.actor.role)) fail('MANAGER_REQUIRED', '날짜가 지난 지급 건의 지연 확정은 매니저·최고관리자만 할 수 있습니다. 현금을 다시 지급하지 마세요', 403);
  const terminalHash = await sha256({ ...input, userId: who.actor.userId, staffId: who.staff.id });
  // Shift handover: any permitted staff (center_staff/part_time/manager/super_admin) may finish another staff's payout.
  // The terminal actor is recorded separately (terminal_by_staff_id + terminal audit actor); terminalHash binds the replay to that actor.
  const row = await getFlyingPassRefund(db, orderId, refundId);
  const status = input.action === 'confirm' ? 'CONFIRMED' : 'CANCELLED';
  const replay = (found: FlyingPassRefund) => {
    if (found.status !== status || found.terminal_hash !== terminalHash) return fail('TERMINAL_CONFLICT', '이미 다른 내용으로 처리된 지급 건입니다. 기존 기록을 확인해주세요');
    return { refund: found, replayed: true };
  };
  if (row.status !== 'PAYOUT_PENDING') return replay(row);
  try {
    let c: Context | null = null;
    if (input.action === 'confirm') {
      if (late) {
        if (row.business_date >= jstDay(now)) fail('LATE_CONFIRM_NOT_NEEDED', '오늘 등록한 지급 건은 일반 지급 완료 확인을 사용하세요');
        const paid = Date.parse(late.paidAt), created = Date.parse(row.created_at);
        if (!Number.isFinite(paid) || new Date(paid).toISOString() !== late.paidAt) fail('PAID_AT_INVALID', '실제 지급 일시 형식이 올바르지 않습니다', 400);
        if (paid < created) fail('PAID_AT_INVALID', `실제 지급 일시는 지급 건 등록 시각(${jstTime(created)} JST) 이후여야 합니다`, 400);
        if (paid >= now.getTime()) fail('PAID_AT_INVALID', '실제 지급 일시는 현재 시각 이전이어야 합니다', 400);
      } else if (row.business_date !== jstDay(now)) fail('PAYOUT_DAY_CHANGED', '지급일이 변경되었습니다. 실제 지급일 확인 전에는 자동 확정하거나 재지급하지 마세요');
      if (input.expectedAmount !== row.amount) fail('AMOUNT_CHANGED', '확인한 현금 지급액이 등록 금액과 다릅니다');
      c = await context(db, orderId);
      eligibility(c, refundId);
      const q = await quote(c, row.after_tier, now);
      if (row.root_snapshot !== c.snapshots[0] || row.receipt_snapshot !== c.snapshots[1] || q.amount !== row.amount
        || q.previousRefundId !== row.previous_refund_id || q.beforeTier !== row.before_tier) fail('STALE', '원 수납 또는 계산 근거가 변경되었습니다');
      // Settlement attribution = JST day of the real payout (late) or of registration (same-day confirm; identical by construction).
      await openDay(db, late ? jstDay(new Date(late.paidAt)) : row.business_date, Boolean(late));
    }
    const action = input.action === 'confirm' ? 'FLYING_PASS_REFUND_CONFIRM' : 'FLYING_PASS_REFUND_CANCEL';
    const at = now.toISOString();
    const details = JSON.stringify({ refundId, ...input, amount: row.amount, businessDate: row.business_date,
      ...(late ? { settlementDate: jstDay(new Date(late.paidAt)) } : {}), terminalHash, ...unifiedActorAuditSnapshot(who.actor, who.staff) });
    await db.batch([
      ...(c ? [guard(db, orderId, c)] : []),
      db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds WHERE refund_id = ? AND order_id = ? AND status = 'PAYOUT_PENDING' AND request_hash = ?) THEN '$' ELSE 'REFUND_STALE' END)`)
        .bind(refundId, orderId, row.request_hash),
      db.prepare('INSERT INTO luggage_audit_logs(order_id, staff_id, device_id, action, details, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(orderId, who.staff.id, refundId, action, details, at),
      db.prepare(`UPDATE luggage_flying_pass_refunds SET status = ?, terminal_hash = ?, terminal_by_staff_id = ?, terminal_at = ?,
        terminal_audit_id = (SELECT log_id FROM luggage_audit_logs WHERE device_id = ? AND action = ?), paid_at = ?, cancel_reason = ?
        WHERE refund_id = ? AND order_id = ? AND status = 'PAYOUT_PENDING'`)
        .bind(status, terminalHash, who.staff.id, at, refundId, action, input.action === 'confirm' ? late?.paidAt ?? at : null,
          input.action === 'cancel' ? input.reason : null, refundId, orderId),
      db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (SELECT 1 FROM luggage_flying_pass_refunds f JOIN luggage_audit_logs a ON a.log_id = f.terminal_audit_id
        WHERE f.refund_id = ? AND f.status = ? AND f.terminal_hash = ? AND a.details = ?) THEN '$' ELSE 'REFUND_ATOMICITY_FAILED' END)`)
        .bind(refundId, status, terminalHash, details),
    ]);
    return { refund: await getFlyingPassRefund(db, orderId, refundId), replayed: false };
  } catch (error) {
    const found = await getFlyingPassRefund(db, orderId, refundId);
    if (found.status !== 'PAYOUT_PENDING') return replay(found);
    return writeError(error);
  }
}
