import { Hono } from "hono";
import type { AppType } from "../types";
import { internalAuth } from "../middleware/internalAuth";

const internalApi = new Hono<AppType>();
// Mounted via `app.route("/", internalApi)` in index.tsx, so a bare "/*" here
// would swallow every request on the worker. Scope the auth middleware to the
// prefix we actually own so /customer, /login, /admin, etc. stay untouched.
internalApi.use("/internal/*", internalAuth);

const EXPERIENCE_STATUSES = new Set(["SCHEDULED", "VISITED", "RECEIVED", "CANCELLED"]);
const EXPERIENCE_VISITOR_TYPES = new Set(["BLOGGER", "INFLUENCER", "YOUTUBER", "OTHER"]);
const EXPERIENCE_BENEFIT_TYPES = new Set(["GIFT_CARD", "CASH", "PRODUCT", "OTHER", "REVIEWER_EXPERIENCE"]);
const LUGGAGE_NOTE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin"]);
const LUGGAGE_ORDER_ID_PATTERN = /^(?:EXT-)?\d{8}-\d{3,10}$/;

// Stable response shape for callers. Prevents raw D1 columns from leaking
// into the contract — future schema additions stay internal unless we
// explicitly surface them here.
type ExperienceVisitDto = {
  externalId: string | null;
  visitorName: string | null;
  visitorType: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  benefitType: string | null;
  benefitLabel: string | null;
  benefitAmount: string | null;
  status: string | null;
  note: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  processedByStaffId: string | null;
  createdByStaffId: string | null;
  piiMaskedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function serializeVisit(row: Record<string, unknown> | null): ExperienceVisitDto | null {
  if (!row) return null;
  const str = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    benefitAmount: str(row.benefit_amount),
    benefitLabel: str(row.benefit_label),
    benefitType: str(row.benefit_type),
    createdAt: str(row.created_at),
    createdByStaffId: str(row.created_by_staff_id),
    externalId: str(row.external_id),
    note: str(row.note),
    piiMaskedAt: str(row.pii_masked_at),
    processedByStaffId: str(row.processed_by_staff_id),
    receivedAt: str(row.received_at),
    receivedBy: str(row.received_by),
    scheduledDate: str(row.scheduled_date),
    scheduledTime: str(row.scheduled_time),
    status: str(row.status),
    updatedAt: str(row.updated_at),
    visitorName: str(row.visitor_name),
    visitorType: str(row.visitor_type),
  };
}

type LuggageOrderDto = {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  suitcaseQty: number;
  backpackQty: number;
  setQty: number;
  expectedPickupAt: string | null;
  actualPickupAt: string | null;
  expectedStorageDays: number;
  actualStorageDays: number;
  prepaidAmount: number;
  finalAmount: number;
  extraAmount: number;
  paymentMethod: string | null;
  status: string;
  tagNo: string | null;
  note: string | null;
  manualEntry: number;
  parentOrderId: string | null;
  inWarehouse: number;
  flyingPassTier: string;
  paymentCashAmount: number;
  paymentQrAmount: number;
};

function parsePaginationQuery(value: string | undefined, fallback: number, maximum?: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function parseJstDateQuery(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : null;
}

// GET /internal/luggage-orders — Read-only order list for the integrated admin.
internalApi.get("/internal/luggage-orders", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("search");
  const dateFrom = parseJstDateQuery(c.req.query("dateFrom"));
  const dateTo = parseJstDateQuery(c.req.query("dateTo"));
  const limit = parsePaginationQuery(c.req.query("limit"), 100, 500);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (status) {
    clauses.push("o.status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(o.order_id LIKE ? OR o.name LIKE ? OR o.phone LIKE ? OR o.tag_no LIKE ?)");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  // created_at is stored in UTC; SQLite applies +9 hours before comparing its
  // calendar date so dateFrom/dateTo consistently mean JST dates.
  if (dateFrom) {
    clauses.push("date(o.created_at, '+9 hours') >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date(o.created_at, '+9 hours') <= ?");
    params.push(dateTo);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const payments = `
    SELECT order_id,
           COALESCE(SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END), 0) AS paymentCashAmount,
           COALESCE(SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END), 0) AS paymentQrAmount
    FROM luggage_order_payments
    GROUP BY order_id
  `;
  const result = await c.env.DB.prepare(
    `SELECT o.order_id AS orderId,
            o.created_at AS createdAt,
            o.updated_at AS updatedAt,
            o.name AS name,
            o.phone AS phone,
            o.email AS email,
            o.suitcase_qty AS suitcaseQty,
            o.backpack_qty AS backpackQty,
            o.set_qty AS setQty,
            o.expected_pickup_at AS expectedPickupAt,
            o.actual_pickup_at AS actualPickupAt,
            o.expected_storage_days AS expectedStorageDays,
            o.actual_storage_days AS actualStorageDays,
            o.prepaid_amount AS prepaidAmount,
            o.final_amount AS finalAmount,
            o.extra_amount AS extraAmount,
            o.payment_method AS paymentMethod,
            o.status AS status,
            o.tag_no AS tagNo,
            o.note AS note,
            o.manual_entry AS manualEntry,
            o.parent_order_id AS parentOrderId,
            o.in_warehouse AS inWarehouse,
            o.flying_pass_tier AS flyingPassTier,
            COALESCE(p.paymentCashAmount, 0) AS paymentCashAmount,
            COALESCE(p.paymentQrAmount, 0) AS paymentQrAmount
     FROM luggage_orders o
     LEFT JOIN (${payments}) p ON p.order_id = o.order_id${where}
     ORDER BY o.created_at DESC, o.order_id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all<LuggageOrderDto>();
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM luggage_orders o${where}`,
  ).bind(...params).first<{ total: number }>();

  return c.json({
    orders: result.results,
    total: countResult?.total ?? 0,
    limit,
    offset,
  });
});

type LuggageNoteActor = {
  userId: string;
  name: string;
  email: string;
  role: "center_staff" | "manager" | "super_admin";
};

type LuggageNoteUpdateDto = {
  orderId: string;
  note: string | null;
  updatedAt: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function requiredActorText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`actor.${field} is required`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`actor.${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`actor.${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function normalizeLuggageNotePayload(payload: unknown): { actor: LuggageNoteActor; note: string | null } {
  const payloadKeys = new Set(["note", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("note" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only note and actor");
  }
  if (typeof payload.note !== "string" && payload.note !== null) {
    throw new Error("note must be a string or null");
  }
  const note = payload.note?.trim() || null;
  if (note && note.length > 500) {
    throw new Error("note exceeds 500 characters");
  }

  const actorKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_NOTE_ACTOR_ROLES.has(role)) {
    throw new Error("actor.role is not allowed");
  }

  return {
    note,
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      email: requiredActorText(payload.actor.email, "email", 254),
      role: role as LuggageNoteActor["role"],
    },
  };
}

// PATCH /internal/luggage-orders/:orderId/note — Note-only mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/note", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let normalized: ReturnType<typeof normalizeLuggageNotePayload>;
  try {
    normalized = normalizeLuggageNotePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    "SELECT note, updated_at AS updatedAt FROM luggage_orders WHERE order_id = ?",
  ).bind(orderId).first<{ note: string | null; updatedAt: string }>();
  if (!current) {
    return c.json({ error: "Luggage order not found" }, 404);
  }
  if (current.note === normalized.note) {
    return c.json({
      orderId,
      note: current.note,
      updatedAt: current.updatedAt,
    });
  }

  const auditDetails = JSON.stringify({
    before: current.note,
    after: normalized.note,
    actor: normalized.actor,
  });
  const [updateResult] = await c.env.DB.batch<LuggageNoteUpdateDto>([
    c.env.DB.prepare(
      `UPDATE luggage_orders
       SET note = ?, updated_at = datetime('now')
       WHERE order_id = ?
       RETURNING order_id AS orderId, note, updated_at AS updatedAt`,
    ).bind(normalized.note, orderId),
    c.env.DB.prepare(
      `INSERT INTO luggage_audit_logs
         (order_id, staff_id, device_id, action, details, timestamp)
       VALUES (?, NULL, 'unified-admin', 'UNIFIED_ADMIN_NOTE_UPDATE', ?, datetime('now'))`,
    ).bind(orderId, auditDetails),
  ]);
  const updated = updateResult.results[0];
  if (!updated) {
    return c.json({ error: "Luggage order not found" }, 404);
  }

  return c.json({
    orderId: updated.orderId,
    note: updated.note,
    updatedAt: updated.updatedAt,
  });
});

type ExperienceUpsertPayload = {
  benefitAmount?: unknown;
  benefitLabel?: unknown;
  benefitType?: unknown;
  createdByStaffId?: unknown;
  externalId?: unknown;
  note?: unknown;
  piiMaskedAt?: unknown;
  scheduledDate?: unknown;
  scheduledTime?: unknown;
  visitorName?: unknown;
  visitorType?: unknown;
};

function asOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new Error(`Text field exceeds ${maxLength} characters`);
  }
  return text;
}

function asRequiredText(value: unknown, field: string, maxLength: number): string {
  const text = asOptionalText(value, maxLength);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function asDate(value: unknown, field: string): string {
  const text = asRequiredText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date`);
  }
  // JS Date auto-rolls over semantically invalid calendar dates (e.g. 2026-02-30
  // becomes 2026-03-02). Regex alone passes these, so confirm the parsed value
  // serialises back to the exact input before accepting.
  if (!parsed.toISOString().startsWith(text)) {
    throw new Error(`${field} is not a valid calendar date`);
  }
  return text;
}

function asOptionalEnum(
  value: unknown,
  allowedValues: Set<string>,
  field: string,
): string | null {
  const text = asOptionalText(value, 100);
  if (!text) return null;
  if (!allowedValues.has(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeUpsertPayload(payload: ExperienceUpsertPayload) {
  return {
    benefitAmount: asOptionalText(payload.benefitAmount, 100),
    benefitLabel: asOptionalText(payload.benefitLabel, 200),
    benefitType:
      asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType") ?? "REVIEWER_EXPERIENCE",
    createdByStaffId: asOptionalText(payload.createdByStaffId, 100) ?? "system:reviewer",
    externalId: asRequiredText(payload.externalId, "externalId", 120),
    note: asOptionalText(payload.note, 500),
    piiMaskedAt: asOptionalText(payload.piiMaskedAt, 50),
    scheduledDate: asDate(payload.scheduledDate, "scheduledDate"),
    scheduledTime: asOptionalText(payload.scheduledTime, 50),
    visitorName: asRequiredText(payload.visitorName, "visitorName", 100),
    visitorType:
      asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER",
  };
}

internalApi.get("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");
  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  if (!row) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  return c.json({ visit: serializeVisit(row) });
});

async function upsertExperienceVisit(
  db: D1Database,
  normalized: ReturnType<typeof normalizeUpsertPayload>,
) {
  await db.prepare(
    `INSERT INTO luggage_experience_visits (
       visitor_name, visitor_type, scheduled_date, scheduled_time,
       benefit_type, benefit_label, benefit_amount, external_id,
       status, note, created_by_staff_id, pii_masked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       visitor_name = excluded.visitor_name,
       visitor_type = excluded.visitor_type,
       scheduled_date = excluded.scheduled_date,
       scheduled_time = excluded.scheduled_time,
       benefit_type = COALESCE(excluded.benefit_type, luggage_experience_visits.benefit_type),
       benefit_label = COALESCE(excluded.benefit_label, luggage_experience_visits.benefit_label),
       benefit_amount = COALESCE(excluded.benefit_amount, luggage_experience_visits.benefit_amount),
       note = COALESCE(excluded.note, luggage_experience_visits.note),
       pii_masked_at = COALESCE(excluded.pii_masked_at, luggage_experience_visits.pii_masked_at),
       updated_at = datetime('now')`,
  ).bind(
    normalized.visitorName,
    normalized.visitorType,
    normalized.scheduledDate,
    normalized.scheduledTime,
    normalized.benefitType,
    normalized.benefitLabel,
    normalized.benefitAmount,
    normalized.externalId,
    normalized.note,
    normalized.createdByStaffId,
    normalized.piiMaskedAt,
  ).run();
}

// PUT is the right verb for an idempotent, client-addressed upsert: the
// externalId lives in the URL, the resource state lives in the body, and a
// replay produces an identical result. POST was the initial design but made
// 201-vs-200 ambiguous; PUT makes the create-or-update distinction explicit
// via the pre-check below.
internalApi.put("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");
  let payload: ExperienceUpsertPayload;
  try {
    payload = await c.req.json<ExperienceUpsertPayload>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (payload.externalId !== undefined && payload.externalId !== externalId) {
    return c.json({ error: "externalId in URL and body must match" }, 400);
  }

  let normalized: ReturnType<typeof normalizeUpsertPayload>;
  try {
    normalized = normalizeUpsertPayload({ ...payload, externalId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const existed = await c.env.DB.prepare(
    "SELECT 1 FROM luggage_experience_visits WHERE external_id = ? LIMIT 1",
  ).bind(externalId).first();

  await upsertExperienceVisit(c.env.DB, normalized);

  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(normalized.externalId).first<Record<string, unknown>>();

  return c.json({ visit: serializeVisit(row) }, existed ? 200 : 201);
});

internalApi.post("/internal/experience/batch", async (c) => {
  let payload: ExperienceUpsertPayload[];
  try {
    payload = await c.req.json<ExperienceUpsertPayload[]>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return c.json({ error: "Batch payload must be a non-empty array" }, 400);
  }
  if (payload.length > 50) {
    return c.json({ error: "Batch payload cannot exceed 50 items" }, 400);
  }

  const results: Array<{ error?: string; externalId?: string; ok: boolean }> = [];

  for (const entry of payload) {
    try {
      const normalized = normalizeUpsertPayload(entry);
      await upsertExperienceVisit(c.env.DB, normalized);
      results.push({ externalId: normalized.externalId, ok: true });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        externalId: typeof entry.externalId === "string" ? entry.externalId : undefined,
        ok: false,
      });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  return c.json(
    {
      failed,
      results,
      succeeded: results.length - failed,
    },
    failed > 0 ? 207 : 200,
  );
});

internalApi.patch("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: string[] = [];
  const values: Array<string | null> = [];

  try {
    if ("visitorName" in payload) {
      updates.push("visitor_name = ?");
      values.push(asRequiredText(payload.visitorName, "visitorName", 100));
    }
    if ("visitorType" in payload) {
      updates.push("visitor_type = ?");
      values.push(asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER");
    }
    if ("scheduledDate" in payload) {
      updates.push("scheduled_date = ?");
      values.push(asDate(payload.scheduledDate, "scheduledDate"));
    }
    if ("scheduledTime" in payload) {
      updates.push("scheduled_time = ?");
      values.push(asOptionalText(payload.scheduledTime, 50));
    }
    if ("benefitType" in payload) {
      updates.push("benefit_type = ?");
      values.push(asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType"));
    }
    if ("benefitLabel" in payload) {
      updates.push("benefit_label = ?");
      values.push(asOptionalText(payload.benefitLabel, 200));
    }
    if ("benefitAmount" in payload) {
      updates.push("benefit_amount = ?");
      values.push(asOptionalText(payload.benefitAmount, 100));
    }
    if ("note" in payload) {
      updates.push("note = ?");
      values.push(asOptionalText(payload.note, 500));
    }
    if ("piiMaskedAt" in payload) {
      updates.push("pii_masked_at = ?");
      values.push(asOptionalText(payload.piiMaskedAt, 50));
    }
    if ("status" in payload) {
      const status = asRequiredText(payload.status, "status", 20);
      if (!EXPERIENCE_STATUSES.has(status)) {
        throw new Error("status is invalid");
      }
      updates.push("status = ?");
      values.push(status);
    }
    if ("receivedBy" in payload) {
      updates.push("received_by = ?");
      values.push(asOptionalText(payload.receivedBy, 100));
    }
    if ("receivedAt" in payload) {
      updates.push("received_at = ?");
      values.push(asOptionalText(payload.receivedAt, 50));
    }
    if ("processedByStaffId" in payload) {
      updates.push("processed_by_staff_id = ?");
      values.push(asOptionalText(payload.processedByStaffId, 100));
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  if (updates.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(externalId);

  const result = await c.env.DB.prepare(
    `UPDATE luggage_experience_visits
     SET ${updates.join(", ")}
     WHERE external_id = ?`,
  ).bind(...values).run();

  if (!result.meta.changes) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  return c.json({ visit: serializeVisit(row) });
});

export default internalApi;
