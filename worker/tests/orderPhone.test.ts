import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import staffApi from "../src/routes/staffApi";
import staffOrders from "../src/routes/staffOrders";
import { signInternalRequest } from "../src/lib/hmac";
import { maskPhone } from "../src/services/orderPhoneWrites";

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
  const app = new Hono().route("/", internalApi).route("/", staffApi).route("/", staffOrders);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test", DEV_STAFF_AUTH_BYPASS: "1" };
  return { app, env, sqlite };
}

const UPDATED_AT = "2026-09-29 01:00:00";
const PHONE = "090-1234-5678";

function seedOrder(sqlite: DatabaseSync, orderId: string, extra: { status?: string; phone?: string | null } = {}) {
  sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, suitcase_qty, set_qty, price_per_day,
       prepaid_amount, final_amount, payment_method, status, tag_no, note, flying_pass_tier)
     VALUES (?, '2026-09-29 00:30:00', ?, 'Synthetic Guest', ?, 1, 1, 800, 800, 800, 'CASH', ?, '12', 'fixture', 'NONE')`,
  ).run(orderId, UPDATED_AT, extra.phone === undefined ? PHONE : extra.phone, extra.status ?? "PAID");
}

async function call(ctx: ReturnType<typeof setup>, orderId: string, body: unknown, options: { unsigned?: boolean; secret?: string; raw?: string } = {}) {
  const url = `https://luggage.test/internal/luggage-orders/${orderId}/phone`;
  const raw = options.raw ?? JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: options.secret ?? SECRET, method: "PATCH", url, timestamp, body: raw });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) {
    headers["x-internal-timestamp"] = timestamp;
    headers["x-internal-signature"] = signature;
  }
  const response = await ctx.app.request(url, { method: "PATCH", headers, body: raw }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

const actor = { userId: "unified-user-1", name: "Unified Tester", email: "editor@example.test", role: "center_staff" };
let requestSeq = 0;
function body(phone: unknown, overrides: Record<string, unknown> = {}) {
  requestSeq += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestSeq).padStart(12, "0")}`,
    phone,
    expected: { phone: PHONE, updatedAt: UPDATED_AT },
    actor,
    ...overrides,
  };
}

const COLUMNS = `order_id, name, phone, email, status, tag_no, note, expected_pickup_at, flying_pass_tier, flying_pass_discount_amount,
  prepaid_amount, final_amount, staff_prepaid_override_amount, payment_method, in_warehouse`;
function row(sqlite: DatabaseSync, orderId: string) {
  return { ...(sqlite.prepare(`SELECT ${COLUMNS}, updated_at FROM luggage_orders WHERE order_id = ?`).get(orderId) as Record<string, any>) };
}
function stored(sqlite: DatabaseSync, orderId: string) {
  const { order_id: _id, updated_at: _updated, ...rest } = row(sqlite, orderId);
  return rest;
}

function audits(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT order_id, staff_id, device_id, action, details FROM luggage_audit_logs ORDER BY log_id").all() as Array<Record<string, any>>;
}

test("phone change as the resolved legacy staff, with a masked audit in the same batch", async () => {
  stubProfiles([EDITOR, { ...EDITOR, id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" }]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-001");
  const before = stored(ctx.sqlite, "20260929-001");
  const res = await call(ctx, "20260929-001", body("  080-9876-5432  "));
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, true);
  const after = row(ctx.sqlite, "20260929-001");
  assert.equal(after.phone, "080-9876-5432");
  assert.notEqual(after.updated_at, UPDATED_AT);
  assert.deepEqual(res.json.order, { orderId: "20260929-001", phone: "080-9876-5432", updatedAt: after.updated_at });
  // Nothing but phone/updated_at changes: status, tier, amounts, tag, note stay as they were.
  assert.deepEqual({ ...stored(ctx.sqlite, "20260929-001"), phone: before.phone }, before);

  const [log] = audits(ctx.sqlite);
  assert.equal(log.action, "UNIFIED_ADMIN_ORDER_PHONE_UPDATE");
  assert.equal(log.staff_id, EDITOR.id);
  assert.equal(log.device_id, "unified-admin");
  assert.equal(log.details.includes("5432") && !log.details.includes("9876") && !log.details.includes("1234"), true);
  const details = JSON.parse(log.details);
  assert.deepEqual(details.before, { phoneMasked: "***-****-5678", updatedAt: UPDATED_AT });
  assert.deepEqual(details.after, { phoneMasked: "***-****-5432", updatedAt: after.updated_at });
  assert.deepEqual(details.expected, { updatedAt: UPDATED_AT });
  assert.deepEqual(details.actor, actor);
  assert.deepEqual(details.legacyStaff, { id: EDITOR.id, displayName: "Synthetic Editor", role: "editor" });
});

test("stores exactly what the staff detail and inline routes store for the same phone", async () => {
  stubProfiles([EDITOR]);
  const inputs = ["080-9876-5432", "+81 90 1111 2222", "(03) 1234-5678", "01012345678", "a".repeat(50)];
  for (const phone of inputs) {
    const ctx = setup();
    for (const id of ["20260929-010", "20260929-011", "20260929-012"]) seedOrder(ctx.sqlite, id);
    const detail = await ctx.app.request("https://luggage.test/staff/orders/20260929-010/update", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "Synthetic Guest", phone, tag_no: "12", expected_pickup_at: "", note: "fixture" }),
    }, ctx.env);
    assert.equal(detail.status, 302);
    const inline = await ctx.app.request("https://luggage.test/staff/api/orders/20260929-011/inline-update", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }),
    }, ctx.env);
    assert.equal(inline.status, 200);
    assert.equal((await call(ctx, "20260929-012", body(phone))).status, 200);
    const unified = stored(ctx.sqlite, "20260929-012");
    assert.equal(unified.phone, phone);
    assert.deepEqual(unified, stored(ctx.sqlite, "20260929-011"), phone);
    // The detail form also resubmits the other fields; phone and everything else not in the form still match.
    assert.equal(stored(ctx.sqlite, "20260929-010").phone, unified.phone);
  }
});

test("no status restriction, like the staff routes; NULL phone can be filled in", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const statuses = ["PAYMENT_PENDING", "PAID", "PICKED_UP", "CANCELLED"];
  statuses.forEach((status, index) => seedOrder(ctx.sqlite, `20260929-02${index}`, { status }));
  for (const [index, status] of statuses.entries()) {
    const res = await call(ctx, `20260929-02${index}`, body("080-0000-1111"));
    assert.equal(res.status, 200, status);
    assert.deepEqual([row(ctx.sqlite, `20260929-02${index}`).phone, row(ctx.sqlite, `20260929-02${index}`).status], ["080-0000-1111", status]);
  }
  seedOrder(ctx.sqlite, "20260929-029", { phone: null });
  const fromNull = await call(ctx, "20260929-029", body("080-2222-3333", { expected: { phone: "", updatedAt: UPDATED_AT } }));
  assert.equal(fromNull.status, 200);
  assert.equal(JSON.parse(audits(ctx.sqlite).at(-1)!.details).before.phoneMasked, null);
});

test("unchanged phone is a no-op without an audit row", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-030");
  const res = await call(ctx, "20260929-030", body(` ${PHONE} `));
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, false);
  assert.equal(row(ctx.sqlite, "20260929-030").updated_at, UPDATED_AT);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("stale updatedAt and a same-second phone change are refused without writing", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-040");
  const staleTime = await call(ctx, "20260929-040", body("080-1", { expected: { phone: PHONE, updatedAt: "2026-09-29 00:59:59" } }));
  assert.deepEqual([staleTime.status, staleTime.json.code], [409, "STALE"]);
  // Same second, different phone: another staff member edited it within the same updated_at second.
  const stalePhone = await call(ctx, "20260929-040", body("080-1", { expected: { phone: "070-0000-0000", updatedAt: UPDATED_AT } }));
  assert.deepEqual([stalePhone.status, stalePhone.json.code], [409, "STALE"]);
  assert.equal(row(ctx.sqlite, "20260929-040").phone, PHONE);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("a concurrent staff-screen change between read and write is not overwritten", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-050");
  seedOrder(ctx.sqlite, "20260929-051");
  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET phone = 'staff-1', updated_at = '2026-09-29 01:00:05' WHERE order_id = '20260929-050'").run();
    return realBatch(statements);
  };
  const bumped = await call(ctx, "20260929-050", body("080-1"));
  assert.deepEqual([bumped.status, bumped.json.code], [409, "STALE"]);
  assert.equal(row(ctx.sqlite, "20260929-050").phone, "staff-1");
  // Same-second race: phone changes but updated_at stays identical — the phone predicate still blocks it.
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET phone = 'staff-2' WHERE order_id = '20260929-051'").run();
    return realBatch(statements);
  };
  const sameSecond = await call(ctx, "20260929-051", body("080-1"));
  assert.deepEqual([sameSecond.status, sameSecond.json.code], [409, "STALE"]);
  assert.equal(row(ctx.sqlite, "20260929-051").phone, "staff-2");
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("replaying the same requestId does not write twice or duplicate the audit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-060");
  const first = body("080-1111-2222");
  assert.equal((await call(ctx, "20260929-060", first)).status, 200);
  const replay = await call(ctx, "20260929-060", first);
  assert.deepEqual([replay.status, replay.json.code], [409, "DUPLICATE_REQUEST"]);
  assert.equal(audits(ctx.sqlite).length, 1);
  // Replay guard inside the write itself: the row was reset with the same updated_at out-of-band.
  ctx.sqlite.prepare("UPDATE luggage_orders SET phone = ?, updated_at = ? WHERE order_id = '20260929-060'").run(PHONE, UPDATED_AT);
  const replayAfterReset = await call(ctx, "20260929-060", first);
  assert.deepEqual([replayAfterReset.status, replayAfterReset.json.code], [409, "DUPLICATE_REQUEST"]);
  assert.equal(row(ctx.sqlite, "20260929-060").phone, PHONE);
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
    seedOrder(ctx.sqlite, "20260929-070");
    const res = await call(ctx, "20260929-070", body("080-1"));
    assert.equal(res.status, status, JSON.stringify(profiles));
    assert.equal(row(ctx.sqlite, "20260929-070").phone, PHONE);
    assert.equal(audits(ctx.sqlite).length, 0);
  }
  stubProfiles([{ ...EDITOR, role: "admin" }]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-071");
  assert.equal((await call(ctx, "20260929-071", body("080-1"))).status, 200);
});

test("payload validation rejects injected fields, unified roles, and malformed values", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-080");
  const bad: unknown[] = [
    body(""),
    body("   "),
    body(null),
    body(9012345678),
    body(["080"]),
    body("1".repeat(51)),
    { ...body("080-1"), staffId: "attacker" },
    { ...body("080-1"), name: "Injected" },
    { ...body("080-1"), flyingPassTier: "GOLD" },
    { ...body("080-1"), action: "UNIFIED_ADMIN_ORDER_PHONE_UPDATE" },
    { ...body("080-1"), expected: { phone: PHONE, updatedAt: UPDATED_AT, staffId: "x" } },
    { ...body("080-1"), expected: { updatedAt: UPDATED_AT } },
    { ...body("080-1"), expected: { phone: null, updatedAt: UPDATED_AT } },
    { ...body("080-1"), requestId: "not-a-uuid" },
    { ...body("080-1"), actor: { ...actor, role: "office_staff" } },
    { ...body("080-1"), actor: { ...actor, role: "viewer" } },
    { ...body("080-1"), actor: { ...actor, staffId: "x" } },
    [],
  ];
  for (const payload of bad) {
    assert.equal((await call(ctx, "20260929-080", payload)).status, 400, JSON.stringify(payload));
  }
  assert.equal((await call(ctx, "20260929-080", null, { raw: "{not json" })).status, 400);
  assert.equal((await call(ctx, "not-an-order", body("080-1"))).status, 400);
  const missing = await call(ctx, "20260929-099", body("080-1"));
  assert.deepEqual([missing.status, missing.json.code], [404, "NOT_FOUND"]);
  assert.equal(row(ctx.sqlite, "20260929-080").phone, PHONE);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("HMAC authentication is required", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-090");
  assert.equal((await call(ctx, "20260929-090", body("080-1"), { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "20260929-090", body("080-1"), { secret: "wrong" })).status, 401);
  assert.equal(row(ctx.sqlite, "20260929-090").phone, PHONE);
});

test("audit failure rolls back the phone change", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20260929-095");
  ctx.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_audit_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  assert.equal((await call(ctx, "20260929-095", body("080-1"))).status, 500);
  const after = row(ctx.sqlite, "20260929-095");
  assert.deepEqual([after.phone, after.updated_at], [PHONE, UPDATED_AT]);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("maskPhone keeps only the last four digits", () => {
  assert.equal(maskPhone("090-1234-5678"), "***-****-5678");
  assert.equal(maskPhone("+81 90 1111 2222"), "+** ** **** 2222");
  assert.equal(maskPhone("123"), "123");
  assert.equal(maskPhone(null), null);
});
