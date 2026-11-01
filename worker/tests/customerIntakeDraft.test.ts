import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTAKE_STEPS, createIntakeDraft, prepareIntakeAuth, resumeIntakeAuth,
  mergeMemberContact, confirmAnonymousDraft, toLegacyIntakeForm, toRenewalIntakeForm, type IntakeDraft } from '../src/customer/intakeDraft';

function sample(): IntakeDraft {
  const draft = createIntakeDraft('ja', 'privacy-existing-v1');
  draft.contact = { name: 'Sample Guest', phone: '000-1234-5678', email: 'sample@example.invalid' };
  draft.visit = { suitcaseQty: '2', backpackQty: '1', pickupDate: '2026-11-02', pickupTime: '17:30',
    paymentMethod: 'PAY_QR', companionCount: '3' };
  draft.photos = { identity: { blob: new Blob(['synthetic-ID'], { type: 'image/png' }), name: 'id.png', lastModified: 50 },
    luggage: { blob: new Blob(['synthetic-bags'], { type: 'image/jpeg' }), name: 'bags.jpg', lastModified: 60 } };
  draft.privacy.accepted = true;
  return draft;
}

for (const step of INTAKE_STEPS) {
  for (const outcome of ['success', 'failure', 'cancel'] as const) {
    test(`${step}: ${outcome} preserves visit, photos, language, consent and entered contact`, async () => {
      const draft = { ...sample(), step };
      let stored: IntakeDraft | null = null;
      const store = { async save(value: IntakeDraft) { stored = structuredClone(value); }, async load() { return stored; } };
      const handoff = await prepareIntakeAuth(store, draft, 'kakao');
      const restored = await store.load();
      const result = resumeIntakeAuth(restored!, handoff, outcome, { name: 'Member', phone: '', email: undefined }, undefined, 200);
      assert.deepEqual(result.draft.contact, draft.contact);
      assert.deepEqual(result.draft.visit, draft.visit);
      assert.deepEqual(result.draft.privacy, draft.privacy);
      assert.equal(result.draft.locale, 'ja');
      assert.equal(result.draft.step, step);
      assert.equal(await result.draft.photos.identity!.blob.text(), 'synthetic-ID');
      assert.equal(await result.draft.photos.luggage!.blob.text(), 'synthetic-bags');
    });
  }
}

test('Google fills only missing contact; never erases an existing phone or changes visit data', () => {
  const draft = confirmAnonymousDraft(sample(), 'a'.repeat(43), 'google', true); draft.contact.email = '';
  const result = mergeMemberContact(draft, { name: 'Sample Google', phone: '', email: 'google@example.invalid' }, 'a'.repeat(43));
  assert.deepEqual(result.draft.contact, { ...draft.contact, email: 'google@example.invalid' });
  assert.deepEqual(result.conflicts, { name: 'Sample Google' });
  assert.equal(draft.contact.email, '', 'does not mutate the input');
});

test('auth can start with invalid/incomplete current step, but cannot navigate before photo snapshot saves', async () => {
  const draft = sample(); draft.visit.suitcaseQty = 'unfinished';
  await assert.rejects(prepareIntakeAuth({ async save() { throw new Error('quota'); }, async load() { return null; } }, draft, 'google'), /quota/);
  const handoff = await prepareIntakeAuth({ async save() {}, async load() { return draft; } }, draft, 'google');
  assert.equal(handoff.draftId, draft.id);
});

test('wrong/older auth draft is rejected and newer local changes survive return', async () => {
  const draft = sample();
  const handoff = await prepareIntakeAuth({ async save() {}, async load() { return draft; } }, draft, 'google');
  assert.throws(() => resumeIntakeAuth({ ...draft, id: 'other' }, handoff, 'success'), /MISMATCH/);
  assert.throws(() => resumeIntakeAuth(draft, { ...handoff, revision: 3 }, 'cancel'), /STALE/);
  const newer = { ...draft, revision: 2, visit: { ...draft.visit, suitcaseQty: '5' } };
  assert.equal(resumeIntakeAuth(newer, handoff, 'success').draft.visit.suitcaseQty, '5');
});

test('legacy multipart contains original fields and both photo bytes; no authorization, payment status or point claims', async () => {
  const form = toLegacyIntakeForm(sample(), 'privacy-existing-v1');
  assert.deepEqual([...form.keys()].sort(), ['name', 'phone', 'email', 'lang', 'suitcase_qty', 'backpack_qty',
    'expected_pickup_at', 'payment_method', 'companion_count', 'consent_checked', 'id_image', 'luggage_image'].sort());
  assert.equal(form.get('expected_pickup_at'), '2026-11-02T17:30');
  assert.equal(await (form.get('id_image') as File).text(), 'synthetic-ID');
  assert.equal(await (form.get('luggage_image') as File).text(), 'synthetic-bags');
});

test('renewal request key is random, stays with the draft, and is added only by the renewal adapter', () => {
  const draft = sample();
  assert.match(draft.requestKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(draft.requestKey, sample().requestKey);
  assert.equal(toRenewalIntakeForm(draft, 'privacy-existing-v1').get('intake_request_key'), draft.requestKey);
  assert.equal(toLegacyIntakeForm(draft, 'privacy-existing-v1').has('intake_request_key'), false);
});

test('submission still requires both photos, valid JST pickup, nonzero bags, and current privacy consent', () => {
  const draft = sample(); draft.photos.identity = null;
  assert.throws(() => toLegacyIntakeForm(draft, 'privacy-existing-v1'), /id_image/);
  const late = sample(); late.visit.pickupTime = '21:30';
  assert.throws(() => toLegacyIntakeForm(late, 'privacy-existing-v1'), /expected_pickup_at/);
  const rolled = sample(); rolled.visit.pickupDate = '2026-02-30';
  assert.throws(() => toLegacyIntakeForm(rolled, 'privacy-existing-v1'), /expected_pickup_at/);
  assert.throws(() => toLegacyIntakeForm(sample(), 'privacy-new'), /privacy_version/);
  const expired=sample();expired.createdAt=Date.now()-1800001;expired.expiresAt=expired.createdAt+1800000;
  assert.throws(()=>toRenewalIntakeForm(expired,'privacy-existing-v1'),/DRAFT_EXPIRED/);
});
