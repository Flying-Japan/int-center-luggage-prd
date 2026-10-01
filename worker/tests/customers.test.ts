import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import { signInternalRequest } from "../src/lib/hmac";

const SECRET = "reviewer-test-key";

// 이전(correlated subquery) 구현. 새 window 함수 구현과 결과가 같은지 비교하는 oracle이다.
function legacyRowsSql(clauses: string[], orderBy: string) {
  const filteredSql = `SELECT order_id AS orderId,
      COALESCE(NULLIF(TRIM(phone), ''), NULLIF(TRIM(email), '')) AS customerIdentity,
      name, created_at AS createdAt, COALESCE(final_amount, 0) AS finalAmount,
      COALESCE(suitcase_qty, 0) AS suitcaseQty, COALESCE(backpack_qty, 0) AS backpackQty
    FROM luggage_orders WHERE ${clauses.join(" AND ")}`;
  return `WITH filtered AS (${filteredSql}),
         grouped AS (
           SELECT customerIdentity, COUNT(*) AS orderCount,
             SUM(finalAmount) AS totalSpent, MIN(createdAt) AS firstVisitAt,
             MAX(createdAt) AS lastVisitAt, SUM(suitcaseQty) AS totalSuitcases,
             SUM(backpackQty) AS totalBackpacks
           FROM filtered GROUP BY customerIdentity
         )
         SELECT grouped.*,
           (SELECT recent.name FROM filtered recent
            WHERE recent.customerIdentity IS grouped.customerIdentity
            ORDER BY recent.createdAt DESC, recent.orderId DESC LIMIT 1) AS name
         FROM grouped ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
}

const ORDER_BY: Record<string, string> = {
  recent: "lastVisitAt DESC, customerIdentity ASC",
  oldest: "lastVisitAt ASC, firstVisitAt ASC, customerIdentity ASC",
  visits_desc: "orderCount DESC, lastVisitAt DESC, customerIdentity ASC",
  spent_desc: "totalSpent DESC, lastVisitAt DESC, customerIdentity ASC",
};

function mask(value: string | null): string {
  const characters = Array.from(value?.trim() ?? "");
  if (characters.length === 0) return "—";
  if (characters.length === 1) return "*";
  if (characters.length === 2) return `${characters[0]}*`;
  return `${characters[0]}${"*".repeat(characters.length - 2)}${characters[characters.length - 1]}`;
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...(args as never[])) }; },
      async first() { return sqlite.prepare(sql).get(...(args as never[])) || null; },
    };
  };
  const app = new Hono().route("/", internalApi);
  const env = { DB: { prepare: statement }, INTERNAL_API_SECRET: SECRET, APP_ENV: "test" };
  return { app, env, sqlite };
}

type Seed = { id: string; at: string; name: string | null; phone: string | null; email?: string | null; status?: string; amount?: number; suit?: number; pack?: number };

function seed(sqlite: DatabaseSync, rows: Seed[]) {
  const insert = sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, email, suitcase_qty, backpack_qty, final_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(r.id, r.at, r.at, r.name, r.phone, r.email ?? null, r.suit ?? 1, r.pack ?? 0, r.amount ?? 800, r.status ?? "PICKED_UP");
}

async function get(ctx: ReturnType<typeof setup>, query: string) {
  const url = `https://luggage.test/internal/luggage-customers${query}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method: "GET", url, timestamp, body: "" });
  const response = await ctx.app.request(url, { method: "GET", headers: { "x-internal-timestamp": timestamp, "x-internal-signature": signature } }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

const ROWS: Seed[] = [
  { id: "A1", at: "2026-09-01 01:00:00", name: "김철수", phone: "090-1111-1111", amount: 800, suit: 2 },
  { id: "A2", at: "2026-09-05 02:00:00", name: "김철수 (수정)", phone: " 090-1111-1111 ", amount: 1600, pack: 1 },
  // 같은 created_at의 두 주문: order_id DESC가 대표 이름을 결정한다.
  { id: "A3", at: "2026-09-09 03:00:00", name: "Tie Low", phone: "090-1111-1111", amount: 400 },
  { id: "A4", at: "2026-09-09 03:00:00", name: "Tie High", phone: "090-1111-1111", amount: 400 },
  { id: "B1", at: "2026-09-02 01:00:00", name: null, phone: "", email: "guest@example.test", amount: 900 },
  { id: "B2", at: "2026-09-03 01:00:00", name: "Guest Mail", phone: "  ", email: " guest@example.test ", amount: 900 },
  { id: "C1", at: "2026-09-04 01:00:00", name: "Solo", phone: "080-2222-2222", amount: 2400, suit: 3 },
  { id: "C2", at: "2026-09-04 02:00:00", name: "취소됨", phone: "080-2222-2222", status: "CANCELLED", amount: 9999 },
  { id: "D1", at: "2026-09-06 01:00:00", name: "X", phone: "070-3333-3333", amount: 800 },
  { id: "D2", at: "2026-09-07 01:00:00", name: "Zed Kim", phone: "070-3333-3333", amount: 800 },
  { id: "E1", at: "2026-09-08 01:00:00", name: "No Contact", phone: null, email: null, amount: 100 },
  { id: "F1", at: "2026-09-10 01:00:00", name: "Oldest Latest", phone: "060-4444-4444", amount: 800 },
  { id: "G1", at: "2026-08-20 01:00:00", name: "Early", phone: "050-5555-5555", amount: 800 },
];

test("window 기반 대표 이름 쿼리가 이전 구현과 모든 정렬·검색·페이지에서 같은 결과를 낸다", async () => {
  const ctx = setup();
  seed(ctx.sqlite, ROWS);
  for (const sort of Object.keys(ORDER_BY)) {
    for (const [q, clauseExtra, params] of [["", "", [] as string[]], ["Kim", "(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')", ["%Kim%", "%Kim%", "%Kim%"]]] as const) {
      for (const [limit, offset] of [[20, 0], [20, 3]] as const) {
        const clauses = ["status != 'CANCELLED'", "COALESCE(NULLIF(TRIM(phone), ''), NULLIF(TRIM(email), '')) IS NOT NULL", ...(clauseExtra ? [clauseExtra] : [])];
        const expected = (ctx.sqlite.prepare(legacyRowsSql(clauses, ORDER_BY[sort])).all(...params, limit, offset) as any[]).map((r) => ({
          maskedName: mask(r.name), orderCount: r.orderCount, totalSpent: r.totalSpent, firstVisitAt: r.firstVisitAt,
          lastVisitAt: r.lastVisitAt, totalSuitcases: r.totalSuitcases, totalBackpacks: r.totalBackpacks,
        }));
        const { status, json } = await get(ctx, `?sort=${sort}&limit=${limit}&offset=${offset}${q ? `&q=${q}` : ""}`);
        assert.equal(status, 200);
        const actual = json.customers.map(({ customerKey: _key, ...rest }: any) => rest);
        assert.deepEqual(actual, expected, `${sort} q=${q} offset=${offset}`);
      }
    }
  }
});

test("대표 이름은 가장 최근 주문, 동률이면 order_id가 큰 주문의 이름이고 취소·연락처 없는 주문은 제외된다", async () => {
  const ctx = setup();
  seed(ctx.sqlite, ROWS);
  const { json } = await get(ctx, "?sort=visits_desc&limit=100");
  const names = json.customers.map((c: any) => c.maskedName);
  assert.ok(names.includes(mask("Tie High")), "동률 created_at이면 order_id DESC의 A4 이름");
  assert.equal(names.includes(mask("Tie Low")), false);
  assert.equal(names.includes(mask("취소됨")), false);
  assert.equal(names.includes(mask("No Contact")), false);
  assert.equal(json.total, 6);
  assert.ok(json.customers.every((c: any) => /^lc_[0-9a-f]{64}$/.test(c.customerKey)));
});

test("고객 조회 쿼리는 filtered CTE를 고객 수만큼 다시 읽는 correlated subquery를 쓰지 않는다", () => {
  const source = readFileSync("src/routes/internalApi.ts", "utf8");
  const start = source.indexOf('internalApi.get("/internal/luggage-customers"');
  const block = source.slice(start, source.indexOf("// GET /internal/luggage-lost-found", start));
  assert.equal(block.includes("recent.customerIdentity IS grouped.customerIdentity"), false);
  assert.match(block, /ROW_NUMBER\(\) OVER \(PARTITION BY customerIdentity/);
});
