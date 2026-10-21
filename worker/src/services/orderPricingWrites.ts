import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";
import {
  calculatePricePerDay,
  normalizeFlyingPassTier,
  recalculateOrderPrepaid,
  FLYING_PASS_TIERS,
  type FlyingPassTier,
} from "./pricing";

// Unified-admin correction of a luggage order's bag counts, Flying Pass tier, payment method and
// manual amount in ONE atomic write. Legacy routes are untouched (update-price keeps its behavior,
// and nothing in the staff UI edits bag counts). Rules:
// - Only PAYMENT_PENDING orders: once payment is recorded the tender ledger
//   (luggage_order_payments) and cash closing depend on the billed amount, so they are never rewritten.
// - Prices come from the same pricing.ts the customer form and update-price use. The Flying Pass
//   discount is the legacy flat per-order amount (not per day); this module does not change that.
// - Changing bag counts recomputes set_qty / price_per_day / discount / prepaid / final together,
//   so counts, set bundles and price can never disagree.
// - Orders that have extension orders (or are one) keep their counts: extensions copy the parent's
//   counts and daily price when they are created.
// - Free manual-intake orders (price_per_day = 0) keep their counts for the same reason.
// - A manual amount (staff_prepaid_override_amount) set for the old counts is never silently kept
//   across a count change: the caller must say keep/replace/clear explicitly.
// - The audit row carries the reason and before/after values in the same D1 batch.

export const ORDER_PRICING_AUDIT_ACTION = "UNIFIED_ADMIN_ORDER_PRICING_UPDATE";
export const ORDER_PRICING_EDITABLE_STATUS = "PAYMENT_PENDING";
export const ORDER_PRICING_MAX_QTY = 99;
export const ORDER_PRICING_MAX_AMOUNT = 500000;
export const ORDER_PRICING_REASON_MAX = 200;

export type PaymentMethod = "CASH" | "PAY_QR";

/** What the screen showed; every value must still match the stored row. */
export type OrderPricingExpected = {
  updatedAt: string;
  suitcaseQty: number;
  backpackQty: number;
  flyingPassTier: FlyingPassTier;
  staffPrepaidOverrideAmount: number | null;
  prepaidAmount: number;
};

export type OrderPricingChanges = {
  suitcaseQty?: number;
  backpackQty?: number;
  flyingPassTier?: FlyingPassTier;
  paymentMethod?: PaymentMethod;
  /** null clears the manual amount (automatic price); a number sets it. */
  staffPrepaidOverrideAmount?: number | null;
};

export type OrderPricingPayload = {
  requestId: string;
  reason: string;
  expected: OrderPricingExpected;
  changes: OrderPricingChanges;
  actor: UnifiedWriteActor;
};

export type OrderPricingConflictCode =
  | "DUPLICATE_REQUEST"
  | "STALE"
  | "STATUS_NOT_EDITABLE"
  | "HAS_EXTENSIONS"
  | "IS_EXTENSION"
  | "FREE_ORDER"
  | "INVALID_DAYS"
  | "OVERRIDE_DECISION_REQUIRED"
  | "EMPTY_ORDER";

export const ORDER_PRICING_CONFLICT_MESSAGES: Record<OrderPricingConflictCode, string> = {
  DUPLICATE_REQUEST: "This pricing update request was already processed",
  STALE: "Luggage order was changed by another request",
  STATUS_NOT_EDITABLE: "Only payment-pending orders can be edited",
  HAS_EXTENSIONS: "Bag counts cannot change on an order that has extension orders",
  IS_EXTENSION: "Bag counts cannot change on an extension order",
  FREE_ORDER: "Bag counts cannot change on a free (no daily price) order",
  INVALID_DAYS: "The order has no storage days, so its price cannot be recalculated; set a manual amount",
  OVERRIDE_DECISION_REQUIRED: "A manual amount is set: choose to keep, replace or clear it when bag counts change",
  EMPTY_ORDER: "An order needs at least one bag",
};

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function qty(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ORDER_PRICING_MAX_QTY) {
    throw new Error(`${field} must be an integer from 0 to ${ORDER_PRICING_MAX_QTY}`);
  }
  return value;
}

function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ORDER_PRICING_MAX_AMOUNT) {
    throw new Error(`${field} must be an integer from 0 to ${ORDER_PRICING_MAX_AMOUNT}`);
  }
  return value;
}

export function normalizeOrderPricingPayload(payload: unknown): OrderPricingPayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", "reason", "expected", "changes", "actor"], "Body");
  if (typeof payload.requestId !== "string" || !REQUEST_ID_PATTERN.test(payload.requestId)) throw new Error("requestId must be a lowercase UUID");
  if (typeof payload.reason !== "string" || !payload.reason.trim()) throw new Error("reason is required");
  const reason = payload.reason.trim();
  if (reason.length > ORDER_PRICING_REASON_MAX) throw new Error(`reason exceeds ${ORDER_PRICING_REASON_MAX} characters`);

  const expected = payload.expected;
  if (!isPlainRecord(expected)) throw new Error("expected is required");
  assertOnlyKeys(expected, ["updatedAt", "suitcaseQty", "backpackQty", "flyingPassTier", "staffPrepaidOverrideAmount", "prepaidAmount"], "expected");
  if (typeof expected.updatedAt !== "string" || !expected.updatedAt.trim() || expected.updatedAt.length > 100) throw new Error("expected.updatedAt is required");
  if (typeof expected.flyingPassTier !== "string" || !(FLYING_PASS_TIERS as readonly string[]).includes(expected.flyingPassTier)) throw new Error("expected.flyingPassTier is invalid");
  const expectedOverride = expected.staffPrepaidOverrideAmount;
  if (expectedOverride !== null) amount(expectedOverride, "expected.staffPrepaidOverrideAmount");

  const changes = payload.changes;
  if (!isPlainRecord(changes)) throw new Error("changes is required");
  assertOnlyKeys(changes, ["suitcaseQty", "backpackQty", "flyingPassTier", "paymentMethod", "staffPrepaidOverrideAmount"], "changes");
  if (Object.keys(changes).length === 0) throw new Error("changes must contain at least one field");
  const normalizedChanges: OrderPricingChanges = {};
  if ("suitcaseQty" in changes) normalizedChanges.suitcaseQty = qty(changes.suitcaseQty, "changes.suitcaseQty");
  if ("backpackQty" in changes) normalizedChanges.backpackQty = qty(changes.backpackQty, "changes.backpackQty");
  if ("flyingPassTier" in changes) {
    if (typeof changes.flyingPassTier !== "string" || !(FLYING_PASS_TIERS as readonly string[]).includes(changes.flyingPassTier)) throw new Error("changes.flyingPassTier is invalid");
    normalizedChanges.flyingPassTier = changes.flyingPassTier as FlyingPassTier;
  }
  if ("paymentMethod" in changes) {
    if (changes.paymentMethod !== "CASH" && changes.paymentMethod !== "PAY_QR") throw new Error("changes.paymentMethod must be CASH or PAY_QR");
    normalizedChanges.paymentMethod = changes.paymentMethod;
  }
  if ("staffPrepaidOverrideAmount" in changes) {
    normalizedChanges.staffPrepaidOverrideAmount = changes.staffPrepaidOverrideAmount === null ? null : amount(changes.staffPrepaidOverrideAmount, "changes.staffPrepaidOverrideAmount");
  }
  return {
    requestId: payload.requestId,
    reason,
    expected: {
      updatedAt: expected.updatedAt,
      suitcaseQty: qty(expected.suitcaseQty, "expected.suitcaseQty"),
      backpackQty: qty(expected.backpackQty, "expected.backpackQty"),
      flyingPassTier: expected.flyingPassTier as FlyingPassTier,
      staffPrepaidOverrideAmount: expectedOverride === null ? null : (expectedOverride as number),
      prepaidAmount: amount(expected.prepaidAmount, "expected.prepaidAmount"),
    },
    changes: normalizedChanges,
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

/** Stored values this write can change (plus what the guards need). */
export type OrderPricingRow = {
  status: string;
  updatedAt: string;
  parentOrderId: string | null;
  hasExtensions: boolean;
  suitcaseQty: number;
  backpackQty: number;
  setQty: number;
  pricePerDay: number;
  expectedStorageDays: number;
  flyingPassTier: string | null;
  flyingPassDiscountAmount: number;
  staffPrepaidOverrideAmount: number | null;
  paymentMethod: string | null;
  prepaidAmount: number;
  finalAmount: number | null;
};

export type OrderPricingValues = {
  suitcaseQty: number;
  backpackQty: number;
  setQty: number;
  pricePerDay: number;
  flyingPassTier: FlyingPassTier;
  flyingPassDiscountAmount: number;
  staffPrepaidOverrideAmount: number | null;
  paymentMethod: string;
  prepaidAmount: number;
  finalAmount: number;
};

export function valuesOfRow(row: OrderPricingRow): OrderPricingValues {
  return {
    suitcaseQty: row.suitcaseQty,
    backpackQty: row.backpackQty,
    setQty: row.setQty,
    pricePerDay: row.pricePerDay,
    flyingPassTier: normalizeFlyingPassTier(row.flyingPassTier),
    flyingPassDiscountAmount: row.flyingPassDiscountAmount,
    staffPrepaidOverrideAmount: row.staffPrepaidOverrideAmount,
    paymentMethod: row.paymentMethod ?? "CASH",
    prepaidAmount: row.prepaidAmount,
    finalAmount: row.finalAmount ?? row.prepaidAmount,
  };
}

/** Screen snapshot vs stored row. A replayed request is reported first. */
export function classifyOrderPricingConflict(
  row: OrderPricingRow,
  expected: OrderPricingExpected,
  replayed: boolean,
): OrderPricingConflictCode | null {
  if (replayed) return "DUPLICATE_REQUEST";
  if (
    row.updatedAt !== expected.updatedAt
    || row.suitcaseQty !== expected.suitcaseQty
    || row.backpackQty !== expected.backpackQty
    || normalizeFlyingPassTier(row.flyingPassTier) !== expected.flyingPassTier
    || row.staffPrepaidOverrideAmount !== expected.staffPrepaidOverrideAmount
    || row.prepaidAmount !== expected.prepaidAmount
  ) return "STALE";
  return null;
}

export type OrderPricingComputation =
  | { ok: true; before: OrderPricingValues; after: OrderPricingValues; changed: boolean; quantityChanged: boolean }
  | { ok: false; code: OrderPricingConflictCode };

/** Resolve the full next state. Pure: the route only persists what this returns. */
export function computeOrderPricing(row: OrderPricingRow, changes: OrderPricingChanges): OrderPricingComputation {
  if (row.status !== ORDER_PRICING_EDITABLE_STATUS) return { ok: false, code: "STATUS_NOT_EDITABLE" };
  const before = valuesOfRow(row);
  const suitcaseQty = changes.suitcaseQty ?? row.suitcaseQty;
  const backpackQty = changes.backpackQty ?? row.backpackQty;
  const quantityChanged = suitcaseQty !== row.suitcaseQty || backpackQty !== row.backpackQty;
  if (suitcaseQty + backpackQty < 1) return { ok: false, code: "EMPTY_ORDER" };
  if (quantityChanged) {
    if (row.parentOrderId !== null) return { ok: false, code: "IS_EXTENSION" };
    if (row.hasExtensions) return { ok: false, code: "HAS_EXTENSIONS" };
    // Free manual intake stores price_per_day = 0; recomputing it from the counts would start charging it.
    if (row.pricePerDay === 0) return { ok: false, code: "FREE_ORDER" };
    if (row.staffPrepaidOverrideAmount !== null && !("staffPrepaidOverrideAmount" in changes)) {
      return { ok: false, code: "OVERRIDE_DECISION_REQUIRED" };
    }
  }
  const { setQty, pricePerDay } = quantityChanged
    ? calculatePricePerDay(suitcaseQty, backpackQty)
    : { setQty: row.setQty, pricePerDay: row.pricePerDay };
  const flyingPassTier = changes.flyingPassTier ?? before.flyingPassTier;
  const override = "staffPrepaidOverrideAmount" in changes ? (changes.staffPrepaidOverrideAmount ?? null) : row.staffPrepaidOverrideAmount;
  const { finalPrepaid, flyingPassDiscountAmount } = recalculateOrderPrepaid(pricePerDay, row.expectedStorageDays, flyingPassTier);
  // Recalculating a price from fewer than one storage day would bill 0; only an explicit manual amount may proceed.
  if (override === null && row.expectedStorageDays < 1) return { ok: false, code: "INVALID_DAYS" };
  const prepaidAmount = override ?? finalPrepaid;
  const after: OrderPricingValues = {
    suitcaseQty,
    backpackQty,
    setQty,
    pricePerDay,
    flyingPassTier,
    flyingPassDiscountAmount,
    staffPrepaidOverrideAmount: override,
    paymentMethod: changes.paymentMethod ?? before.paymentMethod,
    prepaidAmount,
    finalAmount: prepaidAmount,
  };
  const changed = (Object.keys(after) as Array<keyof OrderPricingValues>).some((key) => after[key] !== before[key]);
  return { ok: true, before, after, changed, quantityChanged };
}
