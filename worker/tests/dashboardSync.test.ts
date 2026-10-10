import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import staffApi from "../src/routes/staffApi";
import { signInternalRequest } from "../src/lib/hmac";

const SECRET = "reviewer-test-key";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async run() { return { results: sqlite.prepare(sql).all(...(args as never[])), meta: { changes: 0 } }; },
      async all() { return { results: sqlite.prepare(sql).all(...(args as never[])) }; },
      async first() { return sqlite.prepare(sql).get(...(args as never[])) || null; },
    };
  };
  const db = { prepare: statement, async batch() { throw new Error("not used"); } };
  const app = new Hono().route("/", internalApi).route("/", staffApi);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test", DEV_STAFF_AUTH_BYPASS: "1" };
  return { app, env, sqlite };
}

function seed(sqlite: DatabaseSync, orderId: string, createdAt: string, status = "PAID", updatedAt = createdAt) {
  sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, suitcase_qty, set_qty, price_per_day,
       prepaid_amount, final_amount, payment_method, status, tag_no, note, flying_pass_tier)
     VALUES (?, ?, ?, 'Synthetic Guest', '090-0000-0000', 1, 1, 800, 800, 800, 'CASH', ?, '12', '', 'NONE')`,
  ).run(orderId, createdAt, updatedAt, status);
}

async function token(ctx: ReturnType<typeof setup>, query: string, options: { unsigned?: boolean } = {}) {
  const url = `https://luggage.test/internal/luggage-orders/dashboard-sync${query}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method: "GET", url, timestamp, body: "" });
  const headers: Record<string, string> = options.unsigned ? {} : { "x-internal-timestamp": timestamp, "x-internal-signature": signature };
  const response = await ctx.app.request(url, { method: "GET", headers }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

test("requires the internal HMAC signature", async () => {
  const ctx = setup();
  assert.equal((await token(ctx, "?status=UNPICKED", { unsigned: true })).status, 401);
});

test("rejects unknown status values", async () => {
  const ctx = setup();
  assert.equal((await token(ctx, "?status=DROP%20TABLE")).status, 400);
});

test("same token as the staff dashboard poll for the same scope without dates", async () => {
  const ctx = setup();
  seed(ctx.sqlite, "20261010-001", "2026-10-10 01:00:00", "PAID");
  seed(ctx.sqlite, "20261010-002", "2026-10-10 02:00:00", "PAYMENT_PENDING");
  const staff = await ctx.app.request("https://luggage.test/staff/api/orders/dashboard-sync?status=UNPICKED", {}, ctx.env);
  const staffToken = (await staff.json() as { token: string }).token;
  const internal = await token(ctx, "?status=UNPICKED");
  assert.equal(internal.status, 200);
  assert.equal(internal.json.token, staffToken);
});

test("token changes when an order in scope is updated or created, and stays when nothing changes", async () => {
  const ctx = setup();
  seed(ctx.sqlite, "20261010-001", "2026-10-10 01:00:00", "PAID");
  const query = "?status=UNPICKED&dateFrom=2026-10-10&dateTo=2026-10-10";
  const first = (await token(ctx, query)).json.token;
  assert.equal((await token(ctx, query)).json.token, first);
  ctx.sqlite.prepare("UPDATE luggage_orders SET tag_no = '13', updated_at = '2026-10-10 03:00:00' WHERE order_id = '20261010-001'").run();
  const afterUpdate = (await token(ctx, query)).json.token;
  assert.notEqual(afterUpdate, first);
  seed(ctx.sqlite, "20261010-002", "2026-10-10 04:00:00", "PAYMENT_PENDING");
  assert.notEqual((await token(ctx, query)).json.token, afterUpdate);
});

test("JST date boundary: an order created 00:30 JST (previous UTC day) on dateFrom is still covered", async () => {
  const ctx = setup();
  // 2026-10-10 00:30 JST = 2026-10-09 15:30 UTC
  seed(ctx.sqlite, "20261010-001", "2026-10-09 15:30:00", "PAID");
  const query = "?status=UNPICKED&dateFrom=2026-10-10&dateTo=2026-10-10";
  const before = (await token(ctx, query)).json.token;
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PICKED_UP', updated_at = '2026-10-10 05:00:00' WHERE order_id = '20261010-001'").run();
  assert.notEqual((await token(ctx, query)).json.token, before);
});

test("no status means every status, including cancelled orders", async () => {
  const ctx = setup();
  seed(ctx.sqlite, "20261010-001", "2026-10-10 01:00:00", "CANCELLED");
  const before = (await token(ctx, "?dateFrom=2026-10-10&dateTo=2026-10-10")).json.token;
  ctx.sqlite.prepare("UPDATE luggage_orders SET note = 'x', updated_at = '2026-10-10 06:00:00' WHERE order_id = '20261010-001'").run();
  assert.notEqual((await token(ctx, "?dateFrom=2026-10-10&dateTo=2026-10-10")).json.token, before);
});
