import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppType, CustomerSession } from "../types";
import customerRoutes from "./customer";

class FakePreparedStatement {
  private boundValues: unknown[] = [];

  constructor(private readonly db: FakeDb, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.boundValues = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM luggage_customer_profiles")) return null;

    if (this.sql.includes("FROM luggage_customer_point_accounts")) {
      const personId = String(this.boundValues[0]);
      const balance = this.db.pointBalances.get(personId);
      return (balance == null ? null : { balance_points: balance }) as T | null;
    }

    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM luggage_orders") && this.sql.includes("ORDER BY created_at")) {
      return { results: [] };
    }

    throw new Error(`Unsupported all() SQL: ${this.sql}`);
  }
}

class FakeDb {
  pointBalances = new Map<string, number>();

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }
}

function buildApp(session: CustomerSession | null, db: FakeDb) {
  const app = new Hono<AppType>();
  app.use("*", async (c, next) => {
    if (session) c.set("customer", session);
    return next();
  });
  app.route("/", customerRoutes);
  return {
    app,
    env: { DB: db } as unknown as AppType["Bindings"],
  };
}

function previewUrl(pointsToUse: number) {
  const params = new URLSearchParams({
    backpack_qty: "1",
    expected_pickup_at: "2026-05-22T10:00",
    points_to_use: String(pointsToUse),
    suitcase_qty: "1",
  });
  return `https://luggage.test/api/price-preview?${params.toString()}`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/price-preview point handling", () => {
  it("ignores requested points for anonymous customers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    const { app, env } = buildApp(null, db);

    const response = await app.fetch(new Request(previewUrl(500)), env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      final_amount: 1200,
      final_prepaid: 1200,
      point_balance: 0,
      point_discount_amount: 0,
      points_to_use: 0,
      prepaid_amount: 1200,
    });
  });

  it("applies authenticated points from the server-side balance only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const response = await app.fetch(new Request(previewUrl(500)), env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      final_amount: 700,
      final_prepaid: 1200,
      point_balance: 1000,
      point_discount_amount: 500,
      points_to_use: 500,
      prepaid_amount: 1200,
    });
  });

  it("rounds authenticated point preview down to the configured use unit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const response = await app.fetch(new Request(previewUrl(999)), env);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      final_amount: 300,
      point_balance: 1000,
      point_discount_amount: 900,
      points_to_use: 900,
    });
  });
});
