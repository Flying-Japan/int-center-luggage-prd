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

export type PointUsageValidationError =
  | "POINTS_REQUIRE_AUTH"
  | "POINTS_EXCEED_BALANCE"
  | "POINTS_EXCEED_PAYABLE";

export type PointUsageStatus = "NONE" | "RESERVED";

export type ResolvedPointUsage = {
  ok: boolean;
  error?: PointUsageValidationError;
  pointsToUse: number;
  pointDiscountAmount: number;
  amountAfterPoints: number;
  pointUsageStatus: PointUsageStatus;
};

export type PointUsageLedgerInput = {
  accountPersonId: string;
  orderId: string;
  pointsUsed: number;
};

export const POINT_EARN_RATE_DEFAULT = 0.01;
export const POINT_MINIMUM_USE_UNIT = 100;

export class InsufficientPointsError extends Error {
  readonly requestedPoints: number;
  readonly availablePoints: number;
  constructor(requestedPoints: number, availablePoints: number) {
    super(`Insufficient points: requested ${requestedPoints}, available ${availablePoints}`);
    this.name = "InsufficientPointsError";
    this.requestedPoints = requestedPoints;
    this.availablePoints = availablePoints;
  }
}

export type PointMutationResult = {
  applied: boolean;
  idempotent: boolean;
  pointsDelta: number;
  balanceAfter: number;
  transactionId: number | null;
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

export function pointUsageIdempotencyKey(orderId: string): string {
  return RESERVE_KEY(String(orderId));
}

export function buildPointUsageLedgerStatements(
  db: D1Database,
  input: PointUsageLedgerInput,
): D1PreparedStatement[] {
  const points = normalizePositiveInteger(input.pointsUsed);
  if (points <= 0) return [];

  const idempotencyKey = pointUsageIdempotencyKey(input.orderId);

  return [
    db.prepare(
      `INSERT OR IGNORE INTO luggage_customer_point_transactions (
         account_person_id, order_id, transaction_type, points_delta, status,
         balance_after, idempotency_key, reason, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, balance_points - ?, ?, ?, datetime('now'), datetime('now')
       FROM luggage_customer_point_accounts
       WHERE account_person_id = ?
         AND balance_points >= ?`
    ).bind(
      input.accountPersonId,
      input.orderId,
      TX_TYPE_USE,
      -points,
      STATUS_RESERVED,
      points,
      idempotencyKey,
      `intake order ${input.orderId}`,
      input.accountPersonId,
      points,
    ),
    // LOAD-BEARING INVARIANT: this UPDATE's `changes() = 1` guard refers to the
    // row count of the immediately preceding INSERT OR IGNORE in the same batch.
    // It deducts the balance only when a NEW reservation row was inserted, which
    // is what makes duplicate submits (same idempotency_key → INSERT ignored →
    // changes() = 0) skip the deduction. D1 `batch()` executes statements
    // "sequentially, non-concurrently" in one transaction, so changes() reflects
    // the prior statement. DO NOT reorder these two statements or insert any
    // statement between them — and the order INSERT that follows in the batch
    // likewise chains on `changes() = 1`. Breaking the order silently double-
    // deducts or stops deducting. See customer.tsx submit batch assembly.
    db.prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points - ?,
           lifetime_used_points = lifetime_used_points + ?,
           updated_at = datetime('now')
       WHERE account_person_id = ?
         AND changes() = 1`
    ).bind(points, points, input.accountPersonId),
  ];
}

export function resolvePointUsage(
  input: PointUsageInput & { isAuthenticated: boolean },
): ResolvedPointUsage {
  const requested = normalizePositiveInteger(input.requestedPoints);
  const balance = normalizePositiveInteger(input.balancePoints);
  const payable = normalizePositiveInteger(input.payableAmount);

  if (requested <= 0) return resolvedNoUsage(payable);
  if (!input.isAuthenticated) return rejectedUsage("POINTS_REQUIRE_AUTH", payable);
  if (requested > balance) return rejectedUsage("POINTS_EXCEED_BALANCE", payable);
  if (requested > payable) return rejectedUsage("POINTS_EXCEED_PAYABLE", payable);

  const usage = calculatePointUsage({
    requestedPoints: requested,
    balancePoints: balance,
    payableAmount: payable,
    minimumUnit: input.minimumUnit,
  });

  if (usage.pointsToUse <= 0) return resolvedNoUsage(payable);

  return {
    ok: true,
    pointsToUse: usage.pointsToUse,
    pointDiscountAmount: usage.pointsToUse,
    amountAfterPoints: usage.amountAfterPoints,
    pointUsageStatus: "RESERVED",
  };
}

// ---------- mutation helpers ----------

const RESERVE_KEY = (orderId: string) => `point:reserve:${orderId}`;
const RELEASE_KEY = (orderId: string) => `point:release:${orderId}`;
const EARN_KEY = (orderId: string) => `point:earn:${orderId}`;
const VOID_KEY = (orderId: string) => `point:void:${orderId}`;

const TX_TYPE_USE = "USE";
const TX_TYPE_RELEASE = "RELEASE";
const TX_TYPE_EARN = "EARN";
const TX_TYPE_VOID = "VOID";

const STATUS_RESERVED = "RESERVED";
const STATUS_POSTED = "POSTED";
const STATUS_RELEASED = "RELEASED";
const STATUS_VOIDED = "VOIDED";

type ExistingTransaction = {
  transaction_id: number;
  account_person_id: string;
  points_delta: number;
  balance_after: number;
  status: string;
};

async function findTransactionByKey(db: D1Database, idempotencyKey: string): Promise<ExistingTransaction | null> {
  return await db
    .prepare(
      `SELECT transaction_id, account_person_id, points_delta, balance_after, status
       FROM luggage_customer_point_transactions
       WHERE idempotency_key = ?
       LIMIT 1`
    )
    .bind(idempotencyKey)
    .first<ExistingTransaction>();
}

async function readAccountBalance(db: D1Database, accountPersonId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT balance_points FROM luggage_customer_point_accounts WHERE account_person_id = ? LIMIT 1`
    )
    .bind(accountPersonId)
    .first<{ balance_points: number | null }>();
  return typeof row?.balance_points === "number" ? row.balance_points : 0;
}

export async function reservePointUseForOrder(
  db: D1Database,
  input: { accountPersonId: string; orderId: string; pointsToUse: number; reason?: string }
): Promise<PointMutationResult> {
  const personId = String(input.accountPersonId || "");
  const orderId = String(input.orderId || "");
  const points = normalizePositiveInteger(input.pointsToUse);

  if (!personId || !orderId) {
    throw new Error("reservePointUseForOrder requires accountPersonId and orderId");
  }
  if (points === 0) {
    return {
      applied: false,
      idempotent: false,
      pointsDelta: 0,
      balanceAfter: await readAccountBalance(db, personId),
      transactionId: null,
    };
  }

  const idempotencyKey = RESERVE_KEY(orderId);
  const existing = await findTransactionByKey(db, idempotencyKey);
  if (existing) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: existing.points_delta,
      balanceAfter: existing.balance_after,
      transactionId: existing.transaction_id,
    };
  }

  const updateRes = await db
    .prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points - ?,
           lifetime_used_points = lifetime_used_points + ?,
           updated_at = datetime('now')
       WHERE account_person_id = ? AND balance_points >= ?`
    )
    .bind(points, points, personId, points)
    .run();

  if ((updateRes.meta?.changes ?? 0) === 0) {
    throw new InsufficientPointsError(points, await readAccountBalance(db, personId));
  }

  const balanceAfter = await readAccountBalance(db, personId);
  const insertRes = await db
    .prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(personId, orderId, TX_TYPE_USE, -points, STATUS_RESERVED, balanceAfter, idempotencyKey, input.reason ?? null)
    .run();

  return {
    applied: true,
    idempotent: false,
    pointsDelta: -points,
    balanceAfter,
    transactionId: Number(insertRes.meta?.last_row_id ?? 0),
  };
}

export async function commitReservedPointUseForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const reserveKey = RESERVE_KEY(String(orderId));
  const existing = await findTransactionByKey(db, reserveKey);
  if (!existing) {
    return { applied: false, idempotent: false, pointsDelta: 0, balanceAfter: 0, transactionId: null };
  }
  if (existing.status !== STATUS_RESERVED) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: existing.points_delta,
      balanceAfter: existing.balance_after,
      transactionId: existing.transaction_id,
    };
  }
  await db
    .prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = ?, updated_at = datetime('now')
       WHERE transaction_id = ? AND status = ?`
    )
    .bind(STATUS_POSTED, existing.transaction_id, STATUS_RESERVED)
    .run();

  return {
    applied: true,
    idempotent: false,
    pointsDelta: existing.points_delta,
    balanceAfter: existing.balance_after,
    transactionId: existing.transaction_id,
  };
}

export async function releaseReservedPointUseForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const orderIdStr = String(orderId);
  const reserveKey = RESERVE_KEY(orderIdStr);
  const releaseKey = RELEASE_KEY(orderIdStr);

  const existingRelease = await findTransactionByKey(db, releaseKey);
  if (existingRelease) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: existingRelease.points_delta,
      balanceAfter: existingRelease.balance_after,
      transactionId: existingRelease.transaction_id,
    };
  }

  const reserveRow = await findTransactionByKey(db, reserveKey);
  if (!reserveRow) {
    return { applied: false, idempotent: false, pointsDelta: 0, balanceAfter: 0, transactionId: null };
  }

  if (reserveRow.status !== STATUS_RESERVED) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: 0,
      balanceAfter: reserveRow.balance_after,
      transactionId: reserveRow.transaction_id,
    };
  }

  const pointsToReturn = Math.abs(reserveRow.points_delta);
  if (pointsToReturn === 0) {
    return {
      applied: false,
      idempotent: false,
      pointsDelta: 0,
      balanceAfter: reserveRow.balance_after,
      transactionId: reserveRow.transaction_id,
    };
  }

  await db
    .prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = balance_points + ?,
           lifetime_used_points = MAX(0, lifetime_used_points - ?),
           updated_at = datetime('now')
       WHERE account_person_id = ?`
    )
    .bind(pointsToReturn, pointsToReturn, reserveRow.account_person_id)
    .run();

  await db
    .prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = ?, updated_at = datetime('now')
       WHERE transaction_id = ? AND status = ?`
    )
    .bind(STATUS_RELEASED, reserveRow.transaction_id, STATUS_RESERVED)
    .run();

  const balanceAfter = await readAccountBalance(db, reserveRow.account_person_id);

  const insertRes = await db
    .prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      reserveRow.account_person_id,
      orderIdStr,
      TX_TYPE_RELEASE,
      pointsToReturn,
      STATUS_POSTED,
      balanceAfter,
      releaseKey,
      "release reserved use"
    )
    .run();

  return {
    applied: true,
    idempotent: false,
    pointsDelta: pointsToReturn,
    balanceAfter,
    transactionId: Number(insertRes.meta?.last_row_id ?? 0),
  };
}

export async function postEarnedPointsForPaidOrder(
  db: D1Database,
  input: { accountPersonId: string; orderId: string; paidAmount: number; earnRate?: number }
): Promise<PointMutationResult> {
  const personId = String(input.accountPersonId || "");
  const orderId = String(input.orderId || "");

  if (!personId || !orderId) {
    throw new Error("postEarnedPointsForPaidOrder requires accountPersonId and orderId");
  }

  const idempotencyKey = EARN_KEY(orderId);
  const existing = await findTransactionByKey(db, idempotencyKey);
  if (existing) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: existing.points_delta,
      balanceAfter: existing.balance_after,
      transactionId: existing.transaction_id,
    };
  }

  const rate =
    typeof input.earnRate === "number" && Number.isFinite(input.earnRate) && input.earnRate > 0
      ? input.earnRate
      : POINT_EARN_RATE_DEFAULT;
  const paid = normalizePositiveInteger(input.paidAmount);
  const earned = Math.floor(paid * rate);

  if (earned <= 0) {
    return {
      applied: false,
      idempotent: false,
      pointsDelta: 0,
      balanceAfter: await readAccountBalance(db, personId),
      transactionId: null,
    };
  }

  await db
    .prepare(
      `INSERT INTO luggage_customer_point_accounts (account_person_id, balance_points, lifetime_earned_points, lifetime_used_points)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(account_person_id) DO UPDATE SET
         balance_points = balance_points + excluded.balance_points,
         lifetime_earned_points = lifetime_earned_points + excluded.lifetime_earned_points,
         updated_at = datetime('now')`
    )
    .bind(personId, earned, earned)
    .run();

  const balanceAfter = await readAccountBalance(db, personId);

  const insertRes = await db
    .prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(personId, orderId, TX_TYPE_EARN, earned, STATUS_POSTED, balanceAfter, idempotencyKey, `earn ${Math.round(rate * 100)}% of ${paid}`)
    .run();

  return {
    applied: true,
    idempotent: false,
    pointsDelta: earned,
    balanceAfter,
    transactionId: Number(insertRes.meta?.last_row_id ?? 0),
  };
}

export async function voidEarnedPointsForOrder(
  db: D1Database,
  orderId: string
): Promise<PointMutationResult> {
  const orderIdStr = String(orderId);
  const earnKey = EARN_KEY(orderIdStr);
  const voidKey = VOID_KEY(orderIdStr);

  const existingVoid = await findTransactionByKey(db, voidKey);
  if (existingVoid) {
    return {
      applied: false,
      idempotent: true,
      pointsDelta: existingVoid.points_delta,
      balanceAfter: existingVoid.balance_after,
      transactionId: existingVoid.transaction_id,
    };
  }

  const earnRow = await findTransactionByKey(db, earnKey);
  if (!earnRow || earnRow.status !== STATUS_POSTED || earnRow.points_delta <= 0) {
    return { applied: false, idempotent: false, pointsDelta: 0, balanceAfter: 0, transactionId: null };
  }

  const pointsToTakeBack = earnRow.points_delta;

  await db
    .prepare(
      `UPDATE luggage_customer_point_accounts
       SET balance_points = MAX(0, balance_points - ?),
           lifetime_earned_points = MAX(0, lifetime_earned_points - ?),
           updated_at = datetime('now')
       WHERE account_person_id = ?`
    )
    .bind(pointsToTakeBack, pointsToTakeBack, earnRow.account_person_id)
    .run();

  await db
    .prepare(
      `UPDATE luggage_customer_point_transactions
       SET status = ?, updated_at = datetime('now')
       WHERE transaction_id = ? AND status = ?`
    )
    .bind(STATUS_VOIDED, earnRow.transaction_id, STATUS_POSTED)
    .run();

  const balanceAfter = await readAccountBalance(db, earnRow.account_person_id);

  const insertRes = await db
    .prepare(
      `INSERT INTO luggage_customer_point_transactions
         (account_person_id, order_id, transaction_type, points_delta, status, balance_after, idempotency_key, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(earnRow.account_person_id, orderIdStr, TX_TYPE_VOID, -pointsToTakeBack, STATUS_POSTED, balanceAfter, voidKey, "void earned points")
    .run();

  return {
    applied: true,
    idempotent: false,
    pointsDelta: -pointsToTakeBack,
    balanceAfter,
    transactionId: Number(insertRes.meta?.last_row_id ?? 0),
  };
}

export type PointEffectsInput = {
  accountPersonId: string | null | undefined;
  orderId: string;
  fromStatus: string;
  toStatus: string;
  paidAmount: number;
};

/**
 * Apply point ledger effects for an order status transition.
 * Safe to call for guest orders (accountPersonId == null) — becomes a no-op.
 */
export async function applyPointEffectsForStatusChange(
  db: D1Database,
  input: PointEffectsInput
): Promise<void> {
  if (!input.accountPersonId) return;
  if (input.fromStatus === input.toStatus) return;

  if (input.toStatus === "PAID") {
    await commitReservedPointUseForOrder(db, input.orderId);
    await postEarnedPointsForPaidOrder(db, {
      accountPersonId: input.accountPersonId,
      orderId: input.orderId,
      paidAmount: input.paidAmount,
    });
    return;
  }

  if (input.toStatus === "CANCELLED") {
    await releaseReservedPointUseForOrder(db, input.orderId);
    if (input.fromStatus === "PAID" || input.fromStatus === "PICKED_UP") {
      await voidEarnedPointsForOrder(db, input.orderId);
    }
    return;
  }

  if (input.fromStatus === "PAID" && input.toStatus === "PAYMENT_PENDING") {
    await voidEarnedPointsForOrder(db, input.orderId);
  }
}

function resolvedNoUsage(payableAmount: number): ResolvedPointUsage {
  return {
    ok: true,
    pointsToUse: 0,
    pointDiscountAmount: 0,
    amountAfterPoints: payableAmount,
    pointUsageStatus: "NONE",
  };
}

function rejectedUsage(error: PointUsageValidationError, payableAmount: number): ResolvedPointUsage {
  return {
    ok: false,
    error,
    pointsToUse: 0,
    pointDiscountAmount: 0,
    amountAfterPoints: payableAmount,
    pointUsageStatus: "NONE",
  };
}

function normalizeMinimumUnit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return POINT_MINIMUM_USE_UNIT;
  return Math.max(1, Math.floor(value));
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
