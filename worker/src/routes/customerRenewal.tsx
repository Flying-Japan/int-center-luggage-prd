import { Hono } from 'hono';
import type { AppType } from '../types';
import { normalizeLang } from '../lib/i18n';
import { RenewalPage } from '../customer/renewalPage';
import { readIntakeIdentity, intakeSubject, renewalEnabled, type RenewalEnv } from '../customer/accountContext';
import { RENEWAL_SCRIPT, RENEWAL_CSS, RENEWAL_LOGO } from '../customer/renewalAssets.generated';
const routes = new Hono<AppType>();
const gate: import('hono').MiddlewareHandler<AppType> = async (c, next) => {
  if (!renewalEnabled(c.env)) return c.notFound();
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'same-origin');
  await next();
};
routes.use('/customer/renewal', gate);
routes.use('/customer/renewal/*', gate);
routes.get('/customer/renewal', c => c.html(<RenewalPage locale={normalizeLang(c.req.query('lang'))} />));
routes.get('/customer/renewal/receipt/:id', async c => {
  const locale = normalizeLang(c.req.query('lang'));
  const text = (ko: string, en: string, ja: string) => ({ ko, en, ja })[locale];
  const order = await c.env.DB.prepare(`SELECT o.order_id,o.name,o.suitcase_qty,o.backpack_qty,o.expected_pickup_at,
    o.final_amount,o.status,o.view_token,r.receipt_issued_at FROM luggage_orders o
    JOIN luggage_intake_requests r ON r.order_id=o.order_id AND r.state='COMMITTED' WHERE o.order_id=?`).bind(c.req.param('id'))
    .first<{ order_id: string; name: string; suitcase_qty: number; backpack_qty: number; expected_pickup_at: string;
      final_amount: number; status: string; view_token: string; receipt_issued_at: number | null }>();
  const token = c.req.query('token');
  const timestamp = order?.receipt_issued_at ?? NaN;
  const valid = !!order && !!token && token === order.view_token && Number.isFinite(timestamp) && Date.now() >= timestamp && Date.now() - timestamp < 300000;
  return c.html(<html lang={locale}><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" /><title>{text('접수 확인', 'Reception receipt', '受付確認')}</title>
    <link rel="stylesheet" href="/customer/renewal/assets/app.css" /></head><body style="margin:0"><div class="rd-root">
      <header class="fj-customer-header"><img width="160" src="/customer/renewal/assets/logo.svg" alt="FLYING JAPAN" /></header>
      <main class="rd-main rd-stack"><section class="rd-card rd-stack">
        <h1>{valid ? text('접수를 저장했어요', 'Reception saved', '受付を保存しました') : text('확인 링크를 사용할 수 없습니다', 'Receipt link unavailable', '確認リンクは利用できません')}</h1>
        {valid ? <><p>{text('이 화면을 직원에게 보여주세요. 결제와 실제 짐 인도는 직원 확인이 필요합니다.', 'Show this screen to staff. Payment and physical luggage handover require staff confirmation.', 'この画面をスタッフに見せてください。支払と実際の手荷物引渡しはスタッフ確認が必要です。')}</p>
          <dl class="rd-summary"><dt>{text('접수번호', 'Reception number', '受付番号')}</dt><dd>{order!.order_id}</dd>
            <dt>{text('이름', 'Name', 'お名前')}</dt><dd>{order!.name}</dd><dt>{text('짐', 'Luggage', '手荷物')}</dt><dd>{order!.suitcase_qty} / {order!.backpack_qty}</dd>
            <dt>{text('수령 예정', 'Planned pickup', '受取予定')}</dt><dd>{new Date(order!.expected_pickup_at).toLocaleString(locale, { timeZone: 'Asia/Tokyo' })} JST</dd>
            <dt>{text('접수 시 요금', 'Recorded price', '受付時料金')}</dt><dd>¥{order!.final_amount.toLocaleString()}</dd>
            <dt>{text('주문 상태', 'Order status', '注文状態')}</dt><dd>{order!.status}</dd></dl></>
          : <p>{text('링크가 만료되었거나 올바르지 않습니다. 새로 접수하지 말고 직원에게 기존 접수 여부를 확인해주세요.', 'The link is expired or invalid. Ask staff to check your existing reception before submitting again.', 'リンクが期限切れ、または無効です。再受付の前にスタッフへ既存の受付をご確認ください。')}</p>}
      </section></main></div></body></html>, valid ? 200 : 403);
});
routes.get('/customer/renewal/assets/app.js', c => { c.header('Content-Type', 'text/javascript; charset=utf-8'); return c.body(RENEWAL_SCRIPT); });
routes.get('/customer/renewal/assets/app.css', c => { c.header('Content-Type', 'text/css; charset=utf-8'); return c.body(RENEWAL_CSS); });
routes.get('/customer/renewal/assets/logo.svg', c => { c.header('Content-Type', 'image/svg+xml'); return c.body(RENEWAL_LOGO); });
routes.get('/customer/renewal/assets/PretendardJPVariable.woff2', async c => {
  const object = await c.env.IMAGES.get('static/customer-renewal/PretendardJPVariable.woff2');
  if (!object) return c.notFound();
  c.header('Content-Type', 'font/woff2'); return c.body(object.body);
});
routes.get('/customer/renewal/account', async c => {
  const env: RenewalEnv = c.env;
  const identity = await readIntakeIdentity(c.req.raw.headers, env.ACCOUNT_CONTEXT_SECRET);
  if (identity.kind === 'invalid') return c.json({ authenticated: false, error: 'ACCOUNT_CONTEXT_INVALID' }, 401);
  return c.json({ authenticated: identity.kind === 'verified',
    subject: identity.kind === 'verified' ? await intakeSubject(identity.customer.personId, env.ACCOUNT_CONTEXT_SECRET!) : null,
    expiresAt: identity.kind === 'verified' ? identity.customer.expiresAt : null,
    profile: identity.kind === 'verified' ? { name: identity.customer.name, phone: identity.customer.phone, email: identity.customer.email } : null,
    // This flag is enabled only after the real Account round trip is verified.
    loginReady: env.ACCOUNT_LUGGAGE_LOGIN_READY === '1' && !!env.ACCOUNT_CONTEXT_SECRET });
});
routes.get('/customer/renewal/auth', c => {
  const env: RenewalEnv = c.env;
  if (env.ACCOUNT_LUGGAGE_LOGIN_READY !== '1' || !env.ACCOUNT_CONTEXT_SECRET) {
    return c.json({ error: 'ACCOUNT_LOGIN_NOT_READY' }, 503);
  }
  const provider = c.req.query('provider');
  if (provider !== 'kakao' && provider !== 'google') return c.json({ error: 'INVALID_PROVIDER' }, 400);
  // Fixed Account destination; no caller-supplied redirect origin or PII.
  const destination = new URL('https://account.flyingjp.com/login');
  destination.searchParams.set('provider', provider);
  destination.searchParams.set('next', '/luggage/handoff');
  return c.json({ redirectTo: destination.toString() });
});
export default routes;
