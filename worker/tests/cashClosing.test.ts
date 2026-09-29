import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import ops from "../src/routes/operations";
import { signInternalRequest } from "../src/lib/hmac";
import { formatDateJST } from "../src/services/storage";

const SECRET = "reviewer-test-key";
const originalFetch = globalThis.fetch;
const TODAY = formatDateJST(new Date());
const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1];

type Profile = { id: string; display_name: string | null; username: string | null; email: string | null; role: string; is_active: boolean };
const EDITOR: Profile = { id: "11111111-1111-4111-8111-111111111111", display_name: "정산직원", username: "closer", email: "closer@example.test", role: "editor", is_active: true };

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
  // Production D1 has these columns via ALTER (verified read-only); schema.sql predates them.
  sqlite.exec("ALTER TABLE luggage_cash_closings ADD COLUMN rental_cash INTEGER DEFAULT 0; ALTER TABLE luggage_cash_closings ADD COLUMN wand_refund INTEGER DEFAULT 0;");
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async run() {
        const rows = sqlite.prepare(sql).all(...(args as never[]));
        const { c } = sqlite.prepare("SELECT changes() AS c").get() as { c: number };
        return { results: rows, meta: { changes: c, last_row_id: 0 } };
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
  const app = new Hono().route("/", internalApi).route("/", ops);
  const env = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test", DEV_STAFF_AUTH_BYPASS: "1" };
  return { app, env, sqlite };
}

async function call(ctx: ReturnType<typeof setup>, method: string, path: string, body?: unknown, options: { unsigned?: boolean } = {}) {
  const url = `https://luggage.test${path}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method, url, timestamp, body: raw });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) { headers["x-internal-timestamp"] = timestamp; headers["x-internal-signature"] = signature; }
  const response = await ctx.app.request(url, { method, headers, body: raw || undefined }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

// The unchanged staff HTML routes, driven with the same inputs, are the parity oracle.
async function staffForm(ctx: ReturnType<typeof setup>, path: string, fields: Record<string, string | number>) {
  const body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]));
  const response = await ctx.app.request(`https://luggage.test${path}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }, ctx.env);
  assert.ok(response.status === 302 || response.status === 200, `staff route ${path} -> ${response.status}`);
}

const actor = { userId: "unified-closer", name: "Unified Closer", email: "CLOSER@example.test", role: "manager" };
let seq = 0;
const nextRequestId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
type Inputs = { counts: number[]; paypayAmount: number; actualQrAmount: number; rentalCash: number; wandRefund: number; floor4fCount: number; floor8fCount: number; note: string | null };
const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({ counts: [3, 1, 0, 12, 4, 7, 2, 9, 1, 3], paypayAmount: 8800, actualQrAmount: 9100, rentalCash: 3000, wandRefund: 500, floor4fCount: 6, floor8fCount: 2, note: "합산 확인", ...overrides });
const apiBody = (i: Inputs) => ({ counts: Object.fromEntries(DENOMS.map((d, index) => [String(d), i.counts[index]])), paypayAmount: i.paypayAmount, actualQrAmount: i.actualQrAmount, rentalCash: i.rentalCash, wandRefund: i.wandRefund, floor4fCount: i.floor4fCount, floor8fCount: i.floor8fCount, note: i.note });
const formBody = (i: Inputs) => ({ ...Object.fromEntries(DENOMS.map((d, index) => [`count_${d}`, i.counts[index]])), paypay_amount: i.paypayAmount, actual_qr_amount: i.actualQrAmount, rental_cash: i.rentalCash, wand_refund: i.wandRefund, floor_4f_count: i.floor4fCount, floor_8f_count: i.floor8fCount, note: i.note ?? "" });
const createBody = (closingType = "FINAL_CLOSE", i = inputs(), extra: Record<string, unknown> = {}) => ({ requestId: nextRequestId(), closingType, ...apiBody(i), actor, ...extra });

const STORED = `business_date, closing_type, workflow_status, ${DENOMS.map((d) => `count_${d}`).join(", ")}, total_amount, paypay_amount, actual_qr_amount,
  qr_difference_amount, check_auto_amount, expected_amount, actual_amount, difference_amount, rental_cash, wand_refund, floor_4f_count, floor_8f_count, note`;
const storedRow = (ctx: ReturnType<typeof setup>, type = "FINAL_CLOSE") => ({ ...(ctx.sqlite.prepare(`SELECT ${STORED} FROM luggage_cash_closings WHERE closing_type = ?`).get(type) as Record<string, unknown>) });
const audits = (ctx: ReturnType<typeof setup>) => ctx.sqlite.prepare("SELECT closing_id, action, reason, payload, staff_id FROM luggage_cash_closing_audits ORDER BY audit_id").all() as Array<Record<string, any>>;
const closingCount = (ctx: ReturnType<typeof setup>) => (ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_cash_closings").get() as { n: number }).n;

function seedDailySales(ctx: ReturnType<typeof setup>, cash: number, qr: number, total: number) {
  ctx.sqlite.prepare("INSERT INTO luggage_daily_sales (sale_date, cash, qr, luggage_total) VALUES (?, ?, ?, ?)").run(TODAY, cash, qr, total);
}
function seedLiveOrder(ctx: ReturnType<typeof setup>, id: string, method: string, finalAmount: number) {
  ctx.sqlite.prepare("INSERT INTO luggage_orders (order_id, status, payment_method, final_amount, prepaid_amount) VALUES (?, 'PAID', ?, ?, ?)").run(id, method, finalAmount, finalAmount);
}

async function editSnapshot(ctx: ReturnType<typeof setup>, closingId: number) {
  const res = await call(ctx, "GET", `/internal/luggage-cash-closings/${closingId}/edit-snapshot`);
  assert.equal(res.status, 200);
  return res.json;
}

test("create stores exactly what the staff route stores (daily sales, live orders, PayPay fallback, no sales)", async () => {
  const scenarios: Array<[string, (ctx: ReturnType<typeof setup>) => void, Partial<Inputs>]> = [
    ["daily sales snapshot", (ctx) => seedDailySales(ctx, 41000, 12000, 53000), {}],
    ["live orders snapshot", (ctx) => { seedLiveOrder(ctx, "20260929-001", "CASH", 4500); seedLiveOrder(ctx, "20260929-002", "PAY_QR", 3300); }, {}],
    ["PayPay fallback (actual QR 0)", (ctx) => seedDailySales(ctx, 1000, 2000, 3000), { actualQrAmount: 0 }],
    ["no auto sales", () => {}, { paypayAmount: 0, actualQrAmount: 0 }],
  ];
  for (const [label, seed, overrides] of scenarios) {
    stubProfiles([EDITOR]);
    const legacy = setup();
    const unified = setup();
    seed(legacy); seed(unified);
    const i = inputs(overrides);
    await staffForm(legacy, "/staff/cash-closing", { closing_type: "FINAL_CLOSE", ...formBody(i) });
    const res = await call(unified, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE", i));
    assert.equal(res.status, 201, label);
    assert.deepEqual(storedRow(unified), storedRow(legacy), label);
    const row = storedRow(unified);
    assert.equal(row.business_date, TODAY, label);
    assert.equal(row.workflow_status, "SUBMITTED", label);
    if (label.startsWith("PayPay")) assert.equal(row.actual_qr_amount, i.paypayAmount);
  }
});

test("create records the resolved legacy staff and a SUBMIT audit with actor and calculation snapshot", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedDailySales(ctx, 41000, 12000, 53000);
  const res = await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("MORNING_HANDOVER"));
  assert.equal(res.status, 201);
  const row = ctx.sqlite.prepare("SELECT closing_id, staff_id, submitted_by_staff_id, owner_name FROM luggage_cash_closings").get() as Record<string, any>;
  assert.equal(row.staff_id, EDITOR.id);
  assert.equal(row.submitted_by_staff_id, null); // the staff route does not set it either
  assert.equal(row.owner_name, null);
  const [audit] = audits(ctx);
  assert.equal(audit.action, "SUBMIT");
  assert.equal(audit.closing_id, row.closing_id);
  assert.equal(audit.staff_id, EDITOR.id);
  const payload = JSON.parse(audit.payload);
  assert.equal(payload.closingId, row.closing_id);
  assert.deepEqual(payload.actor, actor);
  assert.equal(payload.legacyStaff.id, EDITOR.id);
  assert.deepEqual(payload.autoSalesSnapshot, { cashAmount: 41000, qrAmount: 12000, totalAmount: 53000, orderCount: 0, source: "daily_sales" });
  assert.equal(payload.after.expectedAmount, 53000);
  assert.equal(res.json.closing.expectedAmount, 53000);
});

test("duplicates: pre-check, request replay and the UNIQUE index all answer 409 without a second audit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const body = createBody("FINAL_CLOSE");
  assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", body)).status, 201);
  const replay = await call(ctx, "POST", "/internal/luggage-cash-closings", body);
  assert.equal(replay.status, 409);
  assert.equal(replay.json.code, "DUPLICATE_CLOSING");
  assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"))).json.code, "DUPLICATE_CLOSING");
  assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("MORNING_HANDOVER"))).status, 201);

  // Race: another request inserts the same date/type after our pre-check; the UNIQUE index decides.
  const race = setup();
  const realBatch = race.env.DB.batch;
  race.env.DB.batch = async (statements) => {
    race.sqlite.prepare("INSERT INTO luggage_cash_closings (business_date, closing_type, workflow_status) VALUES (?, 'FINAL_CLOSE', 'SUBMITTED')").run(TODAY);
    return realBatch(statements);
  };
  const raced = await call(race, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"));
  assert.equal(raced.status, 409);
  assert.equal(raced.json.code, "DUPLICATE_CLOSING");
  assert.equal(closingCount(race), 1);
  assert.equal(audits(race).length, 0);
  assert.equal(closingCount(ctx), 2);
  assert.equal(audits(ctx).length, 2);
});

test("server-calculated fields, dates, statuses and staff ids cannot be injected", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  for (const extra of [{ expectedAmount: 0 }, { differenceAmount: 0 }, { qrDifferenceAmount: 0 }, { checkAutoAmount: 0 }, { totalAmount: 1 }, { businessDate: "2026-01-01" }, { workflowStatus: "DRAFT" }, { staffId: EDITOR.id }]) {
    assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE", inputs(), extra))).status, 400, JSON.stringify(extra));
  }
  const bad = [
    createBody("EVENING"),
    { ...createBody(), counts: { ...apiBody(inputs()).counts, 20000: 1 } },
    { ...createBody(), counts: { 10000: 1 } },
    { ...createBody(), paypayAmount: -1 },
    { ...createBody(), floor4fCount: 1.5 },
    { ...createBody(), actor: { ...actor, role: "viewer" } },
    { ...createBody(), actor: { ...actor, role: "office_staff" } },
  ];
  for (const body of bad) assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", body)).status, 400);
  assert.equal(closingCount(ctx), 0);
});

test("actor mapping fails closed and HMAC is required", async () => {
  const cases: Array<[Profile[] | "error", number]> = [
    [[], 403], [[{ ...EDITOR, is_active: false }], 403], [[{ ...EDITOR, role: "viewer" }], 403],
    [[EDITOR, { ...EDITOR, id: "22222222-2222-4222-8222-222222222222" }], 403], ["error", 503],
  ];
  for (const [profiles, status] of cases) {
    stubProfiles([EDITOR]);
    const ctx = setup();
    const created = await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("MORNING_HANDOVER"));
    const snap = await editSnapshot(ctx, created.json.closing.closingId);
    stubProfiles(profiles);
    assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"))).status, status);
    assert.equal((await call(ctx, "PATCH", `/internal/luggage-cash-closings/${snap.snapshot.closingId}`, { ...apiBody(inputs({ paypayAmount: 1 })), expected: snap.snapshot, actor })).status, status);
    assert.equal(closingCount(ctx), 1);
    assert.equal(audits(ctx).length, 1);
    assert.deepEqual((await editSnapshot(ctx, snap.snapshot.closingId)).snapshot, snap.snapshot);
  }
  stubProfiles([EDITOR]);
  const ctx = setup();
  for (const [method, path] of [["POST", "/internal/luggage-cash-closings"], ["PATCH", "/internal/luggage-cash-closings/1"], ["GET", "/internal/luggage-cash-closing-draft"], ["GET", "/internal/luggage-cash-closings/1/edit-snapshot"]]) {
    assert.equal((await call(ctx, method, path, method === "GET" ? undefined : {}, { unsigned: true })).status, 401, `${method} ${path}`);
  }
});

test("edit stores exactly what the staff edit route stores and keeps the creation-time snapshot", async () => {
  const editScenarios: Array<[string, Partial<Inputs>, Partial<Inputs>]> = [
    ["QR entered", {}, { counts: [2, 2, 1, 10, 4, 7, 2, 9, 1, 3], actualQrAmount: 9900, paypayAmount: 8800, note: "재집계" }],
    ["PayPay fallback on edit", {}, { actualQrAmount: 0, paypayAmount: 7700 }],
    ["created with fallback, edited with QR", { actualQrAmount: 0 }, { actualQrAmount: 12000 }],
  ];
  for (const [label, createOverrides, editOverrides] of editScenarios) {
    stubProfiles([EDITOR]);
    const legacy = setup();
    const unified = setup();
    for (const ctx of [legacy, unified]) seedDailySales(ctx, 41000, 12000, 53000);
    await staffForm(legacy, "/staff/cash-closing", { closing_type: "FINAL_CLOSE", ...formBody(inputs(createOverrides)) });
    const created = await call(unified, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE", inputs(createOverrides)));
    // Current sales move after creation; the edit must not pick them up.
    for (const ctx of [legacy, unified]) ctx.sqlite.prepare("UPDATE luggage_daily_sales SET luggage_total = 99999, qr = 77777 WHERE sale_date = ?").run(TODAY);
    const legacyId = (legacy.sqlite.prepare("SELECT closing_id FROM luggage_cash_closings").get() as { closing_id: number }).closing_id;
    await staffForm(legacy, `/staff/cash-closing/${legacyId}/edit`, formBody(inputs(editOverrides)));
    const snap = await editSnapshot(unified, created.json.closing.closingId);
    const res = await call(unified, "PATCH", `/internal/luggage-cash-closings/${snap.snapshot.closingId}`, { ...apiBody(inputs(editOverrides)), expected: snap.snapshot, actor });
    assert.equal(res.status, 200, label);
    assert.deepEqual(storedRow(unified), storedRow(legacy), label);
    assert.equal(storedRow(unified).expected_amount, 53000, label);
    assert.equal(storedRow(unified).check_auto_amount, 53000, label);
  }
});

test("edit writes an EDIT audit with before/after and preserved snapshot", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedDailySales(ctx, 41000, 12000, 53000);
  const created = await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"));
  const snap = await editSnapshot(ctx, created.json.closing.closingId);
  assert.equal(snap.editable, true);
  assert.equal(snap.expectedQrAmount, 12000);
  const res = await call(ctx, "PATCH", `/internal/luggage-cash-closings/${snap.snapshot.closingId}`, { ...apiBody(inputs({ note: "수정" })), expected: snap.snapshot, actor });
  assert.equal(res.status, 200);
  const audit = audits(ctx).find((row) => row.action === "EDIT")!;
  assert.equal(audit.closing_id, snap.snapshot.closingId);
  assert.equal(audit.staff_id, EDITOR.id);
  const payload = JSON.parse(audit.payload);
  assert.equal(payload.before.note, "합산 확인");
  assert.equal(payload.after.note, "수정");
  assert.deepEqual(payload.preservedSnapshot, { checkAutoAmount: 53000, expectedAmount: 53000 });
  assert.equal(payload.actor.email, actor.email);
  assert.equal((await call(ctx, "PATCH", "/internal/luggage-cash-closings/9999", { ...apiBody(inputs()), expected: snap.snapshot, actor })).status, 404);
});

test("edit stale guard: updated_at, stored values and same-second changes", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const created = await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"));
  const id = created.json.closing.closingId;
  const snap = (await editSnapshot(ctx, id)).snapshot;
  const patch = (expected: object) => call(ctx, "PATCH", `/internal/luggage-cash-closings/${id}`, { ...apiBody(inputs({ note: "mine" })), expected, actor });

  assert.equal((await patch({ ...snap, updatedAt: "2000-01-01 00:00:00" })).json.code, "STALE");
  assert.equal((await patch({ ...snap, paypayAmount: snap.paypayAmount + 1 })).json.code, "STALE");
  // Same-second edit by the staff screen: updated_at unchanged, a stored value changed.
  ctx.sqlite.prepare("UPDATE luggage_cash_closings SET count_1000 = count_1000 + 1 WHERE closing_id = ?").run(id);
  const sameSecond = await patch(snap);
  assert.equal(sameSecond.status, 409);
  assert.equal(sameSecond.json.code, "STALE");
  // Change slipping in between our read and the UPDATE: the WHERE re-check refuses it.
  const fresh = (await editSnapshot(ctx, id)).snapshot;
  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_cash_closings SET note = 'staff' WHERE closing_id = ?").run(id);
    return realBatch(statements);
  };
  assert.equal((await patch(fresh)).status, 409);
  ctx.env.DB.batch = realBatch;
  assert.equal(audits(ctx).filter((row) => row.action === "EDIT").length, 0);
  assert.equal((ctx.sqlite.prepare("SELECT note FROM luggage_cash_closings").get() as { note: string }).note, "staff");
  // Non-SUBMITTED closings stay read-only, as on the staff route.
  ctx.sqlite.prepare("UPDATE luggage_cash_closings SET workflow_status = 'VERIFIED' WHERE closing_id = ?").run(id);
  const locked = (await editSnapshot(ctx, id));
  assert.equal(locked.editable, false);
  assert.equal((await patch(locked.snapshot)).json.code, "NOT_EDITABLE");
});

test("auto-sales read failure refuses to create", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  ctx.sqlite.exec("DROP TABLE luggage_daily_sales");
  assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody())).status, 503);
  assert.equal((await call(ctx, "GET", "/internal/luggage-cash-closing-draft")).status, 503);
  assert.equal(closingCount(ctx), 0);
});

test("draft reports today, current auto sales and existing types", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedDailySales(ctx, 1, 2, 3);
  await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("MORNING_HANDOVER"));
  const draft = (await call(ctx, "GET", "/internal/luggage-cash-closing-draft")).json;
  assert.equal(draft.businessDate, TODAY);
  assert.equal(draft.startingFloat, 40000);
  assert.equal(draft.autoSales.totalAmount, 3);
  assert.equal(typeof draft.existing.MORNING_HANDOVER, "number");
  assert.equal(draft.existing.FINAL_CLOSE, null);
});

test("audit failure rolls back create and edit", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const created = await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("MORNING_HANDOVER"));
  const snap = (await editSnapshot(ctx, created.json.closing.closingId)).snapshot;
  ctx.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_cash_closing_audits BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
  assert.equal((await call(ctx, "POST", "/internal/luggage-cash-closings", createBody("FINAL_CLOSE"))).status, 500);
  assert.equal(closingCount(ctx), 1);
  assert.equal((await call(ctx, "PATCH", `/internal/luggage-cash-closings/${snap.closingId}`, { ...apiBody(inputs({ paypayAmount: 1, note: "x" })), expected: snap, actor })).status, 500);
  assert.deepEqual((await editSnapshot(ctx, snap.closingId)).snapshot, snap);
  assert.equal(audits(ctx).length, 1);
});
