import { describe, expect, it, beforeEach } from "vitest";
import {
  InsufficientPointsError,
  applyPointEffectsForStatusChange,
  calculatePointUsage,
  commitReservedPointUseForOrder,
  postEarnedPointsForPaidOrder,
  releaseReservedPointUseForOrder,
  reservePointUseForOrder,
  voidEarnedPointsForOrder,
} from "./points";

type Account = {
  account_person_id: string;
  balance_points: number;
  lifetime_earned_points: number;
  lifetime_used_points: number;
};

type Transaction = {
  transaction_id: number;
  account_person_id: string;
  order_id: string | null;
  transaction_type: string;
  points_delta: number;
  status: string;
  balance_after: number;
  idempotency_key: string;
  reason: string | null;
};

/**
 * In-memory D1 fake that understands exactly the SQL shapes our point helpers issue.
 * Pattern: dispatch by SQL substring; track changes/last_row_id like D1 meta.
 */
class FakeD1 {
  accounts = new Map<string, Account>();
  transactions: Transaction[] = [];
  private nextTxId = 1;

  seedAccount(personId: string, balance: number) {
    this.accounts.set(personId, {
      account_person_id: personId,
      balance_points: balance,
      lifetime_earned_points: 0,
      lifetime_used_points: 0,
    });
  }

  prepare(sql: string): FakeStmt {
    return new FakeStmt(this, sql);
  }
}

class FakeStmt {
  private boundValues: unknown[] = [];

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM luggage_customer_point_transactions")) {
      const key = String(this.boundValues[0]);
      const row = this.db.transactions.find((t) => t.idempotency_key === key);
      if (!row) return null;
      return {
        transaction_id: row.transaction_id,
        account_person_id: row.account_person_id,
        points_delta: row.points_delta,
        balance_after: row.balance_after,
        status: row.status,
      } as unknown as T;
    }
    if (this.sql.includes("FROM luggage_customer_point_accounts")) {
      const personId = String(this.boundValues[0]);
      const account = this.db.accounts.get(personId);
      return account ? ({ balance_points: account.balance_points } as unknown as T) : null;
    }
    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number } }> {
    if (this.sql.includes("UPDATE luggage_customer_point_accounts") && this.sql.includes("balance_points = balance_points - ?")) {
      // Conditional deduction
      const [delta, lifetimeDelta, personId, threshold] = this.boundValues as [number, number, string, number];
      const acct = this.db.accounts.get(personId);
      if (!acct || acct.balance_points < threshold) {
        return { meta: { changes: 0, last_row_id: 0 } };
      }
      this.db.accounts.set(personId, {
        ...acct,
        balance_points: acct.balance_points - delta,
        lifetime_used_points: acct.lifetime_used_points + lifetimeDelta,
      });
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    if (this.sql.includes("UPDATE luggage_customer_point_accounts") && this.sql.includes("balance_points = balance_points + ?")) {
      // Release: balance += points, lifetime_used = MAX(0, lifetime_used - points)
      const [points, lifetimeDelta, personId] = this.boundValues as [number, number, string];
      const acct = this.db.accounts.get(personId);
      if (!acct) return { meta: { changes: 0, last_row_id: 0 } };
      this.db.accounts.set(personId, {
        ...acct,
        balance_points: acct.balance_points + points,
        lifetime_used_points: Math.max(0, acct.lifetime_used_points - lifetimeDelta),
      });
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    if (this.sql.includes("UPDATE luggage_customer_point_accounts") && this.sql.includes("balance_points = MAX(0, balance_points - ?)")) {
      // Void earn: balance = MAX(0, balance - points), lifetime_earned = MAX(0, lifetime_earned - points)
      const [points, lifetimeDelta, personId] = this.boundValues as [number, number, string];
      const acct = this.db.accounts.get(personId);
      if (!acct) return { meta: { changes: 0, last_row_id: 0 } };
      this.db.accounts.set(personId, {
        ...acct,
        balance_points: Math.max(0, acct.balance_points - points),
        lifetime_earned_points: Math.max(0, acct.lifetime_earned_points - lifetimeDelta),
      });
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    if (this.sql.includes("INSERT INTO luggage_customer_point_accounts")) {
      // Earn upsert
      const [personId, balanceDelta, lifetimeEarnedDelta] = this.boundValues as [string, number, number];
      const acct = this.db.accounts.get(personId);
      if (!acct) {
        this.db.accounts.set(personId, {
          account_person_id: personId,
          balance_points: balanceDelta,
          lifetime_earned_points: lifetimeEarnedDelta,
          lifetime_used_points: 0,
        });
      } else {
        this.db.accounts.set(personId, {
          ...acct,
          balance_points: acct.balance_points + balanceDelta,
          lifetime_earned_points: acct.lifetime_earned_points + lifetimeEarnedDelta,
        });
      }
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    if (this.sql.includes("INSERT INTO luggage_customer_point_transactions")) {
      const [personId, orderId, transactionType, pointsDelta, status, balanceAfter, idempotencyKey, reason] =
        this.boundValues as [string, string | null, string, number, string, number, string, string | null];
      // UNIQUE constraint on idempotency_key
      if (this.db.transactions.some((t) => t.idempotency_key === idempotencyKey)) {
        throw new Error(`UNIQUE constraint failed: idempotency_key ${idempotencyKey}`);
      }
      const tx: Transaction = {
        transaction_id: this.db["nextTxId"]++ as number,
        account_person_id: personId,
        order_id: orderId,
        transaction_type: transactionType,
        points_delta: pointsDelta,
        status,
        balance_after: balanceAfter,
        idempotency_key: idempotencyKey,
        reason,
      };
      this.db.transactions.push(tx);
      return { meta: { changes: 1, last_row_id: tx.transaction_id } };
    }
    if (this.sql.includes("UPDATE luggage_customer_point_transactions")) {
      // Status transition
      const [newStatus, txId, expectedStatus] = this.boundValues as [string, number, string];
      const tx = this.db.transactions.find((t) => t.transaction_id === txId && t.status === expectedStatus);
      if (!tx) return { meta: { changes: 0, last_row_id: 0 } };
      tx.status = newStatus;
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    throw new Error(`Unsupported run() SQL: ${this.sql}`);
  }
}

function asDb(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}

describe("calculatePointUsage", () => {
  it("caps point usage by request, balance, and payable amount", () => {
    expect(calculatePointUsage({ requestedPoints: 2000, balancePoints: 800, payableAmount: 1200 })).toEqual({
      pointsToUse: 800,
      amountAfterPoints: 400,
    });
  });

  it("rounds partial use down to the minimum unit", () => {
    expect(calculatePointUsage({ requestedPoints: 850, balancePoints: 2000, payableAmount: 1200, minimumUnit: 100 })).toEqual({
      pointsToUse: 800,
      amountAfterPoints: 400,
    });
  });

  it("allows exact full payment even when it is not a minimum-unit multiple", () => {
    expect(calculatePointUsage({ requestedPoints: 950, balancePoints: 950, payableAmount: 950, minimumUnit: 100 })).toEqual({
      pointsToUse: 950,
      amountAfterPoints: 0,
    });
  });

  it("normalizes invalid values to zero", () => {
    expect(calculatePointUsage({ requestedPoints: -1, balancePoints: 1000, payableAmount: 1200 })).toEqual({
      pointsToUse: 0,
      amountAfterPoints: 1200,
    });
  });
});

describe("reservePointUseForOrder", () => {
  let db: FakeD1;
  beforeEach(() => {
    db = new FakeD1();
  });

  it("deducts the balance and records a RESERVED transaction", async () => {
    db.seedAccount("person-1", 1500);
    const result = await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(1000);
    expect(result.pointsDelta).toBe(-500);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1000);
    const tx = db.transactions.find((t) => t.idempotency_key === "point:reserve:ord-1");
    expect(tx?.status).toBe("RESERVED");
    expect(tx?.points_delta).toBe(-500);
  });

  it("throws when balance is insufficient and leaves state untouched", async () => {
    db.seedAccount("person-1", 100);
    await expect(
      reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 })
    ).rejects.toBeInstanceOf(InsufficientPointsError);
    expect(db.accounts.get("person-1")?.balance_points).toBe(100);
    expect(db.transactions).toHaveLength(0);
  });

  it("is idempotent for the same orderId", async () => {
    db.seedAccount("person-1", 1500);
    const first = await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    const second = await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    expect(second.applied).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1000);
    expect(db.transactions).toHaveLength(1);
  });
});

describe("commitReservedPointUseForOrder", () => {
  it("transitions RESERVED to POSTED without touching the balance", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    const balanceBefore = db.accounts.get("person-1")?.balance_points;

    const result = await commitReservedPointUseForOrder(asDb(db), "ord-1");
    expect(result.applied).toBe(true);
    expect(db.transactions[0].status).toBe("POSTED");
    expect(db.accounts.get("person-1")?.balance_points).toBe(balanceBefore);
  });

  it("is idempotent when called twice", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    await commitReservedPointUseForOrder(asDb(db), "ord-1");
    const second = await commitReservedPointUseForOrder(asDb(db), "ord-1");
    expect(second.idempotent).toBe(true);
    expect(db.transactions[0].status).toBe("POSTED");
  });

  it("is a no-op when there is no reservation", async () => {
    const db = new FakeD1();
    const result = await commitReservedPointUseForOrder(asDb(db), "ord-1");
    expect(result.applied).toBe(false);
    expect(result.transactionId).toBeNull();
  });
});

describe("releaseReservedPointUseForOrder", () => {
  it("restores the balance and inserts a RELEASE transaction", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    const result = await releaseReservedPointUseForOrder(asDb(db), "ord-1");

    expect(result.applied).toBe(true);
    expect(result.balanceAfter).toBe(1500);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1500);
    expect(db.transactions.find((t) => t.idempotency_key === "point:reserve:ord-1")?.status).toBe("RELEASED");
    expect(db.transactions.find((t) => t.idempotency_key === "point:release:ord-1")?.points_delta).toBe(500);
  });

  it("is idempotent and does not double-restore the balance", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    await releaseReservedPointUseForOrder(asDb(db), "ord-1");
    const second = await releaseReservedPointUseForOrder(asDb(db), "ord-1");

    expect(second.idempotent).toBe(true);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1500);
  });

  it("does nothing once the reservation has been committed (POSTED)", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    await commitReservedPointUseForOrder(asDb(db), "ord-1");

    const result = await releaseReservedPointUseForOrder(asDb(db), "ord-1");
    expect(result.applied).toBe(false);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1000);
  });
});

describe("postEarnedPointsForPaidOrder", () => {
  it("creates the account if missing and posts the earned points", async () => {
    const db = new FakeD1();
    const result = await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 1500 });

    expect(result.applied).toBe(true);
    expect(result.pointsDelta).toBe(15);
    expect(db.accounts.get("person-1")?.balance_points).toBe(15);
    expect(db.transactions[0].status).toBe("POSTED");
  });

  it("is idempotent for the same order", async () => {
    const db = new FakeD1();
    await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 1500 });
    const second = await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 1500 });
    expect(second.idempotent).toBe(true);
    expect(db.accounts.get("person-1")?.balance_points).toBe(15);
    expect(db.transactions).toHaveLength(1);
  });

  it("is a no-op when the earned amount rounds to zero", async () => {
    const db = new FakeD1();
    const result = await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 50 });
    expect(result.applied).toBe(false);
    expect(result.pointsDelta).toBe(0);
    expect(db.accounts.has("person-1")).toBe(false);
  });
});

describe("voidEarnedPointsForOrder", () => {
  it("reverses an earned posting and records a VOID transaction", async () => {
    const db = new FakeD1();
    await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 1500 });
    const result = await voidEarnedPointsForOrder(asDb(db), "ord-1");

    expect(result.applied).toBe(true);
    expect(result.pointsDelta).toBe(-15);
    expect(db.accounts.get("person-1")?.balance_points).toBe(0);
    expect(db.transactions.find((t) => t.idempotency_key === "point:earn:ord-1")?.status).toBe("VOIDED");
  });

  it("is idempotent for repeated calls", async () => {
    const db = new FakeD1();
    await postEarnedPointsForPaidOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", paidAmount: 1500 });
    await voidEarnedPointsForOrder(asDb(db), "ord-1");
    const second = await voidEarnedPointsForOrder(asDb(db), "ord-1");
    expect(second.idempotent).toBe(true);
    expect(db.accounts.get("person-1")?.balance_points).toBe(0);
  });

  it("does nothing when nothing was ever earned", async () => {
    const db = new FakeD1();
    const result = await voidEarnedPointsForOrder(asDb(db), "ord-1");
    expect(result.applied).toBe(false);
    expect(result.transactionId).toBeNull();
  });
});

describe("applyPointEffectsForStatusChange", () => {
  it("does nothing for guest orders", async () => {
    const db = new FakeD1();
    await applyPointEffectsForStatusChange(asDb(db), {
      accountPersonId: null,
      orderId: "ord-1",
      fromStatus: "PAYMENT_PENDING",
      toStatus: "PAID",
      paidAmount: 1500,
    });
    expect(db.transactions).toHaveLength(0);
  });

  it("commits reservations and earns on PAYMENT_PENDING -> PAID", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });

    await applyPointEffectsForStatusChange(asDb(db), {
      accountPersonId: "person-1",
      orderId: "ord-1",
      fromStatus: "PAYMENT_PENDING",
      toStatus: "PAID",
      paidAmount: 1000,
    });

    expect(db.transactions.find((t) => t.idempotency_key === "point:reserve:ord-1")?.status).toBe("POSTED");
    expect(db.transactions.find((t) => t.idempotency_key === "point:earn:ord-1")?.points_delta).toBe(10);
    expect(db.accounts.get("person-1")?.balance_points).toBe(1010);
  });

  it("releases reservations and voids earnings on cancellation", async () => {
    const db = new FakeD1();
    db.seedAccount("person-1", 1500);
    await reservePointUseForOrder(asDb(db), { accountPersonId: "person-1", orderId: "ord-1", pointsToUse: 500 });
    await applyPointEffectsForStatusChange(asDb(db), {
      accountPersonId: "person-1",
      orderId: "ord-1",
      fromStatus: "PAYMENT_PENDING",
      toStatus: "PAID",
      paidAmount: 1000,
    });

    await applyPointEffectsForStatusChange(asDb(db), {
      accountPersonId: "person-1",
      orderId: "ord-1",
      fromStatus: "PAID",
      toStatus: "CANCELLED",
      paidAmount: 1000,
    });

    expect(db.transactions.find((t) => t.idempotency_key === "point:earn:ord-1")?.status).toBe("VOIDED");
    // Reservation was already committed (POSTED), so it stays POSTED and the release is a no-op
    expect(db.transactions.find((t) => t.idempotency_key === "point:reserve:ord-1")?.status).toBe("POSTED");
    expect(db.accounts.get("person-1")?.balance_points).toBe(1000);
  });
});
