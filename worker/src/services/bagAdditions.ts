import { calculatePricePerDay, calculatePrepaidAmount, normalizeFlyingPassTier, recalculateOrderPrepaid } from './pricing';
import { formatDateJST, calculateStorageDays } from './storage';
import { getBillingSummary, confirmCollection } from './luggageBilling';
export class BagAdditionError extends Error {
    constructor(public code: string, message: string, public status = 409) { super(message); }
}
function fail(code: string, message: string, status = 409): never { throw new BagAdditionError(code, message, status); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Root = {
    order_id: string;
    status: string;
    parent_order_id: string | null;
    updated_at: string;
    created_at: string;
    expected_pickup_at: string | null;
    actual_pickup_at: string | null;
    expected_storage_days: number;
    suitcase_qty: number;
    backpack_qty: number;
    set_qty: number;
    price_per_day: number;
    flying_pass_tier: string;
    flying_pass_discount_amount: number;
    prepaid_amount: number;
    final_amount: number | null;
    extra_amount: number;
    staff_prepaid_override_amount: number | null;
};
export type BagCounts = {
    suitcaseAdded: number;
    backpackAdded: number;
    coverageStartDate?: string;
    coverageEndDate?: string;
};
export type BagAdditionInput = BagCounts & {
    additionId: string;
    expectedFingerprint: string;
    reason: string;
    payment?: {
        confirmReceived: true;
        cashAmount: number;
        qrAmount: number;
    };
};
export type BagAdditionActor = {
    staffId: string;
    actor?: unknown;
};
async function hash(value: unknown) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(x => x.toString(16).padStart(2, '0')).join(''); }
function counts(input: BagCounts) {
    for (const n of [input.suitcaseAdded, input.backpackAdded])
        if (!Number.isSafeInteger(n) || n < 0 || n > 99)
            fail('INVALID_REQUEST', '추가 수량은 0~99의 정수여야 합니다', 400);
    if (input.suitcaseAdded + input.backpackAdded < 1)
        fail('INVALID_REQUEST', '추가할 짐을 입력해주세요', 400);
}
function utcDate(value: string) { return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z'); }
const SNAPSHOT = Symbol('bag-addition-snapshot');
const sqlObject = (v: object) => `json_object(${Object.keys(v).map(k => {
    if (!/^[a-z_]+$/.test(k))
        throw new Error('Invalid schema key');
    return `'${k}', ${k}`;
}).join(',')})`;
export async function previewBagAddition(db: D1Database, orderId: string, input: BagCounts, now = new Date()) {
    counts(input);
    const root = await db.prepare(`SELECT order_id,status,parent_order_id,updated_at,created_at,expected_pickup_at,actual_pickup_at,
      expected_storage_days,suitcase_qty,backpack_qty,set_qty,price_per_day,flying_pass_tier,flying_pass_discount_amount,
      prepaid_amount,final_amount,extra_amount,staff_prepaid_override_amount FROM luggage_orders WHERE order_id=?`).bind(orderId).first<Root>();
    if (!root)
        fail('NOT_FOUND', '주문을 찾을 수 없습니다', 404);
    if (root.parent_order_id || root.status !== 'PAID' || root.actual_pickup_at)
        fail('STATUS_NOT_ELIGIBLE', '결제 완료·미수령 원주문에서만 짐을 추가할 수 있습니다');
    if (!root.expected_pickup_at || root.staff_prepaid_override_amount !== null)
        fail('OVERRIDE_REVIEW_REQUIRED', '수동 금액·수령 예정일을 먼저 확인해주세요');
    const businessDate = formatDateJST(now), endDate = formatDateJST(utcDate(root.expected_pickup_at));
    const coverageStartDate = input.coverageStartDate ?? businessDate, coverageEndDate = input.coverageEndDate ?? endDate;
    for (const date of [coverageStartDate, coverageEndDate])
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date)
            fail('INVALID_REQUEST', '올바른 보관 날짜를 입력해주세요', 400);
    if (coverageStartDate !== businessDate || coverageEndDate !== endDate || coverageEndDate < coverageStartDate || formatDateJST(utcDate(root.created_at)) > businessDate)
        fail('INVALID_PERIOD', '추가일 당일부터 기존 수령 예정일까지의 기간만 등록할 수 있습니다');
    // Existing accrual includes the next day from 21:00 JST. Do not accept a stale same-day interval at that boundary.
    if (endDate === businessDate && new Date(now.getTime() + 9 * 3600000).getUTCHours() >= 21)
        fail('PICKUP_DEADLINE_PASSED', '21시 마감 이후에는 연장 상태를 먼저 확인해주세요');
    const [billing, receipts, linked, pending, closing, history] = await Promise.all([
        getBillingSummary(db, orderId),
        db.prepare('SELECT payment_id,tender_type,amount,business_date,recorded_at,receipt_request_id FROM luggage_order_payments WHERE order_id=? ORDER BY payment_id').bind(orderId).all(),
        db.prepare('SELECT 1 FROM luggage_orders WHERE parent_order_id=? LIMIT 1').bind(orderId).first(),
        db.prepare("SELECT 1 FROM luggage_flying_pass_refunds WHERE order_id=? AND status='PAYOUT_PENDING' LIMIT 1").bind(orderId).first(),
        db.prepare("SELECT 1 FROM luggage_cash_closings WHERE business_date=? AND closing_type='FINAL_CLOSE' LIMIT 1").bind(businessDate).first(),
        db.prepare('SELECT suitcase_added,backpack_added,set_added,batch_price_per_day FROM luggage_bag_additions WHERE order_id=? ORDER BY revision,addition_id').bind(orderId).all<{
            suitcase_added: number;
            backpack_added: number;
            set_added: number;
            batch_price_per_day: number;
        }>(),
    ]);
    if (linked || pending)
        fail('RELATED_HISTORY_REVIEW_REQUIRED', '기존 연장 주문 또는 진행 중인 환급을 먼저 확인해주세요');
    if (closing)
        fail('DAY_CLOSED', '최종 마감된 영업일에는 추가 짐을 등록할 수 없습니다');
    if (!billing || billing.invalid_amount || billing.root_review_required || billing.outstanding_amount || billing.unbilled_days || billing.legacy_paid_estimate || billing.pending_refund_count || billing.recorded_amount !== billing.total_billed_amount)
        fail('BILLING_CONFLICT', '기존 청구·수납을 먼저 확인해주세요');
    const added = history.results.reduce((a, b) => ({ suitcase: a.suitcase + b.suitcase_added, backpack: a.backpack + b.backpack_added, set: a.set + b.set_added, daily: a.daily + b.batch_price_per_day }), { suitcase: 0, backpack: 0, set: 0, daily: 0 });
    if (root.suitcase_qty - added.suitcase < 0 || root.backpack_qty - added.backpack < 0 || root.suitcase_qty + root.backpack_qty - added.suitcase - added.backpack < 1)
        fail('PRICE_REVIEW_REQUIRED', '기존 짐 수량 근거를 확인해주세요');
    const original = calculatePricePerDay(root.suitcase_qty - added.suitcase, root.backpack_qty - added.backpack);
    const originalPrice = recalculateOrderPrepaid(original.pricePerDay, root.expected_storage_days, normalizeFlyingPassTier(root.flying_pass_tier));
    if (root.expected_storage_days !== calculateStorageDays(utcDate(root.created_at), utcDate(root.expected_pickup_at)) || root.set_qty !== original.setQty + added.set || root.price_per_day !== original.pricePerDay + added.daily || root.prepaid_amount !== originalPrice.finalPrepaid || root.final_amount !== originalPrice.finalPrepaid || root.flying_pass_discount_amount !== originalPrice.flyingPassDiscountAmount)
        fail('PRICE_REVIEW_REQUIRED', '기존 짐의 기간·단가·할인 근거를 확인해주세요');
    const suitcaseQty = root.suitcase_qty + input.suitcaseAdded, backpackQty = root.backpack_qty + input.backpackAdded;
    if (suitcaseQty > 99 || backpackQty > 99)
        fail('INVALID_REQUEST', '전체 수량은 종류별 99개 이하여야 합니다', 400);
    const own = calculatePricePerDay(input.suitcaseAdded, input.backpackAdded), storageDays = calculateStorageDays(coverageStartDate + 'T00:00:00+09:00', coverageEndDate + 'T00:00:00+09:00');
    const ownPrice = calculatePrepaidAmount(own.pricePerDay, storageDays), tier = normalizeFlyingPassTier(billing.effective_flying_pass_tier);
    // The fixed pass discount belongs to the order once; only the existing BLACK full-free rule applies to this batch.
    const passDiscount = tier === 'BLACK' ? ownPrice.prepaidAmount : 0, amount = ownPrice.prepaidAmount - passDiscount;
    if (!Number.isSafeInteger(amount) || amount < 0 || storageDays > 3660 || ownPrice.prepaidAmount > 500000 || billing.total_billed_amount + amount > 500000 || root.price_per_day + own.pricePerDay > 500000)
        fail('PRICE_REVIEW_REQUIRED', '추가 청구액과 기간을 확인해주세요');
    const batch = { policyVersion: 'SEPARATE_REMAINING_PERIOD_V1', coverageStartDate, coverageEndDate, storageDays, setQty: own.setQty, pricePerDay: own.pricePerDay, discountRate: ownPrice.discountRate, baseAmount: own.pricePerDay * storageDays, longStayDiscountAmount: own.pricePerDay * storageDays - ownPrice.prepaidAmount, discountedAmount: ownPrice.prepaidAmount, flyingPassTier: tier, flyingPassDiscountAmount: passDiscount, amount };
    const fingerprint = await hash({ root, billing, receipts: receipts.results, quoteInput: { suitcaseAdded: input.suitcaseAdded, backpackAdded: input.backpackAdded, coverageStartDate, coverageEndDate }, batch });
    return { [SNAPSHOT]: { root, billing, receipts: receipts.results }, orderId, businessDate, coverageStartDate, coverageEndDate, batch, originalClaim: root.final_amount + root.extra_amount, billedBefore: billing.total_billed_amount, receivedBefore: billing.recorded_amount, amount, billedAfter: billing.total_billed_amount + amount, effectiveBilledAfter: billing.total_effective_billed_amount + amount,
        before: { suitcaseQty: root.suitcase_qty, backpackQty: root.backpack_qty, setQty: root.set_qty, pricePerDay: root.price_per_day, updatedAt: root.updated_at }, after: { suitcaseQty, backpackQty, setQty: root.set_qty + own.setQty, pricePerDay: root.price_per_day + own.pricePerDay }, fingerprint };
}
export async function registerBagAddition(db: D1Database, orderId: string, input: BagAdditionInput, who: BagAdditionActor, now = new Date()) {
    counts(input);
    if (!UUID.test(input.additionId) || !/^[0-9a-f]{64}$/.test(input.expectedFingerprint) || !who.staffId?.trim()
        || typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.trim().length > 200)
        fail('INVALID_REQUEST', '요청 식별자·사유·직원 정보를 확인해주세요', 400);
    const payment = input.payment;
    if (payment && (payment.confirmReceived !== true || [payment.cashAmount, payment.qrAmount].some(x => !Number.isSafeInteger(x) || x < 0 || x > 500000)))
        fail('INVALID_REQUEST', '실제로 받은 현금·QR 금액을 확인해주세요', 400);
    const requestHash = await hash({ orderId, staffId: who.staffId, actor: who.actor, additionId: input.additionId, expectedFingerprint: input.expectedFingerprint, suitcaseAdded: input.suitcaseAdded, backpackAdded: input.backpackAdded, reason: input.reason.trim(), coverageStartDate: input.coverageStartDate ?? null, coverageEndDate: input.coverageEndDate ?? null, payment: payment ? { confirmReceived: true, cashAmount: payment.cashAmount, qrAmount: payment.qrAmount } : null });
    const replay = await db.prepare('SELECT order_id,request_hash,amount FROM luggage_bag_additions WHERE addition_id=?').bind(input.additionId).first<{
        order_id: string;
        request_hash: string;
        amount: number;
    }>();
    if (replay) {
        if (replay.order_id !== orderId || replay.request_hash !== requestHash)
            fail('IDEMPOTENCY_CONFLICT', '다른 내용으로 이미 처리한 요청입니다');
        return { additionId: input.additionId, amount: replay.amount, replayed: true };
    }
    const quote = await previewBagAddition(db, orderId, input, now);
    if (quote.fingerprint !== input.expectedFingerprint)
        fail('STALE', '주문이 변경되었습니다. 새로고침 후 확인해주세요');
    if (payment && (quote.amount === 0 || payment.cashAmount + payment.qrAmount !== quote.amount))
        fail('INVALID_REQUEST', '현금·QR 합계가 추가 청구액과 일치해야 합니다', 400);
    const createdAt = now.toISOString(), previous = utcDate(quote.before.updatedAt).getTime();
    if (!Number.isFinite(previous))
        fail('INVALID_REVISION', '주문 수정 시각을 확인해주세요');
    const revision = new Date(Math.max(now.getTime(), previous + 1)).toISOString();
    const detail = JSON.stringify({ requestHash, amount: quote.amount, revision, actor: who.actor, staffId: who.staffId,
        before: quote.before, after: quote.after, batch: quote.batch, reason: input.reason.trim(), businessDate: quote.businessDate, payment: payment ?? null });
    const row = { addition_id: input.additionId, order_id: orderId, request_hash: requestHash, suitcase_added: input.suitcaseAdded, backpack_added: input.backpackAdded, set_added: quote.batch.setQty,
        before_suitcase: quote.before.suitcaseQty, before_backpack: quote.before.backpackQty, before_set_qty: quote.before.setQty, before_price_per_day: quote.before.pricePerDay,
        after_suitcase: quote.after.suitcaseQty, after_backpack: quote.after.backpackQty, after_set_qty: quote.after.setQty, after_price_per_day: quote.after.pricePerDay,
        batch_price_per_day: quote.batch.pricePerDay, coverage_start_date: quote.coverageStartDate, coverage_end_date: quote.coverageEndDate, original_pickup_at: quote[SNAPSHOT].root.expected_pickup_at!,
        storage_days: quote.batch.storageDays, discount_rate: quote.batch.discountRate, base_amount: quote.batch.baseAmount, discounted_amount: quote.batch.discountedAmount,
        flying_pass_tier: quote.batch.flyingPassTier, flying_pass_discount_amount: quote.batch.flyingPassDiscountAmount, amount: quote.amount, policy_version: quote.batch.policyVersion,
        before_updated_at: quote.before.updatedAt, revision, business_date: quote.businessDate, created_at: createdAt, staff_id: who.staffId, reason: input.reason.trim() };
    const snapshot = quote[SNAPSHOT];
    const statements = [
        db.prepare(`SELECT json_extract('{}', CASE WHEN
          (SELECT ${sqlObject(snapshot.root)} FROM luggage_orders WHERE order_id=?) IS ?
          AND (SELECT ${sqlObject(snapshot.billing)} FROM luggage_billing_balances WHERE root_id=?) IS ?
          AND (SELECT json_group_array(${sqlObject(snapshot.receipts[0] ?? { payment_id: null, tender_type: null, amount: null, business_date: null, recorded_at: null, receipt_request_id: null })}) FROM (SELECT payment_id,tender_type,amount,business_date,recorded_at,receipt_request_id FROM luggage_order_payments WHERE order_id=? ORDER BY payment_id)) IS ?
          THEN '$' ELSE 'BAG_ADDITION_STALE' END)`).bind(orderId, JSON.stringify(snapshot.root), orderId, JSON.stringify(snapshot.billing), orderId, JSON.stringify(snapshot.receipts)),
        db.prepare(`INSERT INTO luggage_audit_logs(order_id,staff_id,device_id,action,details,timestamp) VALUES(?,?,?,'BAG_ADDITION_REGISTER',?,?)`).bind(orderId, who.staffId, input.additionId, detail, createdAt),
    ];
    statements.push(db.prepare(`INSERT INTO luggage_bag_additions(${Object.keys(row).join(',')},audit_id) VALUES(${Object.keys(row).map(() => '?').join(',')},(SELECT log_id FROM luggage_audit_logs WHERE device_id=? AND action='BAG_ADDITION_REGISTER'))`).bind(...Object.values(row), input.additionId));
    if (payment) {
        const receipts = [{ tender: 'CASH', amount: payment.cashAmount }, { tender: 'PAY_QR', amount: payment.qrAmount }].filter(x => x.amount > 0);
        statements.push(db.prepare(`INSERT INTO luggage_audit_logs(order_id,staff_id,device_id,action,details,timestamp)
      VALUES(?,?,?,'CONFIRM_COLLECTION',?,?)`).bind(orderId, who.staffId, input.additionId, JSON.stringify({ source: 'BAG_ADDITION', additionId: input.additionId, requestId: input.additionId,
            rootId: orderId, staffId: who.staffId, businessDate: quote.businessDate, recordedAt: createdAt, receipts }), createdAt));
        for (const r of receipts)
            statements.push(db.prepare(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at,receipt_request_id)
      VALUES(?,?,?,?,?,?,?)`).bind(orderId, quote.businessDate, r.tender, r.amount, who.staffId, createdAt, input.additionId));
        statements.push(db.prepare(`UPDATE luggage_orders SET payment_method=CASE
      WHEN EXISTS(SELECT 1 FROM luggage_order_payments WHERE order_id=? AND tender_type='CASH')
        AND EXISTS(SELECT 1 FROM luggage_order_payments WHERE order_id=? AND tender_type='PAY_QR') THEN 'MIXED'
      WHEN EXISTS(SELECT 1 FROM luggage_order_payments WHERE order_id=? AND tender_type='PAY_QR') THEN 'PAY_QR' ELSE 'CASH' END WHERE order_id=?`).bind(orderId, orderId, orderId, orderId));
    }
    statements.push(db.prepare(`SELECT json_extract('{}', CASE WHEN EXISTS (
    SELECT 1 FROM luggage_bag_additions a JOIN luggage_orders o ON o.order_id=a.order_id
      JOIN luggage_billing_balances b ON b.root_id=o.order_id JOIN luggage_audit_logs log ON log.log_id=a.audit_id
    WHERE a.addition_id=? AND a.request_hash=? AND a.order_id=? AND log.action='BAG_ADDITION_REGISTER'
      AND o.suitcase_qty=? AND o.backpack_qty=? AND o.price_per_day=? AND o.updated_at=?
      AND b.recorded_amount=? AND b.total_billed_amount=? AND b.root_review_required=0 AND b.invalid_amount=0
  ) THEN '$' ELSE 'BAG_ADDITION_ATOMICITY_FAILED' END)`).bind(input.additionId, requestHash, orderId, quote.after.suitcaseQty, quote.after.backpackQty, quote.after.pricePerDay, revision, quote.receivedBefore + (payment ? quote.amount : 0), quote.billedAfter));
    try {
        await db.batch(statements);
    }
    catch (error) {
        const winner = await db.prepare('SELECT order_id,request_hash,amount FROM luggage_bag_additions WHERE addition_id=?').bind(input.additionId).first<{
            order_id: string;
            request_hash: string;
            amount: number;
        }>();
        if (winner?.order_id === orderId && winner.request_hash === requestHash)
            return { additionId: input.additionId, amount: winner.amount, replayed: true };
        if (error instanceof Error && /BAG_ADDITION|Preserve bag|open-day|UNIQUE/.test(error.message))
            fail('STALE', '주문·수납·마감 상태가 변경되어 처리하지 않았습니다. 새로고침 후 확인해주세요');
        throw error;
    }
    return { additionId: input.additionId, amount: quote.amount, replayed: false };
}
/** Replay a recorded on-site collection by its immutable receipt/audit facts; never receive money twice. */
export async function collectBagAddition(db: D1Database, orderId: string, who: BagAdditionActor, input: {
    requestId: string;
    expectedAmount: number;
    cashAmount: number;
    qrAmount: number;
    confirmReceived: true;
}) {
    if (!UUID.test(input.requestId) || input.confirmReceived !== true || !who.staffId?.trim()
        || [input.expectedAmount, input.cashAmount, input.qrAmount].some(n => !Number.isSafeInteger(n) || n < 0 || n > 500000)
        || input.expectedAmount <= 0 || input.cashAmount + input.qrAmount !== input.expectedAmount)
        fail('INVALID_REQUEST', '실제 수납액과 미수납액을 확인해주세요', 400);
    const replay = async () => {
        const old = await db.prepare("SELECT order_id,staff_id FROM luggage_audit_logs WHERE device_id=? AND action='CONFIRM_COLLECTION'").bind(input.requestId).first<{
            order_id: string;
            staff_id: string;
        }>();
        if (!old)
            return null;
        const receipt = await db.prepare(`SELECT SUM(p.amount) AS amount,
            SUM(CASE WHEN p.tender_type='CASH' THEN p.amount ELSE 0 END) AS cash,
            SUM(CASE WHEN p.tender_type='PAY_QR' THEN p.amount ELSE 0 END) AS qr, MIN(p.business_date) AS day,
            SUM(CASE WHEN o.order_id=? OR o.parent_order_id=? THEN 0 ELSE 1 END) AS unrelated
            FROM luggage_order_payments p JOIN luggage_orders o ON o.order_id=p.order_id WHERE p.receipt_request_id=?`)
            .bind(orderId, orderId, input.requestId).first<{
            amount: number;
            cash: number;
            qr: number;
            day: string;
            unrelated: number;
        }>();
        if (old.order_id !== orderId || old.staff_id !== who.staffId || !receipt || receipt.unrelated || receipt.amount !== input.expectedAmount
            || receipt.cash !== input.cashAmount || receipt.qr !== input.qrAmount)
            fail('IDEMPOTENCY_CONFLICT', '다른 내용으로 처리된 수납 요청입니다');
        return { request_id: input.requestId, collected_amount: receipt.amount, business_date: receipt.day, replayed: true };
    };
    const prior = await replay();
    if (prior)
        return prior;
    if (!await db.prepare('SELECT 1 FROM luggage_bag_additions WHERE order_id=? LIMIT 1').bind(orderId).first())
        fail('NOT_FOUND', '추가 짐 청구가 없는 주문입니다', 404);
    try {
        return { ...await confirmCollection(db, orderId, who.staffId, { request_id: input.requestId, confirm_received: 'yes', expected_amount: input.expectedAmount, cash_amount: input.cashAmount, qr_amount: input.qrAmount }), replayed: false };
    }
    catch (error) {
        const found = await replay();
        if (found)
            return found;
        throw error;
    }
}
