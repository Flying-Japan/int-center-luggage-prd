import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import internalApi from '../src/routes/internalApi';
import { buildOvernightTag, buildSameDayTag } from '../src/services/orderNumber';
import { runMidnightRollover } from '../src/services/midnightRollover';
import { signInternalRequest } from '../src/lib/hmac';
import { tagColorClass } from '../src/lib/tagColors';
const SECRET='tag-range-local-test';
test('ordinary140 stays green vertical; expanded long141–150 reuse the red horizontal class', () => {
  assert.equal(tagColorClass('140'), 'tag-pattern-green-vertical');
  for (let tag = 141; tag <= 150; tag++) assert.equal(tagColorClass(String(tag)), 'tag-pattern-red-horizontal');
});
function setup() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync('src/schema.sql','utf8'));
  const statement=(sql:string)=>{let args:unknown[]=[];return {
    bind(...values:unknown[]){args=values;return this;},
    async first(){return sqlite.prepare(sql).get(...args as never[])??null;},
    async all(){return {results:sqlite.prepare(sql).all(...args as never[])};},
    async run(){const results=sqlite.prepare(sql).all(...args as never[]);return {results,meta:{changes:(sqlite.prepare('SELECT changes() n').get() as {n:number}).n}};},
  };};
  let queue:Promise<unknown>=Promise.resolve();
  const db={prepare:statement,batch(items:ReturnType<typeof statement>[]){const result=queue.then(async()=>{sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}});queue=result.then(()=>undefined,()=>undefined);return result;}} as unknown as D1Database;
  return {sqlite,db,app:new Hono().route('/',internalApi)};
}
type C=ReturnType<typeof setup>;
function seed(c:C,tag:number,status='PAID',suffix='') {const id=`20261001-${String(tag).padStart(3,'0')}${suffix}`;c.sqlite.prepare("INSERT INTO luggage_orders(order_id,tag_no,status,created_at,updated_at,expected_pickup_at,expected_storage_days,prepaid_amount,final_amount,price_per_day) VALUES(?,?,?,'2026-10-01 01:00:00','2026-10-01 01:00:00','2026-11-02T03:00:00Z',1,800,800,800)").run(id,String(tag),status);return id;}
const rows=(c:C)=>c.sqlite.prepare('SELECT order_id,tag_no,status,prepaid_amount,final_amount FROM luggage_orders ORDER BY order_id').all();
async function manual(c:C,name='Synthetic Guest') {const tomorrow=new Date(Date.now()+33*3600_000).toISOString().slice(0,10);const url='https://luggage.test/internal/luggage-orders/manual';const body=JSON.stringify({name,phone:'000-local-only',suitcaseQty:1,backpackQty:0,companionCount:0,expectedPickupAt:`${tomorrow}T12:00:00+09:00`,flyingPassTier:'NONE',freeReason:'',freeReasonText:'',note:'local synthetic',actor:{userId:'local',name:'Local Tester',email:'local@example.test',role:'center_staff'}});const timestamp=String(Math.floor(Date.now()/1000));const {signature}=await signInternalRequest({secret:SECRET,method:'POST',url,timestamp,body});const r=await c.app.request(url,{method:'POST',headers:{'content-type':'application/json','x-internal-timestamp':timestamp,'x-internal-signature':signature},body},{DB:c.db,INTERNAL_API_SECRET:SECRET,APP_ENV:'test'});return {status:r.status,body:await r.json() as Record<string,any>};}

test('new long intake uses 141 while preserving existing occupied 145–150 from older dates',async t=>{const c=setup();t.after(()=>c.sqlite.close());for(let n=145;n<=150;n++)seed(c,n);const before=rows(c);assert.equal(await buildOvernightTag(c.db),'141');const r=await manual(c);assert.equal(r.status,201,JSON.stringify(r.body));const created=c.sqlite.prepare("SELECT tag_no FROM luggage_orders WHERE name='Synthetic Guest'").get()!;assert.equal(created.tag_no,'141');assert.deepEqual(rows(c).filter(r=>String(r.order_id).startsWith('20261001-')),before);});

test('overnight availability includes unpaid and paid roots across all dates; picked/cancelled tags can be reused',async t=>{const c=setup();t.after(()=>c.sqlite.close());seed(c,141);seed(c,142,'PAYMENT_PENDING');seed(c,143,'PICKED_UP');seed(c,144,'CANCELLED');for(let n=145;n<=150;n++)seed(c,n);assert.equal(await buildOvernightTag(c.db),'143');});

test('all ten long tags block intake without creating an order, then released 146 becomes available',async t=>{const c=setup();t.after(()=>c.sqlite.close());for(let n=141;n<=150;n++)seed(c,n);const before=rows(c);assert.equal(await buildOvernightTag(c.db),null);const r=await manual(c);assert.equal(r.status,409);assert.match(r.body.error,/141~150/);assert.deepEqual(rows(c),before);c.sqlite.prepare("UPDATE luggage_orders SET status='PICKED_UP' WHERE tag_no='146'").run();assert.equal(await buildOvernightTag(c.db),'146');});

test('same-day boundary and existing counters above 140 never allocate reserved 141–150',async t=>{const c=setup();t.after(()=>c.sqlite.close());c.sqlite.prepare("INSERT INTO luggage_daily_tag_counters VALUES('20300101',139)").run();assert.equal(await buildSameDayTag(c.db,'20300101'),'140');for(let n=1;n<=140;n++)seed(c,n);assert.equal(await buildSameDayTag(c.db,'20300101'),null);c.sqlite.prepare("UPDATE luggage_daily_tag_counters SET last_seq=145").run();c.sqlite.prepare("UPDATE luggage_orders SET status='PICKED_UP' WHERE tag_no='42'").run();assert.equal(await buildSameDayTag(c.db,'20300101'),'42');});

test('midnight moves only 1–140 and its children; existing 141–150 numbers and money stay unchanged',async t=>{const c=setup();t.after(()=>c.sqlite.close());const root=seed(c,140);seed(c,141);seed(c,145);seed(c,146);c.sqlite.prepare("INSERT INTO luggage_orders(order_id,parent_order_id,tag_no,status) VALUES('20261002-EXT',?,'140','PAYMENT_PENDING')").run(root);const before=rows(c);const r=await runMidnightRollover(c.db);assert.equal(r.transitioned,1);assert.equal(r.errors,0);const after=rows(c);for(const prior of before){const saved=after.find(x=>x.order_id===prior.order_id)!;assert.equal(saved.tag_no,prior.tag_no==='140'?'142':prior.tag_no);assert.equal(saved.prepaid_amount,prior.prepaid_amount);assert.equal(saved.final_amount,prior.final_amount);assert.equal(saved.status,prior.status);}assert.equal(await buildOvernightTag(c.db),'143');});

test('concurrent manual intakes cannot claim the same expanded long tag',async t=>{const c=setup();t.after(()=>c.sqlite.close());for(let n=142;n<=150;n++)seed(c,n);const results=await Promise.all([manual(c,'Concurrent A'),manual(c,'Concurrent B')]);assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);const tags=c.sqlite.prepare("SELECT tag_no,COUNT(*) n FROM luggage_orders WHERE status IN ('PAID','PAYMENT_PENDING') GROUP BY CAST(tag_no AS INTEGER) HAVING COUNT(*)>1").all();assert.deepEqual(tags,[]);});
