import { normalizeUnifiedWriteActor, type UnifiedWriteActor } from "../lib/internalActorStaff";
import { CASH_CLOSING_STARTING_FLOAT, type AutoSalesSummary } from "./cashClosingSales";

// Unified-admin cash-closing writes. The staff routes (POST /staff/cash-closing and
// POST /staff/cash-closing/:id/edit in operations.tsx) keep their behavior; the calculations
// below are copied from them line for line so both paths store the same numbers.

export const CASH_CLOSING_DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;
export type CashClosingType = "MORNING_HANDOVER" | "FINAL_CLOSE";

export type CashClosingInputFields = {
  counts: number[]; // same order as CASH_CLOSING_DENOMS
  paypayAmount: number;
  actualQrAmount: number;
  rentalCash: number;
  wandRefund: number;
  floor4fCount: number;
  floor8fCount: number;
  note: string | null;
};

export type CashClosingCreatePayload = CashClosingInputFields & { requestId: string; closingType: CashClosingType; actor: UnifiedWriteActor };
export type CashClosingUpdatePayload = CashClosingInputFields & { expected: CashClosingSnapshot; actor: UnifiedWriteActor };

// Stored values of a closing as the edit screen reads them. Also the stale token for edits.
export type CashClosingSnapshot = {
  closingId: number;
  businessDate: string | null;
  closingType: string;
  workflowStatus: string;
  counts: number[];
  totalAmount: number;
  paypayAmount: number;
  actualQrAmount: number;
  qrDifferenceAmount: number;
  checkAutoAmount: number;
  expectedAmount: number;
  actualAmount: number;
  differenceAmount: number;
  rentalCash: number | null;
  wandRefund: number | null;
  floor4fCount: number;
  floor8fCount: number;
  note: string | null;
  updatedAt: string;
};

export type CashClosingComputed = {
  totalAmount: number;
  paypayAmount: number;
  actualQrForTotal: number;
  actualAmount: number;
  checkAutoAmount: number;
  expectedAmount: number;
  differenceAmount: number;
  qrDifferenceAmount: number;
};

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_KEYS = ["counts", "paypayAmount", "actualQrAmount", "rentalCash", "wandRefund", "floor4fCount", "floor8fCount", "note"];
const SNAPSHOT_KEYS: Array<keyof CashClosingSnapshot> = [
  "closingId", "businessDate", "closingType", "workflowStatus", "counts", "totalAmount", "paypayAmount", "actualQrAmount",
  "qrDifferenceAmount", "checkAutoAmount", "expectedAmount", "actualAmount", "differenceAmount", "rentalCash", "wandRefund",
  "floor4fCount", "floor8fCount", "note", "updatedAt",
];
const MAX_AMOUNT = 100_000_000;
const MAX_COUNT = 100_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const allowed = new Set(keys);
  if (!Object.keys(value).every((key) => allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${field} must be an integer between 0 and ${max}`);
  }
  return value;
}

function inputFields(payload: Record<string, unknown>): CashClosingInputFields {
  if (!isPlainRecord(payload.counts)) throw new Error("counts is required");
  assertOnlyKeys(payload.counts, CASH_CLOSING_DENOMS.map(String), "counts");
  const counts = CASH_CLOSING_DENOMS.map((denom) => boundedInteger((payload.counts as Record<string, unknown>)[String(denom)], `counts.${denom}`, MAX_COUNT));
  if (payload.note !== null && typeof payload.note !== "string") throw new Error("note must be a string or null");
  const note = typeof payload.note === "string" ? payload.note.trim() : "";
  if (note.length > 2000) throw new Error("note exceeds 2000 characters");
  return {
    counts,
    paypayAmount: boundedInteger(payload.paypayAmount, "paypayAmount", MAX_AMOUNT),
    actualQrAmount: boundedInteger(payload.actualQrAmount, "actualQrAmount", MAX_AMOUNT),
    rentalCash: boundedInteger(payload.rentalCash, "rentalCash", MAX_AMOUNT),
    wandRefund: boundedInteger(payload.wandRefund, "wandRefund", MAX_AMOUNT),
    floor4fCount: boundedInteger(payload.floor4fCount, "floor4fCount", MAX_COUNT),
    floor8fCount: boundedInteger(payload.floor8fCount, "floor8fCount", MAX_COUNT),
    note: note || null,
  };
}

export function normalizeCashClosingCreatePayload(payload: unknown): CashClosingCreatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  // Server-calculated values (totals, expected/auto snapshots, differences, business date, status) are not accepted.
  assertOnlyKeys(payload, ["requestId", "closingType", ...INPUT_KEYS, "actor"], "Body");
  if (typeof payload.requestId !== "string" || !REQUEST_ID_PATTERN.test(payload.requestId)) throw new Error("requestId must be a lowercase UUID");
  if (payload.closingType !== "MORNING_HANDOVER" && payload.closingType !== "FINAL_CLOSE") {
    throw new Error("closingType must be MORNING_HANDOVER or FINAL_CLOSE");
  }
  return { requestId: payload.requestId, closingType: payload.closingType, ...inputFields(payload), actor: normalizeUnifiedWriteActor(payload.actor) };
}

export function normalizeCashClosingUpdatePayload(payload: unknown): CashClosingUpdatePayload {
  if (!isPlainRecord(payload)) throw new Error("Body must be an object");
  assertOnlyKeys(payload, [...INPUT_KEYS, "expected", "actor"], "Body");
  if (!isPlainRecord(payload.expected)) throw new Error("expected is required");
  assertOnlyKeys(payload.expected, SNAPSHOT_KEYS, "expected");
  for (const key of SNAPSHOT_KEYS) if (!(key in payload.expected)) throw new Error(`expected.${key} is required`);
  return { ...inputFields(payload), expected: payload.expected as CashClosingSnapshot, actor: normalizeUnifiedWriteActor(payload.actor) };
}

function cashTotal(counts: number[]): number {
  let totalAmount = 0;
  CASH_CLOSING_DENOMS.forEach((denom, index) => { totalAmount += counts[index] * denom; });
  return totalAmount;
}

// POST /staff/cash-closing: auto sales are captured once, when the closing is created.
export function computeCashClosingCreate(fields: CashClosingInputFields, autoSales: AutoSalesSummary | null): CashClosingComputed {
  const totalAmount = cashTotal(fields.counts);
  const checkAutoAmount = autoSales?.totalAmount ?? 0;
  const expectedAmount = checkAutoAmount;
  const actualQrForTotal = fields.actualQrAmount || fields.paypayAmount;
  const actualAmount = (totalAmount - CASH_CLOSING_STARTING_FLOAT) + actualQrForTotal;
  return {
    totalAmount,
    paypayAmount: fields.paypayAmount,
    actualQrForTotal,
    actualAmount,
    checkAutoAmount,
    expectedAmount,
    differenceAmount: actualAmount - expectedAmount,
    qrDifferenceAmount: actualQrForTotal - (autoSales?.qrAmount ?? 0),
  };
}

// POST /staff/cash-closing/:id/edit: keeps the creation-time auto-sales snapshots and
// derives the QR expectation back from the stored values instead of reading current sales.
export function computeCashClosingEdit(fields: CashClosingInputFields, stored: CashClosingSnapshot): CashClosingComputed & { expectedQrAmount: number } {
  const totalAmount = cashTotal(fields.counts);
  const checkAutoAmount = stored.checkAutoAmount || 0;
  const expectedAmount = stored.expectedAmount || 0;
  const actualQrForTotal = fields.actualQrAmount || fields.paypayAmount;
  const actualAmount = (totalAmount - CASH_CLOSING_STARTING_FLOAT) + actualQrForTotal;
  const previousActualQrAmount = (stored.actualQrAmount || 0) || (stored.paypayAmount || 0);
  const expectedQrAmount = previousActualQrAmount - (stored.qrDifferenceAmount || 0);
  return {
    totalAmount,
    paypayAmount: fields.paypayAmount,
    actualQrForTotal,
    actualAmount,
    checkAutoAmount,
    expectedAmount,
    differenceAmount: actualAmount - expectedAmount,
    qrDifferenceAmount: actualQrForTotal - expectedQrAmount,
    expectedQrAmount,
  };
}

export const CASH_CLOSING_RAW_COLUMNS = `closing_id AS closingId, business_date AS businessDate, closing_type AS closingType,
  workflow_status AS workflowStatus, ${CASH_CLOSING_DENOMS.map((d) => `count_${d} AS count${d}`).join(", ")},
  total_amount AS totalAmount, paypay_amount AS paypayAmount, actual_qr_amount AS actualQrAmount,
  qr_difference_amount AS qrDifferenceAmount, check_auto_amount AS checkAutoAmount, expected_amount AS expectedAmount,
  actual_amount AS actualAmount, difference_amount AS differenceAmount, rental_cash AS rentalCash, wand_refund AS wandRefund,
  floor_4f_count AS floor4fCount, floor_8f_count AS floor8fCount, note, updated_at AS updatedAt`;

export function cashClosingSnapshotOf(row: Record<string, unknown>): CashClosingSnapshot {
  const num = (key: string) => Number(row[key]);
  const nullableNum = (key: string) => (row[key] === null || row[key] === undefined ? null : Number(row[key]));
  return {
    closingId: num("closingId"),
    businessDate: (row.businessDate as string | null) ?? null,
    closingType: String(row.closingType),
    workflowStatus: String(row.workflowStatus),
    counts: CASH_CLOSING_DENOMS.map((d) => num(`count${d}`)),
    totalAmount: num("totalAmount"),
    paypayAmount: num("paypayAmount"),
    actualQrAmount: num("actualQrAmount"),
    qrDifferenceAmount: num("qrDifferenceAmount"),
    checkAutoAmount: num("checkAutoAmount"),
    expectedAmount: num("expectedAmount"),
    actualAmount: num("actualAmount"),
    differenceAmount: num("differenceAmount"),
    rentalCash: nullableNum("rentalCash"),
    wandRefund: nullableNum("wandRefund"),
    floor4fCount: num("floor4fCount"),
    floor8fCount: num("floor8fCount"),
    note: (row.note as string | null) ?? null,
    updatedAt: String(row.updatedAt),
  };
}

export function sameCashClosingSnapshot(current: CashClosingSnapshot, expected: CashClosingSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => JSON.stringify(current[key]) === JSON.stringify(expected[key]));
}

// Re-checks updated_at AND every stored value inside the UPDATE, so an edit made within the same
// second (same updated_at) by the staff screen is still detected.
export const CASH_CLOSING_SNAPSHOT_WHERE = `business_date IS ? AND closing_type IS ? AND workflow_status IS ?
  AND ${CASH_CLOSING_DENOMS.map((d) => `count_${d} IS ?`).join(" AND ")}
  AND total_amount IS ? AND paypay_amount IS ? AND actual_qr_amount IS ? AND qr_difference_amount IS ?
  AND check_auto_amount IS ? AND expected_amount IS ? AND actual_amount IS ? AND difference_amount IS ?
  AND rental_cash IS ? AND wand_refund IS ? AND floor_4f_count IS ? AND floor_8f_count IS ? AND note IS ? AND updated_at IS ?`;

export function cashClosingSnapshotBinds(s: CashClosingSnapshot): Array<string | number | null> {
  return [
    s.businessDate, s.closingType, s.workflowStatus, ...s.counts,
    s.totalAmount, s.paypayAmount, s.actualQrAmount, s.qrDifferenceAmount,
    s.checkAutoAmount, s.expectedAmount, s.actualAmount, s.differenceAmount,
    s.rentalCash, s.wandRefund, s.floor4fCount, s.floor8fCount, s.note, s.updatedAt,
  ];
}

export function parseCashClosingId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
