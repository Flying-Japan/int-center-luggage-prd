import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customerFixture, syntheticDraft } from './helpers/customerFixture';
import { toRenewalIntakeForm, confirmAnonymousDraft } from '../src/customer/intakeDraft';
import { syntheticPng } from './helpers/syntheticPhoto';

const origin = 'https://luggage.test';
function submit(c: ReturnType<typeof customerFixture>, draft = syntheticDraft(), headers: Record<string, string> = {}) {
  return c.app.request(`${origin}/customer/submit`, { method: 'POST', headers: { origin, ...headers },
    body: toRenewalIntakeForm(draft, 'existing-storage-notice-v1') }, c.env,
    { waitUntil() { throw Error('NO_OUTBOUND_SIDE_EFFECT'); }, passThroughOnException() {}, props: {} });
}
async function signedCookie(secret: string, overrides: Record<string, string> = {}) {
  const data = { timestamp: new Date().toISOString(), person_id: 'SYNTHETIC-CANONICAL-PERSON',
    email: 'member@example.invalid', provider: 'google', display_name: 'Synthetic Member', phone: '', locale: 'en', ...overrides };
  const canonical = [data.timestamp, data.person_id, data.email, data.provider, data.display_name, data.phone, data.locale].join('\n');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))).toString('base64url');
  return `fj_account_context=${Buffer.from(JSON.stringify({ ...data, signature })).toString('base64url')}`;
}

test('v8 luggage page has six real steps, quick transition, separate existing-booking branch and no sample identity', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close());
  const response = await c.app.request(`${origin}/customer/renewal?lang=en`, {}, c.env);
  assert.equal(response.status, 200); const html = await response.text();
  assert.equal((html.match(/data-step=/g) || []).length, 6);
  assert.match(html, /rd-origin-kakao/); assert.match(html, /data-quick/); assert.match(html, /data-existing-booking/);
  assert.match(html, /<html lang="en"/); assert.doesNotMatch(html, /DRAFT-LUG|SAMPLE_CONTACT|PASS|href=".*trip/i);
  const auth = await c.app.request(`${origin}/customer/renewal/auth?provider=google`, {}, c.env);
  assert.equal(auth.status, 503); assert.equal((await auth.json()).error, 'ACCOUNT_LOGIN_NOT_READY');
});
test('renewal endpoints and submit fail closed in production before explicit enablement; legacy form remains available', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); c.env.APP_ENV = 'production';
  for (const path of ['/customer/renewal', '/customer/renewal/assets/app.js', '/customer/renewal/account'])
    assert.equal((await c.app.request(`${origin}${path}`, {}, c.env)).status, 404);
  assert.equal((await submit(c)).status, 404);
  assert.equal((await c.app.request(`${origin}/customer`, {}, c.env)).status, 200);
  assert.equal(c.objects.size, 0);
});
test('actual renewed submit saves once, replays same receipt and rejects changed photos without extra order/tag/payment', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); const draft = syntheticDraft();
  const response = await submit(c, draft); assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.replayed, false); assert.match(saved.receiptUrl, /^\/customer\/renewal\/receipt\//);
  const firstRow = c.sqlite.prepare('SELECT * FROM luggage_orders').get()!;
  const replay = await submit(c, draft); assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...saved, replayed: true });
  draft.photos.luggage!.blob = new Blob([syntheticPng('CHANGED')], { type: 'image/png' });
  const changed = await submit(c, draft); assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'INTAKE_REQUEST_CHANGED');
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_order_payments').get()!.n, 0);
  assert.equal(c.objects.size, 2); assert.equal(firstRow.status, 'PAYMENT_PENDING'); assert.equal(firstRow.account_person_id, null);
  const receipt = await c.app.request(`${origin}${saved.receiptUrl}`, {}, c.env); assert.equal(receipt.status, 200);
  const text = await receipt.text(); assert.match(text, /Synthetic Renewal/); assert.match(text, /physical luggage handover require staff confirmation/);
  assert.doesNotMatch(text, /have been sent|in storage|Payment complete/);
  const receiptNow=Date.now(); t.mock.method(Date,'now',()=>receiptNow+360000);
  const expired = await c.app.request(`${origin}${saved.receiptUrl}`, {}, c.env); assert.equal(expired.status, 403);
  assert.doesNotMatch(await expired.text(), /Synthetic Renewal/);
});
test('same-key concurrent actual submissions cannot create two orders or upload twice', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); const draft = syntheticDraft();
  const results = await Promise.all([submit(c, draft), submit(c, draft)]);
  assert.ok(results.some(r => r.status === 200));
  assert.ok(results.every(r => [200, 409].includes(r.status)));
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1); assert.equal(c.objects.size, 2);
});
test('signed canonical Account identity links the real order; submitted person id is ignored and contact is not erased', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); c.env.ACCOUNT_CONTEXT_SECRET = 'synthetic-local-secret-not-a-real-key';
  const cookie = await signedCookie(c.env.ACCOUNT_CONTEXT_SECRET);
  const account = await c.app.request(`${origin}/customer/renewal/account`, { headers: { cookie } }, c.env);
  const data = await account.json(); assert.equal(data.authenticated, true); assert.equal(data.loginReady, false);
  assert.deepEqual(data.profile, { name: 'Synthetic Member', phone: '', email: 'member@example.invalid' });
  assert.match(data.subject,/^[\w-]{43}$/); assert.ok(data.expiresAt>Date.now());
  const draft = confirmAnonymousDraft(syntheticDraft(), data.subject, 'google', true); const form = toRenewalIntakeForm(draft, 'existing-storage-notice-v1');
  form.set('account_person_id', 'FORGED-PERSON'); form.set('flying_pass_tier', 'GOLD');
  const response = await c.app.request(`${origin}/customer/submit`, { method: 'POST', headers: { origin, cookie }, body: form }, c.env);
  assert.equal(response.status, 200); const row = c.sqlite.prepare('SELECT * FROM luggage_orders').get()!;
  assert.equal(row.account_person_id, 'SYNTHETIC-CANONICAL-PERSON'); assert.equal(row.phone, draft.contact.phone);
  assert.equal(row.name, draft.contact.name); assert.equal(row.flying_pass_discount_amount, 0);
});
test('invalid/stale Account context and cross-origin submit fail before storing photos or claiming requests', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); c.env.ACCOUNT_CONTEXT_SECRET = 'synthetic';
  const stale = await signedCookie('synthetic', { timestamp: new Date(Date.now() - 3600000).toISOString() });
  assert.equal((await submit(c, syntheticDraft(), { cookie: stale })).status, 401);
  assert.equal((await submit(c, syntheticDraft(), { cookie: 'fj_account_context=forged' })).status, 401);
  assert.equal((await submit(c, syntheticDraft(), { origin: 'https://outside.example.invalid' })).status, 403);
  assert.equal(c.objects.size, 0); assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_intake_requests').get()!.n, 0);
});
test('invalid renewal quantities and forged payment choice are rejected without legacy coercion', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close());
  for (const [field, value] of [['suitcase_qty', '1.9'], ['backpack_qty', '-1'], ['companion_count', '100'], ['payment_method', 'PAID']]) {
    const form = toRenewalIntakeForm(syntheticDraft(), 'existing-storage-notice-v1'); form.set(field, value);
    const response = await c.app.request(`${origin}/customer/submit`, { method: 'POST', headers: { origin }, body: form }, c.env);
    assert.equal(response.status, 400);
  }
  assert.equal(c.objects.size, 0);
});
test('lost response after the actual D1 commit replays without deleting the committed photos or creating a duplicate', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); const draft = syntheticDraft();
  const batch = c.env.DB.batch.bind(c.env.DB);
  c.env.DB.batch = async (statements: unknown[]) => { await batch(statements); throw Error('SYNTHETIC_LOST_COMMIT_RESPONSE'); };
  const uncertain = await submit(c, draft); assert.equal(uncertain.status, 503);
  assert.equal((await uncertain.json()).error, 'INTAKE_COMMIT_UNCERTAIN');
  assert.equal(c.objects.size, 2); assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1);
  c.env.DB.batch = batch;
  const replay = await submit(c, draft); assert.equal(replay.status, 200); assert.equal((await replay.json()).replayed, true);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1); assert.equal(c.objects.size, 2);
});
test('proven photo upload failure can be edited and retried with the same durable browser key', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); const draft = syntheticDraft();
  const put = c.env.IMAGES.put.bind(c.env.IMAGES); let uploads = 0;
  c.env.IMAGES.put = async (...args: unknown[]) => { if (++uploads === 2) throw Error('SYNTHETIC_PHOTO_FAILURE'); return put(...args); };
  assert.equal((await submit(c, draft)).status, 400); assert.equal(c.objects.size, 0);
  assert.equal(c.sqlite.prepare('SELECT state FROM luggage_intake_requests').get()!.state, 'FAILED');
  c.env.IMAGES.put = put; draft.photos.luggage!.blob = new Blob([syntheticPng('REPLACED-PHOTO')], { type: 'image/png' });
  assert.equal((await submit(c, draft)).status, 200);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1); assert.equal(c.objects.size, 2);
});
test('release switch changes only the luggage customer entry and retains the original server legal notice', async t => {
  const c = customerFixture(); t.after(() => c.sqlite.close()); c.env.CUSTOMER_RENEWAL_ENABLED = '1';
  const entry = await c.app.request(`${origin}/customer?lang=ja`, {}, c.env);
  assert.equal(entry.status, 302); assert.equal(entry.headers.get('location'), '/customer/renewal?lang=ja');
  const notice = await c.app.request(`${origin}/customer?notice=1&lang=ja`, {}, c.env);
  assert.equal(notice.status, 200); assert.match(await notice.text(), /id="consent-notice"/);
});
