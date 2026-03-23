/**
 * Admin routes — Sales analytics, staff accounts, settings, activity logs.
 * US-012: All admin-only routes.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { adminAuth, getStaff } from "../middleware/auth";
import { createSupabaseAdmin } from "../lib/supabase";
import { formatDateJST, nowJST } from "../services/storage";
import { StaffMenu } from "../lib/components";
import { loadCompletionMessages, buildCompletionMessagesFromKo } from "../services/completionMessages";
import { fetchRentalDailyRevenue, type RentalDailyRevenue } from "../services/rentalSync";

const admin = new Hono<AppType>();
admin.use("/*", adminAuth);

// GET /staff/admin/sales — Sales analytics
admin.get("/staff/admin/sales", async (c) => {
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
  const [dailySales, summary] = await Promise.all([
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
  ]);

  // Fetch rental revenue from Google Sheets (graceful degradation)
  let rentalData: RentalDailyRevenue[] = [];
  let rentalError = "";
  if (c.env.GOOGLE_SHEETS_CREDENTIALS) {
    try {
      const allRental = await fetchRentalDailyRevenue(c.env.GOOGLE_SHEETS_CREDENTIALS);
      // Filter by date range if specified
      if (startDate && endDate) {
        rentalData = allRental.filter((r) => r.date >= startDate && r.date <= endDate);
      } else {
        rentalData = allRental;
      }
    } catch (e) {
      rentalError = e instanceof Error ? e.message : "알 수 없는 오류";
      console.error("Rental sync error:", rentalError);
    }
  }
  const rentalTotal = rentalData.reduce((sum, r) => sum + r.rentalRevenue, 0);

  const s = summary || { total_orders: 0, total_revenue: 0, total_cash: 0, total_qr: 0 };
  const dayCount = dailySales.results.length || 1;

  const staff = getStaff(c);
  const successMsg = c.req.query("success");
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script><title>매출 분석</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link pill-link-strong" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <StaffMenu active="/staff/admin/sales" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">매출 분석</h2></div></section>

        <section class="card">
          <form method="get" action="/staff/admin/sales" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label class="field"><span class="field-label">시작일</span><input class="control" type="date" name="start_date" value={startDate} /></label>
            <label class="field"><span class="field-label">종료일</span><input class="control" type="date" name="end_date" value={endDate} /></label>
            <button class="btn btn-primary" type="submit">조회</button>
            <a class="btn btn-secondary" href="/staff/admin/sales">초기화</a>
          </form>
        </section>

        <div class="stat-grid">
          <div class="card stat-card">
            <p class="stat-label">짐보관 매출</p>
            <p class="stat-value">¥{s.total_revenue?.toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">렌탈 매출</p>
            <p class="stat-value">¥{rentalTotal.toLocaleString()}</p>
          </div>
          <div class="card stat-card stat-card--highlight">
            <p class="stat-label stat-label--highlight">합계 (짐보관 + 렌탈)</p>
            <p class="stat-value stat-value--highlight">¥{((s.total_revenue || 0) + rentalTotal).toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">총건수</p>
            <p class="stat-value">{s.total_orders}건</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">일평균</p>
            <p class="stat-value">¥{Math.round(s.total_revenue / dayCount).toLocaleString()}</p>
          </div>
          <div class="card stat-card">
            <p class="stat-label">현금 / QR</p>
            <p class="stat-value stat-value--sm">¥{s.total_cash?.toLocaleString()} / ¥{s.total_qr?.toLocaleString()}</p>
          </div>
        </div>

        <section class="card" style="padding:16px">
          <h3 class="card-title">일별 매출 추이</h3>
          <div style="position:relative;height:320px"><canvas id="trendChart"></canvas></div>
        </section>

        <section class="card">
        <h3 class="card-title">일별 매출 상세</h3>
        {rentalError && <p class="error" style="margin:0 8px 8px">Google Sheets 조회 실패: {rentalError}</p>}
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:2px solid var(--line)">
            <th style="text-align:left;padding:6px 8px">날짜</th>
            <th style="text-align:right;padding:6px 8px">고객수</th>
            <th style="text-align:right;padding:6px 8px">현금</th>
            <th style="text-align:right;padding:6px 8px">QR</th>
            <th style="text-align:right;padding:6px 8px;color:#2383e2">짐보관</th>
            <th style="text-align:right;padding:6px 8px;color:#12b886">렌탈</th>
            <th style="text-align:right;padding:6px 8px;font-weight:700">합계</th>
            <th style="text-align:right;padding:6px 8px">비율</th>
          </tr></thead>
          <tbody>
          {dailySales.results.length === 0 && (
            <tr><td colspan={8} style="padding:24px;text-align:center;color:#a5a5a3">데이터가 없습니다</td></tr>
          )}
          {(() => {
            const rentalMap = Object.fromEntries(rentalData.map(r => [r.date, r.rentalRevenue]));
            let luggageSum = 0, rentalSum = 0;
            const rows = dailySales.results.map((d: Record<string, unknown>) => {
              const date = d.sale_date as string;
              const luggage = (d.grand_total as number) || 0;
              const rental = rentalMap[date] || 0;
              const combined = luggage + rental;
              luggageSum += luggage;
              rentalSum += rental;
              const luggagePct = combined > 0 ? Math.round(luggage / combined * 100) : 0;
              const rentalPct = combined > 0 ? 100 - luggagePct : 0;
              return (
                <tr style="border-bottom:1px solid var(--line)">
                  <td style="padding:4px 8px">{date}</td>
                  <td style="padding:4px 8px;text-align:right">{d.order_count as number}</td>
                  <td style="padding:4px 8px;text-align:right">¥{(d.cash_total as number)?.toLocaleString()}</td>
                  <td style="padding:4px 8px;text-align:right">¥{(d.qr_total as number)?.toLocaleString()}</td>
                  <td style="padding:4px 8px;text-align:right;color:#2383e2">¥{luggage.toLocaleString()}</td>
                  <td style="padding:4px 8px;text-align:right;color:#12b886">{rental ? `¥${rental.toLocaleString()}` : "-"}</td>
                  <td style="padding:4px 8px;text-align:right;font-weight:600">¥{combined.toLocaleString()}</td>
                  <td style="padding:4px 8px;text-align:right;font-size:11px;color:#787774">{combined > 0 ? `${luggagePct}% / ${rentalPct}%` : "-"}</td>
                </tr>
              );
            });
            const totalCombined = luggageSum + rentalSum;
            const totalLPct = totalCombined > 0 ? Math.round(luggageSum / totalCombined * 100) : 0;
            return (<>{rows}
              {dailySales.results.length > 0 && (
                <tr style="border-top:2px solid var(--line);font-weight:700;background:#fafaf9">
                  <td style="padding:6px 8px">합계</td>
                  <td style="padding:6px 8px;text-align:right">{s.total_orders}</td>
                  <td style="padding:6px 8px;text-align:right">¥{s.total_cash?.toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right">¥{s.total_qr?.toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right;color:#2383e2">¥{luggageSum.toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right;color:#12b886">¥{rentalSum.toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right">¥{totalCombined.toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right;font-size:11px;color:#787774">{totalLPct}% / {100 - totalLPct}%</td>
                </tr>
              )}
              {dailySales.results.length > 0 && (
                <tr style="font-weight:600;color:#787774;font-size:12px">
                  <td style="padding:6px 8px">일평균</td>
                  <td style="padding:6px 8px;text-align:right">{Math.round(s.total_orders / dayCount)}</td>
                  <td style="padding:6px 8px;text-align:right">¥{Math.round((s.total_cash || 0) / dayCount).toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right">¥{Math.round((s.total_qr || 0) / dayCount).toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right;color:#2383e2">¥{Math.round(luggageSum / dayCount).toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right;color:#12b886">¥{Math.round(rentalSum / (rentalData.length || 1)).toLocaleString()}</td>
                  <td style="padding:6px 8px;text-align:right">¥{Math.round(totalCombined / dayCount).toLocaleString()}</td>
                  <td></td>
                </tr>
              )}
            </>);
          })()}
          </tbody>
        </table>
        </div>
        </section>
        <script dangerouslySetInnerHTML={{__html: `(function(){
  var dailyData = ${JSON.stringify(dailySales.results.slice().reverse().map((d: Record<string, unknown>) => ({
    date: d.sale_date as string || "",
    label: (d.sale_date as string || "").slice(5),
    luggage: d.grand_total as number || 0,
  })))};
  var rentalMap = ${JSON.stringify(Object.fromEntries(rentalData.map(r => [r.date, r.rentalRevenue])))};

  if(!dailyData.length){return;}
  var labels = dailyData.map(function(d){return d.label;});
  var luggageVals = dailyData.map(function(d){return d.luggage;});
  var rentalVals = dailyData.map(function(d){return rentalMap[d.date]||0;});
  var combinedVals = dailyData.map(function(d,i){return d.luggage+(rentalMap[d.date]||0);});

  var defaults = Chart.defaults;
  defaults.font.family = "'Pretendard','Noto Sans KR',sans-serif";
  defaults.font.size = 11;
  defaults.color = '#787774';

  new Chart(document.getElementById('trendChart'),{
    type:'line',
    data:{
      labels: labels,
      datasets:[
        {label:'짐보관 (Luggage)',data:luggageVals,borderColor:'#4285F4',backgroundColor:'rgba(66,133,244,0.08)',pointBackgroundColor:'#4285F4',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false},
        {label:'렌탈 (Rental)',data:rentalVals,borderColor:'#EA4335',backgroundColor:'rgba(234,67,53,0.08)',pointBackgroundColor:'#EA4335',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false},
        {label:'합계 (Combined)',data:combinedVals,borderColor:'#FBBC05',backgroundColor:'rgba(251,188,5,0.08)',pointBackgroundColor:'#FBBC05',pointRadius:4,pointHoverRadius:6,borderWidth:2,tension:0.1,fill:false}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{position:'top',labels:{boxWidth:12,padding:16,usePointStyle:true,pointStyle:'circle'}},
        tooltip:{callbacks:{label:function(c){return c.dataset.label+': \\u00A5'+c.raw.toLocaleString();}}}
      },
      scales:{
        x:{grid:{display:false}},
        y:{ticks:{callback:function(v){return '\\u00A5'+v.toLocaleString();}},grid:{color:'#f0f0ee'},beginAtZero:true}
      }
    }
  });
})()`}} />
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/staff-accounts — Staff account management
admin.get("/staff/admin/staff-accounts", async (c) => {
  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data: accountRows } = await supabaseAdmin
    .from("user_profiles")
    .select("id, display_name, username, email, role, is_active, created_at")
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });

  const accounts = { results: accountRows || [] };

  const staff = getStaff(c);
  const focusId = c.req.query("focus");
  const errorMsg = c.req.query("error");
  const successMsg = c.req.query("success");

  const activeAccounts: Record<string, unknown>[] = [];
  const inactiveAccounts: Record<string, unknown>[] = [];
  let adminCount = 0;
  for (const a of accounts.results) {
    if (a.is_active) {
      activeAccounts.push(a);
      if (a.role === "admin") adminCount++;
    } else {
      inactiveAccounts.push(a);
    }
  }

  const AccountRow = ({ a, isOpen }: { a: Record<string, unknown>; isOpen: boolean }) => {
    const name = (a.display_name as string) || (a.username as string) || "?";
    const initial = name[0].toUpperCase();
    const isMe = a.id === staff.id;
    const isActive = a.is_active as boolean;
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
              <form method="post" action={`/staff/admin/staff-accounts/${a.id}/toggle-active`} onsubmit={`return confirm('${isActive ? "이 계정을 잠금 처리할까요?" : "이 계정을 복구할까요?"}')`}>
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
                  <option value="editor" selected={(a.role as string) !== "admin"}>직원</option>
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
      </head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <StaffMenu active="/staff/admin/staff-accounts" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        {errorMsg && <p class="error">{decodeURIComponent(errorMsg)}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">직원 계정</h2></div></section>

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
                  <option value="editor" selected>직원</option>
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
          <div style="overflow-x:auto">
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
          </div>
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
  const role = String(body.role || "editor");

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

  // Create profile in Supabase PG — rollback Supabase user on failure
  const username = email.split("@")[0];
  try {
    const { error: pgError } = await supabaseAdmin.from("user_profiles").upsert({
      id: data.user.id,
      display_name: displayName,
      username,
      email,
      role,
      is_active: true,
    }, { onConflict: "id" });

    if (pgError) throw pgError;
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

  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("is_active")
    .eq("id", targetId)
    .single();

  if (!profile) return c.redirect("/staff/admin/staff-accounts");

  const newActive = !profile.is_active;
  await supabaseAdmin
    .from("user_profiles")
    .update({ is_active: newActive, updated_at: new Date().toISOString() })
    .eq("id", targetId);

  return c.redirect(`/staff/admin/staff-accounts?success=${newActive ? "계정이 복구되었습니다" : "계정이 잠금되었습니다"}`);
});

// POST /staff/admin/staff-accounts/:id/update
admin.post("/staff/admin/staff-accounts/:id/update", async (c) => {
  const targetId = c.req.param("id");
  const body = await c.req.parseBody();

  const updates: Record<string, string> = {};
  if (body.display_name) updates.display_name = String(body.display_name);
  if (body.role) updates.role = String(body.role);

  if (Object.keys(updates).length > 0) {
    const supabaseAdmin = createSupabaseAdmin(c.env);
    await supabaseAdmin
      .from("user_profiles")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", targetId);
  }

  return c.redirect("/staff/admin/staff-accounts?success=저장되었습니다");
});

// POST /staff/admin/staff-accounts/:id/delete
admin.post("/staff/admin/staff-accounts/:id/delete", async (c) => {
  const targetId = c.req.param("id");

  // Delete from Supabase Auth + PG
  const supabaseAdmin = createSupabaseAdmin(c.env);
  await supabaseAdmin.auth.admin.deleteUser(targetId);
  await supabaseAdmin.from("user_profiles").delete().eq("id", targetId);
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
  const today = formatDateJST(nowJST());
  const startDate = c.req.query("start_date") || "";
  const endDate = c.req.query("end_date") || "";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = 50;
  const offset = (page - 1) * limit;

  // Build date filter — default last 7 days
  let dateFilter = "";
  const dateParams: string[] = [];
  if (startDate && endDate) {
    dateFilter = " WHERE date(a.timestamp, '+9 hours') BETWEEN ? AND ?";
    dateParams.push(startDate, endDate);
  } else {
    dateFilter = " WHERE date(a.timestamp, '+9 hours') >= date('now', '-7 days')";
  }

  const defaultStart = startDate || formatDateJST(new Date(Date.now() - 7 * 86400000));
  const defaultEnd = endDate || today;

  // Fetch logs from D1 with pagination
  const [logs, countResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.* FROM luggage_audit_logs a${dateFilter}
       ORDER BY a.timestamp DESC LIMIT ? OFFSET ?`
    ).bind(...dateParams, limit, offset).all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM luggage_audit_logs a${dateFilter}`
    ).bind(...dateParams).first<{ cnt: number }>(),
  ]);

  const totalCount = countResult?.cnt || 0;
  const hasMore = offset + limit < totalCount;

  // Bulk-fetch staff names from Supabase PG
  const staffIds = [...new Set(logs.results.map((l: Record<string, unknown>) => l.staff_id as string).filter(Boolean))];
  const staffNameMap: Record<string, string> = {};
  if (staffIds.length > 0) {
    const supabaseAdmin = createSupabaseAdmin(c.env);
    const { data: profiles } = await supabaseAdmin
      .from("user_profiles")
      .select("id, display_name, username")
      .in("id", staffIds);
    if (profiles) {
      for (const p of profiles) {
        staffNameMap[p.id] = p.display_name || p.username || p.id;
      }
    }
  }

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>활동 로그</title></head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <StaffMenu active="/staff/admin/activity-logs" role={staff.role} />
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">활동 로그</h2></div></section>

        <section class="card">
          <form method="get" action="/staff/admin/activity-logs" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
            <label class="field"><span class="field-label">시작일</span><input class="control" type="date" name="start_date" value={startDate || defaultStart} /></label>
            <label class="field"><span class="field-label">종료일</span><input class="control" type="date" name="end_date" value={endDate || defaultEnd} /></label>
            <button class="btn btn-primary" type="submit">조회</button>
            <a class="btn btn-secondary" href="/staff/admin/activity-logs">초기화</a>
          </form>
        </section>

        <div style="overflow-x:auto">
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
          {logs.results.length === 0 && (
            <tr><td colspan={5} style="padding:24px;text-align:center;color:#a5a5a3">활동 기록이 없습니다</td></tr>
          )}
          {logs.results.map((l: Record<string, unknown>) => (
            <tr style="border-bottom:1px solid var(--line)">
              <td style="padding:4px 8px;white-space:nowrap">{l.timestamp ? new Date(l.timestamp as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
              <td style="padding:4px 8px"><a href={`/staff/orders/${l.order_id as string}`} style="color:var(--primary)">{l.order_id as string}</a></td>
              <td style="padding:4px 8px">{staffNameMap[l.staff_id as string] || (l.staff_id as string) || "-"}</td>
              <td style="padding:4px 8px"><span class="status-pill" style="font-size:10px">{ACTION_LABELS[l.action as string] || (l.action as string)}</span></td>
              <td style="padding:4px 8px;color:#666">{(l.details as string) || "-"}</td>
            </tr>
          ))}
          </tbody>
        </table>
        </div>

        <div style="display:flex;gap:8px;justify-content:center;margin:16px 0">
          {page > 1 && (
            <a class="btn btn-secondary btn-sm" href={`/staff/admin/activity-logs?page=${page - 1}${startDate ? `&start_date=${startDate}` : ""}${endDate ? `&end_date=${endDate}` : ""}`}>← 이전</a>
          )}
          <span style="font-size:12px;color:#a5a5a3;padding:6px 0">{totalCount}건 중 {offset + 1}-{Math.min(offset + limit, totalCount)}</span>
          {hasMore && (
            <a class="btn btn-secondary btn-sm" href={`/staff/admin/activity-logs?page=${page + 1}${startDate ? `&start_date=${startDate}` : ""}${endDate ? `&end_date=${endDate}` : ""}`}>다음 →</a>
          )}
        </div>
        </main>
      </body>
    </html>
  );
});

// GET /staff/admin/completion-message — Completion message editor
admin.get("/staff/admin/completion-message", async (c) => {
  const msgs = await loadCompletionMessages(c.env.DB);

  const staff = getStaff(c);
  const successMsg = c.req.query("success");
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>작성완료 문구 수정</title>
      </head>
      <body class="staff-site">
        <header class="topbar"><div class="topbar-inner"><a class="brand" href="/staff/dashboard"><img class="brand-logo" src="/static/logo-horizontal.png" alt="Flying Japan" width="24" height="24" /><span>Flying Japan Staff</span></a><nav class="pill-nav"><a class="pill-link" href="/staff/dashboard">대시보드</a><a class="pill-link" href="/staff/admin/sales">매출관리</a><span class="pill-user">{staff.display_name || staff.username}</span><form method="post" action="/staff/logout" style="display:inline"><button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button></form></nav></div></header>
        <main class="container">
          <StaffMenu active="/staff/admin/completion-message" role={staff.role} />
        {successMsg && <p class="success-note">{successMsg}</p>}
        <section class="hero"><div><p class="hero-kicker">Admin</p><h2 class="hero-title">작성완료 문구 수정</h2><p class="hero-desc">한국어로 입력하면 영어/일본어 문구가 자동 생성됩니다.</p></div></section>

        <section class="card" style="padding:16px">
        <form method="post" action="/staff/admin/completion-message">
          <label class="field">
            <span class="field-label">1차 문구 (상단 안내)</span>
            <textarea class="control" name="primary_message_ko" rows={4} style="font-size:13px">{msgs.primary.ko}</textarea>
          </label>
          <label class="field">
            <span class="field-label">2차 문구 (혜택 안내)</span>
            <textarea class="control" name="secondary_message_ko" rows={5} style="font-size:13px">{msgs.secondary.ko}</textarea>
          </label>
          <p style="font-size:12px;color:#787774;margin:8px 0 12px"><code style="background:#f0f0ee;padding:2px 5px;border-radius:3px;font-size:11px">{"{amount}"}</code>를 넣으면 실제 결제금액으로 자동 치환됩니다. (예: ¥4,800)</p>
          <button class="btn btn-primary" type="submit">문구 저장 (자동 번역 포함)</button>
        </form>
        </section>

        <section class="card" style="padding:16px">
          <h3 class="card-title">미리보기</h3>
          <div class="preview-grid">
            <div class="preview-card">
              <h4>KO 한국어</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.ko}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.ko}</div>
            </div>
            <div class="preview-card">
              <h4>EN English</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.en}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.en}</div>
            </div>
            <div class="preview-card">
              <h4>JA 日本語</h4>
              <p class="preview-label">1차 문구</p>
              <div class="preview-text">{msgs.primary.ja}</div>
              <p class="preview-label">2차 문구</p>
              <div class="preview-text">{msgs.secondary.ja}</div>
            </div>
          </div>
        </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/admin/completion-message — Save completion message (auto-translate)
admin.post("/staff/admin/completion-message", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);
  const koPrimary = String(body.primary_message_ko || "");
  const koSecondary = String(body.secondary_message_ko || "");

  const msgs = await buildCompletionMessagesFromKo(koPrimary, koSecondary);

  // Upsert all 6 messages
  const entries: [string, string][] = [
    ["customer_success_primary_message_ko", msgs.primary.ko],
    ["customer_success_primary_message_en", msgs.primary.en],
    ["customer_success_primary_message_ja", msgs.primary.ja],
    ["customer_success_secondary_message_ko", msgs.secondary.ko],
    ["customer_success_secondary_message_en", msgs.secondary.en],
    ["customer_success_secondary_message_ja", msgs.secondary.ja],
  ];

  const stmts = entries.map(([key, value]) =>
    c.env.DB.prepare(
      `INSERT INTO luggage_app_settings (setting_key, setting_value, staff_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = ?, staff_id = ?, updated_at = datetime('now')`
    ).bind(key, value, staff.id, value, staff.id)
  );

  await c.env.DB.batch(stmts);

  return c.redirect("/staff/admin/completion-message?success=저장되었습니다 (자동 번역 포함)");
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
