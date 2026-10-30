import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import internalApi from '../src/routes/internalApi';
import { signInternalRequest } from '../src/lib/hmac';

const SECRET = 'synthetic-tag-sort-secret';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('src/schema.sql', 'utf8'));
  const timings: Array<{ sql: string; ms: number }> = [];
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async all() { const start = performance.now(); const results = sqlite.prepare(sql).all(...args as never[]); timings.push({ sql, ms: performance.now() - start }); return { results }; },
      async first() { return sqlite.prepare(sql).get(...args as never[]) ?? null; },
    };
  };
  return { sqlite, timings, app: new Hono().route('/', internalApi), env: { DB: { prepare }, INTERNAL_API_SECRET: SECRET, APP_ENV: 'test' } };
}
type Seed = { id: string; tag: string | number | null; at?: string; status?: string; manual?: number; parent?: string };
function seed(ctx: ReturnType<typeof setup>, rows: Seed[]) {
  const insert = ctx.sqlite.prepare(`INSERT INTO luggage_orders
    (order_id, tag_no, created_at, updated_at, name, status, manual_entry, parent_order_id, suitcase_qty, prepaid_amount, final_amount)
    VALUES (?, ?, ?, ?, 'Synthetic', ?, ?, ?, 1, 800, 800)`);
  for (const row of rows) insert.run(row.id, row.tag, row.at ?? '2031-05-10T01:00:00Z', row.at ?? '2031-05-10T01:00:00Z', row.status ?? 'PAYMENT_PENDING', row.manual ?? 0, row.parent ?? null);
}
async function get(ctx: ReturnType<typeof setup>, query = '', signed = true) {
  const url = `https://luggage.test/internal/luggage-orders${query}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method: 'GET', url, timestamp, body: '' });
  const response = await ctx.app.request(url, { headers: signed ? { 'x-internal-timestamp': timestamp, 'x-internal-signature': signature } : {} }, ctx.env);
  return { status: response.status, body: await response.json() as any };
}
const ids = (body: any) => body.orders.map((row: any) => row.orderId);

test('opt-in sorts manual 27 between 28/26, numerically descending, with long tags unchanged', async t => {
  const c = setup(); t.after(() => c.sqlite.close());
  seed(c, [{id:'26',tag:26},{id:'28',tag:'28'},{id:'manual27',tag:'27',manual:1,at:'2031-05-10T09:00:00Z'},
    {id:'2',tag:'2'},{id:'10',tag:10},{id:'146',tag:'146'},{id:'150',tag:150}]);
  const before = c.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all();
  const result = await get(c,'?sort=tag_desc'); assert.equal(result.status,200);
  assert.deepEqual(ids(result.body),['150','146','28','manual27','26','10','2']);
  assert.deepEqual(c.sqlite.prepare('SELECT * FROM luggage_orders ORDER BY order_id').all(),before);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_audit_logs').get()!.n,0);
});

test('spaces, numeric/text values, leading zeros and legacy .0 share numeric ties; missing or malformed tags are last', async t => {
  const c=setup();t.after(()=>c.sqlite.close());
  seed(c,[{id:'b',tag:'027'},{id:'a',tag:' 27 '},{id:'c',tag:27.0},{id:'d',tag:'27.0'}, {id:'f',tag:'\t27\n'}, {id:'g',tag:'\uFEFF27.0\u00A0'},
    {id:'e',tag:'28'},{id:'null',tag:null},{id:'empty',tag:''},{id:'space',tag:'  '},
    {id:'text',tag:'tag'},{id:'partial',tag:'99x'},{id:'fraction',tag:'99.5'},{id:'zero',tag:0},
    {id:'negative',tag:-5},{id:'malformed',tag:'99.0.0'},{id:'unsafe',tag:'99999999999999999999'}]);
  const {body}=await get(c,'?sort=tag_desc');
  assert.deepEqual(ids(body).slice(0,7),['e','g','f','d','c','b','a']);
  assert.deepEqual(ids(body).slice(7),['zero','unsafe','text','space','partial','null','negative','malformed','fraction','empty']);
});

test('equal tags use created_at DESC then order_id DESC deterministically across pages and reloads', async t => {
  const c=setup();t.after(()=>c.sqlite.close());
  seed(c,[{id:'older',tag:'27',at:'2031-05-09T01:00:00Z'},{id:'A',tag:27},{id:'Z',tag:'027'}]);
  for(let repeat=0;repeat<2;repeat++) {
    const actual=[];for(let offset=0;offset<3;offset++)actual.push(...ids((await get(c,`?sort=tag_desc&limit=1&offset=${offset}`)).body));
    assert.deepEqual(actual,['Z','A','older']);
  }
});

test('the whole result is sorted before pagination; no page-local reordering or manual priority', async t => {
  const c=setup();t.after(()=>c.sqlite.close());
  seed(c,Array.from({length:150},(_,i)=>({id:`order-${String(i+1).padStart(3,'0')}`,tag:String(i+1),manual:i%2,at:`2031-05-10T01:${String(i%60).padStart(2,'0')}:00Z`})).reverse());
  const all=[];for(let offset=0;offset<150;offset+=20) { const {body}=await get(c,`?sort=tag_desc&limit=20&offset=${offset}`);assert.equal(body.total,150);all.push(...body.orders.map((r:any)=>Number(r.tagNo))); }
  assert.deepEqual(all,Array.from({length:150},(_,i)=>150-i));
  assert.deepEqual(ids((await get(c,'?sort=tag_desc&limit=20&offset=999')).body),[]);
});

test('status/search/JST filters, status counts, financial summaries and nested extension order are preserved', async t => {
  const c=setup();t.after(()=>c.sqlite.close());
  seed(c,[{id:'root-27',tag:'27'},{id:'root-28',tag:'28',status:'PAID'},
    {id:'ext-new',tag:'27',parent:'root-27',at:'2031-05-10T03:00:00Z'},
    {id:'ext-old',tag:'27',parent:'root-27',at:'2031-05-10T02:00:00Z'},
    {id:'before',tag:'150',at:'2031-05-09T14:59:59Z'},{id:'cancel',tag:'149',status:'CANCELLED'}]);
  for(const filters of ['status=UNPICKED','status=PAID','search=root','dateFrom=2031-05-10&dateTo=2031-05-10']) {
    const old=(await get(c,'?'+filters)).body;const sorted=(await get(c,'?'+filters+'&sort=tag_desc')).body;
    assert.deepEqual(sorted.statusCounts,old.statusCounts);assert.equal(sorted.total,old.total);
    const byId=(rows:any[])=>rows.slice().sort((a,b)=>a.orderId.localeCompare(b.orderId));
    assert.deepEqual(byId(sorted.orders),byId(old.orders));
  }
  const root=(await get(c,'?search=root-27&sort=tag_desc')).body.orders.find((r:any)=>r.orderId==='root-27');
  assert.deepEqual(root.extensions.map((r:any)=>r.orderId),['ext-new','ext-old']);assert.ok(root.billing);
});

test('omitted, unknown and injection sort values preserve default order; unsigned reads are still denied', async t => {
  const c=setup();t.after(()=>c.sqlite.close());seed(c,[{id:'old-high',tag:'150'},{id:'new-low',tag:'1',at:'2031-05-11T01:00:00Z'}]);
  for(const query of ['', '?sort=unknown','?sort='+encodeURIComponent('tag_desc; DROP TABLE luggage_orders')])assert.deepEqual(ids((await get(c,query)).body),['new-low','old-high']);
  assert.equal((await get(c,'?sort=tag_desc',false)).status,401);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,2);
});

test('representative 10000-row synthetic read remains bounded without schema/index changes', async t => {
  const c=setup();t.after(()=>c.sqlite.close());
  c.sqlite.exec('BEGIN');seed(c,Array.from({length:10000},(_,i)=>({id:`load-${i}`,tag:String(i%150+1)})));c.sqlite.exec('COMMIT');
  const {body}=await get(c,'?sort=tag_desc&limit=100&offset=5000');assert.equal(body.orders.length,100);assert.equal(body.total,10000);
  const query=c.timings.find(r=>r.sql.includes('LIMIT ? OFFSET ?'))!;assert.ok(query.ms<2000,`Synthetic list SQL took ${query.ms}ms`);
  console.log(JSON.stringify({syntheticTagSortRows:10000,offset:5000,listSqlMilliseconds:query.ms}));
});
