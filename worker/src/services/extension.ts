/** Automatic extension generation. Cron timing and the caller's flag remain unchanged. */
import { materializeOutstandingDays } from './luggageBilling';

export async function generateExtensionOrders(db: D1Database) {
  const ids = await materializeOutstandingDays(db);
  const extendedOrders: Array<{ parentOrderId: string; extOrderId: string; name: string; email: string | null; phone: string; tagNo: string; amount: number }> = [];
  for (const id of ids) {
    const row = await db.prepare(`SELECT e.parent_order_id AS parentOrderId, e.order_id AS extOrderId,
      COALESCE(e.name, '') AS name, e.email, COALESCE(e.phone, '') AS phone,
      COALESCE(e.tag_no, '') AS tagNo, e.prepaid_amount AS amount FROM luggage_orders e WHERE e.order_id = ?`)
      .bind(id).first<(typeof extendedOrders)[number]>();
    if (row) extendedOrders.push(row);
  }
  if (ids.length) await db.prepare(`INSERT INTO luggage_handover_notes(category, title, content, staff_id)
    VALUES ('URGENT', ?, ?, 'SYSTEM')`).bind(`[자동] 미수령 연장 ${ids.length}건`,
      extendedOrders.map(o => `${o.parentOrderId} → ${o.extOrderId} (¥${o.amount.toLocaleString()}, 추가 결제 필요)`).join('\n')).run();
  return { created: ids.length, skippedDup: 0, extendedOrders };
}
