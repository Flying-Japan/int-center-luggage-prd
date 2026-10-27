import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const { app, env } = fixture(db);
  const one = (sql,...args) => db.prepare(sql).bind(...args).first();
  const run = (sql,...args) => db.prepare(sql).bind(...args).run();
  const rows = async sql => (await db.prepare(sql).all()).results;
  const snapshot = async () => ({orders:await rows('SELECT * FROM luggage_orders ORDER BY order_id'),
    payments:await rows('SELECT * FROM luggage_order_payments ORDER BY payment_id'),
    audits:await rows('SELECT * FROM luggage_audit_logs ORDER BY log_id')});
  let seq=0, cases=0;
  async function seed() {
    const id=`20261026-${String(++seq).padStart(3,'0')}`;
    await run(`INSERT INTO luggage_orders(order_id,created_at,expected_pickup_at,expected_storage_days,
      status,price_per_day,prepaid_amount,final_amount,tag_no) VALUES (?,datetime('now','-1 day'),
      date('now','+9 hours','-1 day')||'T12:00:00Z',1,'PAID',1600,1600,1600,'146')`,id);
    await run(`INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id)
      VALUES (?,date('now','+9 hours','-1 day'),'CASH',1600,'d1-test-editor')`,id);
    await confirmCollection(db,id,'d1-test-editor',{request_id:crypto.randomUUID(),confirm_received:'yes',expected_amount:1600,cash_amount:1600,qr_amount:0});
    return id;
  }
  async function request(id,kind,undo=false) {
    if(kind==='internal') {
      const url=`https://local.invalid/internal/luggage-orders/${id}/pickup-status`;
      const row=await one('SELECT updated_at FROM luggage_orders WHERE order_id=?',id);
      const raw=JSON.stringify({action:undo?'undo_picked_up':'mark_picked_up',expectedUpdatedAt:row.updated_at,
        actor:{userId:'test-user',name:'Test',role:'center_staff'}});
      const timestamp=String(Math.floor(Date.now()/1000));
      const {signature}=await signInternalRequest({method:'PATCH',url,body:raw,timestamp,secret:'local-test-only'});
      return app.request(url,{method:'PATCH',headers:{'Content-Type':'application/json','x-internal-signature':signature,'x-internal-timestamp':timestamp},body:raw},env);
    }
    return app.request(kind==='json'?`/staff/api/orders/${id}/${undo?'undo-pickup':'pickup'}`:
      `/staff/orders/${id}/${undo?'undo-picked-up':'mark-picked-up'}`,{method:'POST'},env);
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
  console.log(`PASS ${cases}/${cases} local D1 HTTP scenarios; no existing DB or migration files used`);
} finally {
  if(mf)await mf.dispose();
  console.log('Isolated evidence retained:', dir);
}
