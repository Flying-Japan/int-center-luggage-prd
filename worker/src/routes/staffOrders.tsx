/**
 * Staff order detail routes — HTML pages for order management.
 * US-008: Order detail, mark-paid, update, pickup, undo, extension, manual entry, images.
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, editorAuth, getStaff, insertAuditLog } from "../middleware/auth";
import { downloadImage, logImageView } from "../lib/r2";
import { buildOrderId, buildSameDayTag, buildOvernightTag } from "../services/orderNumber";
import { calculatePricePerDay, calculatePrepaidAmount, normalizeFlyingPassTier, flyingPassDiscountAmount, calculateExtraAmount } from "../services/pricing";
import { calculateStorageDays, calculateExtraDays } from "../services/storage";
import { createBugTask } from "../lib/asana";
import { createSupabaseAdmin } from "../lib/supabase";
import { displayOrderStatus, displayPaymentMethod, displayFlyingPassTier } from "../lib/display";
import { fmtJST } from "../lib/dateFormat";
import { StaffTopbar, NewOrderAlert } from "../lib/components";
import {
  normalizePaymentAllocation,
  payableAmountFromOrder,
  paymentAllocationDetails,
  paymentAllocationStatements,
} from "../lib/payments";

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
  updated_at: string;
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
      `SELECT a.* FROM luggage_audit_logs a
       WHERE a.order_id = ? ORDER BY a.timestamp DESC LIMIT 50`
    )
      .bind(orderId)
      .all(),
    c.env.DB.prepare(
      "SELECT order_id, created_at, status, prepaid_amount FROM luggage_orders WHERE parent_order_id = ? ORDER BY created_at DESC"
    )
      .bind(orderId)
      .all(),
  ]);

  // Bulk-fetch staff names from Supabase PG
  const staffIds = [...new Set(auditLogs.results.map((l: Record<string, unknown>) => l.staff_id as string).filter(Boolean))];
  const staffNameMap: Record<string, string> = {};
  if (staffIds.length > 0) {
    const supabaseAdmin = createSupabaseAdmin(c.env);
    const { data: profiles } = await supabaseAdmin.from("user_profiles").select("id, display_name, username").in("id", staffIds);
    if (profiles) {
      for (const p of profiles) staffNameMap[p.id] = p.display_name || p.username || p.id;
    }
  }

  const staff = getStaff(c);
  const error = c.req.query("error") || "";

  const fmtDatetimeLocal = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 16);
  };

  const yen = (n: number) => `¥${n.toLocaleString()}`;

  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>접수 상세 - {orderId}</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/dashboard" />
        <main class="container">
          {/* Hero */}
          <section class="hero hero-row">
            <div>
              <p class="hero-kicker">접수 관리</p>
              <h2 class="hero-title">접수 상세: {orderId}</h2>
              <p class="hero-desc">수정 가능한 필드만 조정 가능합니다.</p>
            </div>
            <a class="btn btn-secondary" href="/staff/dashboard">목록으로</a>
          </section>
          {error && <p class="error-note" role="alert">{error}</p>}

          {/* Edit card */}
          <section class="card">
            <h3 class="card-title">직원 수정 (허용 항목)</h3>
            <p class="card-desc">이름/전화번호/짐번호/예정 픽업일시/비고만 수정됩니다. 결제 및 수령 상태 처리는 아래에서 진행하세요.</p>
            <form action={`/staff/orders/${orderId}/update`} method="post" class="grid2">
              <label class="field">
                <span class="field-label">이름</span>
                <input class="control" type="text" name="name" value={order.name || ""} required />
              </label>
              <label class="field">
                <span class="field-label">전화번호</span>
                <input class="control" type="text" name="phone" value={order.phone || ""} required />
              </label>
              <label class="field">
                <span class="field-label">짐번호</span>
                <input class="control" type="text" name="tag_no" value={order.tag_no || ""} />
              </label>
              <label class="field">
                <span class="field-label">예정 픽업일/시간</span>
                <input class="control" type="datetime-local" name="expected_pickup_at" value={fmtDatetimeLocal(order.expected_pickup_at)} required />
              </label>
              <label class="field">
                <span class="field-label">비고</span>
                <textarea class="control" name="note" rows={3} placeholder="메모를 입력하세요.">{order.note || ""}</textarea>
              </label>
              <label class="button-wrap">
                <span class="field-label sr-only">저장</span>
                <button class="btn btn-primary" type="submit">저장</button>
              </label>
            </form>
          </section>

          {/* Images card */}
          <section class="grid2">
            <section class="card">
              <h3 class="card-title">신분증 사진</h3>
              {order.id_image_url
                ? <img class="thumb" src={`/staff/orders/${orderId}/id-image`} alt="신분증 사진" />
                : <p class="muted">이미지 없음</p>}
            </section>
            <section class="card">
              <h3 class="card-title">짐 사진</h3>
              {order.luggage_image_url
                ? <img class="thumb" src={`/staff/orders/${orderId}/luggage-image`} alt="짐 사진" />
                : <p class="muted">이미지 없음</p>}
            </section>
          </section>

          {/* Summary card */}
          <section class="card">
            <h3 class="card-title">요약</h3>
            <div class="summary-grid">
              <p><strong>상태</strong><span class={`status-pill status-${order.status.toLowerCase()}`}>{displayOrderStatus(order.status)}</span></p>
              <p><strong>수기접수 여부</strong><span>{order.manual_entry ? "예" : "아니오"}</span></p>
              <p><strong>생성</strong><span>{fmtJST(order.created_at)}</span></p>
              <p><strong>최종 수정시각</strong><span>{fmtJST(order.updated_at)}</span></p>
              <p><strong>예정 픽업</strong><span>{fmtJST(order.expected_pickup_at)}</span></p>
              <p><strong>실제 픽업</strong><span>{fmtJST(order.actual_pickup_at)}</span></p>
              <p><strong>짐번호</strong><span>{order.tag_no || "-"}</span></p>
              <p><strong>결제수단</strong><span>{displayPaymentMethod(order.payment_method)}</span></p>
              <p><strong>동행인원</strong><span>{order.companion_count}</span></p>
              <p><strong>비고</strong><span>{order.note || "-"}</span></p>
              <p><strong>짐</strong><span>캐리어 {order.suitcase_qty}, 백팩 {order.backpack_qty}, 세트 {order.set_qty}</span></p>
              <p><strong>요금</strong><span>일 {yen(order.price_per_day)}, 선결제 {yen(order.prepaid_amount)}, 추가 {yen(order.extra_amount)}, 최종 {yen(order.final_amount)}</span></p>
              <p><strong>멤버할인</strong><span>{displayFlyingPassTier(order.flying_pass_tier)} / 할인 {yen(order.flying_pass_discount_amount)} / 직원수정 {order.staff_prepaid_override_amount !== null ? yen(order.staff_prepaid_override_amount) : "없음"}</span></p>
              <p><strong>일수</strong><span>예정 {order.expected_storage_days}, 실제 {order.actual_storage_days || "-"}, 초과 {order.extra_days}</span></p>
              {order.parent_order_id && (
                <p><strong>원본 접수</strong><span><a href={`/staff/orders/${order.parent_order_id}`} style="color:var(--primary);text-decoration:underline">{order.parent_order_id}</a> <span class="extension-badge">연장</span></span></p>
              )}
            </div>
          </section>

          {/* Extension orders */}
          {extensions.results.length > 0 && (
            <section class="card">
              <h3 class="card-title">연장 접수 내역</h3>
              <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>접수번호</th>
                    <th>생성일</th>
                    <th>금액</th>
                    <th>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {extensions.results.map((ext: Record<string, unknown>) => (
                    <tr>
                      <td><a href={`/staff/orders/${ext.order_id as string}`} style="color:var(--primary);text-decoration:underline">{ext.order_id as string}</a></td>
                      <td>{ext.created_at ? (ext.created_at as string).slice(0, 10) : "-"}</td>
                      <td>{yen(ext.prepaid_amount as number)}</td>
                      <td><span class={`status-pill status-${(ext.status as string).toLowerCase()}`}>{displayOrderStatus(ext.status as string)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
          )}

          {/* Actions card */}
          <section class="card">
            <h3 class="card-title">업무 처리</h3>
            <div class="detail-action-grid">
              {/* 결제 처리 */}
              <section class="detail-action-box">
                <h4 class="detail-action-title">결제 처리</h4>
                {order.status === "PAYMENT_PENDING" ? (
                  <>
                    <p class="card-desc">짐번호는 접수 순서대로 자동 부여됩니다.</p>
                    <form action={`/staff/orders/${orderId}/mark-paid`} method="post" class="detail-action-form">
                      <label class="field">
                        <span class="field-label">결제수단</span>
                        <select class="control" name="payment_method">
                          <option value="PAY_QR" selected={order.payment_method === "PAY_QR"}>QR결제</option>
                          <option value="CASH" selected={order.payment_method === "CASH"}>현금</option>
                          <option value="MIXED">분할결제</option>
                        </select>
                      </label>
                      <div class="grid2">
                        <label class="field">
                          <span class="field-label">분할 현금</span>
                          <input class="control" type="number" name="cash_amount" min="0" step="1" placeholder="분할일 때만" />
                        </label>
                        <label class="field">
                          <span class="field-label">분할 QR</span>
                          <input class="control" type="number" name="qr_amount" min="0" step="1" placeholder="분할일 때만" />
                        </label>
                      </div>
                      <button class="btn btn-primary" type="submit">결제 완료</button>
                    </form>
                  </>
                ) : (
                  <>
                    <p class="card-desc">현재 결제 상태는 결제완료입니다.</p>
                    <span class="status-pill status-paid">결제완료</span>
                  </>
                )}
              </section>

              {/* 수령 처리 */}
              <section class="detail-action-box">
                <h4 class="detail-action-title">수령 처리</h4>
                <p class="card-desc">초과일은 할인 없이 정가 후불 계산됩니다.</p>
                {order.status !== "PICKED_UP" ? (
                  <form action={`/staff/orders/${orderId}/mark-picked-up`} method="post" class="detail-action-form">
                    <button class="btn btn-primary" type="submit">수령 완료</button>
                  </form>
                ) : (
                  <>
                    <p class="card-desc">수령 완료 시각: {fmtJST(order.actual_pickup_at)}</p>
                    <form action={`/staff/orders/${orderId}/undo-picked-up`} method="post" class="detail-action-form">
                      <button class="btn btn-secondary" type="submit">수령 완료 취소</button>
                    </form>
                  </>
                )}
              </section>

              {/* 연장 접수 */}
              {order.status !== "PICKED_UP" && (
                <section class="detail-action-box">
                  <h4 class="detail-action-title">연장 접수</h4>
                  <p class="card-desc">수동으로 연장 접수를 생성합니다 (1일, 할인 없음).</p>
                  <form action={`/staff/orders/${orderId}/create-extension`} method="post" class="detail-action-form">
                    <button class="btn btn-secondary" type="submit">연장 접수 생성</button>
                  </form>
                </section>
              )}
            </div>
          </section>

          {/* Audit log */}
          <section class="card">
            <h3 class="card-title">활동 이력</h3>
            {auditLogs.results.length > 0 ? (
              <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>시간</th>
                    <th>직원</th>
                    <th>행동</th>
                    <th>상세</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.results.map((l: Record<string, unknown>) => (
                    <tr>
                      <td style="white-space:nowrap">{l.timestamp ? new Date(l.timestamp as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td>{staffNameMap[l.staff_id as string] || (l.staff_id as string) || "-"}</td>
                      <td><span class="status-pill" style="font-size:10px">{l.action as string}</span></td>
                      <td>{(l.details as string) || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            ) : (
              <p class="muted">이력 없음</p>
            )}
          </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// POST /staff/orders/:id/mark-paid
staffOrders.post("/staff/orders/:id/mark-paid", editorAuth, async (c) => {
  const orderId = c.req.param("id");
  if (!orderId) return c.redirect("/staff/dashboard");
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const order = await c.env.DB.prepare(
    `SELECT order_id, date(created_at, '+9 hours') as business_date,
            prepaid_amount, final_amount, extra_amount
     FROM luggage_orders WHERE order_id = ?`
  )
    .bind(orderId)
    .first<{
      order_id: string;
      business_date: string;
      prepaid_amount: number;
      final_amount: number | null;
      extra_amount: number | null;
    }>();
  if (!order) return c.redirect("/staff/dashboard");

  const allocation = normalizePaymentAllocation(body as Record<string, unknown>, payableAmountFromOrder(order));
  if ("error" in allocation) return c.redirect(`/staff/orders/${orderId}?error=${encodeURIComponent(allocation.error)}`);

  await c.env.DB.batch([
    ...paymentAllocationStatements(c.env.DB, orderId, order.business_date, staff.id, allocation),
    c.env.DB.prepare(
      "UPDATE luggage_orders SET status = 'PAID', payment_method = ?, updated_at = datetime('now') WHERE order_id = ?"
    ).bind(allocation.paymentMethod, orderId),
  ]);

  await insertAuditLog(c.env.DB, orderId, staff.id, "MARK_PAID", paymentAllocationDetails(allocation));

  return c.redirect(`/staff/orders/${orderId}`);
});

// POST /staff/orders/:id/update
staffOrders.post("/staff/orders/:id/update", editorAuth, async (c) => {
  const orderId = c.req.param("id");
  if (!orderId) return c.redirect("/staff/dashboard");
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const allowedFields = ["name", "phone", "tag_no", "note", "expected_pickup_at"];
  const updates: string[] = [];
  const values: (string | number)[] = [];

  for (const field of allowedFields) {
    if (field in body) {
      updates.push(`${field} = ?`);
      let val = String(body[field]);
      // Convert JST datetime-local to UTC ISO for storage
      if (field === "expected_pickup_at" && val && !val.endsWith("Z")) {
        const normalized = val.replace(/:\d{2}$/, "").slice(0, 16);
        val = new Date(normalized + ":00+09:00").toISOString();
      }
      values.push(val);
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
staffOrders.post("/staff/orders/:id/mark-picked-up", editorAuth, async (c) => {
  const orderId = c.req.param("id");
  if (!orderId) return c.redirect("/staff/dashboard");
  const staff = getStaff(c);
  const now = new Date().toISOString();

  const order = await c.env.DB.prepare(
    "SELECT status, price_per_day, created_at, expected_pickup_at FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{ status: string; price_per_day: number; created_at: string; expected_pickup_at: string | null }>();

  if (!order) return c.redirect("/staff/dashboard");
  if (order.status !== "PAID") return c.redirect(`/staff/orders/${orderId}?error=결제 완료된 주문만 수령 처리 가능`);

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
staffOrders.post("/staff/orders/:id/undo-picked-up", editorAuth, async (c) => {
  const orderId = c.req.param("id");
  if (!orderId) return c.redirect("/staff/dashboard");
  const staff = getStaff(c);

  const current = await c.env.DB.prepare(
    "SELECT status FROM luggage_orders WHERE order_id = ?"
  )
    .bind(orderId)
    .first<{ status: string }>();

  if (!current || current.status !== "PICKED_UP") {
    return c.redirect(`/staff/orders/${orderId}?error=수령완료 상태인 주문만 취소할 수 있습니다`);
  }

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
staffOrders.post("/staff/orders/:id/create-extension", editorAuth, async (c) => {
  const parentOrderId = c.req.param("id");
  if (!parentOrderId) return c.redirect("/staff/dashboard");
  const staff = getStaff(c);

  const parent = await c.env.DB.prepare("SELECT * FROM luggage_orders WHERE order_id = ?")
    .bind(parentOrderId)
    .first<Order>();

  if (!parent) return c.redirect("/staff/dashboard");
  if (parent.status === "CANCELLED" || parent.status === "PICKED_UP") return c.redirect(`/staff/orders/${parentOrderId}`);

  // Find root order (follow parent chain)
  const rootId = parent.parent_order_id || parentOrderId;

  const newOrderId = await buildOrderId(c.env.DB, undefined, false, "ext");
  // Reuse parent's tag_no — extension is for the same physical luggage.
  // Consistent with auto-extension behavior (extension.ts:51).
  const tagNo = parent.tag_no ?? "";
  const { setQty, pricePerDay } = calculatePricePerDay(parent.suitcase_qty, parent.backpack_qty);

  try {
    await c.env.DB.prepare(
      `INSERT INTO luggage_orders (
         order_id, name, phone, companion_count, suitcase_qty, backpack_qty, set_qty,
         price_per_day, flying_pass_tier, status, tag_no, manual_entry, staff_id, parent_order_id, note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, 1, ?, ?, ?)`
    )
      .bind(
        newOrderId, parent.name, parent.phone, parent.companion_count,
        parent.suitcase_qty, parent.backpack_qty, setQty, pricePerDay,
        parent.flying_pass_tier, tagNo, staff.id, rootId,
        `연장 주문 (원본: ${parentOrderId})`
      )
      .run();
  } catch (e) {
    console.error("Extension order insert failed:", e);
    return c.redirect(`/staff/orders/${parentOrderId}?error=연장접수 실패`);
  }

  await insertAuditLog(c.env.DB, newOrderId, staff.id, "CREATE_EXTENSION", `원본: ${parentOrderId}`);
  await insertAuditLog(c.env.DB, parentOrderId, staff.id, "CREATE_EXTENSION", `연장접수 생성: ${newOrderId}`);

  return c.redirect(`/staff/orders/${newOrderId}`);
});

// POST /staff/orders/manual — Manual order creation
staffOrders.post("/staff/orders/manual", editorAuth, async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const suitcaseQty = Math.min(99, parseInt(String(body.suitcase_qty || "0"), 10));
  const backpackQty = Math.min(99, parseInt(String(body.backpack_qty || "0"), 10));
  const companionCount = parseInt(String(body.companion_count || "0"), 10);
  const flyingPassTier = normalizeFlyingPassTier(String(body.flying_pass_tier || ""));
  const expectedPickupAt = String(body.expected_pickup_at || "");
  const rawNote = String(body.note || "").trim();

  // Free reason: 지인 접수, 블로거 방문, 쿠폰, 기타
  const freeReason = String(body.free_reason || "").trim();
  const freeReasonText = String(body.free_reason_text || "").trim();
  const isFree = freeReason !== "";
  const freeLabel = freeReason === "기타" ? (freeReasonText || "기타") : freeReason;
  const note = isFree
    ? `[무료: ${freeLabel}]${rawNote ? " " + rawNote : ""}`
    : rawNote;

  if (!name || !phone || (suitcaseQty === 0 && backpackQty === 0)) {
    return c.redirect("/staff/dashboard?error=이름, 전화번호, 짐 수량이 필요합니다");
  }

  // Check if pickup is next day or later → overnight counter (96+)
  let isOvernight = false;
  if (expectedPickupAt) {
    const nowJST = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const pickupD = new Date(expectedPickupAt.includes("+") || expectedPickupAt.includes("Z") ? expectedPickupAt : expectedPickupAt + ":00+09:00");
    const pickupJST = new Date(pickupD.getTime() + 9 * 60 * 60 * 1000);
    isOvernight = pickupJST.getUTCDate() !== nowJST.getUTCDate()
      || pickupJST.getUTCMonth() !== nowJST.getUTCMonth()
      || pickupJST.getUTCFullYear() !== nowJST.getUTCFullYear();
  }
  const orderId = await buildOrderId(c.env.DB, undefined, isOvernight);
  // Tag assignment: overnight → 91+ sequential, same-day → Phase 1/2 (1-90)
  const tagNo = isOvernight
    ? await buildOvernightTag(c.env.DB)
    : await buildSameDayTag(c.env.DB);
  if (tagNo === null) {
    return c.redirect("/staff/dashboard?error=당일 태그(1-90) 모두 사용 중입니다");
  }
  const { setQty, pricePerDay } = calculatePricePerDay(suitcaseQty, backpackQty);

  let expectedStorageDays = 1;
  if (expectedPickupAt) {
    expectedStorageDays = calculateStorageDays(new Date().toISOString(), expectedPickupAt);
  }

  const { discountRate, prepaidAmount: rawPrepaid } = calculatePrepaidAmount(pricePerDay, expectedStorageDays);
  const prepaidAmount = isFree ? 0 : rawPrepaid;
  const passDiscount = isFree ? 0 : flyingPassDiscountAmount(prepaidAmount, flyingPassTier);
  const finalPricePerDay = isFree ? 0 : pricePerDay;

  try {
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
        expectedPickupAt || null, expectedStorageDays, finalPricePerDay, discountRate,
        prepaidAmount, flyingPassTier, passDiscount,
        tagNo, note || null, staff.id
      )
      .run();
  } catch (e) {
    console.error("Manual order insert failed:", e);
    return c.redirect("/staff/dashboard?error=수동등록 실패");
  }

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
  const success = c.req.query("success") === "1";
  const error = c.req.query("error");
  return c.html(
    <html lang="ko">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>버그 신고</title>
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/bug-report" />
        <main class="container">
          <section class="hero"><div><p class="hero-kicker">Operations</p><h2 class="hero-title">버그 신고</h2></div></section>
          {success && <p class="success-note" id="page-alert" role="alert">버그 신고가 접수되었습니다. 감사합니다!</p>}
          {error && <p class="error" id="page-alert" role="alert">신고 중 오류가 발생했습니다. 다시 시도해주세요.</p>}
          <section class="card">
            <h3 class="card-title">버그 신고</h3>
            <form method="post" action="/staff/bug-report" enctype="multipart/form-data" class="grid2">
              <label class="field">
                <span class="field-label">제목</span>
                <input class="control" type="text" name="title" required />
              </label>
              <label class="field">
                <span class="field-label">카테고리</span>
                <select class="control" name="category" required>
                  <option value="">선택</option>
                  <option value="ui">UI/디자인</option>
                  <option value="function">기능 오류</option>
                  <option value="data">데이터/매출</option>
                  <option value="auth">로그인/권한</option>
                  <option value="performance">속도/성능</option>
                  <option value="other">기타</option>
                </select>
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
                <span class="field-label">신고자</span>
                <input class="control" type="text" name="reporter_name" value={staff.display_name || staff.username || ""} required />
              </label>
              <label class="field" style="grid-column: 1 / -1">
                <span class="field-label">내용</span>
                <textarea class="control" name="description" required rows={6} placeholder="어떤 상황에서 어떤 문제가 발생했는지 자세히 적어주세요" />
              </label>
              <label class="field" style="grid-column: 1 / -1">
                <span class="field-label">스크린샷 (선택)</span>
                <input class="control" type="file" name="screenshot" accept="image/*" style="padding:8px" />
              </label>
              <div class="button-wrap">
                <button class="btn btn-primary" type="submit">제출</button>
              </div>
            </form>
          </section>
        </main>
        <NewOrderAlert />
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
  const category = String(body.category || "other").trim();
  const screenshot = body.screenshot as File | undefined;

  if (!title || !description || !reporterName || !category) {
    return c.redirect("/staff/bug-report?error=1");
  }

  // Upload screenshot to R2 if provided
  let screenshotUrl = "";
  if (screenshot && screenshot.size > 0) {
    const ext = screenshot.name?.split(".").pop() || "png";
    const key = `bug-reports/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await c.env.IMAGES.put(key, await screenshot.arrayBuffer(), { httpMetadata: { contentType: screenshot.type } });
    screenshotUrl = key;
  }

  const fullDescription = `**Category:** ${category}\n**Reporter:** ${reporterName}\n**Priority:** ${priority}${screenshotUrl ? `\n**Screenshot:** Uploaded (${screenshotUrl})` : ""}\n\n${description}`;

  const taskGid = await createBugTask(
    c.env.ASANA_PAT,
    c.env.ASANA_BUG_PROJECT_GID,
    `[${category.toUpperCase()}] ${title}`,
    fullDescription,
    reporterName,
    priority
  );

  if (taskGid === null && c.env.ASANA_PAT) {
    return c.redirect("/staff/bug-report?error=submit");
  }

  return c.redirect("/staff/bug-report?success=1");
});

export default staffOrders;
