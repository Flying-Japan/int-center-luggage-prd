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

  // Check for a cancelled order to reuse its number
  const cancelled = await db
    .prepare(
      `SELECT order_id FROM luggage_orders
       WHERE order_id LIKE ? AND status = 'CANCELLED'
       ORDER BY order_id ASC LIMIT 1`
    )
    .bind(`${businessDate}-%`)
    .first<{ order_id: string }>();

  if (cancelled) {
    // Delete cancelled order and reuse its ID
    await db.prepare("DELETE FROM luggage_orders WHERE order_id = ? AND status = 'CANCELLED'")
      .bind(cancelled.order_id).run();
    await db.prepare("DELETE FROM luggage_audit_logs WHERE order_id = ?")
      .bind(cancelled.order_id).run();
    return cancelled.order_id;
  }

  // No cancelled orders to reuse — increment counter
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
 * Generate next tag_no for today using D1 luggage_daily_tag_counters.
 */
export async function buildTagNo(db: D1Database, nowUtc?: Date): Promise<string> {
  const businessDate = nowUtc ? formatBusinessDate(nowUtc) : todayBusinessDate();

  // Find lowest unused tag number (fills gaps from cancelled orders)
  const used = await db
    .prepare(
      `SELECT CAST(tag_no AS INTEGER) as num FROM luggage_orders
       WHERE order_id LIKE ? AND status != 'CANCELLED' AND tag_no IS NOT NULL
       ORDER BY num ASC`
    )
    .bind(`${businessDate}-%`)
    .all<{ num: number }>();

  const usedSet = new Set(used.results.map((r) => r.num));
  let next = 1;
  while (usedSet.has(next)) next++;

  return String(next);
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
