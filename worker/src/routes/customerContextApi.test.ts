import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppType, CustomerSession } from "../types";
import customerRoutes from "./customer";

type ProfileRow = {
  account_person_id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  identity_verified_at: string | null;
};

type RecentOrderRow = {
  order_id: string;
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
  name?: string;
  phone?: string;
  email?: string;
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
    if (this.sql.includes("FROM luggage_customer_profiles")) {
      return this.db.profile as T | null;
    }

    if (this.sql.includes("FROM luggage_customer_point_accounts")) {
      return { balance_points: this.db.pointBalance } as T;
    }

    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM luggage_orders") && this.sql.includes("ORDER BY created_at")) {
      return { results: this.db.recentOrders as T[] };
    }

    throw new Error(`Unsupported all() SQL: ${this.sql}`);
  }
}

class FakeDb {
  profile: ProfileRow | null = null;
  pointBalance = 0;
  recentOrders: RecentOrderRow[] = [];

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }
}

function buildApp(session: CustomerSession | null, db: unknown) {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    if (session) c.set("customer", session);
    return next();
  });
  app.route("/", customerRoutes);
  return {
    app,
    env: {
      DB: db,
    } as unknown as AppType["Bindings"],
  };
}

describe("GET /customer/api/context", () => {
  it("returns an anonymous no-store context without querying customer tables", async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error("anonymous context should not query D1");
      }),
    };
    const { app, env } = buildApp(null, db);

    const response = await app.fetch(new Request("https://luggage.test/customer/api/context"), env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      is_authenticated: false,
      point_balance: 0,
      recent_orders: [],
    });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("returns only safe preset fields for a signed customer context", async () => {
    const db = new FakeDb();
    db.profile = {
      account_person_id: "person-1",
      display_name: "Kim Customer",
      phone: "010-1111-2222",
      email: "kim@example.com",
      locale: "ko",
      identity_verified_at: "2026-05-20T00:00:00.000Z",
    };
    db.pointBalance = 1200;
    db.recentOrders = [{
      order_id: "20260521-001",
      created_at: "2026-05-21 09:00:00",
      suitcase_qty: 1,
      backpack_qty: 1,
      companion_count: 2,
      payment_method: "CASH",
      gross_amount: 1200,
      prepaid_amount: 1200,
      point_discount_amount: 100,
      final_amount: 1100,
      status: "PAID",
      name: "Kim Customer",
      phone: "010-1111-2222",
      email: "kim@example.com",
    }];
    const { app, env } = buildApp({
      email: "kim@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const response = await app.fetch(new Request("https://luggage.test/customer/api/context"), env);
    const body = await response.json() as {
      is_authenticated: boolean;
      point_balance: number;
      recent_orders: Array<Record<string, unknown>>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      is_authenticated: true,
      point_balance: 1200,
      recent_orders: [{
        order_id: "20260521-001",
        created_at: "2026-05-21 09:00:00",
        suitcase_qty: 1,
        backpack_qty: 1,
        companion_count: 2,
        payment_method: "CASH",
        gross_amount: 1200,
        point_discount_amount: 100,
        final_amount: 1100,
        status: "PAID",
      }],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("kim@example.com");
    expect(serialized).not.toContain("010-1111-2222");
    expect(serialized).not.toContain("Kim Customer");
    expect(serialized).not.toContain("person-1");
  });
});
