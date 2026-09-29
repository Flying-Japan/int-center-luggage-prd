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

async function call(ctx: ReturnType<typeof setup>, method: string, path: string, body?: unknown, options: { unsigned?: boolean; secret?: string } = {}) {
  const url = `https://luggage.test${path}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: options.secret ?? SECRET, method, url, timestamp, body: raw });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) {
    headers["x-internal-timestamp"] = timestamp;
    headers["x-internal-signature"] = signature;
  }
  const response = await ctx.app.request(url, { method, headers, body: raw || undefined }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

const actor = { userId: "unified-user-1", name: "Unified Tester", email: "editor@example.test", role: "center_staff" };
let requestSeq = 0;
function createBody(overrides: Record<string, unknown> = {}) {
  requestSeq += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(requestSeq).padStart(12, "0")}`,
    itemName: "Synthetic umbrella",
    quantity: 1,
    foundLocation: "4F",
    foundAt: "2026-09-29T10:30",
    note: "fixture",
    actor,
    ...overrides,
  };
}

function snapshot(entry: Record<string, any>) {
  const { itemName, quantity, foundLocation, foundAt, status, claimedBy, note } = entry;
  return { itemName, quantity, foundLocation, foundAt, status, claimedBy, note };
}

function audits(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT order_id, staff_id, device_id, action, details FROM luggage_audit_logs ORDER BY log_id").all() as Array<Record<string, any>>;
}

test("create resolves the legacy staff by email and writes source row + audit atomically", async () => {
  stubProfiles([EDITOR, { ...EDITOR, id: "22222222-2222-4222-8222-222222222222", email: "other@example.test" }]);
  const ctx = setup();
  const body = createBody({ staffId: undefined });
  const res = await call(ctx, "POST", "/internal/luggage-lost-found", body);
  assert.equal(res.status, 201);
  assert.equal(res.json.entry.status, "UNCLAIMED");
  assert.equal(res.json.entry.registeredByStaffId, EDITOR.id);
  const row = ctx.sqlite.prepare("SELECT * FROM luggage_lost_found_entries").get() as Record<string, any>;
  assert.equal(row.staff_id, EDITOR.id);
  assert.equal(row.item_name, "Synthetic umbrella");
  const [log] = audits(ctx.sqlite);
  assert.equal(log.action, "UNIFIED_ADMIN_LOST_FOUND_CREATE");
  assert.equal(log.staff_id, EDITOR.id);
  assert.equal(log.device_id, "unified-admin");
  assert.equal(log.order_id, null);
  const details = JSON.parse(log.details);
  assert.equal(details.entryId, row.entry_id);
  assert.equal(details.after.entryId, row.entry_id);
  assert.deepEqual(details.actor, actor);
  assert.deepEqual(details.legacyStaff, { id: EDITOR.id, displayName: "Synthetic Editor", role: "editor" });
});

test("create rejects a caller-supplied staffId and duplicate requestId replays", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const injected = await call(ctx, "POST", "/internal/luggage-lost-found", { ...createBody(), staffId: "attacker" });
  assert.equal(injected.status, 400);
  const body = createBody();
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", body)).status, 201);
  const replay = await call(ctx, "POST", "/internal/luggage-lost-found", body);
  assert.equal(replay.status, 409);
  assert.equal((ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_lost_found_entries").get() as { n: number }).n, 1);
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
    const res = await call(ctx, "POST", "/internal/luggage-lost-found", createBody());
    assert.equal(res.status, status, JSON.stringify(profiles));
    assert.equal((ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_lost_found_entries").get() as { n: number }).n, 0);
    assert.equal(audits(ctx.sqlite).length, 0);
  }
  stubProfiles([{ ...EDITOR, role: "admin" }]);
  assert.equal((await call(setup(), "POST", "/internal/luggage-lost-found", createBody())).status, 201);
});

test("unified role and payload validation", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  for (const role of ["viewer", "office_staff"]) {
    assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody({ actor: { ...actor, role } }))).status, 400);
  }
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody({ itemName: " " }))).status, 400);
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody({ quantity: 0 }))).status, 400);
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody({ foundAt: "2026/09/29" }))).status, 400);
  assert.equal(audits(ctx.sqlite).length, 0);
});

test("HMAC authentication is required", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody(), { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody(), { secret: "wrong" })).status, 401);
  assert.equal((await call(ctx, "PATCH", "/internal/luggage-lost-found/1", {}, { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "DELETE", "/internal/luggage-lost-found/1", {}, { unsigned: true })).status, 401);
});

test("status transitions follow the staff screen and re-check the snapshot", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const { json } = await call(ctx, "POST", "/internal/luggage-lost-found", createBody());
  const id = json.entry.entryId;
  const expected = snapshot(json.entry);

  assert.equal((await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "claim", expected, actor })).status, 400);
  const claimed = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "claim", claimedBy: "Guest A", expected, actor });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.entry.status, "CLAIMED");
  assert.equal(claimed.json.entry.claimedBy, "Guest A");

  // Stale: the client still holds the UNCLAIMED snapshot.
  const stale = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "dispose", expected, actor });
  assert.equal(stale.status, 409);
  // Not allowed: CLAIMED cannot be claimed again.
  const again = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "claim", claimedBy: "B", expected: snapshot(claimed.json.entry), actor });
  assert.equal(again.status, 409);

  const returned = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "return", expected: snapshot(claimed.json.entry), actor });
  assert.equal(returned.status, 200);
  assert.equal(returned.json.entry.status, "RETURNED");
  assert.equal(returned.json.entry.claimedBy, "Guest A");
  const terminal = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "dispose", expected: snapshot(returned.json.entry), actor });
  assert.equal(terminal.status, 409);

  const updateLogs = audits(ctx.sqlite).filter((log) => log.action === "UNIFIED_ADMIN_LOST_FOUND_UPDATE");
  assert.equal(updateLogs.length, 2);
  const details = JSON.parse(updateLogs[0].details);
  assert.equal(details.before.status, "UNCLAIMED");
  assert.equal(details.after.status, "CLAIMED");
  assert.equal(details.actor.email, actor.email);
  assert.equal(updateLogs[0].staff_id, EDITOR.id);
  assert.equal((await call(ctx, "PATCH", "/internal/luggage-lost-found/9999", { action: "dispose", expected, actor })).status, 404);
});

test("a concurrent staff-screen edit between read and write is not overwritten", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const { json } = await call(ctx, "POST", "/internal/luggage-lost-found", createBody());
  const id = json.entry.entryId;
  // Simulate the legacy staff route changing the note right before the guarded UPDATE runs.
  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_lost_found_entries SET note = 'changed by staff' WHERE entry_id = ?").run(id);
    return realBatch(statements);
  };
  const res = await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "dispose", expected: snapshot(json.entry), actor });
  assert.equal(res.status, 409);
  const row = ctx.sqlite.prepare("SELECT status, note FROM luggage_lost_found_entries WHERE entry_id = ?").get(id) as Record<string, any>;
  assert.deepEqual({ ...row }, { status: "UNCLAIMED", note: "changed by staff" });
  assert.equal(audits(ctx.sqlite).filter((log) => log.action === "UNIFIED_ADMIN_LOST_FOUND_UPDATE").length, 0);
});

test("delete keeps the removed row in the audit log and honors the stale guard", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const { json } = await call(ctx, "POST", "/internal/luggage-lost-found", createBody());
  const id = json.entry.entryId;
  const staleExpected = { ...snapshot(json.entry), note: "old" };
  assert.equal((await call(ctx, "DELETE", `/internal/luggage-lost-found/${id}`, { expected: staleExpected, actor })).status, 409);
  const res = await call(ctx, "DELETE", `/internal/luggage-lost-found/${id}`, { expected: snapshot(json.entry), actor });
  assert.equal(res.status, 200);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_lost_found_entries").get()!.n, 0);
  const log = audits(ctx.sqlite).find((entry) => entry.action === "UNIFIED_ADMIN_LOST_FOUND_DELETE")!;
  const details = JSON.parse(log.details);
  assert.equal(details.before.itemName, "Synthetic umbrella");
  assert.equal(details.before.registeredByStaffId, EDITOR.id);
  assert.equal(details.after, null);
  assert.equal((await call(ctx, "DELETE", `/internal/luggage-lost-found/${id}`, { expected: snapshot(json.entry), actor })).status, 404);
});

test("audit failure rolls back the source mutation", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const { json } = await call(ctx, "POST", "/internal/luggage-lost-found", createBody());
  const id = json.entry.entryId;
  ctx.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_audit_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);

  assert.equal((await call(ctx, "POST", "/internal/luggage-lost-found", createBody())).status, 500);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_lost_found_entries").get()!.n, 1);

  assert.equal((await call(ctx, "PATCH", `/internal/luggage-lost-found/${id}`, { action: "dispose", expected: snapshot(json.entry), actor })).status, 500);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM luggage_lost_found_entries WHERE entry_id = ?").get(id)!.status, "UNCLAIMED");

  assert.equal((await call(ctx, "DELETE", `/internal/luggage-lost-found/${id}`, { expected: snapshot(json.entry), actor })).status, 500);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_lost_found_entries").get()!.n, 1);
  assert.equal(audits(ctx.sqlite).length, 1);
});
