/**
 * Staff operations routes — Cash Closing, Handover Notes, Lost & Found.
 * Covers US-009 (Cash Closing), US-010 (Handover), US-011 (Lost & Found).
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, adminAuth, getStaff, type StaffUser } from "../middleware/auth";
import { formatDateJST, nowJST } from "../services/storage";

const ops = new Hono<AppType>();
ops.use("/*", staffAuth);

// ============================================================
// CASH CLOSING (US-009)
// ============================================================

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;

// GET /staff/cash-closing — Cash closing list & form
ops.get("/staff/cash-closing", async (c) => {
  const closings = await c.env.DB.prepare(
    "SELECT * FROM luggage_cash_closings ORDER BY created_at DESC LIMIT 30"
  ).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>정산 마감</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a>{staff.role === "admin" && <a class="pill-link" href="/staff/admin/sales">매출관리</a>}<span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link is-active" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>

          <section class="card">
            <h3 class="card-title">새 마감</h3>
            <form method="post" action="/staff/cash-closing">
              <label class="field">
                <span class="field-label">마감 유형</span>
                <select class="control" name="closing_type">
                  <option value="MORNING_HANDOVER">오전 인수인계</option>
                  <option value="FINAL_CLOSE">최종 마감</option>
                </select>
              </label>

              <div class="cash-denom-panel">
                <p class="field-label">현금 내역</p>
                <div class="cash-denom-grid">
                  {DENOMS.map((d) => (
                    <label class="cash-denom-item">
                      <span>¥{d}</span>
                      <input class="control" type="number" name={`count_${d}`} defaultValue="0" min="0" />
                    </label>
                  ))}
                </div>
              </div>

              <div class="grid2">
                <label class="field">
                  <span class="field-label">PayPay 금액</span>
                  <input class="control" type="number" name="paypay_amount" defaultValue="0" />
                </label>
                <label class="field">
                  <span class="field-label">실제 QR 금액</span>
                  <input class="control" type="number" name="actual_qr_amount" defaultValue="0" />
                </label>
              </div>

              <label class="field">
                <span class="field-label">메모</span>
                <textarea class="control" name="note"></textarea>
              </label>
              <button class="btn btn-primary" type="submit">저장</button>
            </form>
          </section>

          <section class="card">
            <h3 class="card-title">최근 마감</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>날짜</th><th>유형</th><th>상태</th><th>합계</th></tr>
                </thead>
                <tbody>
                  {closings.results.map((cl: Record<string, unknown>) => (
                    <tr>
                      <td><a href={`/staff/cash-closing/${cl.closing_id}`}>{cl.business_date as string}</a></td>
                      <td>{cl.closing_type as string}</td>
                      <td>{cl.workflow_status as string}</td>
                      <td>¥{cl.total_amount as number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/cash-closing — Create cash closing
ops.post("/staff/cash-closing", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);
  const businessDate = formatDateJST(nowJST());

  let totalAmount = 0;
  const denomValues: number[] = [];
  for (const d of DENOMS) {
    const count = parseInt(String(body[`count_${d}`] || "0"), 10);
    denomValues.push(count);
    totalAmount += count * d;
  }

  const paypayAmount = parseInt(String(body.paypay_amount || "0"), 10);
  const actualQrAmount = parseInt(String(body.actual_qr_amount || "0"), 10);
  const closingType = String(body.closing_type || "FINAL_CLOSE");

  await c.env.DB.prepare(
    `INSERT INTO luggage_cash_closings (
       business_date, closing_type, workflow_status,
       count_10000, count_5000, count_2000, count_1000, count_500,
       count_100, count_50, count_10, count_5, count_1,
       total_amount, paypay_amount, actual_qr_amount,
       actual_amount, staff_id, note
     ) VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      businessDate, closingType,
      ...denomValues, totalAmount, paypayAmount, actualQrAmount,
      totalAmount + paypayAmount, staff.id, String(body.note || "") || null
    )
    .run();

  return c.redirect("/staff/cash-closing");
});

// GET /staff/cash-closing/:id — Cash closing detail
ops.get("/staff/cash-closing/:id", async (c) => {
  const closingId = c.req.param("id");
  const closing = await c.env.DB.prepare("SELECT * FROM luggage_cash_closings WHERE closing_id = ?")
    .bind(closingId)
    .first();

  if (!closing) return c.html(<p>Not found</p>, 404);

  const audits = await c.env.DB.prepare(
    "SELECT * FROM luggage_cash_closing_audits WHERE closing_id = ? ORDER BY created_at DESC"
  )
    .bind(closingId)
    .all();

  const cl = closing as Record<string, unknown>;
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>정산 상세</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link is-active" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>

          <section class="card">
            <h3 class="card-title">정산 상세: {cl.business_date as string}</h3>
            <p>유형: {cl.closing_type as string} | 상태: {cl.workflow_status as string}</p>
            <p>현금 합계: ¥{cl.total_amount as number}</p>
            <p>PayPay: ¥{cl.paypay_amount as number}</p>
            <p>QR 실제: ¥{cl.actual_qr_amount as number}</p>
            <p>총 합계: ¥{cl.actual_amount as number}</p>
            <p>메모: {(cl.note as string) || "-"}</p>

            {cl.workflow_status === "DRAFT" && (
              <form method="post" action={`/staff/cash-closing/${closingId}/submit`}>
                <button class="btn btn-primary" type="submit">제출</button>
              </form>
            )}
          </section>

          <section class="card">
            <h3 class="card-title">감사 로그</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>시간</th><th>행동</th><th>직원</th></tr>
                </thead>
                <tbody>
                  {audits.results.map((a: Record<string, unknown>) => (
                    <tr><td>{a.created_at as string}</td><td>{a.action as string}</td><td>{a.staff_id as string}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/cash-closing/:id/submit — Submit closing
ops.post("/staff/cash-closing/:id/submit", async (c) => {
  const closingId = c.req.param("id");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "UPDATE luggage_cash_closings SET workflow_status = 'SUBMITTED', submitted_by_staff_id = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE closing_id = ?"
  )
    .bind(staff.id, closingId)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO luggage_cash_closing_audits (closing_id, action, staff_id) VALUES (?, 'SUBMIT', ?)"
  )
    .bind(closingId, staff.id)
    .run();

  return c.redirect(`/staff/cash-closing/${closingId}`);
});

// POST /staff/cash-closing/:id/verify-lock — Admin verify & lock
ops.post("/staff/cash-closing/:id/verify-lock", adminAuth, async (c) => {
  const closingId = c.req.param("id");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "UPDATE luggage_cash_closings SET workflow_status = 'LOCKED', verified_by_staff_id = ?, verified_at = datetime('now'), updated_at = datetime('now') WHERE closing_id = ?"
  )
    .bind(staff.id, closingId)
    .run();

  await c.env.DB.prepare(
    "INSERT INTO luggage_cash_closing_audits (closing_id, action, staff_id) VALUES (?, 'VERIFY_LOCK', ?)"
  )
    .bind(closingId, staff.id)
    .run();

  return c.redirect(`/staff/cash-closing/${closingId}`);
});

// GET /staff/api/cash-closing/auto-sales — Auto-calculated sales for business date
ops.get("/staff/api/cash-closing/auto-sales", async (c) => {
  const businessDate = c.req.query("date") || "";
  if (!businessDate) return c.json({ error: "date required" }, 400);

  const result = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN payment_method = 'CASH' THEN prepaid_amount + extra_amount ELSE 0 END) as cash_amount,
       SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as qr_amount,
       SUM(prepaid_amount + extra_amount) as total_amount,
       COUNT(*) as order_count
     FROM luggage_orders
     WHERE date(created_at) = ? AND status IN ('PAID', 'PICKED_UP')`
  )
    .bind(businessDate)
    .first();

  return c.json(result || { cash_amount: 0, qr_amount: 0, total_amount: 0, order_count: 0 });
});

// ============================================================
// HANDOVER NOTES (US-010)
// ============================================================

// GET /staff/handover — Handover notes list
ops.get("/staff/handover", async (c) => {
  const staff = getStaff(c);
  const notes = await c.env.DB.prepare(
    "SELECT * FROM luggage_handover_notes ORDER BY is_pinned DESC, created_at DESC LIMIT 50"
  ).all();

  // Get read status for current staff
  const reads = await c.env.DB.prepare(
    "SELECT note_id FROM luggage_handover_reads WHERE staff_id = ?"
  )
    .bind(staff.id)
    .all<{ note_id: number }>();
  const readNoteIds = new Set(reads.results.map((r) => r.note_id));

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>인수인계</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link is-active" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>

          <section class="card">
            <h3 class="card-title">노트 작성</h3>
            <form method="post" action="/staff/handover">
              <div class="grid2">
                <label class="field">
                  <span class="field-label">분류</span>
                  <select class="control" name="category">
                    <option value="HANDOVER">인수인계</option>
                    <option value="NOTICE">안내사항</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">제목</span>
                  <input class="control" type="text" name="title" placeholder="제목" required />
                </label>
              </div>
              <label class="field">
                <span class="field-label">내용</span>
                <textarea class="control" name="content" placeholder="내용" required></textarea>
              </label>
              <label class="check-row">
                <input type="checkbox" name="is_pinned" value="1" />
                <span>고정</span>
              </label>
              <button class="btn btn-primary" type="submit">작성</button>
            </form>
          </section>

          <div class="ops-board">
            {notes.results.map((note: Record<string, unknown>) => {
              const noteId = note.note_id as number;
              const isRead = readNoteIds.has(noteId);
              return (
                <div class="ops-item">
                  <div class="ops-item-header">
                    <strong>{(note.is_pinned as number) ? "📌 " : ""}{note.title as string}</strong>
                    <span class="ops-item-meta">[{note.category as string}] {isRead ? "✓읽음" : "⬤새글"}</span>
                  </div>
                  <p class="ops-item-content">{note.content as string}</p>
                  <small class="ops-item-date">{note.created_at as string}</small>
                  {!isRead && (
                    <form method="post" action={`/staff/handover/${noteId}/read`} style="display:inline">
                      <button class="btn btn-sm" type="submit">읽음 표시</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </main>
      </body>
    </html>
  );
});

// POST /staff/handover — Create note
ops.post("/staff/handover", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "INSERT INTO luggage_handover_notes (category, title, content, is_pinned, staff_id) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(
      String(body.category || "HANDOVER"),
      String(body.title || ""),
      String(body.content || ""),
      body.is_pinned ? 1 : 0,
      staff.id
    )
    .run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/:id/read — Mark note as read
ops.post("/staff/handover/:id/read", async (c) => {
  const noteId = c.req.param("id");
  const staff = getStaff(c);

  // Upsert read status
  await c.env.DB.prepare(
    `INSERT INTO luggage_handover_reads (note_id, staff_id)
     SELECT ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM luggage_handover_reads WHERE note_id = ? AND staff_id = ?
     )`
  )
    .bind(noteId, staff.id, noteId, staff.id)
    .run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/:id/comments — Add comment
ops.post("/staff/handover/:id/comments", async (c) => {
  const noteId = c.req.param("id");
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "INSERT INTO luggage_handover_comments (note_id, staff_id, content) VALUES (?, ?, ?)"
  )
    .bind(noteId, staff.id, String(body.content || ""))
    .run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/:id/update — Update note
ops.post("/staff/handover/:id/update", async (c) => {
  const noteId = c.req.param("id");
  const body = await c.req.parseBody();

  await c.env.DB.prepare(
    "UPDATE luggage_handover_notes SET title = ?, content = ?, category = ?, is_pinned = ? WHERE note_id = ?"
  )
    .bind(
      String(body.title || ""),
      String(body.content || ""),
      String(body.category || "HANDOVER"),
      body.is_pinned ? 1 : 0,
      noteId
    )
    .run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/:id/delete — Delete note
ops.post("/staff/handover/:id/delete", async (c) => {
  const noteId = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM luggage_handover_notes WHERE note_id = ?").bind(noteId),
    c.env.DB.prepare("DELETE FROM luggage_handover_reads WHERE note_id = ?").bind(noteId),
    c.env.DB.prepare("DELETE FROM luggage_handover_comments WHERE note_id = ?").bind(noteId),
  ]);
  return c.redirect("/staff/handover");
});

// POST /staff/handover/comments/:id/delete — Delete comment
ops.post("/staff/handover/comments/:id/delete", async (c) => {
  const commentId = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM luggage_handover_comments WHERE comment_id = ?").bind(commentId).run();
  return c.redirect("/staff/handover");
});

// ============================================================
// LOST & FOUND (US-011)
// ============================================================

// GET /staff/lost-found — Lost & found list
ops.get("/staff/lost-found", async (c) => {
  const statusFilter = c.req.query("status") || "";
  const search = c.req.query("search") || "";

  let sql = "SELECT * FROM luggage_lost_found_entries WHERE 1=1";
  const params: string[] = [];

  if (statusFilter) {
    sql += " AND status = ?";
    params.push(statusFilter);
  }
  if (search) {
    sql += " AND item_name LIKE ?";
    params.push(`%${search}%`);
  }
  sql += " ORDER BY created_at DESC LIMIT 100";

  const entries = await c.env.DB.prepare(sql).bind(...params).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>분실물</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link is-active" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>

          <section class="card">
            <h3 class="card-title">분실물 등록</h3>
            <form method="post" action="/staff/lost-found">
              <div class="grid2">
                <label class="field">
                  <span class="field-label">물품명</span>
                  <input class="control" type="text" name="item_name" required />
                </label>
                <label class="field">
                  <span class="field-label">수량</span>
                  <input class="control" type="number" name="quantity" value="1" min="1" />
                </label>
              </div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">발견 장소</span>
                  <input class="control" type="text" name="found_location" />
                </label>
                <label class="field">
                  <span class="field-label">발견 일시</span>
                  <input class="control" type="datetime-local" name="found_at" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">메모</span>
                <textarea class="control" name="note"></textarea>
              </label>
              <button class="btn btn-primary" type="submit">등록</button>
            </form>
          </section>

          <section class="card">
            <h3 class="card-title">분실물 목록</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>물품</th><th>수량</th><th>장소</th><th>상태</th><th>등록일</th><th>액션</th></tr>
                </thead>
                <tbody>
                  {entries.results.map((e: Record<string, unknown>) => (
                    <tr>
                      <td>{e.item_name as string}</td>
                      <td>{e.quantity as number}</td>
                      <td>{(e.found_location as string) || "-"}</td>
                      <td>{e.status as string}</td>
                      <td>{e.created_at as string}</td>
                      <td>
                        {e.status === "UNCLAIMED" && (
                          <form method="post" action={`/staff/lost-found/${e.entry_id}/update`} style="display:inline">
                            <input type="hidden" name="status" value="CLAIMED" />
                            <input class="control" type="text" name="claimed_by" placeholder="인수자" />
                            <button class="btn btn-sm" type="submit">인계</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/lost-found — Create entry
ops.post("/staff/lost-found", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "INSERT INTO luggage_lost_found_entries (item_name, quantity, found_location, found_at, note, staff_id) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      String(body.item_name || ""),
      parseInt(String(body.quantity || "1"), 10),
      String(body.found_location || "") || null,
      String(body.found_at || "") || null,
      String(body.note || "") || null,
      staff.id
    )
    .run();

  return c.redirect("/staff/lost-found");
});

// POST /staff/lost-found/:id/update — Update entry status
ops.post("/staff/lost-found/:id/update", async (c) => {
  const entryId = c.req.param("id");
  const body = await c.req.parseBody();

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.status) {
    updates.push("status = ?");
    values.push(String(body.status));
  }
  if (body.claimed_by) {
    updates.push("claimed_by = ?");
    values.push(String(body.claimed_by));
  }
  if (body.note !== undefined) {
    updates.push("note = ?");
    values.push(String(body.note));
  }

  if (updates.length > 0) {
    values.push(entryId);
    await c.env.DB.prepare(`UPDATE luggage_lost_found_entries SET ${updates.join(", ")} WHERE entry_id = ?`)
      .bind(...values)
      .run();
  }

  return c.redirect("/staff/lost-found");
});

// POST /staff/lost-found/:id/delete — Delete entry
ops.post("/staff/lost-found/:id/delete", async (c) => {
  const entryId = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM luggage_lost_found_entries WHERE entry_id = ?").bind(entryId).run();
  return c.redirect("/staff/lost-found");
});

export default ops;
