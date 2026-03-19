/**
 * Admin routes — Sales analytics, staff accounts, settings, activity logs.
 * US-012: All admin-only routes.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { adminAuth, getStaff } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { formatDateJST, nowJST } from "../services/storage";

const admin = new Hono<AppType>();
admin.use("/*", adminAuth);

// GET /staff/admin/sales — Sales analytics
admin.get("/staff/admin/sales", async (c) => {
  const today = formatDateJST(nowJST());
  const startDate = c.req.query("start_date") || "";
  const endDate = c.req.query("end_date") || "";

  // Build date filter
  let dateFilter = "";
  const dateParams: string[] = [];
  if (startDate && endDate) {
    dateFilter = " AND date(created_at, '+9 hours') BETWEEN ? AND ?";
    dateParams.push(startDate, endDate);
  } else {
    dateFilter = " AND date(created_at, '+9 hours') >= date('now', '-30 days')";
  }

  // Daily sales + summary in parallel
  const [dailySales, summary, rentalSales] = await Promise.all([
    c.env.DB.prepare(
      `SELECT date(created_at, '+9 hours') as sale_date,
         COUNT(*) as order_count,
         SUM(CASE WHEN payment_method = 'CASH' THEN prepaid_amount + extra_amount ELSE 0 END) as cash_total,
         SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as qr_total,
         SUM(prepaid_amount + extra_amount) as grand_total
       FROM luggage_orders
       WHERE status IN ('PAID', 'PICKED_UP')${dateFilter}
       GROUP BY date(created_at, '+9 hours')
       ORDER BY sale_date DESC`
    ).bind(...dateParams).all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as total_orders,
         SUM(prepaid_amount + extra_amount) as total_revenue,
         SUM(CASE WHEN payment_method = 'CASH' THEN prepaid_amount + extra_amount ELSE 0 END) as total_cash,
         SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as total_qr
       FROM luggage_orders
       WHERE status IN ('PAID', 'PICKED_UP')${dateFilter}`
    ).bind(...dateParams).first<{ total_orders: number; total_revenue: number; total_cash: number; total_qr: number }>(),
    c.env.DB.prepare(
      startDate && endDate
        ? "SELECT * FROM luggage_rental_daily_sales WHERE business_date BETWEEN ? AND ? ORDER BY business_date DESC"
        : "SELECT * FROM luggage_rental_daily_sales ORDER BY business_date DESC LIMIT 30"
    ).bind(...(startDate && endDate ? [startDate, endDate] : [])).all(),
  ]);

  const s = summary || { total_orders: 0, total_revenue: 0, total_cash: 0, total_qr: 0 };
  const dayCount = dailySales.results.length || 1;

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
            <a class="staff-menu-link" href="/staff/admin/completion-message">완료메시지</a>
          </nav>
        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">매출 분석</h2>

        <section class="card">
          <form method="get" action="/staff/admin/sales" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label class="field"><span class="field-label">시작일</span><input class="control" type="date" name="start_date" value={startDate} /></label>
            <label class="field"><span class="field-label">종료일</span><input class="control" type="date" name="end_date" value={endDate} /></label>
            <button class="btn btn-primary" type="submit">조회</button>
            <a class="btn btn-secondary" href="/staff/admin/sales">초기화</a>
          </form>
        </section>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:16px 0">
          <div class="card" style="padding:12px;text-align:center">
            <p style="font-size:11px;color:#787774;margin:0">총매출</p>
            <p style="font-size:18px;font-weight:700;margin:4px 0 0">¥{s.total_revenue}</p>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <p style="font-size:11px;color:#787774;margin:0">총건수</p>
            <p style="font-size:18px;font-weight:700;margin:4px 0 0">{s.total_orders}건</p>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <p style="font-size:11px;color:#787774;margin:0">일평균</p>
            <p style="font-size:18px;font-weight:700;margin:4px 0 0">¥{Math.round(s.total_revenue / dayCount)}</p>
          </div>
          <div class="card" style="padding:12px;text-align:center">
            <p style="font-size:11px;color:#787774;margin:0">현금 / QR</p>
            <p style="font-size:14px;font-weight:600;margin:4px 0 0">¥{s.total_cash} / ¥{s.total_qr}</p>
          </div>
        </div>

        <section class="card">
        <h3 class="card-title">짐보관 일별 매출</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:2px solid var(--line)"><th style="text-align:left;padding:6px 8px">날짜</th><th style="text-align:right;padding:6px 8px">건수</th><th style="text-align:right;padding:6px 8px">현금</th><th style="text-align:right;padding:6px 8px">QR</th><th style="text-align:right;padding:6px 8px">합계</th></tr></thead>
          <tbody>
          {dailySales.results.map((d: Record<string, unknown>) => (
            <tr style="border-bottom:1px solid var(--line)">
              <td style="padding:4px 8px">{d.sale_date as string}</td>
              <td style="padding:4px 8px;text-align:right">{d.order_count as number}</td>
              <td style="padding:4px 8px;text-align:right">¥{d.cash_total as number}</td>
              <td style="padding:4px 8px;text-align:right">¥{d.qr_total as number}</td>
              <td style="padding:4px 8px;text-align:right;font-weight:600">¥{d.grand_total as number}</td>
            </tr>
          ))}
          </tbody>
        </table>
        </section>

        <section class="card">
        <h3 class="card-title">렌탈 일별 매출</h3>
        <form method="post" action="/staff/admin/sales/rental" class="grid2" style="margin-bottom:12px">
          <label class="field"><span class="field-label">날짜</span><input class="control" type="date" name="business_date" value={today} required /></label>
          <label class="field"><span class="field-label">매출 (¥)</span><input class="control" type="number" name="revenue_amount" placeholder="0" required /></label>
          <label class="field"><span class="field-label">고객수</span><input class="control" type="number" name="customer_count" value="0" /></label>
          <label class="field"><span class="field-label">메모</span><input class="control" type="text" name="note" placeholder="메모" /></label>
          <label class="button-wrap"><span class="field-label sr-only">등록</span><button class="btn btn-primary" type="submit">등록</button></label>
        </form>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:2px solid var(--line)"><th style="text-align:left;padding:6px 8px">날짜</th><th style="text-align:right;padding:6px 8px">매출</th><th style="text-align:right;padding:6px 8px">고객수</th><th style="text-align:left;padding:6px 8px">메모</th></tr></thead>
          <tbody>
          {rentalSales.results.map((r: Record<string, unknown>) => (
            <tr style="border-bottom:1px solid var(--line)">
              <td style="padding:4px 8px">{r.business_date as string}</td>
              <td style="padding:4px 8px;text-align:right;font-weight:600">¥{r.revenue_amount as number}</td>
              <td style="padding:4px 8px;text-align:right">{r.customer_count as number}</td>
              <td style="padding:4px 8px">{(r.note as string) || "-"}</td>
            </tr>
          ))}
          </tbody>
        </table>
        </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/sales/rental — Create/upsert rental daily sales
admin.post("/staff/admin/sales/rental", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const bizDate = String(body.business_date);
  const revenueAmount = parseInt(String(body.revenue_amount || "0"), 10);
  const customerCount = parseInt(String(body.customer_count || "0"), 10);
  const note = String(body.note || "") || null;

  // Check if entry exists for this date — update instead of creating duplicate
  const existing = await c.env.DB.prepare(
    "SELECT rental_id FROM luggage_rental_daily_sales WHERE business_date = ?"
  ).bind(bizDate).first<{ rental_id: number }>();

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE luggage_rental_daily_sales SET revenue_amount = ?, customer_count = ?, note = ?, staff_id = ?, updated_at = datetime('now') WHERE rental_id = ?"
    ).bind(revenueAmount, customerCount, note, staff.id, existing.rental_id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO luggage_rental_daily_sales (business_date, revenue_amount, customer_count, note, staff_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(bizDate, revenueAmount, customerCount, note, staff.id).run();
  }

  return c.redirect("/staff/admin/sales");
});

// GET /staff/admin/staff-accounts — Staff account management
admin.get("/staff/admin/staff-accounts", async (c) => {
  const accounts = await c.env.DB.prepare(
    "SELECT * FROM user_profiles ORDER BY is_active DESC, created_at DESC"
  ).all();

  const staff = getStaff(c);
  const focusId = c.req.query("focus");
  const errorMsg = c.req.query("error");
  const successMsg = c.req.query("success");

  const activeAccounts = accounts.results.filter((a: Record<string, unknown>) => a.is_active as number);
  const inactiveAccounts = accounts.results.filter((a: Record<string, unknown>) => !(a.is_active as number));
  const adminCount = accounts.results.filter((a: Record<string, unknown>) => (a.role as string) === "admin" && (a.is_active as number)).length;

  const AccountRow = ({ a, isOpen }: { a: Record<string, unknown>; isOpen: boolean }) => {
    const name = (a.display_name as string) || (a.username as string) || "?";
    const initial = name[0].toUpperCase();
    const isMe = a.id === staff.id;
    const isActive = a.is_active as number;
    const isAdmin = (a.role as string) === "admin";
    const created = a.created_at ? new Date(a.created_at as string).toISOString().slice(0, 10) : "-";

    return (<>
      <tr class={`acct-row${!isActive ? " acct-row--dim" : ""}`}>
        <td class="acct-td">
          <div class="acct-name-cell">
            <span class={`acct-avatar${isAdmin ? " acct-avatar--admin" : ""}`}>{initial}</span>
            <div>
              <span class="acct-name">{name}{isMe && <span class="acct-me">나</span>}</span>
              <span class="acct-email">{(a.username as string) || (a.email as string) || ""}</span>
            </div>
          </div>
        </td>
        <td class="acct-td"><span class={`acct-badge${isAdmin ? " acct-badge--admin" : ""}`}>{isAdmin ? "관리자" : "직원"}</span></td>
        <td class="acct-td"><span class={`acct-status${isActive ? " acct-status--on" : " acct-status--off"}`}>{isActive ? "활성" : "잠금"}</span></td>
        <td class="acct-td acct-td--date">{created}</td>
        <td class="acct-td acct-td--actions">
          <div class="acct-menu-wrap">
            <button class="acct-menu-btn" type="button" aria-label="메뉴">&#x22EF;</button>
            <div class="acct-dropdown">
              <button class="acct-dropdown-item acct-edit-toggle" type="button" data-panel={`acct-panel-${a.id}`}>수정</button>
              <form method="post" action={`/staff/admin/staff-accounts/${a.id}/toggle-active`}>
                <button class={`acct-dropdown-item${!isActive ? " acct-dropdown-item--green" : ""}`} type="submit">{isActive ? "잠금" : "복구"}</button>
              </form>
              {!isMe && (<>
                <div class="acct-dropdown-divider" />
                <form method="post" action={`/staff/admin/staff-accounts/${a.id}/delete`} onsubmit="return confirm('정말 삭제할까요? 되돌릴 수 없습니다.')">
                  <button class="acct-dropdown-item acct-dropdown-item--danger" type="submit">삭제</button>
                </form>
              </>)}
            </div>
          </div>
        </td>
      </tr>
      <tr class="acct-panel-row">
        <td colspan={5} style="padding:0;border:none">
          <div id={`acct-panel-${a.id}`} class={`acct-edit-panel${!isOpen ? " is-collapsed" : ""}`}>
            <form method="post" action={`/staff/admin/staff-accounts/${a.id}/update`} class="acct-edit-form">
              <label class="field"><span class="field-label">표시 이름</span><input class="control" type="text" name="display_name" value={(a.display_name as string) || ""} required /></label>
              <label class="field"><span class="field-label">권한</span>
                <select class="control" name="role">
                  <option value="staff" selected={(a.role as string) === "staff"}>직원</option>
                  <option value="admin" selected={(a.role as string) === "admin"}>관리자</option>
                </select>
              </label>
              <div class="acct-edit-actions">
                <button class="btn btn-primary btn-sm" type="submit">저장</button>
                <button class="btn btn-sm acct-edit-cancel" type="button">취소</button>
              </div>
            </form>
          </div>
        </td>
      </tr>
    </>);
  };

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>직원 계정</title>
      <style>{`
.acct-header{display:flex;align-items:baseline;gap:12px;margin-bottom:4px}
.acct-count{font-size:12px;color:#a5a5a3}
.acct-row{border-bottom:1px solid #f0f0ee}
.acct-row--dim{opacity:.55}
.acct-row:hover{background:#fafaf9}
.acct-td{padding:6px 10px;font-size:13px;white-space:nowrap;vertical-align:middle}
.acct-td--date{font-size:12px;color:#a5a5a3}
.acct-td--actions{width:40px;text-align:right}
.acct-name-cell{display:flex;align-items:center;gap:8px}
.acct-avatar{width:28px;height:28px;border-radius:50%;background:#e8edf3;color:#5a6a7e;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.acct-avatar--admin{background:#fef2f2;color:#991b1b}
.acct-name{font-size:13px;font-weight:500;color:#37352f;display:block;line-height:1.3}
.acct-me{font-size:10px;color:#2383e2;margin-left:4px;font-weight:400}
.acct-email{font-size:11px;color:#a5a5a3;display:block;line-height:1.2}
.acct-badge{font-size:10px;padding:2px 7px;border-radius:3px;background:#f0f0ee;color:#6b6b69;font-weight:500}
.acct-badge--admin{background:#fef2f2;color:#991b1b}
.acct-status{font-size:11px;font-weight:500}
.acct-status--on{color:#166534}
.acct-status--off{color:#991b1b}
.acct-menu-wrap{position:relative;display:inline-block}
.acct-menu-btn{background:none;border:none;cursor:pointer;font-size:16px;color:#a5a5a3;padding:2px 6px;border-radius:4px;line-height:1}
.acct-menu-btn:hover{background:#f0f0ee;color:#37352f}
.acct-dropdown{display:none;position:absolute;right:0;top:100%;z-index:50;min-width:100px;background:#fff;border:1px solid #e5e5e5;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.08);padding:4px 0}
.acct-menu-wrap.is-open .acct-dropdown{display:block}
.acct-dropdown-item{display:block;width:100%;padding:6px 14px;font-size:12px;text-align:left;background:none;border:none;cursor:pointer;color:#37352f}
.acct-dropdown-item:hover{background:#f7f7f5}
.acct-dropdown-item--green{color:#166534}
.acct-dropdown-item--danger{color:#dc2626}
.acct-dropdown-divider{height:1px;background:#f0f0ee;margin:4px 0}
.acct-edit-panel{padding:12px 10px 12px 46px;background:#fafaf9;border-bottom:1px solid #f0f0ee;overflow:hidden;transition:max-height .2s ease,opacity .2s ease;max-height:200px;opacity:1}
.acct-edit-panel.is-collapsed{max-height:0;opacity:0;padding:0 10px 0 46px;border:none}
.acct-edit-form{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.acct-edit-form .field{margin:0}
.acct-edit-form .control{font-size:13px;padding:5px 8px;min-height:32px}
.acct-edit-actions{display:flex;gap:6px;align-items:center}
.acct-edit-cancel{color:#a5a5a3}
.acct-tbl{width:100%;border-collapse:collapse}
.acct-tbl thead th{text-align:left;padding:6px 10px;font-size:11px;font-weight:600;color:#a5a5a3;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid #e5e5e5}
.acct-divider-row td{padding:16px 10px 6px;border:none}
.acct-divider-label{font-size:11px;color:#a5a5a3;font-weight:600}
.acct-create-section{padding:12px 16px}
.acct-create-grid{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.acct-create-grid .field{margin:0;min-width:140px;flex:1}
.acct-create-grid .control{font-size:13px;padding:5px 8px;min-height:32px}
@media(max-width:768px){
  .acct-create-grid{flex-direction:column}
  .acct-create-grid .field{min-width:100%}
  .acct-edit-panel{padding-left:10px}
  .acct-edit-form{flex-direction:column;align-items:stretch}
}
      `}</style>
      </head>
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
            {staff.role === "admin" && (
              <>
                <a class="staff-menu-link" href="/staff/admin/sales">매출관리</a>
                <a class="staff-menu-link is-active" href="/staff/admin/staff-accounts">계정관리</a>
                <a class="staff-menu-link" href="/staff/admin/activity-logs">활동로그</a>
              </>
            )}
          </nav>

        {errorMsg && <div style="background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:8px 14px;margin-bottom:10px;border-radius:6px;font-size:13px">{decodeURIComponent(errorMsg)}</div>}
        {successMsg && <div style="background:#f0fdf4;border:1px solid #86efac;color:#166534;padding:8px 14px;margin-bottom:10px;border-radius:6px;font-size:13px">{successMsg}</div>}

        <section class="card">
          <div class="acct-create-section">
            <div class="acct-header">
              <h3 class="card-title" style="margin:0;font-size:14px">새 계정</h3>
            </div>
            <form method="post" action="/staff/admin/staff-accounts" class="acct-create-grid" style="margin-top:8px">
              <label class="field"><span class="field-label">이름</span><input class="control" type="text" id="create-name" name="display_name" placeholder="홍길동" required /></label>
              <label class="field"><span class="field-label">이메일</span>
                <div style="display:flex;align-items:center;gap:0">
                  <input class="control" type="text" id="create-email" name="email" placeholder="이름 입력 시 자동 생성" style="border-radius:6px 0 0 6px;border-right:none" required />
                  <span style="padding:5px 8px;font-size:12px;color:#a5a5a3;background:#f7f7f5;border:1px solid #e5e5e5;border-radius:0 6px 6px 0;white-space:nowrap">@center.local</span>
                </div>
              </label>
              <label class="field"><span class="field-label">비밀번호</span>
                <div style="display:flex;gap:6px">
                  <input class="control" type="text" id="create-pw" name="password" style="flex:1" required />
                  <button class="btn btn-sm btn-secondary" type="button" id="gen-pw-btn" style="white-space:nowrap">생성</button>
                </div>
              </label>
              <label class="field"><span class="field-label">권한</span>
                <select class="control" name="role">
                  <option value="staff" selected>직원</option>
                  <option value="admin">관리자</option>
                </select>
              </label>
              <button class="btn btn-primary btn-sm" type="submit">계정 생성</button>
            </form>
          </div>
        </section>

        <section class="card">
          <div style="padding:10px 16px 0">
            <div class="acct-header">
              <h3 class="card-title" style="margin:0;font-size:14px">계정 목록</h3>
              <span class="acct-count">{accounts.results.length}명 · 활성 {activeAccounts.length}명 · 관리자 {adminCount}명</span>
            </div>
          </div>
          <table class="acct-tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>권한</th>
                <th>상태</th>
                <th>생성일</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {activeAccounts.map((a: Record<string, unknown>) => (
                <AccountRow a={a} isOpen={String(a.id) === focusId} />
              ))}
              {inactiveAccounts.length > 0 && (<>
                <tr class="acct-divider-row"><td colspan={5}><span class="acct-divider-label">잠금 계정 ({inactiveAccounts.length})</span></td></tr>
                {inactiveAccounts.map((a: Record<string, unknown>) => (
                  <AccountRow a={a} isOpen={String(a.id) === focusId} />
                ))}
              </>)}
            </tbody>
          </table>
        </section>
        </main>
        <script dangerouslySetInnerHTML={{__html: `(function(){
  document.querySelectorAll(".acct-menu-btn").forEach(function(b){
    b.addEventListener("click",function(e){
      e.stopPropagation();
      var w=b.closest(".acct-menu-wrap"),o=w.classList.contains("is-open");
      document.querySelectorAll(".acct-menu-wrap.is-open").forEach(function(x){x.classList.remove("is-open")});
      if(!o)w.classList.add("is-open");
    });
  });
  document.addEventListener("click",function(){document.querySelectorAll(".acct-menu-wrap.is-open").forEach(function(x){x.classList.remove("is-open")})});
  document.querySelectorAll(".acct-edit-toggle").forEach(function(b){
    b.addEventListener("click",function(){
      var p=document.getElementById(b.dataset.panel);if(!p)return;
      p.classList.toggle("is-collapsed");
      var w=b.closest(".acct-menu-wrap");if(w)w.classList.remove("is-open");
    });
  });
  document.querySelectorAll(".acct-edit-cancel").forEach(function(b){
    b.addEventListener("click",function(){
      var p=b.closest(".acct-edit-panel");if(p)p.classList.add("is-collapsed");
    });
  });
  var I=['g','kk','n','d','tt','r','m','b','pp','s','ss','','j','jj','ch','k','t','p','h'];
  var M=['a','ae','ya','yae','eo','e','yeo','ye','o','wa','wae','oe','yo','u','wo','we','wi','yu','eu','ui','i'];
  var F=['','k','k','ks','n','nj','nh','t','l','lk','lm','lp','ls','lt','lp','lh','m','p','ps','t','t','ng','t','t','k','t','p','h'];
  function rom(s){var r='';for(var i=0;i<s.length;i++){var c=s.charCodeAt(i);if(c>=0xAC00&&c<=0xD7A3){var o=c-0xAC00;r+=I[Math.floor(o/588)]+M[Math.floor((o%588)/28)]+F[o%28];}else{r+=s[i];}}return r;}
  var nm=document.getElementById('create-name'),em=document.getElementById('create-email'),edited=false;
  if(em){em.addEventListener('input',function(){edited=true;});}
  if(nm){nm.addEventListener('input',function(){
    if(edited)return;var n=nm.value.trim();if(n.length<2){em.value='';return;}
    em.value=rom(n.slice(1))+'.'+rom(n.charAt(0));
  });}
  var pb=document.getElementById('gen-pw-btn');
  if(pb){pb.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    var ch='abcdefghijklmnopqrstuvwxyz0123456789',pw='';
    for(var i=0;i<10;i++){pw+=ch[Math.floor(Math.random()*ch.length)];}
    document.getElementById('create-pw').value=pw;
  });}
})()`}} />
      </body>
    </html>
  );
});

// POST /staff/admin/staff-accounts — Create staff account
admin.post("/staff/admin/staff-accounts", async (c) => {
  const body = await c.req.parseBody();
  const rawEmail = String(body.email || "").trim();
  const email = rawEmail.includes("@") ? rawEmail : `${rawEmail}@center.local`;
  const password = String(body.password || "").trim();
  const displayName = String(body.display_name || "").trim();
  const role = String(body.role || "staff");

  if (!rawEmail || !password || !displayName) {
    return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("모든 항목을 입력해주세요."));
  }
  if (password.length < 6) {
    return c.redirect("/staff/admin/staff-accounts?error=" + encodeURIComponent("비밀번호는 6자리 이상 입력해주세요."));
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

  // Create profile in D1 — rollback Supabase user on failure
  try {
    await c.env.DB.prepare(
      "INSERT INTO user_profiles (id, display_name, username, email, role, is_active) VALUES (?, ?, ?, ?, ?, 1)"
    )
      .bind(data.user.id, displayName, email.split("@")[0], email, role)
      .run();
  } catch (e) {
    try {
      await supabaseAdmin.auth.admin.deleteUser(data.user.id);
    } catch { /* rollback best-effort */ }
    return c.redirect(`/staff/admin/staff-accounts?error=${encodeURIComponent("프로필 생성 실패 — 계정이 롤백되었습니다")}`);
  }

  return c.redirect("/staff/admin/staff-accounts?success=계정이 생성되었습니다");
});

// POST /staff/admin/staff-accounts/:id/toggle-active
admin.post("/staff/admin/staff-accounts/:id/toggle-active", async (c) => {
  const targetId = c.req.param("id");
  const staff = getStaff(c);

  if (targetId === staff.id) {
    return c.redirect("/staff/admin/staff-accounts?error=자신의 계정은 비활성화할 수 없습니다");
  }

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

// Action labels for Korean display
const ACTION_LABELS: Record<string, string> = {
  INLINE_UPDATE: "수정", TOGGLE_PAYMENT: "결제변경", PICKUP: "수령완료",
  UNDO_PICKUP: "수령취소", CANCEL: "취소", TOGGLE_WAREHOUSE: "창고",
  UPDATE_PRICE: "요금변경", MARK_PAID: "결제완료", MARK_PICKED_UP: "수령완료",
  UNDO_PICKED_UP: "수령취소", MANUAL_CREATE: "수기접수", UPDATE: "수정",
  VIEW_ID_IMAGE: "신분증조회", VIEW_LUGGAGE_IMAGE: "짐사진조회",
  VIEW_ID: "신분증조회", VIEW_LUGGAGE: "짐사진조회",
  CREATE_EXTENSION: "연장접수",
  BULK_CANCEL: "일괄취소", BULK_MARK_PAID: "일괄결제",
};

// GET /staff/admin/activity-logs — Audit log viewer
admin.get("/staff/admin/activity-logs", async (c) => {
  const logs = await c.env.DB.prepare(
    `SELECT a.*, COALESCE(u.display_name, u.username) as staff_name
     FROM luggage_audit_logs a
     LEFT JOIN user_profiles u ON a.staff_id = u.id
     ORDER BY a.timestamp DESC LIMIT 200`
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
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:2px solid var(--line)">
              <th style="text-align:left;padding:6px 8px">시간</th>
              <th style="text-align:left;padding:6px 8px">주문</th>
              <th style="text-align:left;padding:6px 8px">직원</th>
              <th style="text-align:left;padding:6px 8px">행동</th>
              <th style="text-align:left;padding:6px 8px">상세</th>
            </tr>
          </thead>
          <tbody>
          {logs.results.map((l: Record<string, unknown>) => (
            <tr style="border-bottom:1px solid var(--line)">
              <td style="padding:4px 8px;white-space:nowrap">{l.timestamp ? new Date(l.timestamp as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
              <td style="padding:4px 8px"><a href={`/staff/orders/${l.order_id as string}`} style="color:var(--primary)">{l.order_id as string}</a></td>
              <td style="padding:4px 8px">{(l.staff_name as string) || (l.staff_id as string) || "-"}</td>
              <td style="padding:4px 8px"><span class="status-pill" style="font-size:10px">{ACTION_LABELS[l.action as string] || (l.action as string)}</span></td>
              <td style="padding:4px 8px;color:#666">{(l.details as string) || "-"}</td>
            </tr>
          ))}
          </tbody>
        </table>
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/completion-message — Completion message editor
admin.get("/staff/admin/completion-message", async (c) => {
  const setting = await c.env.DB.prepare(
    "SELECT setting_value FROM luggage_app_settings WHERE setting_key = 'customer_success_primary_message_ko'"
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
            <a class="staff-menu-link" href="/staff/admin/completion-message">완료메시지</a>
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
     VALUES ('customer_success_primary_message_ko', ?, ?, datetime('now'))
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

export default admin;
