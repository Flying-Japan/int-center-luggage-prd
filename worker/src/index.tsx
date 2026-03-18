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
// displayOrderStatus no longer needed — status split into pay/pickup columns
import { runRetentionCleanup } from "./services/retention";

/** Map tag_no to a color class (1-10 orange, 11-20 blue, etc.) */
function tagColorClass(tagNo: string | null): string {
  if (!tagNo) return "";
  const num = parseInt(String(tagNo).replace(/^[A-Za-z]+/, ""), 10);
  if (!Number.isFinite(num) || num < 1) return "";
  const map: [number, number, string][] = [
    [1, 10, "tag-color-orange"], [11, 20, "tag-color-blue"], [21, 30, "tag-color-yellow"],
    [31, 40, "tag-color-green"], [41, 50, "tag-color-purple"], [51, 60, "tag-color-black"],
    [61, 70, "tag-color-gray"], [71, 80, "tag-color-pink"], [81, 90, "tag-color-brown"],
  ];
  for (const [min, max, cls] of map) {
    if (num >= min && num <= max) return cls;
  }
  return "";
}

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

  let sql = `SELECT o.order_id, o.name, o.tag_no, o.status, o.prepaid_amount, o.created_at, o.expected_pickup_at, o.note, o.payment_method, o.in_warehouse, o.parent_order_id, o.flying_pass_tier,
    (SELECT COALESCE(u.display_name, u.username, a.staff_id) FROM luggage_audit_logs a LEFT JOIN user_profiles u ON a.staff_id = u.id WHERE a.order_id = o.order_id AND a.action = 'INLINE_UPDATE' AND a.details LIKE '%비고%' ORDER BY a.timestamp DESC LIMIT 1) as note_author,
    (SELECT a.timestamp FROM luggage_audit_logs a WHERE a.order_id = o.order_id AND a.action = 'INLINE_UPDATE' AND a.details LIKE '%비고%' ORDER BY a.timestamp DESC LIMIT 1) as note_updated_at
    FROM luggage_orders o WHERE 1=1`;
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
      .all<{ order_id: string; name: string | null; tag_no: string | null; status: string; prepaid_amount: number; created_at: string; expected_pickup_at: string | null; note: string | null; payment_method: string | null; in_warehouse: number; parent_order_id: string | null; flying_pass_tier: string | null; note_author: string | null; note_updated_at: string | null }>(),
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
                  <col data-col-key="pay_status" />
                  <col data-col-key="pickup_status" />
                  <col data-col-key="actions" />
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
                    <th data-col-key="pay_status">결제상태</th>
                    <th data-col-key="pickup_status">수령상태</th>
                    <th data-col-key="actions">업무처리</th>
                    <th data-col-key="note">비고</th>
                    <th data-col-key="detail">상세</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.results.map((o) => {
                    const rowClasses = [
                      o.status === "CANCELLED" && "is-cancelled",
                      o.in_warehouse && "is-in-warehouse",
                    ].filter(Boolean).join(" ");
                    return (
                    <tr data-order-id={o.order_id} data-status={o.status} class={rowClasses || undefined}>
                      <td data-col-key="name">
                        <span class="editable" data-field="name" data-order-id={o.order_id}>{o.name || "-"}</span>
                        {o.parent_order_id && <span class="extension-badge">연장</span>}
                      </td>
                      <td data-col-key="tag_no"><span class={`editable tag-pill ${tagColorClass(o.tag_no)}`} data-field="tag_no" data-order-id={o.order_id}>{o.tag_no || "-"}</span></td>
                      <td data-col-key="created_time">{o.created_at ? new Date(o.created_at).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td data-col-key="price" class="price-cell" data-order-id={o.order_id} data-tier={o.flying_pass_tier || "NONE"} data-method={o.payment_method || "CASH"} style="cursor:pointer;position:relative"><span class="price-display">{`¥${o.prepaid_amount}`}</span></td>
                      <td data-col-key="pickup_time"><span class="editable" data-field="expected_pickup_at" data-order-id={o.order_id} data-type="datetime-local">{o.expected_pickup_at ? new Date(o.expected_pickup_at).toLocaleString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</span></td>
                      <td data-col-key="pay_status"><span class={`status-pill ${o.status === "PAID" || o.status === "PICKED_UP" ? "status-paid" : o.status === "CANCELLED" ? "status-cancelled" : "status-payment_pending"}`}>{o.status === "PAID" || o.status === "PICKED_UP" ? "결제완료" : o.status === "CANCELLED" ? "취소" : "결제대기"}</span></td>
                      <td data-col-key="pickup_status"><span class={`status-pill ${o.status === "PICKED_UP" ? "status-picked_up" : o.status === "CANCELLED" ? "status-cancelled" : "status-payment_pending"}`}>{o.status === "PICKED_UP" ? "수령완료" : o.status === "CANCELLED" ? "취소" : "미수령"}</span></td>
                      <td data-col-key="actions">
                        <div class="inline-actions">
                          <button
                            class={`payment-state-btn ${o.status === "PAID" || o.status === "PICKED_UP" ? "is-paid" : "is-pending"}`}
                            data-action="toggle-payment"
                            data-order-id={o.order_id}
                            disabled={o.status === "PICKED_UP" || o.status === "CANCELLED"}
                          >
                            {o.status === "PAID" || o.status === "PICKED_UP" ? "결제완료" : "결제대기"}
                          </button>
                          {o.status !== "PICKED_UP" && o.status !== "CANCELLED" && (
                            <button class="pickup-complete-btn" data-action="pickup" data-order-id={o.order_id}>수령완료</button>
                          )}
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
                      <td data-col-key="detail"><a class="btn btn-secondary btn-sm" href={`/staff/orders/${o.order_id}`}>상세</a></td>
                    </tr>
                    );
                  })}
                  {orders.results.length === 0 && (
                    <tr><td colspan={10}>데이터가 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            var FIELD_LABELS={name:'이름',tag_no:'짐번호',expected_pickup_at:'짐 찾는 시각',note:'비고'};
            var TAG_COLORS=[[1,10,'tag-color-orange'],[11,20,'tag-color-blue'],[21,30,'tag-color-yellow'],[31,40,'tag-color-green'],[41,50,'tag-color-purple'],[51,60,'tag-color-black'],[61,70,'tag-color-gray'],[71,80,'tag-color-pink'],[81,90,'tag-color-brown']];

            /* ── Inline edit (click-to-edit for name, tag, pickup, note) ── */
            document.querySelectorAll('.editable').forEach(function(el){
              el.addEventListener('click', function(){
                if(el.querySelector('input')) return;
                var orig = el.textContent.trim();
                if(orig==='-') orig='';
                var inp = document.createElement('input');
                inp.className='edit-input';
                inp.type = el.dataset.type || 'text';
                inp.value = el.dataset.type==='datetime-local' ? (el.dataset.rawValue||'') : orig;
                el.textContent='';
                el.appendChild(inp);
                inp.focus();

                function finish(){
                  var newVal = inp.value;
                  if(newVal===orig){ restore(orig); return; }
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

            function togglePayment(btn,oid){
              if(!confirm('결제 상태를 변경하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/toggle-payment').then(function(r){return r.json();}).then(function(d){
                if(!d.success){alert(d.error||'실패');return;}
                var isPaid=d.status==='PAID';
                btn.className='payment-state-btn '+(isPaid?'is-paid':'is-pending');
                btn.textContent=isPaid?'결제완료':'결제대기';
                var row=btn.closest('tr');
                row.dataset.status=d.status;
                var payPill=row.querySelector('[data-col-key="pay_status"] .status-pill');
                if(payPill){payPill.className='status-pill '+(isPaid?'status-paid':'status-payment_pending');payPill.textContent=isPaid?'결제완료':'결제대기';}
              });
            }

            function doPickup(oid){
              if(!confirm('수령완료 처리하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/pickup').then(function(r){
                if(r.ok) location.reload();
                else alert('처리 실패');
              });
            }

            function undoPickup(oid){
              if(!confirm('수령완료를 취소하시겠습니까?')) return;
              apiPost('/staff/api/orders/'+oid+'/undo-pickup').then(function(r){
                if(r.ok) location.reload();
                else alert('처리 실패');
              });
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
                  '<div class="btn-row"><button class="btn btn-secondary btn-sm" data-pop-cancel>취소</button><button class="btn btn-primary btn-sm" data-pop-save>저장</button></div>';
                cell.appendChild(pop);
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
                    var pd=cell.querySelector('.price-display');if(pd)pd.textContent='¥'+d.prepaid_amount;
                  });
                });
              });
            });

            function closePopover(){
              if(activePopover){activePopover.pop.remove();activePopover=null;}
            }
            document.addEventListener('click',function(e){
              if(activePopover&&!activePopover.cell.contains(e.target)) closePopover();
            });

          })();
        ` }} />
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
