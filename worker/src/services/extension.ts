/**
 * Automatic extension order generation for overdue luggage orders.
 * Ported from Python: app/services/extension.py
 */

import { buildOrderId } from "./orderNumber";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toSqliteDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Build an extension order record from a parent order row. */
async function buildExtensionOrderRecord(
  db: D1Database,
  parent: Record<string, unknown>,
  rootId: string,
  now: Date
): Promise<Record<string, unknown>> {
  const jstMs = now.getTime() + JST_OFFSET_MS;
  const jst = new Date(jstMs);

  // Target pickup: today at 21:00 JST = 12:00 UTC
  const pickupUtc = new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 12, 0, 0)
  );

  const orderId = `EXT-${await buildOrderId(db, now, false, 'ext')}`;
  const pricePerDay = Number(parent.price_per_day ?? 0);

  return {
    order_id: orderId,
    created_at: toSqliteDateTime(now),
    name: parent.name,
    phone: parent.phone,
    companion_count: 0,
    suitcase_qty: parent.suitcase_qty,
    backpack_qty: parent.backpack_qty,
    set_qty: parent.set_qty,
    expected_pickup_at: pickupUtc.toISOString(),
    expected_storage_days: 1,
    actual_storage_days: null,
    extra_days: 0,
    price_per_day: pricePerDay,
    discount_rate: 0,
    prepaid_amount: pricePerDay,
    flying_pass_tier: "NONE",
    flying_pass_discount_amount: 0,
    staff_prepaid_override_amount: null,
    extra_amount: 0,
    final_amount: pricePerDay,
    payment_method: null,
    status: "PAYMENT_PENDING",
    tag_no: parent.tag_no ?? "",
    note: `자동연장 (${rootId})`,
    id_image_url: null,
    luggage_image_url: null,
    consent_checked: 1,
    manual_entry: 0,
    staff_id: null,
    parent_order_id: rootId,
    in_warehouse: parent.in_warehouse ? 1 : 0,
  };
}

/**
 * Find overdue root orders and create extension order lines.
 * Returns { created, skippedDup }.
 */
export async function generateExtensionOrders(
  db: D1Database
): Promise<{ created: number; skippedDup: number; extendedOrders: Array<{ parentOrderId: string; extOrderId: string; name: string; email: string | null; phone: string; tagNo: string; amount: number }> }> {
  const now = new Date();
  const jstMs = now.getTime() + JST_OFFSET_MS;
  const jst = new Date(jstMs);

  // 1. Find overdue root orders (status PAID or PAYMENT_PENDING, past expected pickup, no parent)
  const overdueRows = await db
    .prepare(
      `SELECT * FROM luggage_orders
       WHERE status IN ('PAID', 'PAYMENT_PENDING')
         AND expected_pickup_at < ?
         AND parent_order_id IS NULL`
    )
    .bind(now.toISOString())
    .all<Record<string, unknown>>();

  if (overdueRows.results.length === 0) {
    return { created: 0, skippedDup: 0, extendedOrders: [] };
  }

  // 2. Dedup: find extensions already created today for these root order IDs
  const rootIds = overdueRows.results.map((o) => String(o.order_id));

  // Today JST window in UTC
  const todayStartUtc = new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) - JST_OFFSET_MS
  );
  const tomorrowStartUtc = new Date(todayStartUtc.getTime() + 24 * 60 * 60 * 1000);

  const placeholders = rootIds.map(() => "?").join(",");
  const existingRows = await db
    .prepare(
      `SELECT parent_order_id FROM luggage_orders
       WHERE parent_order_id IN (${placeholders})
         AND created_at >= ?
         AND created_at < ?`
    )
    .bind(...rootIds, todayStartUtc.toISOString(), tomorrowStartUtc.toISOString())
    .all<{ parent_order_id: string }>();

  const alreadyExtended = new Set(existingRows.results.map((r) => r.parent_order_id));

  let created = 0;
  let skippedDup = 0;
  const extendedOrders: Array<{ parentOrderId: string; extOrderId: string; name: string; email: string | null; phone: string; tagNo: string; amount: number }> = [];

  for (const order of overdueRows.results) {
    const orderId = String(order.order_id);
    if (alreadyExtended.has(orderId)) {
      skippedDup++;
      continue;
    }

    const record = await buildExtensionOrderRecord(db, order, orderId, now);

    await db
      .prepare(
        `INSERT INTO luggage_orders (
          order_id, created_at, name, phone, companion_count,
          suitcase_qty, backpack_qty, set_qty,
          expected_pickup_at, expected_storage_days,
          extra_days, price_per_day, discount_rate, prepaid_amount,
          flying_pass_tier, flying_pass_discount_amount,
          extra_amount, final_amount, payment_method,
          status, tag_no, note, id_image_url, luggage_image_url,
          consent_checked, manual_entry, staff_id, parent_order_id, in_warehouse
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )`
      )
      .bind(
        record.order_id,
        record.created_at,
        record.name,
        record.phone,
        record.companion_count,
        record.suitcase_qty,
        record.backpack_qty,
        record.set_qty,
        record.expected_pickup_at,
        record.expected_storage_days,
        record.extra_days,
        record.price_per_day,
        record.discount_rate,
        record.prepaid_amount,
        record.flying_pass_tier,
        record.flying_pass_discount_amount,
        record.extra_amount,
        record.final_amount,
        record.payment_method,
        record.status,
        record.tag_no,
        record.note,
        record.id_image_url,
        record.luggage_image_url,
        record.consent_checked,
        record.manual_entry,
        record.staff_id,
        record.parent_order_id,
        record.in_warehouse
      )
      .run();

    extendedOrders.push({
      parentOrderId: orderId,
      extOrderId: String(record.order_id),
      name: String(order.name || ""),
      email: (order.email as string) || null,
      phone: String(order.phone || ""),
      tagNo: String(order.tag_no || ""),
      amount: Number(record.prepaid_amount || 0),
    });
    created++;
  }

  // Create handover note if any extensions were made
  if (created > 0) {
    const jstDateStr = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    const lines = extendedOrders.map(o => `• ${o.tagNo} ${o.name} → ${o.extOrderId} (¥${o.amount.toLocaleString()})`);
    await db.prepare(
      `INSERT INTO luggage_handover_notes (category, title, content, staff_id, created_at)
       VALUES ('URGENT', ?, ?, 'SYSTEM', datetime('now'))`
    ).bind(
      `[자동] 미수령 연장 ${created}건 (${jstDateStr})`,
      `다음 주문이 수령 기한 초과로 자동 연장 처리되었습니다.\n추가 요금 수령이 필요합니다.\n\n${lines.join("\n")}`
    ).run();
  }

  return { created, skippedDup, extendedOrders };
}
