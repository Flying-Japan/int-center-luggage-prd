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
import { runMidnightRollover } from "./services/midnightRollover";
import { syncDailySales } from "./services/dailySalesSync";
import { syncRentalRevenue } from "./services/rentalRevenueSync";
import { tagColorClass, TAG_COLOR_RANGES } from "./lib/tagColors";
import { StaffTopbar, NewOrderAlert } from "./lib/components";
import { fetchStaffNamesByIds } from "./lib/staffProfiles";

const app = new Hono<AppType>();

// Global security headers
app.use("*", securityHeaders);

// Global error handler
app.onError(errorHandler);

// 404 handler
app.notFound(notFoundHandler);

// Rate limiting on sensitive endpoints
app.post("/staff/login", createRateLimiter(10, 60_000));
app.post("/customer/submit", createRateLimiter(20, 60_000));

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
  const status = c.req.query("status") || "UNPICKED";
  const showAllPickedUp = c.req.query("show_all_picked_up") === "true";
  const dateFrom = c.req.query("date_from") || "";
  const dateTo = c.req.query("date_to") || "";
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const pageSize = 100;

  // Build counts WHERE clause (date + search only, no status filter)
  // so badge counts show per-status breakdown within current date/search context
  let countsWhere = "WHERE 1=1";
  const countsParams: string[] = [];
  const like = q ? `%${q}%` : "";

  if (q) {
    countsWhere += " AND (name LIKE ? OR order_id LIKE ? OR tag_no LIKE ? OR phone LIKE ?)";
    countsParams.push(like, like, like, like);
  }
  if (dateFrom) {
    countsWhere += " AND created_at >= ?";
    countsParams.push(dateFrom + " 00:00:00");
  }
  if (dateTo) {
    countsWhere += " AND created_at <= ?";
    countsParams.push(dateTo + " 23:59:59");
  }

  // Build shared WHERE clause and params (used for both count and list queries)
  let whereClause = "WHERE 1=1";
  const params: string[] = [];

  if (status === "UNPICKED") {
    whereClause += " AND o.status IN ('PAYMENT_PENDING', 'PAID')";
  } else if (status === "ALL") {
    // 전체 = show all except cancelled (unless full history mode)
    if (!showAllPickedUp) {
      whereClause += " AND o.status != 'CANCELLED'";
    }
  } else {
    whereClause += " AND o.status = ?";
    params.push(status);
  }

  if (q) {
    whereClause += " AND (o.name LIKE ? OR o.order_id LIKE ? OR o.tag_no LIKE ? OR o.phone LIKE ?)";
    params.push(like, like, like, like);
  }

  // Hide old PICKED_UP orders (>2 days) unless show_all_picked_up is set or date filter is active
  if (!showAllPickedUp && !dateFrom && !dateTo && (status === "ALL" || status === "PICKED_UP")) {
    whereClause += " AND (o.status != 'PICKED_UP' OR o.created_at >= datetime('now', '-2 days'))";
  }

  if (dateFrom) {
    whereClause += " AND o.created_at >= ?";
    params.push(dateFrom + " 00:00:00");
  }
  if (dateTo) {
    whereClause += " AND o.created_at <= ?";
    params.push(dateTo + " 23:59:59");
  }

  const countSql = `SELECT COUNT(*) as total FROM luggage_orders o ${whereClause}`;

  const sql = `WITH note_edits AS (
      SELECT a.order_id,
             a.staff_id as note_staff_id,
             a.timestamp as note_updated_at,
             ROW_NUMBER() OVER (PARTITION BY a.order_id ORDER BY a.timestamp DESC) as rn
      FROM luggage_audit_logs a
      WHERE a.action = 'INLINE_UPDATE' AND a.details LIKE '%비고%'
    )
    SELECT o.order_id, o.name, o.tag_no, o.status, o.prepaid_amount, o.created_at, o.expected_pickup_at, o.note, o.payment_method, o.in_warehouse, o.parent_order_id, o.flying_pass_tier,
           ne.note_staff_id, ne.note_updated_at
    FROM luggage_orders o
    LEFT JOIN note_edits ne ON ne.order_id = o.order_id AND ne.rn = 1
    ${whereClause}
    ORDER BY o.created_at ASC LIMIT ? OFFSET ?`;

  // Get today's referral counts
  const nowJSTRef = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayRef = nowJSTRef.toISOString().slice(0, 10);

  // Run order list, counts, filtered count, and referral counts in parallel
  const [orders, countsResult, filteredCountResult, refRows] = await Promise.all([
    c.env.DB.prepare(sql)
      .bind(...params, pageSize, (page - 1) * pageSize)
      .all<{ order_id: string; name: string | null; tag_no: string | null; status: string; prepaid_amount: number; created_at: string; expected_pickup_at: string | null; note: string | null; payment_method: string | null; in_warehouse: number; parent_order_id: string | null; flying_pass_tier: string | null; note_staff_id: string | null; note_updated_at: string | null }>(),
    c.env.DB.prepare(
      `SELECT
        SUM(CASE WHEN status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status = 'PICKED_UP' AND created_at >= datetime('now', '-2 days') THEN 1 ELSE 0 END) as picked_up_count,
        SUM(CASE WHEN status = 'PICKED_UP' THEN 1 ELSE 0 END) as picked_up_all_count,
        SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled_count,
        COUNT(*) as total_count
      FROM luggage_orders ${countsWhere}`
    ).bind(...countsParams).first<{ pending_count: number; paid_count: number; picked_up_count: number; picked_up_all_count: number; cancelled_count: number; total_count: number }>(),
    c.env.DB.prepare(countSql).bind(...params).first<{ total: number }>(),
    c.env.DB.prepare("SELECT floor, count FROM luggage_referral_counts WHERE business_date = ?").bind(todayRef).all<{ floor: string; count: number }>(),
  ]);

  const counts = countsResult || { pending_count: 0, paid_count: 0, picked_up_count: 0, picked_up_all_count: 0, cancelled_count: 0, total_count: 0 };
  const totalFiltered = filteredCountResult?.total ?? 0;
  const totalPages = Math.ceil(totalFiltered / pageSize);
  const refCounts: Record<string, number> = { "4F": 0, "8F": 0 };
  for (const r of refRows.results) refCounts[r.floor] = r.count;
  const noteAuthorMap = await fetchStaffNamesByIds(c.env, orders.results.map((order) => order.note_staff_id));
  const orderRows = orders.results.map((order) => ({
    ...order,
    note_author: order.note_staff_id ? noteAuthorMap.get(order.note_staff_id) || order.note_staff_id : null,
  }));

  const buildDashboardUrl = (s: string, extra?: Record<string, string>) => {
    const u = new URLSearchParams();
    u.set("status", s);
    if (dateFrom) u.set("date_from", dateFrom);
    if (dateTo) u.set("date_to", dateTo);
    if (q) u.set("q", q);
    if (extra) for (const [k, v] of Object.entries(extra)) u.set(k, v);
    return `/staff/dashboard?${u.toString()}`;
  };

  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>짐보관 신청</title>
        <link rel="stylesheet" href="/static/styles.css?v=20260415" />
      </head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/dashboard" />

        <main class="container">
          <section class="hero hero-row">
            <div>
              <p class="hero-kicker">Operations</p>
              <h2 class="hero-title">짐보관 신청</h2>
              <p class="hero-desc">{staff.display_name || staff.username} ({({ admin: "ADMIN", editor: "EDITOR" } as Record<string, string>)[staff.role] || "VIEWER"}) · 전체 {counts.total_count}건</p>
            </div>
          </section>

          <section style="display:flex;gap:12px;margin-bottom:8px">
            <div style="flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between">
              <div><span style="font-size:11px;color:#64748b;font-weight:600">4F 안내</span><span id="ref-4f" style="font-size:20px;font-weight:800;margin-left:8px;color:#1e293b">{refCounts["4F"]}</span><span style="font-size:11px;color:#64748b">팀</span></div>
              <div style="display:flex;gap:4px">
                <button class="btn btn-sm" style="padding:2px 10px;font-size:14px" onclick="refBtn('4F',-1)">−</button>
                <button class="btn btn-primary btn-sm" style="padding:2px 10px;font-size:14px" onclick="refBtn('4F',1)">+</button>
              </div>
            </div>
            <div style="flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between">
              <div><span style="font-size:11px;color:#64748b;font-weight:600">8F 안내</span><span id="ref-8f" style="font-size:20px;font-weight:800;margin-left:8px;color:#1e293b">{refCounts["8F"]}</span><span style="font-size:11px;color:#64748b">팀</span></div>
              <div style="display:flex;gap:4px">
                <button class="btn btn-sm" style="padding:2px 10px;font-size:14px" onclick="refBtn('8F',-1)">−</button>
                <button class="btn btn-primary btn-sm" style="padding:2px 10px;font-size:14px" onclick="refBtn('8F',1)">+</button>
              </div>
            </div>
          </section>

          <section class="card">
            {/* Status tab bar */}
            <div style="display:flex;gap:0;border-bottom:2px solid #e2e8f0;margin-bottom:16px">
              {[
                { key: "UNPICKED", label: "미수령", count: (counts.pending_count ?? 0) + (counts.paid_count ?? 0) },
                { key: "PAYMENT_PENDING", label: "결제대기", count: counts.pending_count },
                { key: "PAID", label: "결제완료", count: counts.paid_count },
                { key: "PICKED_UP", label: "수령완료", count: (showAllPickedUp || dateFrom || dateTo) ? counts.picked_up_all_count : counts.picked_up_count },
                { key: "CANCELLED", label: "취소", count: counts.cancelled_count },
              ].map((tab) => (
                <a
                  href={buildDashboardUrl(tab.key, showAllPickedUp ? { show_all_picked_up: "true" } : {})}
                  style={`display:inline-block;padding:10px 20px;font-size:14px;font-weight:600;text-decoration:none;border-bottom:3px solid ${status === tab.key ? "#2563eb" : "transparent"};color:${status === tab.key ? "#2563eb" : "#64748b"};margin-bottom:-2px;white-space:nowrap;transition:color 0.15s`}
                >
                  {tab.label} ({tab.count})
                </a>
              ))}
            </div>

            {/* Show "수령완료 전체보기" toggle when on PICKED_UP or ALL tab */}
            {(status === "PICKED_UP" || status === "ALL") && (
              <div style="margin-bottom:12px">
                <a href={buildDashboardUrl(status, showAllPickedUp ? {} : { show_all_picked_up: "true" })}
                   class="btn btn-sm" style={`font-size:12px;text-decoration:none;${showAllPickedUp ? "background:#2563eb;color:white;border-color:#2563eb" : ""}`}>
                  {showAllPickedUp ? "최근만 보기" : "수령완료 전체보기"}
                </a>
              </div>
            )}

            {/* Date range + presets */}
            <form id="staff-search-form" method="get" action="/staff/dashboard">
              <input type="hidden" name="status" value={status} />
              {showAllPickedUp && <input type="hidden" name="show_all_picked_up" value="true" />}
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
                <span style="font-size:12px;font-weight:600;color:#64748b;white-space:nowrap">기간</span>
                <input class="control" type="date" name="date_from" value={dateFrom} style="max-width:150px;padding:6px 8px;font-size:13px" />
                <span style="color:#94a3b8">~</span>
                <input class="control" type="date" name="date_to" value={dateTo} style="max-width:150px;padding:6px 8px;font-size:13px" />
                <div style="display:flex;gap:4px;margin-left:4px">
                  <button type="button" class="btn btn-sm" onclick="setDateRange('today')" style="padding:4px 10px;font-size:11px">오늘</button>
                  <button type="button" class="btn btn-sm" onclick="setDateRange('yesterday')" style="padding:4px 10px;font-size:11px">어제</button>
                  <button type="button" class="btn btn-sm" onclick="setDateRange('week')" style="padding:4px 10px;font-size:11px">이번주</button>
                  <button type="button" class="btn btn-sm" onclick="setDateRange('month')" style="padding:4px 10px;font-size:11px">이번달</button>
                  <a href={buildDashboardUrl("ALL", { show_all_picked_up: "true" })} class="btn btn-sm" style="padding:4px 10px;font-size:11px;text-decoration:none;border:1.5px dashed #94a3b8;background:transparent;color:#64748b">전체기간</a>
                </div>
              </div>

              {/* Search + reset */}
              <div style="display:flex;align-items:center;gap:8px">
                <input id="search-q" class="control" type="text" name="q" value={q} placeholder="이름, 접수번호, 전화, 짐번호" autocomplete="off" style="flex:1;padding:8px 12px;font-size:13px" />
                <button type="submit" class="btn btn-primary" style="padding:8px 14px;font-size:12px;white-space:nowrap">검색</button>
                <a class="btn btn-secondary" href="/staff/dashboard" style="padding:8px 14px;font-size:12px;text-decoration:none;white-space:nowrap">초기화</a>
              </div>
            </form>

            <div class="bulk-action-bar" id="bulk-bar">
              <span class="bulk-action-label" id="bulk-count">0건 선택</span>
              <button class="btn btn-sm btn-primary" id="bulk-paid">일괄 결제완료</button>
              <button class="btn btn-sm" id="bulk-cancel" style="background:#dc2626;color:#fff;border-color:#dc2626">일괄 취소</button>
            </div>
            <div class="table-wrap" style="max-width:100%;overflow-x:auto">
              <table id="staff-orders-table" style="table-layout:fixed;width:100%;max-width:100%">
                <colgroup>
                  <col data-col-key="checkbox" style="width:36px" />
                  <col data-col-key="name" style="width:80px" />
                  <col data-col-key="tag_no" style="width:52px" />
                  <col data-col-key="created_time" style="width:90px" />
                  <col data-col-key="price" style="width:70px" />
                  <col data-col-key="pickup_time" style="width:56px" />
                  <col data-col-key="pay_status" style="width:72px" />
                  <col data-col-key="pickup_status" style="width:72px" />
                  <col data-col-key="actions" style="width:68px" />
                  <col data-col-key="note" style="width:200px" />
                  <col data-col-key="detail" style="width:42px" />
                </colgroup>
                <thead>
                  <tr>
                    <th data-col-key="checkbox"><input type="checkbox" id="select-all" style="width:16px;height:16px;cursor:pointer" /></th>
                    <th data-col-key="name">이름<span class="col-resize"></span></th>
                    <th data-col-key="tag_no">짐번호<span class="col-resize"></span></th>
                    <th data-col-key="created_time">접수 시각<span class="col-resize"></span></th>
                    <th data-col-key="price">짐보관가격<span class="col-resize"></span></th>
                    <th data-col-key="pickup_time">짐 찾는 시각<span class="col-resize"></span></th>
                    <th data-col-key="pay_status">결제상태<span class="col-resize"></span></th>
                    <th data-col-key="pickup_status">수령상태<span class="col-resize"></span></th>
                    <th data-col-key="actions">관리<span class="col-resize"></span></th>
                    <th data-col-key="note">비고<span class="col-resize"></span></th>
                    <th data-col-key="detail">상세</th>
                  </tr>
                </thead>
                <tbody>
                  {orderRows.map((o) => {
                    const rowClasses = [
                      o.status === "CANCELLED" && "is-cancelled",
                      o.in_warehouse && "is-in-warehouse",
                    ].filter(Boolean).join(" ");
                    return (
                    <tr data-order-id={o.order_id} data-status={o.status} class={rowClasses || undefined}>
                      <td data-col-key="checkbox"><input type="checkbox" class="row-select" data-order-id={o.order_id} style="width:16px;height:16px;cursor:pointer" /></td>
                      <td data-col-key="name">
                        <span class="editable" data-field="name" data-order-id={o.order_id}>{o.name || "-"}</span>
                        {o.parent_order_id && <span class="extension-badge">연장</span>}
                      </td>
                      <td data-col-key="tag_no"><span class={`editable tag-pill ${tagColorClass(o.tag_no)}`} data-field="tag_no" data-order-id={o.order_id}>{o.tag_no ? String(o.tag_no).replace(/\.0$/, "") : "-"}</span></td>
                      <td data-col-key="created_time">{o.created_at ? new Date(o.created_at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td data-col-key="price" class="price-cell" data-order-id={o.order_id} data-tier={o.flying_pass_tier || "NONE"} data-method={o.payment_method || "CASH"} style="cursor:pointer;position:relative"><span class="price-display">{`¥${o.prepaid_amount.toLocaleString()}`}</span></td>
                      <td data-col-key="pickup_time">{(() => {
                        let pickupStyle = "";
                        if (o.expected_pickup_at) {
                          const pJst = new Date(new Date(o.expected_pickup_at).getTime() + 9 * 60 * 60 * 1000);
                          const cJst = new Date(new Date(o.created_at).getTime() + 9 * 60 * 60 * 1000);
                          const pHour = pJst.getUTCHours();
                          const isNextDay = pJst.toISOString().slice(0, 10) !== cJst.toISOString().slice(0, 10);
                          if (pHour >= 20) pickupStyle = "color:#dc2626;font-weight:700";
                          else if (isNextDay) pickupStyle = "color:#2563eb;font-weight:700";
                        }
                        return (
                          <span class="editable" data-field="expected_pickup_at" data-order-id={o.order_id} data-type="datetime-local" data-raw-value={o.expected_pickup_at ? new Date(new Date(o.expected_pickup_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16) : ""} style={pickupStyle || undefined}>{o.expected_pickup_at ? new Date(o.expected_pickup_at).toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</span>
                        );
                      })()}</td>
                      <td data-col-key="pay_status">{(() => {
                        const isPaid = o.status === "PAID" || o.status === "PICKED_UP";
                        const isCancelled = o.status === "CANCELLED";
                        const isPending = o.status === "PAYMENT_PENDING";
                        const cls = isPaid ? "status-paid" : isCancelled ? "status-cancelled" : "status-payment_pending";
                        const label = isPaid ? "결제완료" : isCancelled ? "취소" : "결제대기";
                        if (isPending) {
                          return <span class={`status-pill ${cls} pill-clickable`} data-action="toggle-payment" data-order-id={o.order_id} style="cursor:pointer" title="클릭하여 결제완료 처리">{label}</span>;
                        }
                        return <span class={`status-pill ${cls}`}>{label}</span>;
                      })()}</td>
                      <td data-col-key="pickup_status">{(() => {
                        const isPickedUp = o.status === "PICKED_UP";
                        const isCancelled = o.status === "CANCELLED";
                        const isPaid = o.status === "PAID";
                        const cls = isPickedUp ? "status-picked_up" : isCancelled ? "status-cancelled" : "status-payment_pending";
                        const label = isPickedUp ? "수령완료" : isCancelled ? "취소" : "미수령";
                        if (isPaid) {
                          return <span class={`status-pill ${cls} pill-clickable`} data-action="pickup" data-order-id={o.order_id} style="cursor:pointer" title="클릭하여 수령완료 처리">{label}</span>;
                        }
                        return <span class={`status-pill ${cls}`}>{label}</span>;
                      })()}</td>
                      <td data-col-key="actions">
                        <div class="inline-actions">
                          {o.status === "PICKED_UP" && (
                            <button class="pickup-undo-btn" data-action="undo-pickup" data-order-id={o.order_id}>수령취소</button>
                          )}
                          {o.status !== "CANCELLED" && (
                            <button class="cancel-btn" data-action="cancel" data-order-id={o.order_id}>삭제</button>
                          )}
                          <button
                            class={`warehouse-btn ${o.in_warehouse ? "is-active" : ""}`}
                            data-action="toggle-warehouse"
                            data-order-id={o.order_id}
                          >
                            {o.in_warehouse ? "창고O" : "창고"}
                          </button>
                        </div>
                      </td>
                      <td data-col-key="note">
                        <span class="editable" data-field="note" data-order-id={o.order_id}>{o.note || "-"}</span>
                        {o.note_author && <span style="display:block;font-size:10px;color:#999;margin-top:2px">{o.note_author} · {o.note_updated_at ? new Date(o.note_updated_at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : ""}</span>}
                      </td>
                      <td data-col-key="detail"><button class="btn btn-secondary btn-sm detail-toggle" data-order-id={o.order_id}>상세</button></td>
                    </tr>
                    );
                  })}
                  {orderRows.length === 0 && (
                    <tr><td colspan={11}>데이터가 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalFiltered > 0 && (
              <div style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px">
                <span style="color:#64748b">{`${totalFiltered}건 중 ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, totalFiltered)}`}</span>
                {totalPages > 1 && (
                  <div style="display:flex;gap:4px;margin-left:8px">
                    {page > 1 && (
                      <a class="btn btn-sm btn-secondary" href={buildDashboardUrl(status, { ...(showAllPickedUp ? { show_all_picked_up: "true" } : {}), page: String(page - 1) })}>이전</a>
                    )}
                    {(() => {
                      const pages: (number | "...")[] = [];
                      if (totalPages <= 9) {
                        for (let i = 1; i <= totalPages; i++) pages.push(i);
                      } else {
                        pages.push(1);
                        if (page > 4) pages.push("...");
                        for (let i = Math.max(2, page - 2); i <= Math.min(totalPages - 1, page + 2); i++) pages.push(i);
                        if (page < totalPages - 3) pages.push("...");
                        pages.push(totalPages);
                      }
                      return pages.map((p) =>
                        p === "..." ? (
                          <span style="padding:4px 2px;color:#94a3b8">...</span>
                        ) : (
                          <a
                            class={`btn btn-sm ${p === page ? "btn-primary" : "btn-secondary"}`}
                            href={buildDashboardUrl(status, { ...(showAllPickedUp ? { show_all_picked_up: "true" } : {}), page: String(p) })}
                          >{p}</a>
                        )
                      );
                    })()}
                    {page < totalPages && (
                      <a class="btn btn-sm btn-secondary" href={buildDashboardUrl(status, { ...(showAllPickedUp ? { show_all_picked_up: "true" } : {}), page: String(page + 1) })}>다음</a>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Manual order form */}
          <details class="card" style="margin-top:16px">
            <summary class="card-title" style="cursor:pointer">수기 접수</summary>
            <form id="manual-form" action="/staff/orders/manual" method="post" class="grid2" style="margin-top:12px">
              <label class="field">
                <span class="field-label">이름 *</span>
                <input class="control" type="text" name="name" required />
              </label>
              <label class="field">
                <span class="field-label">전화번호 *</span>
                <input class="control" type="text" name="phone" required />
              </label>
              <label class="field">
                <span class="field-label">캐리어</span>
                <input class="control" type="number" name="suitcase_qty" value="1" min="0" />
              </label>
              <label class="field">
                <span class="field-label">백팩</span>
                <input class="control" type="number" name="backpack_qty" value="0" min="0" />
              </label>
              <label class="field">
                <span class="field-label">예정 픽업 일시</span>
                <input class="control" type="datetime-local" name="expected_pickup_at" />
              </label>
              <div class="field" style="grid-column:1/-1">
                <span class="field-label">무료 사유 (선택 시 자동 0원)</span>
                <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
                  {[
                    { value: "", label: "일반 (유료)" },
                    { value: "지인 접수", label: "지인 접수" },
                    { value: "블로거 방문", label: "블로거 방문" },
                    { value: "쿠폰", label: "쿠폰" },
                    { value: "기타", label: "기타" },
                  ].map((opt, i) => (
                    <label style="display:flex;align-items:center;gap:4px;font-size:13px;cursor:pointer">
                      <input type="radio" name="free_reason" value={opt.value} checked={i === 0} style="width:16px;height:16px" />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
                <input class="control" type="text" name="free_reason_text" placeholder="기타 사유 입력..." style="display:none;margin-top:6px" id="free-reason-text" />
              </div>
              <label class="field" style="grid-column:1/-1">
                <span class="field-label">비고</span>
                <input class="control" type="text" name="note" placeholder="비고 (선택)" />
              </label>
              <label class="button-wrap">
                <span class="field-label sr-only">접수</span>
                <button class="btn btn-primary" type="submit">수기 접수</button>
              </label>
            </form>
          </details>
        </main>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            // Free reason toggle for manual form
            var mf=document.getElementById('manual-form');
            if(mf){var frt=document.getElementById('free-reason-text');mf.querySelectorAll('input[name=free_reason]').forEach(function(r){r.addEventListener('change',function(){frt.style.display=r.value==='기타'?'block':'none';if(r.value==='기타')frt.focus()})})}

            var FIELD_LABELS={name:'이름',tag_no:'짐번호',expected_pickup_at:'짐 찾는 시각',note:'비고'};
            var TAG_COLORS=${JSON.stringify(TAG_COLOR_RANGES)};

            /* ── Inline edit (click-to-edit for name, tag, pickup, note) ── */
            document.querySelectorAll('.editable').forEach(function(el){
              el.addEventListener('click', function(){
                if(el.querySelector('input')) return;
                var orig = el.textContent.trim();
                if(orig==='-') orig='';
                var inp = document.createElement('input');
                inp.className='edit-input';
                var field=el.dataset.field;
                inp.type = el.dataset.type || 'text';
                if(field==='tag_no'){inp.inputMode='numeric';inp.pattern='[0-9]*';inp.min='1';inp.max='100';}
                inp.value = el.dataset.type==='datetime-local' ? (el.dataset.rawValue||'') : orig;
                el.textContent='';
                el.appendChild(inp);
                inp.focus();

                function finish(){
                  var newVal = inp.value;
                  if(newVal===orig){ restore(orig); return; }
                  if(field==='tag_no'&&newVal){var n=parseInt(newVal,10);if(isNaN(n)||n<1||n>100){alert('짐번호는 1~100 사이로 입력해주세요');restore(orig);return;}newVal=String(n);}
                  var label = FIELD_LABELS[el.dataset.field]||el.dataset.field;
                  if(!confirm(label+' 변경: "'+newVal+'" 저장하시겠습니까?')){ restore(orig); return; }
                  var body={};
                  body[el.dataset.field]=newVal;
                  fetch('/staff/api/orders/'+el.dataset.orderId+'/inline-update',{
                    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
                  }).then(function(r){
                    if(r.ok){
                      var display=newVal||'-';
                      if(el.dataset.type==='datetime-local'&&newVal){
                        display=new Date(newVal).toLocaleString('ja-JP',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tokyo'});
                      }
                      el.textContent=display;
                      if(el.dataset.field==='tag_no') updateTagColor(el,newVal);
                    } else { restore(orig); alert('저장 실패'); }
                  }).catch(function(){ restore(orig); alert('저장 실패'); });
                }
                function restore(v){ el.textContent=v||'-'; }
                inp.addEventListener('blur', finish);
                inp.addEventListener('keydown',function(e){
                  if(e.key==='Enter'){e.preventDefault();inp.removeEventListener('blur',finish);finish();}
                  if(e.key==='Escape'){inp.removeEventListener('blur',finish);restore(orig);}
                });
              });
            });

            function updateTagColor(el,val){
              el.className='editable tag-pill';
              var n=parseInt(val,10);
              if(n>0) TAG_COLORS.forEach(function(c){if(n>=c[0]&&n<=c[1])el.classList.add(c[2]);});
            }

            /* ── Action buttons (event delegation on table) ── */
            var tbl=document.getElementById('staff-orders-table');
            if(tbl) tbl.addEventListener('click',function(e){
              var btn=e.target.closest('[data-action]');
              if(!btn) return;
              var action=btn.dataset.action, oid=btn.dataset.orderId;
              if(action==='toggle-payment') togglePayment(btn,oid);
              else if(action==='pickup') doPickup(oid);
              else if(action==='undo-pickup') undoPickup(oid);
              else if(action==='cancel') doCancel(btn,oid);
              else if(action==='toggle-warehouse') toggleWarehouse(btn,oid);
            });

            function apiPost(url,body){
              return fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):'{}'});
            }

            window.refBtn=function(floor,delta){
              var msg=floor+(delta>0?' +1 추가':' -1 감소')+' 하시겠습니까?';
              if(!confirm(msg))return;
              apiPost('/staff/api/referral',{floor:floor,delta:delta}).then(function(r){return r.json();}).then(function(d){
                var el=document.getElementById('ref-'+floor.toLowerCase());
                if(el)el.textContent=d.count;
              });
            };

            function togglePayment(btn,oid){
              if(!confirm('결제 상태를 변경하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/toggle-payment').then(function(r){return r.json();}).then(function(d){
                if(!d.success){alert(d.error||'실패');return;}
                var isPaid=d.status==='PAID';
                var row=btn.closest('tr');
                row.dataset.status=d.status;
                var payPill=row.querySelector('[data-col-key="pay_status"] .status-pill');
                if(payPill){
                  payPill.className='status-pill '+(isPaid?'status-paid':'status-payment_pending');
                  payPill.textContent=isPaid?'결제완료':'결제대기';
                  if(isPaid){payPill.removeAttribute('data-action');payPill.style.cursor='';payPill.classList.remove('pill-clickable');}
                }
              }).catch(function(){alert('네트워크 오류');});
            }

            function doPickup(oid){
              if(!confirm('수령완료 처리하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/pickup').then(function(r){
                if(r.ok) location.reload();
                else r.json().then(function(d){alert(d.error||'처리 실패');});
              }).catch(function(){alert('네트워크 오류');});
            }

            function undoPickup(oid){
              if(!confirm('수령완료를 취소하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/undo-pickup').then(function(r){
                if(r.ok) location.reload();
                else r.json().then(function(d){alert(d.error||'처리 실패');});
              }).catch(function(){alert('네트워크 오류');});
            }

            function doCancel(btn,oid){
              if(!confirm('정말 취소(삭제)하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/cancel').then(function(r){return r.json();}).then(function(d){
                if(!d.success){alert('실패');return;}
                var row=btn.closest('tr');
                row.classList.add('is-cancelled');
                var pill=row.querySelector('.status-pill');
                if(pill){pill.className='status-pill status-cancelled';pill.textContent='취소';}
                var actions=row.querySelector('.inline-actions');
                if(actions) actions.innerHTML='<span style="color:#991b1b;font-size:11px;font-weight:700">취소됨</span>';
              });
            }

            function toggleWarehouse(btn,oid){
              apiPost('/staff/api/orders/'+oid+'/toggle-warehouse').then(function(r){return r.json();}).then(function(d){
                if(!d.success) return;
                var row=btn.closest('tr');
                if(d.in_warehouse){
                  btn.classList.add('is-active');btn.textContent='창고O';
                  row.classList.add('is-in-warehouse');
                } else {
                  btn.classList.remove('is-active');btn.textContent='창고';
                  row.classList.remove('is-in-warehouse');
                }
              });
            }

            /* ── Price popover ── */
            var activePopover=null;
            document.querySelectorAll('.price-cell').forEach(function(cell){
              cell.addEventListener('click',function(e){
                if(e.target.closest('.price-popover')) return;
                closePopover();
                var oid=cell.dataset.orderId;
                var tier=cell.dataset.tier||'NONE';
                var method=cell.dataset.method||'CASH';
                var pop=document.createElement('div');
                pop.className='price-popover';
                pop.innerHTML=
                  '<label>결제수단<select name="pm"><option value="CASH"'+(method==='CASH'?' selected':'')+'>현금</option><option value="PAY_QR"'+(method==='PAY_QR'?' selected':'')+'>QR결제</option></select></label>'+
                  '<label>Flying Pass<select name="tier"><option value="NONE"'+(tier==='NONE'?' selected':'')+'>없음</option><option value="BLUE"'+(tier==='BLUE'?' selected':'')+'>블루 (¥100)</option><option value="SILVER"'+(tier==='SILVER'?' selected':'')+'>실버 (¥200)</option><option value="GOLD"'+(tier==='GOLD'?' selected':'')+'>골드 (¥300)</option><option value="PLATINUM"'+(tier==='PLATINUM'?' selected':'')+'>플래티넘 (¥400)</option><option value="BLACK"'+(tier==='BLACK'?' selected':'')+'>블랙 (무료)</option></select></label>'+
                  '<label>직접입력 (¥)<input type="number" name="override" min="0" step="100" placeholder="자동계산"></label>'+
                  '<p style="margin:0;font-size:11px;font-weight:700;color:#dc2626">⚠️ 카드 결제 불가 (현금/QR만 가능)</p>'+
                  '<div class="btn-row"><button class="btn btn-secondary btn-sm" data-pop-cancel>취소</button><button class="btn btn-primary btn-sm" data-pop-save>저장</button></div>';
                document.body.appendChild(pop);
                // Position fixed relative to cell
                var cellRect=cell.getBoundingClientRect();
                if(cellRect.bottom+250>window.innerHeight){
                  pop.style.bottom=(window.innerHeight-cellRect.top+4)+'px';
                  pop.style.left=cellRect.left+'px';
                }else{
                  pop.style.top=(cellRect.bottom+4)+'px';
                  pop.style.left=cellRect.left+'px';
                }
                activePopover={pop:pop,cell:cell};

                pop.querySelector('[data-pop-cancel]').addEventListener('click',function(ev){ev.stopPropagation();closePopover();});
                pop.querySelector('[data-pop-save]').addEventListener('click',function(ev){
                  ev.stopPropagation();
                  var body={payment_method:pop.querySelector('[name=pm]').value,flying_pass_tier:pop.querySelector('[name=tier]').value};
                  var ov=pop.querySelector('[name=override]').value;
                  if(ov!=='') body.staff_prepaid_override_amount=parseInt(ov,10);
                  apiPost('/staff/api/orders/'+oid+'/update-price',body).then(function(r){return r.json();}).then(function(d){
                    if(!d.success){alert('저장 실패');return;}
                    cell.dataset.tier=d.flying_pass_tier;
                    cell.dataset.method=d.payment_method;
                    closePopover();
                    var pd=cell.querySelector('.price-display');if(pd)pd.textContent='¥'+Number(d.prepaid_amount).toLocaleString();
                  });
                });
              });
            });

            function closePopover(){
              if(activePopover){activePopover.pop.remove();activePopover=null;}
            }
            document.addEventListener('click',function(e){
              if(activePopover&&!activePopover.cell.contains(e.target)&&!activePopover.pop.contains(e.target)) closePopover();
            });

            /* ── Bulk actions ── */
            var selectAll=document.getElementById('select-all');
            var bulkBar=document.getElementById('bulk-bar');
            var bulkCount=document.getElementById('bulk-count');
            var rowChecks=Array.from(document.querySelectorAll('.row-select'));

            function getSelected(){return rowChecks.filter(function(c){return c.checked;}).map(function(c){return c.dataset.orderId;});}
            function updateBulkBar(){
              var sel=getSelected();
              if(sel.length>0){bulkBar.classList.add('is-visible');bulkCount.textContent=sel.length+'건 선택';}
              else{bulkBar.classList.remove('is-visible');}
            }
            if(selectAll){selectAll.addEventListener('change',function(){
              rowChecks.forEach(function(c){c.checked=selectAll.checked;});
              updateBulkBar();
            });}
            rowChecks.forEach(function(c){c.addEventListener('change',updateBulkBar);});

            document.getElementById('bulk-paid').addEventListener('click',function(){
              var ids=getSelected();if(!ids.length)return;
              if(!confirm(ids.length+'건을 일괄 결제완료 처리하시겠습니까?'))return;
              apiPost('/staff/api/orders/bulk-action',{order_ids:ids,action:'mark_paid'}).then(function(r){return r.json();}).then(function(d){
                if(d.success)window.location.reload();else alert('처리 실패');
              });
            });
            document.getElementById('bulk-cancel').addEventListener('click',function(){
              var ids=getSelected();if(!ids.length)return;
              if(!confirm(ids.length+'건을 일괄 취소 처리하시겠습니까? 이 작업은 되돌릴 수 없습니다.'))return;
              apiPost('/staff/api/orders/bulk-action',{order_ids:ids,action:'cancel'}).then(function(r){return r.json();}).then(function(d){
                if(d.success)window.location.reload();else alert('처리 실패');
              });
            });

            /* ── Clear any stale saved column widths from localStorage ── */
            try{localStorage.removeItem('luggage_col_widths')}catch(e){}

            /* ── Date range presets ── */
            window.setDateRange=function(range){
              var now=new Date(Date.now()+9*60*60*1000);
              var y=now.getUTCFullYear(),m=String(now.getUTCMonth()+1).padStart(2,'0'),d=String(now.getUTCDate()).padStart(2,'0');
              var today=y+'-'+m+'-'+d;
              var fromEl=document.querySelector('[name=date_from]');
              var toEl=document.querySelector('[name=date_to]');
              toEl.value=today;
              if(range==='today') fromEl.value=today;
              else if(range==='yesterday'){
                var yd=new Date(now.getTime()-86400000);
                var yy=yd.getUTCFullYear(),ym=String(yd.getUTCMonth()+1).padStart(2,'0'),ydd=String(yd.getUTCDate()).padStart(2,'0');
                fromEl.value=yy+'-'+ym+'-'+ydd;
                toEl.value=yy+'-'+ym+'-'+ydd;
              } else if(range==='week'){
                var dow=now.getUTCDay();
                var mon=new Date(now.getTime()-(dow===0?6:dow-1)*86400000);
                fromEl.value=mon.toISOString().slice(0,10);
              } else if(range==='month'){
                fromEl.value=y+'-'+m+'-01';
              }
              var form=document.getElementById('staff-search-form');
              if(form) form.submit();
            };

            /* ── Detail row toggle ── */
            document.querySelectorAll('.detail-toggle').forEach(function(btn){
              btn.addEventListener('click',function(){
                var oid=btn.dataset.orderId;
                var row=btn.closest('tr');
                var existing=row.nextElementSibling;
                if(existing&&existing.classList.contains('detail-row')){
                  existing.remove();btn.textContent='상세';return;
                }
                btn.textContent='접기';
                var detailRow=document.createElement('tr');
                detailRow.className='detail-row';
                var td=document.createElement('td');
                td.colSpan=11;
                td.style.cssText='padding:12px 16px;background:#f8fafc;font-size:12px;border-bottom:2px solid #e2e8f0';
                td.textContent='로딩중...';
                detailRow.appendChild(td);
                row.after(detailRow);
                fetch('/staff/api/orders?search='+encodeURIComponent(oid)+'&limit=1')
                  .then(function(r){return r.json();})
                  .then(function(d){
                    if(!d.orders||!d.orders.length){td.textContent='데이터 없음';return;}
                    var o=d.orders[0];
                    var grid=document.createElement('div');
                    grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px';
                    var items=[
                      ['접수번호',o.order_id],
                      ['이름',o.name||'-'],
                      ['전화',o.phone||'-'],
                      ['짐번호',o.tag_no?String(o.tag_no).replace(/\.0$/,''):'-'],
                      ['상태',o.status],
                      ['결제수단',o.payment_method||'-'],
                      ['금액','¥'+Number(o.prepaid_amount||0).toLocaleString()],
                      ['Flying Pass',o.flying_pass_tier||'NONE'],
                      ['접수',o.created_at?new Date(o.created_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'-'],
                      ['예정 픽업',o.expected_pickup_at?new Date(o.expected_pickup_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'-'],
                      ['실제 픽업',o.actual_pickup_at?new Date(o.actual_pickup_at).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}):'-'],
                      ['보관일수',o.actual_storage_days||'-'],
                      ['초과일',o.extra_days||0],
                      ['추가요금','¥'+Number(o.extra_amount||0).toLocaleString()],
                      ['비고',o.note||'-'],
                      ['창고',o.in_warehouse?'O':'-']
                    ];
                    items.forEach(function(pair){
                      var div=document.createElement('div');
                      var strong=document.createElement('strong');
                      strong.textContent=pair[0]+': ';
                      div.appendChild(strong);
                      div.appendChild(document.createTextNode(String(pair[1])));
                      grid.appendChild(div);
                    });
                    td.textContent='';
                    td.appendChild(grid);
                    // Images section
                    var imgWrap=document.createElement('div');
                    imgWrap.style.cssText='display:flex;gap:12px;margin-top:12px;flex-wrap:wrap';
                    var idImgUrl='/staff/orders/'+o.order_id+'/id-image';
                    var lugImgUrl='/staff/orders/'+o.order_id+'/luggage-image';
                    if(o.id_image_url){
                      var idImg=document.createElement('div');
                      idImg.innerHTML='<div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:4px">신분증</div>';
                      var img1=document.createElement('img');
                      img1.src=idImgUrl;img1.style.cssText='max-width:360px;max-height:270px;border-radius:8px;border:1px solid #e2e8f0;cursor:pointer';
                      img1.onclick=function(){window.open(idImgUrl,'_blank')};
                      idImg.appendChild(img1);imgWrap.appendChild(idImg);
                    }
                    if(o.luggage_image_url){
                      var lugImg=document.createElement('div');
                      lugImg.innerHTML='<div style="font-size:11px;font-weight:600;color:#64748b;margin-bottom:4px">짐 사진</div>';
                      var img2=document.createElement('img');
                      img2.src=lugImgUrl;img2.style.cssText='max-width:360px;max-height:270px;border-radius:8px;border:1px solid #e2e8f0;cursor:pointer';
                      img2.onclick=function(){window.open(lugImgUrl,'_blank')};
                      lugImg.appendChild(img2);imgWrap.appendChild(lugImg);
                    }
                    if(o.id_image_url||o.luggage_image_url) td.appendChild(imgWrap);
                    var linkWrap=document.createElement('div');
                    linkWrap.style.marginTop='8px';
                    var a=document.createElement('a');
                    a.href='/staff/orders/'+o.order_id;
                    a.className='btn btn-sm';
                    a.style.textDecoration='none';
                    a.textContent='전체 상세 페이지';
                    linkWrap.appendChild(a);
                    td.appendChild(linkWrap);
                  });
              });
            });

            /* ── Changelog modal ── */
            var CL_VER='2026-04-06';
            if(localStorage.getItem('changelog_seen')!==CL_VER){
              var overlay=document.getElementById('changelog-overlay');
              if(overlay) overlay.style.display='flex';
            }
            var clBtn=document.getElementById('changelog-close');
            if(clBtn) clBtn.addEventListener('click',function(){
              localStorage.setItem('changelog_seen',CL_VER);
              document.getElementById('changelog-overlay').style.display='none';
            });

          })();
        ` }} />
        <div id="changelog-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.4);align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:12px;padding:24px 28px;max-width:420px;width:90%;box-shadow:0 8px 30px rgba(0,0,0,0.15)">
            <h3 style="margin:0 0 12px;font-size:16px;font-weight:700">업데이트 안내 (4/6)</h3>
            <ul style="margin:0 0 16px;padding-left:20px;font-size:13px;line-height:1.8;color:#334155">
              <li>수기 등록 건이 정산에 포함됩니다</li>
              <li>수령시간 20시 이후 <span style="color:#dc2626;font-weight:700">빨간색</span> 표시</li>
              <li>익일 수령 주문 시간 <span style="color:#2563eb;font-weight:700">파란색</span> 표시</li>
              <li>동행인원 수가 팀 수 대신 표시됩니다</li>
              <li>번호 꼬임 현상 수정</li>
            </ul>
            <button id="changelog-close" class="btn btn-primary" style="width:100%;padding:10px">확인</button>
          </div>
        </div>
        <NewOrderAlert />
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
        console.log(`Scheduled tasks triggered: ${event.cron}`);

        // Midnight JST rollover (0 15 * * * = 00:00 JST)
        // Transition uncollected same-day orders to overnight with new 91+ tags
        if (event.cron === "0 15 * * *") {
          const rolloverResult = await runMidnightRollover(env.DB);
          console.log(`Midnight rollover complete: ${JSON.stringify(rolloverResult)}`);
          return;
        }

        // Daily maintenance (0 18 * * * = 03:00 JST)
        const result = await runRetentionCleanup(env.DB, env.IMAGES);
        console.log(`Retention cleanup complete: ${JSON.stringify(result)}`);
        if (env.GOOGLE_SHEETS_CREDENTIALS) {
          const syncResult = await syncDailySales(env.DB, env.GOOGLE_SHEETS_CREDENTIALS);
          console.log(`Daily sales sync complete: ${JSON.stringify(syncResult)}`);
        }
        if (env.NAVER_ORDERS_SUPABASE_URL && env.NAVER_ORDERS_SUPABASE_KEY) {
          const rentalResult = await syncRentalRevenue(env.DB, env.NAVER_ORDERS_SUPABASE_URL, env.NAVER_ORDERS_SUPABASE_KEY);
          console.log(`Rental revenue sync complete: ${JSON.stringify(rentalResult)}`);
        }
        // Auto-extend overdue orders + email + handover note
        const { generateExtensionOrders } = await import("./services/extension");
        const { sendExtensionNotification } = await import("./lib/brevo");
        const extResult = await generateExtensionOrders(env.DB);
        console.log(`Extension orders: created=${extResult.created}, skipped=${extResult.skippedDup}`);
        if (env.BREVO_API_KEY) {
          for (const ext of extResult.extendedOrders) {
            if (ext.email) {
              await sendExtensionNotification(env.BREVO_API_KEY, { name: ext.name, email: ext.email, tagNo: ext.tagNo, amount: ext.amount }).catch(e => console.error("Extension email failed:", e));
            }
          }
        }
      })()
    );
  },
};
