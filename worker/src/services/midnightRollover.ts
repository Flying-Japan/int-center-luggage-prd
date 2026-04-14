/**
 * Midnight rollover (00:00 JST / 15:00 UTC).
 *
 * Same-day orders still in PAID status at midnight are uncollected bags
 * that must transition to overnight storage. Each gets a new 91+ tag,
 * freeing the old same-day tag for recycling.
 */

import { buildOvernightTag } from "./orderNumber";

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

  let transitioned = 0;
  let errors = 0;

  for (const order of orders.results) {
    try {
      const newTag = await buildOvernightTag(db, businessDate);
      await db.prepare(
        `UPDATE luggage_orders SET tag_no = ?, updated_at = datetime('now')
         WHERE order_id = ?`
      ).bind(newTag, order.order_id).run();

      // Also update any extension orders that share the parent's tag
      await db.prepare(
        `UPDATE luggage_orders SET tag_no = ?, updated_at = datetime('now')
         WHERE parent_order_id = ?
           AND status IN ('PAYMENT_PENDING', 'PAID')`
      ).bind(newTag, order.order_id).run();

      transitioned++;
    } catch (e) {
      console.error(`Rollover failed for ${order.order_id}:`, e);
      errors++;
    }
  }

  return { transitioned, errors };
}
