// Isolated local D1/R2, immutable staff then combined M0 binaries.
// No production credentials or data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,mkdtempSync,mkdirSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {splitSql,assertSameSql} from '../scripts/lib/sql-contract.mjs';
const plan=JSON.parse(readFileSync('integration/staff-customer-inputs.json','utf8'));
const require=createRequire(import.meta.url),deps=createRequire(require.resolve('wrangler/package.json'));
const {build}=deps('esbuild'),{Miniflare,Log,LogLevel}=deps('miniflare');
const sql=file=>readFileSync(file,'utf8');
const base=execFileSync('git',['show',`${plan.base}:worker/src/schema.sql`],{encoding:'utf8'});
const repository=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();

async function fixture(schema=base){
 const dir=mkdtempSync(join(tmpdir(),'luggage-staff-customer-')),secret='synthetic-integration-only';
 const snapshot=join(dir,'staff-source');mkdirSync(snapshot);
 const archive=execFileSync('git',['archive',plan.staff,'worker/src','worker/tsconfig.json'],{cwd:repository,maxBuffer:32*1024*1024});
 execFileSync('tar',['-x','-C',snapshot],{input:archive});
 symlinkSync(realpathSync('node_modules'),join(snapshot,'worker/node_modules'),'dir');
 await build({entryPoints:[join(snapshot,'worker/src/index.tsx')],tsconfig:join(snapshot,'worker/tsconfig.json'),outfile:join(dir,'staff-worker.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*'],logLevel:'silent'});
 await build({entryPoints:['src/index.tsx'],outfile:join(dir,'worker.mjs'),bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*'],logLevel:'silent'});
 await build({entryPoints:['tests/helpers/syntheticPhoto.ts'],outfile:join(dir,'photo.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const {syntheticPng}=require(join(dir,'photo.cjs'));
 const profile={id:'11111111-1111-4111-8111-111111111111',display_name:'Synthetic Integration Editor',username:'synthetic',email:'integration@example.invalid',role:'editor',is_active:true,created_at:''};
 const options=customer=>({modules:true,modulesRoot:dir,scriptPath:join(dir,customer?'worker.mjs':'staff-worker.mjs'),compatibilityDate:'2025-04-01',compatibilityFlags:['nodejs_compat'],log:new Log(LogLevel.ERROR),
  d1Databases:{DB:'isolated-staff-customer'},d1Persist:join(dir,'d1'),r2Buckets:['IMAGES'],r2Persist:join(dir,'r2'),
  bindings:{INTERNAL_API_SECRET:secret,APP_SECRET_KEY:secret,APP_ENV:'production',SUPABASE_URL:'https://profiles.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',SUPABASE_ANON_KEY:'synthetic-only',LUGGAGE_STAFF_CORRECTIONS_ENABLED:'true',LUGGAGE_PART_TIME_ACTORS_ENABLED:'true',LUGGAGE_FLYING_PASS_REFUNDS_ENABLED:'true',CUSTOMER_RENEWAL_ENABLED:customer?'1':'0'},
  outboundService:async request=>{const u=new URL(request.url);if(request.method!=='GET'||u.origin!=='https://profiles.invalid'||u.pathname!=='/rest/v1/user_profiles')throw Error('EXTERNAL_NETWORK_FORBIDDEN');return Response.json((request.headers.get('accept')??'').includes('object')?profile:[profile]);}});
 const mf=new Miniflare(options(false));let db=await mf.getD1Database('DB');await db.batch(splitSql(schema).map(s=>db.prepare(s)));
 const actor={userId:'synthetic-integration-editor',name:profile.display_name,email:profile.email,role:'center_staff'};
 const request=async(path,method='GET',value)=>{const body=value===undefined?'':JSON.stringify(value),timestamp=String(Math.floor(Date.now()/1000));return mf.dispatchFetch('https://local.invalid'+path,{method,headers:{'Content-Type':'application/json','x-internal-timestamp':timestamp,'x-internal-signature':createHmac('sha256',secret).update(`${method}\n${path}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex')},...(body?{body}:{})});};
 const all=async statement=>(await db.prepare(statement).all()).results;
 const definitions=()=>all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name");
 const migrate=async(file,lateFailure=false)=>db.batch([...splitSql(sql(file)).map(s=>db.prepare(s)),...(lateFailure?[db.prepare('SELECT * FROM synthetic_missing_after_integration_ddl')]:[])]);
 return {mf,get db(){return db;},actor,request,all,definitions,migrate,
  async customerEnabled(value){await mf.setOptions(options(value));db=await mf.getD1Database('DB');},
  async customer(key){const body=new FormData(),day=new Date(Date.now()+33*3600000).toISOString().slice(0,10);
   for(const [k,v] of Object.entries({name:'Synthetic Integrated Guest',phone:'000-1234-5678',email:'guest@example.invalid',lang:'en',suitcase_qty:'1',backpack_qty:'0',expected_pickup_at:day+'T17:00',payment_method:'CASH',companion_count:'1',consent_checked:'1',intake_mode:'guest',intake_request_key:key}))body.set(k,v);
   for(const [field,label]of[['id_image','ID'],['luggage_image','BAGS']])body.set(field,new Blob([syntheticPng(label)],{type:'image/png'}),label+'.png');
   const wire=new Request('https://local.invalid/customer/submit',{method:'POST',body});
   return mf.dispatchFetch(wire.url,{method:'POST',headers:{origin:'https://local.invalid','content-type':wire.headers.get('content-type')},body:new Uint8Array(await wire.arrayBuffer())});
  },close:async()=>{await mf.dispose();rmSync(dir,{recursive:true,force:true});}};
}
const oid='20991231-990799',path=`/internal/luggage-orders/${oid}/corrections`;
async function command(h,changes){const response=await h.request(path+'/preview','POST',{actor:h.actor,changes}),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return{actor:h.actor,changes,correctionId:crypto.randomUUID(),expectedFingerprint:value.quote.fingerprint,reason:'Synthetic staged staff/customer integration'};}

test('staff-first persisted ledger survives customer-only migrations and combined worker redeploy',async t=>{
 const h=await fixture();try{
  const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),created=new Date(Date.now()-3600000).toISOString();
  await h.db.prepare("INSERT INTO luggage_orders(order_id,created_at,updated_at,status,name,suitcase_qty,backpack_qty,set_qty,price_per_day,prepaid_amount,final_amount,payment_method,expected_storage_days,expected_pickup_at,actual_pickup_at,tag_no) VALUES(?,?,?,'PICKED_UP','Synthetic Before Staff',1,0,0,800,800,800,'PAY_QR',1,?,?, '81')").bind(oid,created,created,day+'T11:59:00Z',created).run();
  await h.db.prepare("INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,recorded_at) VALUES(?,?,'PAY_QR',800,?)").bind(oid,day,created).run();
  await t.test('dependency inversion is rejected without partial schema/data changes',async()=>{
   const before=await h.definitions();await assert.rejects(h.migrate(plan.staffStage[1]));await assert.rejects(h.migrate(plan.customerStage[2]));assert.deepEqual(await h.definitions(),before);
  });
  const original=(await h.all('SELECT * FROM luggage_order_payments'))[0];
  for(const file of plan.staffStage)await h.migrate(file);
  const historic=(amount)=>({receiptId:crypto.randomUUID(),amount,tenderType:'PAY_QR',businessDate:day,occurredAt:null,timeNote:'Synthetic prior receipt, exact time unknown',confirmedAlreadyReceived:true});
  const first=await command(h,{finalAmount:1000,suitcaseQty:1,backpackQty:1,historicalReceipts:[historic(400)],returned:{amount:200,method:'UNKNOWN',businessDate:day,occurredAt:null,confirmedAlreadyReturned:true,kind:'DISCOUNT_ALREADY_PAID',discountTier:'BLUE',timeNote:null}});
  await t.test('staff stage records historical receipt and paid discount with customer release gate OFF',async()=>{
   const response=await h.request(path,'POST',first);assert.equal(response.status,200,await response.clone().text());
   assert.equal((await h.mf.dispatchFetch('https://local.invalid/customer/renewal')).status,404);
   assert.equal((await h.db.prepare('SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=?').bind(oid).first()).net_received_amount,1000);
  });
  const before={corrections:await h.all('SELECT * FROM luggage_staff_corrections'),payments:await h.all('SELECT * FROM luggage_order_payments'),audits:await h.all('SELECT * FROM luggage_audit_logs'),orders:await h.all('SELECT * FROM luggage_orders'),closing:await h.all('SELECT * FROM luggage_cash_closings')};
  const staffDefinitions=(await h.definitions()).filter(row=>['view','trigger'].includes(row.type));
  for(const file of plan.customerStage)await t.test(`${file}: late failure is atomic; one successful application preserves staff records`,async()=>{
   const definitions=await h.definitions();await assert.rejects(h.migrate(file,true));assert.deepEqual(await h.definitions(),definitions);await h.migrate(file);
   assert.deepEqual(await h.all('SELECT * FROM luggage_staff_corrections'),before.corrections);assert.deepEqual(await h.all('SELECT * FROM luggage_order_payments'),before.payments);assert.deepEqual(await h.all('SELECT * FROM luggage_audit_logs'),before.audits);
  });
  await t.test('customer ALTER adds only null ownership; staff views/triggers and existing closing rows remain exact',async()=>{
   assert.deepEqual((await h.all('SELECT * FROM luggage_orders')).map(({account_person_id,...old})=>old),before.orders);
   assert.deepEqual(await h.all('SELECT * FROM luggage_cash_closings'),before.closing);
   const definitions=await h.definitions();for(const row of staffDefinitions)assert.deepEqual(definitions.find(d=>d.name===row.name&&d.type===row.type),row);
   assert.deepEqual(await h.all('PRAGMA foreign_key_check'),[]);
  });
  await h.customerEnabled(true);
  await t.test('combined worker preserves staff replay and permits an appended historical receipt after restart',async()=>{
   const replay=await h.request(path,'POST',first);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
   const next=await command(h,{finalAmount:1100,historicalReceipts:[historic(100)]});const response=await h.request(path,'POST',next);assert.equal(response.status,200,await response.clone().text());
   assert.equal((await h.db.prepare('SELECT net_received_amount FROM luggage_billing_balances WHERE root_id=?').bind(oid).first()).net_received_amount,1100);
   assert.deepEqual(await h.db.prepare('SELECT * FROM luggage_order_payments WHERE payment_id=?').bind(original.payment_id).first(),original);
   await assert.rejects(h.db.prepare('UPDATE luggage_order_payments SET amount=amount+1 WHERE payment_id=?').bind(original.payment_id).run());
   assert.equal((await h.all('SELECT count(*) n FROM luggage_staff_corrections'))[0].n,2);
  });
  await t.test('renewed customer saves once against upgraded staff schema and staff still reads its actual billing state',async()=>{
   const key=randomBytes(32).toString('base64url'),response=await h.customer(key);assert.equal(response.status,200,await response.clone().text());const saved=await response.json();
   const replay=await h.customer(key);assert.equal(replay.status,200);assert.equal((await replay.json()).orderId,saved.orderId);
   assert.equal((await h.mf.dispatchFetch('https://local.invalid'+saved.receiptUrl)).status,200);
   const state=await h.request(`/internal/luggage-orders/${saved.orderId}/corrections`);assert.equal(state.status,200);const value=await state.json();assert.equal(value.order.status,'PAYMENT_PENDING');assert.equal(value.billing.recorded_amount,0);
   assert.equal((await h.all('SELECT count(*) n FROM luggage_intake_requests'))[0].n,1);
   assert.equal((await h.all('SELECT count(*) n FROM luggage_staff_corrections'))[0].n,2);
  });
 }finally{await h.close();}
});

test('fresh combined schema and staged upgrade expose equivalent staff/customer SQL contracts',async()=>{
 const upgraded=await fixture(),fresh=await fixture(sql(plan.freshStaffSchema));try{
  for(const file of [...plan.staffStage,...plan.customerStage])await upgraded.migrate(file);
  for(const file of plan.customerStage)await fresh.migrate(file);
  const left=await upgraded.definitions(),right=await fresh.definitions();assert.deepEqual(left.map(r=>[r.type,r.name]),right.map(r=>[r.type,r.name]));
  // Do not request protected SQLite/D1 internal table metadata. The application
  // contract is the set of tables actually declared by these reviewed SQL files.
  const applicationTables=new Set(splitSql([sql(plan.freshStaffSchema),...plan.customerStage.map(sql)].join('\n')).map(s=>/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(s)?.[1]).filter(Boolean));
  for(const row of left){const match=right.find(r=>r.type===row.type&&r.name===row.name);if(['view','trigger','index'].includes(row.type))assertSameSql(row.name,row.sql,match.sql);else if(row.type==='table'&&applicationTables.has(row.name)){
    assert.deepEqual(await upgraded.all(`PRAGMA table_info(${row.name})`),await fresh.all(`PRAGMA table_info(${row.name})`));
    assert.deepEqual(await upgraded.all(`PRAGMA foreign_key_list(${row.name})`),await fresh.all(`PRAGMA foreign_key_list(${row.name})`));
  }}
  await assert.rejects(fresh.migrate(plan.staffStage[0]),/duplicate column|already exists/);
 }finally{await upgraded.close();await fresh.close();}
});
