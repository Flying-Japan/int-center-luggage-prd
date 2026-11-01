import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import customer from '../src/routes/customer';
import { createIntakeDraft, toLegacyIntakeForm } from '../src/customer/intakeDraft';
import { syntheticPng } from './helpers/syntheticPhoto';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('src/schema.sql', 'utf8'));
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return { bind(...values: unknown[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
      async run() { const results = sqlite.prepare(sql).all(...args as never[]);
        return { results, meta: { changes: sqlite.prepare('SELECT changes() n').get()!.n } }; },
    };
  };
  const objects = new Map<string, ArrayBuffer>();
  const env = { DB: { prepare: statement }, APP_ENV: 'test',
    IMAGES: { async put(key: string, body: ArrayBuffer) { objects.set(key, body); },
      async delete(key: string) { objects.delete(key); } } };
  return { sqlite, objects, env, app: new Hono().route('/', customer) };
}

test('renewal guest multipart uses the actual legacy save and private receipt route with no auth, messages, payments or points', async t => {
  const c = fixture(); t.after(() => c.sqlite.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN_IN_LOCAL_CONTRACT_TEST'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const draft = createIntakeDraft('en', 'existing-privacy');
  draft.contact = { name: 'Synthetic Guest', phone: '000-1234-5678', email: 'synthetic@example.invalid' };
  const tomorrowJst = new Date(Date.now() + (24 + 9) * 3600000).toISOString().slice(0, 10);
  draft.visit = { suitcaseQty: '2', backpackQty: '1', pickupDate: tomorrowJst, pickupTime: '17:00',
    paymentMethod: 'PAY_QR', companionCount: '2' };
  draft.photos = { identity: { blob: new Blob([syntheticPng('SYNTHETIC-ID')], { type: 'image/png' }), name: 'id.png', lastModified: 1 },
    luggage: { blob: new Blob([syntheticPng('SYNTHETIC-BAGS')], { type: 'image/png' }), name: 'bags.png', lastModified: 2 } };
  draft.privacy.accepted = true;
  let backgrounds = 0;
  const response = await c.app.request('https://luggage.test/customer/submit',
    { method: 'POST', body: toLegacyIntakeForm(draft, 'existing-privacy') }, c.env,
    { waitUntil() { backgrounds++; throw Error('NO_BACKGROUND_SIDE_EFFECT'); }, passThroughOnException() {}, props: {} });
  assert.equal(response.status, 302);
  const location = response.headers.get('location'); assert.ok(location);
  const row = c.sqlite.prepare('SELECT * FROM luggage_orders').get()!;
  assert.equal(row.name, 'Synthetic Guest');
  assert.equal(row.status, 'PAYMENT_PENDING');
  assert.equal(row.actual_pickup_at, null);
  assert.equal(row.in_warehouse, 0);
  assert.equal(row.suitcase_qty, 2); assert.equal(row.backpack_qty, 1);
  assert.ok(Number(row.final_amount) > 0);
  assert.ok(Number(row.tag_no) >= 141 && Number(row.tag_no) <= 150);
  assert.equal(c.objects.size, 2);
  assert.deepEqual([...c.objects.values()].map(b => Buffer.from(b).toString('base64')).sort(), [syntheticPng('SYNTHETIC-ID'),syntheticPng('SYNTHETIC-BAGS')].map(b=>Buffer.from(b).toString('base64')).sort());
  assert.equal(c.sqlite.prepare('SELECT count(*) AS n FROM luggage_order_payments').get()!.n, 0);
  assert.equal(backgrounds, 0);
  assert.match(location, new RegExp(`/customer/orders/${row.order_id}\\?lang=en&token=`));
  const receipt = await c.app.request(`https://luggage.test${location}`, {}, c.env);
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /Synthetic Guest/);
  const denied = await c.app.request(`https://luggage.test/customer/orders/${row.order_id}?lang=en`, {}, c.env);
  assert.doesNotMatch(await denied.text(), /Synthetic Guest/);
  const wrongToken = await c.app.request(`https://luggage.test/customer/orders/${row.order_id}?token=wrong&lang=en`, {}, c.env);
  assert.doesNotMatch(await wrongToken.text(), /Synthetic Guest/);
});
