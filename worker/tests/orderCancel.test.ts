import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import { signInternalRequest } from "../src/lib/hmac";

const SECRET = "reviewer-test-key";
const originalFetch = globalThis.fetch;

type Profile = { id: string; display_name: string | null; username: string | null; email: string | null; role: string; is_active: boolean };
const EDITOR: Profile = { id: "11111111-1111-4111-8111-111111111111", display_name: "Synthetic Editor", username: "editor", email: "Editor@Example.test", role: "editor", is_active: true };

function stubProfiles(profiles: Profile[] | "error") {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://supabase.test/rest/v1/user_profiles")) throw new Error(`unexpected fetch ${url}`);
    if (profiles === "error") return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(profiles), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => { globalThis.fetch = originalFetch; });

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      // D1-like result: rows from RETURNING plus meta.changes of this statement.
      async run() {
        const rows = sqlite.prepare(sql).all(...(args as never[]));
        const { c } = sqlite.prepare("SELECT changes() AS c").get() as { c: number };
        return { results: rows, meta: { changes: c } };
      },
      async all() { return { results: sqlite.prepare(sql).all(...(args as never[])) }; },
      async first() { return sqlite.prepare(sql).get(...(args as never[])) || null; },
    };
  };
  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const app = new Hono().route("/", internalApi);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test" };
  return { app, env, sqlite };
}

const UPDATED_AT = "2026-09-29 01:00:00";

function seedOrder(sqlite: DatabaseSync, orderId: string, status: string, extra: { parentOrderId?: string; tagNo?: string } = {}) {
  sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, suitcase_qty, set_qty, price_per_day,
       prepaid_amount, final_amount, payment_method, status, tag_no, note, parent_order_id)
     VALUES (?, '2026-09-29 00:30:00', ?, 'Synthetic Guest', '000-0000', 1, 1, 800, 800, 800, 'CASH', ?, ?, 'fixture', ?)`,
  ).run(orderId, UPDATED_AT, status, extra.tagNo ?? "12", extra.parentOrderId ?? null);
}

async function call(ctx: ReturnType<typeof setup>, orderId: string, body: unknown, options: { unsigned?: boolean; secret?: string; raw?: string } = {}) {
  const url = `https://luggage.test/internal/luggage-orders/${orderId}/cancel`;
  const raw = options.raw ?? JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: options.secret ?? SECRET, method: "POST", url, timestamp, body: raw });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) {
    headers["x-internal-timestamp"] = timestamp;
    headers["x-internal-signature"] = signature;
  }
  const response = await ctx.app.request(url, { method: "POST", headers, body: raw }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

const actor = { userId: "unified-user-1", name: "Unified Tester", email: "editor@example.test", role: "center_staff" };
let requestSeq = 0;
function body(overrides: Record<string, unknown> = {}) {
  requestSeq += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestSeq).padStart(12, "0")}`,
    expected: { status: "PAYMENT_PENDING", updatedAt: UPDATED_AT },
    actor,
    ...overrides,
  };
}

function order(sqlite: DatabaseSync, orderId: string) {
  return sqlite.prepare("SELECT status, updated_at, tag_no, note, payment_method FROM luggage_orders WHERE order_id = ?").get(orderId) as Record<string, any>;
}

function audits(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT order_id, staff_id, device_id, action, details FROM luggage_audit_logs ORDER BY log_id").all() as Array<Record<string, any>>;
}

test("PAYMENT_PENDING → CANCELLED as the resolved legacy staff, with the audit in the same batch", async () => {
  stubProfiles([EDITOR, { ...EDITOR, id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" }]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-001", "PAYMENT_PENDING");
  ctx.sqlite.prepare("INSERT INTO luggage_order_payments (order_id, business_date, tender_type, amount) VALUES ('20260929-001', '2026-09-29', 'CASH', 800)").run();
  const res = await call(ctx, "20260929-001", body());
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, true);
  assert.equal(res.json.order.orderId, "20260929-001");
  assert.equal(res.json.order.status, "CANCELLED");
  const row = order(ctx.sqlite, "20260929-001");
  assert.equal(row.status, "CANCELLED");
  assert.notEqual(row.updated_at, UPDATED_AT);
  assert.equal(res.json.order.updatedAt, row.updated_at);
  // Same meaning as the staff cancel: nothing but status/updated_at changes.
  assert.deepEqual({ tag: row.tag_no, note: row.note, method: row.payment_method }, { tag: "12", note: "fixture", method: "CASH" });
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_order_payments").get()!.n, 1);

  const [log] = audits(ctx.sqlite);
  assert.equal(log.action, "UNIFIED_ADMIN_ORDER_CANCEL");
  assert.equal(log.order_id, "20260929-001");
  assert.equal(log.staff_id, EDITOR.id);
  assert.equal(log.device_id, "unified-admin");
  const details = JSON.parse(log.details);
  assert.deepEqual(details.before, { status: "PAYMENT_PENDING", updatedAt: UPDATED_AT });
  assert.deepEqual(details.after, { status: "CANCELLED", updatedAt: row.updated_at });
  assert.deepEqual(details.expected, { status: "PAYMENT_PENDING", updatedAt: UPDATED_AT });
  assert.deepEqual(details.actor, actor);
  assert.deepEqual(details.legacyStaff, { id: EDITOR.id, displayName: "Synthetic Editor", role: "editor" });
  assert.match(details.requestId, /^00000000-/);
});

test("extension child orders cancel the same way and the parent is untouched", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-002", "PAID");
  seedOrder(ctx.sqlite, "EXT-20260929-002", "PAYMENT_PENDING", { parentOrderId: "20260929-002" });
  assert.equal((await call(ctx, "EXT-20260929-002", body())).status, 200);
  assert.equal(order(ctx.sqlite, "EXT-20260929-002").status, "CANCELLED");
  assert.deepEqual({ ...order(ctx.sqlite, "20260929-002") }.status, "PAID");
  assert.equal(order(ctx.sqlite, "20260929-002").updated_at, UPDATED_AT);
});

test("status restrictions: already cancelled, PAID, PICKED_UP and unknown statuses are refused with distinct codes", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-010", "CANCELLED");
  seedOrder(ctx.sqlite, "20260929-011", "PAID");
  seedOrder(ctx.sqlite, "20260929-012", "PICKED_UP");
  seedOrder(ctx.sqlite, "20260929-013", "SOMETHING_ELSE");
  const already = await call(ctx, "20260929-010", body({ expected: { status: "CANCELLED", updatedAt: UPDATED_AT } }));
  assert.deepEqual([already.status, already.json.code], [409, "ALREADY_CANCELLED"]);
  // Even when the screen still thinks it is pending, the source says it is already cancelled.
  const alreadyFromPending = await call(ctx, "20260929-010", body());
  assert.deepEqual([alreadyFromPending.status, alreadyFromPending.json.code], [409, "ALREADY_CANCELLED"]);
  for (const [id, status] of [["20260929-011", "PAID"], ["20260929-012", "PICKED_UP"], ["20260929-013", "SOMETHING_ELSE"]]) {
    const res = await call(ctx, id, body({ expected: { status, updatedAt: UPDATED_AT } }));
    assert.deepEqual([res.status, res.json.code], [409, "INVALID_STATUS"], id);
    assert.equal(order(ctx.sqlite, id).status, status);
  }
  const missing = await call(ctx, "20260929-099", body());
  assert.deepEqual([missing.status, missing.json.code], [404, "NOT_FOUND"]);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("stale updatedAt and stale status are refused without writing", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-020", "PAYMENT_PENDING");
  const staleTime = await call(ctx, "20260929-020", body({ expected: { status: "PAYMENT_PENDING", updatedAt: "2026-09-29 00:59:59" } }));
  assert.deepEqual([staleTime.status, staleTime.json.code], [409, "STALE"]);
  // Same second, different status: another staff member paid it within the same updated_at second.
  seedOrder(ctx.sqlite, "20260929-021", "PAID");
  const staleStatus = await call(ctx, "20260929-021", body());
  assert.deepEqual([staleStatus.status, staleStatus.json.code], [409, "STALE"]);
  assert.equal(order(ctx.sqlite, "20260929-020").status, "PAYMENT_PENDING");
  assert.equal(order(ctx.sqlite, "20260929-021").status, "PAID");
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("a concurrent staff-screen change between read and write is not overwritten", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-030", "PAYMENT_PENDING");
  seedOrder(ctx.sqlite, "20260929-031", "PAYMENT_PENDING");
  const realBatch = ctx.env.DB.batch;
  // Staff marks it paid right before the guarded UPDATE runs (bump updated_at like the staff route).
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAID', updated_at = '2026-09-29 01:00:05' WHERE order_id = '20260929-030'").run();
    return realBatch(statements);
  };
  const paid = await call(ctx, "20260929-030", body());
  assert.deepEqual([paid.status, paid.json.code], [409, "STALE"]);
  assert.equal(order(ctx.sqlite, "20260929-030").status, "PAID");
  // Same-second race: status flips but updated_at stays identical — the status predicate still blocks it.
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAID' WHERE order_id = '20260929-031'").run();
    return realBatch(statements);
  };
  const sameSecond = await call(ctx, "20260929-031", body());
  assert.deepEqual([sameSecond.status, sameSecond.json.code], [409, "STALE"]);
  assert.equal(order(ctx.sqlite, "20260929-031").status, "PAID");
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("replaying the same requestId does not cancel twice or duplicate the audit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-040", "PAYMENT_PENDING");
  const first = body();
  assert.equal((await call(ctx, "20260929-040", first)).status, 200);
  const replay = await call(ctx, "20260929-040", first);
  assert.deepEqual([replay.status, replay.json.code], [409, "DUPLICATE_REQUEST"]);
  // A new request for the now-cancelled order is a different answer from the replay.
  const again = await call(ctx, "20260929-040", body());
  assert.deepEqual([again.status, again.json.code], [409, "ALREADY_CANCELLED"]);
  assert.equal(audits(ctx.sqlite).length, 1);

  // Replay guard inside the write itself: the order was reset to pending with the same updated_at
  // (e.g. restored out-of-band), and the same requestId must still not write again.
  ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAYMENT_PENDING', updated_at = ? WHERE order_id = '20260929-040'").run(UPDATED_AT);
  const replayAfterReset = await call(ctx, "20260929-040", first);
  assert.deepEqual([replayAfterReset.status, replayAfterReset.json.code], [409, "DUPLICATE_REQUEST"]);
  assert.equal(order(ctx.sqlite, "20260929-040").status, "PAYMENT_PENDING");
  assert.equal(audits(ctx.sqlite).length, 1);
});

test("actor mapping fails closed", async () => {
  const cases: Array<[Profile[] | "error", number]> = [
    [[], 403],
    [[{ ...EDITOR, is_active: false }], 403],
    [[{ ...EDITOR, role: "viewer" }], 403],
    [[EDITOR, { ...EDITOR, id: "33333333-3333-4333-8333-333333333333" }], 403],
    ["error", 503],
  ];
  for (const [profiles, status] of cases) {
    stubProfiles(profiles);
    const ctx = setup();
    seedOrder(ctx.sqlite, "20260929-050", "PAYMENT_PENDING");
    const res = await call(ctx, "20260929-050", body());
    assert.equal(res.status, status, JSON.stringify(profiles));
    assert.equal(order(ctx.sqlite, "20260929-050").status, "PAYMENT_PENDING");
    assert.equal(audits(ctx.sqlite).length, 0);
  }
  stubProfiles([{ ...EDITOR, role: "admin" }]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-051", "PAYMENT_PENDING");
  assert.equal((await call(ctx, "20260929-051", body())).status, 200);
});

test("payload validation rejects injected fields, unified roles, and malformed values", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-060", "PAYMENT_PENDING");
  const bad: unknown[] = [
    { ...body(), staffId: "attacker" },
    { ...body(), status: "CANCELLED" },
    { ...body(), action: "UNIFIED_ADMIN_ORDER_CANCEL" },
    { ...body(), expected: { status: "PAYMENT_PENDING", updatedAt: UPDATED_AT, staffId: "x" } },
    { ...body(), expected: { status: "PAYMENT_PENDING" } },
    { ...body(), requestId: "not-a-uuid" },
    { ...body(), requestId: undefined },
    { ...body(), actor: { ...actor, role: "office_staff" } },
    { ...body(), actor: { ...actor, role: "viewer" } },
    { ...body(), actor: { ...actor, staffId: "x" } },
    { ...body(), actor: { ...actor, email: "no-at-sign" } },
    [],
  ];
  for (const payload of bad) {
    assert.equal((await call(ctx, "20260929-060", payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal((await call(ctx, "20260929-060", null, { raw: "{not json" })).status, 400);
  assert.equal((await call(ctx, "not-an-order", body())).status, 400);
  assert.equal(order(ctx.sqlite, "20260929-060").status, "PAYMENT_PENDING");
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("HMAC authentication is required", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-070", "PAYMENT_PENDING");
  assert.equal((await call(ctx, "20260929-070", body(), { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "20260929-070", body(), { secret: "wrong" })).status, 401);
  assert.equal(order(ctx.sqlite, "20260929-070").status, "PAYMENT_PENDING");
});

test("audit failure rolls back the cancel", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-080", "PAYMENT_PENDING");
  ctx.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_audit_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  assert.equal((await call(ctx, "20260929-080", body())).status, 500);
  const row = order(ctx.sqlite, "20260929-080");
  assert.deepEqual([row.status, row.updated_at], ["PAYMENT_PENDING", UPDATED_AT]);
  assert.equal(audits(ctx.sqlite).length, 0);
});
