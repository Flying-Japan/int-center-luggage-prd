import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import { recalculateOrderPrepaid } from "../src/services/pricing";
import { signInternalRequest } from "../src/lib/hmac";

const SECRET = "pickup-test-secret";
const ORIGINAL_PICKUP = "2026-10-21T03:00:00.000Z";
const NEXT_DAY_PICKUP = "2026-10-22T03:00:00.000Z";
const ORDER_ID = "20261021-001";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));

  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        args = values;
        return this;
      },
      async run() {
        const results = sqlite.prepare(sql).all(...(args as never[]));
        const row = sqlite.prepare("SELECT changes() AS n").get() as { n: number };
        return { results, meta: { changes: row.n } };
      },
      async first() {
        return sqlite.prepare(sql).get(...(args as never[])) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...(args as never[])) };
      },
    };
  };

  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  const app = new Hono().route("/", internalApi);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, APP_ENV: "test" };
  return { sqlite, app, env };
}

type Context = ReturnType<typeof setup>;

function seed(
  ctx: Context,
  id = ORDER_ID,
  status = "PAYMENT_PENDING",
  tag = "55",
) {
  ctx.sqlite.prepare(`
    INSERT INTO luggage_orders (
      order_id, created_at, updated_at, name, phone,
      suitcase_qty, backpack_qty, price_per_day,
      expected_pickup_at, expected_storage_days,
      prepaid_amount, final_amount, status, tag_no,
      flying_pass_tier
    )
    VALUES (
      ?, '2026-10-21 00:30:00', '2026-10-21 01:00:00',
      'Synthetic Guest', '000-0000',
      1, 0, 800, ?, 1, 800, 800, ?, ?, 'NONE'
    )
  `).run(id, ORIGINAL_PICKUP, status, tag);
}

function order(ctx: Context, id = ORDER_ID) {
  return ctx.sqlite.prepare(`
    SELECT expected_pickup_at, expected_storage_days,
           prepaid_amount, final_amount, tag_no, status
    FROM luggage_orders WHERE order_id = ?
  `).get(id) as Record<string, any>;
}

function audits(ctx: Context) {
  return ctx.sqlite.prepare(
    "SELECT * FROM luggage_audit_logs ORDER BY log_id"
  ).all();
}

async function change(
  ctx: Context,
  pickup: string | null = NEXT_DAY_PICKUP,
  id = ORDER_ID,
  extra: Record<string, unknown> = {},
) {
  const url = `https://luggage.test/internal/luggage-orders/${id}/operations-fields`;
  const body = JSON.stringify({
    expectedPickupAt: pickup,
    ...extra,
    actor: {
      userId: "synthetic-user",
      name: "Synthetic Tester",
      email: "tester@example.test",
      role: "center_staff",
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({
    secret: SECRET,
    method: "PATCH",
    url,
    timestamp,
    body,
  });
  const response = await ctx.app.request(
    url,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-internal-timestamp": timestamp,
        "x-internal-signature": signature,
      },
      body,
    },
    ctx.env,
  );
  return {
    status: response.status,
    data: await response.json() as Record<string, any>,
  };
}

test("미결제: 다음 날 변경 시 장기 번호·일수·요금 변경", async () => {
  const ctx = setup();
  seed(ctx);

  const result = await change(ctx);
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const saved = order(ctx);
  assert.equal(saved.expected_pickup_at, NEXT_DAY_PICKUP);
  assert.equal(saved.expected_storage_days, 2);
  assert.equal(saved.tag_no, "146");
  assert.equal(saved.prepaid_amount, 1600);
  assert.equal(saved.final_amount, 1600);
  assert.equal(result.data.pricing?.amountsUpdated, true);
  assert.equal(audits(ctx).length, 1);
});

test("결제 완료: 번호와 일수만 변경하고 수납 원장 보존", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PAID");

  ctx.sqlite.prepare(`
    INSERT INTO luggage_order_payments
      (order_id, business_date, tender_type, amount)
    VALUES (?, '20261021', 'CASH', 800)
  `).run(ORDER_ID);

  const result = await change(ctx);
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const saved = order(ctx);
  assert.equal(saved.tag_no, "146");
  assert.equal(saved.expected_storage_days, 2);
  assert.equal(saved.prepaid_amount, 800);
  assert.equal(saved.final_amount, 800);

  const payments = ctx.sqlite.prepare(`
    SELECT amount FROM luggage_order_payments WHERE order_id = ?
  `).all(ORDER_ID) as Array<{ amount: number }>;

  assert.deepEqual(payments.map(p => p.amount), [800]);
  assert.equal(result.data.pricing?.expectedAmount, 1600);
  assert.equal(result.data.pricing?.paidAmount, 800);
  assert.equal(result.data.pricing?.outstandingAmount, 800);
  assert.equal(result.data.pricing?.amountsUpdated, false);
});

test("장기 번호 5개 소진: 주문과 감사 기록 불변", async () => {
  const ctx = setup();
  seed(ctx);

  for (let tag = 146; tag <= 150; tag++) {
    seed(ctx, `20261021-${tag}`, "PAID", String(tag));
  }

  const before = order(ctx);
  const result = await change(ctx);

  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal(result.data.code, "NO_LONG_TAG");
  assert.deepEqual(order(ctx), before);
  assert.equal(audits(ctx).length, 0);
});

test("감사 기록 실패: 날짜·번호·요금 모두 롤백", async () => {
  const ctx = setup();
  seed(ctx);

  ctx.sqlite.exec(`
    CREATE TRIGGER block_pickup_audit
    BEFORE INSERT ON luggage_audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'synthetic audit failure');
    END;
  `);

  const before = order(ctx);
  const result = await change(ctx);

  assert.notEqual(result.status, 200);
  assert.deepEqual(order(ctx), before);
  assert.equal(audits(ctx).length, 0);
});

test("수령 완료: 날짜 변경 거부 및 데이터 보존", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PICKED_UP");

  const before = order(ctx);
  const result = await change(ctx);

  assert.equal(result.status, 409);
  assert.equal(result.data.code, "STATUS_NOT_EDITABLE");
  assert.deepEqual(order(ctx), before);
  assert.equal(audits(ctx).length, 0);
});

test("픽업 날짜 null 초기화: 400으로 차단하고 주문·감사 기록 불변", async () => {
  const ctx = setup();
  seed(ctx);

  const before = order(ctx);
  const result = await change(ctx, null);

  assert.equal(result.status, 400, JSON.stringify(result.data));
  assert.equal(result.data.code, "PICKUP_DATE_REQUIRED");
  assert.deepEqual(order(ctx), before);
  assert.equal(audits(ctx).length, 0);
});

test("null 차단은 다른 운영 필드 수정에 영향 없음", async () => {
  const ctx = setup();
  seed(ctx);

  const url = `https://luggage.test/internal/luggage-orders/${ORDER_ID}/operations-fields`;
  const body = JSON.stringify({
    name: "Renamed Guest",
    actor: { userId: "synthetic-user", name: "Synthetic Tester", email: "tester@example.test", role: "center_staff" },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method: "PATCH", url, timestamp, body });
  const response = await ctx.app.request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-internal-timestamp": timestamp, "x-internal-signature": signature },
    body,
  }, ctx.env);

  assert.equal(response.status, 200);
  const saved = ctx.sqlite.prepare("SELECT name, expected_pickup_at FROM luggage_orders WHERE order_id = ?").get(ORDER_ID) as Record<string, any>;
  assert.equal(saved.name, "Renamed Guest");
  assert.equal(saved.expected_pickup_at, ORIGINAL_PICKUP);
});

test("이미 다음 날 픽업인데 1~145번인 주문: 같은 날짜 재요청으로 146번 재배정", async () => {
  const ctx = setup();
  seed(ctx);
  ctx.sqlite.prepare("UPDATE luggage_orders SET expected_pickup_at = ? WHERE order_id = ?").run(NEXT_DAY_PICKUP, ORDER_ID);

  // Same JST date, different time: previously handled as a field-only edit that left tag 55 in place.
  const result = await change(ctx, "2026-10-22T05:00:00.000Z");
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const saved = order(ctx);
  assert.equal(saved.tag_no, "146");
  assert.equal(saved.expected_storage_days, 2);
  assert.equal(result.data.tagReassigned, true);
});

test("정합한 장기 번호표는 같은 날짜 시각 변경에서 유지", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PAYMENT_PENDING", "148");
  ctx.sqlite.prepare("UPDATE luggage_orders SET expected_pickup_at = ? WHERE order_id = ?").run(NEXT_DAY_PICKUP, ORDER_ID);

  const result = await change(ctx, "2026-10-22T05:00:00.000Z");
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(order(ctx).tag_no, "148");
  assert.equal(result.data.pricing, undefined);
});

test("장기 번호 1개 남음: 동시 변경 2건 중 1건만 성공, 번호 중복 없음", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PAYMENT_PENDING", "55");
  seed(ctx, "20261021-002", "PAYMENT_PENDING", "56");
  for (let tag = 146; tag <= 149; tag++) {
    seed(ctx, `20261021-${tag}`, "PAID", String(tag));
  }

  const [first, second] = await Promise.all([
    change(ctx, NEXT_DAY_PICKUP, ORDER_ID),
    change(ctx, NEXT_DAY_PICKUP, "20261021-002"),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const loser = first.status === 409 ? first : second;
  assert.ok(["NO_LONG_TAG", "TAG_CLAIMED"].includes(loser.data.code), JSON.stringify(loser.data));

  const tags = ctx.sqlite.prepare(
    "SELECT tag_no FROM luggage_orders WHERE status IN ('PAYMENT_PENDING','PAID')"
  ).all() as Array<{ tag_no: string }>;
  assert.equal(new Set(tags.map(t => t.tag_no)).size, tags.length);
  assert.equal(audits(ctx).length, 1);
  const unchanged = ctx.sqlite.prepare(
    "SELECT tag_no, expected_pickup_at FROM luggage_orders WHERE order_id = ?"
  ).get(first.status === 409 ? ORDER_ID : "20261021-002") as Record<string, any>;
  assert.equal(unchanged.expected_pickup_at, ORIGINAL_PICKUP);
  assert.ok(["55", "56"].includes(unchanged.tag_no));
});

test("결제 완료 + 원장 없음: 주문 금액 기준 추정으로 표시하고 데이터 불변", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PAID");

  const result = await change(ctx);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.pricing?.paidAmountSource, "ORDER_FINAL_AMOUNT");
  assert.equal(result.data.pricing?.paidAmountEstimated, true);
  assert.equal(result.data.pricing?.paidAmount, 800);
  assert.equal(result.data.pricing?.outstandingAmount, 800);
  assert.equal(order(ctx).prepaid_amount, 800);
  assert.equal(order(ctx).final_amount, 800);
  const rows = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_order_payments").get() as { n: number };
  assert.equal(rows.n, 0);
});

test("결제 완료 + 원장 있음: 추정 아님", async () => {
  const ctx = setup();
  seed(ctx, ORDER_ID, "PAID");
  ctx.sqlite.prepare(`
    INSERT INTO luggage_order_payments (order_id, business_date, tender_type, amount)
    VALUES (?, '20261021', 'PAY_QR', 800)
  `).run(ORDER_ID);

  const result = await change(ctx);
  assert.equal(result.data.pricing?.paidAmountSource, "LEDGER");
  assert.equal(result.data.pricing?.paidAmountEstimated, false);
});

test("수동 요금: 미결제 주문은 override 금액 유지", async () => {
  const ctx = setup();
  seed(ctx);
  ctx.sqlite.prepare(`
    UPDATE luggage_orders
    SET staff_prepaid_override_amount = 1000, prepaid_amount = 1000, final_amount = 1000
    WHERE order_id = ?
  `).run(ORDER_ID);

  const result = await change(ctx);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const saved = order(ctx);
  assert.equal(saved.expected_storage_days, 2);
  assert.equal(saved.prepaid_amount, 1000);
  assert.equal(saved.final_amount, 1000);
  assert.equal(result.data.pricing?.expectedAmount, 1000);
});

test("무료 접수: 일 요금 0이면 금액 0 유지", async () => {
  const ctx = setup();
  seed(ctx);
  ctx.sqlite.prepare(`
    UPDATE luggage_orders SET price_per_day = 0, prepaid_amount = 0, final_amount = 0 WHERE order_id = ?
  `).run(ORDER_ID);

  const result = await change(ctx);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const saved = order(ctx);
  assert.equal(saved.tag_no, "146");
  assert.equal(saved.prepaid_amount, 0);
  assert.equal(saved.final_amount, 0);
  assert.equal(result.data.pricing?.expectedAmount, 0);
});

test("Flying Pass 할인·장기 할인: 새 일수 기준으로 재계산", async () => {
  const ctx = setup();
  seed(ctx);
  ctx.sqlite.prepare("UPDATE luggage_orders SET flying_pass_tier = 'SILVER' WHERE order_id = ?").run(ORDER_ID);

  const result = await change(ctx, "2026-10-27T03:00:00.000Z");
  assert.equal(result.status, 200, JSON.stringify(result.data));

  const expected = recalculateOrderPrepaid(800, 7, "SILVER");
  const saved = ctx.sqlite.prepare(`
    SELECT expected_storage_days, discount_rate, prepaid_amount, final_amount, flying_pass_discount_amount
    FROM luggage_orders WHERE order_id = ?
  `).get(ORDER_ID) as Record<string, any>;
  assert.equal(saved.expected_storage_days, 7);
  assert.equal(saved.discount_rate, expected.discountRate);
  assert.equal(saved.prepaid_amount, expected.finalPrepaid);
  assert.equal(saved.final_amount, expected.finalPrepaid);
  assert.equal(saved.flying_pass_discount_amount, expected.flyingPassDiscountAmount);
});
