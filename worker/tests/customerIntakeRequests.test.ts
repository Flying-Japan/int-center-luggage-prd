import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { claimCustomerIntake, commitCustomerIntake, failCustomerIntakeBeforeCommit, intakeHash, fingerprintCustomerIntake } from '../src/services/customerIntakeRequests';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON; CREATE TABLE luggage_orders(order_id TEXT PRIMARY KEY, status TEXT, tag_no TEXT UNIQUE);');
  sql.exec(readFileSync('migrations/20261101_customer_intake_requests.sql', 'utf8'));
  sql.exec(readFileSync('migrations/20261101_customer_intake_hardening.sql', 'utf8'));
  function statement(text: string) {
    let values: any[] = [];
    return { bind(...args: any[]) { values = args; return this; },
      async first() { return sql.prepare(text).get(...values) || null; },
      async run() { const results = sql.prepare(text).all(...values); return { results, success: true, meta: { changes: Number(sql.prepare('SELECT changes() n').get()!.n) } }; } };
  }
  const db = { prepare: statement, async batch(statements: ReturnType<typeof statement>[]) {
    sql.exec('BEGIN IMMEDIATE');
    try { const result = []; for (const stmt of statements) result.push(await stmt.run()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  const insert = (id: string, tag = '7') => db.prepare("INSERT INTO luggage_orders VALUES(?,'PAYMENT_PENDING',?)").bind(id, tag);
  return { db, sql, insert };
}
const key = 'a'.repeat(43);

test('same concurrent browser key acquires once; altered payload conflicts', async () => {
  const { db, sql } = fixture(); const hash = await intakeHash('synthetic contact+photos');
  const results = await Promise.all([claimCustomerIntake(db, key, hash), claimCustomerIntake(db, key, hash)]);
  assert.equal(results.filter(r => r.kind === 'acquired').length, 1);
  assert.equal(results.filter(r => r.kind === 'busy').length, 1);
  assert.deepEqual(await claimCustomerIntake(db, key, await intakeHash('changed')), { kind: 'conflict' });
  assert.equal(sql.prepare('SELECT count(*) AS n FROM luggage_orders').get()!.n, 0);
});

test('order + replay link commit atomically; retry creates no extra order, tag or payment state', async () => {
  const { db, sql, insert } = fixture(); const hash = await intakeHash('same');
  const result = await claimCustomerIntake(db, key, hash); assert.equal(result.kind, 'acquired');
  if (result.kind !== 'acquired') return;
  assert.deepEqual(await commitCustomerIntake(db, result.claim, 'SYNTHETIC-1', insert('SYNTHETIC-1')), { orderId: 'SYNTHETIC-1', replayed: false });
  assert.deepEqual(await claimCustomerIntake(db, key, hash), { kind: 'replay', orderId: 'SYNTHETIC-1' });
  assert.deepEqual(await commitCustomerIntake(db, result.claim, 'SYNTHETIC-1', insert('NEVER')), { orderId: 'SYNTHETIC-1', replayed: true });
  assert.equal(sql.prepare('SELECT count(*) AS n FROM luggage_orders').get()!.n, 1);
  assert.equal(sql.prepare('SELECT status FROM luggage_orders').get()!.status, 'PAYMENT_PENDING');
});

test('zero-insert tag conflict atomically marks FAILED and leaves no phantom receipt', async () => {
  const { db, sql } = fixture();
  const result = await claimCustomerIntake(db, key, await intakeHash('same')); if (result.kind !== 'acquired') throw Error();
  await assert.rejects(commitCustomerIntake(db, result.claim, 'MISSING', db.prepare("INSERT INTO luggage_orders SELECT 'MISSING','PAYMENT_PENDING','7' WHERE 0")));
  assert.equal(sql.prepare('SELECT state FROM luggage_intake_requests').get()!.state, 'FAILED');
  assert.equal(sql.prepare('SELECT count(*) AS n FROM luggage_orders').get()!.n, 0);
});

test('proven failure permits new owner; stale owner can never write an order', async () => {
  const { db, sql, insert } = fixture(); const hash = await intakeHash('same');
  const first = await claimCustomerIntake(db, key, hash); if (first.kind !== 'acquired') throw Error();
  await failCustomerIntakeBeforeCommit(db, first.claim);
  const second = await claimCustomerIntake(db, key, hash); assert.equal(second.kind, 'acquired');
  await assert.rejects(commitCustomerIntake(db, first.claim, 'STALE', insert('STALE')), /CLAIM_LOST/);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM luggage_orders').get()!.n, 0);
});

test('unknown request outcome stays busy indefinitely; it is never re-stolen on timeout', async () => {
  const { db } = fixture(); const hash = await intakeHash('same');
  await claimCustomerIntake(db, key, hash);
  assert.deepEqual(await claimCustomerIntake(db, key, hash), { kind: 'busy' });
  await assert.rejects(claimCustomerIntake(db, 'guess', hash), /INVALID/);
});

test('fingerprint includes actual photo content and verified actor scope, independent of object key order', async () => {
  const input = { actorScope: 'anonymous', name: 'Sample', phone: '000-1234-5678', email: 'sample@example.invalid', lang: 'ko',
    suitcaseQty: 1, backpackQty: 0, companionCount: 1, pickupISO: '2026-11-01T08:00:00.000Z', paymentMethod: 'CASH',
    privacyVersion: 'v1', identityPhoto: new Blob(['ID-A'], { type: 'image/png' }), luggagePhoto: new Blob(['BAG-A'], { type: 'image/png' }) };
  const hash = await fingerprintCustomerIntake(input);
  assert.equal(hash, await fingerprintCustomerIntake({ ...input, name: ' Sample ' }));
  assert.notEqual(hash, await fingerprintCustomerIntake({ ...input, actorScope: 'verified-person-other' }));
  assert.notEqual(hash, await fingerprintCustomerIntake({ ...input, identityPhoto: new Blob(['ID-B'], { type: 'image/png' }) }));
  assert.notEqual(hash, await fingerprintCustomerIntake({ ...input, suitcaseQty: 2 }));
});

test('claim changed between preflight and transaction cannot leave an extra order', async () => {
  const { db, sql, insert } = fixture(); const hash = await intakeHash('same');
  const first = await claimCustomerIntake(db, key, hash); if (first.kind !== 'acquired') throw Error();
  const batch = db.batch.bind(db);
  db.batch = async statements => {
    await failCustomerIntakeBeforeCommit(db, first.claim);
    await claimCustomerIntake(db, key, hash);
    return batch(statements);
  };
  await assert.rejects(commitCustomerIntake(db, first.claim, 'STALE-RACE', insert('STALE-RACE')));
  assert.equal(sql.prepare('SELECT count(*) AS n FROM luggage_orders').get()!.n, 0);
});
test('a vanished ledger owner aborts the whole transaction before inserting an order', async () => {
  const { db, sql, insert } = fixture();
  const first = await claimCustomerIntake(db, key, await intakeHash('same')); if (first.kind !== 'acquired') throw Error();
  const batch = db.batch.bind(db);
  db.batch = async statements => { sql.prepare('DELETE FROM luggage_intake_requests').run(); return batch(statements); };
  await assert.rejects(commitCustomerIntake(db, first.claim, 'NEVER', insert('NEVER')));
  assert.equal(sql.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 0);
});
test('only proven pre-commit failures allow edited payload; late old payload conflicts', async () => {
  const { db, sql, insert } = fixture(); const oldHash = await intakeHash('old'), newHash = await intakeHash('new');
  const first = await claimCustomerIntake(db, key, oldHash); if (first.kind !== 'acquired') throw Error();
  await failCustomerIntakeBeforeCommit(db, first.claim);
  const edited = await claimCustomerIntake(db, key, newHash); if (edited.kind !== 'acquired') throw Error();
  assert.deepEqual(await claimCustomerIntake(db, key, oldHash), { kind: 'conflict' });
  await commitCustomerIntake(db, edited.claim, 'EDITED', insert('EDITED'));
  assert.equal(sql.prepare('SELECT count(*) n FROM luggage_orders').get()!.n, 1);
});
