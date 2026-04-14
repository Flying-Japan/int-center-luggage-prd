/**
 * Midnight rollover (00:00 JST / 15:00 UTC).
 *
 * Same-day orders still in PAID status at midnight are uncollected bags
 * that must transition to overnight storage. Each gets a new 91+ tag,
 * freeing the old same-day tag for recycling.
 */

// Overnight tags allocated in bulk via direct counter manipulation (no per-order buildOvernightTag call)

interface RolloverResult {
  transitioned: number;
  errors: number;
}

/**
 * Find all same-day PAID orders (tag 1-90) for the just-ended business date
 * and assign new overnight tags (91+).
 *
 * "Just-ended business date" = yesterday in JST, since this runs at 00:00 JST.
 */
export async function runMidnightRollover(db: D1Database): Promise<RolloverResult> {
  // At 00:00 JST, the business date that just ended is yesterday
  const nowUtc = new Date();
  const jstMs = nowUtc.getTime() + 9 * 60 * 60 * 1000;
  const yesterdayJst = new Date(jstMs - 24 * 60 * 60 * 1000);
  const y = yesterdayJst.getUTCFullYear();
  const m = String(yesterdayJst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(yesterdayJst.getUTCDate()).padStart(2, "0");
  const businessDate = `${y}${m}${d}`;

  // Find same-day orders (tag 1-90) that are still PAID (not picked up, not cancelled)
  // These are uncollected bags that need overnight tags.
  const orders = await db.prepare(
    `SELECT order_id, tag_no FROM luggage_orders
     WHERE order_id LIKE ? || '-%'
       AND status = 'PAID'
       AND CAST(tag_no AS INTEGER) BETWEEN 1 AND 90
       AND parent_order_id IS NULL`
  ).bind(businessDate).all<{ order_id: string; tag_no: string }>();

  if (orders.results.length === 0) {
    return { transitioned: 0, errors: 0 };
  }

  // Bulk-allocate overnight tags: bump counter once by N instead of N separate calls
  const count = orders.results.length;
  await db.prepare(
    `INSERT INTO luggage_daily_tag_counters (business_date, last_seq)
     VALUES (?, ?)
     ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + ?`
  ).bind(`${businessDate}-overnight`, 90 + count, count).run();

  const counterRow = await db.prepare(
    `SELECT last_seq FROM luggage_daily_tag_counters WHERE business_date = ?`
  ).bind(`${businessDate}-overnight`).first<{ last_seq: number }>();

  const endSeq = counterRow?.last_seq ?? (90 + count);
  const startSeq = endSeq - count + 1;

  // Batch all updates in a single transaction
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < count; i++) {
    const newTag = String(startSeq + i);
    const orderId = orders.results[i].order_id;
    stmts.push(
      db.prepare(
        `UPDATE luggage_orders SET tag_no = ?, updated_at = datetime('now') WHERE order_id = ?`
      ).bind(newTag, orderId)
    );
    stmts.push(
      db.prepare(
        `UPDATE luggage_orders SET tag_no = ?, updated_at = datetime('now')
         WHERE parent_order_id = ? AND status IN ('PAYMENT_PENDING', 'PAID')`
      ).bind(newTag, orderId)
    );
  }

  try {
    await db.batch(stmts);
  } catch (e) {
    console.error("Midnight rollover batch failed:", e);
    return { transitioned: 0, errors: count };
  }

  return { transitioned: count, errors: 0 };
}
