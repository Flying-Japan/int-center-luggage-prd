/**
 * Staff order detail routes — HTML pages for order management.
 * US-008: Order detail, mark-paid, update, pickup, undo, extension, manual entry, images.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff, insertAuditLog, type StaffUser } from "../middleware/auth";
import { downloadImage, logImageView } from "../lib/r2";
import { buildOrderId, buildTagNo } from "../services/orderNumber";
import { calculatePricePerDay, calculatePrepaidAmount, normalizeFlyingPassTier, flyingPassDiscountAmount } from "../services/pricing";
import { calculateStorageDays, calculateExtraDays } from "../services/storage";
import { calculateExtraAmount } from "../services/pricing";
import { createBugTask } from "../lib/asana";

type Order = {
  order_id: string;
  created_at: string;
  name: string | null;
  phone: string | null;
  suitcase_qty: number;
  backpack_qty: number;
  set_qty: number;
  expected_pickup_at: string | null;
  actual_pickup_at: string | null;
  expected_storage_days: number;
  actual_storage_days: number;
  extra_days: number;
  price_per_day: number;
  discount_rate: number;
  prepaid_amount: number;
  flying_pass_tier: string;
  flying_pass_discount_amount: number;
  staff_prepaid_override_amount: number | null;
  extra_amount: number;
  final_amount: number;
  payment_method: string | null;
  status: string;
  tag_no: string | null;
  note: string | null;
  id_image_url: string | null;
  luggage_image_url: string | null;
  manual_entry: number;
  staff_id: string | null;
  parent_order_id: string | null;
  in_warehouse: number;
  companion_count: number;
  consent_checked: number;
};

const staffOrders = new Hono<AppType>();
staffOrders.use("/*", staffAuth);

// GET /staff/orders/:id — Order detail page
staffOrders.get("/staff/orders/:id", async (c) => {
  const orderId = c.req.param("id");
  const order = await c.env.DB.prepare("SELECT * FROM luggage_orders WHERE order_id = ?")
    .bind(orderId)
    .first<Order>();

  if (!order) return c.html(<p>Order not found</p>, 404);

  // Run independent queries in parallel
  const [auditLogs, extensions] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM luggage_audit_logs WHERE order_id = ? ORDER BY timestamp DESC LIMIT 50"
    )
      .bind(orderId)
      .all(),
    c.env.DB.prepare(
      "SELECT order_id, created_at, status, prepaid_amount FROM luggage_orders WHERE parent_order_id = ? ORDER BY created_at DESC"
    )
      .bind(orderId)
      .all(),
  ]);

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>주문 상세 - {orderId}</title>
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
              <a class="pill-link" href="/staff/dashboard">대시보드</a>
              {staff.role === "admin" && <a class="pill-link" href="/staff/admin/sales">매출관리</a>}
              <span class="pill-user">{staff.display_name || staff.username}</span>
              <form method="post" action="/staff/logout" style="display:inline">
                <button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button>
              </form>
            </nav>
          </div>
        </header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link" href="/staff/bug-report">버그신고</a>
          </nav>

        <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
        <h2 class="hero-title">주문 상세: {orderId}</h2>

        <h2>고객 정보</h2>
        <table>
          <tr><td>이름</td><td>{order.name}</td></tr>
          <tr><td>연락처</td><td>{order.phone}</td></tr>
          <tr><td>동행인원</td><td>{order.companion_count}</td></tr>
          <tr><td>태그번호</td><td>{order.tag_no || "-"}</td></tr>
        </table>

        <h2>짐 정보</h2>
        <table>
          <tr><td>캐리어</td><td>{order.suitcase_qty}</td></tr>
          <tr><td>배낭/가방</td><td>{order.backpack_qty}</td></tr>
          <tr><td>세트</td><td>{order.set_qty}</td></tr>
          <tr><td>창고보관</td><td>{order.in_warehouse ? "예" : "아니오"}</td></tr>
        </table>

        <h2>요금</h2>
        <table>
          <tr><td>1일 요금</td><td>¥{order.price_per_day}</td></tr>
          <tr><td>할인율</td><td>{(order.discount_rate * 100).toFixed(0)}%</td></tr>
          <tr><td>선결제</td><td>¥{order.prepaid_amount}</td></tr>
          <tr><td>패스할인</td><td>¥{order.flying_pass_discount_amount} ({order.flying_pass_tier})</td></tr>
          <tr><td>추가일</td><td>{order.extra_days}일 (¥{order.extra_amount})</td></tr>
          <tr><td>최종금액</td><td>¥{order.final_amount}</td></tr>
          <tr><td>결제방법</td><td>{order.payment_method || "-"}</td></tr>
          <tr><td>상태</td><td>{order.status}</td></tr>
        </table>

        <h2>이미지</h2>
        {order.id_image_url && <p><a href={`/staff/orders/${orderId}/id-image`} target="_blank">신분증 사진 보기</a></p>}
        {order.luggage_image_url && <p><a href={`/staff/orders/${orderId}/luggage-image`} target="_blank">짐 사진 보기</a></p>}

        <h2>메모</h2>
        <p>{order.note || "-"}</p>

        {order.status === "PAYMENT_PENDING" && (
          <form method="post" action={`/staff/orders/${orderId}/mark-paid`}>
            <select name="payment_method">
              <option value="PAY_QR">QR결제</option>
              <option value="CASH">현금</option>
            </select>
            <button type="submit">결제 완료</button>
          </form>
        )}

        {order.status === "PAID" && (
          <form method="post" action={`/staff/orders/${orderId}/mark-picked-up`}>
            <button type="submit">수령 완료</button>
          </form>
        )}

        {order.status === "PICKED_UP" && (
          <form method="post" action={`/staff/orders/${orderId}/undo-picked-up`}>
            <button type="submit">수령 취소</button>
          </form>
        )}

        <h2>연장 주문</h2>
        {extensions.results.length > 0 ? (
          <ul>
            {extensions.results.map((ext: Record<string, unknown>) => (
              <li><a href={`/staff/orders/${ext.order_id as string}`}>{ext.order_id as string}</a> - {ext.status as string}</li>
            ))}
          </ul>
        ) : <p>없음</p>}

        <form method="post" action={`/staff/orders/${orderId}/create-extension`}>
          <button type="submit">연장 주문 생성</button>
        </form>

        <h2>감사 로그</h2>
        <table>
          <tr><th>시간</th><th>직원</th><th>행동</th></tr>
          {auditLogs.results.map((log: Record<string, unknown>) => (
            <tr>
              <td>{log.timestamp as string}</td>
              <td>{log.staff_id as string}</td>
              <td>{log.action as string}</td>
            </tr>
          ))}
        </table>
        </main>
      </body>
    </html>
  );
});

// POST /staff/orders/:id/mark-paid
staffOrders.post("/staff/orders/:id/mark-paid", async (c) => {
  const orderId = c.req.param("id");
  const body = await c.req.parseBody();
  const paymentMethod = String(body.payment_method || "CASH");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    "UPDATE luggage_orders SET status = 'PAID', payment_method = ?, updated_at = datetime('now') WHERE order_id = ?"
  )
    .bind(paymentMethod, orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "MARK_PAID");

  return c.redirect(`/staff/orders/${orderId}`);
});

// POST /staff/orders/:id/update
staffOrders.post("/staff/orders/:id/update", async (c) => {
  const orderId = c.req.param("id");
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const allowedFields = ["name", "phone", "tag_no", "note", "expected_pickup_at"];
  const updates: string[] = [];
  const values: (string | number)[] = [];

  for (const field of allowedFields) {
    if (field in body) {
      updates.push(`${field} = ?`);
      values.push(String(body[field]));
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(orderId);
    await c.env.DB.prepare(
      `UPDATE luggage_orders SET ${updates.join(", ")} WHERE order_id = ?`
    )
      .bind(...values)
      .run();
  }

  await insertAuditLog(c.env.DB, orderId, staff.id, "UPDATE");

  return c.redirect(`/staff/orders/${orderId}`);
});

// POST /staff/orders/:id/mark-picked-up
staffOrders.post("/staff/orders/:id/mark-picked-up", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);
  const now = new Date().toISOString();

  const order = await c.env.DB.prepare(
    "SELECT price_per_day, created_at, expected_pickup_at FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{ price_per_day: number; created_at: string; expected_pickup_at: string | null }>();

  if (!order) return c.redirect("/staff/dashboard");

  const actualStorageDays = calculateStorageDays(order.created_at, now);
  const extraDays = order.expected_pickup_at ? calculateExtraDays(order.expected_pickup_at, now) : 0;
  const extraAmount = calculateExtraAmount(order.price_per_day, extraDays);

  await c.env.DB.prepare(
    `UPDATE luggage_orders
     SET status = 'PICKED_UP', actual_pickup_at = ?, actual_storage_days = ?,
         extra_days = ?, extra_amount = ?, updated_at = datetime('now')
     WHERE order_id = ?`
  )
    .bind(now, actualStorageDays, extraDays, extraAmount, orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "MARK_PICKED_UP");

  return c.redirect(`/staff/orders/${orderId}`);
});

// POST /staff/orders/:id/undo-picked-up
staffOrders.post("/staff/orders/:id/undo-picked-up", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  await c.env.DB.prepare(
    `UPDATE luggage_orders
     SET status = 'PAID', actual_pickup_at = NULL, actual_storage_days = 0,
         extra_days = 0, extra_amount = 0, updated_at = datetime('now')
     WHERE order_id = ?`
  )
    .bind(orderId)
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "UNDO_PICKED_UP");

  return c.redirect(`/staff/orders/${orderId}`);
});

// POST /staff/orders/:id/create-extension
staffOrders.post("/staff/orders/:id/create-extension", async (c) => {
  const parentOrderId = c.req.param("id");
  const staff = getStaff(c);

  const parent = await c.env.DB.prepare("SELECT * FROM luggage_orders WHERE order_id = ?")
    .bind(parentOrderId)
    .first<Order>();

  if (!parent) return c.redirect("/staff/dashboard");

  // Find root order (follow parent chain)
  const rootId = parent.parent_order_id || parentOrderId;

  const newOrderId = await buildOrderId(c.env.DB);
  const { setQty, pricePerDay } = calculatePricePerDay(parent.suitcase_qty, parent.backpack_qty);

  await c.env.DB.prepare(
    `INSERT INTO luggage_orders (
       order_id, name, phone, companion_count, suitcase_qty, backpack_qty, set_qty,
       price_per_day, flying_pass_tier, status, manual_entry, staff_id, parent_order_id, note
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', 1, ?, ?, ?)`
  )
    .bind(
      newOrderId, parent.name, parent.phone, parent.companion_count,
      parent.suitcase_qty, parent.backpack_qty, setQty, pricePerDay,
      parent.flying_pass_tier, staff.id, rootId,
      `연장 주문 (원본: ${parentOrderId})`
    )
    .run();

  await insertAuditLog(c.env.DB, newOrderId, staff.id, "CREATE_EXTENSION");

  return c.redirect(`/staff/orders/${newOrderId}`);
});

// POST /staff/orders/manual — Manual order creation
staffOrders.post("/staff/orders/manual", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const suitcaseQty = parseInt(String(body.suitcase_qty || "0"), 10);
  const backpackQty = parseInt(String(body.backpack_qty || "0"), 10);
  const companionCount = parseInt(String(body.companion_count || "0"), 10);
  const flyingPassTier = normalizeFlyingPassTier(String(body.flying_pass_tier || ""));
  const expectedPickupAt = String(body.expected_pickup_at || "");
  const note = String(body.note || "").trim();

  if (!name || (suitcaseQty === 0 && backpackQty === 0)) {
    return c.redirect("/staff/dashboard?error=Name and at least one bag required");
  }

  const orderId = await buildOrderId(c.env.DB);
  const tagNo = await buildTagNo(c.env.DB);
  const { setQty, pricePerDay } = calculatePricePerDay(suitcaseQty, backpackQty);

  let expectedStorageDays = 1;
  if (expectedPickupAt) {
    expectedStorageDays = calculateStorageDays(new Date().toISOString(), expectedPickupAt);
  }

  const { discountRate, prepaidAmount } = calculatePrepaidAmount(pricePerDay, expectedStorageDays);
  const passDiscount = flyingPassDiscountAmount(prepaidAmount, flyingPassTier);

  await c.env.DB.prepare(
    `INSERT INTO luggage_orders (
       order_id, name, phone, companion_count, suitcase_qty, backpack_qty, set_qty,
       expected_pickup_at, expected_storage_days, price_per_day, discount_rate,
       prepaid_amount, flying_pass_tier, flying_pass_discount_amount,
       status, tag_no, note, manual_entry, staff_id, consent_checked
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, ?, 1, ?, 1)`
  )
    .bind(
      orderId, name, phone, companionCount, suitcaseQty, backpackQty, setQty,
      expectedPickupAt || null, expectedStorageDays, pricePerDay, discountRate,
      prepaidAmount, flyingPassTier, passDiscount,
      tagNo, note || null, staff.id
    )
    .run();

  await insertAuditLog(c.env.DB, orderId, staff.id, "MANUAL_CREATE");

  return c.redirect(`/staff/orders/${orderId}`);
});

// GET /staff/orders/:id/id-image — Serve ID photo with audit logging
staffOrders.get("/staff/orders/:id/id-image", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  const order = await c.env.DB.prepare("SELECT id_image_url FROM luggage_orders WHERE order_id = ?")
    .bind(orderId)
    .first<{ id_image_url: string | null }>();

  if (!order?.id_image_url) return c.json({ error: "Image not found" }, 404);

  await logImageView(c.env.DB, orderId, staff.id, "VIEW_ID");

  const image = await downloadImage(c.env.IMAGES, order.id_image_url);
  if (!image) return c.json({ error: "Image not found in storage" }, 404);

  return new Response(image.body, {
    headers: { "Content-Type": image.contentType, "Cache-Control": "no-store" },
  });
});

// GET /staff/orders/:id/luggage-image — Serve luggage photo with audit logging
staffOrders.get("/staff/orders/:id/luggage-image", async (c) => {
  const orderId = c.req.param("id");
  const staff = getStaff(c);

  const order = await c.env.DB.prepare("SELECT luggage_image_url FROM luggage_orders WHERE order_id = ?")
    .bind(orderId)
    .first<{ luggage_image_url: string | null }>();

  if (!order?.luggage_image_url) return c.json({ error: "Image not found" }, 404);

  await logImageView(c.env.DB, orderId, staff.id, "VIEW_LUGGAGE");

  const image = await downloadImage(c.env.IMAGES, order.luggage_image_url);
  if (!image) return c.json({ error: "Image not found in storage" }, 404);

  return new Response(image.body, {
    headers: { "Content-Type": image.contentType, "Cache-Control": "no-store" },
  });
});

// GET /staff/bug-report — Bug report form
staffOrders.get("/staff/bug-report", (c) => {
  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>버그 신고</title>
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
              <a class="pill-link" href="/staff/dashboard">대시보드</a>
              <span class="pill-user">{staff.display_name || staff.username}</span>
              <form method="post" action="/staff/logout" style="display:inline">
                <button type="submit" class="pill-link" style="background:none;border:none;cursor:pointer;padding:4px 10px;font:inherit;color:inherit">로그아웃</button>
              </form>
            </nav>
          </div>
        </header>
        <main class="container">
          <nav class="staff-menu" aria-label="직원 메뉴">
            <a class="staff-menu-link" href="/staff/dashboard">대시보드</a>
            <a class="staff-menu-link" href="/staff/cash-closing">정산마감</a>
            <a class="staff-menu-link" href="/staff/handover">인수인계</a>
            <a class="staff-menu-link" href="/staff/lost-found">분실물</a>
            <a class="staff-menu-link" href="/staff/schedule">스케줄</a>
            <a class="staff-menu-link is-active" href="/staff/bug-report">버그신고</a>
          </nav>
          <a class="btn-link" href="/staff/dashboard">← 대시보드</a>
          <section class="card">
            <h3 class="card-title">버그 신고</h3>
            <form method="post" action="/staff/bug-report" class="grid2">
              <label class="field">
                <span class="field-label">제목</span>
                <input class="control" type="text" name="title" required />
              </label>
              <label class="field">
                <span class="field-label">우선순위</span>
                <select class="control" name="priority">
                  <option value="low">낮음</option>
                  <option value="medium" selected>보통</option>
                  <option value="high">높음</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">신고자 이름</span>
                <input class="control" type="text" name="reporter_name" required />
              </label>
              <label class="field" style="grid-column: 1 / -1">
                <span class="field-label">내용</span>
                <textarea class="control" name="description" required rows={6} />
              </label>
              <div class="button-wrap">
                <button class="btn btn-primary" type="submit">제출</button>
              </div>
            </form>
          </section>
        </main>
      </body>
    </html>
  );
});

// POST /staff/bug-report — Submit bug report
staffOrders.post("/staff/bug-report", async (c) => {
  const body = await c.req.parseBody();
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const reporterName = String(body.reporter_name || "").trim();
  const priority = String(body.priority || "medium").trim();

  if (!title || !description || !reporterName) {
    return c.redirect("/staff/bug-report?error=1");
  }

  const taskGid = await createBugTask(
    c.env.ASANA_PAT,
    c.env.ASANA_BUG_PROJECT_GID,
    title,
    description,
    reporterName,
    priority
  );

  if (taskGid === null && c.env.ASANA_PAT) {
    return c.redirect("/staff/bug-report?error=submit");
  }

  return c.redirect("/staff/bug-report?success=1");
});

export default staffOrders;
