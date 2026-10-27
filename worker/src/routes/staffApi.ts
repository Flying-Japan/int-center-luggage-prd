import { writePickupTransition, PickupTransitionError } from '../services/orderPickupWrites';
import { confirmCollection, getBillingSummary, getBillingSummaries, getCancellationBlock, requiresCollectionFlow } from '../services/luggageBilling';
/**
 * Staff API routes — JSON endpoints for dashboard interaction.
 * Handles order listing, inline editing, bulk actions, pickup/undo.
 */
import { Hono, type Context } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff, insertAuditLog } from "../middleware/auth";
import { recalculateOrderPrepaid, normalizeFlyingPassTier } from "../services/pricing";
import type { FlyingPassTier } from "../services/pricing";
import { getDashboardSyncToken } from "../lib/dashboardSync";
import {
  normalizePaymentAllocation,
  payableAmountFromOrder,
  paymentAllocationDetails,
  paymentAllocationStatements,
} from "../lib/payments";

const staffApi = new Hono<AppType>();

// All routes require staff auth
staffApi.use("/*", staffAuth);

function canEditOrders(role: string): boolean {
  return role === "admin" || role === "editor";
}

function denyEditorOnlyJson(c: Context<AppType>) {
  return c.json({ error: "편집자 또는 관리자 권한이 필요합니다" }, 403);
}

/** Build the shared WHERE clause fragment and params for order filtering. */
function buildOrderFilters(
  status: string,
  warehouse: string,
  search: string
): { clause: string; params: (string | number)[] } {
  let clause = "";
  const params: (string | number)[] = [];

  if (status && status !== "ALL") {
    clause += " AND status = ?";
    params.push(status);
  }

  if (warehouse === "true") {
    clause += " AND in_warehouse = 1";
  }

  if (search) {
    clause += " AND (name LIKE ? OR phone LIKE ? OR order_id LIKE ? OR tag_no LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  return { clause, params };
}

// POST /staff/api/referral — Increment/decrement referral count
staffApi.post("/staff/api/referral", async (c) => {
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  const body = await c.req.json<{ floor: string; delta: number }>();
  if (!["4F", "8F"].includes(body.floor)) return c.json({ error: "Invalid floor" }, 400);
  const delta = body.delta === -1 ? -1 : 1;
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const businessDate = now.toISOString().slice(0, 10);
  await c.env.DB.prepare(
    `INSERT INTO luggage_referral_counts (business_date, floor, count) VALUES (?, ?, ?)
     ON CONFLICT(business_date, floor) DO UPDATE SET count = MAX(0, count + ?), updated_at = datetime('now')`
  ).bind(businessDate, body.floor, Math.max(0, delta), delta).run();
  const row = await c.env.DB.prepare(
    "SELECT count FROM luggage_referral_counts WHERE business_date = ? AND floor = ?"
  ).bind(businessDate, body.floor).first<{ count: number }>();
  return c.json({ floor: body.floor, count: row?.count ?? 0 });
});

// GET /staff/api/referral — Get today's referral counts
staffApi.get("/staff/api/referral", async (c) => {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const businessDate = now.toISOString().slice(0, 10);
  const rows = await c.env.DB.prepare(
    "SELECT floor, count FROM luggage_referral_counts WHERE business_date = ?"
  ).bind(businessDate).all<{ floor: string; count: number }>();
  const counts: Record<string, number> = { "4F": 0, "8F": 0 };
  for (const r of rows.results) counts[r.floor] = r.count;
  return c.json(counts);
});

// GET /staff/api/handover/unread — Unread handover notes count for current staff
staffApi.get("/staff/api/handover/unread", async (c) => {
  const staff = getStaff(c);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM luggage_handover_notes n
     WHERE n.staff_id != ?
       AND NOT EXISTS (SELECT 1 FROM luggage_handover_reads r WHERE r.note_id = n.note_id AND r.staff_id = ?)`
  ).bind(staff.id, staff.id).first<{ count: number }>();
  return c.json({ count: row?.count ?? 0 });
});

// GET /staff/api/orders/new — Check for new orders since a timestamp
staffApi.get("/staff/api/orders/new", async (c) => {
  const raw = c.req.query("since") || "";
  if (!raw) return c.json({ orders: [], count: 0 });
  const result = await c.env.DB.prepare(
    `SELECT order_id, name, tag_no, status, prepaid_amount, created_at, expected_pickup_at, note, payment_method, in_warehouse, parent_order_id, flying_pass_tier
     FROM luggage_orders
     WHERE parent_order_id IS NULL
       AND datetime(created_at) > datetime(?)
     ORDER BY datetime(created_at) DESC`
  ).bind(raw).all();
  return c.json({ orders: result.results, count: result.results.length });
});

// GET /staff/api/orders — List orders with filtering, search, pagination
staffApi.get("/staff/api/orders", async (c) => {
  const status = c.req.query("status") || "";
  const search = c.req.query("search") || "";
  const warehouse = c.req.query("warehouse") || "";
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const offset = parseInt(c.req.query("offset") || "0", 10);

  const { clause, params } = buildOrderFilters(status, warehouse, search);

  const result = await c.env.DB.prepare(
    `SELECT * FROM luggage_orders WHERE 1=1${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM luggage_orders WHERE 1=1${clause}`
  )
    .bind(...params)
    .first<{ total: number }>();

  const billings = await getBillingSummaries(c.env.DB, result.results.map(o => String(o.order_id)));
  return c.json({
    orders: result.results.map((order) => ({
      ...order, billing: billings.get(String(order.order_id)) ?? null,
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// GET /staff/api/orders/dashboard-sync — Polling token for dashboard auto-refresh
staffApi.get("/staff/api/orders/dashboard-sync", async (c) => {
  const token = await getDashboardSyncToken(c.env.DB, {
    q: c.req.query("q") || "",
    status: c.req.query("status") || "UNPICKED",
    showAllPickedUp: c.req.query("show_all_picked_up") === "true",
    dateFrom: c.req.query("date_from") || "",
    dateTo: c.req.query("date_to") || "",
  });

  return c.json({ token });
});

// Confirm money received on site; staffAuth plus editor/admin role are both required.
staffApi.post('/staff/api/orders/:id/confirm-collection', async (c) => {
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  try {
    const body = await c.req.json<Record<string, unknown>>();
    return c.json({ success: true, ...await confirmCollection(c.env.DB, c.req.param('id'), staff.id, body) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '수납 처리 실패' }, 409);
  }
});

// POST /staff/api/orders/:id/inline-update — Inline field editing
staffApi.post("/staff/api/orders/:id/inline-update", async (c) => {
  const orderId = c.req.param("id");
  const body = await c.req.json<Record<string, string | number | null>>();
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);

  // Allowed fields for inline update
  const ALLOWED_FIELDS = ["name", "phone", "tag_no", "note", "expected_pickup_at", "flying_pass_tier"];
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, val] of Object.entries(body)) {
    if (ALLOWED_FIELDS.includes(key)) {
      updates.push(`${key} = ?`);
      // Convert JST datetime-local to UTC ISO for storage
      if (key === "expected_pickup_at") {
        if (typeof val !== 'string' || !val.trim()) return c.json({ error: '픽업 날짜는 비울 수 없습니다' }, 400);
        const parsed = new Date(val.endsWith('Z') ? val : val.slice(0, 16) + ':00+09:00');
        if (!Number.isFinite(parsed.getTime())) return c.json({ error: '유효한 픽업 날짜가 필요합니다' }, 400);
        values.push(parsed.toISOString());
      } else if (key === "flying_pass_tier" && typeof val === "string") {
        values.push(normalizeFlyingPassTier(val));
      } else if (key === "tag_no") {
        const tagNum = parseInt(String(val), 10);
        if (isNaN(tagNum) || tagNum < 1 || tagNum > 150) {
          return c.json({ error: "tag_no must be an integer between 1 and 150" }, 400);
        }
        values.push(String(tagNum));
      } else {
        values.push(val);
      }
    }
  }

  if (updates.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(orderId);

  // Log the update with field details
  const FIELD_LABELS: Record<string, string> = { name: "이름", phone: "전화", tag_no: "짐번호", note: "비고", expected_pickup_at: "픽업시각", flying_pass_tier: "패스" };
  const details = Object.entries(body)
    .filter(([k]) => ALLOWED_FIELDS.includes(k))
    .map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`)
    .join(", ");
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE luggage_orders SET ${updates.join(', ')} WHERE order_id = ?`).bind(...values),
      c.env.DB.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details)
        SELECT ?, ?, 'INLINE_UPDATE', ? WHERE changes() = 1`).bind(orderId, staff.id, details),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Preserve accrued extension coverage')) {
      return c.json({ error: '이미 확정된 연장 보관일은 변경할 수 없습니다', code: 'BILLING_HISTORY_LOCKED' }, 409);
    }
    throw error;
  }

  return c.json({ success: true });
});

// POST /staff/api/orders/:id/toggle-warehouse — Toggle warehouse flag
staffApi.post("/staff/api/orders/:id/toggle-warehouse", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);

  const order = await c.env.DB.prepare(
    "SELECT in_warehouse FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{ in_warehouse: number }>();

  if (!order) return c.json({ error: "Order not found" }, 404);

  const newVal = order.in_warehouse ? 0 : 1;
  await c.env.DB.prepare(
    "UPDATE luggage_orders SET in_warehouse = ?, updated_at = datetime('now') WHERE order_id = ?"
  )
    .bind(newVal, orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "TOGGLE_WAREHOUSE", newVal ? "창고보관" : "창고해제");
  return c.json({ success: true, in_warehouse: !!newVal });
});

// POST /staff/api/orders/:id/cancel — Legacy drafts only when the shared financial policy permits it.
staffApi.post('/staff/api/orders/:id/cancel', async (c) => {
  const orderId = c.req.param('id');
  if (!orderId) return c.json({ error: 'Order ID required' }, 400);
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  const current = await c.env.DB.prepare(`SELECT status, updated_at, parent_order_id, prepaid_amount,
    final_amount, extra_amount FROM luggage_orders WHERE order_id = ?`).bind(orderId)
    .first<{ status: string; updated_at: string; parent_order_id: string | null; prepaid_amount: number; final_amount: number | null; extra_amount: number }>();
  if (!current) return c.json({ error: 'Order not found' }, 404);
  const code = await getCancellationBlock(c.env.DB, orderId);
  if (code) return c.json({ error: code === 'ROOT_SETTLEMENT_REVIEW_REQUIRED' ? '기존 원주문 정산 확인 필요: 취소할 수 없습니다' : '확정 연장/수납 내역은 별도 정정 정책이 필요합니다', code }, 409);
  try {
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE luggage_orders SET status = 'CANCELLED', updated_at = datetime('now')
        WHERE order_id = ? AND status = ? AND updated_at = ? RETURNING order_id`)
        .bind(orderId, current.status, current.updated_at),
      c.env.DB.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details)
        SELECT ?, ?, 'CANCEL', ? WHERE changes() = 1`).bind(orderId, staff.id,
        JSON.stringify({ before: current, after: { status: 'CANCELLED' }, policy: 'LEGACY_UNCOLLECTED_DRAFT_OR_STANDALONE' })),
    ]);
    if (!result[0].results?.length) return c.json({ error: 'Order was changed by another request' }, 409);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof Error && (error.message.includes('Extension cancellation requires an approved policy') || error.message.includes('Preserve original settlement review'))) {
      const code = await getCancellationBlock(c.env.DB, orderId) ?? 'EXTENSION_POLICY_REQUIRED';
      return c.json({ error: '정산 또는 연장 상태가 변경되었습니다. 정정 정책 확인이 필요합니다', code }, 409);
    }
    throw error;
  }
});

// POST /staff/api/orders/bulk-action — Bulk status changes
staffApi.post("/staff/api/orders/bulk-action", async (c) => {
  const body = await c.req.json<{ order_ids: string[]; action: string; payment_method?: string }>();
  const staff = getStaff(c);

  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);

  if (!body.order_ids?.length || !body.action) {
    return c.json({ error: "order_ids and action required" }, 400);
  }
  if (body.order_ids.length > 100) {
    return c.json({ error: "최대 100건까지 일괄 처리 가능합니다" }, 400);
  }

  for (const id of body.order_ids) {
    if (await requiresCollectionFlow(c.env.DB, id)) {
      const summary = await getBillingSummary(c.env.DB, id);
      return c.json({ error: summary?.root_review_required ? '기존 원주문 정산 확인 필요: 일괄 처리로 정산 차이를 변경할 수 없습니다' : '연장/추가금 주문은 일괄 처리할 수 없습니다. 상세 화면에서 수납을 확인해주세요.' }, 409);
    }
  }

  const validActions: Record<string, string> = {
    cancel: "CANCELLED",
    mark_paid: "PAID",
  };

  const newStatus = validActions[body.action];
  if (!newStatus) {
    return c.json({ error: "Invalid action" }, 400);
  }

  const placeholders = body.order_ids.map(() => "?").join(",");
  let updatedCount = 0;
  let auditDetails = "";

  if (body.action === "mark_paid") {
    const pendingOrders = await c.env.DB.prepare(
      `SELECT order_id, date(created_at, '+9 hours') as business_date,
              prepaid_amount, final_amount, extra_amount
       FROM luggage_orders
       WHERE order_id IN (${placeholders}) AND status = 'PAYMENT_PENDING'`
    )
      .bind(...body.order_ids)
      .all<{
        order_id: string;
        business_date: string;
        prepaid_amount: number;
        final_amount: number | null;
        extra_amount: number | null;
      }>();
    if (pendingOrders.results.length === 0) return c.json({ success: true, updated: 0 });

    const statements: D1PreparedStatement[] = [];
    const updateIndexes: number[] = [];
    for (const order of pendingOrders.results) {
      const payableAmount = payableAmountFromOrder(order);
      const allocation = normalizePaymentAllocation(body as Record<string, unknown>, payableAmount);
      if ("error" in allocation) return c.json({ error: allocation.error }, 400);
      // Re-checked at write time (the SELECT above can be stale): an order that is no longer PAYMENT_PENDING keeps its payment rows
      // and gets no audit row; the audit row is inserted before the status change, in the same batch.
      statements.push(...paymentAllocationStatements(c.env.DB, order.order_id, order.business_date, staff.id, allocation, "PAYMENT_PENDING"));
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO luggage_audit_logs (order_id, staff_id, action, details, timestamp)
           SELECT ?, ?, ?, ?, datetime('now')
           WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAYMENT_PENDING')`
        ).bind(order.order_id, staff.id, `BULK_${body.action.toUpperCase()}`, paymentAllocationDetails(allocation), order.order_id)
      );
      statements.push(
        c.env.DB.prepare(
          `UPDATE luggage_orders
           SET status = ?, payment_method = ?, updated_at = datetime('now')
           WHERE order_id = ? AND status = 'PAYMENT_PENDING'
           RETURNING order_id`
        ).bind(newStatus, allocation.paymentMethod, order.order_id)
      );
      updateIndexes.push(statements.length - 1);
    }
    const results = await c.env.DB.batch(statements);
    updatedCount = updateIndexes.filter((index) => results[index].results?.[0]).length;
    auditDetails = "handled";
  } else {
    const result = await c.env.DB.prepare(
      `UPDATE luggage_orders
       SET status = ?, updated_at = datetime('now')
       WHERE order_id IN (${placeholders}) AND status != 'PICKED_UP'`
    )
      .bind(newStatus, ...body.order_ids)
      .run();
    updatedCount = result.meta.changes || 0;
  }

  // Log each action
  if (!auditDetails) {
    const stmts = body.order_ids.map((id) =>
      c.env.DB.prepare(
        "INSERT INTO luggage_audit_logs (order_id, staff_id, action, details, timestamp) VALUES (?, ?, ?, ?, datetime('now'))"
      ).bind(id, staff.id, `BULK_${body.action.toUpperCase()}`, null)
    );
    if (stmts.length > 0) {
      await c.env.DB.batch(stmts);
    }
  }

  return c.json({ success: true, updated: updatedCount });
});

// POST /staff/api/orders/:id/pickup — Mark as picked up (inline)
staffApi.post("/staff/api/orders/:id/pickup", async (c) => {
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  try {
    const updated = await writePickupTransition(c.env.DB, c.req.param("id"), 'mark_picked_up', {
      action: 'PICKUP', staffId: staff.id,
    });
    return c.json({ success: true, extra_days: updated.extraDays, extra_amount: 0 });
  } catch (error) {
    if (error instanceof PickupTransitionError) return c.json({ error: error.message }, error.code === 'NOT_PAID' ? 400 : error.status);
    throw error;
  }
});

// POST /staff/api/orders/:id/undo-pickup — Revert the recorded family pickup atomically.
staffApi.post("/staff/api/orders/:id/undo-pickup", async (c) => {
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  try {
    await writePickupTransition(c.env.DB, c.req.param("id"), 'undo_picked_up', { action: 'UNDO_PICKUP', staffId: staff.id });
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof PickupTransitionError) return c.json({ error: error.message }, error.status);
    throw error;
  }
});

// POST /staff/api/orders/:id/toggle-payment — Toggle PAYMENT_PENDING <-> PAID
staffApi.post("/staff/api/orders/:id/toggle-payment", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);
  if (await requiresCollectionFlow(c.env.DB, orderId)) {
    const summary = await getBillingSummary(c.env.DB, orderId);
    return c.json({ error: summary?.root_review_required ? '기존 원주문 정산 확인 필요: 결제 토글이나 재수납으로 정산 차이를 처리할 수 없습니다' : '연장 주문은 상세 화면의 현장 수납 확인을 이용해주세요. 임의 취소는 불가합니다.' }, 409);
  }

  const order = await c.env.DB.prepare(
    `SELECT status, payment_method, date(created_at, '+9 hours') as business_date,
            prepaid_amount, final_amount, extra_amount
     FROM luggage_orders WHERE order_id = ?`
  )
    .bind(orderId)
    .first<{
      status: string;
      payment_method: string | null;
      business_date: string;
      prepaid_amount: number;
      final_amount: number | null;
      extra_amount: number | null;
    }>();

  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status !== "PAYMENT_PENDING" && order.status !== "PAID") {
    return c.json({ error: "Cannot toggle payment for this status" }, 400);
  }

  // Same policy as the unified admin: a payment recorded as PAID is never reverted directly (collection history is preserved).
  if (order.status === "PAID") {
    return c.json({ error: "이미 기록된 결제는 직접 취소할 수 없습니다. 관리자에게 확인해 주세요.", code: "PAYMENT_REVERT_NOT_ALLOWED" }, 409);
  }

  const newStatus = "PAID";
  const toggleBody = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
  const payableAmount = payableAmountFromOrder(order);
  const allocation = normalizePaymentAllocation(toggleBody, payableAmount);
  if ("error" in allocation) return c.json({ error: allocation.error }, 400);
  const paymentMethod = allocation.paymentMethod;
  const paymentDetails = paymentAllocationDetails(allocation);
  // The status is checked again where the write happens (the SELECT above can be stale): a repeated or concurrent toggle
  // changes nothing, so an existing payment row is never deleted and re-created. The audit row commits or rolls back with the write.
  const results = await c.env.DB.batch([
    ...paymentAllocationStatements(c.env.DB, orderId, order.business_date, staff.id, allocation, "PAYMENT_PENDING"),
    c.env.DB.prepare(
      `INSERT INTO luggage_audit_logs (order_id, staff_id, action, details, timestamp)
       SELECT ?, ?, 'TOGGLE_PAYMENT', ?, datetime('now')
       WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAYMENT_PENDING')`
    ).bind(orderId, staff.id, `${order.status} → ${newStatus}${paymentDetails ? `, ${paymentDetails}` : ""}`, orderId),
    c.env.DB.prepare(
      "UPDATE luggage_orders SET status = ?, payment_method = ?, updated_at = datetime('now') WHERE order_id = ? AND status = 'PAYMENT_PENDING' RETURNING order_id"
    ).bind(newStatus, paymentMethod, orderId),
  ]);
  if (!results[results.length - 1].results?.[0]) return c.json({ error: "Payment status was changed by another request" }, 409);

  return c.json({ success: true, status: newStatus, payment_method: paymentMethod });
});

// POST /staff/api/orders/:id/update-price — Update payment method, tier, override amount
staffApi.post("/staff/api/orders/:id/update-price", async (c) => {
  const orderId = c.req.param("id");
  const body = await c.req.json<{
    payment_method?: string;
    flying_pass_tier?: string;
    staff_prepaid_override_amount?: number | null;
  }>();
  const staff = getStaff(c);
  if (!canEditOrders(staff.role)) return denyEditorOnlyJson(c);

  const order = await c.env.DB.prepare(
    "SELECT price_per_day, expected_storage_days, prepaid_amount, final_amount, extra_amount, staff_prepaid_override_amount, flying_pass_tier, flying_pass_discount_amount, payment_method, updated_at, (SELECT COUNT(*) FROM luggage_order_payments p WHERE p.order_id = luggage_orders.order_id) AS payment_count FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{
      price_per_day: number;
      payment_count: number;
      flying_pass_discount_amount: number;
      expected_storage_days: number;
      prepaid_amount: number;
      final_amount: number | null;
      extra_amount: number;
      staff_prepaid_override_amount: number | null;
      updated_at: string;
      flying_pass_tier: string;
      payment_method: string;
    }>();

  if (!order) return c.json({ error: "Order not found" }, 404);

  const tier = normalizeFlyingPassTier(body.flying_pass_tier ?? order.flying_pass_tier);
  const requestedPaymentMethod = body.payment_method ?? order.payment_method ?? "CASH";
  const paymentMethod = ["CASH", "PAY_QR"].includes(String(requestedPaymentMethod))
    ? String(requestedPaymentMethod)
    : "";
  if (!paymentMethod) return c.json({ error: "Invalid payment method" }, 400);

  const { finalPrepaid, flyingPassDiscountAmount: passDiscount } = recalculateOrderPrepaid(
    order.price_per_day,
    order.expected_storage_days,
    tier
  );

  // If staff override is provided, use that; otherwise use calculated amount
  const overrideAmount = body.staff_prepaid_override_amount;
  if (overrideAmount != null && (!Number.isSafeInteger(overrideAmount) || overrideAmount < 0 || overrideAmount > 500000)) {
    return c.json({ error: "Override amount out of range (0-500000)" }, 400);
  }
  const metadataOnly = order.payment_count > 0 && body.flying_pass_tier === undefined && body.staff_prepaid_override_amount === undefined;
  const finalAmount = metadataOnly ? order.final_amount : overrideAmount != null ? overrideAmount : finalPrepaid;
  const prepaidAmount = metadataOnly ? order.prepaid_amount : finalAmount;
  const storedOverride = metadataOnly ? order.staff_prepaid_override_amount : overrideAmount ?? null;
  const storedDiscount = metadataOnly ? order.flying_pass_discount_amount : passDiscount;
  if (order.payment_count > 0 && (prepaidAmount !== order.prepaid_amount || finalAmount !== order.final_amount)) {
    return c.json({ error: '수납 원장이 있는 주문의 금액 정정은 별도 정산 확인이 필요합니다', code: 'COLLECTED_PRICE_REVIEW_REQUIRED' }, 409);
  }

  let result: D1Result[];
  try {
    result = await c.env.DB.batch([c.env.DB.prepare(
    `UPDATE luggage_orders
     SET payment_method = ?, flying_pass_tier = ?, flying_pass_discount_amount = ?,
         prepaid_amount = ?, final_amount = ?,
         staff_prepaid_override_amount = ?,
         updated_at = datetime('now')
     WHERE order_id = ? AND updated_at = ? AND prepaid_amount = ? AND final_amount IS ? AND payment_method IS ?
       AND flying_pass_tier IS ? AND flying_pass_discount_amount = ? AND staff_prepaid_override_amount IS ? AND extra_amount = ?`
  )
    .bind(
      paymentMethod,
      tier,
      storedDiscount,
      prepaidAmount,
      finalAmount,
      storedOverride,
      orderId, order.updated_at, order.prepaid_amount, order.final_amount, order.payment_method,
      order.flying_pass_tier, order.flying_pass_discount_amount, order.staff_prepaid_override_amount, order.extra_amount
    ), c.env.DB.prepare(`INSERT INTO luggage_audit_logs(order_id, staff_id, action, details)
      SELECT ?, ?, 'UPDATE_PRICE', ? WHERE changes() = 1`).bind(orderId, staff.id,
        JSON.stringify({ before: order, after: { tier, paymentMethod, prepaidAmount, finalAmount, overrideAmount: storedOverride, policy: metadataOnly ? 'COLLECTED_METADATA_ONLY' : 'PRICE_UPDATE' }, staffId: staff.id }))]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Collected amounts require a separate correction policy')) return c.json({ error: '수납 내역이 변경되었습니다. 별도 정산 확인이 필요합니다', code: 'COLLECTED_PRICE_REVIEW_REQUIRED' }, 409);
    throw error;
  }
  if (result[0].meta.changes !== 1) return c.json({ error: '금액이 변경되었습니다. 새로고침 후 다시 확인해주세요' }, 409);

  return c.json({ success: true, prepaid_amount: prepaidAmount, flying_pass_tier: tier, payment_method: paymentMethod });
});

export default staffApi;
