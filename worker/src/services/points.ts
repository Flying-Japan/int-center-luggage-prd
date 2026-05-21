import { calculateOrderCollectedAmount } from "./orderAmounts";

export type PointUsageInput = {
  requestedPoints: number;
  balancePoints: number;
  payableAmount: number;
  minimumUnit?: number;
};

export type PointUsageResult = {
  pointsToUse: number;
  amountAfterPoints: number;
};

export function calculatePointUsage(input: PointUsageInput): PointUsageResult {
  const minimumUnit = normalizeMinimumUnit(input.minimumUnit);
  const requested = normalizePositiveInteger(input.requestedPoints);
  const balance = normalizePositiveInteger(input.balancePoints);
  const payable = normalizePositiveInteger(input.payableAmount);
  const capped = Math.min(requested, balance, payable);
  const pointsToUse = capped === payable ? capped : Math.floor(capped / minimumUnit) * minimumUnit;

  return {
    pointsToUse,
    amountAfterPoints: Math.max(0, payable - pointsToUse),
  };
}

export const POINT_EARN_RATE_BPS = 100; // 1.00% — basis points (1 bps = 0.01%)
export const POINT_MINIMUM_USE_UNIT = 100;

export type PointTransactionType =
  | "USE_RESERVE"
  | "USE_COMMIT"
  | "USE_RELEASE"
  | "EARN"
  | "EARN_VOID";

export type PointTransactionStatus = "RESERVED" | "POSTED" | "VOIDED";

export type PointMutationOutcome = "applied" | "already" | "noop";

export type PointMutationResult = {
  outcome: PointMutationOutcome;
  pointsDelta: number;
  balanceAfter: number;
};

export type ReservePointUseInput = {
  accountPersonId: string;
  orderId: string;
  pointsToUse: number;
  reason?: string | null;
};

export class InsufficientPointBalanceError extends Error {
  constructor(public readonly accountPersonId: string, public readonly requested: number, public readonly available: number) {
    super(`Insufficient point balance for ${accountPersonId}: requested ${requested}, available ${available}`);
    this.name = "InsufficientPointBalanceError";
  }
}

type PointAccountRow = { balance_points: number | null };
type PointTransactionRow = {
  transaction_id: number;
  account_person_id: string;
  order_id: string | null;
  transaction_type: PointTransactionType;
  points_delta: number;
  status: PointTransactionStatus;
  balance_after: number;
  idempotency_key: string;
};
type OrderAmountsRow = {
  account_person_id: string | null;
  prepaid_amount: number | null;
  final_amount: number | null;
  extra_amount: number | null;
  point_discount_amount: number | null;
  points_used: number | null;
  flying_pass_discount_amount: number | null;
};

export function reserveIdempotencyKey(orderId: string): string {
  return `point:reserve:${orderId}`;
}

export function commitIdempotencyKey(orderId: string): string {
  return `point:commit:${orderId}`;
}

export function releaseIdempotencyKey(orderId: string): string {
  return `point:release:${orderId}`;
}

export function earnIdempotencyKey(orderId: string): string {
  return `point:earn:${orderId}`;
}

export function earnVoidIdempotencyKey(orderId: string): string {
  return `point:earn-void:${orderId}`;
}

export async function reservePointUseForOrder(
  db: D1Database,
  input: ReservePointUseInput
): Promise<PointMutationResult> {
  const pointsToUse = normalizePositiveInteger(input.pointsToUse);
  if (pointsToUse === 0) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: await loadBalance(db, input.accountPersonId) };
  }

  const idempotencyKey = reserveIdempotencyKey(input.orderId);
  const existing = await findTransactionByKey(db, idempotencyKey);
  if (existing) {
    return { outcome: "already", pointsDelta: existing.points_delta, balanceAfter: existing.balance_after };
  }

  await ensurePointAccount(db, input.accountPersonId);
  const currentBalance = await loadBalance(db, input.accountPersonId);
  if (currentBalance < pointsToUse) {
    throw new InsufficientPointBalanceError(input.accountPersonId, pointsToUse, currentBalance);
  }
  const newBalance = currentBalance - pointsToUse;

  const results = await db.batch([
    db.prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points - ?,
           lifetime_used_points = lifetime_used_points + ?,
           updated_at = datetime('now')
       WHERE account_person_id = ? AND balance_points >= ?`
    ).bind(pointsToUse, pointsToUse, input.accountPersonId, pointsToUse),
    db.prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, 'USE_RESERVE', ?, 'RESERVED', ?, ?, ?)`
    ).bind(input.accountPersonId, input.orderId, -pointsToUse, newBalance, idempotencyKey, input.reason ?? null),
  ]);

  const updateChanges = readChanges(results[0]);
  if (updateChanges !== 1) {
    await db.prepare(
      `DELETE FROM luggage_customer_point_transactions WHERE idempotency_key = ?`
    ).bind(idempotencyKey).run();
    throw new InsufficientPointBalanceError(input.accountPersonId, pointsToUse, currentBalance);
  }

  return { outcome: "applied", pointsDelta: -pointsToUse, balanceAfter: newBalance };
}

export async function commitReservedPointUseForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const reserveKey = reserveIdempotencyKey(orderId);
  const commitKey = commitIdempotencyKey(orderId);

  const alreadyCommitted = await findTransactionByKey(db, commitKey);
  if (alreadyCommitted) {
    return { outcome: "already", pointsDelta: 0, balanceAfter: alreadyCommitted.balance_after };
  }

  const reservation = await findTransactionByKey(db, reserveKey);
  if (!reservation) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: 0 };
  }
  if (reservation.status === "VOIDED") {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: reservation.balance_after };
  }

  await db.batch([
    db.prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = 'POSTED', updated_at = datetime('now')
       WHERE idempotency_key = ? AND status = 'RESERVED'`
    ).bind(reserveKey),
    db.prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, 'USE_COMMIT', ?, 'POSTED', ?, ?, ?)`
    ).bind(reservation.account_person_id, orderId, 0, reservation.balance_after, commitKey, "commit reserved use"),
  ]);

  return { outcome: "applied", pointsDelta: 0, balanceAfter: reservation.balance_after };
}

export async function releaseReservedPointUseForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const releaseKey = releaseIdempotencyKey(orderId);
  const reserveKey = reserveIdempotencyKey(orderId);

  const alreadyReleased = await findTransactionByKey(db, releaseKey);
  if (alreadyReleased) {
    return { outcome: "already", pointsDelta: alreadyReleased.points_delta, balanceAfter: alreadyReleased.balance_after };
  }

  const reservation = await findTransactionByKey(db, reserveKey);
  if (!reservation) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: 0 };
  }
  if (reservation.status === "VOIDED") {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: reservation.balance_after };
  }

  const pointsToReturn = Math.abs(reservation.points_delta);
  const currentBalance = await loadBalance(db, reservation.account_person_id);
  const newBalance = currentBalance + pointsToReturn;

  await db.batch([
    db.prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points + ?,
           lifetime_used_points = MAX(0, lifetime_used_points - ?),
           updated_at = datetime('now')
       WHERE account_person_id = ?`
    ).bind(pointsToReturn, pointsToReturn, reservation.account_person_id),
    db.prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = 'VOIDED', updated_at = datetime('now')
       WHERE idempotency_key = ? AND status IN ('RESERVED', 'POSTED')`
    ).bind(reserveKey),
    db.prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, 'USE_RELEASE', ?, 'POSTED', ?, ?, ?)`
    ).bind(reservation.account_person_id, orderId, pointsToReturn, newBalance, releaseKey, "release reserved use"),
  ]);

  return { outcome: "applied", pointsDelta: pointsToReturn, balanceAfter: newBalance };
}

export async function postEarnedPointsForPaidOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const earnKey = earnIdempotencyKey(orderId);
  const existing = await findTransactionByKey(db, earnKey);
  if (existing) {
    return { outcome: "already", pointsDelta: existing.points_delta, balanceAfter: existing.balance_after };
  }

  const order = await loadOrderForEarn(db, orderId);
  if (!order || !order.account_person_id) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: 0 };
  }

  const collectedAmount = calculateOrderCollectedAmount({
    prepaidAmount: order.prepaid_amount,
    finalAmount: order.final_amount,
    extraAmount: order.extra_amount,
    pointDiscountAmount: order.point_discount_amount,
    pointsUsed: order.points_used,
    flyingPassDiscountAmount: order.flying_pass_discount_amount,
  });
  const earned = Math.floor((collectedAmount * POINT_EARN_RATE_BPS) / 10000);
  if (earned <= 0) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: await loadBalance(db, order.account_person_id) };
  }

  await ensurePointAccount(db, order.account_person_id);
  const currentBalance = await loadBalance(db, order.account_person_id);
  const newBalance = currentBalance + earned;

  await db.batch([
    db.prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points + ?,
           lifetime_earned_points = lifetime_earned_points + ?,
           updated_at = datetime('now')
       WHERE account_person_id = ?`
    ).bind(earned, earned, order.account_person_id),
    db.prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, 'EARN', ?, 'POSTED', ?, ?, ?)`
    ).bind(order.account_person_id, orderId, earned, newBalance, earnKey, `earn ${POINT_EARN_RATE_BPS}bps of ${collectedAmount}`),
    db.prepare(
      `UPDATE luggage_orders
       SET points_earned = ?
       WHERE order_id = ?`
    ).bind(earned, orderId),
  ]);

  return { outcome: "applied", pointsDelta: earned, balanceAfter: newBalance };
}

export async function voidEarnedPointsForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const voidKey = earnVoidIdempotencyKey(orderId);
  const alreadyVoided = await findTransactionByKey(db, voidKey);
  if (alreadyVoided) {
    return { outcome: "already", pointsDelta: alreadyVoided.points_delta, balanceAfter: alreadyVoided.balance_after };
  }

  const earn = await findTransactionByKey(db, earnIdempotencyKey(orderId));
  if (!earn || earn.status === "VOIDED") {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: earn?.balance_after ?? 0 };
  }

  const pointsToReverse = Math.max(0, earn.points_delta);
  if (pointsToReverse === 0) {
    return { outcome: "noop", pointsDelta: 0, balanceAfter: earn.balance_after };
  }

  const currentBalance = await loadBalance(db, earn.account_person_id);
  const newBalance = Math.max(0, currentBalance - pointsToReverse);
  const appliedDelta = currentBalance - newBalance;

  await db.batch([
    db.prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = MAX(0, balance_points - ?),
           lifetime_earned_points = MAX(0, lifetime_earned_points - ?),
           updated_at = datetime('now')
       WHERE account_person_id = ?`
    ).bind(pointsToReverse, pointsToReverse, earn.account_person_id),
    db.prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = 'VOIDED', updated_at = datetime('now')
       WHERE idempotency_key = ? AND status = 'POSTED'`
    ).bind(earnIdempotencyKey(orderId)),
    db.prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, 'EARN_VOID', ?, 'POSTED', ?, ?, ?)`
    ).bind(earn.account_person_id, orderId, -appliedDelta, newBalance, voidKey, "void earned points"),
    db.prepare(
      `UPDATE luggage_orders
       SET points_earned = 0
       WHERE order_id = ?`
    ).bind(orderId),
  ]);

  return { outcome: "applied", pointsDelta: -appliedDelta, balanceAfter: newBalance };
}

async function findTransactionByKey(db: D1Database, idempotencyKey: string): Promise<PointTransactionRow | null> {
  const row = await db.prepare(
    `SELECT transaction_id, account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key
     FROM luggage_customer_point_transactions
     WHERE idempotency_key = ?
     LIMIT 1`
  ).bind(idempotencyKey).first<PointTransactionRow>();
  return row ?? null;
}

async function ensurePointAccount(db: D1Database, accountPersonId: string): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO luggage_customer_point_accounts (account_person_id) VALUES (?)`
  ).bind(accountPersonId).run();
}

async function loadBalance(db: D1Database, accountPersonId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT balance_points FROM luggage_customer_point_accounts WHERE account_person_id = ?`
  ).bind(accountPersonId).first<PointAccountRow>();
  return normalizePositiveInteger(row?.balance_points ?? 0);
}

async function loadOrderForEarn(db: D1Database, orderId: string): Promise<OrderAmountsRow | null> {
  const row = await db.prepare(
    `SELECT account_person_id, prepaid_amount, final_amount, extra_amount,
            point_discount_amount, points_used, flying_pass_discount_amount
     FROM luggage_orders
     WHERE order_id = ?
     LIMIT 1`
  ).bind(orderId).first<OrderAmountsRow>();
  return row ?? null;
}

function readChanges(result: D1Result | undefined): number {
  if (!result || !result.meta) return 0;
  const value = (result.meta as { changes?: number }).changes;
  return typeof value === "number" ? value : 0;
}

function normalizeMinimumUnit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return POINT_MINIMUM_USE_UNIT;
  return Math.max(1, Math.floor(value));
}

function normalizePositiveInteger(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
