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
export async function buildOrderId(db: D1Database, nowUtc?: Date, overnight?: boolean): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  // Two counters: same-day (1~95) and overnight/next-day+ (96~)
  const counterKey = overnight ? `${businessDate}-overnight` : businessDate;
  const startSeq = overnight ? 93 : 1;

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
 * Derive tag_no from an order_id's sequence number.
 * Since buildOrderId already handles reuse and sequential numbering,
 * the tag_no is simply the NNN part of YYYYMMDD-NNN — keeping them in sync.
 *
 * If pickup is the next day or later (in JST), the tag starts from 91+.
 */
export function buildTagNo(orderId: string): string {
  // tag_no = sequence from order_id (YYYYMMDD-NNN → NNN)
  // Same-day: 1~95, overnight: 96+. Always matches order_id.
  return String(parseInt(orderId.split("-")[1], 10));
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
