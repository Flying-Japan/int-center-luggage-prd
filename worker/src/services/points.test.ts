import { beforeEach, describe, expect, it } from "vitest";
import {
  calculatePointUsage,
  commitReservedPointUseForOrder,
  InsufficientPointBalanceError,
  postEarnedPointsForPaidOrder,
  releaseReservedPointUseForOrder,
  reservePointUseForOrder,
  voidEarnedPointsForOrder,
} from "./points";

describe("calculatePointUsage", () => {
  it("caps point usage by request, balance, and payable amount", () => {
    expect(calculatePointUsage({
      requestedPoints: 2000,
      balancePoints: 800,
      payableAmount: 1200,
    })).toEqual({ pointsToUse: 800, amountAfterPoints: 400 });
  });

  it("rounds partial use down to the minimum unit", () => {
    expect(calculatePointUsage({
      requestedPoints: 850,
      balancePoints: 2000,
      payableAmount: 1200,
      minimumUnit: 100,
    })).toEqual({ pointsToUse: 800, amountAfterPoints: 400 });
  });

  it("allows exact full payment even when it is not a minimum-unit multiple", () => {
    expect(calculatePointUsage({
      requestedPoints: 950,
      balancePoints: 950,
      payableAmount: 950,
      minimumUnit: 100,
    })).toEqual({ pointsToUse: 950, amountAfterPoints: 0 });
  });

  it("normalizes invalid values to zero", () => {
    expect(calculatePointUsage({
      requestedPoints: -1,
      balancePoints: 1000,
      payableAmount: 1200,
    })).toEqual({ pointsToUse: 0, amountAfterPoints: 1200 });
  });
});

type PointAccountRecord = {
  account_person_id: string;
  balance_points: number;
  lifetime_earned_points: number;
  lifetime_used_points: number;
};

type PointTransactionRecord = {
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

type OrderRecord = {
  order_id: string;
  account_person_id: string | null;
  prepaid_amount: number | null;
  final_amount: number | null;
  extra_amount: number | null;
  point_discount_amount: number | null;
  points_used: number | null;
  points_earned: number;
  flying_pass_discount_amount: number | null;
};

class FakeDb {
  accounts = new Map<string, PointAccountRecord>();
  transactions: PointTransactionRecord[] = [];
  orders = new Map<string, OrderRecord>();
  private nextTransactionId = 1;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    const results: { meta: { changes: number } }[] = [];
    for (const statement of statements) {
      const changes = statement.execute();
      results.push({ meta: { changes } });
    }
    return results;
  }

  allocateTransactionId() {
    const id = this.nextTransactionId;
    this.nextTransactionId += 1;
    return id;
  }
}

class FakeStatement {
  private boundValues: unknown[] = [];

  constructor(private readonly db: FakeDb, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM luggage_customer_point_transactions")) {
      const key = String(this.boundValues[0]);
      const row = this.db.transactions.find((t) => t.idempotency_key === key);
      return (row ?? null) as T | null;
    }
    if (this.sql.includes("FROM luggage_customer_point_accounts")) {
      const id = String(this.boundValues[0]);
      const account = this.db.accounts.get(id);
      return (account ? { balance_points: account.balance_points } : null) as T | null;
    }
    if (this.sql.includes("FROM luggage_orders")) {
      const id = String(this.boundValues[0]);
      const order = this.db.orders.get(id);
      if (!order) return null;
      return {
        account_person_id: order.account_person_id,
        prepaid_amount: order.prepaid_amount,
        final_amount: order.final_amount,
        extra_amount: order.extra_amount,
        point_discount_amount: order.point_discount_amount,
        points_used: order.points_used,
        flying_pass_discount_amount: order.flying_pass_discount_amount,
      } as T;
    }
    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async run() {
    const changes = this.execute();
    return { meta: { changes } };
  }

  execute(): number {
    if (this.sql.startsWith("INSERT OR IGNORE INTO luggage_customer_point_accounts")) {
      const id = String(this.boundValues[0]);
      if (this.db.accounts.has(id)) return 0;
      this.db.accounts.set(id, {
        account_person_id: id,
        balance_points: 0,
        lifetime_earned_points: 0,
        lifetime_used_points: 0,
      });
      return 1;
    }
    if (this.sql.startsWith("UPDATE luggage_customer_point_accounts")) {
      const account = this.findAccountForUpdate();
      if (!account) return 0;
      const setBalanceMinus = /SET balance_points = balance_points - \?/.test(this.sql);
      const setBalancePlus = /SET balance_points = balance_points \+ \?/.test(this.sql);
      const setBalanceMaxMinus = /SET balance_points = MAX\(0, balance_points - \?\)/.test(this.sql);
      if (setBalanceMinus) {
        const delta = Number(this.boundValues[0]);
        const used = Number(this.boundValues[1]);
        if (account.balance_points < delta) return 0;
        account.balance_points -= delta;
        account.lifetime_used_points += used;
        return 1;
      }
      if (setBalancePlus) {
        const delta = Number(this.boundValues[0]);
        if (/lifetime_used_points = MAX\(0, lifetime_used_points - \?\)/.test(this.sql)) {
          const reduction = Number(this.boundValues[1]);
          account.balance_points += delta;
          account.lifetime_used_points = Math.max(0, account.lifetime_used_points - reduction);
          return 1;
        }
        if (/lifetime_earned_points = lifetime_earned_points \+ \?/.test(this.sql)) {
          const earned = Number(this.boundValues[1]);
          account.balance_points += delta;
          account.lifetime_earned_points += earned;
          return 1;
        }
        account.balance_points += delta;
        return 1;
      }
      if (setBalanceMaxMinus) {
        const reverse = Number(this.boundValues[0]);
        const earnReduce = Number(this.boundValues[1]);
        account.balance_points = Math.max(0, account.balance_points - reverse);
        account.lifetime_earned_points = Math.max(0, account.lifetime_earned_points - earnReduce);
        return 1;
      }
      return 0;
    }
    if (this.sql.startsWith("INSERT INTO luggage_customer_point_transactions")) {
      const [accountPersonId, orderId, pointsDelta, balanceAfter, idempotencyKey, reason] = this.boundValues;
      if (this.db.transactions.some((t) => t.idempotency_key === idempotencyKey)) {
        throw new Error(`UNIQUE constraint failed: idempotency_key=${String(idempotencyKey)}`);
      }
      const transactionType = this.extractTransactionType();
      const status = this.extractStatus();
      this.db.transactions.push({
        transaction_id: this.db.allocateTransactionId(),
        account_person_id: String(accountPersonId),
        order_id: orderId == null ? null : String(orderId),
        transaction_type: transactionType,
        points_delta: Number(pointsDelta),
        status,
        balance_after: Number(balanceAfter),
        idempotency_key: String(idempotencyKey),
        reason: reason == null ? null : String(reason),
      });
      return 1;
    }
    if (this.sql.startsWith("DELETE FROM luggage_customer_point_transactions")) {
      const key = String(this.boundValues[0]);
      const before = this.db.transactions.length;
      this.db.transactions = this.db.transactions.filter((t) => t.idempotency_key !== key);
      return before - this.db.transactions.length;
    }
    if (this.sql.startsWith("UPDATE luggage_customer_point_transactions")) {
      const key = String(this.boundValues[0]);
      const targetStatus = /SET status = 'POSTED'/.test(this.sql) ? "POSTED" : "VOIDED";
      const allowedFrom = this.extractAllowedFromStatuses();
      let changes = 0;
      this.db.transactions = this.db.transactions.map((t) => {
        if (t.idempotency_key !== key) return t;
        if (!allowedFrom.includes(t.status)) return t;
        changes += 1;
        return { ...t, status: targetStatus };
      });
      return changes;
    }
    if (this.sql.startsWith("UPDATE luggage_orders")) {
      const matches = this.sql.match(/SET points_earned = (\?|0)/);
      if (!matches) return 0;
      if (matches[1] === "0") {
        const orderId = String(this.boundValues[0]);
        const order = this.db.orders.get(orderId);
        if (!order) return 0;
        order.points_earned = 0;
        return 1;
      }
      const earned = Number(this.boundValues[0]);
      const orderId = String(this.boundValues[1]);
      const order = this.db.orders.get(orderId);
      if (!order) return 0;
      order.points_earned = earned;
      return 1;
    }
    throw new Error(`Unsupported execute SQL: ${this.sql}`);
  }

  private findAccountForUpdate(): PointAccountRecord | undefined {
    const idIndex = this.boundValues.length - (this.sql.includes("AND balance_points >= ?") ? 2 : 1);
    const id = String(this.boundValues[idIndex]);
    return this.db.accounts.get(id);
  }

  private extractTransactionType(): string {
    if (/'USE_RESERVE'/.test(this.sql)) return "USE_RESERVE";
    if (/'USE_COMMIT'/.test(this.sql)) return "USE_COMMIT";
    if (/'USE_RELEASE'/.test(this.sql)) return "USE_RELEASE";
    if (/'EARN_VOID'/.test(this.sql)) return "EARN_VOID";
    if (/'EARN'/.test(this.sql)) return "EARN";
    return "UNKNOWN";
  }

  private extractStatus(): string {
    if (/'RESERVED'/.test(this.sql)) return "RESERVED";
    return "POSTED";
  }

  private extractAllowedFromStatuses(): string[] {
    const whereIndex = this.sql.toUpperCase().indexOf("WHERE");
    const whereClause = whereIndex >= 0 ? this.sql.slice(whereIndex) : this.sql;
    const match = whereClause.match(/status IN \(([^)]+)\)/);
    if (match) {
      return match[1].split(",").map((s) => s.trim().replace(/'/g, ""));
    }
    const single = whereClause.match(/status = '([^']+)'/);
    if (single) return [single[1]];
    return ["RESERVED", "POSTED", "VOIDED"];
  }
}

function seedAccount(db: FakeDb, accountPersonId: string, balance: number) {
  db.accounts.set(accountPersonId, {
    account_person_id: accountPersonId,
    balance_points: balance,
    lifetime_earned_points: 0,
    lifetime_used_points: 0,
  });
}

function seedOrder(db: FakeDb, order: Partial<OrderRecord> & { order_id: string }) {
  db.orders.set(order.order_id, {
    order_id: order.order_id,
    account_person_id: order.account_person_id ?? null,
    prepaid_amount: order.prepaid_amount ?? 0,
    final_amount: order.final_amount ?? 0,
    extra_amount: order.extra_amount ?? 0,
    point_discount_amount: order.point_discount_amount ?? 0,
    points_used: order.points_used ?? 0,
    points_earned: order.points_earned ?? 0,
    flying_pass_discount_amount: order.flying_pass_discount_amount ?? 0,
  });
}

describe("point ledger operations", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("reservePointUseForOrder is a noop when no points are requested", async () => {
    seedAccount(db, "p1", 500);
    const result = await reservePointUseForOrder(db as unknown as D1Database, {
      accountPersonId: "p1",
      orderId: "o1",
      pointsToUse: 0,
    });
    expect(result.outcome).toBe("noop");
    expect(db.accounts.get("p1")?.balance_points).toBe(500);
    expect(db.transactions).toHaveLength(0);
  });

  it("reservePointUseForOrder throws when balance is insufficient", async () => {
    seedAccount(db, "p1", 100);
    await expect(
      reservePointUseForOrder(db as unknown as D1Database, {
        accountPersonId: "p1",
        orderId: "o1",
        pointsToUse: 500,
      })
    ).rejects.toBeInstanceOf(InsufficientPointBalanceError);
    expect(db.accounts.get("p1")?.balance_points).toBe(100);
    expect(db.transactions).toHaveLength(0);
  });

  it("reservePointUseForOrder reserves and is idempotent for the same order", async () => {
    seedAccount(db, "p1", 1500);
    const first = await reservePointUseForOrder(db as unknown as D1Database, {
      accountPersonId: "p1",
      orderId: "o1",
      pointsToUse: 800,
    });
    expect(first.outcome).toBe("applied");
    expect(first.balanceAfter).toBe(700);
    expect(db.accounts.get("p1")?.balance_points).toBe(700);
    expect(db.accounts.get("p1")?.lifetime_used_points).toBe(800);

    const second = await reservePointUseForOrder(db as unknown as D1Database, {
      accountPersonId: "p1",
      orderId: "o1",
      pointsToUse: 800,
    });
    expect(second.outcome).toBe("already");
    expect(db.accounts.get("p1")?.balance_points).toBe(700);
    expect(db.transactions.filter((t) => t.transaction_type === "USE_RESERVE")).toHaveLength(1);
  });

  it("commitReservedPointUseForOrder transitions reserved use to posted exactly once", async () => {
    seedAccount(db, "p1", 1000);
    await reservePointUseForOrder(db as unknown as D1Database, {
      accountPersonId: "p1",
      orderId: "o1",
      pointsToUse: 400,
    });

    const first = await commitReservedPointUseForOrder(db as unknown as D1Database, "o1");
    expect(first.outcome).toBe("applied");
    expect(db.accounts.get("p1")?.balance_points).toBe(600);
    const reserveTx = db.transactions.find((t) => t.transaction_type === "USE_RESERVE");
    expect(reserveTx?.status).toBe("POSTED");

    const second = await commitReservedPointUseForOrder(db as unknown as D1Database, "o1");
    expect(second.outcome).toBe("already");
    expect(db.transactions.filter((t) => t.transaction_type === "USE_COMMIT")).toHaveLength(1);
  });

  it("releaseReservedPointUseForOrder restores balance once", async () => {
    seedAccount(db, "p1", 1000);
    await reservePointUseForOrder(db as unknown as D1Database, {
      accountPersonId: "p1",
      orderId: "o1",
      pointsToUse: 400,
    });
    expect(db.accounts.get("p1")?.balance_points).toBe(600);

    const first = await releaseReservedPointUseForOrder(db as unknown as D1Database, "o1");
    expect(first.outcome).toBe("applied");
    expect(first.pointsDelta).toBe(400);
    expect(db.accounts.get("p1")?.balance_points).toBe(1000);

    const second = await releaseReservedPointUseForOrder(db as unknown as D1Database, "o1");
    expect(second.outcome).toBe("already");
    expect(db.accounts.get("p1")?.balance_points).toBe(1000);
  });

  it("releaseReservedPointUseForOrder is a noop when no reservation exists", async () => {
    const result = await releaseReservedPointUseForOrder(db as unknown as D1Database, "missing");
    expect(result.outcome).toBe("noop");
  });

  it("postEarnedPointsForPaidOrder posts 1% of collected amount exactly once", async () => {
    seedOrder(db, {
      order_id: "o1",
      account_person_id: "p1",
      final_amount: 2000,
      prepaid_amount: 2000,
    });

    const first = await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    expect(first.outcome).toBe("applied");
    expect(first.pointsDelta).toBe(20);
    expect(db.accounts.get("p1")?.balance_points).toBe(20);
    expect(db.accounts.get("p1")?.lifetime_earned_points).toBe(20);
    expect(db.orders.get("o1")?.points_earned).toBe(20);

    const second = await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    expect(second.outcome).toBe("already");
    expect(db.accounts.get("p1")?.balance_points).toBe(20);
  });

  it("postEarnedPointsForPaidOrder is a noop for guest orders", async () => {
    seedOrder(db, {
      order_id: "o1",
      account_person_id: null,
      final_amount: 5000,
      prepaid_amount: 5000,
    });
    const result = await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    expect(result.outcome).toBe("noop");
    expect(db.transactions).toHaveLength(0);
  });

  it("postEarnedPointsForPaidOrder is a noop when collected amount is zero", async () => {
    seedOrder(db, {
      order_id: "o1",
      account_person_id: "p1",
      final_amount: 0,
      prepaid_amount: 0,
      points_used: 1000,
      point_discount_amount: 1000,
    });
    const result = await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    expect(result.outcome).toBe("noop");
    expect(db.accounts.get("p1")).toBeUndefined();
  });

  it("voidEarnedPointsForOrder reverses earned points once", async () => {
    seedOrder(db, {
      order_id: "o1",
      account_person_id: "p1",
      final_amount: 3000,
      prepaid_amount: 3000,
    });
    await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    expect(db.accounts.get("p1")?.balance_points).toBe(30);

    const first = await voidEarnedPointsForOrder(db as unknown as D1Database, "o1");
    expect(first.outcome).toBe("applied");
    expect(first.pointsDelta).toBe(-30);
    expect(db.accounts.get("p1")?.balance_points).toBe(0);
    expect(db.orders.get("o1")?.points_earned).toBe(0);

    const second = await voidEarnedPointsForOrder(db as unknown as D1Database, "o1");
    expect(second.outcome).toBe("already");
  });

  it("voidEarnedPointsForOrder is a noop when no earn exists", async () => {
    const result = await voidEarnedPointsForOrder(db as unknown as D1Database, "missing");
    expect(result.outcome).toBe("noop");
  });

  it("voidEarnedPointsForOrder caps reversal at the current balance to avoid going negative", async () => {
    seedOrder(db, {
      order_id: "o1",
      account_person_id: "p1",
      final_amount: 3000,
      prepaid_amount: 3000,
    });
    await postEarnedPointsForPaidOrder(db as unknown as D1Database, "o1");
    const account = db.accounts.get("p1");
    if (account) {
      account.balance_points = 10; // customer already spent 20 of the earned points elsewhere
    }

    const result = await voidEarnedPointsForOrder(db as unknown as D1Database, "o1");
    expect(result.outcome).toBe("applied");
    expect(result.balanceAfter).toBe(0);
    expect(db.accounts.get("p1")?.balance_points).toBe(0);
  });
});
