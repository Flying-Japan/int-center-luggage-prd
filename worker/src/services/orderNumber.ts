/**
 * Sequential order ID and tag number generation.
 *
 * Order ID: YYYYMMDD-NNN — always unique, always increments, never reused.
 * Tag number: physical luggage tag.
 *
 * Same-day tags (1-90):
 *   Phase 1: Sequential 1→2→3...→90 (first pass).
 *   Phase 2: After reaching 90, recycle the lowest available tag
 *            (i.e. not held by an active PAYMENT_PENDING or PAID order).
 *   Returns null when all 90 tags are in use.
 *
 * Overnight tags (91+):
 *   Sequential counter, no recycling. Starts at 91 for each business date.
 *
 * Extensions: Reuse parent's tag (same physical bag) — handled by caller.
 */

import { todayBusinessDate } from "./storage";

/**
 * Generate next order_id for today using D1 luggage_daily_counters.
 * Atomic INSERT ON CONFLICT UPDATE with RETURNING.
 */
export async function buildOrderId(db: D1Database, nowUtc?: Date, overnight?: boolean, counterPrefix?: string): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  let counterKey = businessDate;
  if (counterPrefix) {
    counterKey = `${businessDate}-${counterPrefix}`;
  } else if (overnight) {
    counterKey = `${businessDate}-overnight`;
  }
  const startSeq = overnight ? 92 : 1;

  const row = await db
    .prepare(
      `INSERT INTO luggage_daily_counters (business_date, last_seq)
       VALUES (?, ?)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1
       RETURNING last_seq`
    )
    .bind(counterKey, startSeq)
    .first<{ last_seq: number }>();

  const seq = row?.last_seq ?? startSeq;
  return `${businessDate}-${String(seq).padStart(3, "0")}`;
}

/**
 * Assign a same-day tag number (1-90).
 *
 * Phase 1: Increment sequential counter. If <= 90, use that directly.
 * Phase 2: All 90 first-pass tags used — recycle the lowest tag not held
 *          by an active order (PAYMENT_PENDING or PAID) for today.
 *
 * Uses luggage_tag_pool (static 1-90 rows) as the reference set instead
 * of generate_series (not available in D1/SQLite).
 *
 * Returns null when all 90 tags are in use (caller should show error).
 */
export async function buildSameDayTag(db: D1Database, businessDate?: string): Promise<string | null> {
  const bizDate = businessDate ?? todayBusinessDate();

  // Check current counter without incrementing first
  const current = await db.prepare(
    `SELECT last_seq FROM luggage_daily_tag_counters WHERE business_date = ?`
  ).bind(bizDate).first<{ last_seq: number }>();

  const currentSeq = current?.last_seq ?? 0;

  // Phase 1: Still in first pass (1-90) — increment and use
  if (currentSeq < 90) {
    const row = await db.prepare(
      `INSERT INTO luggage_daily_tag_counters (business_date, last_seq)
       VALUES (?, 1)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1
       RETURNING last_seq`
    ).bind(bizDate).first<{ last_seq: number }>();
    return String(row?.last_seq ?? 1);
  }

  // Phase 2: Recycle — find lowest available tag from pool (no counter increment)
  // A tag is "in use" if an active order (PAYMENT_PENDING or PAID) holds it for today
  const freeTag = await db.prepare(
    `SELECT t.tag_no FROM luggage_tag_pool t
     WHERE NOT EXISTS (
       SELECT 1 FROM luggage_orders o
       WHERE CAST(o.tag_no AS INTEGER) = t.tag_no
         AND o.order_id LIKE ? || '-%'
         AND o.status IN ('PAYMENT_PENDING', 'PAID')
     )
     ORDER BY t.tag_no ASC
     LIMIT 1`
  ).bind(bizDate).first<{ tag_no: number }>();

  if (!freeTag) return null; // All 90 tags in use
  return String(freeTag.tag_no);
}

/**
 * Assign an overnight tag number (91+).
 * Sequential counter per business date, no recycling.
 */
export async function buildOvernightTag(db: D1Database, businessDate?: string): Promise<string> {
  const bizDate = businessDate ?? todayBusinessDate();

  const row = await db.prepare(
    `INSERT INTO luggage_daily_tag_counters (business_date, last_seq)
     VALUES (?, 91)
     ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1
     RETURNING last_seq`
  ).bind(`${bizDate}-overnight`).first<{ last_seq: number }>();

  return String(row?.last_seq ?? 91);
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
