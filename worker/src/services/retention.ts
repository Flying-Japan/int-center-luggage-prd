/**
 * Data retention and cleanup service.
 *
 * Image cleanup only:
 * - 14-day pass: Delete ID/luggage images from R2, clear URL fields in DB
 * - Customer order data is kept permanently for service and marketing purposes
 */

const ID_IMAGE_RETENTION_DAYS = 14;

export type RetentionResult = {
  imagesCleared: number;
  ordersDeleted: number;
  auditLogsDeleted: number;
};

/**
 * Run retention cleanup on images and old orders.
 */
export async function runRetentionCleanup(
  db: D1Database,
  images: R2Bucket
): Promise<RetentionResult> {
  const result: RetentionResult = {
    imagesCleared: 0,
    ordersDeleted: 0,
    auditLogsDeleted: 0,
  };

  // Pass 1: Clear images older than 14 days
  const imageCutoff = daysAgoISO(ID_IMAGE_RETENTION_DAYS);
  const ordersWithImages = await db
    .prepare(
      `SELECT order_id, id_image_url, luggage_image_url FROM luggage_orders
       WHERE created_at < ?
       AND (id_image_url IS NOT NULL OR luggage_image_url IS NOT NULL)`
    )
    .bind(imageCutoff)
    .all<{ order_id: string; id_image_url: string | null; luggage_image_url: string | null }>();

  const clearedOrderIds: string[] = [];
  for (const order of ordersWithImages.results) {
    // Delete images from R2 — only mark cleared if all deletes succeed
    const keysToDelete: string[] = [];
    if (order.id_image_url) keysToDelete.push(order.id_image_url);
    if (order.luggage_image_url) keysToDelete.push(order.luggage_image_url);

    let allDeleted = true;
    for (const key of keysToDelete) {
      try {
        await images.delete(key);
      } catch (e) {
        console.error(`Failed to delete R2 object ${key}:`, e);
        allDeleted = false;
      }
    }

    if (allDeleted) clearedOrderIds.push(order.order_id);
  }

  // Bulk UPDATE all cleared orders in one statement
  if (clearedOrderIds.length > 0) {
    const placeholders = clearedOrderIds.map(() => "?").join(",");
    await db
      .prepare(
        `UPDATE luggage_orders
         SET id_image_url = NULL, luggage_image_url = NULL, updated_at = datetime('now')
         WHERE order_id IN (${placeholders})`
      )
      .bind(...clearedOrderIds)
      .run();
    result.imagesCleared = clearedOrderIds.length;
  }

  // Customer order data kept permanently — no deletion pass

  return result;
}

/** Get ISO string for N days ago. */
function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
