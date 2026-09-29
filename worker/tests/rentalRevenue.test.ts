import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import { signInternalRequest } from "../src/lib/hmac";
import { aggregateNaverRentalDaily, syncNaverRentalRevenueRange } from "../src/services/rentalRevenueSync";
import { parseJpyRateResponse } from "../src/services/exchangeRate";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async run() { return sqlite.prepare(sql).run(...args); },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec("COMMIT"); return result; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
  };
  return { db: db as unknown as D1Database, sqlite };
}

const order = (payed: string, amount: number | string, extra: Record<string, unknown> = {}) => ({
  product_id: "1", product_name: "파워업밴드 대여", payed_datetime: payed, total_payment_amount: amount, ...extra,
});

test("aggregates KRW by KST pay date like the center dashboard, excluding damage/loss", () => {
  const daily = aggregateNaverRentalDaily([
    order("2026-09-01T01:00:00+00:00", 13600),
    order("2026-09-01T14:59:59+00:00", "27200.00"),
    order("2026-09-01T15:00:00+00:00", 5000), // 2026-09-02 00:00 KST
    order("2026-09-01T02:00:00+00:00", 55000, { product_id: "12611527498" }),
    order("2026-09-01T03:00:00+00:00", 30000, { product_name: "[스태프 안내시] 파손 분실 요금 청구" }),
    order("2026-09-01T04:00:00+00:00", null),
    { product_id: "1", product_name: "x", payed_datetime: null, total_payment_amount: 9999 },
  ]);
  assert.deepEqual(daily.get("2026-09-01"), { revenueKrw: 40800, orderCount: 3 });
  assert.deepEqual(daily.get("2026-09-02"), { revenueKrw: 5000, orderCount: 1 });
  assert.equal(daily.size, 2);
});

test("range sync stores KRW without conversion and replaces stale rows only inside the range", async (t) => {
  const { db, sqlite } = setup();
  sqlite.exec(`INSERT INTO luggage_naver_rental_daily_sales (business_date, revenue_krw, order_count) VALUES
    ('2026-09-01', 1, 1), ('2026-09-03', 999, 9), ('2026-08-31', 777, 7)`);
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requested.push(decodeURIComponent(url));
    return new Response(JSON.stringify([order("2026-09-01T01:00:00+00:00", 13600), order("2026-09-02T01:00:00+00:00", 27200)]), { status: 200 });
  });

  const result = await syncNaverRentalRevenueRange(db, "https://supabase.test", "key", "2026-09-01", "2026-09-03");
  assert.deepEqual(result, { synced: 2, rows: 2 });
  assert.match(requested[0], /payed_datetime=gte\.2026-08-31T15:00:00\.000Z/);
  assert.match(requested[0], /payed_datetime=lt\.2026-09-03T15:00:00\.000Z/);
  const rows = sqlite.prepare("SELECT business_date, revenue_krw, order_count FROM luggage_naver_rental_daily_sales ORDER BY business_date").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { business_date: "2026-08-31", revenue_krw: 777, order_count: 7 },
    { business_date: "2026-09-01", revenue_krw: 13600, order_count: 1 },
    { business_date: "2026-09-02", revenue_krw: 27200, order_count: 1 },
  ]);
});

test("failed fetch keeps stored totals untouched", async (t) => {
  const { db, sqlite } = setup();
  sqlite.exec(`INSERT INTO luggage_naver_rental_daily_sales (business_date, revenue_krw, order_count) VALUES ('2026-09-01', 500, 2)`);
  t.mock.method(globalThis, "fetch", async () => new Response("boom", { status: 500 }));
  await assert.rejects(syncNaverRentalRevenueRange(db, "https://supabase.test", "key", "2026-09-01", "2026-09-03"));
  assert.equal(sqlite.prepare("SELECT revenue_krw FROM luggage_naver_rental_daily_sales").get().revenue_krw, 500);
});

test("integrated admin sales projection is on-site luggage only (no KRW rental mixed in)", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(`INSERT INTO luggage_daily_sales (sale_date, people, cash, qr, luggage_total, rental_total) VALUES ('2026-09-01', 10, 3000, 2000, 5000, 999)`);
  sqlite.exec(`INSERT INTO luggage_naver_rental_daily_sales (business_date, revenue_krw, order_count) VALUES ('2026-09-01', 1683900, 68), ('2026-09-02', 500000, 20)`);
  const env = { DB: db, INTERNAL_API_SECRET: "reviewer-test-key" };
  const app = new Hono().route("/", internalApi);
  const url = "https://luggage.test/internal/luggage-sales-analytics?startDate=2026-09-01&endDate=2026-09-02";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: env.INTERNAL_API_SECRET, method: "GET", url, timestamp });
  const res = await app.request(url, { headers: { "x-internal-timestamp": timestamp, "x-internal-signature": signature } }, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.summary.luggage, 5000);
  assert.equal("rental" in body.summary, false);
  assert.equal("combined" in body.summary, false);
  assert.deepEqual(body.dailyRows.map((row) => row.date), ["2026-09-01"]);
  assert.equal("rental" in body.dailyRows[0], false);
  assert.equal("combined" in body.dailyRows[0], false);
});

test("today's JPY rate parser accepts only a positive KRW rate", () => {
  assert.deepEqual(parseJpyRateResponse({ base: "JPY", date: "2026-09-29", rates: { KRW: 9.31 } }), { krwPerJpy: 9.31, rateDate: "2026-09-29" });
  assert.deepEqual(parseJpyRateResponse({ rates: { KRW: 9.31 } }), { krwPerJpy: 9.31, rateDate: null });
  for (const body of [null, {}, { rates: {} }, { rates: { KRW: 0 } }, { rates: { KRW: "9.3" } }, { rates: { KRW: Number.NaN } }]) assert.equal(parseJpyRateResponse(body), null);
});
