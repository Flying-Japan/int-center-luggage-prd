import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptDraft, decryptDraft, createBrowserDraftStore, assertDraftLifetime } from '../client/intakeDraftStore.mjs';

test('encrypted snapshots restore actual photo bytes, names and metadata without plaintext contact/ID data', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const draft = { version: 2, boundary: {mode:'guest'}, id: crypto.randomUUID(), contact: { name: 'Sample', phone: '000-1234-5678' },
    photos: { identity: { blob: new Blob(['SYNTHETIC-ID'], { type: 'image/png' }), name: 'id.png', lastModified: 123 },
      luggage: { blob: new Blob(['SYNTHETIC-BAGS'], { type: 'image/jpeg' }), name: 'bags.jpg', lastModified: 456 } } };
  const record = await encryptDraft(draft, key);
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'iv']);
  assert.equal(new TextDecoder().decode(record.ciphertext).includes('SYNTHETIC-ID'), false);
  const restored = await decryptDraft(structuredClone(record), draft.id, key);
  assert.equal(await restored.photos.identity.blob.text(), 'SYNTHETIC-ID');
  assert.equal(await restored.photos.luggage.blob.text(), 'SYNTHETIC-BAGS');
  assert.equal(restored.photos.identity.blob.type, 'image/png');
  assert.equal(restored.photos.identity.lastModified, 123);
  assert.equal(restored.photos.luggage.name, 'bags.jpg');
  assert.deepEqual(restored.contact, draft.contact);
  await assert.rejects(decryptDraft(record, 'different-draft', key));
  await assert.rejects(decryptDraft(record, draft.id, crypto.getRandomValues(new Uint8Array(32))));
  const corrupted = { ...record, ciphertext: new Uint8Array(record.ciphertext).map((b, i) => i === 0 ? b ^ 1 : b) };
  await assert.rejects(decryptDraft(corrupted, draft.id, key));
});

test('storage/key failures reject auth snapshot rather than claim successful preservation', async () => {
  const store = createBrowserDraftStore({ indexedDB: null, sessionStorage: { getItem() { return null; }, setItem() {} } });
  const draft = { id:'synthetic',createdAt:Date.now(),expiresAt:Date.now()+1800000,photos:{identity:null,luggage:null} };
  draft.expiresAt=draft.createdAt+1800000;
  await assert.rejects(store.save(draft), /UNAVAILABLE/);
  const denied = createBrowserDraftStore({ indexedDB: null, sessionStorage: { getItem() { throw new Error('storage denied'); } } });
  await assert.rejects(denied.save(draft), /denied/);
});
test('absolute draft lifetime cannot be extended by an edit or a save after expiry', async () => {
  const draft={createdAt:1000,expiresAt:1801000};
  assert.doesNotThrow(()=>assertDraftLifetime(draft,1800999));
  assert.throws(()=>assertDraftLifetime({...draft,updatedAt:1801000},1801000),/EXPIRED/);
  assert.throws(()=>assertDraftLifetime({...draft,expiresAt:3601000},1801000),/EXPIRED/);
  const store=createBrowserDraftStore({indexedDB:null,now:()=>1801000});
  await assert.rejects(store.save(draft),/EXPIRED/);
});
