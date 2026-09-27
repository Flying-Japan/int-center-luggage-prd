import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import inventory from "../src/routes/experienceInventory";
import internalApi from "../src/routes/internalApi";
import ops from "../src/routes/operations";
import { signInternalRequest } from "../src/lib/hmac";
import { parseExperienceRentals, validateOccupancyRange } from "../src/services/experienceRentals";

const parentSchema = `CREATE TABLE luggage_experience_visits (
  visit_id INTEGER PRIMARY KEY AUTOINCREMENT, visitor_name TEXT NOT NULL, visitor_type TEXT DEFAULT 'BLOGGER',
  scheduled_date TEXT NOT NULL, benefit_type TEXT, benefit_amount TEXT, status TEXT DEFAULT 'SCHEDULED',
  received_by TEXT, received_at TEXT, processed_by_staff_id TEXT, note TEXT, created_by_staff_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
  scheduled_time TEXT, benefit_label TEXT, external_id TEXT, pii_masked_at TEXT
);`;
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(parentSchema);
  sqlite.exec(readFileSync('src/schema.sql', 'utf8'));
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async run() { return sqlite.prepare(sql).run(...args); },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
  const app = new Hono().route('/', inventory).route('/', internalApi).route('/', ops);
  const env = { DB: db, CENTER_INVENTORY_API_SECRET: 'center-test-key', INTERNAL_API_SECRET: 'reviewer-test-key', DEV_STAFF_AUTH_BYPASS: '1', APP_ENV: 'test' };
  return { app, env, sqlite };
}
const row = { rental_group: '에어랩', rental_quantity: '2', rental_start: '2026-09-27', rental_end: '2026-09-29' };
function form(rows = [row]) {
  const body = new URLSearchParams({ visitor_name: 'Synthetic fixture', scheduled_date: '2026-09-27', benefit_amount: 'free text preserved', note: 'private note' });
  for (const item of rows) for (const [key, value] of Object.entries(item)) body.append(key, value);
  return body;
}
async function signed(app, env, params = 'start=2026-09-27&end=2026-09-29', options: { secret?: string; timestamp?: string; signature?: string } = {}) {
  const url = `https://luggage.test/internal/experience-rental-occupancy?${params}`;
  const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: options.secret || env.CENTER_INVENTORY_API_SECRET, method: 'GET', url, timestamp });
  return app.request(url, { headers: { 'x-internal-timestamp': timestamp, 'x-internal-signature': options.signature || signature } }, env);
}

test('strict validation and multiple input rows', () => {
  assert.equal(parseExperienceRentals({}).length, 0);
  assert.equal(parseExperienceRentals(row)[0].quantity, 2);
  assert.equal(parseExperienceRentals(Object.fromEntries(Object.entries(row).map(([k,v]) => [k,[v,v]]))).length, 2);
  for (const quantity of ['0','-1','1.2','NaN','1e3','9007199254740992','']) assert.throws(() => parseExperienceRentals({ ...row, rental_quantity: quantity }));
  for (const date of ['2026-2-01','2026-02-30','2025-02-29','0000-01-01','invalid','2026-13-01']) assert.throws(() => parseExperienceRentals({ ...row, rental_start: date }));
  assert.throws(() => parseExperienceRentals({ ...row, rental_end: '2026-09-26' }));
  assert.throws(() => parseExperienceRentals({ ...row, rental_group: 'unsupported' }));
  assert.throws(() => parseExperienceRentals({ ...row, rental_group: ['에어랩','밴드'] }));
  assert.equal(validateOccupancyRange('2026-01-01','2026-04-03'), true);
  assert.equal(validateOccupancyRange('2026-01-01','2026-04-04'), false);
});

test('create, edit, clear and delete rentals atomically without parsing benefit text', async () => {
  const { app, env, sqlite } = setup();
  let res = await app.request('/staff/handover/experience', { method:'POST', body: form([row, { ...row, rental_group:'밴드', rental_quantity:'3' }]) }, env);
  assert.equal(res.status, 302);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_rentals WHERE visit_id = 1').get().n, 2);
  assert.equal(sqlite.prepare('SELECT benefit_amount FROM luggage_experience_visits').get().benefit_amount, 'free text preserved');
  const edit = await app.request('/staff/handover/experience/1/edit', {}, env);
  const html = await edit.text();
  assert.match(html, /렌탈 재고 반영/); assert.match(html, /value="밴드" selected/); assert.match(html, /value="2026-09-29"/);
  res = await app.request('/staff/handover/experience/1/update', { method:'POST', body: form([{ ...row, rental_quantity:'5' }]) }, env);
  assert.equal(res.status,302);
  assert.equal(sqlite.prepare('SELECT SUM(quantity) AS n FROM luggage_experience_rentals').get().n,5);
  res = await app.request('/staff/handover/experience/1/update', { method:'POST', body: form([{ ...row, rental_quantity:'0' }]) }, env);
  assert.equal(res.status,400);
  assert.equal(sqlite.prepare('SELECT SUM(quantity) AS n FROM luggage_experience_rentals').get().n,5);
  await app.request('/staff/handover/experience/1/cancel', { method:'POST' }, env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_rentals').get().n,1);
  await app.request('/staff/handover/experience/1/update', { method:'POST', body: form([]) }, env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_rentals').get().n,0);
  await app.request('/staff/handover/experience/1/update', { method:'POST', body: form() }, env);
  await app.request('/staff/handover/experience/1/delete', { method:'POST' }, env);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_rentals').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_visits').get().n,0);
  res = await app.request('/staff/handover/experience', { method:'POST', body: form([{...row,rental_end:'2026-01-01'}]) }, env);
  assert.equal(res.status,400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_visits').get().n,0);
  // A DB failure after parent insertion rolls the parent back too.
  sqlite.exec("CREATE TRIGGER fail_rental BEFORE INSERT ON luggage_experience_rentals BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  res = await app.request('/staff/handover/experience', { method:'POST', body: form() }, env);
  assert.equal(res.status,500);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM luggage_experience_visits').get().n,0);
});

test('D1 constraints reject invalid groups, quantities, dates and orphaned parents', () => {
  const { sqlite } = setup();
  sqlite.exec("INSERT INTO luggage_experience_visits (visitor_name,scheduled_date,created_by_staff_id) VALUES ('fixture','2026-09-27','fixture')");
  const insert = sqlite.prepare('INSERT INTO luggage_experience_rentals (visit_id,product_group,quantity,start_date,end_date) VALUES (?,?,?,?,?)');
  for (const values of [[1,'unknown',1,'2026-09-27','2026-09-29'],[1,'밴드',0,'2026-09-27','2026-09-29'],[1,'밴드',1.2,'2026-09-27','2026-09-29'],[1,'밴드',1,'2026-02-30','2026-09-29'],[1,'밴드',1,'2026-09-27','2026-09-26'],[1,'밴드',1,'2026-09-27','2026-13-01'],[999,'밴드',1,'2026-09-27','2026-09-29']]) assert.throws(() => insert.run(...values));
});

test('occupancy aggregates inclusive dates, clips range, includes active statuses and excludes cancellation and PII', async () => {
  const { app, env, sqlite } = setup();
  for (const status of ['SCHEDULED','VISITED','RECEIVED','CANCELLED']) {
    await app.request('/staff/handover/experience', { method:'POST', body: form([row, row, {...row,rental_group:'밴드',rental_quantity:'1'}]) }, env);
    sqlite.prepare('UPDATE luggage_experience_visits SET status=? WHERE visit_id=(SELECT MAX(visit_id) FROM luggage_experience_visits)').run(status);
  }
  const res = await signed(app,env);
  assert.equal(res.status,200); assert.equal(res.headers.get('Cache-Control'),'no-store');
  const data = await res.json();
  assert.equal(data.items.length,6);
  for (const day of ['2026-09-27','2026-09-28','2026-09-29']) {
    assert.equal(data.items.find(i=>i.date===day && i.group==='에어랩').quantity,12);
    assert.equal(data.items.find(i=>i.date===day && i.group==='밴드').quantity,3);
  }
  for (const item of data.items) assert.deepEqual(Object.keys(item).sort(),['date','group','quantity']);
  assert.doesNotMatch(JSON.stringify(data), /visitor|note|staff|external|Synthetic|private/);
  assert.equal((await (await signed(app,env,'start=2026-09-29&end=2026-09-30')).json()).items.length,2);
  assert.deepEqual(await (await signed(app,env,'start=2026-09-30&end=2026-09-30')).json(),{items:[]});
});

test('HMAC auth is isolated from reviewer, blocks tampering and stale timestamps, limits 93 days', async () => {
  const { app, env } = setup();
  assert.equal((await app.request('/internal/experience-rental-occupancy',{},env)).status,401);
  assert.equal((await signed(app,env,undefined,{signature:'0'.repeat(64)})).status,401);
  assert.equal((await signed(app,env,undefined,{secret:env.INTERNAL_API_SECRET})).status,401);
  assert.equal((await signed(app,env,undefined,{timestamp:String(Math.floor(Date.now()/1000)-301)})).status,401);
  assert.equal((await signed(app,env,undefined,{timestamp:String(Math.floor(Date.now()/1000)+301)})).status,401);
  assert.equal((await signed(app,env)).status,200);
  assert.equal((await signed(app,env,'start=2026-01-01&end=2026-04-03')).status,200);
  for (const query of ['start=2026-01-01&end=2026-04-04','start=2026-02-30&end=2026-03-01','start=2026-09-29&end=2026-09-27']) assert.equal((await signed(app,env,query)).status,400);
  const res = await signed(app, {...env,CENTER_INVENTORY_API_SECRET:undefined}, undefined, {secret:'test'});
  assert.equal(res.status,503);
  const unavailable = await signed(app,{...env,DB:{prepare(){throw new Error('unavailable')}}});
  assert.equal(unavailable.status,503);
  // Non-GET requests never reach a Center-authorized write route.
  const url='https://luggage.test/internal/experience-rental-occupancy'; const timestamp=String(Math.floor(Date.now()/1000));
  const {signature}=await signInternalRequest({secret:env.CENTER_INVENTORY_API_SECRET,method:'POST',url,timestamp});
  assert.equal((await app.request(url,{method:'POST',headers:{'x-internal-timestamp':timestamp,'x-internal-signature':signature}},env)).status,401);
});

test('cross-language canonical HMAC vector with empty GET body', async () => {
  const {signature,bodyHash}=await signInternalRequest({secret:'test-shared-key',method:'GET',url:'https://luggage.test/internal/experience-rental-occupancy?start=2026-09-27&end=2026-09-29',timestamp:'1790467200'});
  assert.equal(bodyHash,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(signature,'9fcf1c483601e091f91b2c8039f41e3e003a2bea66e510959ac916487677c95c');
});

test('every rental of a new visit references that visit even when rental ids diverge', async () => {
  const { app, env, sqlite } = setup();
  // Seed so visit ids and rental ids no longer coincide.
  await app.request('/staff/handover/experience', { method:'POST', body: form([row, row, row, row]) }, env);
  const res = await app.request('/staff/handover/experience', { method:'POST', body: form([row, { ...row, rental_group:'밴드' }, { ...row, rental_group:'지팡이' }]) }, env);
  assert.equal(res.status, 302);
  assert.deepEqual(
    sqlite.prepare('SELECT visit_id, COUNT(*) AS n FROM luggage_experience_rentals GROUP BY visit_id ORDER BY visit_id').all().map((r) => [r.visit_id, r.n]),
    [[1, 4], [2, 3]],
  );
});
