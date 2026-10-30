import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import internalApi from "../src/routes/internalApi";
import { signInternalRequest } from "../src/lib/hmac";
import { resolveInternalActorStaff } from "../src/lib/internalActorStaff";
import { CASH_CLOSING_DENOMS } from "../src/services/cashClosingWrites";

const SECRET = "reviewer-test-key";
const originalFetch = globalThis.fetch;

type Profile = { id: string; display_name: string | null; username: string | null; email: string | null; role: string; is_active: boolean };
const EDITOR: Profile = { id: "11111111-1111-4111-8111-111111111111", display_name: "정직원", username: "editor", email: "editor@example.test", role: "editor", is_active: true };
const ADMIN: Profile = { id: "33333333-3333-4333-8333-333333333333", display_name: "관리자", username: "admin", email: "admin@example.test", role: "admin", is_active: true };
// A staff profile whose email equals an ERP part-time email: a part_time actor must never be mapped onto it.
const LOOKALIKE: Profile = { id: "44444444-4444-4444-8444-444444444444", display_name: "동명 직원", username: "lookalike", email: "pt-a@part-time.local", role: "admin", is_active: true };

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PT_A = `pt:${UID_A}`;
const PT_B = `pt:${UID_B}`;
const partTime = (uid: string, name: string, login: string, overrides: Record<string, unknown> = {}) =>
  ({ userId: uid, name, email: `${login}@part-time.local`, role: "part_time", ...overrides });
const actorA = partTime(UID_A, "알바A", "pt-a");
const actorB = partTime(UID_B, "알바B", "pt-b");
const staffActor = (profile: Profile) => ({ userId: `unified-${profile.username}`, name: `Unified ${profile.username}`, email: profile.email!, role: "center_staff" });

function stubProfiles(profiles: Profile[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://supabase.test/rest/v1/user_profiles")) throw new Error(`unexpected fetch ${url}`);
    const rows = url.includes("is_active=eq.true") ? profiles.filter((p) => p.is_active) : profiles;
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

afterEach(() => { globalThis.fetch = originalFetch; });

function setup(partTimeEnabled = true) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("src/schema.sql", "utf8"));
  // Same as tests/cashClosing.test.ts: production D1 has these columns via ALTER, schema.sql predates them (the cash closing INSERT needs them).
  sqlite.exec("ALTER TABLE luggage_cash_closings ADD COLUMN rental_cash INTEGER DEFAULT 0; ALTER TABLE luggage_cash_closings ADD COLUMN wand_refund INTEGER DEFAULT 0;");
  const statement = (sql: string) => {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
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
  const env: Record<string, unknown> = { DB: db, INTERNAL_API_SECRET: SECRET, SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-test-key", APP_ENV: "test" };
  if (partTimeEnabled) env.LUGGAGE_PART_TIME_ACTORS_ENABLED = "true";
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

let seq = 0;
const nextRequestId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const noteBody = (actor: object, overrides: Record<string, unknown> = {}) => ({ requestId: nextRequestId(), category: "HANDOVER", title: "교대 메모", content: "4F 락커 확인", isPinned: false, actor, ...overrides });
const expectedOf = (note: Record<string, any>) => ({ category: note.category, title: note.title, content: note.content, isPinned: note.isPinned, authorId: note.authorId });
const count = (ctx: ReturnType<typeof setup>, table: string) => (ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const audits = (ctx: ReturnType<typeof setup>, action: string) =>
  (ctx.sqlite.prepare("SELECT staff_id, details FROM luggage_audit_logs WHERE action = ? ORDER BY log_id").all(action) as Array<Record<string, any>>);

async function createNote(ctx: ReturnType<typeof setup>, actor: object) {
  const res = await call(ctx, "POST", "/internal/luggage-handovers", noteBody(actor));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.note as Record<string, any>;
}
const edit = (ctx: ReturnType<typeof setup>, note: Record<string, any>, actor: object, title = "수정 제목") =>
  call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "URGENT", title, content: "수정 본문", isPinned: true, expected: expectedOf(note), actor });
const remove = (ctx: ReturnType<typeof setup>, note: Record<string, any>, actor: object) =>
  call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected: { ...expectedOf(note), commentCount: 0 }, actor });

test("part_time actors are refused unless the flag is on (fail-closed default)", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup(false);
  const res = await call(ctx, "POST", "/internal/luggage-handovers", noteBody(actorA));
  assert.equal(res.status, 403);
  assert.equal(count(ctx, "luggage_handover_notes"), 0);
  assert.equal(count(ctx, "luggage_part_time_actors"), 0);
  // existing staff are not affected by the flag
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody(staffActor(EDITOR)))).status, 201);
});

test("flag OFF: a part_time role padded with whitespace is still refused by the gate (403) on staff-resolved and self-reported routes, and nothing is written", async () => {
  stubProfiles([EDITOR]);
  // Every route normalizes actor.role with String.trim(), so the gate must treat these as part_time too.
  const padded = [" part_time", "part_time ", "\tpart_time", "part_time\n", " \t part_time \r\n", "\u00a0part_time"];
  // Not the part_time role after trim: the routes reject them (400), so they can never act either.
  const notPartTime = ["PART_TIME", "Part_time", "part_time\u200b", "part\u200b_time"];
  // Only the exact string "true" turns the flag on.
  for (const flag of [undefined, "false", "TRUE", "1", "true "]) {
    const ctx = setup(false);
    if (flag !== undefined) ctx.env.LUGGAGE_PART_TIME_ACTORS_ENABLED = flag;
    seedOrder(ctx, "20261027-004", "PAID");
    seedOrder(ctx, "20261027-005", "PAYMENT_PENDING");
    const fingerprint = () => JSON.stringify([
      ["luggage_handover_notes", "luggage_audit_logs", "luggage_part_time_actors", "luggage_order_payments", "luggage_lost_found_entries"].map((table) => count(ctx, table)),
      ctx.sqlite.prepare("SELECT * FROM luggage_orders ORDER BY order_id").all(),
    ]);
    const before = fingerprint();
    const requests = (role: string) => {
      const actor = { ...actorA, role };
      const { email: _email, ...pickupActor } = actor; // the pickup actor carries no email
      return [
        ["handover create (staff-resolved)", () => call(ctx, "POST", "/internal/luggage-handovers", noteBody(actor))],
        ["order note (self-reported)", () => call(ctx, "PATCH", "/internal/luggage-orders/20261027-004/note", { note: "x", actor })],
        ["payment status (self-reported)", () => call(ctx, "PATCH", "/internal/luggage-orders/20261027-005/payment-status", { targetStatus: "PAID", payment: { cashAmount: 800, qrAmount: 0 }, actor })],
        ["pickup status (self-reported)", () => call(ctx, "PATCH", "/internal/luggage-orders/20261027-004/pickup-status", { action: "mark_picked_up", expectedUpdatedAt: UPDATED_AT, actor: pickupActor })],
      ] as const;
    };
    for (const role of padded) {
      for (const [label, run] of requests(role)) {
        const res = await run();
        assert.equal(res.status, 403, `flag ${String(flag)}, role ${JSON.stringify(role)}, ${label}: ${JSON.stringify(res.json)}`);
        assert.equal(res.json.error, "Part-time actors are not enabled");
      }
    }
    for (const role of notPartTime) {
      for (const [label, run] of requests(role)) {
        const res = await run();
        assert.ok(res.status === 400 || res.status === 403, `flag ${String(flag)}, role ${JSON.stringify(role)}, ${label}: status ${res.status}`);
      }
    }
    assert.equal(fingerprint(), before, `flag ${String(flag)}: refused requests wrote nothing`);
  }

  // existing staff are unaffected by the flag
  const off = setup(false);
  assert.equal((await call(off, "POST", "/internal/luggage-handovers", noteBody(staffActor(EDITOR)))).status, 201);
});

test("part-timers A and B write as separate pt:<uid> workers with an audit that records uid, name and auth source", async () => {
  stubProfiles([EDITOR, LOOKALIKE]);
  const ctx = setup();
  const noteA = await createNote(ctx, actorA);
  const noteB = await createNote(ctx, actorB);
  assert.equal(noteA.authorId, PT_A); // not the editor/admin profile that shares the email
  assert.equal(noteB.authorId, PT_B);
  const [logA] = audits(ctx, "UNIFIED_ADMIN_HANDOVER_CREATE");
  assert.equal(logA.staff_id, PT_A);
  const details = JSON.parse(logA.details);
  assert.deepEqual(details.actor, actorA);
  assert.equal(details.authSource, "part_time_auth");
  assert.deepEqual(details.legacyStaff, { id: PT_A, displayName: "알바A", role: "part_time" });
  const names = ctx.sqlite.prepare("SELECT actor_id, display_name FROM luggage_part_time_actors ORDER BY actor_id").all().map((r) => ({ ...r }));
  assert.deepEqual(names, [{ actor_id: PT_A, display_name: "알바A" }, { actor_id: PT_B, display_name: "알바B" }]);

  const list = await call(ctx, "GET", "/internal/luggage-handovers");
  const byId = new Map((list.json.notes as Array<Record<string, any>>).map((n) => [n.authorId, n.authorName]));
  assert.equal(byId.get(PT_A), "알바A");
  assert.equal(byId.get(PT_B), "알바B");
  assert.ok((list.json.authors as Array<Record<string, any>>).some((a) => a.staffId === PT_A && a.staffName === "알바A"));
});

test("own notes can be edited and deleted; other part-timers and staff cannot touch them, and part-timers get no admin power", async () => {
  stubProfiles([EDITOR, ADMIN]);
  const ctx = setup();
  const noteA = await createNote(ctx, actorA);
  for (const intruder of [actorB, staffActor(EDITOR)]) {
    const denied = await edit(ctx, noteA, intruder);
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, "NOT_AUTHOR");
    assert.equal((await remove(ctx, noteA, intruder)).status, 403);
  }
  assert.equal(count(ctx, "luggage_handover_notes"), 1);

  // a part-timer cannot edit or delete a staff note (no legacy admin rights)
  const staffNote = await createNote(ctx, staffActor(EDITOR));
  assert.equal((await edit(ctx, staffNote, actorA)).status, 403);
  assert.equal((await remove(ctx, staffNote, actorA)).status, 403);

  const edited = await edit(ctx, noteA, actorA);
  assert.equal(edited.status, 200, JSON.stringify(edited.json));
  assert.equal(edited.json.note.authorId, PT_A);
  const edits = ctx.sqlite.prepare("SELECT staff_id FROM luggage_handover_edits").all().map((r) => ({ ...r }));
  assert.deepEqual(edits, [{ staff_id: PT_A }]);
  // existing behaviour kept: a legacy admin may still edit (not delete) someone else's note
  assert.equal((await edit(ctx, edited.json.note, staffActor(ADMIN), "관리자 수정")).status, 200);

  const current = (await call(ctx, "GET", "/internal/luggage-handovers")).json.notes.find((n: Record<string, any>) => n.noteId === noteA.noteId);
  const deleted = await remove(ctx, current, actorA);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  assert.equal(count(ctx, "luggage_handover_notes"), 1); // only the staff note is left
});

test("read marks and comments are recorded per part-timer and shown with their names", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const note = await createNote(ctx, staffActor(EDITOR));
  const read = await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: actorA });
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.staffId, PT_A);
  assert.equal(read.json.changed, true);
  assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: actorA })).json.changed, false);
  const comment = await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, { requestId: nextRequestId(), content: "확인했습니다", actor: actorB });
  assert.equal(comment.status, 201, JSON.stringify(comment.json));
  assert.equal(comment.json.comment.staffId, PT_B);

  const listed = (await call(ctx, "GET", "/internal/luggage-handovers")).json.notes[0];
  assert.deepEqual(listed.readers.map((r: Record<string, any>) => [r.staffId, r.staffName]), [[PT_A, "알바A"]]);
  assert.deepEqual(listed.comments.map((r: Record<string, any>) => [r.staffId, r.staffName]), [[PT_B, "알바B"]]);
});

test("the part-time display name follows the latest write and unknown ids never leak the uid", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  await createNote(ctx, actorA);
  await createNote(ctx, { ...actorA, name: "알바A 개명" });
  assert.equal(count(ctx, "luggage_part_time_actors"), 1);
  const [first, second] = (await call(ctx, "GET", "/internal/luggage-handovers")).json.notes as Array<Record<string, any>>;
  assert.equal(first.authorName, "알바A 개명");
  assert.equal(second.authorName, "알바A 개명");

  ctx.sqlite.exec("DELETE FROM luggage_part_time_actors");
  const nameless = (await call(ctx, "GET", "/internal/luggage-handovers")).json.notes[0];
  assert.equal(nameless.authorName, "아르바이트");
});

test("the name upsert commits atomically with the work", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  ctx.sqlite.exec("CREATE TRIGGER fail_part_time_name BEFORE INSERT ON luggage_part_time_actors BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const res = await call(ctx, "POST", "/internal/luggage-handovers", noteBody(actorA));
  assert.equal(res.status, 500);
  assert.equal(count(ctx, "luggage_handover_notes"), 0);
  assert.equal(audits(ctx, "UNIFIED_ADMIN_HANDOVER_CREATE").length, 0);
});

test("lost-and-found works for part-timers with their own worker id", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const res = await call(ctx, "POST", "/internal/luggage-lost-found", { requestId: nextRequestId(), itemName: "우산", quantity: 1, foundLocation: "4F", foundAt: "2026-10-27T10:30", note: "fixture", actor: actorA });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.equal(res.json.entry.registeredByStaffId, PT_A);
  assert.equal(audits(ctx, "UNIFIED_ADMIN_LOST_FOUND_CREATE")[0].staff_id, PT_A);
  assert.equal(count(ctx, "luggage_part_time_actors"), 1);
});

test("part_time actor shape errors are rejected before anything is written", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const bad = [
    partTime(UID_A.toUpperCase(), "알바A", "pt-a"), // upper-case UUID
    partTime("not-a-uuid", "알바A", "pt-a"),
    partTime("unified-editor", "알바A", "pt-a"),
    partTime(UID_A, "알바A", "pt-a", { email: "editor@example.test" }), // not a part-time.local identity
    { ...actorA, staffId: PT_A }, // caller-supplied worker id
    { ...actorA, authSource: "part_time_auth" }, // auth source is derived by the worker, never accepted
    { ...actorA, role: "viewer" },
  ];
  for (const actor of bad) {
    assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody(actor))).status, 400, JSON.stringify(actor));
  }
  assert.equal(count(ctx, "luggage_handover_notes"), 0);
  assert.equal(count(ctx, "luggage_part_time_actors"), 0);
});

test("HMAC authentication is still required for part_time requests", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  const body = noteBody(actorA);
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", body, { unsigned: true })).status, 401);
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", body, { secret: "wrong" })).status, 401);
  assert.equal(count(ctx, "luggage_handover_notes"), 0);
});

const UPDATED_AT = "2026-10-27 01:00:00";
function seedOrder(ctx: ReturnType<typeof setup>, orderId: string, status: string) {
  ctx.sqlite.prepare(
    `INSERT INTO luggage_orders (order_id, created_at, updated_at, name, phone, suitcase_qty, set_qty, price_per_day,
       prepaid_amount, final_amount, payment_method, status, tag_no, note, parent_order_id)
     VALUES (?, '2026-10-27 00:30:00', ?, 'Synthetic Guest', '000-0000', 1, 1, 800, 800, 800, 'CASH', ?, '12', 'fixture', NULL)`,
  ).run(orderId, UPDATED_AT, status);
}
const orderAudits = (ctx: ReturnType<typeof setup>, orderId: string) =>
  ctx.sqlite.prepare("SELECT staff_id, action, details FROM luggage_audit_logs WHERE order_id = ? ORDER BY log_id").all(orderId) as Array<Record<string, any>>;

test("part_time has center_staff's staff-resolved operations (cash closing, cancel, phone) and writes as pt:<uid> without a staff account", async () => {
  stubProfiles([]); // no Luggage staff account exists for the part-timer
  const ctx = setup();
  const counts = Object.fromEntries(CASH_CLOSING_DENOMS.map((d) => [String(d), 0]));
  const cash = await call(ctx, "POST", "/internal/luggage-cash-closings", {
    requestId: nextRequestId(), closingType: "FINAL_CLOSE", counts, paypayAmount: 0, actualQrAmount: 0, rentalCash: 0, wandRefund: 0, floor4fCount: 0, floor8fCount: 0, note: null, actor: actorA,
  });
  assert.equal(cash.status, 201, JSON.stringify(cash.json));
  assert.equal((ctx.sqlite.prepare("SELECT staff_id FROM luggage_cash_closings").get() as { staff_id: string }).staff_id, PT_A);
  const closingAudit = ctx.sqlite.prepare("SELECT staff_id, payload FROM luggage_cash_closing_audits").get() as { staff_id: string; payload: string };
  assert.equal(closingAudit.staff_id, PT_A);
  assert.equal(JSON.parse(closingAudit.payload).authSource, "part_time_auth");

  seedOrder(ctx, "20261027-001", "PAYMENT_PENDING");
  const phone = await call(ctx, "PATCH", "/internal/luggage-orders/20261027-001/phone", { requestId: nextRequestId(), phone: "080-9876-5432", expected: { phone: "000-0000", updatedAt: UPDATED_AT }, actor: actorA });
  assert.equal(phone.status, 200, JSON.stringify(phone.json));
  seedOrder(ctx, "20261027-002", "PAYMENT_PENDING");
  const cancel = await call(ctx, "POST", "/internal/luggage-orders/20261027-002/cancel", { requestId: nextRequestId(), expected: { status: "PAYMENT_PENDING", updatedAt: UPDATED_AT }, actor: actorA });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
  for (const orderId of ["20261027-001", "20261027-002"]) {
    const [log] = orderAudits(ctx, orderId);
    assert.equal(log.staff_id, PT_A);
    const details = JSON.parse(log.details);
    assert.deepEqual(details.actor, actorA);
    assert.equal(details.authSource, "part_time_auth");
  }
  assert.deepEqual(ctx.sqlite.prepare("SELECT actor_id, display_name FROM luggage_part_time_actors").all().map((r) => ({ ...r })), [{ actor_id: PT_A, display_name: "알바A" }]);

  // a staff-resolved call site that names no operation is still refused for part_time (fail closed); a listed one resolves to pt:<uid>
  const env = ctx.env as never;
  const actor = { ...actorA, role: "part_time" as const };
  for (const operation of [undefined, "order.unknown"]) {
    const resolved = await resolveInternalActorStaff(env, actor, operation);
    assert.equal(resolved.ok, false, String(operation));
    if (!resolved.ok) assert.equal(resolved.status, 403);
  }
  for (const operation of ["cashClosing.create", "cashClosing.update", "order.cancel", "order.phone", "order.pricing", "handover.create", "lostFound.create"]) {
    const resolved = await resolveInternalActorStaff(env, actor, operation);
    assert.equal(resolved.ok && resolved.staff.id, PT_A, operation);
  }
});

test("self-reported endpoints (order note etc.) accept part_time with the real actor in the audit, behind the flag and the uid shape check", async () => {
  stubProfiles([EDITOR]);
  const ctx = setup();
  seedOrder(ctx, "20261027-003", "PAID");
  const res = await call(ctx, "PATCH", "/internal/luggage-orders/20261027-003/note", { note: "메모", actor: actorA });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const [log] = orderAudits(ctx, "20261027-003");
  assert.equal(log.staff_id, null); // same as center_staff: the self-reported actor lives in the audit details
  assert.deepEqual(JSON.parse(log.details).actor, actorA);

  const before = count(ctx, "luggage_audit_logs");
  const off = setup(false);
  seedOrder(off, "20261027-003", "PAID");
  assert.equal((await call(off, "PATCH", "/internal/luggage-orders/20261027-003/note", { note: "x", actor: actorA })).status, 403);
  assert.equal((await call(off, "PATCH", "/internal/luggage-orders/20261027-003/note", { note: "x", actor: staffActor(EDITOR) })).status, 200); // staff do not need the flag
  for (const bad of [partTime(UID_A.toUpperCase(), "알바", "pt-a"), partTime("not-a-uuid", "알바", "pt-a"), partTime(UID_A, "알바", "pt-a", { email: "editor@example.test" })]) {
    assert.equal((await call(ctx, "PATCH", "/internal/luggage-orders/20261027-003/note", { note: "y", actor: bad })).status, 400);
  }
  assert.equal(count(ctx, "luggage_audit_logs"), before);
});

test("existing staff regression: editor/admin mapping is unchanged and needs no part-time table", async () => {
  stubProfiles([EDITOR, ADMIN]);
  const ctx = setup(false);
  const note = await createNote(ctx, staffActor(EDITOR));
  assert.equal(note.authorId, EDITOR.id);
  assert.deepEqual(JSON.parse(audits(ctx, "UNIFIED_ADMIN_HANDOVER_CREATE")[0].details).legacyStaff, { id: EDITOR.id, displayName: "정직원", role: "editor" });
  assert.equal(JSON.parse(audits(ctx, "UNIFIED_ADMIN_HANDOVER_CREATE")[0].details).authSource, undefined);
  assert.equal((await edit(ctx, note, staffActor(EDITOR))).status, 200);
  assert.equal(count(ctx, "luggage_part_time_actors"), 0);
  const list = await call(ctx, "GET", "/internal/luggage-handovers");
  assert.equal(list.json.notes[0].authorName, "정직원");
});


test("CI deployments preserve dashboard part-time and refund switches", () => {
  const workflow = readFileSync("../.github/workflows/deploy-worker.yml", "utf8");
  assert.match(workflow, /wrangler deploy --keep-vars /);
  for (const file of ["wrangler.toml", "wrangler.f1.toml"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /^LUGGAGE_PART_TIME_(?:REFUND_)?ACTORS_ENABLED\s*=/m);
  }
});
