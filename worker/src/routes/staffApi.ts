/**
 * Staff API routes — JSON endpoints for dashboard interaction.
 * Handles order listing, inline editing, bulk actions, pickup/undo.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff, insertAuditLog } from "../middleware/auth";
import { calculateStorageDays, calculateExtraDays } from "../services/storage";
import { calculateExtraAmount } from "../services/pricing";

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
      values.push(val);
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

  // Log the update
  await insertAuditLog(c.env.DB, orderId, staff.id, "INLINE_UPDATE");

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

  const placeholders = body.order_ids.map(() => "?").join(",");
  await c.env.DB.prepare(
    `UPDATE luggage_orders SET status = ?, updated_at = datetime('now') WHERE order_id IN (${placeholders})`
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
    "SELECT * FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{
      order_id: string;
      expected_pickup_at: string;
      price_per_day: number;
      created_at: string;
    }>();

  if (!order) return c.json({ error: "Order not found" }, 404);

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

  await insertAuditLog(c.env.DB, orderId, staff.id, "PICKUP");

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

export default staffApi;
