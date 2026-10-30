import { Hono, type Context } from 'hono';
import type { AppType } from '../types';
import { staffAuth, editorAuth, getStaff } from '../middleware/auth';
import { normalizeUnifiedWriteActor, resolveInternalActorStaff, partTimeActorNameStatements } from '../lib/internalActorStaff';
import { BagAdditionError, previewBagAddition, registerBagAddition, collectBagAddition, type BagCounts, type BagAdditionInput } from '../services/bagAdditions';
import { BillingConflict, getBillingSummary } from '../services/luggageBilling';
import { StaffTopbar } from '../lib/components';
const internal = new Hono<AppType>(), staffRoutes = new Hono<AppType>();
function bad(message: string): never { throw new BagAdditionError('INVALID_REQUEST', message, 400); }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function body(v: unknown, keys: string[]) {
    if (!record(v) || Object.keys(v).some(k => !keys.includes(k)))
        bad('허용되지 않은 요청 항목입니다');
    return v;
}
function integer(v: unknown, max = 500000) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max)
        bad('올바른 정수 금액·수량을 입력해주세요');
    return v;
}
function bagCounts(v: Record<string, unknown>): BagCounts { return { suitcaseAdded: integer(v.suitcaseAdded, 99), backpackAdded: integer(v.backpackAdded, 99), ...((v.coverageStartDate !== undefined || v.coverageEndDate !== undefined) ? { coverageStartDate: date(v.coverageStartDate), coverageEndDate: date(v.coverageEndDate) } : {}) }; }
function date(v: unknown) {
    if (typeof v !== 'string')
        bad('보관 시작·종료일을 입력해주세요');
    return v;
}
function payment(v: unknown) {
    if (v === undefined)
        return undefined;
    const p = body(v, ['confirmReceived', 'cashAmount', 'qrAmount']);
    if (p.confirmReceived !== true)
        bad('실제 수납 확인이 필요합니다');
    return { confirmReceived: true as const, cashAmount: integer(p.cashAmount), qrAmount: integer(p.qrAmount) };
}
function id(c: Context<AppType>) {
    const value = c.req.param('id');
    if (!value || !/^\d{8}-\d{3,10}$/.test(value))
        bad('원주문 식별자가 필요합니다');
    return value;
}
function enabled(c: Context<AppType>) {
    if (c.env.LUGGAGE_BAG_ADDITIONS_ENABLED !== 'true')
        throw new BagAdditionError('BAG_ADDITIONS_DISABLED', '추가 짐 등록 기능이 비활성화되어 있습니다', 503);
}
function error(c: Context<AppType>, e: unknown) {
    if (e instanceof BagAdditionError)
        return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404 | 409 | 503);
    throw e;
}
async function actor(c: Context<AppType>, value: unknown, operation: "order.bagAddition" | "order.bagCollection" = "order.bagAddition") {
    let who;
    try {
        who = normalizeUnifiedWriteActor(value);
    }
    catch {
        throw new BagAdditionError('PERMISSION', '주문 수정 권한이 있는 직원 정보가 필요합니다', 403);
    }
    const mapped = await resolveInternalActorStaff(c.env, who, operation);
    if (!mapped.ok)
        throw new BagAdditionError('PERMISSION', mapped.error, mapped.status);
    return { staffId: mapped.staff.id, actor: who, nameStatements: [...partTimeActorNameStatements(c.env, mapped.staff), ...(mapped.staff.role === 'part_time' ? [c.env.DB.prepare("SELECT json_extract('{}',CASE WHEN EXISTS(SELECT 1 FROM luggage_part_time_actors WHERE actor_id=? AND display_name=?) THEN '$' ELSE 'BAG_ACTOR_NAME_ATOMICITY_FAILED' END)").bind(mapped.staff.id, mapped.staff.displayName)] : [])] };
}
async function history(c: Context<AppType>, orderId: string) { return (await c.env.DB.prepare('SELECT addition_id,suitcase_added,backpack_added,set_added,batch_price_per_day,coverage_start_date,coverage_end_date,storage_days,discount_rate,base_amount,discounted_amount,flying_pass_tier,flying_pass_discount_amount,policy_version,amount,business_date,created_at,reason FROM luggage_bag_additions WHERE order_id=? ORDER BY created_at,addition_id').bind(orderId).all()).results; }
// Mounted under the existing internalAuth HMAC boundary in internalApi.
internal.get('/internal/luggage-orders/:id/bag-additions', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
        const orderId = id(c);
        return c.json({ partTimeActorsEnabled: c.env.LUGGAGE_PART_TIME_ACTORS_ENABLED === 'true', registrationEnabled: c.env.LUGGAGE_BAG_ADDITIONS_ENABLED === 'true', additions: await history(c, orderId), billing: await getBillingSummary(c.env.DB, orderId) });
    }
    catch (e) {
        return error(c, e);
    }
});
internal.post('/internal/luggage-orders/:id/bag-additions/preview', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
        enabled(c);
        const v = body(await c.req.json().catch(() => null), ['actor', 'suitcaseAdded', 'backpackAdded', 'coverageStartDate', 'coverageEndDate']);
        await actor(c, v.actor);
        return c.json({ quote: await previewBagAddition(c.env.DB, id(c), bagCounts(v)) });
    }
    catch (e) {
        return error(c, e);
    }
});
internal.post('/internal/luggage-orders/:id/bag-additions', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
        const v = body(await c.req.json().catch(() => null), ['actor', 'suitcaseAdded', 'backpackAdded', 'additionId', 'expectedFingerprint', 'reason', 'payment', 'coverageStartDate', 'coverageEndDate']);
        const who = await actor(c, v.actor);
        if (typeof v.additionId !== 'string' || typeof v.expectedFingerprint !== 'string' || typeof v.reason !== 'string')
            bad('요청 식별자·사유가 필요합니다');
        if (c.env.LUGGAGE_BAG_ADDITIONS_ENABLED !== 'true' && !await c.env.DB.prepare('SELECT 1 FROM luggage_bag_additions WHERE addition_id=? AND order_id=?').bind(v.additionId, id(c)).first())
            enabled(c);
        const result = await registerBagAddition(c.env.DB, id(c), { ...bagCounts(v), additionId: v.additionId, expectedFingerprint: v.expectedFingerprint, reason: v.reason, payment: payment(v.payment) }, who);
        return c.json(result, result.replayed ? 200 : 201);
    }
    catch (e) {
        return error(c, e);
    }
});
// Recovery of already registered additions remains available while new registrations are OFF.
internal.post('/internal/luggage-orders/:id/bag-additions/collect', async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
        const v = body(await c.req.json().catch(() => null), ['actor', 'requestId', 'expectedAmount', 'confirmReceived', 'cashAmount', 'qrAmount']);
        const who = await actor(c, v.actor, "order.bagCollection"), orderId = id(c);
        if (v.confirmReceived !== true || typeof v.requestId !== 'string')
            bad('실제 수납 확인과 요청 식별자가 필요합니다');
        const result = await collectBagAddition(c.env.DB, orderId, who, { requestId: v.requestId, confirmReceived: true, expectedAmount: integer(v.expectedAmount), cashAmount: integer(v.cashAmount), qrAmount: integer(v.qrAmount) });
        return c.json(result);
    }
    catch (e) {
        if (e instanceof BillingConflict)
            return c.json({ error: e.message, code: 'COLLECTION_CONFLICT' }, 409);
        return error(c, e);
    }
});
for (const path of ['/staff/orders/:id/bag-additions', '/staff/orders/:id/bag-additions/*']) {
    staffRoutes.use(path, staffAuth, editorAuth);
    staffRoutes.post(path, async (c, next) => {
        if (c.req.header('Origin') !== new URL(c.req.url).origin)
            return c.json({ error: '다른 사이트의 요청은 허용되지 않습니다' }, 403);
        await next();
    });
}
type Quote = Awaited<ReturnType<typeof previewBagAddition>>;
async function page(c: Context<AppType>, quote?: Quote, message?: string) {
    const orderId = id(c), staff = getStaff(c), billing = await getBillingSummary(c.env.DB, orderId);
    if (!billing)
        return c.html(<p>주문을 찾을 수 없습니다</p>, 404);
    const additions = await history(c, orderId);
    const current = await c.env.DB.prepare('SELECT status,parent_order_id,expected_pickup_at FROM luggage_orders WHERE order_id=?').bind(orderId).first<{
        status: string;
        parent_order_id: string | null;
        expected_pickup_at: string | null;
    }>();
    return c.html(<html lang="ko"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><link rel="stylesheet" href="/static/styles.css"/><title>추가 짐·수납</title></head><body class="staff-site"><StaffTopbar staff={staff}/><main class="container"><section class="card"><h2>추가 짐·수납 · {orderId}</h2><p><a href={`/staff/orders/${orderId}`}>주문 상세로 돌아가기</a></p>{message && <p role="alert" style="color:#b91c1c">{message}</p>}<div class="summary-grid"><p><strong>전체 청구</strong><span>¥{billing.total_billed_amount.toLocaleString()}</span></p><p><strong>실제 수납</strong><span>¥{billing.recorded_amount.toLocaleString()}</span></p><p><strong>이미 지급한 할인 환급</strong><span>¥{billing.cash_refunded_amount.toLocaleString()}</span></p><p><strong>추가 미수납</strong><span>¥{billing.outstanding_amount.toLocaleString()}</span></p></div><p>기존 청구와 수납 원장은 보존됩니다. 기존 짐의 기간·할인은 그대로 두고, 추가한 짐은 추가일~기존 수령 예정일의 자체 기간으로 계산합니다. 각 추가 배치 안에서 세트·장기 할인을 계산하고 Flying Pass 정액 할인은 중복 적용하지 않습니다.</p>
    {quote ? <form action={`/staff/orders/${orderId}/bag-additions`} method="post"><h3>추가 요금 확인</h3><p>캐리어 {quote.before.suitcaseQty} → {quote.after.suitcaseQty}, 백팩 {quote.before.backpackQty} → {quote.after.backpackQty}</p><p>보관 기간: {quote.coverageStartDate}~{quote.coverageEndDate} ({quote.batch.storageDays}일) · 추가 청구 <strong>¥{quote.amount.toLocaleString()}</strong></p><p>추가 짐 일요금 ¥{quote.batch.pricePerDay.toLocaleString()} × {quote.batch.storageDays}일, 장기 할인 {Math.round(quote.batch.discountRate * 100)}% (−¥{quote.batch.longStayDiscountAmount.toLocaleString()}), 등급 할인 −¥{quote.batch.flyingPassDiscountAmount.toLocaleString()}</p><p>청구 합계 ¥{quote.billedBefore.toLocaleString()} → ¥{quote.billedAfter.toLocaleString()}</p><input type="hidden" name="coverageStartDate" value={quote.coverageStartDate}/><input type="hidden" name="coverageEndDate" value={quote.coverageEndDate}/><input type="hidden" name="additionId" value={crypto.randomUUID()}/><input type="hidden" name="expectedFingerprint" value={quote.fingerprint}/><input type="hidden" name="suitcaseAdded" value={quote.after.suitcaseQty - quote.before.suitcaseQty}/><input type="hidden" name="backpackAdded" value={quote.after.backpackQty - quote.before.backpackQty}/><label class="field"><span>추가 사유</span><input class="control" name="reason" maxLength={200} required/></label><fieldset><legend>추가금 수납</legend><label><input type="checkbox" name="received" value="yes"/> 추가금을 현장에서 실제로 받았습니다</label><label class="field"><span>받은 현금(엔)</span><input class="control" name="cashAmount" type="number" min="0" max="500000" step="1" value="0"/></label><label class="field"><span>받은 PayPay/QR(엔)</span><input class="control" name="qrAmount" type="number" min="0" max="500000" step="1" value="0"/></label><p>아직 받지 않았다면 체크하지 않고 두 금액을 0으로 두세요. 추가 청구만 등록되며 미수납이 남으면 수령할 수 없습니다.</p></fieldset><button class="btn btn-primary" type="submit">추가 짐 등록</button></form> : c.env.LUGGAGE_BAG_ADDITIONS_ENABLED === 'true' && current?.status === 'PAID' && !current.parent_order_id ? <form action={`/staff/orders/${orderId}/bag-additions/preview`} method="post"><label class="field"><span>추가 캐리어</span><input class="control" name="suitcaseAdded" type="number" min="0" max="99" step="1" value="0" required/></label><label class="field"><span>추가 백팩</span><input class="control" name="backpackAdded" type="number" min="0" max="99" step="1" value="0" required/></label><label class="field"><span>추가 짐 보관 시작일</span><input class="control" type="date" name="coverageStartDate" value={new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)} required/></label><label class="field"><span>추가 짐 보관 종료일</span><input class="control" type="date" name="coverageEndDate" value={current?.expected_pickup_at ? new Date(new Date(current.expected_pickup_at.includes("T") ? current.expected_pickup_at : current.expected_pickup_at.replace(" ", "T") + "Z").getTime() + 9 * 3600000).toISOString().slice(0, 10) : ""} readOnly required/></label><p>보관 기간과 기존 수량·세트 할인을 확인한 뒤 견적을 표시합니다.</p><button class="btn btn-primary" type="submit">추가 요금 미리보기</button></form> : <p>새 추가 짐은 기능이 켜져 있고 결제 완료·미수령인 원주문에서 등록할 수 있습니다. 이미 등록한 미수납은 주문 상세에서 실제 수납 확인 후 처리하세요.</p>}
    </section><section class="card"><h3>추가 짐 이력</h3><div class="table-wrap"><table><thead><tr><th>일자</th><th>보관 기간</th><th>할인</th><th>추가 캐리어</th><th>추가 백팩</th><th>추가 청구</th><th>사유</th></tr></thead><tbody>{additions.map(a => <tr><td>{String(a.business_date)}</td><td>{String(a.coverage_start_date)}~{String(a.coverage_end_date)} ({Number(a.storage_days)}일)</td><td>{Math.round(Number(a.discount_rate) * 100)}%</td><td>{Number(a.suitcase_added)}</td><td>{Number(a.backpack_added)}</td><td>¥{Number(a.amount).toLocaleString()}</td><td>{String(a.reason)}</td></tr>)}</tbody></table></div></section></main></body></html>);
}
const formInt = (v: unknown) => {
    if (typeof v !== 'string' || !/^\d+$/.test(v))
        bad('올바른 정수를 입력해주세요');
    return Number(v);
};
staffRoutes.get('/staff/orders/:id/bag-additions', async (c) => page(c));
staffRoutes.post('/staff/orders/:id/bag-additions/preview', async (c) => {
    try {
        enabled(c);
        const v = await c.req.parseBody();
        const quote = await previewBagAddition(c.env.DB, id(c), { suitcaseAdded: formInt(v.suitcaseAdded), backpackAdded: formInt(v.backpackAdded), coverageStartDate: String(v.coverageStartDate ?? ''), coverageEndDate: String(v.coverageEndDate ?? '') });
        return page(c, quote);
    }
    catch (e) {
        if (e instanceof BagAdditionError)
            return page(c, undefined, e.message);
        throw e;
    }
});
staffRoutes.post('/staff/orders/:id/bag-additions', async (c) => {
    try {
        enabled(c);
        const v = await c.req.parseBody();
        const cashAmount = formInt(v.cashAmount ?? '0'), qrAmount = formInt(v.qrAmount ?? '0');
        if (v.received !== 'yes' && (cashAmount || qrAmount))
            bad('실제 수납 확인 체크가 필요합니다');
        const input: BagAdditionInput = { additionId: String(v.additionId ?? ''), expectedFingerprint: String(v.expectedFingerprint ?? ''), suitcaseAdded: formInt(v.suitcaseAdded), backpackAdded: formInt(v.backpackAdded), reason: String(v.reason ?? ''), coverageStartDate: String(v.coverageStartDate ?? ''), coverageEndDate: String(v.coverageEndDate ?? ''), ...(v.received === 'yes' ? { payment: { confirmReceived: true, cashAmount, qrAmount } } : {}) };
        await registerBagAddition(c.env.DB, id(c), input, { staffId: getStaff(c).id });
        return c.redirect(`/staff/orders/${id(c)}/bag-additions`);
    }
    catch (e) {
        if (e instanceof BagAdditionError)
            return page(c, undefined, e.message);
        throw e;
    }
});
export { internal as bagAdditionInternalRoutes, staffRoutes as bagAdditionStaffRoutes };
