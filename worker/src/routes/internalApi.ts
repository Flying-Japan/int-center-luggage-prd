import { Hono } from "hono";
import type { AppType } from "../types";
import { internalAuth } from "../middleware/internalAuth";
import {
  normalizePaymentAllocation,
  paymentAllocationStatements,
  payableAmountFromOrder,
} from "../lib/payments";
import { FLYING_PASS_TIERS, calculateExtraAmount, calculatePricePerDay, normalizeFlyingPassTier, recalculateOrderPrepaid } from "../services/pricing";
import { buildOrderId } from "../services/orderNumber";
import { downloadImage } from "../lib/r2";
import { calculateExtraDays, calculateStorageDays } from "../services/storage";

const internalApi = new Hono<AppType>();
// Mounted via `app.route("/", internalApi)` in index.tsx, so a bare "/*" here
// would swallow every request on the worker. Scope the auth middleware to the
// prefix we actually own so /customer, /login, /admin, etc. stay untouched.
internalApi.use("/internal/*", internalAuth);

const EXPERIENCE_STATUSES = new Set(["SCHEDULED", "VISITED", "RECEIVED", "CANCELLED"]);
const EXPERIENCE_VISITOR_TYPES = new Set(["BLOGGER", "INFLUENCER", "YOUTUBER", "OTHER"]);
const EXPERIENCE_BENEFIT_TYPES = new Set(["GIFT_CARD", "CASH", "PRODUCT", "OTHER", "REVIEWER_EXPERIENCE"]);
const LUGGAGE_NOTE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin"]);
const LUGGAGE_IMAGE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin", "viewer"]);
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
  extraDays: number;
  prepaidAmount: number;
  finalAmount: number | null;
  extraAmount: number;
  pricePerDay: number;
  paymentMethod: string | null;
  status: string;
  tagNo: string | null;
  note: string | null;
  manualEntry: number;
  parentOrderId: string | null;
  inWarehouse: number;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  staffPrepaidOverrideAmount: number | null;
  paymentCashAmount: number;
  paymentQrAmount: number;
  hasIdImage: boolean;
  hasLuggageImage: boolean;
  extensions: LuggageExtensionSummaryDto[];
};

type LuggageExtensionSummaryDto = {
  orderId: string;
  parentOrderId: string;
  status: string;
  createdAt: string;
  prepaidAmount: number;
  finalAmount: number | null;
  pricePerDay: number;
  paymentCashAmount: number;
  paymentQrAmount: number;
};

type LuggageStatusCounts = {
  paymentPending: number;
  paid: number;
  pickedUp: number;
  cancelled: number;
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
  const countClauses: string[] = [];
  const countParams: Array<string | number> = [];

  if (status) {
    if (status === "UNPICKED") {
      clauses.push("o.status IN ('PAYMENT_PENDING', 'PAID')");
    } else {
      clauses.push("o.status = ?");
      params.push(status);
    }
  }
  if (search) {
    clauses.push("(o.order_id LIKE ? OR o.name LIKE ? OR o.phone LIKE ? OR o.tag_no LIKE ?)");
    countClauses.push("(o.order_id LIKE ? OR o.name LIKE ? OR o.phone LIKE ? OR o.tag_no LIKE ?)");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
    countParams.push(pattern, pattern, pattern, pattern);
  }
  // created_at is stored in UTC; SQLite applies +9 hours before comparing its
  // calendar date so dateFrom/dateTo consistently mean JST dates.
  if (dateFrom) {
    clauses.push("date(o.created_at, '+9 hours') >= ?");
    params.push(dateFrom);
    countClauses.push("date(o.created_at, '+9 hours') >= ?");
    countParams.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date(o.created_at, '+9 hours') <= ?");
    params.push(dateTo);
    countClauses.push("date(o.created_at, '+9 hours') <= ?");
    countParams.push(dateTo);
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
            o.extra_days AS extraDays,
            o.prepaid_amount AS prepaidAmount,
            o.final_amount AS finalAmount,
            o.extra_amount AS extraAmount,
            o.price_per_day AS pricePerDay,
            o.payment_method AS paymentMethod,
            o.status AS status,
            o.tag_no AS tagNo,
            o.note AS note,
            o.manual_entry AS manualEntry,
            o.parent_order_id AS parentOrderId,
            o.in_warehouse AS inWarehouse,
            o.flying_pass_tier AS flyingPassTier,
            o.flying_pass_discount_amount AS flyingPassDiscountAmount,
            o.staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
            COALESCE(p.paymentCashAmount, 0) AS paymentCashAmount,
            COALESCE(p.paymentQrAmount, 0) AS paymentQrAmount,
            CASE WHEN o.id_image_url IS NOT NULL AND trim(o.id_image_url) <> '' THEN 1 ELSE 0 END AS hasIdImage,
            CASE WHEN o.luggage_image_url IS NOT NULL AND trim(o.luggage_image_url) <> '' THEN 1 ELSE 0 END AS hasLuggageImage
     FROM luggage_orders o
     LEFT JOIN (${payments}) p ON p.order_id = o.order_id${where}
     ORDER BY o.created_at DESC, o.order_id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all<LuggageOrderDto>();
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM luggage_orders o${where}`,
  ).bind(...params).first<{ total: number }>();
  const statusCountsResult = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN o.status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END), 0) AS paymentPending,
       COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN 1 ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN o.status = 'PICKED_UP' THEN 1 ELSE 0 END), 0) AS pickedUp,
       COALESCE(SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
     FROM luggage_orders o${countClauses.length ? ` WHERE ${countClauses.join(" AND ")}` : ""}`,
  ).bind(...countParams).first<LuggageStatusCounts>();

  const parentOrderIds = result.results
    .filter((order) => order.parentOrderId === null)
    .map((order) => order.orderId);
  const extensionsByParent = new Map<string, LuggageExtensionSummaryDto[]>();
  if (parentOrderIds.length > 0) {
    const placeholders = parentOrderIds.map(() => "?").join(",");
    const extensionResult = await c.env.DB.prepare(
      `SELECT o.order_id AS orderId,
              o.parent_order_id AS parentOrderId,
              o.status AS status,
              o.created_at AS createdAt,
              o.prepaid_amount AS prepaidAmount,
              o.final_amount AS finalAmount,
              o.price_per_day AS pricePerDay,
              COALESCE(SUM(CASE WHEN p.tender_type = 'CASH' THEN p.amount ELSE 0 END), 0) AS paymentCashAmount,
              COALESCE(SUM(CASE WHEN p.tender_type = 'PAY_QR' THEN p.amount ELSE 0 END), 0) AS paymentQrAmount
       FROM luggage_orders o
       LEFT JOIN luggage_order_payments p ON p.order_id = o.order_id
       WHERE o.parent_order_id IN (${placeholders})
       GROUP BY o.order_id
       ORDER BY o.created_at DESC, o.order_id DESC`,
    ).bind(...parentOrderIds).all<LuggageExtensionSummaryDto>();
    for (const extension of extensionResult.results) {
      const current = extensionsByParent.get(extension.parentOrderId) ?? [];
      current.push(extension);
      extensionsByParent.set(extension.parentOrderId, current);
    }
  }

  return c.json({
    orders: result.results.map((order) => ({
      ...order,
      hasIdImage: Boolean(order.hasIdImage),
      hasLuggageImage: Boolean(order.hasLuggageImage),
      extensions: extensionsByParent.get(order.orderId) ?? [],
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
    statusCounts: {
      paymentPending: statusCountsResult?.paymentPending ?? 0,
      paid: statusCountsResult?.paid ?? 0,
      pickedUp: statusCountsResult?.pickedUp ?? 0,
      cancelled: statusCountsResult?.cancelled ?? 0,
    },
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

type LuggageOperationsFieldsOrder = {
  orderId: string;
  status: string;
  name: string | null;
  tagNo: string | null;
  expectedPickupAt: string | null;
  inWarehouse: number;
  updatedAt: string;
};

type LuggageOperationsFieldsUpdateDto = {
  orderId: string;
  name: string | null;
  tagNo: string | null;
  expectedPickupAt: string | null;
  inWarehouse: number;
  updatedAt: string;
};

type LuggagePriceOrder = {
  orderId: string;
  pricePerDay: number;
  expectedStorageDays: number;
  prepaidAmount: number;
  finalAmount: number | null;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  paymentMethod: string | null;
  staffPrepaidOverrideAmount: number | null;
  updatedAt: string;
};

type LuggagePriceUpdateDto = {
  orderId: string;
  paymentMethod: string | null;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  prepaidAmount: number;
  finalAmount: number;
  staffPrepaidOverrideAmount: number | null;
  updatedAt: string;
};

type LuggagePaymentStatus = "PAYMENT_PENDING" | "PAID";

type LuggagePaymentStatusOrder = {
  orderId: string;
  status: string;
  paymentMethod: string | null;
  businessDate: string;
  prepaidAmount: number;
  finalAmount: number | null;
  extraAmount: number | null;
  paymentCashAmount: number;
  paymentQrAmount: number;
};

type LuggagePaymentStatusResponse = {
  success: true;
  changed: boolean;
  order: {
    orderId: string;
    status: LuggagePaymentStatus;
    paymentMethod: string | null;
    paymentCashAmount: number;
    paymentQrAmount: number;
  };
};

type LuggagePickupStatusAction = "mark_picked_up" | "undo_picked_up";

type LuggagePickupStatusActor = {
  userId: string;
  name: string;
  role: LuggageNoteActor["role"];
};

type LuggagePickupStatusOrder = {
  orderId: string;
  status: string;
  createdAt: string;
  expectedPickupAt: string | null;
  actualPickupAt: string | null;
  pricePerDay: number;
  actualStorageDays: number;
  extraDays: number;
  extraAmount: number;
  updatedAt: string;
};

type LuggagePickupStatusUpdateDto = {
  orderId: string;
  status: "PAID" | "PICKED_UP";
  actualPickupAt: string | null;
  actualStorageDays: number;
  extraDays: number;
  extraAmount: number;
  updatedAt: string;
};

type LuggageExtensionParentOrder = {
  orderId: string;
  parentOrderId: string | null;
  updatedAt: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  companionCount: number;
  suitcaseQty: number;
  backpackQty: number;
  tagNo: string | null;
  inWarehouse: number;
};

type LuggageExtensionCreateResponse = {
  order: LuggageOrderDto;
  parentUpdatedAt: string;
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

function parseTimezoneIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) throw new Error("expectedPickupAt must be an ISO timestamp with timezone");
  const [, year, month, day, hour, minute, second = "00", fraction = "", timezone] = match;
  const localDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0"))));
  if (
    localDate.getUTCFullYear() !== Number(year)
    || localDate.getUTCMonth() + 1 !== Number(month)
    || localDate.getUTCDate() !== Number(day)
    || localDate.getUTCHours() !== Number(hour)
    || localDate.getUTCMinutes() !== Number(minute)
    || localDate.getUTCSeconds() !== Number(second)
  ) {
    throw new Error("expectedPickupAt is not a valid calendar timestamp");
  }
  if (timezone !== "Z") {
    const [, , timezoneHour, timezoneMinute] = /^([+-])(\d{2}):(\d{2})$/.exec(timezone) ?? [];
    if (Number(timezoneHour) > 23 || Number(timezoneMinute) > 59) {
      throw new Error("expectedPickupAt has an invalid timezone offset");
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("expectedPickupAt is not a valid date");
  return parsed.toISOString();
}

function normalizeLuggageOperationsFieldsPayload(payload: unknown): {
  actor: LuggageNoteActor;
  update: { name?: string | null; tagNo?: string | null; expectedPickupAt?: string | null; inWarehouse?: number };
} {
  const payloadKeys = new Set(["name", "tagNo", "expectedPickupAt", "inWarehouse", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain actor and only supported operation fields");
  }
  const hasOperationsField = "name" in payload || "tagNo" in payload || "expectedPickupAt" in payload || "inWarehouse" in payload;
  if (!hasOperationsField) throw new Error("At least one operation field is required");
  const actor = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  const update: { name?: string | null; tagNo?: string | null; expectedPickupAt?: string | null; inWarehouse?: number } = {};
  if ("name" in payload) {
    if (typeof payload.name !== "string" && payload.name !== null) throw new Error("name must be a string or null");
    // Match the staff inline-update contract: null and an empty string remain distinct stored values.
    update.name = typeof payload.name === "string" ? payload.name.trim() : null;
  }
  if ("tagNo" in payload) {
    if (typeof payload.tagNo !== "string" && payload.tagNo !== null) throw new Error("tagNo must be a string or null");
    const tagNo = payload.tagNo?.trim() ?? "";
    if (!tagNo) {
      update.tagNo = null;
    } else if (!/^\d+$/.test(tagNo) || Number(tagNo) < 1 || Number(tagNo) > 100) {
      throw new Error("tagNo must be an integer from 1 to 100");
    } else {
      update.tagNo = String(Number(tagNo));
    }
  }
  if ("expectedPickupAt" in payload) {
    if (typeof payload.expectedPickupAt !== "string" && payload.expectedPickupAt !== null) {
      throw new Error("expectedPickupAt must be an ISO timestamp with timezone or null");
    }
    update.expectedPickupAt = typeof payload.expectedPickupAt === "string" ? parseTimezoneIso(payload.expectedPickupAt) : null;
  }
  if ("inWarehouse" in payload) {
    if (typeof payload.inWarehouse !== "boolean") throw new Error("inWarehouse must be a boolean");
    update.inWarehouse = payload.inWarehouse ? 1 : 0;
  }
  return { actor, update };
}

function normalizeLuggagePricePayload(payload: unknown): {
  actor: LuggageNoteActor;
  update: { paymentMethod?: "CASH" | "PAY_QR"; flyingPassTier?: string; staffPrepaidOverrideAmount?: number | null };
} {
  const payloadKeys = new Set(["paymentMethod", "flyingPassTier", "staffPrepaidOverrideAmount", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain actor and only supported price fields");
  }
  if (!("paymentMethod" in payload) && !("flyingPassTier" in payload) && !("staffPrepaidOverrideAmount" in payload)) {
    throw new Error("At least one price field is required");
  }
  const actor = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  const update: { paymentMethod?: "CASH" | "PAY_QR"; flyingPassTier?: string; staffPrepaidOverrideAmount?: number | null } = {};
  if ("paymentMethod" in payload) {
    if (payload.paymentMethod !== "CASH" && payload.paymentMethod !== "PAY_QR") {
      throw new Error("paymentMethod must be CASH or PAY_QR");
    }
    update.paymentMethod = payload.paymentMethod;
  }
  if ("flyingPassTier" in payload) {
    if (typeof payload.flyingPassTier !== "string" || !FLYING_PASS_TIERS.includes(payload.flyingPassTier as typeof FLYING_PASS_TIERS[number])) {
      throw new Error("flyingPassTier is invalid");
    }
    update.flyingPassTier = normalizeFlyingPassTier(payload.flyingPassTier);
  }
  if ("staffPrepaidOverrideAmount" in payload) {
    const override = payload.staffPrepaidOverrideAmount;
    if (override !== null && (typeof override !== "number" || !Number.isInteger(override) || override < 0 || override > 500000)) {
      throw new Error("staffPrepaidOverrideAmount must be an integer from 0 to 500000 or null");
    }
    update.staffPrepaidOverrideAmount = override;
  }
  return { actor, update };
}

function normalizeLuggagePaymentStatusPayload(payload: unknown): {
  actor: LuggageNoteActor;
  targetStatus: LuggagePaymentStatus;
  payment?: { cashAmount: number; qrAmount: number };
} {
  const payloadKeys = new Set(["targetStatus", "payment", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("targetStatus" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain targetStatus, actor, and optional payment");
  }
  if (payload.targetStatus !== "PAYMENT_PENDING" && payload.targetStatus !== "PAID") {
    throw new Error("targetStatus must be PAYMENT_PENDING or PAID");
  }
  const actorPayload = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  if (payload.targetStatus === "PAYMENT_PENDING") {
    if ("payment" in payload) throw new Error("payment is only allowed when targetStatus is PAID");
    return { actor: actorPayload, targetStatus: payload.targetStatus };
  }
  if (!("payment" in payload)) {
    return { actor: actorPayload, targetStatus: payload.targetStatus };
  }
  if (!isPlainRecord(payload.payment) || !hasOnlyKeys(payload.payment, new Set(["cashAmount", "qrAmount"]))) {
    throw new Error("payment must contain only cashAmount and qrAmount");
  }
  const cashAmount = payload.payment.cashAmount;
  const qrAmount = payload.payment.qrAmount;
  if (
    typeof cashAmount !== "number"
    || typeof qrAmount !== "number"
    || !Number.isInteger(cashAmount)
    || cashAmount < 0
    || !Number.isInteger(qrAmount)
    || qrAmount < 0
  ) {
    throw new Error("payment amounts must be non-negative integers");
  }
  return { actor: actorPayload, targetStatus: payload.targetStatus, payment: { cashAmount, qrAmount } };
}

function normalizeLuggagePickupStatusPayload(payload: unknown): {
  action: LuggagePickupStatusAction;
  expectedUpdatedAt: string;
  actor: LuggagePickupStatusActor;
} {
  const payloadKeys = new Set(["action", "expectedUpdatedAt", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys)
    || !("action" in payload) || !("expectedUpdatedAt" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only action, expectedUpdatedAt, and actor");
  }
  if (payload.action !== "mark_picked_up" && payload.action !== "undo_picked_up") {
    throw new Error("action must be mark_picked_up or undo_picked_up");
  }
  if (typeof payload.expectedUpdatedAt !== "string" || !payload.expectedUpdatedAt.trim() || payload.expectedUpdatedAt.length > 100) {
    throw new Error("expectedUpdatedAt must be a non-empty string");
  }
  const actorKeys = new Set(["userId", "name", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)
    || !("userId" in payload.actor) || !("name" in payload.actor) || !("role" in payload.actor)) {
    throw new Error("actor must contain only userId, name, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_NOTE_ACTOR_ROLES.has(role)) throw new Error("actor.role is not allowed");
  return {
    action: payload.action,
    expectedUpdatedAt: payload.expectedUpdatedAt,
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      role: role as LuggageNoteActor["role"],
    },
  };
}

function normalizeLuggageExtensionCreatePayload(payload: unknown): {
  expectedUpdatedAt: string;
  actor: LuggageNoteActor;
} {
  const payloadKeys = new Set(["expectedUpdatedAt", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys)
    || !("expectedUpdatedAt" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only expectedUpdatedAt and actor");
  }
  if (typeof payload.expectedUpdatedAt !== "string" || !payload.expectedUpdatedAt.trim() || payload.expectedUpdatedAt.length > 100) {
    throw new Error("expectedUpdatedAt must be a non-empty string");
  }
  return {
    expectedUpdatedAt: payload.expectedUpdatedAt,
    actor: normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor,
  };
}

type LuggageImageActor = Omit<LuggageNoteActor, "role"> & { role: "center_staff" | "manager" | "super_admin" | "viewer" };

function normalizeLuggageImagePayload(payload: unknown): { actor: LuggageImageActor } {
  const payloadKeys = new Set(["actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain only actor");
  }
  const actorKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_IMAGE_ACTOR_ROLES.has(role)) throw new Error("actor.role is not allowed");
  return {
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      email: requiredActorText(payload.actor.email, "email", 254),
      role: role as LuggageImageActor["role"],
    },
  };
}

function isAllowedImageContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  return ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"].includes(normalized);
}

function serializePaymentStatusOrder(order: LuggagePaymentStatusOrder): LuggagePaymentStatusResponse["order"] {
  return {
    orderId: order.orderId,
    status: order.status as LuggagePaymentStatus,
    paymentMethod: order.paymentMethod,
    paymentCashAmount: order.paymentCashAmount,
    paymentQrAmount: order.paymentQrAmount,
  };
}

function serializePaymentAuditActor(actor: LuggageNoteActor) {
  return { id: actor.userId, name: actor.name, email: actor.email };
}

// POST /internal/luggage-orders/:orderId/images/:kind — Private image stream for the unified admin.
internalApi.post("/internal/luggage-orders/:orderId/images/:kind", async (c) => {
  const orderId = c.req.param("orderId");
  const kind = c.req.param("kind");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }
  if (kind !== "id" && kind !== "luggage") return c.json({ error: "Invalid image kind" }, 400);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggageImagePayload>;
  try {
    normalized = normalizeLuggageImagePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const imageColumn = kind === "id" ? "id_image_url" : "luggage_image_url";
  const imageKey = await c.env.DB.prepare(
    `SELECT ${imageColumn} AS imageKey FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<{ imageKey: string | null }>();
  if (!imageKey?.imageKey?.trim()) return c.json({ error: "Image not found" }, 404);

  const image = await downloadImage(c.env.IMAGES, imageKey.imageKey);
  if (!image || !isAllowedImageContentType(image.contentType)) {
    return c.json({ error: "Image not found" }, 404);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
       VALUES (?, NULL, 'unified-admin', ?, ?, datetime('now'))`,
    ).bind(
      orderId,
      kind === "id" ? "UNIFIED_ADMIN_VIEW_ID_IMAGE" : "UNIFIED_ADMIN_VIEW_LUGGAGE_IMAGE",
      JSON.stringify({ actor: normalized.actor, kind }),
    ).run();
  } catch {
    return c.json({ error: "Unable to record image access" }, 500);
  }

  return new Response(image.body, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": "inline",
      "Content-Type": image.contentType,
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// POST /internal/luggage-orders/:orderId/extensions — One-day manual extension for the unified admin.
// This stays separate from the staff HTML route so the existing /staff behavior is unchanged.
internalApi.post("/internal/luggage-orders/:orderId/extensions", async (c) => {
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
  let normalized: ReturnType<typeof normalizeLuggageExtensionCreatePayload>;
  try {
    normalized = normalizeLuggageExtensionCreatePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const parent = await c.env.DB.prepare(
    `SELECT order_id AS orderId, parent_order_id AS parentOrderId, updated_at AS updatedAt, status, name, phone, email,
            companion_count AS companionCount, suitcase_qty AS suitcaseQty,
            backpack_qty AS backpackQty, tag_no AS tagNo, in_warehouse AS inWarehouse
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggageExtensionParentOrder>();
  if (!parent) return c.json({ error: "Luggage order not found" }, 404);
  if (parent.parentOrderId !== null) return c.json({ error: "Extension orders cannot be extended" }, 409);
  if (parent.status !== "PAYMENT_PENDING" && parent.status !== "PAID") {
    return c.json({ error: "Extension creation is not allowed for the current order status" }, 409);
  }
  if (parent.updatedAt !== normalized.expectedUpdatedAt) {
    return c.json({ error: "Luggage order was changed by another request" }, 409);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expectedPickupAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const extensionOrderId = `EXT-${await buildOrderId(c.env.DB, now, false, "ext")}`;
  const { setQty, pricePerDay } = calculatePricePerDay(parent.suitcaseQty, parent.backpackQty);
  const extensionNote = `연장 주문 (원본: ${orderId})`;
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    action: "create_manual_extension",
    parentOrderId: orderId,
    extensionOrderId,
    actor: normalized.actor,
  });

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE luggage_orders
         SET updated_at = ?
         WHERE order_id = ?
           AND parent_order_id IS NULL
           AND status IN ('PAYMENT_PENDING', 'PAID')
           AND updated_at = ?
         RETURNING updated_at AS updatedAt`,
      ).bind(nowIso, orderId, normalized.expectedUpdatedAt),
      c.env.DB.prepare(
        `INSERT INTO luggage_orders (
           order_id, created_at, updated_at, name, phone, email, companion_count,
           suitcase_qty, backpack_qty, set_qty, expected_pickup_at, expected_storage_days,
           actual_storage_days, extra_days, price_per_day, discount_rate, prepaid_amount,
           flying_pass_tier, flying_pass_discount_amount, staff_prepaid_override_amount,
           extra_amount, final_amount, payment_method, status, tag_no, note,
           manual_entry, staff_id, parent_order_id, in_warehouse
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, 0, ?, 'NONE', 0, NULL,
                0, ?, NULL, 'PAYMENT_PENDING', ?, ?, 1, NULL, ?, ?
         WHERE changes() = 1
         RETURNING order_id AS orderId, created_at AS createdAt, updated_at AS updatedAt,
                   name, phone, email, suitcase_qty AS suitcaseQty, backpack_qty AS backpackQty,
                   set_qty AS setQty, expected_pickup_at AS expectedPickupAt,
                   actual_pickup_at AS actualPickupAt, expected_storage_days AS expectedStorageDays,
                   actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                   prepaid_amount AS prepaidAmount, final_amount AS finalAmount,
                   extra_amount AS extraAmount, price_per_day AS pricePerDay,
                   payment_method AS paymentMethod, status, tag_no AS tagNo, note,
                   manual_entry AS manualEntry, parent_order_id AS parentOrderId,
                   in_warehouse AS inWarehouse, flying_pass_tier AS flyingPassTier,
                   flying_pass_discount_amount AS flyingPassDiscountAmount,
                   staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
                   0 AS paymentCashAmount, 0 AS paymentQrAmount,
                   0 AS hasIdImage, 0 AS hasLuggageImage`,
      ).bind(
        extensionOrderId, nowIso, nowIso, parent.name, parent.phone, parent.email, parent.companionCount,
        parent.suitcaseQty, parent.backpackQty, setQty, expectedPickupAt, pricePerDay, pricePerDay,
        pricePerDay, parent.tagNo ?? "", extensionNote, orderId, parent.inWarehouse,
      ),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_CREATE_EXTENSION', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ?)`,
      ).bind(extensionOrderId, auditDetails, extensionOrderId),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_CREATE_EXTENSION', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ?)`,
      ).bind(orderId, auditDetails, extensionOrderId),
    ]);
    const parentUpdate = results[0].results?.[0] as { updatedAt?: string } | undefined;
    const extension = results[1].results?.[0] as LuggageOrderDto | undefined;
    if (!parentUpdate || !extension) {
      return c.json({ error: "Luggage order was changed by another request" }, 409);
    }
    return c.json<LuggageExtensionCreateResponse>({
      parentUpdatedAt: parentUpdate.updatedAt ?? nowIso,
      order: { ...extension, extensions: [] },
    }, 201);
  } catch {
    return c.json({ error: "Unable to create luggage extension" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/payment-status — Explicit payment transition for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/payment-status", async (c) => {
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
  let normalized: ReturnType<typeof normalizeLuggagePaymentStatusPayload>;
  try {
    normalized = normalizeLuggagePaymentStatusPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT o.order_id AS orderId, o.status, o.payment_method AS paymentMethod,
            date(o.created_at, '+9 hours') AS businessDate, o.prepaid_amount AS prepaidAmount,
            o.final_amount AS finalAmount, o.extra_amount AS extraAmount,
            COALESCE(SUM(CASE WHEN p.tender_type = 'CASH' THEN p.amount ELSE 0 END), 0) AS paymentCashAmount,
            COALESCE(SUM(CASE WHEN p.tender_type = 'PAY_QR' THEN p.amount ELSE 0 END), 0) AS paymentQrAmount
     FROM luggage_orders o
     LEFT JOIN luggage_order_payments p ON p.order_id = o.order_id
     WHERE o.order_id = ?
     GROUP BY o.order_id`,
  ).bind(orderId).first<LuggagePaymentStatusOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);
  if (current.status === normalized.targetStatus) {
    return c.json<LuggagePaymentStatusResponse>({ success: true, changed: false, order: serializePaymentStatusOrder(current) });
  }
  if ((current.status !== "PAYMENT_PENDING" && current.status !== "PAID")
    || !((current.status === "PAYMENT_PENDING" && normalized.targetStatus === "PAID")
      || (current.status === "PAID" && normalized.targetStatus === "PAYMENT_PENDING"))) {
    return c.json({ error: "Payment status transition is not allowed" }, 409);
  }
  if (normalized.targetStatus === "PAID" && !normalized.payment) {
    return c.json({ error: "payment is required when targetStatus is PAID" }, 400);
  }

  const before = serializePaymentStatusOrder(current);
  let after: LuggagePaymentStatusResponse["order"];
  let statements: D1PreparedStatement[];
  if (normalized.targetStatus === "PAID") {
    const payableAmount = payableAmountFromOrder({
      prepaid_amount: current.prepaidAmount,
      final_amount: current.finalAmount,
      extra_amount: current.extraAmount,
    });
    const allocation = normalizePaymentAllocation({
      cash_amount: normalized.payment?.cashAmount,
      qr_amount: normalized.payment?.qrAmount,
    }, payableAmount);
    if ("error" in allocation) return c.json({ error: allocation.error }, 400);
    after = { orderId, status: "PAID", paymentMethod: allocation.paymentMethod, paymentCashAmount: allocation.cashAmount, paymentQrAmount: allocation.qrAmount };
    const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: serializePaymentAuditActor(normalized.actor) });
    statements = [
      ...paymentAllocationStatements(c.env.DB, orderId, current.businessDate, null, allocation, "PAYMENT_PENDING"),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAYMENT_PENDING')`,
      ).bind(orderId, auditDetails, orderId),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET status = 'PAID', payment_method = ?, updated_at = datetime('now')
         WHERE order_id = ? AND status = 'PAYMENT_PENDING'
         RETURNING order_id AS orderId`,
      ).bind(allocation.paymentMethod, orderId),
    ];
  } else {
    after = { orderId, status: "PAYMENT_PENDING", paymentMethod: current.paymentMethod, paymentCashAmount: 0, paymentQrAmount: 0 };
    const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: serializePaymentAuditActor(normalized.actor) });
    statements = [
      c.env.DB.prepare(
        `DELETE FROM luggage_order_payments
         WHERE order_id = ? AND EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAID')`,
      ).bind(orderId, orderId),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAID')`,
      ).bind(orderId, auditDetails, orderId),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET status = 'PAYMENT_PENDING', updated_at = datetime('now')
         WHERE order_id = ? AND status = 'PAID'
         RETURNING order_id AS orderId`,
      ).bind(orderId),
    ];
  }
  try {
    const results = await c.env.DB.batch(statements);
    const updateResult = results[results.length - 1];
    if (!updateResult.results?.[0]) return c.json({ error: "Payment status was changed by another request" }, 409);
  } catch {
    return c.json({ error: "Unable to update payment status" }, 500);
  }
  return c.json<LuggagePaymentStatusResponse>({ success: true, changed: true, order: after });
});

// PATCH /internal/luggage-orders/:orderId/pickup-status — Pickup transition for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/pickup-status", async (c) => {
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
  let normalized: ReturnType<typeof normalizeLuggagePickupStatusPayload>;
  try {
    normalized = normalizeLuggagePickupStatusPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, status, created_at AS createdAt,
            expected_pickup_at AS expectedPickupAt, actual_pickup_at AS actualPickupAt,
            price_per_day AS pricePerDay, actual_storage_days AS actualStorageDays,
            extra_days AS extraDays, extra_amount AS extraAmount, updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggagePickupStatusOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);
  if (current.updatedAt !== normalized.expectedUpdatedAt) {
    return c.json({ error: "Luggage order was changed by another request" }, 409);
  }

  const expectedStatus = normalized.action === "mark_picked_up" ? "PAID" : "PICKED_UP";
  const targetStatus: LuggagePickupStatusUpdateDto["status"] = normalized.action === "mark_picked_up" ? "PICKED_UP" : "PAID";
  if (current.status !== expectedStatus) {
    return c.json({ error: "Pickup status transition is not allowed" }, 409);
  }

  const now = new Date().toISOString();
  const actualPickupAt = normalized.action === "mark_picked_up" ? now : null;
  const actualStorageDays = normalized.action === "mark_picked_up"
    ? calculateStorageDays(current.createdAt, now)
    : 0;
  const extraDays = normalized.action === "mark_picked_up" && current.expectedPickupAt
    ? calculateExtraDays(current.expectedPickupAt, now)
    : 0;
  const extraAmount = normalized.action === "mark_picked_up"
    ? calculateExtraAmount(current.pricePerDay, extraDays)
    : 0;
  const before = {
    orderId,
    status: current.status,
    actualPickupAt: current.actualPickupAt,
    actualStorageDays: current.actualStorageDays,
    extraDays: current.extraDays,
    extraAmount: current.extraAmount,
  };
  const after = { orderId, status: targetStatus, actualPickupAt, actualStorageDays, extraDays, extraAmount };
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    action: normalized.action,
    before,
    after,
    actor: normalized.actor,
  });

  try {
    const results = await c.env.DB.batch([
      normalized.action === "mark_picked_up"
        ? c.env.DB.prepare(
          `UPDATE luggage_orders
           SET status = 'PICKED_UP', actual_pickup_at = ?, actual_storage_days = ?,
               extra_days = ?, extra_amount = ?, updated_at = datetime('now')
           WHERE order_id = ? AND status = 'PAID' AND updated_at = ?
           RETURNING order_id AS orderId, status, actual_pickup_at AS actualPickupAt,
                     actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                     extra_amount AS extraAmount, updated_at AS updatedAt`,
        ).bind(now, actualStorageDays, extraDays, extraAmount, orderId, current.updatedAt)
        : c.env.DB.prepare(
          `UPDATE luggage_orders
           SET status = 'PAID', actual_pickup_at = NULL, actual_storage_days = 0,
               extra_days = 0, extra_amount = 0, updated_at = datetime('now')
           WHERE order_id = ? AND status = 'PICKED_UP' AND updated_at = ?
           RETURNING order_id AS orderId, status, actual_pickup_at AS actualPickupAt,
                     actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                     extra_amount AS extraAmount, updated_at AS updatedAt`,
        ).bind(orderId, current.updatedAt),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PICKUP_STATUS_UPDATE', ?, datetime('now')
         WHERE changes() = 1
           AND EXISTS (
             SELECT 1 FROM luggage_orders
             WHERE order_id = ? AND status = ? AND updated_at = datetime('now')
               AND actual_pickup_at IS ? AND actual_storage_days = ?
               AND extra_days = ? AND extra_amount = ?
           )`,
      ).bind(orderId, auditDetails, orderId, targetStatus, actualPickupAt, actualStorageDays, extraDays, extraAmount),
    ]);
    const updatedRows = results[0].results ?? [];
    if (updatedRows.length !== 1) {
      return c.json({ error: "Luggage order was changed by another request" }, 409);
    }
    if (results[1].meta.changes !== 1) {
      return c.json({ error: "Unable to write pickup status audit log" }, 500);
    }
    const updated = updatedRows[0] as LuggagePickupStatusUpdateDto;
    return c.json({
      changed: true,
      orderId: updated.orderId,
      status: updated.status,
      actualPickupAt: updated.actualPickupAt,
      actualStorageDays: updated.actualStorageDays,
      extraDays: updated.extraDays,
      extraAmount: updated.extraAmount,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update pickup status" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/operations-fields — Limited operational field mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/operations-fields", async (c) => {
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
  let normalized: ReturnType<typeof normalizeLuggageOperationsFieldsPayload>;
  try {
    normalized = normalizeLuggageOperationsFieldsPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, status, name, tag_no AS tagNo, expected_pickup_at AS expectedPickupAt,
            in_warehouse AS inWarehouse, updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggageOperationsFieldsOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);

  const before = {
    orderId: current.orderId,
    name: current.name,
    tagNo: current.tagNo,
    expectedPickupAt: current.expectedPickupAt,
    inWarehouse: current.inWarehouse === 1,
  };
  const after = {
    orderId,
    name: "name" in normalized.update ? normalized.update.name! : current.name,
    tagNo: "tagNo" in normalized.update ? normalized.update.tagNo! : current.tagNo,
    expectedPickupAt: "expectedPickupAt" in normalized.update ? normalized.update.expectedPickupAt! : current.expectedPickupAt,
    inWarehouse: "inWarehouse" in normalized.update ? normalized.update.inWarehouse === 1 : current.inWarehouse === 1,
  };
  if (
    before.name === after.name
    && before.tagNo === after.tagNo
    && before.expectedPickupAt === after.expectedPickupAt
    && before.inWarehouse === after.inWarehouse
  ) {
    return c.json({
      changed: false,
      orderId: current.orderId,
      name: current.name,
      tagNo: current.tagNo,
      expectedPickupAt: current.expectedPickupAt,
      inWarehouse: current.inWarehouse === 1,
      updatedAt: current.updatedAt,
    });
  }

  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if ("name" in normalized.update) {
    updates.push("name = ?");
    values.push(normalized.update.name ?? null);
  }
  if ("tagNo" in normalized.update) {
    updates.push("tag_no = ?");
    values.push(normalized.update.tagNo ?? null);
  }
  if ("expectedPickupAt" in normalized.update) {
    updates.push("expected_pickup_at = ?");
    values.push(normalized.update.expectedPickupAt ?? null);
  }
  if ("inWarehouse" in normalized.update) {
    updates.push("in_warehouse = ?");
    values.push(normalized.update.inWarehouse ?? 0);
  }
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    before,
    after,
    actor: normalized.actor,
  });
  try {
    const results = await c.env.DB.batch<LuggageOperationsFieldsUpdateDto>([
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_OPERATION_FIELDS_UPDATE', ?, datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM luggage_orders
           WHERE order_id = ? AND updated_at = ? AND status = ?
             AND name IS ? AND tag_no IS ? AND expected_pickup_at IS ? AND in_warehouse = ?
         )`,
      ).bind(orderId, auditDetails, orderId, current.updatedAt, current.status, current.name, current.tagNo, current.expectedPickupAt, current.inWarehouse),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET ${updates.join(", ")}, updated_at = datetime('now')
         WHERE order_id = ? AND updated_at = ? AND status = ?
           AND name IS ? AND tag_no IS ? AND expected_pickup_at IS ? AND in_warehouse = ?
         RETURNING order_id AS orderId, name, tag_no AS tagNo, expected_pickup_at AS expectedPickupAt,
                   in_warehouse AS inWarehouse, updated_at AS updatedAt`,
      ).bind(...values, orderId, current.updatedAt, current.status, current.name, current.tagNo, current.expectedPickupAt, current.inWarehouse),
    ]);
    const updated = results[1].results?.[0];
    if (!updated) return c.json({ error: "Luggage order was changed by another request" }, 409);
    return c.json({
      changed: true,
      orderId: updated.orderId,
      name: updated.name,
      tagNo: updated.tagNo,
      expectedPickupAt: updated.expectedPickupAt,
      inWarehouse: updated.inWarehouse === 1,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update luggage operation fields" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/price — Price configuration mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/price", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) return c.json({ error: "Invalid orderId" }, 400);
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggagePricePayload>;
  try {
    normalized = normalizeLuggagePricePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }
  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, price_per_day AS pricePerDay, expected_storage_days AS expectedStorageDays,
            prepaid_amount AS prepaidAmount, final_amount AS finalAmount,
            flying_pass_tier AS flyingPassTier, flying_pass_discount_amount AS flyingPassDiscountAmount,
            payment_method AS paymentMethod, staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
            updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggagePriceOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);

  const flyingPassTier = normalizeFlyingPassTier(normalized.update.flyingPassTier ?? current.flyingPassTier);
  const paymentMethod = normalized.update.paymentMethod ?? current.paymentMethod ?? "CASH";
  if (paymentMethod !== "CASH" && paymentMethod !== "PAY_QR") return c.json({ error: "Invalid payment method" }, 400);
  const { finalPrepaid, flyingPassDiscountAmount } = recalculateOrderPrepaid(
    current.pricePerDay,
    current.expectedStorageDays,
    flyingPassTier,
  );
  const staffPrepaidOverrideAmount: number | null = "staffPrepaidOverrideAmount" in normalized.update
    ? normalized.update.staffPrepaidOverrideAmount ?? null
    : current.staffPrepaidOverrideAmount;
  const prepaidAmount = staffPrepaidOverrideAmount ?? finalPrepaid;
  const after = {
    orderId,
    paymentMethod,
    flyingPassTier,
    flyingPassDiscountAmount,
    prepaidAmount,
    finalAmount: prepaidAmount,
    staffPrepaidOverrideAmount,
  };
  const before = {
    orderId: current.orderId,
    paymentMethod: current.paymentMethod,
    flyingPassTier: current.flyingPassTier,
    flyingPassDiscountAmount: current.flyingPassDiscountAmount,
    prepaidAmount: current.prepaidAmount,
    finalAmount: current.finalAmount,
    staffPrepaidOverrideAmount: current.staffPrepaidOverrideAmount,
  };
  if (
    before.paymentMethod === after.paymentMethod
    && before.flyingPassTier === after.flyingPassTier
    && before.flyingPassDiscountAmount === after.flyingPassDiscountAmount
    && before.prepaidAmount === after.prepaidAmount
    && before.finalAmount === after.finalAmount
    && before.staffPrepaidOverrideAmount === after.staffPrepaidOverrideAmount
  ) {
    return c.json({
      changed: false,
      orderId: current.orderId,
      paymentMethod: current.paymentMethod,
      flyingPassTier: current.flyingPassTier,
      flyingPassDiscountAmount: current.flyingPassDiscountAmount,
      prepaidAmount: current.prepaidAmount,
      finalAmount: current.finalAmount,
      staffPrepaidOverrideAmount: current.staffPrepaidOverrideAmount,
      updatedAt: current.updatedAt,
    });
  }
  const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: normalized.actor });
  try {
    const results = await c.env.DB.batch<LuggagePriceUpdateDto>([
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PRICE_UPDATE', ?, datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM luggage_orders
           WHERE order_id = ? AND updated_at = ?
             AND price_per_day = ? AND expected_storage_days = ?
             AND prepaid_amount = ? AND final_amount IS ?
             AND flying_pass_tier IS ? AND flying_pass_discount_amount = ?
             AND payment_method IS ? AND staff_prepaid_override_amount IS ?
         )`,
      ).bind(orderId, auditDetails, orderId, current.updatedAt, current.pricePerDay, current.expectedStorageDays, current.prepaidAmount, current.finalAmount, current.flyingPassTier, current.flyingPassDiscountAmount, current.paymentMethod, current.staffPrepaidOverrideAmount),
      c.env.DB.prepare(
        `UPDATE luggage_orders
         SET payment_method = ?, flying_pass_tier = ?, flying_pass_discount_amount = ?,
             prepaid_amount = ?, final_amount = ?, staff_prepaid_override_amount = ?, updated_at = datetime('now')
         WHERE order_id = ? AND updated_at = ?
           AND price_per_day = ? AND expected_storage_days = ?
           AND prepaid_amount = ? AND final_amount IS ?
           AND flying_pass_tier IS ? AND flying_pass_discount_amount = ?
           AND payment_method IS ? AND staff_prepaid_override_amount IS ?
         RETURNING order_id AS orderId, payment_method AS paymentMethod, flying_pass_tier AS flyingPassTier,
                   flying_pass_discount_amount AS flyingPassDiscountAmount, prepaid_amount AS prepaidAmount,
                   final_amount AS finalAmount, staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
                   updated_at AS updatedAt`,
      ).bind(after.paymentMethod, after.flyingPassTier, after.flyingPassDiscountAmount, after.prepaidAmount, after.finalAmount, after.staffPrepaidOverrideAmount, orderId, current.updatedAt, current.pricePerDay, current.expectedStorageDays, current.prepaidAmount, current.finalAmount, current.flyingPassTier, current.flyingPassDiscountAmount, current.paymentMethod, current.staffPrepaidOverrideAmount),
    ]);
    const updated = results[1].results?.[0];
    if (!updated) return c.json({ error: "Luggage order price was changed by another request" }, 409);
    return c.json({
      changed: true,
      orderId: updated.orderId,
      paymentMethod: updated.paymentMethod,
      flyingPassTier: updated.flyingPassTier,
      flyingPassDiscountAmount: updated.flyingPassDiscountAmount,
      prepaidAmount: updated.prepaidAmount,
      finalAmount: updated.finalAmount,
      staffPrepaidOverrideAmount: updated.staffPrepaidOverrideAmount,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update luggage price" }, 500);
  }
});

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
