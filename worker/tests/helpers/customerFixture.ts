import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import customer from '../../src/routes/customer';
import { createIntakeDraft } from '../../src/customer/intakeDraft';
import { syntheticPng } from './syntheticPhoto';

/** In-memory synthetic bindings only. No Wrangler, remote DB or email key. */
export function customerFixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('src/schema.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/20261101_customer_intake_requests.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/20261101_customer_account_link.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/20261101_customer_intake_hardening.sql', 'utf8'));
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return { bind(...values: unknown[]) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args as never[]) }; },
      async run() {
        const results = sqlite.prepare(sql).all(...args as never[]);
        return { results, success: true, meta: { changes: sqlite.prepare('SELECT changes() n').get()!.n } };
      } };
  };
  const objects = new Map<string, { body: ArrayBuffer; contentType: string }>();
  const env: any = { DB: { prepare: statement, async batch(statements: ReturnType<typeof statement>[]) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const results = []; for (const item of statements) results.push(await item.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } }, APP_ENV: 'test', IMAGES: {
    async put(key: string, body: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { body, contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream' });
    },
    async get(key: string) { const value = objects.get(key); if (!value) return null;
      return { body: new Blob([value.body]).stream(), httpMetadata: { contentType: value.contentType } };
    }, async delete(key: string) { objects.delete(key); },
  } };
  return { sqlite, objects, env, app: new Hono().route('/', customer) };
}
export function syntheticDraft() {
  const draft = createIntakeDraft('en', 'existing-storage-notice-v1');
  draft.contact = { name: 'Synthetic Renewal', phone: '000-1234-5678', email: 'synthetic@example.invalid' };
  draft.visit = { suitcaseQty: '1', backpackQty: '1', pickupDate: new Date(Date.now() + 33 * 3600000).toISOString().slice(0, 10),
    pickupTime: '17:00', paymentMethod: 'CASH', companionCount: '1' };
  draft.photos = { identity: { blob: new Blob([syntheticPng('SYNTHETIC-ID')], { type: 'image/png' }), name: 'id.png', lastModified: 1 },
    luggage: { blob: new Blob([syntheticPng('SYNTHETIC-BAGS')], { type: 'image/png' }), name: 'bags.png', lastModified: 2 } };
  draft.privacy.accepted = true; return draft;
}
