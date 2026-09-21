/**
 * Midnight rollover (00:00 JST / 15:00 UTC).
 *
 * Same-day orders still in PAID status at midnight are uncollected bags
 * that must transition to overnight storage. Each gets an available tag from
 * the dedicated 146-150 range, freeing the old same-day tag for recycling.
 */

import { captureOperationalError } from "../lib/observability";

interface RolloverResult {
  transitioned: number;
  errors: number;
}

/**
 * Find all untransitioned PAID orders (tag 1-145) from the just-ended or any
 * earlier business date and assign available overnight tags (146-150).
 *
 * Backlog orders remain eligible on each later midnight run until transitioned.
 */
export async function runMidnightRollover(db: D1Database): Promise<RolloverResult> {
  // At 00:00 JST, the business date that just ended is yesterday
  const nowUtc = new Date();
  const jstMs = nowUtc.getTime() + 9 * 60 * 60 * 1000;
  const yesterdayJst = new Date(jstMs - 24 * 60 * 60 * 1000);
  const y = yesterdayJst.getUTCFullYear();
  const m = String(yesterdayJst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(yesterdayJst.getUTCDate()).padStart(2, "0");
  const latestEligibleBusinessDate = `${y}${m}${d}`;

  // Include the just-ended business date and all older untransitioned backlog.
  // Oldest orders receive the limited overnight tags first.
  const orders = await db.prepare(
    `SELECT order_id, tag_no FROM luggage_orders
     WHERE status = 'PAID'
       AND CAST(tag_no AS INTEGER) BETWEEN 1 AND 145
       AND parent_order_id IS NULL
       AND SUBSTR(order_id, 1, 8) <= ?
     ORDER BY SUBSTR(order_id, 1, 8) ASC, created_at ASC, order_id ASC`
  ).bind(latestEligibleBusinessDate).all<{ order_id: string; tag_no: string }>();

  if (orders.results.length === 0) {
    return { transitioned: 0, errors: 0 };
  }

  const count = orders.results.length;
  const availableTags = await db.prepare(
    `WITH overnight_tags(tag_no) AS (
       VALUES (146), (147), (148), (149), (150)
     )
     SELECT tag_no FROM overnight_tags t
     WHERE NOT EXISTS (
       SELECT 1 FROM luggage_orders o
       WHERE CAST(o.tag_no AS INTEGER) = t.tag_no
         AND o.status IN ('PAYMENT_PENDING', 'PAID')
     )
     ORDER BY tag_no ASC`
  ).all<{ tag_no: number }>();

  if (availableTags.results.length === 0) {
    return { transitioned: 0, errors: count };
  }

  let transitioned = 0;
  let tagIndex = 0;

  try {
    for (const order of orders.results) {
      while (tagIndex < availableTags.results.length) {
        const targetTag = availableTags.results[tagIndex].tag_no;
        const newTag = String(targetTag);

        const results = await db.batch([
          db.prepare(
            `UPDATE luggage_orders
             SET tag_no = ?, updated_at = datetime('now')
             WHERE order_id = ?
               AND parent_order_id IS NULL
               AND status = 'PAID'
               AND CAST(tag_no AS INTEGER) BETWEEN 1 AND 145
               AND NOT EXISTS (
                 SELECT 1 FROM luggage_orders active
                 WHERE CAST(active.tag_no AS INTEGER) = ?
                   AND active.status IN ('PAYMENT_PENDING', 'PAID')
               )
             RETURNING order_id`
          ).bind(newTag, order.order_id, targetTag),
          db.prepare(
            `UPDATE luggage_orders
             SET tag_no = ?, updated_at = datetime('now')
             WHERE parent_order_id = ?
               AND status IN ('PAYMENT_PENDING', 'PAID')
               AND EXISTS (
                 SELECT 1 FROM luggage_orders root
                 WHERE root.order_id = ?
                   AND root.parent_order_id IS NULL
                   AND CAST(root.tag_no AS INTEGER) = ?
               )`
          ).bind(newTag, order.order_id, order.order_id, targetTag),
        ]);

        if (results[0]?.results?.[0]) {
          transitioned += 1;
          tagIndex += 1;
          break;
        }

        const stillEligible = await db.prepare(
          `SELECT 1 FROM luggage_orders
           WHERE order_id = ?
             AND parent_order_id IS NULL
             AND status = 'PAID'
             AND CAST(tag_no AS INTEGER) BETWEEN 1 AND 145
           LIMIT 1`
        ).bind(order.order_id).first();

        if (!stillEligible) break;

        // The target was claimed after the initial availability query.
        // Keep this oldest order first and retry it with the next candidate.
        tagIndex += 1;
      }

      if (tagIndex >= availableTags.results.length) break;
    }
  } catch (e) {
    console.error("Midnight rollover batch failed:", e);
    captureOperationalError(e, {
      operation: "scheduled.midnight_rollover",
      tags: { job: "midnight_rollover" },
      context: { count, transitioned, attemptedTags: tagIndex },
      fingerprint: ["scheduled.midnight_rollover"],
    });
    return { transitioned, errors: count - transitioned };
  }

  return { transitioned, errors: count - transitioned };
}
