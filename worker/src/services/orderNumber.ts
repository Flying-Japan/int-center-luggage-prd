/**
 * Sequential order ID and tag number generation.
 * Ported from Python: app/services/order_number.py
 *
 * Order ID format: YYYYMMDD-NNN (e.g., 20260219-001)
 * Tag number: numeric sequence per business day
 */

import { todayBusinessDate } from "./storage";

/**
 * Generate next order_id for today using D1 luggage_daily_counters.
 * Uses atomic INSERT ON CONFLICT UPDATE with RETURNING to safely increment in one round-trip.
 */
export async function buildOrderId(db: D1Database, nowUtc?: Date): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  // Always increment — never reuse cancelled order IDs
  const row = await db
    .prepare(
      `INSERT INTO luggage_daily_counters (business_date, last_seq)
       VALUES (?, 1)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1
       RETURNING last_seq`
    )
    .bind(businessDate)
    .first<{ last_seq: number }>();

  const seq = row?.last_seq ?? 1;
  return `${businessDate}-${String(seq).padStart(3, "0")}`;
}

/**
 * Generate next tag_no for today.
 * Always based on the actual max tag_no in orders (not a blind counter).
 * This way, if staff manually edits a tag number, the next one follows correctly.
 */
export async function buildTagNo(db: D1Database, nowUtc?: Date): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  // Find the actual max tag_no currently in orders for today
  const maxTag = await db
    .prepare(
      `SELECT MAX(CAST(tag_no AS INTEGER)) as max_tag FROM luggage_orders
       WHERE order_id LIKE ? AND tag_no IS NOT NULL`
    )
    .bind(`${businessDate}-%`)
    .first<{ max_tag: number | null }>();

  return String((maxTag?.max_tag ?? 0) + 1);
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
