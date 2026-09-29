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
const AUTHOR: Profile = { id: "11111111-1111-4111-8111-111111111111", display_name: "작성자", username: "author", email: "author@example.test", role: "editor", is_active: true };
const OTHER: Profile = { id: "22222222-2222-4222-8222-222222222222", display_name: "다른직원", username: "other", email: "other@example.test", role: "editor", is_active: true };
const ADMIN: Profile = { id: "33333333-3333-4333-8333-333333333333", display_name: "관리자", username: "admin", email: "admin@example.test", role: "admin", is_active: true };
const ALL = [AUTHOR, OTHER, ADMIN];

function stubProfiles(profiles: Profile[] | "error") {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://supabase.test/rest/v1/user_profiles")) throw new Error(`unexpected fetch ${url}`);
    if (profiles === "error") return new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } });
    const rows = url.includes("is_active=eq.true") ? profiles.filter((p) => p.is_active) : profiles;
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
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

async function call(ctx: ReturnType<typeof setup>, method: string, path: string, body?: unknown, options: { unsigned?: boolean } = {}) {
  const url = `https://luggage.test${path}`;
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const { signature } = await signInternalRequest({ secret: SECRET, method, url, timestamp, body: raw });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.unsigned) {
    headers["x-internal-timestamp"] = timestamp;
    headers["x-internal-signature"] = signature;
  }
  const response = await ctx.app.request(url, { method, headers, body: raw || undefined }, ctx.env);
  return { status: response.status, json: await response.json() as Record<string, any> };
}

const actorFor = (profile: Profile, role = "center_staff") => ({ userId: `unified-${profile.username}`, name: `Unified ${profile.username}`, email: profile.email!.toUpperCase(), role });
const author = actorFor(AUTHOR);
let seq = 0;
const nextRequestId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const noteBody = (overrides: Record<string, unknown> = {}) => ({ requestId: nextRequestId(), category: "HANDOVER", title: "교대 메모", content: "4F 락커 확인 @다른직원", isPinned: false, actor: author, ...overrides });
const expectedOf = (note: Record<string, any>) => ({ category: note.category, title: note.title, content: note.content, isPinned: note.isPinned, authorId: note.authorId });
const count = (ctx: ReturnType<typeof setup>, table: string) => (ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const audits = (ctx: ReturnType<typeof setup>, action?: string) => (ctx.sqlite.prepare("SELECT staff_id, device_id, action, details FROM luggage_audit_logs ORDER BY log_id").all() as Array<Record<string, any>>)
  .filter((row) => !action || row.action === action);

async function createNote(ctx: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  const res = await call(ctx, "POST", "/internal/luggage-handovers", noteBody(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.note as Record<string, any>;
}

test("create writes the resolved legacy staff as author, mentions and a create audit atomically", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  assert.equal(note.authorId, AUTHOR.id);
  const row = ctx.sqlite.prepare("SELECT * FROM luggage_handover_notes").get() as Record<string, any>;
  assert.equal(row.staff_id, AUTHOR.id);
  assert.equal(row.is_pinned, 0);
  const mentions = ctx.sqlite.prepare("SELECT note_id, comment_id, staff_id FROM luggage_handover_mentions").all();
  assert.deepEqual(mentions.map((m) => ({ ...m })), [{ note_id: row.note_id, comment_id: null, staff_id: OTHER.id }]);
  const [log] = audits(ctx, "UNIFIED_ADMIN_HANDOVER_CREATE");
  assert.equal(log.staff_id, AUTHOR.id);
  assert.equal(log.device_id, "unified-admin");
  const details = JSON.parse(log.details);
  assert.equal(details.noteId, row.note_id);
  assert.deepEqual(details.actor, author);
  assert.deepEqual(details.legacyStaff, { id: AUTHOR.id, displayName: "작성자", role: "editor" });

  // The existing read API shows the unified-created note under the same legacy author name.
  const list = await call(ctx, "GET", "/internal/luggage-handovers");
  assert.equal(list.json.notes[0].authorName, "작성자");
  assert.deepEqual(list.json.notes[0].mentionedStaff, [{ staffId: OTHER.id, staffName: "다른직원" }]);
});

test("create rejects staff_id injection, bad fields and replays", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  for (const bad of [{ staffId: AUTHOR.id }, { category: "SECRET" }, { title: " " }, { content: "" }, { isPinned: "1" }, { requestId: "x" }]) {
    assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody(bad))).status, 400, JSON.stringify(bad));
  }
  for (const role of ["viewer", "office_staff"]) {
    assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody({ actor: { ...author, role } }))).status, 400);
  }
  const body = noteBody();
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", body)).status, 201);
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", body)).status, 409);
  assert.equal(count(ctx, "luggage_handover_notes"), 1);
  assert.equal(count(ctx, "luggage_handover_mentions"), 1);
  assert.equal(audits(ctx).length, 1);
});

test("actor mapping fails closed for every write", async () => {
  const cases: Array<[Profile[] | "error", number]> = [
    [[OTHER], 403],
    [[{ ...AUTHOR, is_active: false }], 403],
    [[{ ...AUTHOR, role: "viewer" }], 403],
    [[AUTHOR, { ...AUTHOR, id: "44444444-4444-4444-8444-444444444444" }], 403],
    ["error", 503],
  ];
  for (const [profiles, status] of cases) {
    stubProfiles(ALL);
    const ctx = setup();
    const note = await createNote(ctx);
    stubProfiles(profiles);
    const before = { notes: count(ctx, "luggage_handover_notes"), audits: audits(ctx).length };
    assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody())).status, status);
    assert.equal((await call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "NOTICE", title: "t", content: "c", isPinned: true, expected: expectedOf(note), actor: author })).status, status);
    assert.equal((await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected: { ...expectedOf(note), commentCount: 0 }, actor: author })).status, status);
    assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: author })).status, status);
    assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, { requestId: nextRequestId(), content: "x", actor: author })).status, status);
    assert.equal(count(ctx, "luggage_handover_notes"), before.notes);
    assert.equal(count(ctx, "luggage_handover_reads"), 0);
    assert.equal(count(ctx, "luggage_handover_comments"), 0);
    assert.equal(count(ctx, "luggage_handover_edits"), 0);
    assert.equal(audits(ctx).length, before.audits);
    assert.equal((ctx.sqlite.prepare("SELECT title FROM luggage_handover_notes").get() as { title: string }).title, "교대 메모");
  }
});

test("HMAC is required on every new endpoint", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  for (const [method, path] of [["POST", "/internal/luggage-handovers"], ["PATCH", "/internal/luggage-handovers/1"], ["DELETE", "/internal/luggage-handovers/1"], ["POST", "/internal/luggage-handovers/1/read"], ["POST", "/internal/luggage-handovers/1/comments"]]) {
    assert.equal((await call(ctx, method, path, {}, { unsigned: true })).status, 401, `${method} ${path}`);
  }
});

test("read is idempotent per legacy staff and feeds the legacy unread count", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  const unreadFor = (staffId: string) => (ctx.sqlite.prepare(
    `SELECT COUNT(*) as count FROM luggage_handover_notes n WHERE n.staff_id != ?
       AND NOT EXISTS (SELECT 1 FROM luggage_handover_reads r WHERE r.note_id = n.note_id AND r.staff_id = ?)`,
  ).get(staffId, staffId) as { count: number }).count;
  assert.equal(unreadFor(OTHER.id), 1);
  const reader = actorFor(OTHER, "manager");
  const first = await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: reader });
  assert.equal(first.status, 200);
  assert.equal(first.json.changed, true);
  assert.equal(first.json.staffId, OTHER.id);
  const second = await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: reader });
  assert.equal(second.json.changed, false);
  assert.equal(second.json.readAt, first.json.readAt);
  assert.equal(count(ctx, "luggage_handover_reads"), 1);
  assert.equal(unreadFor(OTHER.id), 0);
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers/9999/read", { actor: reader })).status, 404);
  assert.equal(count(ctx, "luggage_handover_reads"), 1);
  assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: reader, staffId: OTHER.id })).status, 400);
});

test("comments keep the legacy author, mentions and refuse deleted notes", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx, { content: "멘션 없음" });
  const body = { requestId: nextRequestId(), content: " 확인했습니다 @작성자 ", actor: actorFor(OTHER) };
  const res = await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, body);
  assert.equal(res.status, 201);
  const row = ctx.sqlite.prepare("SELECT * FROM luggage_handover_comments").get() as Record<string, any>;
  assert.equal(row.staff_id, OTHER.id);
  assert.equal(row.content, "확인했습니다 @작성자");
  const mentions = ctx.sqlite.prepare("SELECT note_id, comment_id, staff_id FROM luggage_handover_mentions").all();
  assert.deepEqual(mentions.map((m) => ({ ...m })), [{ note_id: note.noteId, comment_id: row.comment_id, staff_id: AUTHOR.id }]);
  assert.equal(JSON.parse(audits(ctx, "UNIFIED_ADMIN_HANDOVER_COMMENT_CREATE")[0].details).commentId, row.comment_id);
  assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, body)).status, 409);
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers/9999/comments", { ...body, requestId: nextRequestId() })).status, 404);
  assert.equal(count(ctx, "luggage_handover_comments"), 1);
  assert.equal(count(ctx, "luggage_handover_mentions"), 1);
});

test("edit is limited to the author or a legacy admin and keeps edit history", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  const edit = (actor: object, expected = expectedOf(note), fields: Record<string, unknown> = {}) =>
    call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "URGENT", title: "수정 제목", content: "수정 본문", isPinned: true, expected, actor, ...fields });

  const denied = await edit(actorFor(OTHER, "super_admin"));
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, "NOT_AUTHOR");
  const ok = await edit(author);
  assert.equal(ok.status, 200);
  assert.deepEqual(expectedOf(ok.json.note), { category: "URGENT", title: "수정 제목", content: "수정 본문", isPinned: true, authorId: AUTHOR.id });
  const history = ctx.sqlite.prepare("SELECT staff_id, old_title, old_content, new_title, new_content FROM luggage_handover_edits").all();
  assert.deepEqual(history.map((h) => ({ ...h })), [{ staff_id: AUTHOR.id, old_title: "교대 메모", old_content: "4F 락커 확인 @다른직원", new_title: "수정 제목", new_content: "수정 본문" }]);
  const details = JSON.parse(audits(ctx, "UNIFIED_ADMIN_HANDOVER_UPDATE")[0].details);
  assert.equal(details.before.category, "HANDOVER");
  assert.equal(details.after.isPinned, true);

  // Stale: still holding the pre-edit snapshot.
  assert.equal((await edit(author)).status, 409);
  // Legacy admin may edit someone else's note; history records the admin.
  const byAdmin = await edit(actorFor(ADMIN), expectedOf(ok.json.note), { title: "관리자 수정" });
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.json.note.authorId, AUTHOR.id);
  assert.equal((ctx.sqlite.prepare("SELECT staff_id FROM luggage_handover_edits ORDER BY edit_id DESC").get() as { staff_id: string }).staff_id, ADMIN.id);
  assert.equal(count(ctx, "luggage_handover_edits"), 2);
  assert.equal((await call(ctx, "PATCH", "/internal/luggage-handovers/9999", { category: "URGENT", title: "t", content: "c", isPinned: true, expected: expectedOf(note), actor: author })).status, 404);
});

test("a staff-screen edit between our read and write is not overwritten", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  const realBatch = ctx.env.DB.batch;
  ctx.env.DB.batch = async (statements) => {
    ctx.sqlite.prepare("UPDATE luggage_handover_notes SET content = 'staff edit' WHERE note_id = ?").run(note.noteId);
    return realBatch(statements);
  };
  const res = await call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "URGENT", title: "t", content: "c", isPinned: false, expected: expectedOf(note), actor: author });
  assert.equal(res.status, 409);
  assert.equal((ctx.sqlite.prepare("SELECT content FROM luggage_handover_notes").get() as { content: string }).content, "staff edit");
  assert.equal(count(ctx, "luggage_handover_edits"), 0);
  assert.equal(audits(ctx, "UNIFIED_ADMIN_HANDOVER_UPDATE").length, 0);
});

test("delete is author-only, guards unseen comments and clears the same child rows as the staff route", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/read`, { actor: actorFor(OTHER) });
  await call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "HANDOVER", title: "교대 메모", content: "4F 락커 확인 @다른직원", isPinned: false, expected: expectedOf(note), actor: author });
  const other = await createNote(ctx, { content: "다른 노트" });
  const expected = { ...expectedOf(note), commentCount: 0 };

  for (const actor of [actorFor(OTHER), actorFor(ADMIN, "super_admin")]) {
    const denied = await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected, actor });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, "NOT_AUTHOR");
  }
  await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, { requestId: nextRequestId(), content: "새 댓글 @작성자", actor: actorFor(OTHER) });
  assert.equal((await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected, actor: author })).status, 409);

  const res = await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected: { ...expected, commentCount: 1 }, actor: author });
  assert.equal(res.status, 200);
  for (const table of ["luggage_handover_reads", "luggage_handover_comments"]) {
    assert.equal((ctx.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE note_id = ?`).get(note.noteId) as { n: number }).n, 0, table);
  }
  assert.equal((ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_handover_mentions WHERE note_id = ?").get(note.noteId) as { n: number }).n, 0);
  // Edit history stays, exactly as the staff delete route leaves it; the other note is untouched.
  assert.equal(count(ctx, "luggage_handover_edits"), 1);
  assert.equal((ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM luggage_handover_notes WHERE note_id = ?").get(other.noteId) as { n: number }).n, 1);
  const details = JSON.parse(audits(ctx, "UNIFIED_ADMIN_HANDOVER_DELETE")[0].details);
  assert.equal(details.before.title, "교대 메모");
  assert.equal(details.before.comments[0].content, "새 댓글 @작성자");
  assert.equal(details.before.reads[0].staffId, OTHER.id);
  assert.equal(details.before.mentions.length, 2);
  assert.equal((await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected: { ...expected, commentCount: 1 }, actor: author })).status, 404);
});

test("audit failure rolls back every handover write", async () => {
  stubProfiles(ALL);
  const ctx = setup();
  const note = await createNote(ctx);
  await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, { requestId: nextRequestId(), content: "기존 댓글", actor: author });
  const snapshot = () => JSON.stringify(["luggage_handover_notes", "luggage_handover_comments", "luggage_handover_mentions", "luggage_handover_edits", "luggage_handover_reads"]
    .map((table) => ctx.sqlite.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  ctx.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON luggage_audit_logs BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
  assert.equal((await call(ctx, "POST", "/internal/luggage-handovers", noteBody())).status, 500);
  assert.equal((await call(ctx, "PATCH", `/internal/luggage-handovers/${note.noteId}`, { category: "URGENT", title: "t", content: "c", isPinned: true, expected: expectedOf(note), actor: author })).status, 500);
  assert.equal((await call(ctx, "DELETE", `/internal/luggage-handovers/${note.noteId}`, { expected: { ...expectedOf(note), commentCount: 1 }, actor: author })).status, 500);
  assert.equal((await call(ctx, "POST", `/internal/luggage-handovers/${note.noteId}/comments`, { requestId: nextRequestId(), content: "새 댓글 @다른직원", actor: author })).status, 500);
  assert.equal(snapshot(), before);
});
