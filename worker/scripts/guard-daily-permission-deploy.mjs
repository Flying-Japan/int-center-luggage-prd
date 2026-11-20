import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

export function assertClosedHours(now=new Date()) {
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tokyo',hour:'2-digit',hourCycle:'h23'}).format(now));
 assert.ok(hour<9||hour>=21,'Production deploy requires closed business hours (21:00–09:00 JST).');
}
export function bindingSnapshot(bindings) {
 return bindings.filter(b=>b.type!=='assets'&&b.name!=='SENTRY_RELEASE').map(b=>({name:b.name,type:b.type,hash:createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(b).sort(([a],[z])=>a.localeCompare(z))))).digest('hex')})).sort((a,b)=>a.name.localeCompare(b.name));
}
export function assertStaffFlags(bindings) {
 for(const name of ['LUGGAGE_PART_TIME_ACTORS_ENABLED','LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED','LUGGAGE_STAFF_CORRECTIONS_ENABLED','LUGGAGE_FLYING_PASS_REFUNDS_ENABLED']) {
  assert.ok(bindings.some(b=>b.name===name&&b.type==='plain_text'&&b.text==='true'),`${name} must remain readable and enabled.`);
 }
}
export function assertRefundGuard(sql) {
 assert.ok(sql.includes("NOT IN ('center_staff', 'part_time', 'manager', 'super_admin')")&&sql.includes("NEW.terminal_by_staff_id IS NOT 'pt:' ||"),'Staff late-confirm schema migration is required before deploying the Worker.');
 for(const token of ['NEW.root_snapshot IS NOT','NEW.receipt_snapshot IS NOT',"closing_type = 'FINAL_CLOSE'",'NEW.amount IS NOT OLD.amount','$.lateConfirm.reason','luggage_bag_additions ba WHERE ba.order_id=o.order_id'])assert.ok(sql.includes(token),`Financial guard missing: ${token}`);
}
function main(mode) {
 assert.ok(['before','after'].includes(mode));if(mode==='before')assertClosedHours();
 const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD'),git('rev-parse','origin/main'),'Deploy only a pushed main commit.');
 assert.equal(git('status','--porcelain'),'','Deploy only a clean checkout.');
 assert.match(readFileSync('wrangler.f1.toml','utf8'),/^main = "src\/index.tsx"$/m);
 const wrangler=resolve('node_modules/.bin/wrangler');
 const json=(...args)=>JSON.parse(execFileSync(wrangler,[...args,'--json'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024}));
 const current=json('deployments','list','--name','int-center-luggage-api').at(-1);
 assert.equal(current.versions.length,1);assert.equal(current.versions[0].percentage,100);
 const version=json('versions','view',current.versions[0].version_id,'--name','int-center-luggage-api');
 const bindings=version.resources?.bindings??[];assertStaffFlags(bindings);
 const state={version:current.versions[0].version_id,bindings:bindingSnapshot(bindings)};
 const file=join(process.env.RUNNER_TEMP??tmpdir(),'luggage-daily-permission-deploy.json');
 if(mode==='before') {
  const rows=json('d1','execute','center-luggage-db','--config','wrangler.f1.toml','--remote','--command',"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='luggage_refund_transition_guard'");
  assertRefundGuard(rows[0]?.results?.[0]?.sql??'');
  writeFileSync(file,JSON.stringify(state),{mode:0o600});
 } else {
  const before=JSON.parse(readFileSync(file,'utf8'));
  assert.notEqual(state.version,before.version,'Expected the new deployment to be live.');
  assert.deepEqual(state.bindings,before.bindings,'Existing variables, flags and secrets must be preserved.');
 }
 console.log(`PASS ${mode}: closed hours, F1 target, staff flags, ${mode==='before'?'schema prerequisite':'all existing bindings preserved'}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv[2]);
