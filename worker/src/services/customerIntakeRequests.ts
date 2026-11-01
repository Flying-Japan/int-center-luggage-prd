/** Mounted only behind the explicit customer-renewal release gate.
 * One high-entropy browser request key must survive auth and network retries.
 * Never expire/re-steal PROCESSING claims: an interrupted request is uncertain.
 * Existing order/tag/pricing code remains the only writer of the order itself. */
export type IntakeClaim = { requestHash: string; payloadHash: string; claimId: string };
export type IntakeClaimResult = { kind: "acquired"; claim: IntakeClaim; previousClaim?: IntakeClaim }
  | { kind: "busy" } | { kind: "conflict" } | { kind: "replay"; orderId: string };
type RequestRow = { payload_hash: string; claim_id: string; state: "PROCESSING" | "COMMITTED" | "FAILED"; order_id: string | null };
export class IntakeTagConflict extends Error { constructor() { super('INTAKE_TAG_RETRY'); } }

export async function intakeHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export type IntakeFingerprintInput = {
  // Server-verified Account person id, or explicit anonymous scope. Never form data.
  actorScope: string;
  name: string; phone: string; email: string; lang: string;
  suitcaseQty: number; backpackQty: number; companionCount: number;
  pickupISO: string; paymentMethod: string; privacyVersion: string;
  identityPhoto: Blob; luggagePhoto: Blob;
  identityBytes?: ArrayBuffer; luggageBytes?: ArrayBuffer;
};
export async function fingerprintCustomerIntake(input: IntakeFingerprintInput): Promise<string> {
  const photoDigest = async (photo: Blob, bytes?: ArrayBuffer) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes ?? await photo.arrayBuffer());
    return [photo.type, photo.size, Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')];
  };
  return intakeHash(JSON.stringify([input.actorScope, input.name.trim(), input.phone.trim(), input.email.trim(), input.lang,
    input.suitcaseQty, input.backpackQty, input.companionCount, input.pickupISO, input.paymentMethod, input.privacyVersion,
    await photoDigest(input.identityPhoto,input.identityBytes), await photoDigest(input.luggagePhoto,input.luggageBytes)]));
}

/** Hash canonical validated fields + verified actor scope + BOTH photo digests.
 * Include no volatile timestamps or freshly calculated price in the fingerprint.
 * The request key, all identity authorization and the fingerprint are server checked. */
export async function claimCustomerIntake(db: D1Database, requestKey: string, payloadHash: string): Promise<IntakeClaimResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(requestKey) || !/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new Error("INVALID_INTAKE_REQUEST");
  }
  const requestHash = await intakeHash(requestKey);
  const claimId = crypto.randomUUID();
  await db.prepare(`INSERT INTO luggage_intake_requests(request_hash,payload_hash,claim_id,state)
    VALUES(?,?,?,'PROCESSING') ON CONFLICT(request_hash) DO NOTHING`)
    .bind(requestHash, payloadHash, claimId).run();
  let row = await readRequest(db, requestHash);
  if (!row) throw new Error("INTAKE_CLAIM_NOT_DURABLE");
  let previousClaim: IntakeClaim | undefined;
  if (row.state === "FAILED") {
    previousClaim = { requestHash, payloadHash: row.payload_hash, claimId: row.claim_id };
    // A proven pre-commit failure can be edited, without retiring the durable key.
    // CAS against its previous fingerprint prevents a late old retry from winning.
    await db.prepare(`UPDATE luggage_intake_requests SET claim_id=?,payload_hash=?,state='PROCESSING',updated_at=datetime('now')
      WHERE request_hash=? AND payload_hash=? AND state='FAILED'`).bind(claimId, payloadHash, requestHash, row.payload_hash).run();
    row = await readRequest(db, requestHash);
  }
  if (row?.payload_hash !== payloadHash) return { kind: "conflict" };
  if (row.state === "COMMITTED") return { kind: "replay", orderId: row.order_id! };
  return row?.claim_id === claimId ? { kind: "acquired", claim: { requestHash, payloadHash, claimId }, ...(previousClaim ? { previousClaim } : {}) } : { kind: "busy" };
}

function readRequest(db: D1Database, requestHash: string) {
  return db.prepare("SELECT payload_hash,claim_id,state,order_id FROM luggage_intake_requests WHERE request_hash=?")
    .bind(requestHash).first<RequestRow>();
}

/** The guarded legacy order INSERT and receipt link commit in one D1 batch.
 * A stale claim aborts the WHOLE transaction using the ledger state constraint.
 * No outbound messages or payments belong inside this helper.
 * orderInsert must insert exactly the supplied, newly allocated orderId. */
export async function commitCustomerIntake(db: D1Database, claim: IntakeClaim, orderId: string,
  orderInsert: D1PreparedStatement): Promise<{ orderId: string; replayed: boolean }> {
  const current = await readRequest(db, claim.requestHash);
  if (!current || current.payload_hash !== claim.payloadHash || current.claim_id !== claim.claimId) {
    throw new Error("INTAKE_CLAIM_LOST");
  }
  if (current.state === "COMMITTED") {
    if (current.order_id !== orderId) throw new Error("INTAKE_ORDER_MISMATCH");
    return { orderId, replayed: true };
  }
  const results = await db.batch([
    // Insert an impossible state only when the owner is absent/wrong. The CHECK
    // aborts the whole batch even if a ledger row vanished after the preflight.
    db.prepare(`INSERT INTO luggage_intake_requests(request_hash,payload_hash,claim_id,state)
      SELECT ?,?,?,'INVALID' WHERE NOT EXISTS(SELECT 1 FROM luggage_intake_requests
        WHERE request_hash=? AND claim_id=? AND payload_hash=? AND state='PROCESSING')`)
      .bind(claim.requestHash, claim.payloadHash, claim.claimId, claim.requestHash, claim.claimId, claim.payloadHash),
    orderInsert,
    // A conditional tag collision is a known zero-insert, not a lost response.
    // Record FAILED atomically so retry never needs to steal PROCESSING.
    db.prepare(`UPDATE luggage_intake_requests SET state=CASE
      WHEN EXISTS(SELECT 1 FROM luggage_orders WHERE order_id=?) THEN 'COMMITTED' ELSE 'FAILED' END,
      order_id=CASE WHEN EXISTS(SELECT 1 FROM luggage_orders WHERE order_id=?) THEN ? ELSE NULL END,
      receipt_issued_at=CASE WHEN EXISTS(SELECT 1 FROM luggage_orders WHERE order_id=?) THEN ? ELSE NULL END,
      updated_at=datetime('now') WHERE request_hash=? AND claim_id=? AND state='PROCESSING'
      RETURNING state,order_id`)
      .bind(orderId, orderId, orderId, orderId, Date.now(), claim.requestHash, claim.claimId),
  ]);
  if (results[0].meta.changes !== 0 || results[2].meta.changes !== 1) throw new Error("INTAKE_COMMIT_UNCERTAIN");
  const final = results[2].results[0] as { state?: string; order_id?: string | null } | undefined;
  if (final?.state === 'FAILED' && final.order_id === null) throw new IntakeTagConflict();
  if (final?.state !== 'COMMITTED' || final.order_id !== orderId) throw Error('INTAKE_COMMIT_UNCERTAIN');
  return { orderId, replayed: false };
}

export async function reserveIntakeUpload(db: D1Database, claim: IntakeClaim, objectKey: string, kind: 'id' | 'luggage') {
  const result = await db.prepare(`INSERT INTO luggage_intake_uploads(object_key,request_hash,claim_id,kind)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM luggage_intake_requests
      WHERE request_hash=? AND claim_id=? AND payload_hash=? AND state='PROCESSING')`)
    .bind(objectKey, claim.requestHash, claim.claimId, kind, claim.requestHash, claim.claimId, claim.payloadHash).run();
  if (result.meta.changes !== 1) throw Error('INTAKE_UPLOAD_OWNER_LOST');
}

/** DB is used directly (primary, no unconstrained replica session). Only failed
 * or superseded owners may clean unreferenced keys. Unknown active owners retain
 * their objects. R2 failures keep durable rows for later reconciliation. */
export async function cleanupIntakeUploads(db: D1Database, bucket: R2Bucket, claim: IntakeClaim) {
  const result = await db.prepare(`SELECT u.object_key FROM luggage_intake_uploads u
    JOIN luggage_intake_requests r ON r.request_hash=u.request_hash
    WHERE u.request_hash=? AND u.claim_id=? AND u.deleted_at IS NULL
      AND (r.state='FAILED' OR r.claim_id!=u.claim_id)
      AND NOT EXISTS(SELECT 1 FROM luggage_orders o WHERE o.id_image_url=u.object_key OR o.luggage_image_url=u.object_key)`)
    .bind(claim.requestHash, claim.claimId).all<{ object_key: string }>();
  for (const row of result.results) {
    try {
      await bucket.delete(row.object_key);
      await db.prepare(`UPDATE luggage_intake_uploads SET deleted_at=datetime('now')
        WHERE object_key=? AND request_hash=? AND claim_id=?`).bind(row.object_key, claim.requestHash, claim.claimId).run();
    } catch { /* Durable uncleaned row remains; do not fabricate cleanup success. */ }
  }
}

/** Call ONLY after a proven pre-commit failure (e.g. rejected image validation).
 * Do not call after a network/DB timeout; retain PROCESSING for reconciliation. */
export async function failCustomerIntakeBeforeCommit(db: D1Database, claim: IntakeClaim) {
  await db.prepare(`UPDATE luggage_intake_requests SET state='FAILED',updated_at=datetime('now')
    WHERE request_hash=? AND payload_hash=? AND claim_id=? AND state='PROCESSING'`)
    .bind(claim.requestHash, claim.payloadHash, claim.claimId).run();
}
