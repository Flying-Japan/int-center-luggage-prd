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
 * Uses atomic INSERT ON CONFLICT UPDATE to safely increment.
 */
export async function buildOrderId(db: D1Database, nowUtc?: Date): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  // Atomic upsert: insert with seq=1, or increment existing
  await db
    .prepare(
      `INSERT INTO luggage_daily_counters (business_date, last_seq)
       VALUES (?, 1)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1`
    )
    .bind(businessDate)
    .run();

  // Read the current sequence
  const row = await db
    .prepare("SELECT last_seq FROM luggage_daily_counters WHERE business_date = ?")
    .bind(businessDate)
    .first<{ last_seq: number }>();

  const seq = row?.last_seq ?? 1;
  return `${businessDate}-${String(seq).padStart(3, "0")}`;
}

/**
 * Generate next tag_no for today using D1 luggage_daily_tag_counters.
 */
export async function buildTagNo(db: D1Database, nowUtc?: Date): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  await db
    .prepare(
      `INSERT INTO luggage_daily_tag_counters (business_date, last_seq)
       VALUES (?, 1)
       ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1`
    )
    .bind(businessDate)
    .run();

  const row = await db
    .prepare("SELECT last_seq FROM luggage_daily_tag_counters WHERE business_date = ?")
    .bind(businessDate)
    .first<{ last_seq: number }>();

  const seq = row?.last_seq ?? 1;
  return String(seq);
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
