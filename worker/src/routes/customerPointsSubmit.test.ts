import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppType, CustomerSession } from "../types";

vi.mock("../services/orderNumber", () => ({
  buildOrderId: vi.fn(async () => "20260522-101"),
  buildOvernightTag: vi.fn(async () => "91"),
  buildSameDayTag: vi.fn(async () => "7"),
}));

import customerRoutes from "./customer";

type InsertedCustomerOrder = {
  account_person_id: string | null;
  email: string;
  final_amount: number;
  flying_pass_discount_amount: number;
  gross_amount: number;
  name: string;
  order_id: string;
  phone: string;
  point_discount_amount: number;
  point_usage_status: string;
  points_earned: number;
  points_used: number;
  prepaid_amount: number;
  source_preset_order_id: string | null;
  view_token: string | null;
};

type PointTransaction = {
  account_person_id: string;
  balance_after: number;
  idempotency_key: string;
  order_id: string;
  points_delta: number;
  status: string;
  transaction_type: string;
};

type ProfileRow = {
  account_person_id: string;
  display_name: string | null;
  email: string | null;
  identity_verified_at: string | null;
  locale: string | null;
  phone: string | null;
};

type SourcePresetOrder = {
  account_person_id: string;
  order_id: string;
  parent_order_id: string | null;
  status: string;
};

type BatchResult = { meta: { changes: number }; rollback?: boolean };

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
      const personId = String(this.boundValues[0]);
      const balance = this.db.pointBalances.get(personId);
      return (balance == null ? null : { balance_points: balance }) as T | null;
    }

    if (this.sql.includes("FROM luggage_orders") && this.sql.includes("account_person_id")) {
      const orderId = String(this.boundValues[0]);
      const accountPersonId = String(this.boundValues[1]);
      const order = this.db.sourcePresetOrders.find((candidate) =>
        candidate.order_id === orderId &&
        candidate.account_person_id === accountPersonId &&
        candidate.parent_order_id === null &&
        ["PAID", "PICKED_UP", "PAYMENT_PENDING"].includes(candidate.status)
      );
      return (order ? { order_id: order.order_id } : null) as T | null;
    }

    throw new Error(`Unsupported first() SQL: ${this.sql}`);
  }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM luggage_orders") && this.sql.includes("ORDER BY created_at")) {
      return { results: [] };
    }

    throw new Error(`Unsupported all() SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.includes("UPDATE luggage_orders SET view_token")) {
      const token = String(this.boundValues[0]);
      const orderId = String(this.boundValues[1]);
      const order = this.db.insertedOrders.find((candidate) => candidate.order_id === orderId);
      if (order) order.view_token = token;
      return { meta: { changes: order ? 1 : 0 } };
    }

    throw new Error(`Unsupported run() SQL: ${this.sql}`);
  }

  async runInBatch(): Promise<BatchResult> {
    return this.db.executeBatchStatement(this.sql, this.boundValues, () => this.insertCustomerOrder());
  }

  private insertCustomerOrder(): InsertedCustomerOrder {
    return {
      account_person_id: this.boundValues[25] == null ? null : String(this.boundValues[25]),
      email: String(this.boundValues[4]),
      final_amount: Number(this.boundValues[22]),
      flying_pass_discount_amount: Number(this.boundValues[17]),
      gross_amount: Number(this.boundValues[14]),
      name: String(this.boundValues[2]),
      order_id: String(this.boundValues[0]),
      phone: String(this.boundValues[3]),
      point_discount_amount: Number(this.boundValues[18]),
      point_usage_status: String(this.boundValues[21]),
      points_earned: Number(this.boundValues[20]),
      points_used: Number(this.boundValues[19]),
      prepaid_amount: Number(this.boundValues[15]),
      source_preset_order_id: this.boundValues[26] == null ? null : String(this.boundValues[26]),
      view_token: null,
    };
  }
}

class FakeDb {
  failOrderInsert = false;
  insertedOrders: InsertedCustomerOrder[] = [];
  lastChanges = 0;
  pointBalances = new Map<string, number>();
  pointTransactions: PointTransaction[] = [];
  profile: ProfileRow | null = null;
  sourcePresetOrders: SourcePresetOrder[] = [];

  prepare(sql: string) {
    return new FakePreparedStatement(this, sql);
  }

  async batch(statements: FakePreparedStatement[]) {
    const snapshot = {
      failOrderInsert: this.failOrderInsert,
      insertedOrders: this.insertedOrders.map((order) => ({ ...order })),
      lastChanges: this.lastChanges,
      pointBalances: new Map(this.pointBalances),
      pointTransactions: this.pointTransactions.map((transaction) => ({ ...transaction })),
      profile: this.profile ? { ...this.profile } : null,
      sourcePresetOrders: this.sourcePresetOrders.map((order) => ({ ...order })),
    };
    const results: BatchResult[] = [];

    try {
      for (const statement of statements) {
        const result = await statement.runInBatch();
        if (result.rollback) {
          this.failOrderInsert = snapshot.failOrderInsert;
          this.insertedOrders = snapshot.insertedOrders;
          this.lastChanges = 0;
          this.pointBalances = snapshot.pointBalances;
          this.pointTransactions = snapshot.pointTransactions;
          this.profile = snapshot.profile;
          this.sourcePresetOrders = snapshot.sourcePresetOrders;
          results.push({ meta: { changes: 0 } });
          return results;
        }
        results.push(result);
      }
      return results;
    } catch (error) {
      this.failOrderInsert = snapshot.failOrderInsert;
      this.insertedOrders = snapshot.insertedOrders;
      this.lastChanges = snapshot.lastChanges;
      this.pointBalances = snapshot.pointBalances;
      this.pointTransactions = snapshot.pointTransactions;
      this.profile = snapshot.profile;
      this.sourcePresetOrders = snapshot.sourcePresetOrders;
      throw error;
    }
  }

  async executeBatchStatement(
    sql: string,
    boundValues: unknown[],
    insertCustomerOrder: () => InsertedCustomerOrder,
  ): Promise<BatchResult> {
    if (sql.includes("INSERT OR IGNORE INTO luggage_customer_point_transactions")) {
      const accountPersonId = String(boundValues[8]);
      const pointsUsed = Number(boundValues[9]);
      const idempotencyKey = String(boundValues[6]);
      const currentBalance = this.pointBalances.get(accountPersonId) ?? 0;

      if (
        currentBalance < pointsUsed ||
        this.pointTransactions.some((transaction) => transaction.idempotency_key === idempotencyKey)
      ) {
        this.lastChanges = 0;
        return { meta: { changes: 0 } };
      }

      this.pointTransactions.push({
        account_person_id: String(boundValues[0]),
        balance_after: currentBalance - pointsUsed,
        idempotency_key: idempotencyKey,
        order_id: String(boundValues[1]),
        points_delta: Number(boundValues[3]),
        status: String(boundValues[4]),
        transaction_type: String(boundValues[2]),
      });
      this.lastChanges = 1;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE luggage_customer_point_accounts")) {
      const pointsUsed = Number(boundValues[0]);
      const accountPersonId = String(boundValues[2]);
      const currentBalance = this.pointBalances.get(accountPersonId);

      if (this.lastChanges !== 1 || currentBalance == null) {
        this.lastChanges = 0;
        return { meta: { changes: 0 } };
      }

      this.pointBalances.set(accountPersonId, currentBalance - pointsUsed);
      this.lastChanges = 1;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO luggage_orders")) {
      const placeholderCount = (sql.match(/\?/g) ?? []).length;
      if (placeholderCount !== boundValues.length) {
        throw new Error(`placeholder count mismatch: ${placeholderCount} placeholders for ${boundValues.length} values`);
      }
      if (this.failOrderInsert) return { meta: { changes: 0 }, rollback: true };
      const isPointGuardedInsert = sql.includes("WHERE changes() = 1");
      if (isPointGuardedInsert && this.lastChanges !== 1) {
        this.lastChanges = 0;
        return { meta: { changes: 0 } };
      }

      const order = insertCustomerOrder();
      if (this.insertedOrders.some((candidate) => candidate.order_id === order.order_id)) {
        throw new Error("duplicate order_id");
      }
      this.insertedOrders.push(order);
      this.lastChanges = 1;
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unsupported batch SQL: ${sql}`);
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
    env: {
      BREVO_API_KEY: "",
      DB: db,
      IMAGES: {
        delete: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    } as unknown as AppType["Bindings"],
  };
}

function customerOrderForm(overrides: Record<string, string | number> = {}) {
  const body = new FormData();
  const defaults: Record<string, string | number> = {
    backpack_qty: "1",
    companion_count: "1",
    consent_checked: "1",
    email: "customer@example.com",
    expected_pickup_at: "2026-05-22T10:00",
    lang: "ko",
    name: "Customer",
    payment_method: "CASH",
    phone: "010-1234-5678",
    points_to_use: "0",
    suitcase_qty: "1",
  };

  for (const [key, value] of Object.entries({ ...defaults, ...overrides })) {
    body.set(key, String(value));
  }
  body.set("id_image", new File(["id"], "id.jpg", { type: "image/jpeg" }));
  body.set("luggage_image", new File(["luggage"], "luggage.jpg", { type: "image/jpeg" }));

  return body;
}

async function postCustomerOrder(
  app: Hono<AppType>,
  env: AppType["Bindings"],
  body: FormData,
) {
  return app.fetch(
    new Request("https://luggage.test/customer/submit", {
      body,
      method: "POST",
    }),
    env,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("customer order point usage", () => {
  it("keeps anonymous submit anonymous and ignores preset ownership fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    const { app, env } = buildApp(null, db);

    const res = await postCustomerOrder(
      app,
      env,
      customerOrderForm({
        points_to_use: 0,
        source_preset_order_id: "20260501-001",
      }),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/customer\/orders\/20260522-101\?lang=ko&token=/);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: null,
      final_amount: 1200,
      point_discount_amount: 0,
      point_usage_status: "NONE",
      points_earned: 0,
      points_used: 0,
      source_preset_order_id: null,
    });
    expect(db.pointTransactions).toHaveLength(0);
  });

  it("rejects anonymous point usage before order insert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    const { app, env } = buildApp(null, db);

    const res = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));

    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toContain(
      "포인트는 로그인한 고객만 사용할 수 있습니다.",
    );
    expect(db.insertedOrders).toHaveLength(0);
    expect(db.pointTransactions).toHaveLength(0);
  });

  it("uses signed Account session identity instead of editable form identity fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    const { app, env } = buildApp({
      displayName: "Account Name",
      email: "account@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      phone: "+81-90-1111-2222",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(
      app,
      env,
      customerOrderForm({
        email: "edited@example.com",
        name: "Edited Form Name",
        phone: "010-9999-9999",
      }),
    );

    expect(res.status).toBe(302);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: "person-1",
      email: "account@example.com",
      name: "Account Name",
      phone: "+81-90-1111-2222",
    });
  });

  it("uses verified cached customer profile identity ahead of signed Account session fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.profile = {
      account_person_id: "person-1",
      display_name: "Verified Profile Name",
      email: "verified@example.com",
      identity_verified_at: "2026-05-21T00:00:00.000Z",
      locale: "ko",
      phone: "010-2222-3333",
    };
    const { app, env } = buildApp({
      displayName: "Session Name",
      email: "session@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      phone: "010-1111-2222",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(
      app,
      env,
      customerOrderForm({
        email: "edited@example.com",
        name: "Edited Form Name",
        phone: "010-9999-9999",
      }),
    );

    expect(res.status).toBe(302);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: "person-1",
      email: "verified@example.com",
      name: "Verified Profile Name",
      phone: "010-2222-3333",
    });
  });

  it("stores server-recalculated point discounts after Flying Pass discounts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      email: "account@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toMatch(/^\/customer\/orders\/20260522-101\?lang=ko&token=/);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: "person-1",
      final_amount: 700,
      flying_pass_discount_amount: 0,
      gross_amount: 1200,
      point_discount_amount: 500,
      point_usage_status: "RESERVED",
      points_earned: 0,
      points_used: 500,
      prepaid_amount: 1200,
    });
    expect(db.pointBalances.get("person-1")).toBe(500);
    expect(db.pointTransactions).toEqual([
      expect.objectContaining({
        account_person_id: "person-1",
        balance_after: 500,
        idempotency_key: "point:reserve:20260522-101",
        order_id: "20260522-101",
        points_delta: -500,
        status: "RESERVED",
        transaction_type: "USE",
      }),
    ]);
  });

  it("rounds signed point usage down before inserting the order and point ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      email: "account@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 999 }));

    expect(res.status).toBe(302);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: "person-1",
      final_amount: 300,
      point_discount_amount: 900,
      point_usage_status: "RESERVED",
      points_used: 900,
      prepaid_amount: 1200,
    });
    expect(db.pointBalances.get("person-1")).toBe(100);
    expect(db.pointTransactions).toEqual([
      expect.objectContaining({
        account_person_id: "person-1",
        balance_after: 100,
        idempotency_key: "point:reserve:20260522-101",
        order_id: "20260522-101",
        points_delta: -900,
        status: "RESERVED",
        transaction_type: "USE",
      }),
    ]);
  });

  it("stores an owned active previous-history preset reference for signed customers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.sourcePresetOrders.push({
      account_person_id: "person-1",
      order_id: "20260501-001",
      parent_order_id: null,
      status: "PAID",
    });
    const { app, env } = buildApp({
      email: "account@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(
      app,
      env,
      customerOrderForm({ source_preset_order_id: "20260501-001" }),
    );

    expect(res.status).toBe(302);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.insertedOrders[0]).toMatchObject({
      account_person_id: "person-1",
      source_preset_order_id: "20260501-001",
    });
  });

  it("rejects tampered previous-history preset references before order insert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.sourcePresetOrders.push({
      account_person_id: "person-2",
      order_id: "20260501-001",
      parent_order_id: null,
      status: "PAID",
    });
    const { app, env } = buildApp({
      email: "account@example.com",
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(
      app,
      env,
      customerOrderForm({ source_preset_order_id: "20260501-001" }),
    );

    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toContain("오류가 발생했습니다");
    expect(db.insertedOrders).toHaveLength(0);
    expect(db.pointTransactions).toHaveLength(0);
  });

  it("rejects point usage above the account balance before order insert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 100);
    const { app, env } = buildApp({
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));

    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toContain("사용 가능한 포인트를 초과했습니다.");
    expect(db.insertedOrders).toHaveLength(0);
    expect(db.pointTransactions).toHaveLength(0);
    expect(db.pointBalances.get("person-1")).toBe(100);
  });

  it("does not double-spend points when the same order idempotency key is retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const first = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));
    const second = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));

    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(db.insertedOrders).toHaveLength(1);
    expect(db.pointTransactions).toHaveLength(1);
    expect(db.pointBalances.get("person-1")).toBe(500);
  });

  it("rolls back point ledger writes when order insertion fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T00:00:00Z"));

    const db = new FakeDb();
    db.failOrderInsert = true;
    db.pointBalances.set("person-1", 1000);
    const { app, env } = buildApp({
      issuedBy: "pub-account",
      personId: "person-1",
      provider: "account",
    }, db);

    const res = await postCustomerOrder(app, env, customerOrderForm({ points_to_use: 500 }));

    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("Location") || "")).toContain("사용 가능한 포인트를 초과했습니다.");
    expect(db.insertedOrders).toHaveLength(0);
    expect(db.pointTransactions).toHaveLength(0);
    expect(db.pointBalances.get("person-1")).toBe(1000);
  });
});
