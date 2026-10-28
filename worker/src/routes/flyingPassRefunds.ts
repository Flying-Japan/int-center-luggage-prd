import { Hono, type Context } from 'hono';
import type { AppType } from '../types';
import { normalizeUnifiedWriteActor, resolveInternalActorStaff } from '../lib/internalActorStaff';
import { FLYING_PASS_TIERS, type FlyingPassTier } from '../services/pricing';
import { FlyingPassRefundError, REFUND_UUID, previewFlyingPassRefund, registerFlyingPassRefund, getFlyingPassRefund, finishFlyingPassRefund } from '../services/flyingPassRefunds';

const prefix = '/internal/luggage-orders/:orderId/flying-pass-refunds';
const orderIdPattern = /^\d{8}-\d{3,10}$/;
function bodyRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalid(message: string): never { throw new FlyingPassRefundError('INVALID_REQUEST', message, 400); }
function reason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 200) invalid('1~200자의 사유가 필요합니다');
  return value.trim();
}
function targetTier(value: unknown): FlyingPassTier {
  if (typeof value !== 'string' || value === 'NONE' || !FLYING_PASS_TIERS.includes(value as FlyingPassTier)) invalid('환급 대상 Flying Pass 등급이 올바르지 않습니다');
  return value as FlyingPassTier;
}

/** Parent must install internalAuth. The production mount has NO activation path before phase 3, even with the flag on.
 * Local D1 tests explicitly construct a test-only router; enabling real payouts requires the later settlement work.
 */
export function createFlyingPassRefundRoutes(localTestOnly = false) {
  const routes = new Hono<AppType>();
  const handle = (operation: 'preview' | 'register' | 'lookup' | 'confirm' | 'cancel') => async (c: Context<AppType>) => {
    c.header('Cache-Control', 'no-store');
    if (!localTestOnly || c.env.APP_ENV !== 'test') {
      return c.json({ error: '3단계 UI 및 운영 검증 완료 전에는 환급 기능을 사용할 수 없습니다', code: 'REFUND_SETTLEMENT_NOT_READY' }, 503);
    }
    if (['preview','register'].includes(operation) && c.env.LUGGAGE_FLYING_PASS_REFUNDS_ENABLED !== 'true') {
      return c.json({ error: '환급 기능이 비활성화되어 있습니다', code: 'REFUNDS_DISABLED' }, 503);
    }
    try {
      const orderId = c.req.param('orderId');
      if (!orderId || !orderIdPattern.test(orderId)) invalid('PAID 원주문 식별자가 필요합니다');
      const body: unknown = await c.req.json().catch(() => null);
      if (!bodyRecord(body)) invalid('올바른 JSON 요청이 필요합니다');
      const keys = { preview: ['targetTier'], register: ['refundId','targetTier','reason','expectedFingerprint'], lookup: [], confirm: ['cashPaid','expectedAmount'], cancel: ['confirmNotPaid','reason'] }[operation];
      if (Object.keys(body).some(key => !['actor', ...keys].includes(key))) invalid('허용되지 않은 요청 항목입니다');
      let actor;
      try { actor = normalizeUnifiedWriteActor(body.actor); }
      catch { throw new FlyingPassRefundError('PERMISSION', '환급 작업 권한이 있는 직원 정보가 필요합니다', 403); }
      const resolved = await resolveInternalActorStaff(c.env, actor);
      if (!resolved.ok) return c.json({ error: resolved.error, code: 'PERMISSION' }, resolved.status);
      const who = { actor, staff: resolved.staff };
      if (operation === 'preview') return c.json({ quote: await previewFlyingPassRefund(c.env.DB, orderId, targetTier(body.targetTier)) });
      if (operation === 'register') {
        if (typeof body.refundId !== 'string' || !REFUND_UUID.test(body.refundId)) invalid('유효한 환급 UUID가 필요합니다');
        if (typeof body.expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedFingerprint)) invalid('미리보기 검증값이 필요합니다');
        const result = await registerFlyingPassRefund(c.env.DB, orderId, { refundId: body.refundId, targetTier: targetTier(body.targetTier), reason: reason(body.reason), expectedFingerprint: body.expectedFingerprint }, who);
        return c.json(result, result.replayed ? 200 : 201);
      }
      const refundId = c.req.param('refundId');
      if (!refundId || !REFUND_UUID.test(refundId)) invalid('유효한 환급 UUID가 필요합니다');
      if (operation === 'lookup') return c.json({ refund: await getFlyingPassRefund(c.env.DB, orderId, refundId), instruction: '기록을 조회한 것만으로 현금을 다시 지급하지 마세요. 진행 중이면 담당 직원의 실제 지급 여부를 먼저 확인하세요' });
      if (operation === 'confirm') {
        if (body.cashPaid !== true || typeof body.expectedAmount !== 'number' || !Number.isSafeInteger(body.expectedAmount) || body.expectedAmount < 1 || body.expectedAmount > 500000) invalid('실제 현금 지급 완료 확인과 정확한 지급액이 필요합니다');
        return c.json(await finishFlyingPassRefund(c.env.DB, orderId, refundId, { action: 'confirm', cashPaid: true, expectedAmount: body.expectedAmount }, who));
      }
      if (body.confirmNotPaid !== true) invalid('현금을 지급하지 않았다는 명시적 확인이 필요합니다');
      return c.json(await finishFlyingPassRefund(c.env.DB, orderId, refundId, { action: 'cancel', confirmNotPaid: true, reason: reason(body.reason) }, who));
    } catch (error) {
      if (error instanceof FlyingPassRefundError) return c.json({ error: error.message, code: error.code }, error.status);
      console.error('Flying Pass refund failed', error);
      return c.json({ error: '환급 결과를 확인할 수 없습니다. 같은 환급 ID로 조회하고 현금을 다시 지급하지 마세요', code: 'SOURCE_ERROR' }, 500);
    }
  };
  routes.post(`${prefix}/preview`, handle('preview'));
  routes.post(`${prefix}/register`, handle('register'));
  routes.post(`${prefix}/:refundId/lookup`, handle('lookup'));
  routes.post(`${prefix}/:refundId/confirm`, handle('confirm'));
  routes.post(`${prefix}/:refundId/cancel`, handle('cancel'));
  return routes;
}
export default createFlyingPassRefundRoutes();
