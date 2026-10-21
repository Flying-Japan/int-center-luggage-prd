import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import staffApi from "../src/routes/staffApi";
import staffOrders from "../src/routes/staffOrders";
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
  const app = new Hono().route("/", internalApi).route("/", staffApi).route("/", staffOrders);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test", DEV_STAFF_AUTH_BYPASS: "1" };
  return { app, env, sqlite };
}

const UPDATED_AT = "2026-10-21 01:00:00";
type Seed = { status?: string; suitcase?: number; backpack?: number; days?: number; tier?: string; override?: number | null; parent?: string | null; pricePerDay?: number; prepaid?: number; final?: number; method?: string | null };

function seedOrder(sqlite: DatabaseSync, orderId: string, extra: Seed = {}) {
  const suitcase = extra.suitcase ?? 1;
  const backpack = extra.backpack ?? 0;
  const days = extra.days ?? 2;
  const pricePerDay = extra.pricePerDay ?? 800 * suitcase + 500 * backpack;
  const prepaid = extra.prepaid ?? pricePerDay * days;
  sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, suitcase_qty, backpack_qty, set_qty, price_per_day, expected_storage_days,
       prepaid_amount, final_amount, payment_method, status, tag_no, note, flying_pass_tier, flying_pass_discount_amount, staff_prepaid_override_amount, parent_order_id)
     VALUES (?, '2026-10-21 00:30:00', ?, 'Synthetic Guest', '090-1234-5678', ?, ?, ?, ?, ?, ?, ?, ?, ?, '12', 'fixture', ?, 0, ?, ?)`,
  ).run(orderId, UPDATED_AT, suitcase, backpack, Math.min(suitcase, backpack), pricePerDay, days, prepaid, extra.final ?? prepaid,
    extra.method === undefined ? "CASH" : extra.method, extra.status ?? "PAYMENT_PENDING", extra.tier ?? "NONE", extra.override ?? null, extra.parent ?? null);
}

async function call(ctx: ReturnType<typeof setup>, orderId: string, body: unknown, options: { unsigned?: boolean; secret?: string; raw?: string } = {}) {
  const url = `https://luggage.test/internal/luggage-orders/${orderId}/pricing`;
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
type Expected = { updatedAt: string; suitcaseQty: number; backpackQty: number; flyingPassTier: string; staffPrepaidOverrideAmount: number | null; prepaidAmount: number };
function body(changes: Record<string, unknown>, overrides: Record<string, unknown> = {}, expected: Partial<Expected> = {}) {
  requestSeq += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestSeq).padStart(12, "0")}`,
    reason: "결제 전 정정(테스트)",
    expected: { updatedAt: UPDATED_AT, suitcaseQty: 1, backpackQty: 0, flyingPassTier: "NONE", staffPrepaidOverrideAmount: null, prepaidAmount: 1600, ...expected },
    changes,
    actor,
    ...overrides,
  };
}

const COLUMNS = `order_id, status, suitcase_qty, backpack_qty, set_qty, price_per_day, expected_storage_days, flying_pass_tier, flying_pass_discount_amount,
  staff_prepaid_override_amount, payment_method, prepaid_amount, final_amount, extra_amount, name, phone, tag_no, note, parent_order_id`;
function row(sqlite: DatabaseSync, orderId: string) {
  return { ...(sqlite.prepare(`SELECT ${COLUMNS}, updated_at FROM luggage_orders WHERE order_id = ?`).get(orderId) as Record<string, any>) };
}
function priced(sqlite: DatabaseSync, orderId: string) {
  const r = row(sqlite, orderId);
  return { suitcase: r.suitcase_qty, backpack: r.backpack_qty, set: r.set_qty, perDay: r.price_per_day, tier: r.flying_pass_tier, discount: r.flying_pass_discount_amount, override: r.staff_prepaid_override_amount, method: r.payment_method, prepaid: r.prepaid_amount, final: r.final_amount };
}
function audits(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT order_id, staff_id, device_id, action, details FROM luggage_audit_logs ORDER BY log_id").all() as Array<Record<string, any>>;
}

test("1. no discount -> BLUE: flat per-order discount of 200 applied once, audit has reason and before/after", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-001");
  const res = await call(ctx, "20261021-001", body({ flyingPassTier: "BLUE" }));
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, true);
  assert.deepEqual(priced(ctx.sqlite, "20261021-001"), { suitcase: 1, backpack: 0, set: 0, perDay: 800, tier: "BLUE", discount: 200, override: null, method: "CASH", prepaid: 1400, final: 1400 });
  assert.equal(res.json.order.prepaidAmount, 1400);
  assert.equal(res.json.order.updatedAt, row(ctx.sqlite, "20261021-001").updated_at);
  const [log] = audits(ctx.sqlite);
  assert.equal(log.action, "UNIFIED_ADMIN_ORDER_PRICING_UPDATE");
  assert.equal(log.staff_id, EDITOR.id);
  assert.equal(log.device_id, "unified-admin");
  const details = JSON.parse(log.details);
  assert.equal(details.reason, "결제 전 정정(테스트)");
  assert.equal(details.before.flyingPassTier, "NONE");
  assert.equal(details.before.finalAmount, 1600);
  assert.equal(details.after.flyingPassTier, "BLUE");
  assert.equal(details.after.finalAmount, 1400);
  assert.equal(details.after.updatedAt, row(ctx.sqlite, "20261021-001").updated_at);
  assert.deepEqual(details.actor, actor);
  assert.deepEqual(details.legacyStaff, { id: EDITOR.id, displayName: "Synthetic Editor", role: "editor" });
});

test("2./3. BLUE -> SILVER -> GOLD -> NONE (release) follows the staff update-price stored values exactly", async () => {
  stubProfiles([EDITOR]);
  for (const tier of ["BLUE", "SILVER", "GOLD", "PLATINUM", "BLACK", "NONE"]) {
    for (const days of [1, 2, 7, 14, 30, 60]) {
      const ctx = setup();
      seedOrder(ctx.sqlite, "20261021-010", { days, tier: "BLUE" });
      seedOrder(ctx.sqlite, "20261021-011", { days, tier: "BLUE" });
      const staff = await ctx.app.request("https://luggage.test/staff/api/orders/20261021-010/update-price", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flying_pass_tier: tier, payment_method: "CASH" }),
      }, ctx.env);
      assert.equal(staff.status, 200);
      const expected = { suitcaseQty: 1, backpackQty: 0, flyingPassTier: "BLUE", staffPrepaidOverrideAmount: null, prepaidAmount: 800 * days };
      const unified = await call(ctx, "20261021-011", body({ flyingPassTier: tier }, {}, expected));
      assert.equal(unified.status, tier === "BLUE" ? 200 : 200, `${tier}/${days}`);
      assert.deepEqual(priced(ctx.sqlite, "20261021-011"), priced(ctx.sqlite, "20261021-010"), `${tier}/${days}`);
    }
  }
});

test("4./5. bag count increase and decrease recompute set bundle, daily price and amount together", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-020");
  // 3 suitcases: 3 x 800 x 2 days
  assert.equal((await call(ctx, "20261021-020", body({ suitcaseQty: 3 }))).status, 200);
  assert.deepEqual(priced(ctx.sqlite, "20261021-020"), { suitcase: 3, backpack: 0, set: 0, perDay: 2400, tier: "NONE", discount: 0, override: null, method: "CASH", prepaid: 4800, final: 4800 });
  // add 1 backpack -> 1 set (1200) + 2 suitcases (1600) = 2800/day
  const afterThree = row(ctx.sqlite, "20261021-020");
  const add = await call(ctx, "20261021-020", body({ backpackQty: 1 }, {}, { suitcaseQty: 3, backpackQty: 0, prepaidAmount: 4800, updatedAt: afterThree.updated_at }));
  assert.equal(add.status, 200);
  assert.deepEqual(priced(ctx.sqlite, "20261021-020"), { suitcase: 3, backpack: 1, set: 1, perDay: 2800, tier: "NONE", discount: 0, override: null, method: "CASH", prepaid: 5600, final: 5600 });
  // decrease to a single backpack: 500/day
  const afterAdd = row(ctx.sqlite, "20261021-020");
  const dec = await call(ctx, "20261021-020", body({ suitcaseQty: 0 }, {}, { suitcaseQty: 3, backpackQty: 1, prepaidAmount: 5600, updatedAt: afterAdd.updated_at }));
  assert.equal(dec.status, 200);
  assert.deepEqual(priced(ctx.sqlite, "20261021-020"), { suitcase: 0, backpack: 1, set: 0, perDay: 500, tier: "NONE", discount: 0, override: null, method: "CASH", prepaid: 1000, final: 1000 });
  assert.equal(audits(ctx.sqlite).length, 3);
});

test("6. tier and counts together in one atomic write, with long-stay discount first then the flat tier discount", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-030", { days: 7 });
  const res = await call(ctx, "20261021-030", body({ suitcaseQty: 2, backpackQty: 1, flyingPassTier: "BLUE" }, {}, { prepaidAmount: 5600 }));
  assert.equal(res.status, 200);
  // set 1200 + suitcase 800 = 2000/day x 7 = 14000, 5% long stay = 13300, minus 200
  assert.deepEqual(priced(ctx.sqlite, "20261021-030"), { suitcase: 2, backpack: 1, set: 1, perDay: 2000, tier: "BLUE", discount: 200, override: null, method: "CASH", prepaid: 13100, final: 13100 });
  assert.equal(audits(ctx.sqlite).length, 1);
});

test("7. manual amount, payment method, and clearing it back to automatic", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-040");
  assert.equal((await call(ctx, "20261021-040", body({ staffPrepaidOverrideAmount: 1000, paymentMethod: "PAY_QR" }))).status, 200);
  assert.deepEqual(priced(ctx.sqlite, "20261021-040"), { suitcase: 1, backpack: 0, set: 0, perDay: 800, tier: "NONE", discount: 0, override: 1000, method: "PAY_QR", prepaid: 1000, final: 1000 });
  const after = row(ctx.sqlite, "20261021-040");
  // A later tier change keeps the manual amount (legacy behavior) ...
  const tierOnly = await call(ctx, "20261021-040", body({ flyingPassTier: "GOLD" }, {}, { staffPrepaidOverrideAmount: 1000, prepaidAmount: 1000, updatedAt: after.updated_at }));
  assert.equal(tierOnly.status, 200);
  assert.equal(priced(ctx.sqlite, "20261021-040").final, 1000);
  assert.equal(priced(ctx.sqlite, "20261021-040").discount, 400);
  // ... until it is cleared explicitly (null), which returns to the calculated price.
  const cleared = await call(ctx, "20261021-040", body({ staffPrepaidOverrideAmount: null }, {}, { staffPrepaidOverrideAmount: 1000, flyingPassTier: "GOLD", prepaidAmount: 1000, updatedAt: row(ctx.sqlite, "20261021-040").updated_at }));
  assert.equal(cleared.status, 200);
  assert.deepEqual([priced(ctx.sqlite, "20261021-040").override, priced(ctx.sqlite, "20261021-040").final], [null, 1200]);
  // zero is a valid amount and the maximum is accepted
  const zero = await call(ctx, "20261021-040", body({ staffPrepaidOverrideAmount: 0 }, {}, { flyingPassTier: "GOLD", prepaidAmount: 1200, updatedAt: row(ctx.sqlite, "20261021-040").updated_at }));
  assert.equal(zero.status, 200);
  assert.equal(priced(ctx.sqlite, "20261021-040").final, 0);
});

test("a manual amount is never silently kept across a bag count change", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-045", { override: 1000, prepaid: 1000, final: 1000 });
  const base = { prepaidAmount: 1000, staffPrepaidOverrideAmount: 1000 };
  const refused = await call(ctx, "20261021-045", body({ suitcaseQty: 2 }, {}, base));
  assert.deepEqual([refused.status, refused.json.code], [409, "OVERRIDE_DECISION_REQUIRED"]);
  assert.equal(priced(ctx.sqlite, "20261021-045").suitcase, 1);
  const keep = await call(ctx, "20261021-045", body({ suitcaseQty: 2, staffPrepaidOverrideAmount: 1000 }, {}, base));
  assert.equal(keep.status, 200);
  assert.deepEqual([priced(ctx.sqlite, "20261021-045").suitcase, priced(ctx.sqlite, "20261021-045").perDay, priced(ctx.sqlite, "20261021-045").final], [2, 1600, 1000]);
  const clear = await call(ctx, "20261021-045", body({ suitcaseQty: 3, staffPrepaidOverrideAmount: null }, {}, { ...base, suitcaseQty: 2, updatedAt: row(ctx.sqlite, "20261021-045").updated_at }));
  assert.equal(clear.status, 200);
  assert.deepEqual([priced(ctx.sqlite, "20261021-045").override, priced(ctx.sqlite, "20261021-045").final], [null, 4800]);
});

test("8. only payment-pending orders: PAID, PICKED_UP and CANCELLED are refused and untouched; payment ledger is never read or written", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  for (const [index, status] of ["PAID", "PICKED_UP", "CANCELLED"].entries()) {
    const id = `20261021-05${index}`;
    seedOrder(ctx.sqlite, id, { status });
    ctx.sqlite.prepare("INSERT INTO luggage_order_payments (order_id, business_date, tender_type, amount) VALUES (?, '2026-10-21', 'CASH', 1600)").run(id);
    const before = row(ctx.sqlite, id);
    const res = await call(ctx, id, body({ suitcaseQty: 2, flyingPassTier: "BLUE" }));
    assert.deepEqual([res.status, res.json.code], [409, "STATUS_NOT_EDITABLE"], status);
    assert.deepEqual(row(ctx.sqlite, id), before);
    assert.deepEqual(ctx.sqlite.prepare("SELECT tender_type, amount FROM luggage_order_payments WHERE order_id = ?").all(id).map((r) => ({ ...r })), [{ tender_type: "CASH", amount: 1600 }]);
  }
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("9. invalid counts, amounts, tiers, reasons and injected fields are rejected before any write", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-060");
  const before = row(ctx.sqlite, "20261021-060");
  const bad: unknown[] = [
    body({}), body({ suitcaseQty: -1 }), body({ suitcaseQty: 100 }), body({ suitcaseQty: 1.5 }), body({ suitcaseQty: "2" }), body({ backpackQty: null }),
    body({ staffPrepaidOverrideAmount: -1 }), body({ staffPrepaidOverrideAmount: 500001 }), body({ staffPrepaidOverrideAmount: 10.5 }), body({ staffPrepaidOverrideAmount: "100" }),
    body({ flyingPassTier: "blue" }), body({ flyingPassTier: "DIAMOND" }), body({ flyingPassTier: null }), body({ paymentMethod: "CARD" }),
    body({ prepaidAmount: 1 }), body({ status: "PAID" }), body({ pricePerDay: 1 }), body({ setQty: 9 }),
    body({ flyingPassTier: "BLUE" }, { reason: "" }), body({ flyingPassTier: "BLUE" }, { reason: "   " }), body({ flyingPassTier: "BLUE" }, { reason: "x".repeat(201) }), body({ flyingPassTier: "BLUE" }, { reason: 5 }),
    { ...body({ flyingPassTier: "BLUE" }), staffId: "attacker" }, { ...body({ flyingPassTier: "BLUE" }), requestId: "nope" },
    { ...body({ flyingPassTier: "BLUE" }), expected: { updatedAt: UPDATED_AT } },
    { ...body({ flyingPassTier: "BLUE" }), actor: { ...actor, role: "viewer" } }, { ...body({ flyingPassTier: "BLUE" }), actor: { ...actor, staffId: "x" } },
    { ...body({ flyingPassTier: "BLUE" }), changes: null }, [],
  ];
  for (const payload of bad) assert.equal((await call(ctx, "20261021-060", payload)).status, 400, JSON.stringify(payload));
  assert.equal((await call(ctx, "20261021-060", null, { raw: "{not json" })).status, 400);
  assert.equal((await call(ctx, "not-an-order", body({ flyingPassTier: "BLUE" }))).status, 400);
  assert.deepEqual([(await call(ctx, "20261021-099", body({ flyingPassTier: "BLUE" }))).status], [404]);
  // an order cannot end up empty
  seedOrder(ctx.sqlite, "20261021-061");
  const empty = await call(ctx, "20261021-061", body({ suitcaseQty: 0 }));
  assert.deepEqual([empty.status, empty.json.code], [409, "EMPTY_ORDER"]);
  assert.deepEqual(row(ctx.sqlite, "20261021-060"), before);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("counts do not change on extension orders, orders with extensions, or free (price 0) orders; tier still can", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-070");
  seedOrder(ctx.sqlite, "EXT-20261021-071", { parent: "20261021-070", days: 1, status: "PAYMENT_PENDING" });
  seedOrder(ctx.sqlite, "20261021-072", { pricePerDay: 0, prepaid: 0, final: 0 });
  const parent = await call(ctx, "20261021-070", body({ suitcaseQty: 2 }));
  assert.deepEqual([parent.status, parent.json.code], [409, "HAS_EXTENSIONS"]);
  const ext = await call(ctx, "EXT-20261021-071", body({ suitcaseQty: 2 }, {}, { prepaidAmount: 800 }));
  assert.deepEqual([ext.status, ext.json.code], [409, "IS_EXTENSION"]);
  const free = await call(ctx, "20261021-072", body({ suitcaseQty: 2 }, {}, { prepaidAmount: 0 }));
  assert.deepEqual([free.status, free.json.code], [409, "FREE_ORDER"]);
  assert.deepEqual([priced(ctx.sqlite, "20261021-070").suitcase, priced(ctx.sqlite, "EXT-20261021-071").suitcase, priced(ctx.sqlite, "20261021-072").suitcase], [1, 1, 1]);
  assert.equal((await call(ctx, "20261021-070", body({ flyingPassTier: "BLUE" }))).status, 200);
});

test("11. stale screen (time or same-second value drift) is refused; a concurrent writer between read and write is not overwritten", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-080");
  seedOrder(ctx.sqlite, "20261021-081");
  seedOrder(ctx.sqlite, "20261021-082");
  const staleTime = await call(ctx, "20261021-080", body({ flyingPassTier: "BLUE" }, {}, { updatedAt: "2026-10-21 00:59:59" }));
  assert.deepEqual([staleTime.status, staleTime.json.code], [409, "STALE"]);
  const staleQty = await call(ctx, "20261021-080", body({ flyingPassTier: "BLUE" }, {}, { suitcaseQty: 5 }));
  assert.deepEqual([staleQty.status, staleQty.json.code], [409, "STALE"]);
  const staleTier = await call(ctx, "20261021-080", body({ suitcaseQty: 2 }, {}, { flyingPassTier: "GOLD" }));
  assert.deepEqual([staleTier.status, staleTier.json.code], [409, "STALE"]);
  assert.equal(priced(ctx.sqlite, "20261021-080").tier, "NONE");

  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET prepaid_amount = 1700, final_amount = 1700, updated_at = '2026-10-21 01:00:05' WHERE order_id = '20261021-081'").run();
    return realBatch(statements);
  };
  const bumped = await call(ctx, "20261021-081", body({ flyingPassTier: "BLUE" }));
  assert.deepEqual([bumped.status, bumped.json.code], [409, "STALE"]);
  assert.equal(row(ctx.sqlite, "20261021-081").prepaid_amount, 1700);
  // same-second race: values change but updated_at is identical
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET suitcase_qty = 4 WHERE order_id = '20261021-082'").run();
    return realBatch(statements);
  };
  const sameSecond = await call(ctx, "20261021-082", body({ flyingPassTier: "BLUE" }));
  assert.deepEqual([sameSecond.status, sameSecond.json.code], [409, "STALE"]);
  assert.equal(row(ctx.sqlite, "20261021-082").suitcase_qty, 4);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("payment or extension recorded between read and write blocks the update", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-085");
  seedOrder(ctx.sqlite, "20261021-086");
  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_orders SET status = 'PAID' WHERE order_id = '20261021-085'").run(); // same second: only the status predicate can stop it
    return realBatch(statements);
  };
  const paid = await call(ctx, "20261021-085", body({ suitcaseQty: 2 }));
  assert.deepEqual([paid.status, paid.json.code], [409, "STALE"]);
  assert.equal(priced(ctx.sqlite, "20261021-085").suitcase, 1);
  ctx.env.DB.batch = async (statements) => {
    seedOrder(ctx.sqlite, "EXT-20261021-087", { parent: "20261021-086", days: 1 }); // extension appears, parent updated_at untouched
    return realBatch(statements);
  };
  const ext = await call(ctx, "20261021-086", body({ suitcaseQty: 2 }));
  assert.deepEqual([ext.status, ext.json.code], [409, "STALE"]);
  assert.equal(priced(ctx.sqlite, "20261021-086").suitcase, 1);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("replaying a requestId neither writes twice nor duplicates the audit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-090");
  const first = body({ flyingPassTier: "SILVER" });
  assert.equal((await call(ctx, "20261021-090", first)).status, 200);
  const replay = await call(ctx, "20261021-090", first);
  assert.deepEqual([replay.status, replay.json.code], [409, "DUPLICATE_REQUEST"]);
  assert.equal(audits(ctx.sqlite).length, 1);
});

test("unchanged request is a no-op without write or audit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-095");
  const res = await call(ctx, "20261021-095", body({ flyingPassTier: "NONE", suitcaseQty: 1, paymentMethod: "CASH" }));
  assert.equal(res.status, 200);
  assert.equal(res.json.changed, false);
  assert.equal(row(ctx.sqlite, "20261021-095").updated_at, UPDATED_AT);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("12. audit failure rolls back every field (counts, price, tier) — no partial save", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-100");
  const before = row(ctx.sqlite, "20261021-100");
  ctx.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_audit_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  assert.equal((await call(ctx, "20261021-100", body({ suitcaseQty: 3, flyingPassTier: "BLUE" }))).status, 500);
  assert.deepEqual(row(ctx.sqlite, "20261021-100"), before);
  assert.equal(audits(ctx.sqlite).length, 0);
  ctx.sqlite.exec("DROP TRIGGER fail_audit");
  assert.equal((await call(ctx, "20261021-100", body({ suitcaseQty: 3, flyingPassTier: "BLUE" }))).status, 200);
});

test("only the pricing columns change: identity, status, tag, note, extra amount and pickup stay as they were", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-110");
  const before = row(ctx.sqlite, "20261021-110");
  assert.equal((await call(ctx, "20261021-110", body({ suitcaseQty: 2, backpackQty: 2, flyingPassTier: "GOLD", paymentMethod: "PAY_QR" }))).status, 200);
  const after = row(ctx.sqlite, "20261021-110");
  for (const key of ["order_id", "status", "name", "phone", "tag_no", "note", "parent_order_id", "expected_storage_days", "extra_amount"]) assert.equal(after[key], before[key], key);
  assert.equal(after.set_qty, Math.min(after.suitcase_qty, after.backpack_qty));
  assert.equal(after.price_per_day, 2400);
});

test("actor mapping fails closed and HMAC is required", async () => {
  const cases: Array<[Profile[] | "error", number]> = [
    [[], 403], [[{ ...EDITOR, is_active: false }], 403], [[{ ...EDITOR, role: "viewer" }], 403],
    [[EDITOR, { ...EDITOR, id: "33333333-3333-4333-8333-333333333333" }], 403], ["error", 503],
  ];
  for (const [profiles, status] of cases) {
    stubProfiles(profiles);
    const ctx = setup();
    seedOrder(ctx.sqlite, "20261021-120");
    const before = row(ctx.sqlite, "20261021-120");
    assert.equal((await call(ctx, "20261021-120", body({ flyingPassTier: "BLUE" }))).status, status, JSON.stringify(profiles));
    assert.deepEqual(row(ctx.sqlite, "20261021-120"), before);
    assert.equal(audits(ctx.sqlite).length, 0);
  }
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-121");
  assert.equal((await call(ctx, "20261021-121", body({ flyingPassTier: "BLUE" }), { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "20261021-121", body({ flyingPassTier: "BLUE" }), { secret: "wrong" })).status, 401);
  assert.equal(priced(ctx.sqlite, "20261021-121").tier, "NONE");
});

test("legacy routes keep working unchanged: update-price still has no status restriction (regression, not copied)", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx.sqlite, "20261021-130", { status: "PAID" });
  const legacy = await ctx.app.request("https://luggage.test/staff/api/orders/20261021-130/update-price", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ flying_pass_tier: "BLUE", payment_method: "CASH" }),
  }, ctx.env);
  assert.equal(legacy.status, 200);
  assert.equal(priced(ctx.sqlite, "20261021-130").final, 1400);
});
