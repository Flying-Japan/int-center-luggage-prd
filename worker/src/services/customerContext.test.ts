import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { AppType, CustomerSession } from "../types";
import {
  getCurrentCustomer,
  loadCustomerContext,
  loadCustomerProfile,
  loadPointBalance,
  loadRecentCustomerOrders,
} from "./customerContext";

type RawProfile = {
  account_person_id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  identity_verified_at: string | null;
};

type RawRecentOrder = {
  order_id: string;
  account_person_id: string | null;
  created_at: string;
  suitcase_qty: number | null;
  backpack_qty: number | null;
  companion_count: number | null;
  payment_method: string | null;
  gross_amount: number | null;
  prepaid_amount: number | null;
  point_discount_amount: number | null;
  final_amount: number | null;
  status: string;
  parent_order_id: string | null;
};

class FakePreparedStatement {
  private boundValues: unknown[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const personId = String(this.boundValues[0]);

    if (this.sql.includes("FROM luggage_customer_profiles")) {
      return (this.db.profiles.get(personId) ?? null) as T | null;
    }

    if (this.sql.includes("FROM luggage_customer_point_accounts")) {
      const balance = this.db.pointBalances.get(personId);
      return (balance == null ? null : { balance_points: balance }) as T | null;
    }

    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (!this.sql.includes("FROM luggage_orders")) {
      throw new Error(`Unsupported all() SQL: ${this.sql}`);
    }

    const personId = String(this.boundValues[0]);
    const limit = Number(this.boundValues[1]);
    const results = this.db.orders
      .filter((order) =>
        order.account_person_id === personId &&
        order.parent_order_id === null &&
        ["PAID", "PICKED_UP", "PAYMENT_PENDING"].includes(order.status)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);

    return { results: results as T[] };
  }
}

class FakeDb {
  profiles = new Map<string, RawProfile>();
  pointBalances = new Map<string, number>();
  orders: RawRecentOrder[] = [];

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }
}

function buildContext(session: CustomerSession | null, db: FakeDb): Context<AppType> {
  return {
    get: (key: string) => key === "customer" ? session ?? undefined : undefined,
    env: { DB: db },
  } as unknown as Context<AppType>;
}

describe("customer context service", () => {
  it("returns null when no customer session exists", () => {
    const db = new FakeDb();
    expect(getCurrentCustomer(buildContext(null, db))).toBeNull();
  });

  it("loads profile and point balance by Account person_id", async () => {
    const db = new FakeDb();
    db.profiles.set("person-1", {
      account_person_id: "person-1",
      display_name: "Kim",
      phone: "080-0000-0000",
      email: "kim@example.com",
      locale: "ko",
      identity_verified_at: null,
    });
    db.pointBalances.set("person-1", 1500);

    await expect(loadCustomerProfile(db as unknown as D1Database, "person-1")).resolves.toEqual({
      accountPersonId: "person-1",
      displayName: "Kim",
      phone: "080-0000-0000",
      email: "kim@example.com",
      locale: "ko",
      identityVerifiedAt: null,
    });
    await expect(loadPointBalance(db as unknown as D1Database, "person-1")).resolves.toBe(1500);
  });

  it("returns recent root orders only and excludes cancelled or extension rows", async () => {
    const db = new FakeDb();
    db.orders = [
      {
        order_id: "old",
        account_person_id: "person-1",
        created_at: "2026-05-01 10:00:00",
        suitcase_qty: 1,
        backpack_qty: 1,
        companion_count: 0,
        payment_method: "CASH",
        gross_amount: 0,
        prepaid_amount: 1200,
        point_discount_amount: 0,
        final_amount: 1200,
        status: "PAID",
        parent_order_id: null,
      },
      {
        order_id: "new",
        account_person_id: "person-1",
        created_at: "2026-05-02 10:00:00",
        suitcase_qty: 2,
        backpack_qty: 0,
        companion_count: 1,
        payment_method: "PAY_QR",
        gross_amount: 1600,
        prepaid_amount: 1600,
        point_discount_amount: 0,
        final_amount: 1600,
        status: "PAYMENT_PENDING",
        parent_order_id: null,
      },
      {
        order_id: "extension",
        account_person_id: "person-1",
        created_at: "2026-05-03 10:00:00",
        suitcase_qty: 2,
        backpack_qty: 0,
        companion_count: 0,
        payment_method: null,
        gross_amount: 800,
        prepaid_amount: 800,
        point_discount_amount: 0,
        final_amount: 800,
        status: "PAYMENT_PENDING",
        parent_order_id: "new",
      },
      {
        order_id: "cancelled",
        account_person_id: "person-1",
        created_at: "2026-05-04 10:00:00",
        suitcase_qty: 1,
        backpack_qty: 0,
        companion_count: 0,
        payment_method: "CASH",
        gross_amount: 800,
        prepaid_amount: 800,
        point_discount_amount: 0,
        final_amount: 800,
        status: "CANCELLED",
        parent_order_id: null,
      },
    ];

    await expect(loadRecentCustomerOrders(db as unknown as D1Database, "person-1", 3)).resolves.toEqual([
      {
        orderId: "new",
        createdAt: "2026-05-02 10:00:00",
        suitcaseQty: 2,
        backpackQty: 0,
        companionCount: 1,
        paymentMethod: "PAY_QR",
        grossAmount: 1600,
        pointDiscountAmount: 0,
        finalAmount: 1600,
        status: "PAYMENT_PENDING",
      },
      {
        orderId: "old",
        createdAt: "2026-05-01 10:00:00",
        suitcaseQty: 1,
        backpackQty: 1,
        companionCount: 0,
        paymentMethod: "CASH",
        grossAmount: 1200,
        pointDiscountAmount: 0,
        finalAmount: 1200,
        status: "PAID",
      },
    ]);
  });

  it("loads the combined authenticated context", async () => {
    const db = new FakeDb();
    const session: CustomerSession = {
      personId: "person-1",
      email: "kim@example.com",
      provider: "test",
      issuedBy: "pub-account",
    };
    db.pointBalances.set("person-1", 300);

    await expect(loadCustomerContext(buildContext(session, db))).resolves.toMatchObject({
      session,
      pointBalance: 300,
      isAuthenticated: true,
    });
  });
});
