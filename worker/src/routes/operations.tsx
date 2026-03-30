/**
 * Staff operations routes — Cash Closing, Handover Notes, Lost & Found.
 * Covers US-009 (Cash Closing), US-010 (Handover), US-011 (Lost & Found).
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff } from "../middleware/auth";
import { formatDateJST, nowJST } from "../services/storage";
import { StaffTopbar, NewOrderAlert } from "../lib/components";

const ops = new Hono<AppType>();
ops.use("/*", staffAuth);

// ============================================================
// CASH CLOSING (US-009)
// ============================================================

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;
const CLOSING_TYPE_LABELS: Record<string, string> = { MORNING_HANDOVER: "오전", FINAL_CLOSE: "최종" };
const WORKFLOW_LABELS: Record<string, string> = { SUBMITTED: "제출완료" };
const AUDIT_ACTION_LABELS: Record<string, string> = { CREATE: "정산마감 생성", SUBMIT: "정산마감 제출", VERIFY_LOCK: "확인/잠금 (레거시)", EDIT: "정산마감 수정" };

// GET /staff/cash-closing — Cash closing list & form
ops.get("/staff/cash-closing", async (c) => {
  const closings = await c.env.DB.prepare(
    `SELECT c.*, COALESCE(u.display_name, u.username) as staff_name
     FROM luggage_cash_closings c
     LEFT JOIN user_profiles u ON c.staff_id = u.id
     ORDER BY c.created_at DESC LIMIT 60`
  ).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>정산 마감</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/cash-closing" />
        <main class="container">

          <section class="hero"><div><p class="hero-kicker">Operations</p><h2 class="hero-title">정산 마감</h2></div></section>

          <section class="card">
            <h3 class="card-title">새 마감</h3>
            <form method="post" action="/staff/cash-closing">
              <label class="field">
                <span class="field-label">마감 유형</span>
                <select class="control" name="closing_type" style="max-width:180px">
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
                  <span class="field-label">QR결제 실수령액 (PayPay 포함)</span>
                  <input class="control" type="number" name="actual_qr_amount" defaultValue="0" />
                  <small style="color:#666;font-size:11px;margin-top:2px">PayPay + 카카오페이 + 기타 QR결제 실수령 합계</small>
                </label>
              </div>

              <div class="grid2">
                <label class="field">
                  <span class="field-label">렌탈 현금</span>
                  <input class="control" type="number" name="rental_cash" defaultValue="0" />
                </label>
                <label class="field">
                  <span class="field-label">지팡이 환불</span>
                  <input class="control" type="number" name="wand_refund" defaultValue="0" />
                </label>
              </div>

              <label class="field">
                <span class="field-label">메모</span>
                <textarea class="control" name="note"></textarea>
              </label>
              <button class="btn btn-primary" type="submit">정산마감 제출</button>
            </form>
          </section>

          <section class="card" style="padding:12px">
            <h3 class="card-title" style="margin-bottom:8px">최근 마감</h3>
            <div class="table-wrap" style="overflow-x:auto">
              <table style="font-size:11px;border-collapse:collapse;width:100%;min-width:900px">
                <thead>
                  <tr style="background:#f1f5f9;border-bottom:2px solid #cbd5e1">
                    <th style="padding:3px 6px;text-align:left;font-size:10px;color:#475569;white-space:nowrap">날짜</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">10000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">5000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">2000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">1000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">500</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">100</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">50</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">10</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">5</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">1</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569;font-weight:700">Total</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">PayPay</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#2563eb">자동매출</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">차액</th>
                    <th style="padding:3px 4px;text-align:left;font-size:10px;color:#475569">작성자</th>
                    <th style="padding:3px 4px;text-align:left;font-size:10px;color:#475569">메모</th>
                    <th style="padding:3px 4px;font-size:10px"></th>
                  </tr>
                </thead>
                <tbody>
                  {closings.results.map((cl: Record<string, unknown>) => {
                    const diff = cl.difference_amount as number;
                    const noteStr = (cl.note as string) || "";
                    return (
                      <tr style="border-bottom:1px solid #e2e8f0">
                        <td style="padding:2px 6px;white-space:nowrap"><a href={`/staff/cash-closing/${cl.closing_id}`} style="color:var(--primary);font-weight:600">{cl.business_date as string}</a></td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_10000 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_5000 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_2000 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_1000 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_500 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_100 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_50 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_10 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_5 as number || 0}</td>
                        <td style="padding:2px 4px;text-align:right">{cl.count_1 as number || 0}</td>
                        <td style="padding:2px 6px;text-align:right;font-weight:700">¥{(cl.total_amount as number).toLocaleString()}</td>
                        <td style="padding:2px 6px;text-align:right">¥{(cl.paypay_amount as number).toLocaleString()}</td>
                        <td style="padding:2px 6px;text-align:right;color:#2563eb">¥{(cl.check_auto_amount as number).toLocaleString()}</td>
                        <td style={`padding:2px 6px;text-align:right;font-weight:600;color:${diff === 0 ? '#166534' : '#dc2626'}`}>{diff > 0 ? "+" : ""}{diff.toLocaleString()}</td>
                        <td style="padding:2px 4px;white-space:nowrap">{(cl.staff_name as string) || "-"}</td>
                        <td style="padding:2px 4px;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b">{noteStr.length > 20 ? noteStr.slice(0, 20) + "…" : noteStr || "-"}</td>
                        <td style="padding:2px 4px;white-space:nowrap">
                          <a href={`/staff/cash-closing/${cl.closing_id}/edit`} style="color:var(--primary);font-size:10px;margin-right:4px">수정</a>
                          <a href={`/staff/cash-closing/${cl.closing_id}`} style="color:#64748b;font-size:10px">상세</a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </main>
        <NewOrderAlert />
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
  const rentalCash = parseInt(String(body.rental_cash || "0"), 10) || 0;
  const wandRefund = parseInt(String(body.wand_refund || "0"), 10) || 0;
  const closingType = String(body.closing_type || "FINAL_CLOSE");

  // Prevent duplicate closings for same date + type
  const existing = await c.env.DB.prepare(
    "SELECT closing_id FROM luggage_cash_closings WHERE business_date = ? AND closing_type = ?"
  ).bind(businessDate, closingType).first();
  if (existing) return c.redirect("/staff/cash-closing?error=이미 해당 날짜/유형의 정산이 존재합니다");
  const actualAmount = totalAmount + actualQrAmount;

  // Auto-calculate expected amount from today's PAID/PICKED_UP orders (includes extra_amount)
  const autoSales = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN payment_method = 'CASH' OR payment_method IS NULL THEN prepaid_amount + extra_amount ELSE 0 END) as auto_cash,
       SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as auto_qr,
       SUM(prepaid_amount + extra_amount) as auto_total
     FROM luggage_orders
     WHERE date(created_at, '+9 hours') = ? AND status IN ('PAID', 'PICKED_UP')`
  ).bind(businessDate).first<{ auto_cash: number; auto_qr: number; auto_total: number }>();

  const checkAutoAmount = autoSales?.auto_total ?? 0;
  const expectedAmount = checkAutoAmount;
  const differenceAmount = actualAmount - expectedAmount;
  const qrDifferenceAmount = actualQrAmount - (autoSales?.auto_qr ?? 0);

  await c.env.DB.prepare(
    `INSERT INTO luggage_cash_closings (
       business_date, closing_type, workflow_status,
       count_10000, count_5000, count_2000, count_1000, count_500,
       count_100, count_50, count_10, count_5, count_1,
       total_amount, paypay_amount, actual_qr_amount,
       actual_amount, check_auto_amount, expected_amount,
       difference_amount, qr_difference_amount,
       rental_cash, wand_refund,
       staff_id, note
     ) VALUES (?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      businessDate, closingType,
      ...denomValues, totalAmount, paypayAmount, actualQrAmount,
      actualAmount, checkAutoAmount, expectedAmount,
      differenceAmount, qrDifferenceAmount,
      rentalCash, wandRefund,
      staff.id, String(body.note || "") || null
    )
    .run();

  // Get the new closing_id for audit log
  const newClosing = await c.env.DB.prepare(
    "SELECT closing_id FROM luggage_cash_closings WHERE business_date = ? AND closing_type = ?"
  ).bind(businessDate, closingType).first<{ closing_id: number }>();

  if (newClosing) {
    await c.env.DB.prepare(
      "INSERT INTO luggage_cash_closing_audits (closing_id, action, staff_id) VALUES (?, 'SUBMIT', ?)"
    ).bind(newClosing.closing_id, staff.id).run();
  }

  return c.redirect("/staff/cash-closing");
});

// GET /staff/cash-closing/:id — Cash closing detail
ops.get("/staff/cash-closing/:id", async (c) => {
  const closingId = c.req.param("id");
  const closing = await c.env.DB.prepare("SELECT * FROM luggage_cash_closings WHERE closing_id = ?")
    .bind(closingId)
    .first();

  if (!closing) return c.html(<p>Not found</p>, 404);
  const staff = getStaff(c);

  const audits = await c.env.DB.prepare(
    `SELECT a.*, COALESCE(u.display_name, u.username) as staff_name
     FROM luggage_cash_closing_audits a
     LEFT JOIN user_profiles u ON a.staff_id = u.id
     WHERE a.closing_id = ? ORDER BY a.created_at DESC`
  )
    .bind(closingId)
    .all();

  const cl = closing as Record<string, unknown>;
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>정산 상세</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/cash-closing" />
        <main class="container">

          <section class="card">
            <h3 class="card-title">정산 상세: {cl.business_date as string}</h3>
            <p style="margin-bottom:12px">유형: {CLOSING_TYPE_LABELS[cl.closing_type as string] || cl.closing_type as string} | 상태: <span class="status-pill">{WORKFLOW_LABELS[cl.workflow_status as string] || cl.workflow_status as string}</span></p>

            <div class="stat-grid" style="margin-bottom:16px">
              <div class="card stat-card">
                <p class="stat-label">현금 합계</p>
                <p class="stat-value">¥{(cl.total_amount as number).toLocaleString()}</p>
              </div>
              <div class="card stat-card">
                <p class="stat-label">QR 실제</p>
                <p class="stat-value">¥{(cl.actual_qr_amount as number).toLocaleString()}</p>
              </div>
              <div class="card stat-card">
                <p class="stat-label">자동매출</p>
                <p class="stat-value">¥{(cl.check_auto_amount as number).toLocaleString()}</p>
              </div>
              <div class="card stat-card">
                <p class="stat-label">차액</p>
                <p class="stat-value" style={`color:${(cl.difference_amount as number) === 0 ? '#166534' : '#dc2626'}`}>¥{(cl.difference_amount as number).toLocaleString()}</p>
              </div>
            </div>

            <div style="margin-bottom:16px;overflow-x:auto">
              <table style="font-size:11px;border-collapse:collapse;width:100%">
                <thead>
                  <tr style="background:#f1f5f9;border-bottom:1px solid #cbd5e1">
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥10,000</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥5,000</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥2,000</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥1,000</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥500</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥100</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥50</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥10</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥5</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">¥1</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {DENOMS.map(d => <td style="padding:3px 6px;text-align:right;font-weight:600">{((cl[`count_${d}`] as number) || 0).toLocaleString()}</td>)}
                  </tr>
                  <tr style="border-top:1px solid #e2e8f0;color:#64748b;font-size:10px">
                    {DENOMS.map(d => <td style="padding:2px 6px;text-align:right">¥{(((cl[`count_${d}`] as number) || 0) * d).toLocaleString()}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="summary-grid" style="font-size:13px">
              <p><strong>PayPay</strong><span>¥{(cl.paypay_amount as number).toLocaleString()}</span></p>
              <p><strong>총 실제액</strong><span>¥{(cl.actual_amount as number).toLocaleString()}</span></p>
              <p><strong>렌탈 현금</strong><span>¥{((cl.rental_cash as number) || 0).toLocaleString()}</span></p>
              <p><strong>지팡이 환불</strong><span>¥{((cl.wand_refund as number) || 0).toLocaleString()}</span></p>
              <p><strong>QR 차액</strong><span style={`color:${(cl.qr_difference_amount as number) === 0 ? '#166534' : '#dc2626'}`}>¥{(cl.qr_difference_amount as number).toLocaleString()}</span></p>
              <p><strong>메모</strong><span>{(cl.note as string) || "-"}</span></p>
            </div>

            <div style="margin-top:12px;padding:10px;background:#f5f5f4;border-radius:6px;font-size:13px;color:#37352f">
              {(() => {
                const diff = cl.difference_amount as number;
                const typeLabel = CLOSING_TYPE_LABELS[cl.closing_type as string] || cl.closing_type as string;
                return `${typeLabel} 정산현금 (¥${(cl.total_amount as number).toLocaleString()} / ${diff > 0 ? "+" : ""}${diff.toLocaleString()}엔)`;
              })()}
            </div>

            {cl.workflow_status === "SUBMITTED" && (
              <div style="margin-top:12px">
                <a href={`/staff/cash-closing/${closingId}/edit`} class="btn btn-primary">수정</a>
              </div>
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
                    <tr>
                      <td>{a.created_at ? new Date(a.created_at as string + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</td>
                      <td>{AUDIT_ACTION_LABELS[a.action as string] || a.action as string}</td>
                      <td>{(a.staff_name as string) || a.staff_id as string}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// GET /staff/cash-closing/:id/edit — Edit form for existing closing
ops.get("/staff/cash-closing/:id/edit", async (c) => {
  const closingId = c.req.param("id");
  const closing = await c.env.DB.prepare("SELECT * FROM luggage_cash_closings WHERE closing_id = ?")
    .bind(closingId)
    .first();

  if (!closing) return c.html(<p>Not found</p>, 404);
  const cl = closing as Record<string, unknown>;
  // All statuses can be edited

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>정산 수정</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/cash-closing" />
        <main class="container">

          <section class="card">
            <h3 class="card-title">정산 수정: {cl.business_date as string}</h3>
            <p style="margin-bottom:12px">유형: {CLOSING_TYPE_LABELS[cl.closing_type as string] || cl.closing_type as string}</p>
            <form method="post" action={`/staff/cash-closing/${closingId}/edit`}>
              <div class="cash-denom-panel">
                <p class="field-label">현금 내역</p>
                <div class="cash-denom-grid">
                  {DENOMS.map((d) => (
                    <label class="cash-denom-item">
                      <span>¥{d}</span>
                      <input class="control" type="number" name={`count_${d}`} defaultValue={String(cl[`count_${d}`] ?? 0)} min="0" />
                    </label>
                  ))}
                </div>
              </div>

              <div class="grid2">
                <label class="field">
                  <span class="field-label">PayPay 금액</span>
                  <input class="control" type="number" name="paypay_amount" defaultValue={String(cl.paypay_amount ?? 0)} />
                </label>
                <label class="field">
                  <span class="field-label">QR결제 실수령액 (PayPay 포함)</span>
                  <input class="control" type="number" name="actual_qr_amount" defaultValue={String(cl.actual_qr_amount ?? 0)} />
                  <small style="color:#666;font-size:11px;margin-top:2px">PayPay + 카카오페이 + 기타 QR결제 실수령 합계</small>
                </label>
              </div>

              <div class="grid2">
                <label class="field">
                  <span class="field-label">렌탈 현금</span>
                  <input class="control" type="number" name="rental_cash" defaultValue={String(cl.rental_cash ?? 0)} />
                </label>
                <label class="field">
                  <span class="field-label">지팡이 환불</span>
                  <input class="control" type="number" name="wand_refund" defaultValue={String(cl.wand_refund ?? 0)} />
                </label>
              </div>

              <label class="field">
                <span class="field-label">메모</span>
                <textarea class="control" name="note">{(cl.note as string) || ""}</textarea>
              </label>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-primary" type="submit">수정 저장</button>
                <a href={`/staff/cash-closing/${closingId}`} class="btn btn-secondary">취소</a>
              </div>
            </form>
          </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// POST /staff/cash-closing/:id/edit — Update existing closing
ops.post("/staff/cash-closing/:id/edit", async (c) => {
  const closingId = c.req.param("id");
  const staff = getStaff(c);
  const body = await c.req.parseBody();

  // Only allow editing SUBMITTED closings
  const existing = await c.env.DB.prepare("SELECT * FROM luggage_cash_closings WHERE closing_id = ? AND workflow_status = 'SUBMITTED'")
    .bind(closingId)
    .first();
  if (!existing) return c.redirect(`/staff/cash-closing/${closingId}`);

  let totalAmount = 0;
  const denomValues: number[] = [];
  for (const d of DENOMS) {
    const count = parseInt(String(body[`count_${d}`] || "0"), 10);
    denomValues.push(count);
    totalAmount += count * d;
  }

  const paypayAmount = parseInt(String(body.paypay_amount || "0"), 10);
  const actualQrAmount = parseInt(String(body.actual_qr_amount || "0"), 10);
  const rentalCash = parseInt(String(body.rental_cash || "0"), 10) || 0;
  const wandRefund = parseInt(String(body.wand_refund || "0"), 10) || 0;
  const actualAmount = totalAmount + actualQrAmount;

  const cl = existing as Record<string, unknown>;
  const expectedAmount = cl.expected_amount as number;
  const differenceAmount = actualAmount - expectedAmount;
  // Recalculate QR difference from auto sales
  const businessDate = cl.business_date as string;
  const autoSales = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN payment_method = 'PAY_QR' THEN prepaid_amount + extra_amount ELSE 0 END) as auto_qr
     FROM luggage_orders
     WHERE date(created_at, '+9 hours') = ? AND status IN ('PAID', 'PICKED_UP')`
  ).bind(businessDate).first<{ auto_qr: number }>();
  const qrDiff = actualQrAmount - (autoSales?.auto_qr ?? 0);

  await c.env.DB.prepare(
    `UPDATE luggage_cash_closings SET
       count_10000 = ?, count_5000 = ?, count_2000 = ?, count_1000 = ?, count_500 = ?,
       count_100 = ?, count_50 = ?, count_10 = ?, count_5 = ?, count_1 = ?,
       total_amount = ?, paypay_amount = ?, actual_qr_amount = ?,
       actual_amount = ?, difference_amount = ?, qr_difference_amount = ?,
       rental_cash = ?, wand_refund = ?,
       note = ?, updated_at = datetime('now')
     WHERE closing_id = ?`
  )
    .bind(
      ...denomValues, totalAmount, paypayAmount, actualQrAmount,
      actualAmount, differenceAmount, qrDiff,
      rentalCash, wandRefund,
      String(body.note || "") || null, closingId
    )
    .run();

  await c.env.DB.prepare(
    "INSERT INTO luggage_cash_closing_audits (closing_id, action, staff_id) VALUES (?, 'EDIT', ?)"
  ).bind(closingId, staff.id).run();

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
     WHERE date(created_at, '+9 hours') = ? AND status IN ('PAID', 'PICKED_UP')`
  )
    .bind(businessDate)
    .first();

  return c.json(result || { cash_amount: 0, qr_amount: 0, total_amount: 0, order_count: 0 });
});

// ============================================================
// HANDOVER NOTES (US-010)
// ============================================================

const NOTE_CATEGORY_LABELS: Record<string, string> = {
  HANDOVER: "인수인계", NOTICE: "안내사항", URGENT: "긴급", EXPERIENCE: "체험단", OTHER: "기타",
};

// GET /staff/handover — Handover notes list
ops.get("/staff/handover", async (c) => {
  const staff = getStaff(c);

  // Fetch notes with author names, read status, comments, and experience visits in parallel
  const [notes, reads, comments] = await Promise.all([
    c.env.DB.prepare(
      `SELECT n.*, COALESCE(u.display_name, u.username) as author_name
       FROM luggage_handover_notes n
       LEFT JOIN user_profiles u ON n.staff_id = u.id
       ORDER BY n.is_pinned DESC, n.created_at DESC LIMIT 50`
    ).all(),
    c.env.DB.prepare(
      `SELECT r.note_id, r.staff_id, COALESCE(u.display_name, u.username) as reader_name
       FROM luggage_handover_reads r
       LEFT JOIN user_profiles u ON r.staff_id = u.id`
    ).all<{ note_id: number; staff_id: string; reader_name: string }>(),
    c.env.DB.prepare(
      `SELECT c.*, COALESCE(u.display_name, u.username) as author_name
       FROM luggage_handover_comments c
       LEFT JOIN user_profiles u ON c.staff_id = u.id
       ORDER BY c.created_at ASC`
    ).all(),
  ]);
  const expVisits = await c.env.DB.prepare(
    `SELECT v.*, COALESCE(u.display_name, u.username) as creator_name, COALESCE(p.display_name, p.username) as processor_name
     FROM luggage_experience_visits v
     LEFT JOIN user_profiles u ON v.created_by_staff_id = u.id
     LEFT JOIN user_profiles p ON v.processed_by_staff_id = p.id
     ORDER BY v.scheduled_date DESC, v.created_at DESC LIMIT 50`
  ).all();
  const readNoteIds = new Set(reads.results.filter((r) => r.staff_id === staff.id).map((r) => r.note_id));
  const readersByNote = new Map<number, string[]>();
  for (const r of reads.results) {
    if (!readersByNote.has(r.note_id)) readersByNote.set(r.note_id, []);
    if (r.reader_name) readersByNote.get(r.note_id)!.push(r.reader_name);
  }
  const commentsByNote = new Map<number, Record<string, unknown>[]>();
  for (const cm of comments.results as Record<string, unknown>[]) {
    const nid = cm.note_id as number;
    if (!commentsByNote.has(nid)) commentsByNote.set(nid, []);
    commentsByNote.get(nid)!.push(cm);
  }

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>인수인계</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/handover" />
        <main class="container">

          <section class="card">
            <h3 class="card-title">노트 작성</h3>
            <form method="post" action="/staff/handover">
              <div class="grid2">
                <label class="field">
                  <span class="field-label">분류</span>
                  <select class="control" name="category">
                    <option value="HANDOVER">인수인계</option>
                    <option value="NOTICE">안내사항</option>
                    <option value="URGENT">긴급</option>
                    <option value="EXPERIENCE">체험단</option>
                    <option value="OTHER">기타</option>
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">제목</span>
                  <input class="control" type="text" name="title" placeholder="제목" required />
                </label>
              </div>
              <label class="field">
                <span class="field-label">내용</span>
                <textarea class="control" name="content" placeholder="내용" required rows={4}></textarea>
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
              const noteComments = commentsByNote.get(noteId) || [];
              const catLabel = NOTE_CATEGORY_LABELS[note.category as string] || (note.category as string);
              return (
                <div class={`ops-item ${isRead ? "" : "ops-item-unread"}`} style={isRead ? "" : "border-left:3px solid var(--primary)"}>
                  <div class="ops-item-head">
                    <strong>{(note.is_pinned as number) ? "[고정] " : ""}{note.title as string}</strong>
                    <span class="ops-item-meta">
                      <span class="status-pill" style="font-size:10px">{catLabel}</span>
                      {isRead ? <span class="status-pill">읽음</span> : <span class="status-pill">새글</span>}
                    </span>
                  </div>
                  <p class="ops-item-content" style="white-space:pre-line">{note.content as string}</p>
                  <small class="ops-item-date">
                    {(note.author_name as string) || "알수없음"} · {note.created_at ? new Date(note.created_at as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : ""}
                  </small>
                  {(() => {
                    const readers = readersByNote.get(noteId) || [];
                    return readers.length > 0 ? (
                      <small style="display:block;margin-top:4px;color:#94a3b8;font-size:11px">읽음: {readers.join(", ")}</small>
                    ) : null;
                  })()}
                  {!isRead && (
                    <form method="post" action={`/staff/handover/${noteId}/read`} style="display:inline-block;margin-top:4px">
                      <button class="btn btn-sm" type="submit">읽음 표시</button>
                    </form>
                  )}

                  {/* Comments */}
                  {noteComments.length > 0 && (
                    <div style="margin-top:8px;padding-left:12px;border-left:2px solid #e5e5e5">
                      {noteComments.map((cm) => (
                        <div style="margin-bottom:6px;font-size:12px">
                          <strong style="color:#37352f">{(cm.author_name as string) || "알수없음"}</strong>
                          <span style="color:#999;margin-left:6px">{cm.created_at ? new Date(cm.created_at as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : ""}</span>
                          <p style="margin:2px 0 0;color:#555">{cm.content as string}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Comment form */}
                  <form method="post" action={`/staff/handover/${noteId}/comments`} style="display:flex;gap:6px;margin-top:8px">
                    <input class="control" type="text" name="content" placeholder="댓글 입력..." required style="flex:1;font-size:12px;padding:4px 8px" />
                    <button class="btn btn-sm btn-secondary" type="submit">댓글</button>
                  </form>

                  {/* Edit/Delete (only for author) */}
                  {(note.staff_id as string) === staff.id && (
                    <div style="margin-top:8px;display:flex;gap:6px">
                      <form method="post" action={`/staff/handover/${noteId}/delete`} style="display:inline" onsubmit="return confirm('이 노트를 삭제하시겠습니까?')">
                        <button class="btn btn-sm btn-secondary" style="font-size:11px" type="submit">삭제</button>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Experience Visits Section */}
          <section class="card" style="margin-top:24px">
            <h3 class="card-title">체험단 관리</h3>
            <form method="post" action="/staff/handover/experience" style="margin-bottom:16px">
              <div class="grid2">
                <label class="field">
                  <span class="field-label">방문자 이름</span>
                  <input class="control" type="text" name="visitor_name" required />
                </label>
                <label class="field">
                  <span class="field-label">유형</span>
                  <select class="control" name="visitor_type">
                    <option value="BLOGGER">블로거</option>
                    <option value="INFLUENCER">인플루언서</option>
                    <option value="YOUTUBER">유튜버</option>
                    <option value="OTHER">기타</option>
                  </select>
                </label>
              </div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">방문 예정일</span>
                  <input class="control" type="date" name="scheduled_date" required />
                </label>
                <label class="field">
                  <span class="field-label">혜택 유형</span>
                  <select class="control" name="benefit_type">
                    <option value="">선택</option>
                    <option value="GIFT_CARD">상품권</option>
                    <option value="CASH">지원금</option>
                    <option value="PRODUCT">물품</option>
                    <option value="OTHER">기타</option>
                  </select>
                </label>
              </div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">혜택 금액/내용</span>
                  <input class="control" type="text" name="benefit_amount" placeholder="예: ¥3,000" />
                </label>
                <label class="field">
                  <span class="field-label">메모</span>
                  <input class="control" type="text" name="note" placeholder="메모" />
                </label>
              </div>
              <button class="btn btn-primary" type="submit">등록</button>
            </form>

            <div class="table-wrap" style="overflow-x:auto">
              <table style="font-size:12px;border-collapse:collapse;width:100%;min-width:800px">
                <thead>
                  <tr style="background:#f1f5f9;border-bottom:2px solid #cbd5e1">
                    <th style="padding:4px 6px;text-align:left;font-size:11px">방문자</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">유형</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">예정일</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">혜택</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">금액</th>
                    <th style="padding:4px 6px;text-align:center;font-size:11px">상태</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">처리자</th>
                    <th style="padding:4px 6px;text-align:left;font-size:11px">메모</th>
                    <th style="padding:4px 6px;text-align:center;font-size:11px">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {expVisits.results.map((v: Record<string, unknown>) => {
                    const st = v.status as string;
                    const stColor = st === "SCHEDULED" ? "#64748b" : st === "VISITED" ? "#2563eb" : st === "RECEIVED" ? "#166534" : "#dc2626";
                    const stLabel = st === "SCHEDULED" ? "예정" : st === "VISITED" ? "방문" : st === "RECEIVED" ? "수령완료" : "취소";
                    const vtLabel = (v.visitor_type as string) === "BLOGGER" ? "블로거" : (v.visitor_type as string) === "INFLUENCER" ? "인플루언서" : (v.visitor_type as string) === "YOUTUBER" ? "유튜버" : "기타";
                    const btLabel = (v.benefit_type as string) === "GIFT_CARD" ? "상품권" : (v.benefit_type as string) === "CASH" ? "지원금" : (v.benefit_type as string) === "PRODUCT" ? "물품" : (v.benefit_type as string) === "OTHER" ? "기타" : "-";
                    return (
                      <tr style="border-bottom:1px solid #e2e8f0">
                        <td style="padding:3px 6px;font-weight:600">{v.visitor_name as string}</td>
                        <td style="padding:3px 6px">{vtLabel}</td>
                        <td style="padding:3px 6px;white-space:nowrap">{v.scheduled_date as string}</td>
                        <td style="padding:3px 6px">{btLabel}</td>
                        <td style="padding:3px 6px">{(v.benefit_amount as string) || "-"}</td>
                        <td style="padding:3px 6px;text-align:center"><span style={`display:inline-block;padding:1px 8px;border-radius:9999px;font-size:10px;font-weight:600;color:white;background:${stColor}`}>{stLabel}</span></td>
                        <td style="padding:3px 6px;font-size:11px">{(v.processor_name as string) || (v.creator_name as string) || "-"}</td>
                        <td style="padding:3px 6px;font-size:11px;color:#64748b;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{(v.note as string) || "-"}</td>
                        <td style="padding:3px 6px;text-align:center;white-space:nowrap">
                          {st === "SCHEDULED" && (
                            <form method="post" action={`/staff/handover/experience/${v.visit_id}/visit`} style="display:inline">
                              <button class="btn btn-sm" type="submit" style="font-size:10px">방문확인</button>
                            </form>
                          )}
                          {(st === "SCHEDULED" || st === "VISITED") && (
                            <form method="post" action={`/staff/handover/experience/${v.visit_id}/receive`} style="display:inline;margin-left:2px">
                              <button class="btn btn-sm btn-primary" type="submit" style="font-size:10px">수령처리</button>
                            </form>
                          )}
                          {st !== "CANCELLED" && st !== "RECEIVED" && (
                            <form method="post" action={`/staff/handover/experience/${v.visit_id}/cancel`} style="display:inline;margin-left:2px">
                              <button class="btn btn-sm btn-secondary" type="submit" style="font-size:10px">취소</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </main>
        <NewOrderAlert />
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
  const content = String(body.content || "").trim();

  if (!content) return c.redirect("/staff/handover");

  await c.env.DB.prepare(
    "INSERT INTO luggage_handover_comments (note_id, staff_id, content) VALUES (?, ?, ?)"
  )
    .bind(noteId, staff.id, content)
    .run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/:id/update — Update note
ops.post("/staff/handover/:id/update", async (c) => {
  const noteId = c.req.param("id");
  const staff = getStaff(c);
  const body = await c.req.parseBody();

  // Only the author can update their own note
  const note = await c.env.DB.prepare("SELECT staff_id FROM luggage_handover_notes WHERE note_id = ?").bind(noteId).first<{ staff_id: string }>();
  if (!note || note.staff_id !== staff.id) return c.redirect("/staff/handover");

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

// POST /staff/handover/:id/delete — Delete note (author only)
ops.post("/staff/handover/:id/delete", async (c) => {
  const noteId = c.req.param("id");
  const staff = getStaff(c);

  // Only the author can delete their own note
  const note = await c.env.DB.prepare("SELECT staff_id FROM luggage_handover_notes WHERE note_id = ?").bind(noteId).first<{ staff_id: string }>();
  if (!note || note.staff_id !== staff.id) return c.redirect("/staff/handover");

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM luggage_handover_notes WHERE note_id = ?").bind(noteId),
    c.env.DB.prepare("DELETE FROM luggage_handover_reads WHERE note_id = ?").bind(noteId),
    c.env.DB.prepare("DELETE FROM luggage_handover_comments WHERE note_id = ?").bind(noteId),
  ]);
  return c.redirect("/staff/handover");
});

// POST /staff/handover/comments/:id/delete — Delete comment (author only)
ops.post("/staff/handover/comments/:id/delete", async (c) => {
  const commentId = c.req.param("id");
  const staff = getStaff(c);

  const comment = await c.env.DB.prepare("SELECT staff_id FROM luggage_handover_comments WHERE comment_id = ?").bind(commentId).first<{ staff_id: string }>();
  if (!comment || comment.staff_id !== staff.id) return c.redirect("/staff/handover");

  await c.env.DB.prepare("DELETE FROM luggage_handover_comments WHERE comment_id = ?").bind(commentId).run();
  return c.redirect("/staff/handover");
});

// ============================================================
// EXPERIENCE VISITS (체험단)
// ============================================================

// POST /staff/handover/experience — Create visit
ops.post("/staff/handover/experience", async (c) => {
  const body = await c.req.parseBody();
  const staff = getStaff(c);

  await c.env.DB.prepare(
    `INSERT INTO luggage_experience_visits (visitor_name, visitor_type, scheduled_date, benefit_type, benefit_amount, note, created_by_staff_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(body.visitor_name || ""),
    String(body.visitor_type || "BLOGGER"),
    String(body.scheduled_date || ""),
    String(body.benefit_type || "") || null,
    String(body.benefit_amount || "") || null,
    String(body.note || "") || null,
    staff.id
  ).run();

  return c.redirect("/staff/handover");
});

// POST /staff/handover/experience/:id/visit — Mark as visited
ops.post("/staff/handover/experience/:id/visit", async (c) => {
  const visitId = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE luggage_experience_visits SET status = 'VISITED', updated_at = datetime('now') WHERE visit_id = ? AND status = 'SCHEDULED'"
  ).bind(visitId).run();
  return c.redirect("/staff/handover");
});

// POST /staff/handover/experience/:id/receive — Mark as received
ops.post("/staff/handover/experience/:id/receive", async (c) => {
  const visitId = c.req.param("id");
  const staff = getStaff(c);
  await c.env.DB.prepare(
    `UPDATE luggage_experience_visits SET status = 'RECEIVED', processed_by_staff_id = ?, received_by = ?, received_at = datetime('now'), updated_at = datetime('now')
     WHERE visit_id = ? AND status IN ('SCHEDULED', 'VISITED')`
  ).bind(staff.id, getStaff(c).display_name || getStaff(c).username, visitId).run();
  return c.redirect("/staff/handover");
});

// POST /staff/handover/experience/:id/cancel — Cancel visit
ops.post("/staff/handover/experience/:id/cancel", async (c) => {
  const visitId = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE luggage_experience_visits SET status = 'CANCELLED', updated_at = datetime('now') WHERE visit_id = ? AND status IN ('SCHEDULED', 'VISITED')"
  ).bind(visitId).run();
  return c.redirect("/staff/handover");
});

// ============================================================
// LOST & FOUND (US-011)
// ============================================================

const LOST_FOUND_STATUS_LABELS: Record<string, string> = {
  UNCLAIMED: "미확인", CLAIMED: "인수완료", DISPOSED: "폐기", RETURNED: "반환",
};

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
    sql += " AND (item_name LIKE ? OR found_location LIKE ? OR claimed_by LIKE ? OR note LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  sql += " ORDER BY created_at DESC LIMIT 100";

  const entries = await c.env.DB.prepare(sql).bind(...params).all();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>분실물</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/lost-found" />
        <main class="container">

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
                  <tr><th>물품</th><th>수량</th><th>장소</th><th>상태</th><th>메모</th><th>등록일</th><th>액션</th></tr>
                </thead>
                <tbody>
                  {entries.results.map((e: Record<string, unknown>) => {
                    return (
                    <tr>
                      <td>{e.item_name as string}</td>
                      <td>{e.quantity as number}</td>
                      <td>{(e.found_location as string) || "-"}</td>
                      <td><span class="status-pill" style="font-size:10px">{LOST_FOUND_STATUS_LABELS[e.status as string] || (e.status as string)}</span></td>
                      <td style="font-size:12px;color:#666">{(e.note as string) || "-"}</td>
                      <td style="white-space:nowrap">{e.created_at ? new Date(e.created_at as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : "-"}</td>
                      <td>
                        {e.status === "UNCLAIMED" && (
                          <form method="post" action={`/staff/lost-found/${e.entry_id}/update`} style="display:inline">
                            <input type="hidden" name="status" value="CLAIMED" />
                            <input class="table-control" type="text" name="claimed_by" placeholder="인수자" />
                            <button class="btn btn-sm" type="submit">인계</button>
                          </form>
                        )}
                        {(e.status === "UNCLAIMED" || e.status === "CLAIMED") && (
                          <form method="post" action={`/staff/lost-found/${e.entry_id}/update`} style="display:inline;margin-left:4px">
                            <select name="status" class="table-control">
                              <option value="">상태변경</option>
                              <option value="DISPOSED">폐기</option>
                              <option value="RETURNED">반환</option>
                            </select>
                            <button class="btn btn-sm" type="submit">변경</button>
                          </form>
                        )}
                        <form method="post" action={`/staff/lost-found/${e.entry_id}/delete`} style="display:inline;margin-left:4px" onsubmit="return confirm('삭제하시겠습니까?')">
                          <button class="btn btn-sm btn-secondary" type="submit">삭제</button>
                        </form>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </main>
        <NewOrderAlert />
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

  const VALID_STATUSES = ["UNCLAIMED", "CLAIMED", "DISPOSED", "RETURNED"];
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.status) {
    const status = String(body.status);
    if (!VALID_STATUSES.includes(status)) return c.redirect("/staff/lost-found");
    if (status === "CLAIMED" && !body.claimed_by) return c.redirect("/staff/lost-found");
    updates.push("status = ?");
    values.push(status);
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

// ============================================================
// SCHEDULE (moved from admin — accessible to all staff)
// ============================================================

// GET /staff/schedule — Work schedule (all staff can view)
ops.get("/staff/schedule", async (c) => {
  const calendarUrl = await c.env.DB.prepare(
    "SELECT setting_value FROM luggage_app_settings WHERE setting_key = 'calendar_embed_url'"
  ).first<{ setting_value: string }>();

  const staff = getStaff(c);
  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>근무 스케줄</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/schedule" />
        <main class="container">
        <section class="hero"><div><p class="hero-kicker">Operations</p><h2 class="hero-title">근무 스케줄</h2></div></section>
        <section class="card" style="padding:16px">
        {calendarUrl?.setting_value ? (
          <>
            <iframe src={calendarUrl.setting_value} style="width:100%;height:600px;border:none" />
            <p style="margin-top:8px"><a href={calendarUrl.setting_value} target="_blank" style="color:var(--primary)">새 창에서 열기 ↗</a></p>
          </>
        ) : (
          <p class="muted">캘린더 URL이 설정되지 않았습니다. 관리자에게 문의하세요.</p>
        )}
        </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

export default ops;
