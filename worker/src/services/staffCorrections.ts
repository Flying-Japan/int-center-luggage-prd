import { calculatePricePerDay, recalculateOrderPrepaid, normalizeFlyingPassTier } from './pricing';
import { getBillingSummary, type BillingSummary } from './luggageBilling';
export class StaffCorrectionError extends Error {
    constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
const fail = (code: string, message: string, status = 409): never => { throw new StaffCorrectionError(code, message, status); };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, max = 500000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const strict = (v: unknown, keys: string[]) => { if (!record(v) || Object.keys(v).some(k => !keys.includes(k)))
    return fail('INVALID_REQUEST', '입력 항목을 확인해 주세요.', 400); return v; };
export type TenderChange = {
    paymentId: number;
    before: 'CASH' | 'PAY_QR';
    after: 'CASH' | 'PAY_QR';
};
export type ReturnAllocation = {
    correctionId: string;
    method: 'CASH' | 'PAY_QR';
};
export type CorrectionChanges = {
    finalAmount: number;
    suitcaseQty?: number;
    backpackQty?: number;
    tenderChanges: TenderChange[];
    returnAllocations: ReturnAllocation[];
    returned: {
        amount: number;
        method: 'CASH' | 'PAY_QR' | 'UNKNOWN';
        businessDate: string;
        occurredAt: string | null;
        confirmedAlreadyReturned: true;
    } | null;
};
export type CorrectionActor = {
    staffId: string;
    actor: unknown;
    isManager: boolean;
    nameStatements?: D1PreparedStatement[];
};
export function parseCorrectionChanges(value: unknown): CorrectionChanges {
    const v = strict(value, ['finalAmount', 'suitcaseQty', 'backpackQty', 'tenderChanges', 'returnAllocations', 'returned']);
    if (!integer(v.finalAmount))
        fail('INVALID_REQUEST', '최종 청구금액을 정수 엔으로 입력해 주세요.', 400);
    const out: CorrectionChanges = { finalAmount: v.finalAmount as number, tenderChanges: [], returnAllocations: [], returned: null };
    for (const [key, label] of [['suitcaseQty', '캐리어'], ['backpackQty', '작은 가방']] as const)
        if (key in v) {
            if (!integer(v[key], 99))
                fail('INVALID_REQUEST', `${label} 수량을 확인해 주세요.`, 400);
            out[key] = v[key] as number;
        }
    if (v.tenderChanges !== undefined) {
        if (!Array.isArray(v.tenderChanges) || v.tenderChanges.length > 20)
            fail('INVALID_REQUEST', '수납수단 정정 목록을 확인해 주세요.', 400);
        for (const raw of v.tenderChanges as unknown[]) {
            const t = strict(raw, ['paymentId', 'before', 'after']);
            if (!integer(t.paymentId, Number.MAX_SAFE_INTEGER) || !t.paymentId || !['CASH', 'PAY_QR'].includes(String(t.before)) || !['CASH', 'PAY_QR'].includes(String(t.after)) || t.before === t.after)
                fail('INVALID_REQUEST', '수납수단 변경을 확인해 주세요.', 400);
            out.tenderChanges.push(t as TenderChange);
        }
    }
    if (new Set(out.tenderChanges.map(x => x.paymentId)).size !== out.tenderChanges.length)
        fail('INVALID_REQUEST', '같은 영수증을 중복 선택할 수 없습니다.', 400);
    if (v.returnAllocations !== undefined) {
        if (!Array.isArray(v.returnAllocations) || v.returnAllocations.length > 20)
            fail('INVALID_REQUEST', '반환수단 확인 목록을 확인해 주세요.', 400);
        for (const raw of v.returnAllocations as unknown[]) {
            const t = strict(raw, ['correctionId', 'method']);
            if (!uuid(t.correctionId) || !['CASH', 'PAY_QR'].includes(String(t.method)))
                fail('INVALID_REQUEST', '확인한 반환수단을 선택해 주세요.', 400);
            out.returnAllocations.push(t as ReturnAllocation);
        }
    }
    if (new Set(out.returnAllocations.map(x => x.correctionId)).size !== out.returnAllocations.length)
        fail('INVALID_REQUEST', '같은 반환을 중복 선택할 수 없습니다.', 400);
    if (v.returned !== undefined && v.returned !== null) {
        const r = strict(v.returned, ['amount', 'method', 'businessDate', 'occurredAt', 'confirmedAlreadyReturned']);
        if (!integer(r.amount) || r.amount === 0 || !['CASH', 'PAY_QR', 'UNKNOWN'].includes(String(r.method)) || r.confirmedAlreadyReturned !== true || typeof r.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.businessDate) || !Number.isFinite(Date.parse(r.businessDate)) || new Date(r.businessDate).toISOString().slice(0, 10) !== r.businessDate || !(r.occurredAt === null || typeof r.occurredAt === 'string' && Number.isFinite(Date.parse(r.occurredAt)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(r.occurredAt)))
            fail('INVALID_REQUEST', '이미 반환한 금액·업무일을 확인해 주세요. 정확한 시각·수단이 미상이면 미상으로 남겨 주세요.', 400);
        out.returned = r as CorrectionChanges['returned'];
    }
    return out;
}
export async function correctionHash(value: unknown) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))); return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join(''); }
const fields = 'order_id,status,parent_order_id,created_at,expected_pickup_at,expected_storage_days,suitcase_qty,backpack_qty,set_qty,price_per_day,prepaid_amount,final_amount,extra_amount,flying_pass_tier,flying_pass_discount_amount,staff_prepaid_override_amount,payment_method,updated_at';
type Order = {
    order_id: string;
    status: string;
    parent_order_id: string | null;
    created_at: string;
    expected_pickup_at: string;
    expected_storage_days: number;
    suitcase_qty: number;
    backpack_qty: number;
    set_qty: number;
    price_per_day: number;
    prepaid_amount: number;
    final_amount: number;
    extra_amount: number;
    flying_pass_tier: string;
    flying_pass_discount_amount: number;
    staff_prepaid_override_amount: number | null;
    payment_method: string;
    updated_at: string;
};
export async function correctionState(db: D1Database, orderId: string) {
    const order = await db.prepare(`SELECT ${fields} FROM luggage_orders WHERE order_id=?`).bind(orderId).first<Order>();
    if (!order)
        fail('NOT_FOUND', '주문을 찾을 수 없습니다.', 404);
    const [receipts, history, returns, billing, related, closings, scope] = await Promise.all([
        db.prepare('SELECT payment_id,order_id,business_date,tender_type,original_tender_type,amount,recorded_at,receipt_request_id FROM luggage_effective_payments WHERE order_id IN (SELECT order_id FROM luggage_orders WHERE order_id=? OR parent_order_id=?) ORDER BY payment_id').bind(orderId,orderId).all(),
        db.prepare('SELECT * FROM luggage_staff_corrections WHERE order_id=? ORDER BY sequence').bind(orderId).all(),
        db.prepare('SELECT * FROM luggage_correction_returns WHERE order_id=? ORDER BY recorded_at,correction_id').bind(orderId).all(),
        getBillingSummary(db, orderId),
        db.prepare('SELECT (SELECT COUNT(*) FROM luggage_orders WHERE parent_order_id=?) AS extensions,(SELECT COUNT(*) FROM luggage_bag_additions WHERE order_id=?) AS additions,(SELECT COUNT(*) FROM luggage_flying_pass_refunds WHERE order_id=?) AS refunds').bind(orderId, orderId, orderId).first<{
            extensions: number;
            additions: number;
            refunds: number;
        }>(),
        db.prepare("SELECT closing_id,business_date,closing_type,workflow_status,updated_at FROM luggage_cash_closings WHERE closing_type='FINAL_CLOSE' AND business_date>=(SELECT MIN(business_date) FROM luggage_order_payments WHERE order_id=?) AND business_date<=date('now','+9 hours') ORDER BY closing_id").bind(orderId).all(),
        db.prepare('SELECT snapshot_json FROM luggage_staff_correction_scopes WHERE root_id=?').bind(orderId).first<{snapshot_json:string}>()
    ]);
    const family=JSON.parse(scope?.snapshot_json??'{}') as {orders?:Order[]};
    const components={rootAmount:order!.final_amount+order!.extra_amount,bagAmount:billing?.bag_addition_amount??0,extensionAmount:(family.orders??[]).filter(o=>o.parent_order_id===orderId&&o.status!=='CANCELLED').reduce((sum,o)=>sum+(o.final_amount??o.prepaid_amount)+o.extra_amount,0),discountRefund:billing?.discount_credit_amount??0,correctionAdjustment:billing?.family_claim_adjustment??0,unbilledAmount:billing?.unbilled_amount??0};
    const state = {components, order: order!, receipts: receipts.results, history: history.results, returns: returns.results, billing: billing!, related: related!, closings: closings.results,scopeJson:scope?.snapshot_json??'{}' };
    return { ...state, fingerprint: await correctionHash(state) };
}
export async function previewStaffCorrection(db: D1Database, orderId: string, changes: CorrectionChanges, who: CorrectionActor, now = new Date()) {
    if (!/^\d{8}-\d{3,10}$/.test(orderId))
        fail('INVALID_REQUEST', '주문번호를 확인해 주세요.', 400);
    const s = await correctionState(db, orderId), o = s.order, b = s.billing;
    if (!['PAID', 'PICKED_UP'].includes(o.status) || o.parent_order_id)
        fail('STATUS_NOT_EDITABLE', '결제완료·수령완료 원주문에서 사용하세요. 결제대기는 기존 가격 수정 기능을 이용해 주세요.');
    if (!b || !s.receipts.length || b.legacy_paid_estimate || b.unbilled_days || b.pending_refund_count)
        fail('BILLING_REVIEW_REQUIRED', '원수납·연장·진행 중 환급을 먼저 확인해 주세요.');
    const today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), r = changes.returned;
    const affectedDays = new Set([today, ...s.receipts.map(x => String(x.business_date)), ...s.returns.filter(x => changes.returnAllocations.some(a => a.correctionId === x.correction_id)).map(x => String(x.business_date)), ...(r ? [r.businessDate] : [])]);
    const closed = s.closings.filter(x => affectedDays.has(String(x.business_date)));
    const suitcase = changes.suitcaseQty ?? o.suitcase_qty, backpack = changes.backpackQty ?? o.backpack_qty;
    if (suitcase + backpack < 1)
        fail('INVALID_REQUEST', '짐이 1개 이상이어야 합니다.', 400);
    const countChanged = suitcase !== o.suitcase_qty || backpack !== o.backpack_qty;
    const familyAmountOnly=Boolean(s.related.extensions||s.related.additions||s.related.refunds||(b.family_correction_count??0)>0);
    if(familyAmountOnly&&countChanged)fail('LINKED_QUANTITY_CHANGE','금액은 주문 전체 기준으로 정정할 수 있습니다. 연결된 추가짐·연장별 수량은 각 이력에서 구분해 확인해 주세요.');
    const p = countChanged ? calculatePricePerDay(suitcase, backpack) : { setQty: o.set_qty, pricePerDay: o.price_per_day };
    if (!familyAmountOnly && changes.finalAmount < o.extra_amount)
        fail('EXTRA_CLAIM_PROTECTED', '최종 청구액은 기존 추가 보관료보다 작을 수 없습니다. 추가 보관료 정정은 담당자 확인이 필요합니다.');
    const baseAmount = familyAmountOnly ? o.final_amount : changes.finalAmount - o.extra_amount;
    const auto = recalculateOrderPrepaid(p.pricePerDay, o.expected_storage_days, normalizeFlyingPassTier(o.flying_pass_tier));
    const override = auto.finalPrepaid === baseAmount && auto.flyingPassDiscountAmount === o.flying_pass_discount_amount ? null : baseAmount;
    const after = { ...o, suitcase_qty: suitcase, backpack_qty: backpack, set_qty: p.setQty, price_per_day: p.pricePerDay, final_amount: baseAmount, prepaid_amount: baseAmount, staff_prepaid_override_amount: familyAmountOnly?o.staff_prepaid_override_amount:override, familyAmountOnly, billing_total:changes.finalAmount };
    for (const t of changes.tenderChanges) {
        const receipt = s.receipts.find(x => x.payment_id === t.paymentId);
        if (!receipt || receipt.tender_type !== t.before)
            fail('STALE', '수납수단이 변경되었습니다. 새로고침해 주세요.');
    }
    for (const a of changes.returnAllocations)
        if (!s.returns.some(x => x.correction_id === a.correctionId && x.method === 'UNKNOWN'))
            fail('STALE', '이미 확인됐거나 다른 주문의 반환입니다.');
    const netBefore = b.net_received_amount, returned = r?.amount ?? 0;
    if (returned > Math.max(0, netBefore - changes.finalAmount))
        fail('RETURN_EXCEEDS_OVERPAYMENT', '이미 반환한 금액이 원수납과 최종 청구의 차액보다 큽니다.');
    if (r && (r.businessDate > today || r.businessDate < s.receipts.map(x => String(x.business_date)).sort()[0] || (r.occurredAt !== null && (Date.parse(r.occurredAt) > now.getTime() || new Date(Date.parse(r.occurredAt) + 9 * 3600000).toISOString().slice(0, 10) !== r.businessDate))))
        fail('INVALID_REQUEST', '반환 업무일과 실제 시각을 확인해 주세요.', 400);
    const tenders = s.receipts.filter(x=>x.order_id===orderId).map(x => changes.tenderChanges.find(t => t.paymentId === x.payment_id)?.after ?? x.tender_type);
    after.payment_method = tenders.every(x => x === 'CASH') ? 'CASH' : tenders.every(x => x === 'PAY_QR') ? 'PAY_QR' : 'MIXED';
    const target = changes.finalAmount, netAfter = netBefore - returned;
    if (o.status === 'PICKED_UP' && target > netAfter)
        fail('PICKED_UP_DEBT', '수령완료 주문에 미수납을 만들 수 없습니다. 담당자에게 이미 받은 금액을 확인해 주세요.');
    return { fingerprint: s.fingerprint, before: {...o,billing_total:b.total_effective_billed_amount}, after, scopeJson:s.scopeJson,familyDelta:familyAmountOnly?target-b.total_effective_billed_amount:0, billingBefore: b, netReceivedAfter: netAfter, finalBilledAfter: target, outstandingAfter: Math.max(0, target - netAfter), returnDueAfter: Math.max(0, netAfter - target), closedDays: closed.map(x => String(x.business_date)), receipts: s.receipts, sequence: s.history.length + 1, changes };
}
export async function applyStaffCorrection(db: D1Database, orderId: string, input: {
    correctionId: string;
    expectedFingerprint: string;
    reason: string;
    changes: CorrectionChanges;
}, who: CorrectionActor, now = new Date()) {
    if (!uuid(input.correctionId) || !/^[0-9a-f]{64}$/.test(input.expectedFingerprint) || !who.staffId.trim() || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200)
        fail('INVALID_REQUEST', '요청 ID·사유·직원을 확인해 주세요.', 400);
    const requestHash = await correctionHash({ orderId, input, staffId: who.staffId, actor: who.actor });
    const replay = async () => { const row = await db.prepare('SELECT order_id,request_hash FROM luggage_staff_corrections WHERE correction_id=?').bind(input.correctionId).first<{
        order_id: string;
        request_hash: string;
    }>(); if (!row)
        return null; if (row.order_id !== orderId || row.request_hash !== requestHash)
        fail('IDEMPOTENCY_CONFLICT', '다른 내용으로 이미 사용된 요청 ID입니다.'); return { correctionId: input.correctionId, replayed: true }; };
    const prior = await replay();
    if (prior)
        return prior;
    const q = await previewStaffCorrection(db, orderId, input.changes, who, now);
    if (q.fingerprint !== input.expectedFingerprint)
        fail('STALE', '다른 직원이 주문·수납·정산을 변경했습니다. 다시 확인해 주세요.');
    const recordedAt = now.toISOString(), beforeJson = JSON.stringify(q.before), oldTime = Date.parse(q.before.updated_at.includes('T') ? q.before.updated_at : q.before.updated_at.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(oldTime))
        fail('INVALID_REVISION', '주문 수정 시각을 확인해 주세요.');
    const after = { ...q.after, updated_at: new Date(Math.max(now.getTime(), oldTime + 2)).toISOString() }, afterJson = JSON.stringify(after), r = input.changes.returned;
    const originalReceipts = q.receipts.map(p => ({ ...p, tender_type: p.original_tender_type }));
    const detail = JSON.stringify({ requestHash, reason: input.reason.trim(), before: q.before, after, changes: input.changes, actor: who.actor, staffId: who.staffId, recordedAt });
    const statements = [db.prepare(`INSERT INTO luggage_audit_logs(order_id,staff_id,device_id,action,details,timestamp) VALUES(?,?,?,'STAFF_ORDER_CORRECTION',?,?)`).bind(orderId, who.staffId, input.correctionId, detail, recordedAt),
        db.prepare(`INSERT INTO luggage_staff_corrections(correction_id,order_id,family_delta,scope_json,before_billed_amount,after_billed_amount,sequence,request_hash,before_json,after_json,receipts_json,tender_changes_json,return_allocations_json,returned_amount,return_method,return_business_date,return_occurred_at,reason,staff_id,actor_json,is_manager,recorded_at,audit_id)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT log_id FROM luggage_audit_logs WHERE device_id=? AND action='STAFF_ORDER_CORRECTION'))`).bind(input.correctionId, orderId,q.familyDelta,q.scopeJson,q.billingBefore.total_effective_billed_amount,q.finalBilledAfter, q.sequence, requestHash, beforeJson, afterJson, JSON.stringify(originalReceipts), JSON.stringify(input.changes.tenderChanges), JSON.stringify(input.changes.returnAllocations), r?.amount ?? 0, r?.method ?? null, r?.businessDate ?? null, r?.occurredAt ?? null, input.reason.trim(), who.staffId, JSON.stringify(who.actor), who.isManager ? 1 : 0, recordedAt, input.correctionId),
        db.prepare(`SELECT json_extract('{}',CASE WHEN EXISTS(SELECT 1 FROM luggage_staff_corrections WHERE correction_id=? AND request_hash=?) AND EXISTS(SELECT 1 FROM luggage_billing_balances WHERE root_id=? AND recorded_amount=? AND net_received_amount=? AND total_effective_billed_amount=? AND outstanding_amount=? AND overpaid_amount=? AND root_review_required=0 AND invalid_amount=0) THEN '$' ELSE 'CORRECTION_POSTCONDITION_FAILED' END)`).bind(input.correctionId, requestHash, orderId, q.billingBefore.recorded_amount, q.netReceivedAfter, q.finalBilledAfter, q.outstandingAfter, q.returnDueAfter), ...(who.nameStatements ?? [])];
    try {
        await db.batch(statements);
    }
    catch (e) {
        const winner = await replay();
        if (winner)
            return winner;
        if (/CORRECTION_|UNIQUE|Preserve correction/.test(String(e instanceof Error ? e.cause ?? e : e)))
            fail('STALE', '주문·수납·정산 상태가 달라져 정정하지 않았습니다. 새로고침해 주세요.');
        throw e;
    }
    return { correctionId: input.correctionId, replayed: false };
}
