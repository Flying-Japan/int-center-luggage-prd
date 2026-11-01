import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { customerFixture, syntheticDraft } from './helpers/customerFixture';
import { syntheticPng } from './helpers/syntheticPhoto';
import { toRenewalIntakeForm, confirmAnonymousDraft, mergeMemberContact, draftBoundaryDecision } from '../src/customer/intakeDraft';
import { normalizedPhotoMime, inspectPhotoContent } from '../src/lib/imageContent';
import { downloadImage } from '../src/lib/r2';
import { securityHeaders } from '../src/middleware/security';
import staffOrders from '../src/routes/staffOrders';

const origin='https://luggage.test', secret='synthetic-hardening-test-secret';
async function member(c: ReturnType<typeof customerFixture>, person: string) {
  c.env.ACCOUNT_CONTEXT_SECRET=secret;
  const payload={timestamp:new Date(Date.now()).toISOString(),person_id:person,email:'same@example.invalid',provider:'google',display_name:person,phone:'',locale:'en'};
  const message=[payload.timestamp,person,payload.email,payload.provider,payload.display_name,payload.phone,payload.locale].join('\n');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message))).toString('base64url');
  const cookie='fj_account_context='+Buffer.from(JSON.stringify({...payload,signature})).toString('base64url');
  const account=await c.app.request(origin+'/customer/renewal/account',{headers:{cookie}},c.env);
  return {cookie,...await account.json()};
}
const post=(c: ReturnType<typeof customerFixture>,draft=syntheticDraft(),cookie='')=>c.app.request(origin+'/customer/submit',
  {method:'POST',headers:{origin,...(cookie?{cookie}:{})},body:toRenewalIntakeForm(draft,'existing-storage-notice-v1')},c.env);

test('P1 account A draft cannot merge into or submit as verified B even with identical emails',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const a=await member(c,'SYNTHETIC-A'),b=await member(c,'SYNTHETIC-B');
  assert.notEqual(a.subject,b.subject);assert.equal(a.profile.email,b.profile.email);
  const draft=confirmAnonymousDraft(syntheticDraft(),a.subject,'google',true);
  assert.equal(draftBoundaryDecision(draft,b.subject),'different-member');
  assert.throws(()=>mergeMemberContact(draft,b.profile,b.subject),/BOUNDARY_CHANGED/);
  assert.throws(()=>confirmAnonymousDraft(draft,b.subject,'google',true),/BOUNDARY_CHANGED/);
  const response=await post(c,draft,b.cookie);assert.equal(response.status,409);assert.equal((await response.json()).error,'ACCOUNT_BOUNDARY_CHANGED');
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,0);assert.equal(c.objects.size,0);
});
test('P1 missing member cookie never silently downgrades a verified member draft to guest',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const a=await member(c,'SYNTHETIC-A');
  const draft=confirmAnonymousDraft(syntheticDraft(),a.subject,'google',true);
  draft.path='guest'; // Even a stale path selector cannot change the stored boundary.
  assert.equal(toRenewalIntakeForm(draft,'existing-storage-notice-v1').get('intake_mode'),'member');
  const response=await post(c,draft);assert.equal(response.status,401);assert.equal((await response.json()).error,'MEMBER_REAUTHENTICATION_REQUIRED');
  assert.equal(draftBoundaryDecision(draft,null),'reauthenticate');assert.equal(c.objects.size,0);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,0);
});
test('anonymous to member adoption requires explicit ownership confirmation; explicit guest stays anonymous with a valid other-account cookie',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const b=await member(c,'SYNTHETIC-B');const draft=syntheticDraft();
  assert.throws(()=>confirmAnonymousDraft(draft,b.subject,'google',false),/CONFIRMATION_REQUIRED/);
  draft.path='google';assert.throws(()=>toRenewalIntakeForm(draft,'existing-storage-notice-v1'),/CONFIRMATION_REQUIRED/);
  draft.path='guest';assert.equal((await post(c,draft,b.cookie)).status,200);
  assert.equal(c.sqlite.prepare('SELECT account_person_id FROM luggage_orders').get()!.account_person_id,null);
});
test('P1 deterministic overnight-tag race atomically releases the losing claim; same key retries and cleans only failed-attempt photos',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const first=syntheticDraft(),second=syntheticDraft();
  const batch=c.env.DB.batch.bind(c.env.DB);let injected=false;
  c.env.DB.batch=async(statements:unknown[])=>{if(!injected){injected=true;assert.equal((await post(c,second)).status,200);}return batch(statements);};
  const lost=await post(c,first);assert.equal(lost.status,409);assert.equal((await lost.json()).error,'INTAKE_TAG_RETRY');
  assert.equal(c.sqlite.prepare("SELECT count(*) n FROM luggage_intake_requests WHERE state='FAILED'").get()!.n,1);
  assert.equal(c.objects.size,2,'only winner photos remain');c.env.DB.batch=batch;
  assert.equal((await post(c,first)).status,200);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,2);
  assert.equal(c.sqlite.prepare("SELECT count(*) n FROM luggage_intake_requests WHERE state='PROCESSING'").get()!.n,0);
  assert.equal(c.sqlite.prepare('SELECT count(DISTINCT tag_no) n FROM luggage_orders').get()!.n,2);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_intake_uploads WHERE deleted_at IS NOT NULL').get()!.n,2);
  assert.equal(c.objects.size,4);
});
test('uncertain batch outcome remains PROCESSING and retains tracked photos; it is never reclaimed by time',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const draft=syntheticDraft();
  c.env.DB.batch=async()=>{throw Error('SYNTHETIC_UNKNOWN_DATABASE_OUTCOME');};
  assert.equal((await post(c,draft)).status,503);assert.equal((await post(c,draft)).status,409);
  assert.equal(c.sqlite.prepare('SELECT state FROM luggage_intake_requests').get()!.state,'PROCESSING');
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_intake_uploads WHERE deleted_at IS NULL').get()!.n,2);assert.equal(c.objects.size,2);
});
test('lost response after a known zero-insert tag collision is safely retried and superseded orphan keys are reconciled',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const first=syntheticDraft(),second=syntheticDraft();
  const batch=c.env.DB.batch.bind(c.env.DB);let injected=false;
  c.env.DB.batch=async(statements:unknown[])=>{if(!injected){injected=true;assert.equal((await post(c,second)).status,200);await batch(statements);throw Error('SYNTHETIC_LOST_RESPONSE');}return batch(statements);};
  assert.equal((await post(c,first)).status,503);assert.equal(c.objects.size,4);c.env.DB.batch=batch;
  assert.equal((await post(c,first)).status,200);assert.equal(c.objects.size,4);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,2);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_intake_uploads WHERE deleted_at IS NOT NULL').get()!.n,2);
});
test('P2 expired receipt cannot revive after order phone/status/timestamp changes or a new Account handoff',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const a=await member(c,'SYNTHETIC-A');
  const draft=confirmAnonymousDraft(syntheticDraft(),a.subject,'google',true);const saved=await(await post(c,draft,a.cookie)).json();
  const issued=c.sqlite.prepare('SELECT receipt_issued_at FROM luggage_intake_requests').get()!.receipt_issued_at;
  const future=Date.now()+360000;t.mock.method(Date,'now',()=>future);
  assert.equal((await c.app.request(origin+saved.receiptUrl,{},c.env)).status,403);
  c.sqlite.prepare("UPDATE luggage_orders SET phone='000-9999-9999',status='PAID',updated_at=?").run(new Date(future).toISOString());
  const refreshed=await member(c,'SYNTHETIC-A');assert.ok(refreshed.expiresAt>future);
  assert.equal((await c.app.request(origin+saved.receiptUrl,{headers:{cookie:refreshed.cookie}},c.env)).status,403);
  assert.equal(c.sqlite.prepare('SELECT receipt_issued_at FROM luggage_intake_requests').get()!.receipt_issued_at,issued);
  assert.throws(()=>c.sqlite.prepare('UPDATE luggage_intake_requests SET receipt_issued_at=?').run(future),/immutable/);
});
test('P1 MIME essence is normalized and active/mislabeled/truncated content never reaches R2 or a new order',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());
  const inert='<svg xmlns="http://www.w3.org/2000/svg"><text>INERT TEST ONLY</text></svg>';
  for(const type of ['image/svg+xml; charset=utf-8','IMAGE/SVG+XML ;charset=utf-8','image/jpeg','image/png']){
    const draft=syntheticDraft();draft.photos.identity!.blob=new Blob([inert],{type});
    assert.equal((await post(c,draft)).status,400);
  }
  const prefixed=syntheticDraft();prefixed.photos.identity!.blob=new Blob([new Uint8Array([137,80,78,71,13,10,26,10]),inert],{type:'image/png'});
  assert.equal((await post(c,prefixed)).status,400);assert.equal(c.objects.size,0);
  assert.equal(normalizedPhotoMime(' IMAGE/PNG; charset=utf-8 '),'image/png');
  const valid=syntheticDraft();valid.photos.identity!.blob=new Blob([syntheticPng()],{type:'image/png; charset=utf-8'});
  assert.equal((await post(c,valid)).status,200);assert.ok([...c.objects.values()].every(v=>v.contentType==='image/png'));
  const corrupt=syntheticPng();corrupt[corrupt.length-1]^=1;assert.equal(inspectPhotoContent(corrupt.buffer,'image/png'),null);
});
test('P1 legacy staff photo routes reject stored SVG/masquerading bytes and serve valid raster under nosniff+sandbox policy',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const saved=await(await post(c)).json();
  const order=c.sqlite.prepare('SELECT * FROM luggage_orders').get()!;
  const app=new Hono();app.use('*',securityHeaders);app.use('*',async(context,next)=>{context.set('staff',{id:'synthetic-staff',role:'admin'});await next();});app.route('/',staffOrders);
  const path=origin+`/staff/orders/${saved.orderId}/id-image`;
  const valid=await app.request(path,{},c.env);assert.equal(valid.status,200);assert.equal(valid.headers.get('content-type'),'image/png');
  assert.equal(valid.headers.get('x-content-type-options'),'nosniff');assert.match(valid.headers.get('content-security-policy')!,/sandbox/);assert.doesNotMatch(valid.headers.get('content-security-policy')!,/unsafe-inline/);
  assert.deepEqual(new Uint8Array(await valid.arrayBuffer()),syntheticPng('SYNTHETIC-ID'));
  c.objects.set(order.id_image_url as string,{body:new TextEncoder().encode('<svg>INERT</svg>').buffer,contentType:'image/svg+xml; charset=utf-8'});
  assert.equal(await downloadImage(c.env.IMAGES,order.id_image_url as string),null);
  assert.equal((await app.request(path,{},c.env)).status,404);
  c.objects.set(order.id_image_url as string,{body:new TextEncoder().encode('<html>INERT</html>').buffer,contentType:'image/png'});
  assert.equal((await app.request(path,{},c.env)).status,404);
});
test('member intent cannot enter the legacy anonymous path by losing its request key',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const a=await member(c,'SYNTHETIC-A');
  const form=toRenewalIntakeForm(confirmAnonymousDraft(syntheticDraft(),a.subject,'google',true),'existing-storage-notice-v1');form.delete('intake_request_key');
  const response=await c.app.request(origin+'/customer/submit',{method:'POST',headers:{origin},body:form},c.env);
  assert.equal(response.status,400);assert.equal((await response.json()).error,'INTAKE_REQUEST_KEY_REQUIRED');assert.equal(c.objects.size,0);
});
test('known pre-order counter response loss releases the claim without guessing an order commit',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const draft=syntheticDraft(),prepare=c.env.DB.prepare.bind(c.env.DB);let failed=false;
  c.env.DB.prepare=(sql:string)=>{
    const real=prepare(sql);
    if(!failed&&sql.includes('INSERT INTO luggage_daily_counters')){
      failed=true;return {bind(...args:unknown[]){real.bind(...args);return this;},async first(){await real.first();throw Error('SYNTHETIC_COUNTER_RESPONSE_LOST');}};
    }return real;
  };
  const first=await post(c,draft);assert.equal(first.status,503);assert.equal((await first.json()).error,'INTAKE_PRECOMMIT_RETRY');
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,0);assert.equal(c.objects.size,0);
  assert.equal(c.sqlite.prepare('SELECT state FROM luggage_intake_requests').get()!.state,'FAILED');
  c.env.DB.prepare=prepare;assert.equal((await post(c,draft)).status,200);assert.equal(c.objects.size,2);
  assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,1);
});
test('legacy upload validates both files before storing either personal photo',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const draft=syntheticDraft();
  const form=toRenewalIntakeForm(draft,'existing-storage-notice-v1');
  form.delete('intake_request_key');form.delete('intake_mode');form.set('luggage_image',new Blob(['<svg>INERT</svg>'],{type:'image/svg+xml; charset=utf-8'}),'test.svg');
  const response=await c.app.request(origin+'/customer/submit',{method:'POST',body:form},c.env);
  assert.equal(response.status,302);assert.equal(c.objects.size,0);assert.equal(c.sqlite.prepare('SELECT count(*) n FROM luggage_orders').get()!.n,0);
});
test('private renewal form and bearer receipt are excluded from global third-party analytics injection',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());const secure=new Hono();secure.use('*',securityHeaders);secure.route('/',c.app);
  const saved=await(await post(c)).json();
  for(const path of ['/customer/renewal',saved.receiptUrl]){
    const response=await secure.request(origin+path,{},c.env);assert.equal(response.status,200);
    assert.doesNotMatch(await response.text(),/googletagmanager|google-analytics|clarity\.ms/);
  }
});
