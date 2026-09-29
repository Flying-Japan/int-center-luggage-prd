import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";

// Unified-admin lost-and-found writes. The staff HTML routes in operations.tsx keep
// their original behavior; these payloads mirror what the staff screen lets editors do.

export type LostFoundStatus = "UNCLAIMED" | "CLAIMED" | "DISPOSED" | "RETURNED";
export type LostFoundUpdateAction = "claim" | "dispose" | "return";

export type LostFoundSnapshot = {
  itemName: string | null;
  quantity: number;
  foundLocation: string | null;
  foundAt: string | null;
  status: string;
  claimedBy: string | null;
  note: string | null;
};

export type LostFoundCreatePayload = {
  requestId: string;
  itemName: string;
  quantity: number;
  foundLocation: string | null;
  foundAt: string | null;
  note: string | null;
  actor: UnifiedWriteActor;
};

export type LostFoundUpdatePayload = {
  action: LostFoundUpdateAction;
  claimedBy: string | null;
  expected: LostFoundSnapshot;
  actor: UnifiedWriteActor;
};

export type LostFoundDeletePayload = {
  expected: LostFoundSnapshot;
  actor: UnifiedWriteActor;
};

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Matches the staff form's <input type="datetime-local"> value that the legacy route stores verbatim.
const FOUND_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const STATUSES = new Set(["UNCLAIMED", "CLAIMED", "DISPOSED", "RETURNED"]);

// Same transitions the staff screen offers: 인계 from UNCLAIMED, 폐기/반환 from UNCLAIMED or CLAIMED.
export const LOST_FOUND_TRANSITIONS: Record<LostFoundUpdateAction, { from: LostFoundStatus[]; to: LostFoundStatus }> = {
  claim: { from: ["UNCLAIMED"], to: "CLAIMED" },
  dispose: { from: ["UNCLAIMED", "CLAIMED"], to: "DISPOSED" },
  return: { from: ["UNCLAIMED", "CLAIMED"], to: "RETURNED" },
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized || null;
}

function snapshotText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`expected.${field} must be a string or null`);
  return value;
}

function normalizeSnapshot(value: unknown): LostFoundSnapshot {
  const keys = ["itemName", "quantity", "foundLocation", "foundAt", "status", "claimedBy", "note"];
  if (!isPlainRecord(value)) throw new Error("expected is required");
  assertOnlyKeys(value, keys, "expected");
  for (const key of keys) {
    if (!(key in value)) throw new Error(`expected.${key} is required`);
  }
  if (typeof value.quantity !== "number" || !Number.isInteger(value.quantity)) {
    throw new Error("expected.quantity must be an integer");
  }
  if (typeof value.status !== "string" || !value.status) throw new Error("expected.status is required");
  return {
    itemName: snapshotText(value.itemName, "itemName"),
    quantity: value.quantity,
    foundLocation: snapshotText(value.foundLocation, "foundLocation"),
    foundAt: snapshotText(value.foundAt, "foundAt"),
    status: value.status,
    claimedBy: snapshotText(value.claimedBy, "claimedBy"),
    note: snapshotText(value.note, "note"),
  };
}

export function normalizeLostFoundCreatePayload(payload: unknown): LostFoundCreatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["requestId", "itemName", "quantity", "foundLocation", "foundAt", "note", "actor"], "Body");
  if (typeof payload.requestId !== "string" || !REQUEST_ID_PATTERN.test(payload.requestId)) {
    throw new Error("requestId must be a lowercase UUID");
  }
  const itemName = optionalText(payload.itemName, "itemName", 200);
  if (!itemName) throw new Error("itemName is required");
  if (typeof payload.quantity !== "number" || !Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 999) {
    throw new Error("quantity must be an integer between 1 and 999");
  }
  const foundAt = optionalText(payload.foundAt, "foundAt", 16);
  if (foundAt && !FOUND_AT_PATTERN.test(foundAt)) throw new Error("foundAt must be YYYY-MM-DDTHH:mm");
  return {
    requestId: payload.requestId,
    itemName,
    quantity: payload.quantity,
    foundLocation: optionalText(payload.foundLocation, "foundLocation", 200),
    foundAt,
    note: optionalText(payload.note, "note", 1000),
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

export function normalizeLostFoundUpdatePayload(payload: unknown): LostFoundUpdatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["action", "claimedBy", "expected", "actor"], "Body");
  const action = payload.action;
  if (action !== "claim" && action !== "dispose" && action !== "return") {
    throw new Error("action must be claim, dispose, or return");
  }
  const claimedBy = optionalText(payload.claimedBy, "claimedBy", 100);
  if (action === "claim" && !claimedBy) throw new Error("claimedBy is required to claim an item");
  if (action !== "claim" && claimedBy) throw new Error("claimedBy is only allowed when claiming an item");
  return {
    action,
    claimedBy,
    expected: normalizeSnapshot(payload.expected),
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

export function normalizeLostFoundDeletePayload(payload: unknown): LostFoundDeletePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, ["expected", "actor"], "Body");
  return {
    expected: normalizeSnapshot(payload.expected),
    actor: normalizeUnifiedWriteActor(payload.actor),
  };
}

export function isKnownLostFoundStatus(value: string): value is LostFoundStatus {
  return STATUSES.has(value);
}

export function sameLostFoundSnapshot(current: LostFoundSnapshot, expected: LostFoundSnapshot): boolean {
  return current.itemName === expected.itemName
    && current.quantity === expected.quantity
    && current.foundLocation === expected.foundLocation
    && current.foundAt === expected.foundAt
    && current.status === expected.status
    && current.claimedBy === expected.claimedBy
    && current.note === expected.note;
}

// SQL fragment + binds that re-check the whole snapshot inside the write statement,
// so a concurrent staff-screen edit between our read and write cannot be overwritten.
export const LOST_FOUND_SNAPSHOT_WHERE = `item_name IS ? AND quantity IS ? AND found_location IS ?
  AND found_at IS ? AND status IS ? AND claimed_by IS ? AND note IS ?`;

export function lostFoundSnapshotBinds(snapshot: LostFoundSnapshot): Array<string | number | null> {
  return [
    snapshot.itemName,
    snapshot.quantity,
    snapshot.foundLocation,
    snapshot.foundAt,
    snapshot.status,
    snapshot.claimedBy,
    snapshot.note,
  ];
}
