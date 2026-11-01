// Browser-only adapter. ID photos are encrypted at rest; the encryption key lives
// in this tab's sessionStorage, never in the durable database or a URL.
const DB_NAME = 'fj-luggage-intake-drafts-v1';
const STORE = 'drafts';
const TTL_MS = 30 * 60 * 1000;
const KEY_NAME = 'fj-luggage-intake-tab-key-v1';
const bytesToText = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const textToBytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export function assertDraftLifetime(draft, time) {
  if (!Number.isFinite(draft.createdAt) || draft.expiresAt !== draft.createdAt + TTL_MS || time < draft.createdAt || time >= draft.expiresAt)
    throw new Error('DRAFT_EXPIRED');
}

export async function encryptDraft(draft, rawKey, cryptoApi = crypto) {
  const photos = {};
  for (const field of ['identity', 'luggage']) {
    const photo = draft.photos[field];
    photos[field] = photo ? { name: photo.name, lastModified: photo.lastModified,
      type: photo.blob.type, bytes: bytesToText(new Uint8Array(await photo.blob.arrayBuffer())) } : null;
  }
  const key = await cryptoApi.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode(JSON.stringify({ ...draft, photos }));
  const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: new TextEncoder().encode(draft.id) }, key, payload);
  return { iv, ciphertext };
}

export async function decryptDraft(record, id, rawKey, cryptoApi = crypto) {
  const key = await cryptoApi.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const payload = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: record.iv,
    additionalData: new TextEncoder().encode(id) }, key, record.ciphertext);
  const draft = JSON.parse(new TextDecoder().decode(payload));
  if (draft.version !== 2 || draft.id !== id || !['guest', 'member'].includes(draft.boundary?.mode)
    || (draft.boundary.mode === 'member' && !/^[A-Za-z0-9_-]{43}$/.test(draft.boundary.subject))) throw new Error('INVALID_DRAFT');
  for (const field of ['identity', 'luggage']) {
    const photo = draft.photos[field];
    draft.photos[field] = photo ? { name: photo.name, lastModified: photo.lastModified,
      blob: new Blob([textToBytes(photo.bytes)], { type: photo.type }) } : null;
  }
  return draft;
}

export function createBrowserDraftStore({ indexedDB = globalThis.indexedDB,
  sessionStorage = globalThis.sessionStorage, cryptoApi = globalThis.crypto,
  now = () => Date.now() } = {}) {
  let opening;
  function open() {
    if (!indexedDB) return Promise.reject(new Error('DRAFT_STORAGE_UNAVAILABLE'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('DRAFT_STORAGE_BLOCKED'));
    });
    return opening;
  }
  function tabKey(create) {
    const encoded = sessionStorage.getItem(KEY_NAME);
    if (encoded) return textToBytes(encoded);
    if (!create) return null;
    const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
    sessionStorage.setItem(KEY_NAME, bytesToText(bytes));
    return bytes;
  }
  async function transact(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error('DRAFT_STORAGE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('DRAFT_STORAGE_ABORTED'));
      try { action(tx.objectStore(STORE), next => { value = next; }, tx); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  async function remove(id) { await transact('readwrite', store => { store.delete(id); }); }
  return {
    async save(draft) {
      try { assertDraftLifetime(draft, now()); }
      catch (error) { await remove(draft.id).catch(() => {}); throw error; }
      const encrypted = await encryptDraft(draft, tabKey(true), cryptoApi);
      const time = now();
      try { assertDraftLifetime(draft, time); }
      catch (error) { await remove(draft.id).catch(() => {}); throw error; }
      const outcome = await transact('readwrite', (store, setValue, tx) => {
        // Encryption finishes before opening a transaction (IDB auto-commit).
        const request = store.get(draft.id);
        request.onsuccess = () => {
          const previous = request.result;
          if (now() >= draft.expiresAt) { store.delete(draft.id); setValue('expired'); return; }
          if (previous && previous.expiresAt <= time) { store.delete(draft.id); setValue('expired'); return; }
          if (previous && (previous.expiresAt !== draft.expiresAt || previous.revision > draft.revision)) {
            tx.abort(); return;
          }
          store.put({ id: draft.id, revision: draft.revision, ...encrypted,
            expiresAt: draft.expiresAt });
          setValue(undefined);
        };
      });
      if (outcome === 'expired' || now() >= draft.expiresAt) { await remove(draft.id); throw new Error('DRAFT_EXPIRED'); }
    },
    async load(id) {
      const record = await transact('readonly', (store, setValue) => {
        const request = store.get(id); request.onsuccess = () => setValue(request.result);
      });
      if (!record) return null;
      const key = tabKey(false);
      if (!key || record.expiresAt <= now()) { await remove(id); return null; }
      try {
        const draft = await decryptDraft(record, id, key, cryptoApi);
        assertDraftLifetime(draft, now());
        if (draft.expiresAt !== record.expiresAt) throw Error('INVALID_EXPIRY');
        return draft;
      } catch { await remove(id); throw new Error('DRAFT_CANNOT_RESTORE'); }
    },
    remove,
    async discardForNewOwner(id) { await remove(id); sessionStorage.removeItem(KEY_NAME); },
    async purgeExpired() {
      const time = now();
      await transact('readwrite', store => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          if (current.value.expiresAt <= time) current.delete();
          current.continue();
        };
      });
    },
  };
}
