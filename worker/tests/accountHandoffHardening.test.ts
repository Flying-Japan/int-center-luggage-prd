// Resolved only by the explicit cross-checkout runner, never a production import.
import { buildLuggageCustomerContextCookieValue, buildLuggageCustomerContextHeaders } from 'account-handoff-signer';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readIntakeIdentity, intakeSubject } from '../src/customer/accountContext';
import { customerFixture, syntheticDraft } from './helpers/customerFixture';
import { confirmAnonymousDraft, toRenewalIntakeForm, beginIntakeAuth, resumeIntakeAuth } from '../src/customer/intakeDraft';
const secret='synthetic-cross-checkout-key-no-production-credentials';
const origin='https://luggage.test';
const context=(personId:string,provider='google')=>({personId,provider,email:'same@example.invalid',displayName:personId,phone:''});
const cookie=async(personId:string,provider='google')=>'fj_account_context='+await buildLuggageCustomerContextCookieValue(secret,context(personId,provider));
for(const provider of ['google','kakao']) test(`Account fixed-commit actual ${provider} signer matches Luggage receiver, subject and expiry`,async()=>{
  const input=context('SYNTHETIC-A',provider);const headers=new Headers(await buildLuggageCustomerContextHeaders(secret,input));
  const signed=await readIntakeIdentity(headers,secret);assert.equal(signed.kind,'verified');if(signed.kind!=='verified')throw Error();
  assert.equal(signed.customer.personId,'SYNTHETIC-A');assert.equal(signed.customer.provider,provider);
  assert.equal(signed.customer.expiresAt-signed.customer.issuedAt,300000);
  const byCookie=await readIntakeIdentity(new Headers({cookie:await cookie('SYNTHETIC-A',provider)}),secret);assert.equal(byCookie.kind,'verified');
  assert.equal((await readIntakeIdentity(headers,secret,signed.customer.expiresAt)).kind,'invalid');
  const forged=new Headers(headers);forged.set('x-flying-account-person-id','SYNTHETIC-B');
  assert.equal((await readIntakeIdentity(forged,secret)).kind,'invalid');
});
test('actual Account same-email A/B subjects cannot reattribute an A draft and missing cookie cannot downgrade it',async t=>{
  const c=customerFixture();t.after(()=>c.sqlite.close());c.env.ACCOUNT_CONTEXT_SECRET=secret;
  const aCookie=await cookie('SYNTHETIC-A'),bCookie=await cookie('SYNTHETIC-B');
  const a=await(await c.app.request(origin+'/customer/renewal/account',{headers:{cookie:aCookie}},c.env)).json();
  const b=await(await c.app.request(origin+'/customer/renewal/account',{headers:{cookie:bCookie}},c.env)).json();
  assert.notEqual(a.subject,b.subject);assert.equal(a.profile.email,b.profile.email);
  assert.equal(a.subject,await intakeSubject('SYNTHETIC-A',secret));
  const draft=confirmAnonymousDraft(syntheticDraft(),a.subject,'google',true);
  const post=(signedCookie:string)=>c.app.request(origin+'/customer/submit',{method:'POST',headers:{origin,...(signedCookie?{cookie:signedCookie}:{})},body:toRenewalIntakeForm(draft,'existing-storage-notice-v1')},c.env);
  assert.equal((await post(bCookie)).status,409);assert.equal((await post('')).status,401);assert.equal(c.objects.size,0);
  assert.equal((await post(aCookie)).status,200);
  assert.equal(c.sqlite.prepare('SELECT account_person_id FROM luggage_orders').get()!.account_person_id,'SYNTHETIC-A');
});
test('an Account handoff plus a local nonce hint does not automatically adopt anonymous photos',async()=>{
  const draft=syntheticDraft(),handoff=beginIntakeAuth(draft,'google');
  const a=await readIntakeIdentity(new Headers({cookie:await cookie('SYNTHETIC-A')}),secret);assert.equal(a.kind,'verified');if(a.kind!=='verified')throw Error();
  const subject=await intakeSubject(a.customer.personId,secret);
  const returned=resumeIntakeAuth(draft,handoff,'success',{name:a.customer.name,email:a.customer.email,phone:a.customer.phone},subject);
  assert.equal(returned.requiresConfirmation,true);assert.equal(returned.draft.boundary.mode,'guest');
  const confirmed=confirmAnonymousDraft(returned.draft,subject,'google',true);assert.equal(confirmed.boundary.mode,'member');
  assert.equal(confirmed.photos.identity,draft.photos.identity);assert.equal(confirmed.expiresAt,draft.expiresAt);
});
