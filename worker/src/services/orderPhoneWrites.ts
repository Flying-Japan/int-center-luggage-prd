import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";

// Unified-admin phone correction on a luggage order.
// The staff routes (/staff/orders/:id/update, /staff/api/orders/:id/inline-update) keep their
// original behavior. Like those routes, only luggage_orders.phone (and updated_at) changes:
// no status restriction, no format rule beyond a trimmed, non-empty value, and nothing is
// synced to other systems. The unified path adds a stale guard and a replay guard, and the
// audit keeps a masked number instead of the full phone.

export type OrderPhoneSnapshot = { phone: string; updatedAt: string };

export type OrderPhonePayload = {
  requestId: string;
  phone: string;
  expected: OrderPhoneSnapshot;
  actor: UnifiedWriteActor;
};

export type OrderPhoneConflictCode = "DUPLICATE_REQUEST" | "STALE";

export const ORDER_PHONE_AUDIT_ACTION = "UNIFIED_ADMIN_ORDER_PHONE_UPDATE";
// Same cap the unified manual intake already applies to staff-entered phone numbers.
export const ORDER_PHONE_MAX_LENGTH = 50;

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

export function normalizeOrderPhonePayload(payload: unknown): OrderPhonePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", "phone", "expected", "actor"], "Body");
  if (typeof payload.requestId !== "string" || !REQUEST_ID_PATTERN.test(payload.requestId)) {
    throw new Error("requestId must be a lowercase UUID");
  }
  if (typeof payload.phone !== "string") throw new Error("phone must be a string");
  const phone = payload.phone.trim();
  if (!phone) throw new Error("phone is required");
  if (phone.length > ORDER_PHONE_MAX_LENGTH) throw new Error(`phone exceeds ${ORDER_PHONE_MAX_LENGTH} characters`);
  const expected = payload.expected;
  if (!isPlainRecord(expected)) throw new Error("expected is required");
  assertOnlyKeys(expected, ["phone", "updatedAt"], "expected");
  // The screen shows the trimmed stored value (empty when NULL); older rows may exceed the new cap.
  if (typeof expected.phone !== "string" || expected.phone.length > 500) throw new Error("expected.phone must be a string");
  if (typeof expected.updatedAt !== "string" || !expected.updatedAt.trim() || expected.updatedAt.length > 100) {
    throw new Error("expected.updatedAt is required");
  }
  return {
    requestId: payload.requestId,
    phone,
    expected: { phone: expected.phone, updatedAt: expected.updatedAt },
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

/** Compare the freshly read row with what the screen showed; a replayed request is reported first. */
export function classifyOrderPhoneConflict(
  current: { phone: string | null; updatedAt: string },
  expected: OrderPhoneSnapshot,
  replayed: boolean,
): OrderPhoneConflictCode | null {
  if (replayed) return "DUPLICATE_REQUEST";
  if ((current.phone ?? "").trim() !== expected.phone || current.updatedAt !== expected.updatedAt) return "STALE";
  return null;
}

/** Keep only the last four digits so the audit row does not copy the customer's number. */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  const totalDigits = (phone.match(/\d/g) ?? []).length;
  let seen = 0;
  return phone.replace(/\d/g, (digit) => {
    seen += 1;
    return seen > totalDigits - 4 ? digit : "*";
  });
}

export const ORDER_PHONE_CONFLICT_MESSAGES: Record<OrderPhoneConflictCode, string> = {
  DUPLICATE_REQUEST: "This phone update request was already processed",
  STALE: "Luggage order was changed by another request",
};
