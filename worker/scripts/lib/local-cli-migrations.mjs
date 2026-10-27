import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, copyFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sqlTokens, assertSameSql } from './sql-contract.mjs';

/** Rehearse the exact operator CLI and generate equivalent SQL safe for Wrangler 4.73's CASE splitter. */
export async function localCliMigrations(worker,root,rehearsal) {
 const req=createRequire(import.meta.url),deps=createRequire(req.resolve('wrangler/package.json'));
 const {Miniflare,Log,LogLevel}=deps('miniflare');
 const dir=join(root,'cli-migrations');await mkdir(dir,{mode:0o700});
 const state=join(dir,'state'),id='f0000000-0000-4000-8000-000000000001';
 const config=join(dir,'local.toml');
 await writeFile(config,`name = "finance-cli-local-only"\ncompatibility_date = "2025-04-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "finance-cli-local-only"\ndatabase_id = "${id}"\n`);
 const mf=new Miniflare({host:'127.0.0.1',port:0,modules:true,script:'export default {fetch(){return new Response(null,{status:503})}}',d1Databases:{DB:id},d1Persist:join(state,'v3/d1'),log:new Log(LogLevel.ERROR),outboundService:()=>{throw new Error('No external network');}});
 const db=await mf.getD1Database('DB');await db.prepare('SELECT 1').first();await mf.dispose();
 async function files(p){const a=[];for(const e of await readdir(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())a.push(...await files(f));else a.push(f);}return a;}
 const sqlite=(await files(state)).filter(p=>p.endsWith('.sqlite'));assert.equal(sqlite.length,1);const dbPath=sqlite[0];
 for(const suffix of ['-wal','-shm'])try{await unlink(dbPath+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}
 await copyFile(join(rehearsal,'before.sqlite'),dbPath);
 const home=join(dir,'home'),temp=join(dir,'tmp');await mkdir(home);await mkdir(temp);
 // Permit local workerd transport only; deny all non-loopback network at the OS level.
 const policy=join(dir,'loopback-only.sb');await writeFile(policy,'(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*") (remote unix-socket))\n');
 const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:join(home,'config'),XDG_CACHE_HOME:join(home,'cache'),TMPDIR:temp,CI:'true',NO_COLOR:'1',WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CLOUDFLARE_INCLUDE_PROCESS_ENV:'false',WRANGLER_LOG_PATH:join(dir,'wrangler.log')};
 function schema(){const c=new DatabaseSync(dbPath,{readOnly:true});try{return c.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();}finally{c.close();}}
 const report={dir,dbPath,networkPolicy:await readFile(policy,'utf8'),files:[],rollbackChecks:[],passed:false};
 for(const [i,name] of ['20261025_extension_receipts.sql','20261026_root_settlement_review.sql'].entries()){
  const original=await readFile(join(worker,'migrations',name),'utf8');let formatted=original;
  // Insert spaces after END tokens before punctuation; never edit strings, identifiers or conditions.
  for(const t of sqlTokens(original).filter(t=>t.word==='END'&&/[,)]/.test(original[t.end]||'')).reverse())formatted=formatted.slice(0,t.end)+' '+formatted.slice(t.end);
  assertSameSql(name+' CLI formatting',formatted,original);
  const path=join(dir,`${i+1}-${name}`);await writeFile(path,formatted);
  function execute(file,label){
   const args=[process.execPath,join(dirname(req.resolve('wrangler/package.json')),'bin/wrangler.js'),'d1','execute','finance-cli-local-only','--local','--persist-to',state,'--config',config,'--file',file,'--yes'];
   assert.ok(args.includes('--local')&&!args.includes('--remote'));
   const result=spawnSync('/usr/bin/sandbox-exec',['-f',policy,...args],{cwd:worker,env,encoding:'utf8',maxBuffer:8*1024*1024});
   // No command ever targets an operational DB, credential, Worker, or remote endpoint.
   return writeFile(join(dir,label+'.log'),(result.stdout||'')+(result.stderr||''),{mode:0o600}).then(()=>result.status);
  }
  const bad=join(dir,`rollback-${i+1}.sql`);await writeFile(bad,formatted+'\nSELECT * FROM __finance_rehearsal_missing_table;\n');
  const before=schema();assert.notEqual(await execute(bad,`rollback-${i+1}`),0);assert.deepEqual(schema(),before,'Failed migration must roll back all DDL');report.rollbackChecks.push({migration:name,schemaRolledBack:true});
  assert.equal(await execute(path,`apply-${i+1}`),0,`Local Wrangler migration ${name} failed; never retry remotely`);
  report.files.push({name,path,sourceSha256:createHash('sha256').update(original).digest('hex'),sha256:createHash('sha256').update(formatted).digest('hex'),tokenEquivalent:true});
 }
 const c=new DatabaseSync(dbPath,{readOnly:true});try{report.balances=c.prepare('SELECT SUM(root_review_required) AS reviews,SUM(root_review_amount) AS amount FROM luggage_billing_balances').get();assert.equal(report.balances.reviews,366);assert.equal(report.balances.amount,348839);}finally{c.close();}
 report.passed=true;await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
}
