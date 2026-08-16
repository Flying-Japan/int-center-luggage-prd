/**
 * Data retention and cleanup service.
 *
 * Image cleanup only:
 * - 14-day pass: Delete ID/luggage images from R2, clear URL fields in DB
 * - Customer order data is kept permanently for service and marketing purposes
 */

import { captureOperationalError } from "../lib/observability";

const ID_IMAGE_RETENTION_DAYS = 14;
const RETENTION_ORDER_LIMIT = 100;
const D1_UPDATE_CHUNK_SIZE = 50;

export type RetentionResult = {
  imagesCleared: number;
  ordersSelected: number;
  ordersFailed: number;
  backlogRemaining: number;
};

/**
 * Run retention cleanup on images and old orders.
 */
export async function runRetentionCleanup(
  db: D1Database,
  images: R2Bucket
): Promise<RetentionResult> {
  // Pass 1: Clear images older than 14 days
  const imageCutoff = daysAgoISO(ID_IMAGE_RETENTION_DAYS);
  const backlog = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM luggage_orders
       WHERE created_at < ?
       AND (id_image_url IS NOT NULL OR luggage_image_url IS NOT NULL)`
    )
    .bind(imageCutoff)
    .first<{ total: number }>();

  const ordersWithImages = await db
    .prepare(
      `SELECT order_id, id_image_url, luggage_image_url FROM luggage_orders
       WHERE created_at < ?
       AND (id_image_url IS NOT NULL OR luggage_image_url IS NOT NULL)
       ORDER BY created_at ASC, order_id ASC
       LIMIT ?`
    )
    .bind(imageCutoff, RETENTION_ORDER_LIMIT)
    .all<{ order_id: string; id_image_url: string | null; luggage_image_url: string | null }>();

  const result: RetentionResult = {
    imagesCleared: 0,
    ordersSelected: ordersWithImages.results.length,
    ordersFailed: 0,
    backlogRemaining: backlog?.total ?? 0,
  };

  const clearedOrderIds: string[] = [];
  for (const order of ordersWithImages.results) {
    // Delete images from R2 — only mark cleared if all deletes succeed
    const keysToDelete: Array<{ key: string; prefix: "id/" | "luggage/" }> = [];
    if (order.id_image_url) keysToDelete.push({ key: order.id_image_url, prefix: "id/" });
    if (order.luggage_image_url) keysToDelete.push({ key: order.luggage_image_url, prefix: "luggage/" });

    let allDeleted = true;
    for (const { key, prefix } of keysToDelete) {
      if (!isCustomerImageKey(key, prefix)) {
        const error = new Error(`Refusing to delete non-customer R2 key: ${key}`);
        console.error(error.message);
        captureOperationalError(error, {
          level: "warning",
          operation: "scheduled.retention.invalid_image_key",
          tags: { storage: "r2" },
          context: { orderId: order.order_id, key },
          fingerprint: ["scheduled.retention.invalid_image_key"],
        });
        allDeleted = false;
        continue;
      }

      try {
        await images.delete(key);
      } catch (e) {
        console.error(`Failed to delete R2 object ${key}:`, e);
        captureOperationalError(e, {
          level: "warning",
          operation: "scheduled.retention.delete_image",
          tags: { storage: "r2" },
          context: { orderId: order.order_id, key },
          fingerprint: ["scheduled.retention.delete_image"],
        });
        allDeleted = false;
      }
    }

    if (allDeleted) {
      clearedOrderIds.push(order.order_id);
    } else {
      result.ordersFailed += 1;
    }
  }

  // Keep D1 bind counts small while clearing successfully deleted orders.
  for (let i = 0; i < clearedOrderIds.length; i += D1_UPDATE_CHUNK_SIZE) {
    const chunk = clearedOrderIds.slice(i, i + D1_UPDATE_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(",");
    await db
      .prepare(
        `UPDATE luggage_orders
         SET id_image_url = NULL, luggage_image_url = NULL, updated_at = datetime('now')
         WHERE order_id IN (${placeholders})`
      )
      .bind(...chunk)
      .run();
    result.imagesCleared += chunk.length;
  }

  result.backlogRemaining = Math.max(0, result.backlogRemaining - result.imagesCleared);

  // Customer order data kept permanently — no deletion pass

  return result;
}

function isCustomerImageKey(key: string, expectedPrefix: "id/" | "luggage/"): boolean {
  return key.startsWith(expectedPrefix) && key.length > expectedPrefix.length;
}

/** Get ISO string for N days ago. */
function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
