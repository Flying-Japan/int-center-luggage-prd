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

  // Always increment counter — no reuse of cancelled IDs
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
 * Derive tag_no from an order_id's sequence number.
 * Since buildOrderId already handles reuse and sequential numbering,
 * the tag_no is simply the NNN part of YYYYMMDD-NNN — keeping them in sync.
 *
 * If pickup is the next day or later (in JST), the tag starts from 91+.
 */
export function buildTagNo(orderId: string, createdAt?: string, expectedPickupAt?: string): string {
  // Extract sequence number from order_id format YYYYMMDD-NNN
  const seq = parseInt(orderId.split("-")[1], 10);

  // If pickup is next day or later, offset tag to 91+
  if (createdAt && expectedPickupAt) {
    const toJSTDate = (s: string) => {
      const d = new Date(s);
      const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
    };
    const createdDate = toJSTDate(createdAt);
    const pickupDate = toJSTDate(expectedPickupAt);
    if (pickupDate > createdDate) {
      return String(90 + seq);
    }
  }

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
