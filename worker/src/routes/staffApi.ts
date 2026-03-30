/**
 * Staff API routes — JSON endpoints for dashboard interaction.
 * Handles order listing, inline editing, bulk actions, pickup/undo.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff, insertAuditLog } from "../middleware/auth";
import { calculateStorageDays, calculateExtraDays } from "../services/storage";
import { calculateExtraAmount, recalculateOrderPrepaid, normalizeFlyingPassTier } from "../services/pricing";
import type { FlyingPassTier } from "../services/pricing";

const staffApi = new Hono<AppType>();

// All routes require staff auth
staffApi.use("/*", staffAuth);

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

// GET /staff/api/orders/new — Check for new orders since a timestamp
staffApi.get("/staff/api/orders/new", async (c) => {
  const raw = c.req.query("since") || "";
  if (!raw) return c.json({ orders: [], count: 0 });
  // Normalize ISO string (2026-03-30T06:25:19.000Z) to D1 format (2026-03-30 06:25:19)
  const since = raw.replace("T", " ").replace(/\.\d+Z$/, "").replace("Z", "");
  const result = await c.env.DB.prepare(
    `SELECT order_id, name, tag_no, status, prepaid_amount, created_at, expected_pickup_at, note, payment_method, in_warehouse, parent_order_id, flying_pass_tier
     FROM luggage_orders WHERE created_at > ? ORDER BY created_at DESC`
  ).bind(since).all();
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

  return c.json({
    orders: result.results,
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

// POST /staff/api/orders/:id/inline-update — Inline field editing
staffApi.post("/staff/api/orders/:id/inline-update", async (c) => {
  const orderId = c.req.param("id");
  const body = await c.req.json<Record<string, string | number | null>>();
  const staff = getStaff(c);

  // Allowed fields for inline update
  const ALLOWED_FIELDS = ["name", "phone", "tag_no", "note", "expected_pickup_at", "flying_pass_tier"];
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, val] of Object.entries(body)) {
    if (ALLOWED_FIELDS.includes(key)) {
      updates.push(`${key} = ?`);
      // Convert JST datetime-local to UTC ISO for storage
      if (key === "expected_pickup_at" && val && typeof val === "string" && !val.endsWith("Z")) {
        const normalized = String(val).replace(/:\d{2}$/, "").slice(0, 16);
        values.push(new Date(normalized + ":00+09:00").toISOString());
      } else if (key === "flying_pass_tier" && typeof val === "string") {
        values.push(normalizeFlyingPassTier(val));
      } else if (key === "tag_no") {
        const tagNum = parseInt(String(val), 10);
        if (isNaN(tagNum) || tagNum < 1 || tagNum > 100) {
          return c.json({ error: "tag_no must be an integer between 1 and 100" }, 400);
        }
        values.push(tagNum);
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

  await c.env.DB.prepare(
    `UPDATE luggage_orders SET ${updates.join(", ")} WHERE order_id = ?`
  )
    .bind(...values)
    .run();

  // Log the update with field details
  const FIELD_LABELS: Record<string, string> = { name: "이름", phone: "전화", tag_no: "짐번호", note: "비고", expected_pickup_at: "픽업시각", flying_pass_tier: "패스" };
  const details = Object.entries(body)
    .filter(([k]) => ALLOWED_FIELDS.includes(k))
    .map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`)
    .join(", ");
  await insertAuditLog(c.env.DB, orderId, staff.id, "INLINE_UPDATE", details);

  return c.json({ success: true });
});

// POST /staff/api/orders/:id/toggle-warehouse — Toggle warehouse flag
staffApi.post("/staff/api/orders/:id/toggle-warehouse", async (c) => {
  const orderId = c.req.param("id");

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

  await insertAuditLog(c.env.DB, orderId, getStaff(c).id, "TOGGLE_WAREHOUSE", newVal ? "창고보관" : "창고해제");
  return c.json({ success: true, in_warehouse: !!newVal });
});

// POST /staff/api/orders/:id/cancel — Cancel order
staffApi.post("/staff/api/orders/:id/cancel", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "UPDATE luggage_orders SET status = 'CANCELLED', updated_at = datetime('now') WHERE order_id = ?"
  )
    .bind(orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "CANCEL");

  return c.json({ success: true });
});

// POST /staff/api/orders/bulk-action — Bulk status changes
staffApi.post("/staff/api/orders/bulk-action", async (c) => {
  const body = await c.req.json<{ order_ids: string[]; action: string }>();
  const staff = getStaff(c);

  if (staff.role === "viewer") {
    return c.json({ error: "Insufficient permissions" }, 403);
  }

  if (!body.order_ids?.length || !body.action) {
    return c.json({ error: "order_ids and action required" }, 400);
  }

  const validActions: Record<string, string> = {
    cancel: "CANCELLED",
    mark_paid: "PAID",
  };

  const newStatus = validActions[body.action];
  if (!newStatus) {
    return c.json({ error: "Invalid action" }, 400);
  }

  // Status guards: mark_paid only from PAYMENT_PENDING, cancel only non-PICKED_UP
  const statusGuard = body.action === "mark_paid"
    ? " AND status = 'PAYMENT_PENDING'"
    : body.action === "cancel"
      ? " AND status != 'PICKED_UP'"
      : "";

  const placeholders = body.order_ids.map(() => "?").join(",");
  await c.env.DB.prepare(
    `UPDATE luggage_orders SET status = ?, updated_at = datetime('now') WHERE order_id IN (${placeholders})${statusGuard}`
  )
    .bind(newStatus, ...body.order_ids)
    .run();

  // Log each action
  const stmts = body.order_ids.map((id) =>
    c.env.DB.prepare(
      "INSERT INTO luggage_audit_logs (order_id, staff_id, action, timestamp) VALUES (?, ?, ?, datetime('now'))"
    ).bind(id, staff.id, `BULK_${body.action.toUpperCase()}`)
  );
  if (stmts.length > 0) {
    await c.env.DB.batch(stmts);
  }

  return c.json({ success: true, updated: body.order_ids.length });
});

// POST /staff/api/orders/:id/pickup — Mark as picked up (inline)
staffApi.post("/staff/api/orders/:id/pickup", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);
  const now = new Date().toISOString();

  const order = await c.env.DB.prepare(
    "SELECT order_id, status, expected_pickup_at, price_per_day, created_at FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{
      order_id: string;
      status: string;
      expected_pickup_at: string;
      price_per_day: number;
      created_at: string;
    }>();

  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status !== "PAID") return c.json({ error: "결제 완료된 주문만 수령 처리할 수 있습니다" }, 400);

  // Calculate actual storage days and extra days
  const actualStorageDays = calculateStorageDays(order.created_at, now);
  const extraDays = order.expected_pickup_at
    ? calculateExtraDays(order.expected_pickup_at, now)
    : 0;
  const extraAmount = calculateExtraAmount(order.price_per_day, extraDays);

  await c.env.DB.prepare(
    `UPDATE luggage_orders
     SET status = 'PICKED_UP',
         actual_pickup_at = ?,
         actual_storage_days = ?,
         extra_days = ?,
         extra_amount = ?,
         updated_at = datetime('now')
     WHERE order_id = ?`
  )
    .bind(now, actualStorageDays, extraDays, extraAmount, orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "PICKUP", `실제보관 ${actualStorageDays}일, 초과 ${extraDays}일, 추가요금 ¥${extraAmount}`);

  return c.json({ success: true, extra_days: extraDays, extra_amount: extraAmount });
});

// POST /staff/api/orders/:id/undo-pickup — Revert pickup
staffApi.post("/staff/api/orders/:id/undo-pickup", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    `UPDATE luggage_orders
     SET status = 'PAID',
         actual_pickup_at = NULL,
         actual_storage_days = 0,
         extra_days = 0,
         extra_amount = 0,
         updated_at = datetime('now')
     WHERE order_id = ?`
  )
    .bind(orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "UNDO_PICKUP");

  return c.json({ success: true });
});

// POST /staff/api/orders/:id/toggle-payment — Toggle PAYMENT_PENDING <-> PAID
staffApi.post("/staff/api/orders/:id/toggle-payment", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  const order = await c.env.DB.prepare(
    "SELECT status FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{ status: string }>();

  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.status !== "PAYMENT_PENDING" && order.status !== "PAID") {
    return c.json({ error: "Cannot toggle payment for this status" }, 400);
  }

  const newStatus = order.status === "PAID" ? "PAYMENT_PENDING" : "PAID";
  await c.env.DB.prepare(
    "UPDATE luggage_orders SET status = ?, updated_at = datetime('now') WHERE order_id = ?"
  )
    .bind(newStatus, orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "TOGGLE_PAYMENT", `${order.status} → ${newStatus}`);

  return c.json({ success: true, status: newStatus });
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

  const order = await c.env.DB.prepare(
    "SELECT price_per_day, expected_storage_days, prepaid_amount, flying_pass_tier, payment_method FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{
      price_per_day: number;
      expected_storage_days: number;
      prepaid_amount: number;
      flying_pass_tier: string;
      payment_method: string;
    }>();

  if (!order) return c.json({ error: "Order not found" }, 404);

  const tier = normalizeFlyingPassTier(body.flying_pass_tier ?? order.flying_pass_tier);
  const paymentMethod = body.payment_method ?? order.payment_method ?? "CASH";

  const { finalPrepaid, flyingPassDiscountAmount: passDiscount } = recalculateOrderPrepaid(
    order.price_per_day,
    order.expected_storage_days,
    tier
  );

  // If staff override is provided, use that; otherwise use calculated amount
  const overrideAmount = body.staff_prepaid_override_amount;
  if (overrideAmount != null && (overrideAmount < 0 || overrideAmount > 500000)) {
    return c.json({ error: "Override amount out of range (0-500000)" }, 400);
  }
  const finalAmount = overrideAmount != null ? overrideAmount : finalPrepaid;

  await c.env.DB.prepare(
    `UPDATE luggage_orders
     SET payment_method = ?, flying_pass_tier = ?, flying_pass_discount_amount = ?,
         prepaid_amount = ?, final_amount = ?,
         staff_prepaid_override_amount = ?,
         updated_at = datetime('now')
     WHERE order_id = ?`
  )
    .bind(
      paymentMethod,
      tier,
      passDiscount,
      finalAmount,
      finalAmount,
      overrideAmount ?? null,
      orderId
    )
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "UPDATE_PRICE", `패스: ${tier}, 결제수단: ${paymentMethod}, 금액: ¥${finalAmount}`);

  return c.json({ success: true, prepaid_amount: finalAmount, flying_pass_tier: tier, payment_method: paymentMethod });
});

export default staffApi;
