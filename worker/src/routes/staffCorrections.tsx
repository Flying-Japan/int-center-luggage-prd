import { Hono, type Context } from 'hono';
import type { AppType } from '../types';
import { staffAuth, editorAuth, getStaff } from '../middleware/auth';
import { normalizeUnifiedWriteActor, resolveInternalActorStaff, partTimeActorNameStatements } from '../lib/internalActorStaff';
import { StaffCorrectionError, parseCorrectionChanges, correctionState, previewStaffCorrection, applyStaffCorrection, type CorrectionActor } from '../services/staffCorrections';
import { collectBagAddition, BagAdditionError } from '../services/bagAdditions';
import { BillingConflict } from '../services/luggageBilling';
import { StaffTopbar } from '../lib/components';
const internal = new Hono<AppType>(), staff = new Hono<AppType>();
const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (): never => { throw new StaffCorrectionError('INVALID_REQUEST', '입력 내용을 확인해 주세요.', 400); };
function orderId(c: Context<AppType>) { const id = c.req.param('id'); if (!id || !/^\d{8}-\d{3,10}$/.test(id))
    bad(); return id!; }
function enabled(c: Context<AppType>) { if (c.env.LUGGAGE_STAFF_CORRECTIONS_ENABLED !== 'true')
    throw new StaffCorrectionError('CORRECTIONS_DISABLED', '직원 정정 기능이 비활성화되어 있습니다.', 503); }
function body(value: unknown, keys: string[]) { if (!rec(value) || Object.keys(value).some(k => !keys.includes(k)))
    return bad(); return value; }
function error(c: Context<AppType>, e: unknown) { if (e instanceof StaffCorrectionError || e instanceof BagAdditionError)
    return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404 | 409 | 503); if (e instanceof BillingConflict)
    return c.json({ error: e.message, code: 'COLLECTION_CONFLICT' }, 409); throw e; }
async function actor(c: Context<AppType>, raw: unknown): Promise<CorrectionActor> {
    let a;
    try {
        a = normalizeUnifiedWriteActor(raw);
    }
    catch {
        throw new StaffCorrectionError('PERMISSION', '수정 권한이 있는 직원 세션이 필요합니다.', 403);
    }
    const mapped = await resolveInternalActorStaff(c.env, a, 'order.pricing');
    if (!mapped.ok)
        throw new StaffCorrectionError('PERMISSION', mapped.error, mapped.status);
    return { staffId: mapped.staff.id, actor: a, isManager: a.role === 'manager' || a.role === 'super_admin', nameStatements: [...partTimeActorNameStatements(c.env, mapped.staff),...(mapped.staff.role==='part_time'?[c.env.DB.prepare("SELECT json_extract('{}',CASE WHEN EXISTS(SELECT 1 FROM luggage_part_time_actors WHERE actor_id=? AND display_name=?) THEN '$' ELSE 'CORRECTION_ACTOR_NAME_FAILED' END)").bind(mapped.staff.id,mapped.staff.displayName)]:[])] };
}
internal.get('/internal/luggage-orders/:id/corrections', async (c) => { c.header('Cache-Control', 'no-store'); try {
    return c.json({ enabled: c.env.LUGGAGE_STAFF_CORRECTIONS_ENABLED === 'true', partTimeActorsEnabled: c.env.LUGGAGE_PART_TIME_ACTORS_ENABLED === 'true', ...await correctionState(c.env.DB, orderId(c)) });
}
catch (e) {
    return error(c, e);
} });
internal.post('/internal/luggage-orders/:id/corrections/preview', async (c) => { c.header('Cache-Control', 'no-store'); try {
    enabled(c);
    const v = body(await c.req.json().catch(() => null), ['actor', 'changes']);
    const who = await actor(c, v.actor);
    return c.json({ quote: await previewStaffCorrection(c.env.DB, orderId(c), parseCorrectionChanges(v.changes), who) });
}
catch (e) {
    return error(c, e);
} });
internal.post('/internal/luggage-orders/:id/corrections', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
        const v = body(await c.req.json().catch(() => null), ['actor', 'correctionId', 'expectedFingerprint', 'reason', 'changes']);
        const who = await actor(c, v.actor);
        if (c.env.LUGGAGE_STAFF_CORRECTIONS_ENABLED !== 'true' && !await c.env.DB.prepare('SELECT 1 FROM luggage_staff_corrections WHERE correction_id=? AND order_id=?').bind(String(v.correctionId), orderId(c)).first())
            enabled(c);
        if (typeof v.correctionId !== 'string' || typeof v.expectedFingerprint !== 'string' || typeof v.reason !== 'string')
            bad();
        return c.json(await applyStaffCorrection(c.env.DB, orderId(c), { correctionId: v.correctionId as string, expectedFingerprint: v.expectedFingerprint as string, reason: v.reason as string, changes: parseCorrectionChanges(v.changes) }, who));
    }
    catch (e) {
        return error(c, e);
    }
});
internal.post('/internal/luggage-orders/:id/corrections/collect', async (c) => { c.header('Cache-Control', 'no-store'); try {
    enabled(c);
    const v = body(await c.req.json().catch(() => null), ['actor', 'requestId', 'expectedAmount', 'cashAmount', 'qrAmount', 'confirmReceived']);
    const who = await actor(c, v.actor);
    if (typeof v.requestId !== 'string' || v.confirmReceived !== true || ![v.expectedAmount, v.cashAmount, v.qrAmount].every(x => typeof x === 'number' && Number.isSafeInteger(x)))
        bad();
    return c.json(await collectBagAddition(c.env.DB, orderId(c), who, { requestId: v.requestId as string, expectedAmount: v.expectedAmount as number, cashAmount: v.cashAmount as number, qrAmount: v.qrAmount as number, confirmReceived: true }, true));
}
catch (e) {
    return error(c, e);
} });
for (const path of ['/staff/orders/:id/corrections', '/staff/orders/:id/corrections/*']) {
    staff.use(path, staffAuth, editorAuth);
    staff.post(path, async (c, next) => { if (c.req.header('Origin') !== new URL(c.req.url).origin)
        return c.json({ error: '허용되지 않은 요청 출처입니다.' }, 403); await next(); });
}
async function page(c: Context<AppType>, message?: string) { const id = orderId(c), s = await correctionState(c.env.DB, id), user = getStaff(c); return c.html(<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="/static/styles.css"/><title>금액·수량 정정</title></head><body><StaffTopbar staff={user}/><main class="container"><section class="card"><h1>금액·수량 정정 · {id}</h1><a href={`/staff/orders/${id}`}>주문 상세</a>{message && <p role="alert">{message}</p>}<p>원수납 ¥{s.billing.recorded_amount.toLocaleString()} · 일반 반환 ¥{(s.billing.general_returned_amount ?? 0).toLocaleString()} · 할인환급 ¥{s.billing.cash_refunded_amount.toLocaleString()} · 순수납 ¥{s.billing.net_received_amount.toLocaleString()} · 청구 ¥{s.billing.total_effective_billed_amount.toLocaleString()}</p><p>이미 반환한 사실만 기록합니다. 이 기능은 돈을 지급하지 않습니다. 추가수납은 기존 실제 수납 확인 기능을 이용하세요.</p>{c.env.LUGGAGE_STAFF_CORRECTIONS_ENABLED === 'true' && !s.order.parent_order_id ? <form method="post" action={`/staff/orders/${id}/corrections`}><input type="hidden" name="correctionId" value={crypto.randomUUID()}/><input type="hidden" name="expectedFingerprint" value={s.fingerprint}/><label class="field">최종 청구금액(엔)<input class="control" name="finalAmount" type="number" min="0" max="500000" required value={s.billing.total_effective_billed_amount}/></label><p>주문 전체 금액에는 원주문·추가짐·연장·할인환급이 포함됩니다. 연결 주문은 금액만 정정합니다.</p><label class="field">캐리어<input class="control" name="suitcaseQty" disabled={Boolean(s.related.extensions||s.related.additions||s.related.refunds)} type="number" min="0" max="99" required value={s.order.suitcase_qty}/></label><label class="field">작은 가방<input class="control" name="backpackQty" disabled={Boolean(s.related.extensions||s.related.additions||s.related.refunds)} type="number" min="0" max="99" required value={s.order.backpack_qty}/></label><label class="field">사유<input class="control" name="reason" maxLength={200} required/></label><details><summary>원수납 결제수단 오류 정정</summary>{s.receipts.map(p=><label class="field">영수증 {String(p.payment_id)} · 원금 ¥{Number(p.amount).toLocaleString()} · 원수단 {String(p.original_tender_type)}<select name={`tender_${String(p.payment_id)}`}><option value="CASH" selected={p.tender_type==='CASH'}>현금</option><option value="PAY_QR" selected={p.tender_type==='PAY_QR'}>QR</option></select></label>)}</details>
{ s.returns.filter(r=>r.method==='UNKNOWN').map(r=><label class="field">{String(r.business_date)} 반환 ¥{Number(r.amount).toLocaleString()}의 수단 확인<select name={`allocate_${String(r.correction_id)}`}><option value="">미상 유지</option><option value="CASH">현금 확인</option><option value="PAY_QR">QR 확인</option></select></label>)}
<fieldset><legend>이미 반환한 금액 기록(선택)</legend><label>금액<input name="returnedAmount" type="number" min="0" max="500000" value="0"/></label><label>수단<select name="returnMethod"><option value="UNKNOWN">미상</option><option value="CASH">현금</option><option value="PAY_QR">QR</option></select></label><label>반환 업무일<input name="returnBusinessDate" type="date"/></label><label><input name="alreadyReturned" type="checkbox" value="yes"/> 이미 반환했습니다</label><p>정확한 시각을 모르면 입력하지 않아도 됩니다.</p></fieldset><button type="submit">정정 내역 저장</button></form> : <p>새 정정은 개방 전입니다.</p>}</section><section class="card"><h2>원수납 영수증</h2>{s.receipts.map(p => <p>영수증 {String(p.payment_id)} · ¥{Number(p.amount).toLocaleString()} · 원수단 {String(p.original_tender_type)} / 현재 {String(p.tender_type)}</p>)}<h2>정정 이력</h2>{s.history.map(x => <details><summary>{String(x.recorded_at)} · {String(x.reason)}</summary><p>작업자 {String(x.staff_id)}</p><pre>{String(x.before_json)}</pre><pre>{String(x.after_json)}</pre><p>이미 반환 ¥{Number(x.returned_amount).toLocaleString()} · {String(x.return_method ?? '없음')} · 실제시각 {String(x.return_occurred_at ?? '미상')}</p></details>)}</section></main></body></html>); }
staff.get('/staff/orders/:id/corrections', async (c) => { try {
    return await page(c);
}
catch (e) {
    return error(c, e);
} });
staff.post('/staff/orders/:id/corrections', async (c) => {
    try {
        enabled(c);
        const v = await c.req.parseBody(), id = orderId(c), user = getStaff(c), who: CorrectionActor = { staffId: user.id, actor: { source: 'legacy_session', userId: user.id, name: user.display_name ?? user.username ?? user.id, role: user.role }, isManager: user.role === 'admin' };
        const num = (x: unknown) => typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN;
        const amount = num(v.returnedAmount);
        if(!Number.isSafeInteger(amount)||amount<0)bad();
        const current = await correctionState(c.env.DB,id);
        const tenderChanges=current.receipts.filter(p=>v[`tender_${String(p.payment_id)}`]&&v[`tender_${String(p.payment_id)}`]!==p.tender_type).map(p=>({paymentId:p.payment_id,before:p.tender_type,after:v[`tender_${String(p.payment_id)}`]}));
        const returnAllocations=current.returns.filter(r=>v[`allocate_${String(r.correction_id)}`]).map(r=>({correctionId:r.correction_id,method:v[`allocate_${String(r.correction_id)}`]}));
        const changes = parseCorrectionChanges({ finalAmount: num(v.finalAmount), tenderChanges, returnAllocations, ...(v.suitcaseQty!==undefined?{suitcaseQty:num(v.suitcaseQty)}:{}),...(v.backpackQty!==undefined?{backpackQty:num(v.backpackQty)}:{}), returned: amount > 0 ? { amount, method: v.returnMethod, businessDate: v.returnBusinessDate, occurredAt: null, confirmedAlreadyReturned: v.alreadyReturned === 'yes' } : null });
        const result = await applyStaffCorrection(c.env.DB, id, { correctionId: String(v.correctionId ?? ''), expectedFingerprint: String(v.expectedFingerprint ?? ''), reason: String(v.reason ?? ''), changes }, who);
        return await page(c, result.replayed ? '같은 저장 내역을 확인했습니다.' : '정정 내역을 저장했습니다.');
    }
    catch (e) {
        if (e instanceof StaffCorrectionError)
            return await page(c, e.message);
        throw e;
    }
});
export { internal as staffCorrectionInternalRoutes, staff as staffCorrectionStaffRoutes };
