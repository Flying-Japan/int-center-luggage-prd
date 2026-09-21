/**
 * Sequential order ID and tag number generation.
 *
 * Order ID: YYYYMMDD-NNN — always unique, always increments, never reused.
 * Tag number: physical luggage tag.
 *
 * Same-day tags (1-145):
 *   Phase 1: Sequential 1→2→3...→145 (first pass).
 *   Phase 2: After reaching 145, recycle the lowest available tag
 *            (i.e. not held by an active PAYMENT_PENDING or PAID order).
 *   Returns null when all 145 tags are in use.
 *
 * Overnight tags (146-150):
 *   Reuse the lowest number not held by any active order, regardless of date.
 *
 * Extensions: Reuse parent's tag (same physical bag) — handled by caller.
 */

import { todayBusinessDate } from "./storage";

/**
 * Generate next order_id for today using D1 luggage_daily_counters.
 * Atomic INSERT ON CONFLICT UPDATE with RETURNING.
 */
export async function buildOrderId(db: D1Database, nowUtc?: Date, _overnight?: boolean, counterPrefix?: string): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  const counterKey = counterPrefix ? `${businessDate}-${counterPrefix}` : businessDate;
  let nextSeqFloor = 1;

  // Customer and manual orders share one sequence per business date. When
  // switching from the former overnight counter, skip any IDs already stored.
  if (!counterPrefix) {
    const existing = await db.prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(order_id, 10) AS INTEGER)), 0) AS last_seq
       FROM luggage_orders
       WHERE order_id GLOB ?`
    ).bind(`${businessDate}-[0-9]*`).first<{ last_seq: number }>();
    nextSeqFloor = (existing?.last_seq ?? 0) + 1;
  }

  const row = await db
    .prepare(
      `INSERT INTO luggage_daily_counters (business_date, last_seq)
       VALUES (?, ?)
       ON CONFLICT(business_date) DO UPDATE
       SET last_seq = MAX(last_seq + 1, excluded.last_seq)
       RETURNING last_seq`
    )
    .bind(counterKey, nextSeqFloor)
    .first<{ last_seq: number }>();

  const seq = row?.last_seq ?? nextSeqFloor;
  return `${businessDate}-${String(seq).padStart(3, "0")}`;
}

/**
 * Assign a same-day tag number (1-145).
 *
 * Phase 1: Increment the sequential counter through 145, skipping candidates
 *          held by any active order (PAYMENT_PENDING or PAID), regardless of date.
 * Phase 2: All 145 first-pass tags used — recycle the lowest tag not held
 *          by any active order.
 *
 * Uses luggage_tag_pool (static 1-145 rows) as the reference set instead
 * of generate_series (not available in D1/SQLite).
 *
 * Returns null when all 145 tags are in use (caller should show error).
 */
export async function buildSameDayTag(db: D1Database, businessDate?: string): Promise<string | null> {
  const bizDate = businessDate ?? todayBusinessDate();

  // Check current counter without incrementing first
  const current = await db.prepare(
    `SELECT last_seq FROM luggage_daily_tag_counters WHERE business_date = ?`
  ).bind(bizDate).first<{ last_seq: number }>();

  let currentSeq = current?.last_seq ?? 0;

  // Phase 1: Increment atomically so concurrent requests receive distinct
  // sequential candidates. Skip any candidate held by an active order.
  while (currentSeq < 145) {
    const row = await db.prepare(
      `INSERT INTO luggage_daily_tag_counters (business_date, last_seq)
       VALUES (?, 1)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1
       RETURNING last_seq`
    ).bind(bizDate).first<{ last_seq: number }>();

    const candidate = row?.last_seq ?? (currentSeq + 1);
    currentSeq = candidate;

    // Another concurrent request may have advanced the counter past the range.
    if (candidate > 145) break;

    const inUse = await db.prepare(
      `SELECT 1 FROM luggage_orders
       WHERE CAST(tag_no AS INTEGER) = ?
         AND status IN ('PAYMENT_PENDING', 'PAID')
       LIMIT 1`
    ).bind(candidate).first();

    if (!inUse) return String(candidate);
  }

  // Phase 2: Recycle — find lowest available tag from pool (no counter increment)
  // A tag is "in use" if any active order holds it, regardless of business date.
  const freeTag = await db.prepare(
    `SELECT t.tag_no FROM luggage_tag_pool t
     WHERE t.tag_no BETWEEN 1 AND 145
       AND NOT EXISTS (
       SELECT 1 FROM luggage_orders o
       WHERE CAST(o.tag_no AS INTEGER) = t.tag_no
         AND o.status IN ('PAYMENT_PENDING', 'PAID')
     )
     ORDER BY t.tag_no ASC
     LIMIT 1`
  ).first<{ tag_no: number }>();

  if (!freeTag) return null; // All 145 tags in use
  return String(freeTag.tag_no);
}

/**
 * Assign an overnight tag number from the dedicated 146-150 range.
 * Availability is checked against every active order because long-term bags
 * can remain in storage across business dates.
 */
export async function buildOvernightTag(db: D1Database, _businessDate?: string): Promise<string | null> {
  const freeTag = await db.prepare(
    `WITH overnight_tags(tag_no) AS (
       VALUES (146), (147), (148), (149), (150)
     )
     SELECT tag_no FROM overnight_tags t
     WHERE NOT EXISTS (
       SELECT 1 FROM luggage_orders o
       WHERE CAST(o.tag_no AS INTEGER) = t.tag_no
         AND o.status IN ('PAYMENT_PENDING', 'PAID')
     )
     ORDER BY tag_no ASC
     LIMIT 1`
  ).first<{ tag_no: number }>();

  return freeTag ? String(freeTag.tag_no) : null;
}

/** Convert a UTC Date to JST business date string (YYYYMMDD). */
function formatBusinessDate(utcDate: Date): string {
  const jstMs = utcDate.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
