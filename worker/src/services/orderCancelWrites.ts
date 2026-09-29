import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";

// Unified-admin cancellation of a PAYMENT_PENDING luggage order.
// The staff route (/staff/api/orders/:id/cancel) keeps its original behavior. Like that
// route, cancelling only flips status to CANCELLED: payment rows, tag_no and images are
// left untouched, and tag reuse follows from the status change. The unified path is
// narrower on purpose: only PAYMENT_PENDING orders, with a stale guard and replay guard.

export type OrderCancelSnapshot = { status: string; updatedAt: string };

export type OrderCancelPayload = {
  requestId: string;
  expected: OrderCancelSnapshot;
  actor: UnifiedWriteActor;
};

export type OrderCancelConflictCode = "DUPLICATE_REQUEST" | "ALREADY_CANCELLED" | "STALE" | "INVALID_STATUS";

export const ORDER_CANCEL_AUDIT_ACTION = "UNIFIED_ADMIN_ORDER_CANCEL";
export const ORDER_CANCELLABLE_STATUS = "PAYMENT_PENDING";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

export function normalizeOrderCancelPayload(payload: unknown): OrderCancelPayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", "expected", "actor"], "Body");
  if (typeof payload.requestId !== "string" || !REQUEST_ID_PATTERN.test(payload.requestId)) {
    throw new Error("requestId must be a lowercase UUID");
  }
  const expected = payload.expected;
  if (!isPlainRecord(expected)) throw new Error("expected is required");
  assertOnlyKeys(expected, ["status", "updatedAt"], "expected");
  if (typeof expected.status !== "string" || !expected.status || expected.status.length > 32) {
    throw new Error("expected.status is required");
  }
  if (typeof expected.updatedAt !== "string" || !expected.updatedAt.trim() || expected.updatedAt.length > 100) {
    throw new Error("expected.updatedAt is required");
  }
  return {
    requestId: payload.requestId,
    expected: { status: expected.status, updatedAt: expected.updatedAt },
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

/**
 * Classify why a cancel cannot proceed, checked against the freshly read row.
 * Order matters: a replayed request and an order someone else already cancelled are
 * reported as such before the generic stale answer.
 */
export function classifyOrderCancelConflict(
  current: OrderCancelSnapshot,
  expected: OrderCancelSnapshot,
  replayed: boolean,
): OrderCancelConflictCode | null {
  if (replayed) return "DUPLICATE_REQUEST";
  if (current.status === "CANCELLED") return "ALREADY_CANCELLED";
  if (current.status !== expected.status || current.updatedAt !== expected.updatedAt) return "STALE";
  if (current.status !== ORDER_CANCELLABLE_STATUS) return "INVALID_STATUS";
  return null;
}

export const ORDER_CANCEL_CONFLICT_MESSAGES: Record<OrderCancelConflictCode, string> = {
  DUPLICATE_REQUEST: "This cancel request was already processed",
  ALREADY_CANCELLED: "Luggage order is already cancelled",
  STALE: "Luggage order was changed by another request",
  INVALID_STATUS: "Only PAYMENT_PENDING luggage orders can be cancelled",
};
