/**
 * Admin routes — Sales analytics, staff accounts, settings, activity logs.
 * US-012: All admin-only routes.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { adminAuth, getStaff, type StaffUser } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { formatDateJST, nowJST } from "../services/storage";

const admin = new Hono<AppType>();
admin.use("/*", adminAuth);

// GET /staff/admin/sales — Sales analytics
admin.get("/staff/admin/sales", async (c) => {
  const today = formatDateJST(nowJST());

  // Daily sales from orders
  const dailySales = await c.env.DB.prepare(
    `SELECT date(created_at) as sale_date,
       COUNT(*) as order_count,
       SUM(CASE WHEN payment_method = 'CASH' THEN prepaid_amount + extra_amount ELSE 0 END) as cash_total,
       SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as qr_total,
       SUM(prepaid_amount + extra_amount) as grand_total
     FROM luggage_orders
     WHERE status IN ('PAID', 'PICKED_UP')
     GROUP BY date(created_at)
     ORDER BY sale_date DESC
     LIMIT 30`
  ).all();

  // Rental sales
  const rentalSales = await c.env.DB.prepare(
    "SELECT * FROM luggage_rental_daily_sales ORDER BY business_date DESC LIMIT 30"
  ).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>매출 분석</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link pill-link-strong" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
            <a class="staff-menu-link is-active" href="/staff/admin/sales">매출관리</a>
            <a class="staff-menu-link" href="/staff/admin/staff-accounts">계정관리</a>
            <a class="staff-menu-link" href="/staff/admin/activity-logs">활동로그</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">매출 분석</h2>

        <h2>짐보관 일별 매출</h2>
        <table>
          <tr><th>날짜</th><th>건수</th><th>현금</th><th>QR</th><th>합계</th></tr>
          {dailySales.results.map((d: Record<string, unknown>) => (
            <tr>
              <td>{d.sale_date as string}</td>
              <td>{d.order_count as number}</td>
              <td>¥{d.cash_total as number}</td>
              <td>¥{d.qr_total as number}</td>
              <td>¥{d.grand_total as number}</td>
            </tr>
          ))}
        </table>

        <h2>렌탈 일별 매출</h2>
        <form method="post" action="/staff/admin/sales/rental">
          <input type="date" name="business_date" value={today} required />
          <input type="number" name="revenue_amount" placeholder="매출" required />
          <input type="number" name="customer_count" placeholder="고객수" defaultValue="0" />
          <input type="text" name="note" placeholder="메모" />
          <button type="submit">등록</button>
        </form>
        <table>
          <tr><th>날짜</th><th>매출</th><th>고객수</th><th>메모</th></tr>
          {rentalSales.results.map((r: Record<string, unknown>) => (
            <tr>
              <td>{r.business_date as string}</td>
              <td>¥{r.revenue_amount as number}</td>
              <td>{r.customer_count as number}</td>
              <td>{(r.note as string) || "-"}</td>
            </tr>
          ))}
        </table>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/sales/rental — Create/upsert rental daily sales
admin.post("/staff/admin/sales/rental", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "INSERT INTO luggage_rental_daily_sales (business_date, revenue_amount, customer_count, note, staff_id) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(
      String(body.business_date),
      parseInt(String(body.revenue_amount || "0"), 10),
      parseInt(String(body.customer_count || "0"), 10),
      String(body.note || "") || null,
      staff.id
    )
    .run();

  return c.redirect("/staff/admin/sales");
});

// GET /staff/admin/staff-accounts — Staff account management
admin.get("/staff/admin/staff-accounts", async (c) => {
  const accounts = await c.env.DB.prepare(
    "SELECT * FROM user_profiles ORDER BY created_at DESC"
  ).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>직원 계정</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
            <a class="staff-menu-link" href="/staff/admin/sales">매출관리</a>
            <a class="staff-menu-link is-active" href="/staff/admin/staff-accounts">계정관리</a>
            <a class="staff-menu-link" href="/staff/admin/activity-logs">활동로그</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">직원 계정 관리</h2>

        <h2>새 계정</h2>
        <form method="post" action="/staff/admin/staff-accounts">
          <input type="email" name="email" placeholder="이메일" required />
          <input type="password" name="password" placeholder="비밀번호" required />
          <input type="text" name="display_name" placeholder="표시 이름" required />
          <select name="role">
            <option value="staff">직원</option>
            <option value="admin">관리자</option>
          </select>
          <button type="submit">생성</button>
        </form>

        <h2>계정 목록</h2>
        <table>
          <tr><th>이름</th><th>역할</th><th>상태</th><th>액션</th></tr>
          {accounts.results.map((a: Record<string, unknown>) => (
            <tr>
              <td>{(a.display_name as string) || (a.username as string)}</td>
              <td>{a.role as string}</td>
              <td>{(a.is_active as number) ? "활성" : "비활성"}</td>
              <td>
                <form method="post" action={`/staff/admin/staff-accounts/${a.id}/toggle-active`} style="display:inline">
                  <button type="submit">{(a.is_active as number) ? "비활성화" : "활성화"}</button>
                </form>
              </td>
            </tr>
          ))}
        </table>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/staff-accounts — Create staff account
admin.post("/staff/admin/staff-accounts", async (c) => {
  const body = await c.req.parseBody();
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const displayName = String(body.display_name || "").trim();
  const role = String(body.role || "staff");

  if (!email || !password || !displayName) {
    return c.redirect("/staff/admin/staff-accounts?error=All fields required");
  }

  // Create user in Supabase Auth
  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    return c.redirect(`/staff/admin/staff-accounts?error=${encodeURIComponent(error?.message || "Failed")}`);
  }

  // Create profile in D1
  await c.env.DB.prepare(
    "INSERT INTO user_profiles (id, display_name, username, role, is_active) VALUES (?, ?, ?, ?, 1)"
  )
    .bind(data.user.id, displayName, email.split("@")[0], role)
    .run();

  return c.redirect("/staff/admin/staff-accounts");
});

// POST /staff/admin/staff-accounts/:id/toggle-active
admin.post("/staff/admin/staff-accounts/:id/toggle-active", async (c) => {
  const targetId = c.req.param("id");

  const profile = await c.env.DB.prepare("SELECT is_active FROM user_profiles WHERE id = ?")
    .bind(targetId)
    .first<{ is_active: number }>();

  if (!profile) return c.redirect("/staff/admin/staff-accounts");

  await c.env.DB.prepare("UPDATE user_profiles SET is_active = ? WHERE id = ?")
    .bind(profile.is_active ? 0 : 1, targetId)
    .run();

  return c.redirect("/staff/admin/staff-accounts");
});

// POST /staff/admin/staff-accounts/:id/update
admin.post("/staff/admin/staff-accounts/:id/update", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req.parseBody();

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.display_name) { updates.push("display_name = ?"); values.push(String(body.display_name)); }
  if (body.role) { updates.push("role = ?"); values.push(String(body.role)); }

  if (updates.length > 0) {
    values.push(targetId);
    await c.env.DB.prepare(`UPDATE user_profiles SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  return c.redirect("/staff/admin/staff-accounts");
});

// POST /staff/admin/staff-accounts/:id/delete
admin.post("/staff/admin/staff-accounts/:id/delete", async (c) => {
  const targetId = c.req.param("id");

  // Delete from Supabase Auth first
  const supabaseAdmin = createSupabaseAdmin(c.env);
  await supabaseAdmin.auth.admin.deleteUser(targetId);

  // Then delete D1 profile
  await c.env.DB.prepare("DELETE FROM user_profiles WHERE id = ?").bind(targetId).run();
  return c.redirect("/staff/admin/staff-accounts");
});

// GET /staff/admin/activity-logs — Audit log viewer
admin.get("/staff/admin/activity-logs", async (c) => {
  const logs = await c.env.DB.prepare(
    "SELECT * FROM luggage_audit_logs ORDER BY timestamp DESC LIMIT 200"
  ).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>활동 로그</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
            <a class="staff-menu-link" href="/staff/admin/sales">매출관리</a>
            <a class="staff-menu-link" href="/staff/admin/staff-accounts">계정관리</a>
            <a class="staff-menu-link is-active" href="/staff/admin/activity-logs">활동로그</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">활동 로그</h2>
        <table>
          <tr><th>시간</th><th>주문</th><th>직원</th><th>행동</th></tr>
          {logs.results.map((l: Record<string, unknown>) => (
            <tr>
              <td>{l.timestamp as string}</td>
              <td><a href={`/staff/orders/${l.order_id as string}`}>{l.order_id as string}</a></td>
              <td>{l.staff_id as string}</td>
              <td>{l.action as string}</td>
            </tr>
          ))}
        </table>
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/completion-message — Completion message editor
admin.get("/staff/admin/completion-message", async (c) => {
  const setting = await c.env.DB.prepare(
    "SELECT setting_value FROM luggage_app_settings WHERE setting_key = 'completion_message_ko'"
  ).first<{ setting_value: string }>();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>완료 메시지</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
            <a class="staff-menu-link" href="/staff/admin/sales">매출관리</a>
            <a class="staff-menu-link" href="/staff/admin/staff-accounts">계정관리</a>
            <a class="staff-menu-link" href="/staff/admin/activity-logs">활동로그</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">접수 완료 메시지 편집</h2>
        <form method="post" action="/staff/admin/completion-message">
          <label class="field">
            <span class="field-label">한국어 메시지</span>
            <textarea class="control" name="message_ko" rows={5}>{setting?.setting_value || ""}</textarea>
          </label>
          <button class="btn btn-primary" type="submit">저장</button>
        </form>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/completion-message — Save completion message
admin.post("/staff/admin/completion-message", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);
  const messageKo = String(body.message_ko || "");

  await c.env.DB.prepare(
    `INSERT INTO luggage_app_settings (setting_key, setting_value, staff_id, updated_at)
     VALUES ('completion_message_ko', ?, ?, datetime('now'))
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = ?, staff_id = ?, updated_at = datetime('now')`
  )
    .bind(messageKo, staff.id, messageKo, staff.id)
    .run();

  return c.redirect("/staff/admin/completion-message");
});

// POST /staff/admin/retention/run — Manual retention cleanup
admin.post("/staff/admin/retention/run", async (c) => {
  const { runRetentionCleanup } = await import("../services/retention");
  const result = await runRetentionCleanup(c.env.DB, c.env.IMAGES);
  return c.json({ success: true, ...result });
});

// POST /staff/admin/extensions/run — Manual extension processing
admin.post("/staff/admin/extensions/run", async (c) => {
  const { generateExtensionOrders } = await import("../services/extension");
  const result = await generateExtensionOrders(c.env.DB);
  return c.json({ success: true, ...result });
});

// GET /staff/schedule — Work schedule
admin.get("/staff/schedule", async (c) => {
  const calendarUrl = await c.env.DB.prepare(
    "SELECT setting_value FROM luggage_app_settings WHERE setting_key = 'calendar_embed_url'"
  ).first<{ setting_value: string }>();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>근무 스케줄</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link is-active" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">근무 스케줄</h2>
        {calendarUrl?.setting_value ? (
          <iframe src={calendarUrl.setting_value} style="width:100%;height:600px;border:none" />
        ) : (
          <p class="muted">캘린더 URL이 설정되지 않았습니다.</p>
        )}
        </main>
      </body>
    </html>
  );
});

export default admin;
