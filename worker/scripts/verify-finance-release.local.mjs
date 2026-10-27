import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, mkdtemp, realpath, copyFile, unlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { localCliMigrations } from './lib/local-cli-migrations.mjs';
import { offlinePackage } from './lib/offline-package.mjs';
import { assertSameSql, checkSqlComparisonContract } from './lib/sql-contract.mjs';
import { discoverRoutes, concretePath } from '../tests/helpers/m0.mjs';

assert.equal(process.argv[2], '--run-local');
assert.equal(process.argv[3], '--rehearsal');
assert.equal(process.argv.length, 5);
const rehearsal = await realpath(process.argv[4]);
assert.match(rehearsal, /\/flying-finance-rehearsal-[A-Za-z0-9_-]+$/);
const held = JSON.parse(await readFile(join(rehearsal, 'report.json'), 'utf8'));
assert.equal(held.passed, true);
assert.equal(await realpath(held.root), rehearsal);
const worker = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: worker, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const base = 'aba7288c3fc597f7b4ea45bf33a74a43278b8de2';
assert.equal(git('rev-parse','HEAD').trim(), base);
const baselineConfig = git('show', `${base}:worker/wrangler.toml`);
const f1Config = baselineConfig.replace('workers_dev = true\n', 'workers_dev = true\npreview_urls = false\n');
assert.equal(await readFile(join(worker,'wrangler.f1.toml'),'utf8'), f1Config);
assert.equal(await readFile(join(worker,'wrangler.toml'),'utf8'), f1Config.replace('main = "src/index.tsx"', 'main = "src/index.f0.ts"'));
assert.deepEqual((await readdir(join(worker,'migrations'))).sort(), ['20261025_extension_receipts.sql','20261026_root_settlement_review.sql']);
for (const p of ['src/lib/internalActorStaff.ts','src/lib/staffProfiles.ts','src/types.ts']) assert.equal(await readFile(join(worker,p),'utf8'),git('show',`${base}:worker/${p}`),p);
const root = await mkdtemp(join(tmpdir(), 'flying-finance-release-'));await chmod(root,0o700);
const report = {root,base,heldSource:held.source,heldSourceSha256:held.source_sha256,packages:{},checks:[],passed:false};
const sha = x=>createHash('sha256').update(x).digest('hex');
const require=createRequire(import.meta.url),deps=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,Log,LogLevel}=deps('miniflare'),{build}=deps('esbuild');
for(const [phase,config] of [['F0','wrangler.toml'],['F1','wrangler.f1.toml']]) {
  const output=join(root,phase);await mkdir(output,{mode:0o700});report.packages[phase]=await offlinePackage(worker,config,output);
}
// Reconstruct the exact production revision without changing any checkout.
const legacy=join(root,'legacy.mjs');
const oldSourceHashes={};
await build({entryPoints:[join(worker,'src/index.tsx')],outfile:legacy,bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*'],logLevel:'silent',plugins:[{name:'production-git-sources',setup(b){b.onLoad({filter:/\.(ts|tsx)$/},args=>{
 const rel=relative(worker,args.path);if(!rel.startsWith('src/'))return;
 const contents=git('show',`${base}:worker/${rel}`);oldSourceHashes[rel]=sha(contents);
 return {contents,loader:rel.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(args.path)};
});}}]});
report.legacy={artifact:legacy,sha256:sha(await readFile(legacy)),sources:oldSourceHashes,build:'esbuild of git-show source, not downloaded production bytecode'};
const secret='finance-local-only-secret',editor='11111111-1111-4111-8111-111111111111';
const profile={id:editor,email:'synthetic@example.invalid',display_name:'Synthetic Editor',username:'synthetic',role:'editor',is_active:true,created_at:'2026-01-01T00:00:00Z'};
let profileReads=0,forbiddenOutbound=0;
const outboundService=async request=>{
 const url=new URL(request.url);
 if(request.method==='GET'&&url.origin==='https://profiles.invalid'&&url.pathname==='/rest/v1/user_profiles'){
  profileReads++;return Response.json((request.headers.get('accept')||'').includes('object')?profile:[profile]);
 }
 forbiddenOutbound++;throw new Error('Unexpected outbound call');
};
const bindings={INTERNAL_API_SECRET:secret,APP_SECRET_KEY:secret,APP_ENV:'test',SUPABASE_URL:'https://profiles.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key'};
const modules={modules:true,modulesRules:[{type:'ESModule',include:['**/*.js','**/*.mjs']}],modulesRoot:root,compatibilityDate:'2025-04-01',compatibilityFlags:['nodejs_compat'],outboundService,bindings};
let mf;
const check=(name,details={})=>{report.checks.push({name,...details});console.log('PASS',name);};
async function files(path){const out=[];for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())out.push(...await files(p));else out.push(p);}return out;}
function options(state,persist=true){return {host:'127.0.0.1',port:0,log:new Log(LogLevel.ERROR),workers:[
 {...modules,name:'F0',scriptPath:report.packages.F0.artifact,d1Databases:{DB:'finance-release-local-only'}},
 {...modules,name:'F1',scriptPath:report.packages.F1.artifact,d1Databases:{DB:'finance-release-local-only'}},
 {...modules,name:'OLD',scriptPath:legacy,d1Databases:{DB:'finance-release-local-only'}},
 ],d1Persist:persist?state:false};}
async function request(phase,path,method='GET',payload,auth=true){
 const url='https://local.invalid'+path,body=payload instanceof URLSearchParams?payload.toString():payload===undefined?undefined:JSON.stringify(payload),headers={'Content-Type':payload instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json'};
 if(auth){const timestamp=String(Math.floor(Date.now()/1000));headers['x-internal-timestamp']=timestamp;headers['x-internal-signature']=createHmac('sha256',secret).update([method,new URL(url).pathname+new URL(url).search,timestamp,sha(body||'')].join('\n')).digest('hex');
 const session=Buffer.from(JSON.stringify({user_id:editor,exp:Date.now()+3600000})).toString('base64');headers.Cookie='luggage_session='+session+'.'+createHmac('sha256',secret).update(session).digest('hex');}
 return (await mf.getWorker(phase)).fetch(url,{method,headers,body,redirect:'manual'});
}
async function expect(phase,path,status,method='GET',payload,auth=true){const response=await request(phase,path,method,payload,auth);assert.equal(response.status,status,`${phase} ${method} ${path}: ${response.status}`);return response;}
const fresh = new DatabaseSync(':memory:');fresh.exec(await readFile(join(worker,'src/schema.sql'),'utf8'));
try {
 checkSqlComparisonContract();
 const state=join(root,'replica-d1');await mkdir(state,{mode:0o700});mf=new Miniflare(options(state));
 let db=await mf.getD1Database('DB','F0');await db.prepare('SELECT 1').first();await mf.dispose();mf=null;
 const paths=(await files(state)).filter(p=>p.endsWith('.sqlite'));assert.equal(paths.length,1);const d1Path=paths[0];
 for(const suffix of ['-wal','-shm'])try{await unlink(d1Path+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
 await copyFile(join(rehearsal,'before.sqlite'),d1Path);await chmod(d1Path,0o600);
 mf=new Miniflare(options(state));db=await mf.getD1Database('DB','F0');
 await expect('OLD','/internal/luggage-orders?limit=75',200);check('old Worker/old DB baseline read');
 await expect('F0','/internal/luggage-orders?limit=1',500);await expect('F1','/internal/luggage-orders?limit=1',500);check('new Workers on old schema fail closed; migrations required before F0/F1');
 const migrations=JSON.parse(await readFile(join(rehearsal,'migration-batches.json'),'utf8'));
 for(const migration of migrations){assert.equal(sha(await readFile(join(worker,'migrations',migration.name))),migration.sha256);await db.batch(migration.statements.map(sql=>db.prepare(sql)));check('actual D1 transaction migration '+migration.name,{statements:migration.statements.length});}
 const names=[...new Set(migrations.flatMap(m=>m.statements.flatMap(sql=>[...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:VIEW|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)].map(m=>m[1]))))];
 for(const name of names){const actual=await db.prepare('SELECT sql FROM sqlite_master WHERE name=?').bind(name).first();const expected=fresh.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name);assert.ok(actual&&expected,name);assertSameSql(name,actual.sql,expected.sql);}
 check('actual D1 financial schema matches fresh schema',{objects:names.length});
 const balance=await db.prepare('SELECT COUNT(*) AS roots,SUM(root_review_required) AS reviews,SUM(root_review_amount) AS review_amount,SUM(outstanding_amount) AS outstanding FROM luggage_billing_balances').first();
 assert.equal(balance.reviews,366);assert.equal(balance.review_amount,348839);report.replicaBalance=balance;report.reviewByStatus=(await db.prepare('SELECT o.status,COUNT(*) AS n,SUM(b.root_review_amount) AS amount FROM luggage_billing_balances b JOIN luggage_orders o ON o.order_id=b.root_id WHERE b.root_review_required=1 GROUP BY o.status').all()).results;check('366 reviews and JPY 348839 preserved');
 for(const phase of ['F0','F1','OLD']){
  for(const n of phase==='OLD'?[75]:[100,101,500,501]){const response=await expect(phase,`/internal/luggage-orders?limit=${n}`,200);const data=await response.json();assert.equal(data.orders.length,Math.min(n,500));check(`${phase} migrated replica list ${n}`,{rows:data.orders.length,total:data.total});}
 }
 for(const path of ['/internal/luggage-orders/dashboard-sync','/internal/luggage-sales-analytics?dateFrom=2026-10-01&dateTo=2026-10-28','/internal/luggage-sales-heatmap','/internal/luggage-cash-closings']){
  const a=await (await expect('F0',path,200)).json(),b=await (await expect('F1',path,200)).json();assert.deepEqual(a,b);check('F0/F1 identical signed read '+path.split('?')[0]);
 }
 await expect('F0','/internal/luggage-orders',401,'GET',undefined,false);check('F0 authentication retained');
 for(const phase of ['F0']){
  for(const route of discoverRoutes(worker).filter(r=>r.method!=='GET'))await expect(phase,concretePath(route.path),503,route.method);
  for(const path of ['/staff/orders/20261025-001','/staff/orders/20261025-001/id-image','/staff/auth/callback','/customer'])await expect(phase,path,503);
  for(const cron of ['0 15 * * *','0 18 * * *'])assert.equal((await (await mf.getWorker(phase)).scheduled({cron})).outcome,'ok');
 }
 check('F0 all mutation routes, unsafe GET and both cron blocked on actual artifact');
 await mf.dispose();mf=null;
 // Independently fingerprint every original column of every original table; no row data is emitted.
 const auditCode=`import sqlite3,json,hashlib,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro&immutable=1',uri=True)\ne=json.load(open(sys.argv[2]))['source_tables']\nfor table,expected in e.items():\n cols=','.join('"'+s.replace('"','""')+'"' for s in expected['columns']);d=hashlib.sha256();n=0\n for row in c.execute('SELECT '+cols+' FROM "'+table+'" ORDER BY '+cols):\n  d.update(json.dumps(row,ensure_ascii=False,separators=(',',':'),default=lambda b:{'blob':bytes(b).hex()}).encode());d.update(b'\\n');n+=1\n assert n==expected['rows'] and d.hexdigest()==expected['sha256'],table\nprint('all-original-tables-preserved')`;
 assert.match(execFileSync('python3',['-c',auditCode,d1Path,join(rehearsal,'report.json')],{encoding:'utf8'}),/all-original-tables-preserved/);check('all original replica tables unchanged through migration and HTTP reads');
 // Synthetic-only state for all mutating HTTP and compatibility tests.
 mf=new Miniflare(options(null,false));db=await mf.getD1Database('DB','F0');
 for(const {sql} of fresh.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all())await db.prepare(sql).run();
 const one=(sql,...args)=>db.prepare(sql).bind(...args).first();const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 let seq=0;
 async function seed({amount=1600,received=1600,debt=false,pending=false}={}){
  const id='20261028-'+String(++seq).padStart(3,'0');
  await run(`INSERT INTO luggage_orders(order_id,created_at,expected_pickup_at,expected_storage_days,status,price_per_day,prepaid_amount,final_amount,tag_no)
   VALUES(?,datetime('now'),datetime('now','+1 day'),1,?,1600,?,?,?)`,id,pending?'PAYMENT_PENDING':'PAID',amount,amount,String(seq));
  if(!pending)await run("INSERT INTO luggage_order_payments(order_id,business_date,tender_type,amount,staff_id) VALUES(?,date('now','+9 hours'),'CASH',?,?)",id,received,editor);
  if(debt)await run(`INSERT INTO luggage_orders(order_id,parent_order_id,created_at,expected_pickup_at,expected_storage_days,status,price_per_day,prepaid_amount,final_amount,tag_no,extension_date)
   VALUES(?,?,datetime('now'),datetime('now','+2 days'),1,'PAYMENT_PENDING',1600,1600,1600,?,date('now','+9 hours','+2 days'))`,'EXT-'+id,id,String(seq));
  return id;
 }
 async function pickup(id,action='mark_picked_up',phase='F1'){
  const row=await one('SELECT updated_at FROM luggage_orders WHERE order_id=?',id);
  return request(phase,`/internal/luggage-orders/${id}/pickup-status`,'PATCH',{action,expectedUpdatedAt:row.updated_at,actor:{userId:'synthetic-user',name:'Synthetic',role:'center_staff'}});
 }
 const normal=await seed();assert.equal((await pickup(normal)).status,200);check('F1 actual pickup paid normal');
 assert.equal((await pickup(normal,'undo_picked_up')).status,200);check('F1 actual undo normal');
 const markPaid=await seed({pending:true});
 const paidForm=new URLSearchParams({payment_method:'CASH'});
 const firstPaid=await expect('F1',`/staff/orders/${markPaid}/mark-paid`,302,'POST',paidForm);assert.ok(!firstPaid.headers.get('location').includes('error='));
 const paidSnapshot=async()=>({order:await one('SELECT * FROM luggage_orders WHERE order_id=?',markPaid),payments:(await db.prepare('SELECT * FROM luggage_order_payments WHERE order_id=? ORDER BY payment_id').bind(markPaid).all()).results,audits:(await db.prepare('SELECT * FROM luggage_audit_logs WHERE order_id=? ORDER BY log_id').bind(markPaid).all()).results});
 const paidOnce=await paidSnapshot();assert.equal(paidOnce.order.status,'PAID');assert.equal(paidOnce.payments.length,1);assert.equal(paidOnce.audits.filter(a=>a.action==='MARK_PAID').length,1);
 const repeatedPaid=await expect('F1',`/staff/orders/${markPaid}/mark-paid`,302,'POST',paidForm);assert.ok(repeatedPaid.headers.get('location').includes('error='));assert.deepEqual(await paidSnapshot(),paidOnce);
 check('actual F1 mark-paid records once; repeated PAID submit preserves ledger and audit');
 const refusedPaid=await seed({pending:true});
 await run(`CREATE TRIGGER reject_mark_paid_audit BEFORE INSERT ON luggage_audit_logs WHEN NEW.order_id='${refusedPaid}' AND NEW.action='MARK_PAID' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`);
 await expect('F1',`/staff/orders/${refusedPaid}/mark-paid`,500,'POST',paidForm);
 assert.equal((await one('SELECT status FROM luggage_orders WHERE order_id=?',refusedPaid)).status,'PAYMENT_PENDING');assert.equal((await one('SELECT COUNT(*) AS n FROM luggage_order_payments WHERE order_id=?',refusedPaid)).n,0);assert.equal((await one('SELECT COUNT(*) AS n FROM luggage_audit_logs WHERE order_id=?',refusedPaid)).n,0);
 check('actual F1 mark-paid audit failure rolls back receipt and status');
 const owed=await seed({debt:true});assert.equal((await pickup(owed)).status,409);check('F1 unpaid extension blocks pickup');
 const before=await one('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM luggage_order_payments');
 const requestId=crypto.randomUUID(),receipt={request_id:requestId,confirm_received:'yes',expected_amount:1600,cash_amount:1600,qr_amount:0};
 await expect('F0',`/staff/api/orders/${owed}/confirm-collection`,503,'POST',receipt);
 await expect('F1',`/staff/api/orders/${owed}/confirm-collection`,200,'POST',receipt);
 const after=await one('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM luggage_order_payments');assert.equal(after.amount-before.amount,1600);
 const repeat=await request('F1',`/staff/api/orders/${owed}/confirm-collection`,'POST',receipt);assert.ok([200,409].includes(repeat.status));assert.deepEqual(await one('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM luggage_order_payments'),after);
 check('actual F1 collection and idempotency; F0 cannot collect');
 assert.equal((await pickup(owed)).status,200);const family=(await db.prepare('SELECT status,actual_pickup_at FROM luggage_orders WHERE order_id=? OR parent_order_id=?').bind(owed,owed).all()).results;assert.ok(family.every(x=>x.status==='PICKED_UP'&&x.actual_pickup_at===family[0].actual_pickup_at));
 assert.equal((await pickup(owed,'undo_picked_up')).status,200);check('actual F1 family pickup/undo keeps paid extension');
 const review=await seed({amount:9000,received:8550});assert.equal((await pickup(review)).status,409);check('actual F1 original review blocks pickup without collection');
 const both=await seed({amount:9000,received:8550,debt:true});
 await expect('F1',`/staff/api/orders/${both}/confirm-collection`,200,'POST',{...receipt,request_id:crypto.randomUUID(),cash_amount:0,qr_amount:1600});
 const billed=(await (await expect('F0','/internal/luggage-orders?search='+both,200)).json()).orders[0].billing;
 assert.equal(billed.root_review_amount,450);assert.equal(billed.extension_outstanding_amount,0);assert.equal(billed.outstanding_amount,0);assert.equal((await pickup(both)).status,409);check('QR extension receipt never absorbs original JPY450 review');
 const oldPaid=await seed();assert.equal((await pickup(oldPaid,'mark_picked_up','OLD')).status,200);check('old Worker/new DB normal pickup compatibility only');
 const oldDebt=await seed({debt:true});assert.equal((await pickup(oldDebt,'mark_picked_up','OLD')).status,500);check('old Worker/new DB financial pickup guard preserved');
 const countsBefore=await one('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM luggage_order_payments');
 const oldPayment=await request('OLD',`/staff/api/orders/${oldDebt}/toggle-payment`,'POST');assert.equal(oldPayment.status,500);assert.deepEqual(await one('SELECT COUNT(*) AS n,SUM(amount) AS amount FROM luggage_order_payments'),countsBefore);
 check('old Worker/new DB payment rewrite is incompatible and cannot be a writable rollback',{status:oldPayment.status});
 const legacyReceipt=await seed();await expect('F1',`/staff/api/orders/${legacyReceipt}/toggle-payment`,409,'POST');
 const legacyMoney=await one('SELECT COUNT(*) AS n FROM luggage_order_payments WHERE order_id=?',legacyReceipt);assert.equal(legacyMoney.n,1);
 await expect('OLD',`/staff/api/orders/${legacyReceipt}/toggle-payment`,200,'POST');assert.equal((await one('SELECT COUNT(*) AS n FROM luggage_order_payments WHERE order_id=?',legacyReceipt)).n,0);
 check('negative compatibility: old Worker can erase an unprotected legacy-only receipt; writable rollback forbidden');
 await mf.dispose();mf=null;
 report.cliMigrations=await localCliMigrations(worker,root,rehearsal);
 assert.match(execFileSync('python3',['-c',auditCode,report.cliMigrations.dbPath,join(rehearsal,'report.json')],{encoding:'utf8'}),/all-original-tables-preserved/);check('operator Wrangler local CLI migrations, per-file failure rollback and all original data preservation');
 assert.equal(forbiddenOutbound,0);report.profileReads=profileReads;report.forbiddenOutbound=forbiddenOutbound;report.passed=true;
} catch(error){report.error=String(error);throw error;}
finally{fresh.close();if(mf)await mf.dispose();await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({root,passed:report.passed,checks:report.checks.length}));}
