import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { mock } from 'node:test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.deepEqual(process.argv.slice(2), ['--run-local']);
const require = createRequire(`${root}/package.json`);
const dependency = createRequire(require.resolve('wrangler/package.json'));
const { build } = dependency('esbuild');
const { Miniflare } = dependency('miniflare');
const dir = await mkdtemp(join(tmpdir(), 'luggage-pickup-http-d1-'));
let mf;
try {
  const file = join(dir, 'http.cjs');
  await build({ stdin: { contents: `
    import { Hono } from 'hono';
    import staffApi from './src/routes/staffApi';
    import staffOrders from './src/routes/staffOrders';
    import internalApi from './src/routes/internalApi';
    export { signInternalRequest } from './src/lib/hmac';
    export { confirmCollection, getBillingSummary } from './src/services/luggageBilling';
    export function fixture(db) {
      const app = new Hono();
      app.use('/staff/*', async(c,next)=> {c.set('staff',{id:'d1-test-editor',role:'editor',is_active:true,display_name:'Test'}); await next();});
      app.route('/',internalApi).route('/',staffApi).route('/',staffOrders);
      return {app, env:{DB:db, INTERNAL_API_SECRET:'local-test-only', APP_ENV:'test'}};
    }
  `, resolveDir: root, sourcefile: 'd1-http.ts', loader: 'ts' }, outfile: file,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' });
  const { fixture, signInternalRequest, confirmCollection, getBillingSummary } = require(file);
  // Never loads Wrangler config or any existing DB. This binding is memory-only.
  mf = new Miniflare({ modules: true, rootPath: dir, host: '127.0.0.1', port: 0,
    compatibilityDate: '2025-04-01', script: "export default {fetch(){return new Response('test only',{status:405})}}",
    outboundService: () => new Response('network disabled', { status: 403 }),
    d1Databases: { DB: 'pickup-http-test-only' }, d1Persist: false });
  const db = await mf.getD1Database('DB');
  // SQLite supplies complete CREATE statements; only the current fresh schema is bootstrapped.
  // No migration files or production/rehearsal databases are opened.
  const schema = new DatabaseSync(':memory:');
  try {
    schema.exec(await readFile(`${root}/src/schema.sql`, 'utf8'));
    for (const { sql } of schema.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) {
      await db.prepare(sql).run();
    }
  } finally { schema.close(); }
  // Synthetic historical fixtures opt in explicitly; never relax the operational cutover.
  await db.prepare("INSERT INTO luggage_automatic_billing_policy(singleton, starts_at) VALUES (1, '1970-01-01T00:00:00Z')").run();
  const { app, env } = fixture(db);
  const one = (sql,...args) => db.prepare(sql).bind(...args).first();
  const run = (sql,...args) => db.prepare(sql).bind(...args).run();
  const rows = async sql => (await db.prepare(sql).all()).results;
  const snapshot = async () => ({orders:await rows('SELECT * FROM luggage_orders ORDER BY order_id'),
    payments:await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'),
    audits:await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id')});
  let seq=0, cases=0;
  async function seed(tag) {
    const id=`20261026-${String(++seq).padStart(3,'0')}`;
    await run(`INSERT INTO luggage_orders(order_id,created_at,expected_pickup_at,expected_storage_days,
      status,price_per_day,prepaid_amount,final_amount,tag_no) VALUES (?,datetime('now','-1 day'),
      date('now','+9 hours','-1 day')||'T12:00:00Z',1,'PAID',1600,1600,1600,?)`,id,String(tag ?? 50 + seq));
    await run(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id,recorded_at)
      VALUES (?,date('now','+9 hours','-1 day'),'CASH',1600,'d1-test-editor',datetime('now','-1 day'))`,id);
    await confirmCollection(db,id,'d1-test-editor',{request_id:crypto.randomUUID(),confirm_received:'yes',expected_amount:1600,cash_amount:1600,qr_amount:0});
    return id;
  }
  async function request(id,kind,undo=false,target={app,env}) {
    if(kind==='internal') {
      const url=`https://local.invalid/internal/luggage-orders/${id}/pickup-status`;
      const row=await one('SELECT updated_at FROM luggage_orders WHERE order_id=?',id);
      const raw=JSON.stringify({action:undo?'undo_picked_up':'mark_picked_up',expectedUpdatedAt:row.updated_at,
        actor:{userId:'test-user',name:'Test',role:'center_staff'}});
      const timestamp=String(Math.floor(Date.now()/1000));
      const {signature}=await signInternalRequest({method:'PATCH',url,body:raw,timestamp,secret:'local-test-only'});
      return target.app.request(url,{method:'PATCH',headers:{'Content-Type':'application/json','x-internal-signature':signature,'x-internal-timestamp':timestamp},body:raw},target.env);
    }
    return app.request(kind==='json'?`/staff/api/orders/${id}/${undo?'undo-pickup':'pickup'}`:
      `/staff/orders/${id}/${undo?'undo-picked-up':'mark-picked-up'}`,{method:'POST'},target.env);
  }
  const ok=(response,kind)=>{assert.equal(response.status,kind==='html'?302:200);if(kind==='html')assert.ok(!response.headers.get('location').includes('?error='));};
  for(const kind of ['json','html','internal']) {
    const id=await seed();
    const money=await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id');
    ok(await request(id,kind),kind);
    let family=(await db.prepare('SELECT status,actual_pickup_at FROM luggage_orders WHERE order_id=? OR parent_order_id=?').bind(id,id).all()).results;
    assert.ok(family.every(row=>row.status==='PICKED_UP'&&row.actual_pickup_at===family[0].actual_pickup_at));
    ok(await request(id,kind,true),kind);
    family=(await db.prepare('SELECT status,actual_pickup_at FROM luggage_orders WHERE order_id=? OR parent_order_id=?').bind(id,id).all()).results;
    assert.ok(family.every(row=>row.status==='PAID'&&row.actual_pickup_at===null));
    assert.deepEqual(await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'),money);
    assert.equal((await getBillingSummary(db,id)).outstanding_amount,0);
    cases++;
    for(const undo of [false,true]) for(const mode of ['ABORT','IGNORE']) {
      const failedId=await seed();
      if(undo)ok(await request(failedId,kind),kind);
      await db.prepare(`CREATE TRIGGER reject_audit_${seq} BEFORE INSERT ON luggage_audit_logs
        WHEN NEW.order_id='${failedId}' AND NEW.action IN ('PICKUP','UNDO_PICKUP','MARK_PICKED_UP','UNDO_PICKED_UP','UNIFIED_ADMIN_PICKUP_STATUS_UPDATE')
        BEGIN SELECT RAISE(${mode}${mode==='ABORT'?", 'test audit failure'":''}); END`).run();
      const before=await snapshot();
      const response=await request(failedId,kind,undo);
      assert.equal(response.status,500,`${kind} undo=${undo} audit=${mode}`);
      assert.deepEqual(await snapshot(),before);
      cases++;
    }
    for(const undo of [false,true]) {
      const failedId=await seed();
      if(undo)ok(await request(failedId,kind),kind);
      await db.prepare(`CREATE TRIGGER reject_child_${seq} BEFORE UPDATE OF status ON luggage_orders
        WHEN OLD.parent_order_id='${failedId}' BEGIN SELECT RAISE(ABORT,'test child failure'); END`).run();
      const before=await snapshot();
      assert.equal((await request(failedId,kind,undo)).status,500);
      assert.deepEqual(await snapshot(),before);
      cases++;
    }
    console.log(`PASS local D1 actual HTTP: ${kind} success/undo + audit ABORT/IGNORE + child failure`);
  }
  const collisionMessage='이 짐번호는 이미 다른 주문에서 사용 중이라 수령취소할 수 없습니다. 현재 보관 내역을 확인해주세요.';
  const rejected=async(response,kind)=>{
    assert.equal(response.status,kind==='html'?302:409);
    const message=kind==='html'?new URL(response.headers.get('location'),'https://local.invalid').searchParams.get('error'):(await response.json()).error;
    assert.equal(message,collisionMessage);
  };
  async function holder(tag,status='PAID') {
    const id=`LOCAL-HOLDER-${++seq}`;
    await run(`INSERT INTO luggage_orders(order_id,tag_no,status,created_at,expected_pickup_at,price_per_day,prepaid_amount,final_amount)
      VALUES(?,?,?,datetime('now'),datetime('now','+2 days'),0,0,0)`,id,String(tag),status);
    return id;
  }
  for(const tag of [1,140,141,145,146,150]) for(const status of ['PAYMENT_PENDING','PAID']) {
    const id=await seed(tag);ok(await request(id,'internal'),'internal');
    const owner=await holder(tag,status),before=await snapshot();
    await rejected(await request(id,'internal',true),'internal');
    assert.deepEqual(await snapshot(),before);
    await run("UPDATE luggage_orders SET status='CANCELLED' WHERE order_id=?",owner);
    cases++;
  }
  console.log('PASS local D1: reused ordinary/expanded/old long tags; paid and pending owners; all records unchanged');
  for(const kind of ['json','html','internal']) {
    const id=await seed(141);ok(await request(id,kind),kind);
    const owner=await holder('0141');
    // Put a valid audit write BEFORE the collision assertion: real D1 must roll it back as well.
    const guarded=fixture({prepare:db.prepare.bind(db),batch:statements=>db.batch([
      db.prepare("INSERT INTO luggage_audit_logs(order_id,action,details) VALUES (?,'LOCAL_ATOMICITY_PROBE','must roll back')").bind(id),...statements])});
    const before=await snapshot();
    await rejected(await request(id,kind,true,guarded),kind);
    assert.deepEqual(await snapshot(),before);
    await run("UPDATE luggage_orders SET status='CANCELLED' WHERE order_id=?",owner);
    ok(await request(id,kind,true),kind);
    const restored=await snapshot();
    const replay=await request(id,kind,true);
    assert.equal(replay.status,kind==='html'?302:409);
    if(kind==='html')assert.ok(replay.headers.get('location').includes('?error='));
    assert.deepEqual(await snapshot(),restored);
    ok(await request(id,kind),kind); // Release the synthetic tag for the next case.
    cases++;
  }
  console.log('PASS local D1: all 3 HTTP entry points; collision rolls back prior write, normal restore and repeat refusal');
  {
    const id=await seed(145);ok(await request(id,'internal'),'internal');
    let owner;
    const concurrent=fixture({prepare:db.prepare.bind(db),batch:async statements=>{
      owner=await holder(145,'PAYMENT_PENDING'); // Intake commits after the undo read, before its transaction.
      return db.batch(statements);
    }});
    const before=await snapshot();
    await rejected(await request(id,'internal',true,concurrent),'internal');
    assert.equal((await one('SELECT status FROM luggage_orders WHERE order_id=?',id)).status,'PICKED_UP');
    assert.deepEqual(await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id'),before.audits);
    await run("UPDATE luggage_orders SET status='CANCELLED' WHERE order_id=?",owner);
    cases++;
  }
  async function intake(overnight) {
    const date=new Date(Date.now()+(overnight?33:9)*3600000).toISOString().slice(0,10);
    const url='https://local.invalid/internal/luggage-orders/manual';
    const raw=JSON.stringify({name:'Local race',phone:'local-only',suitcaseQty:1,backpackQty:0,companionCount:0,
      expectedPickupAt:`${date}T20:00:00+09:00`,flyingPassTier:'NONE',freeReason:'',freeReasonText:'',note:'local-only',
      actor:{userId:'test-user',name:'Test',email:'local@example.test',role:'center_staff'}});
    const timestamp=String(Math.floor(Date.now()/1000));
    const {signature}=await signInternalRequest({method:'POST',url,body:raw,timestamp,secret:'local-test-only'});
    return app.request(url,{method:'POST',headers:{'Content-Type':'application/json','x-internal-signature':signature,'x-internal-timestamp':timestamp},body:raw},env);
  }
  for(const overnight of [true,false]) {
    if(!overnight){const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);mock.timers.enable({apis:['Date'],now:new Date(`${today}T01:00:00Z`)});}
    const tag=overnight?141:140,id=await seed(tag);ok(await request(id,'internal'),'internal');
    // Use only synthetic local records; fill all other tags in the selected allocation pool.
    const blockers=[];
    for(let n=overnight?142:1;n<=(overnight?150:139);n++){
      if(!await one("SELECT 1 FROM luggage_orders WHERE CAST(tag_no AS INTEGER)=? AND status IN ('PAID','PAYMENT_PENDING') LIMIT 1",n))blockers.push(await holder(n,'PAYMENT_PENDING'));
    }
    if(!overnight)await db.prepare("INSERT OR REPLACE INTO luggage_daily_tag_counters(business_date,last_seq) VALUES(strftime('%Y%m%d','now','+9 hours'),140)").run();
    const [created,undo]=await Promise.all([intake(overnight),request(id,'internal',true)]);
    assert.ok((created.status===201&&undo.status===409)||(created.status===409&&undo.status===200),`intake=${created.status} undo=${undo.status}`);
    const active=await one("SELECT COUNT(DISTINCT COALESCE(parent_order_id,order_id)) n FROM luggage_orders WHERE CAST(tag_no AS INTEGER)=? AND status IN ('PAID','PAYMENT_PENDING')",tag);
    assert.equal(active.n,1);
    for(const owner of blockers)await run("UPDATE luggage_orders SET status='CANCELLED' WHERE order_id=?",owner);
    cases++;
    if(!overnight)mock.timers.reset();
  }
  console.log('PASS local D1: late claim, concurrent general/long intake versus undo, exactly one family per contested tag');
  const report={passed:cases,failed:0,at:new Date().toISOString(),existingDatabasesOpened:0,productionRequests:0,
    sourceHashes:Object.fromEntries(await Promise.all(['src/services/orderPickupWrites.ts','scripts/verify-d1-http.local.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(root,name))).digest('hex')])))};
  await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));
  console.log(`PASS ${cases}/${cases} local D1 HTTP scenarios; no existing DB or migration files used`);
} finally {
  mock.timers.reset();
  if(mf)await mf.dispose();
  console.log('Isolated evidence retained:', dir);
}
