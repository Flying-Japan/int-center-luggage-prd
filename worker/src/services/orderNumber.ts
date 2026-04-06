/**
 * Sequential order ID and tag number generation.
 *
 * Order ID: YYYYMMDD-NNN — always unique, always increments, never reused.
 * Tag number: physical luggage tag.
 *   - Same-day pickup: 1~91, recycled from CANCELLED/PICKED_UP when full.
 *   - Overnight pickup: 92~, always matches order_id seq.
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
 * Generate tag_no for an order.
 *
 * Overnight: tag = order_id seq (92+), always matches.
 * Same-day:
 *   - If seq ≤ 91: tag = seq (matches order_id)
 *   - If seq > 91: recycle lowest tag 1~91 from CANCELLED/PICKED_UP orders today
 */
export async function buildTagNo(db: D1Database, orderId: string): Promise<string> {
  const seq = parseInt(orderId.split("-")[1], 10);
  const businessDate = orderId.split("-")[0]; // YYYYMMDD

  // Overnight (92+): always use seq as tag
  if (seq >= 92) {
    return String(seq);
  }

  // Same-day (1~91): use seq if not taken by active order
  const conflict = await db
    .prepare(
      `SELECT 1 FROM luggage_orders
       WHERE order_id LIKE ? AND tag_no = ? AND status IN ('PAYMENT_PENDING', 'PAID')
       LIMIT 1`
    )
    .bind(`${businessDate}-%`, String(seq))
    .first();

  if (!conflict) {
    return String(seq);
  }

  // Recycle: find lowest tag 1~91 not used by an active (PAYMENT_PENDING/PAID) order today
  const activeTagsResult = await db
    .prepare(
      `SELECT CAST(tag_no AS INTEGER) as num FROM luggage_orders
       WHERE order_id LIKE ? AND status IN ('PAYMENT_PENDING', 'PAID')
       AND CAST(tag_no AS INTEGER) BETWEEN 1 AND 91
       ORDER BY num ASC`
    )
    .bind(`${businessDate}-%`)
    .all<{ num: number }>();

  const activeTags = new Set(activeTagsResult.results.map((r) => r.num));
  for (let i = 1; i <= 91; i++) {
    if (!activeTags.has(i)) return String(i);
  }

  // All 91 tags active (extremely unlikely) — use seq as fallback
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
