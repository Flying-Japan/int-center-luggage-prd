import { Hono } from "hono";
import type { AppType, Env } from "./types";
import authRoutes from "./routes/auth";
import customerRoutes from "./routes/customer";
import staffApi from "./routes/staffApi";
import staffOrders from "./routes/staffOrders";
import opsRoutes from "./routes/operations";
import adminRoutes from "./routes/admin";
import staticRoutes from "./routes/static";
import { securityHeaders, errorHandler, notFoundHandler, createRateLimiter } from "./middleware/security";
import { staffAuth, getStaff } from "./middleware/auth";
import { runRetentionCleanup } from "./services/retention";

const app = new Hono<AppType>();

// Global security headers
app.use("*", securityHeaders);

// Global error handler
app.onError(errorHandler);

// 404 handler
app.notFound(notFoundHandler);

// Rate limiting on sensitive endpoints
app.use("/staff/login", createRateLimiter(10, 60_000));
app.use("/customer/submit", createRateLimiter(20, 60_000));

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "luggage-storage" }));

// Root redirect to customer form
app.get("/", (c) => c.redirect("/customer"));

// /admin shortcut → staff dashboard
app.get("/admin", (c) => c.redirect("/staff/dashboard"));

// Static asset routes (favicon, etc.)
app.route("/", staticRoutes);

// Auth routes (login, logout, OAuth)
app.route("/", authRoutes);

// Customer-facing routes
app.route("/", customerRoutes);

// Staff API routes (JSON)
app.route("/", staffApi);

// Staff order detail routes (HTML)
app.route("/", staffOrders);

// Operations routes (cash closing, handover, lost & found)
app.route("/", opsRoutes);

// Admin routes (sales, accounts, settings, logs)
app.route("/", adminRoutes);

// Staff dashboard (safe JSX rendering — no dangerouslySetInnerHTML)
app.get("/staff/dashboard", staffAuth, async (c) => {
  const staff = getStaff(c);

  // Parse query params for search/filter
  const q = c.req.query("q") || "";
  const statusFilters = c.req.queries("status_filter") || [];

  let sql = "SELECT order_id, name, tag_no, status, prepaid_amount, created_at, expected_pickup_at, note FROM luggage_orders WHERE 1=1";
  const params: string[] = [];

  if (statusFilters.length > 0) {
    sql += ` AND status IN (${statusFilters.map(() => "?").join(",")})`;
    params.push(...statusFilters);
  }

  if (q) {
    sql += " AND (name LIKE ? OR order_id LIKE ? OR tag_no LIKE ? OR phone LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  sql += " ORDER BY created_at ASC LIMIT 100";

  // Run order list and counts in parallel
  const [orders, countsResult] = await Promise.all([
    c.env.DB.prepare(sql)
      .bind(...params)
      .all<{ order_id: string; name: string | null; tag_no: string | null; status: string; prepaid_amount: number; created_at: string; expected_pickup_at: string | null; note: string | null }>(),
    c.env.DB.prepare(
      `SELECT
        SUM(CASE WHEN status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status = 'PICKED_UP' THEN 1 ELSE 0 END) as picked_up_count,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled_count,
        COUNT(*) as total_count
      FROM luggage_orders`
    ).first<{ pending_count: number; paid_count: number; picked_up_count: number; cancelled_count: number; total_count: number }>(),
  ]);

  const counts = countsResult || { pending_count: 0, paid_count: 0, picked_up_count: 0, cancelled_count: 0, total_count: 0 };

  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>직원 대시보드</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="staff-site">
        <header class="topbar">
          <div class="topbar-inner">
            <a class="brand" href="/staff/dashboard">
              <img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" />
              <span>Flying Japan Staff</span>
            </a>
            <nav class="pill-nav">
              <a class="pill-link pill-link-strong" href="/staff/dashboard">대시보드</a>
              {staff.role === "admin" && (
                <a class="pill-link" href="/staff/admin/sales">매출관리</a>
              )}
              <span class="pill-user">{staff.display_name || staff.username}</span>
              <form method="post" action="/staff/logout" style="display:inline">
                <button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button>
              </form>
            </nav>
          </div>
        </header>

        <main class="container">
          <section class="hero hero-row">
            <div>
              <p class="hero-kicker">Operations</p>
              <h2 class="hero-title">직원 대시보드</h2>
              <p class="hero-desc">{staff.display_name || staff.username} ({staff.role === "admin" ? "ADMIN" : "STAFF"}) · 전체 {counts.total_count}건</p>
            </div>
          </section>

          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link is-active" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
            {staff.role === "admin" && (
              <>
                <a class="staff-menu-link" href="/staff/admin/sales">매출관리</a>
                <a class="staff-menu-link" href="/staff/admin/staff-accounts">계정관리</a>
                <a class="staff-menu-link" href="/staff/admin/activity-logs">활동로그</a>
              </>
            )}
          </nav>

          <section class="card">
            <h3 class="card-title">접수 검색</h3>
            <form id="staff-search-form" method="get" action="/staff/dashboard" class="staff-search-form">
              <div class="field">
                <span class="field-label">상태 (복수 선택)</span>
                <div class="status-filter-buttons" id="status-filter-buttons">
                  <label class="status-filter-chip">
                    <input class="status-filter-input" type="checkbox" name="status_filter" value="PAYMENT_PENDING" checked={statusFilters.includes("PAYMENT_PENDING")} />
                    <span>결제대기 ({counts.pending_count})</span>
                  </label>
                  <label class="status-filter-chip">
                    <input class="status-filter-input" type="checkbox" name="status_filter" value="PAID" checked={statusFilters.includes("PAID")} />
                    <span>결제완료 ({counts.paid_count})</span>
                  </label>
                  <label class="status-filter-chip">
                    <input class="status-filter-input" type="checkbox" name="status_filter" value="PICKED_UP" checked={statusFilters.includes("PICKED_UP")} />
                    <span>수령완료 ({counts.picked_up_count})</span>
                  </label>
                  <label class="status-filter-chip">
                    <input class="status-filter-input" type="checkbox" name="status_filter" value="CANCELLED" checked={statusFilters.includes("CANCELLED")} />
                    <span>취소 ({counts.cancelled_count})</span>
                  </label>
                </div>
              </div>

              <div class="staff-search-row">
                <label class="field">
                  <span class="field-label">검색</span>
                  <input id="search-q" class="control" type="text" name="q" value={q} placeholder="이름, 접수번호, 전화, 짐번호" autocomplete="off" />
                </label>
                <label class="button-wrap staff-search-button-wrap">
                  <span class="field-label sr-only">조회</span>
                  <button class="btn btn-primary" type="submit">조회</button>
                </label>
              </div>
            </form>

            <p class="card-desc">접수 순서대로(오래된 순) 정렬됩니다.</p>

            <div class="table-wrap">
              <table id="staff-orders-table">
                <colgroup>
                  <col data-col-key="name" />
                  <col data-col-key="tag_no" />
                  <col data-col-key="created_time" />
                  <col data-col-key="price" />
                  <col data-col-key="pickup_time" />
                  <col data-col-key="status" />
                  <col data-col-key="note" />
                  <col data-col-key="detail" />
                </colgroup>
                <thead>
                  <tr>
                    <th data-col-key="name">이름</th>
                    <th data-col-key="tag_no">짐번호</th>
                    <th data-col-key="created_time">접수 시각</th>
                    <th data-col-key="price">짐보관가격</th>
                    <th data-col-key="pickup_time">짐 찾는 시각</th>
                    <th data-col-key="status">상태</th>
                    <th data-col-key="note">비고</th>
                    <th data-col-key="detail">상세</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.results.map((o) => (
                    <tr data-order-id={o.order_id}>
                      <td data-col-key="name">{o.name || "-"}</td>
                      <td data-col-key="tag_no">{o.tag_no || "-"}</td>
                      <td data-col-key="created_time">{o.created_at ? new Date(o.created_at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td data-col-key="price">{`¥${o.prepaid_amount}`}</td>
                      <td data-col-key="pickup_time">{o.expected_pickup_at ? new Date(o.expected_pickup_at).toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td data-col-key="status">{o.status}</td>
                      <td data-col-key="note">{o.note || ""}</td>
                      <td data-col-key="detail"><a class="btn btn-secondary btn-sm" href={`/staff/orders/${o.order_id}`}>상세</a></td>
                    </tr>
                  ))}
                  {orders.results.length === 0 && (
                    <tr><td colspan={8}>데이터가 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </body>
    </html>
  );
});

// Scheduled event handler (retention cleanup)
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        console.log(`Scheduled retention cleanup triggered: ${event.cron}`);
        const result = await runRetentionCleanup(env.DB, env.IMAGES);
        console.log(`Retention cleanup complete: ${JSON.stringify(result)}`);
      })()
    );
  },
};
