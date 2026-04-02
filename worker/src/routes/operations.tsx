/**
 * Staff operations routes — Cash Closing, Handover Notes, Lost & Found.
 * Covers US-009 (Cash Closing), US-010 (Handover), US-011 (Lost & Found).
 */
import { Hono } from "hono";
import type { AppType } from "../types";
import { staffAuth, getStaff } from "../middleware/auth";
import { formatDateJST } from "../services/storage";
import { StaffTopbar, NewOrderAlert } from "../lib/components";
import { fetchStaffNamesByIds } from "../lib/staffProfiles";

const ops = new Hono<AppType>();
ops.use("/*", staffAuth);

// ============================================================
// CASH CLOSING (US-009)
// ============================================================

const DENOMS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;
const STARTING_FLOAT = 40000; // 시제 ¥40,000
const CLOSING_TYPE_LABELS: Record<string, string> = { MORNING_HANDOVER: "오전", FINAL_CLOSE: "최종" };
const WORKFLOW_LABELS: Record<string, string> = { SUBMITTED: "제출완료" };
const AUDIT_ACTION_LABELS: Record<string, string> = { CREATE: "정산마감 생성", SUBMIT: "정산마감 제출", VERIFY_LOCK: "확인/잠금 (레거시)", EDIT: "정산마감 수정" };
const DOW_JP = ["日", "月", "火", "水", "木", "金", "土"];
const JP_HOLIDAYS: Record<string, string> = {
  "01-01": "元日", "01-12": "成人の日", "02-11": "建国記念の日", "02-23": "天皇誕生日",
  "03-20": "春分の日", "04-29": "昭和の日", "05-03": "憲法記念日", "05-04": "みどりの日",
  "05-05": "こどもの日", "05-06": "振替休日", "07-20": "海の日", "08-11": "山の日",
  "09-21": "敬老の日", "09-23": "秋分の日", "10-12": "スポーツの日", "11-03": "文化の日",
  "11-23": "勤労感謝の日",
};
const KR_HOLIDAYS: Record<string, string> = {
  "01-01": "신정", "03-01": "삼일절", "05-05": "어린이날", "06-06": "현충일",
  "08-15": "광복절", "10-03": "개천절", "10-09": "한글날", "12-25": "성탄절",
  "2025-10-03": "개천절", "2025-10-05": "추석", "2025-10-06": "추석", "2025-10-07": "추석", "2025-10-08": "대체휴일", "2025-10-09": "한글날",
  "2026-02-16": "설날", "2026-02-17": "설날", "2026-02-18": "설날",
  "2026-05-24": "석가탄신일",
  "2026-09-24": "추석", "2026-09-25": "추석", "2026-09-26": "추석",
};

function getHolidayFlags(dateStr: string): { isWeekend: boolean; jp: string | null; kr: string | null } {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const isWeekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
  const mmdd = dateStr.slice(5);
  return {
    isWeekend,
    jp: JP_HOLIDAYS[mmdd] || null,
    kr: KR_HOLIDAYS[dateStr] || KR_HOLIDAYS[mmdd] || null,
  };
}

function formatClosingDate(dateStr: string): { label: string; style: string; suffix: string; title: string } {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = DOW_JP[d.getUTCDay()];
  const flags = getHolidayFlags(dateStr);
  const suffix = `${flags.isWeekend && !flags.jp && !flags.kr ? " 🔵" : ""}${flags.jp ? " 🇯🇵" : ""}${flags.kr ? " 🇰🇷" : ""}`;
  const style = flags.jp || flags.kr
    ? "color:#dc2626;font-weight:600"
    : flags.isWeekend
      ? "color:#2383e2;font-weight:600"
      : "";
  const title = [flags.jp, flags.kr].filter(Boolean).join(" / ");
  return {
    label: `${dateStr.replace(/-/g, "/")}/${dow}`,
    style,
    suffix,
    title,
  };
}

function formatDenominationLabel(amount: number): string {
  return `¥${amount.toLocaleString()}`;
}

function uniqueStaffIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => `${value ?? ""}`.trim()).filter(Boolean))];
}

type AutoSalesSummary = {
  cashAmount: number;
  qrAmount: number;
  totalAmount: number;
  orderCount: number;
  source: "daily_sales" | "live_orders";
};

function buildDateRange(businessDates: string[]): { uniqueDates: string[]; rangeStart: string; rangeEnd: string } | null {
  const uniqueDates = [...new Set(businessDates.filter(Boolean))];
  if (uniqueDates.length === 0) return null;

  const sortedDates = uniqueDates.sort();
  return {
    uniqueDates,
    rangeStart: sortedDates[0],
    rangeEnd: sortedDates[sortedDates.length - 1],
  };
}

async function fetchDailySalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
  const dateRange = buildDateRange(businessDates);
  if (!dateRange) return new Map();

  const rows = await db.prepare(
    `SELECT sale_date, cash, qr, luggage_total
     FROM luggage_daily_sales
     WHERE sale_date >= ?
       AND sale_date <= ?`
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{ sale_date: string; cash: number; qr: number; luggage_total: number }>();

  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.sale_date, {
      cashAmount: row.cash ?? 0,
      qrAmount: row.qr ?? 0,
      totalAmount: row.luggage_total ?? 0,
      orderCount: 0,
      source: "daily_sales",
    });
  }
  return result;
}

async function fetchLiveOrderSalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
  const dateRange = buildDateRange(businessDates);
  if (!dateRange) return new Map();

  const rows = await db.prepare(
    `SELECT
       date(created_at, '+9 hours') as business_date,
       SUM(CASE WHEN payment_method = 'PAY_QR' THEN COALESCE(NULLIF(final_amount, 0), prepaid_amount) + extra_amount ELSE 0 END) as qr_amount,
       SUM(CASE WHEN payment_method = 'CASH' OR payment_method IS NULL THEN COALESCE(NULLIF(final_amount, 0), prepaid_amount) + extra_amount ELSE 0 END) as cash_amount,
       SUM(COALESCE(NULLIF(final_amount, 0), prepaid_amount) + extra_amount) as total_amount,
       COUNT(*) as order_count
     FROM luggage_orders
     WHERE date(created_at, '+9 hours') >= ?
       AND date(created_at, '+9 hours') <= ?
       AND status != 'CANCELLED'
       AND manual_entry = 0
     GROUP BY date(created_at, '+9 hours')`
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{
    business_date: string;
    cash_amount: number;
    qr_amount: number;
    total_amount: number;
    order_count: number;
  }>();

  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.business_date, {
      cashAmount: row.cash_amount ?? 0,
      qrAmount: row.qr_amount ?? 0,
      totalAmount: row.total_amount ?? 0,
      orderCount: row.order_count ?? 0,
      source: "live_orders",
    });
  }
  return result;
}

async function resolveAutoSalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
  const uniqueDates = [...new Set(businessDates.filter(Boolean))];
  if (uniqueDates.length === 0) return new Map();

  const [dailySalesByDate, liveOrdersByDate] = await Promise.all([
    fetchDailySalesSummariesByDate(db, uniqueDates),
    fetchLiveOrderSalesSummariesByDate(db, uniqueDates),
  ]);

  const today = formatDateJST(new Date());
  const result = new Map<string, AutoSalesSummary>();
  for (const businessDate of uniqueDates) {
    const daily = dailySalesByDate.get(businessDate);
    const live = liveOrdersByDate.get(businessDate);
    if (businessDate === today && live && live.totalAmount > 0) {
      result.set(businessDate, live);
      continue;
    }
    if (daily && daily.totalAmount > 0) {
      result.set(businessDate, daily);
      continue;
    }
    if (live && live.totalAmount > 0) {
      result.set(businessDate, live);
      continue;
    }
    if (daily) {
      result.set(businessDate, daily);
    }
  }
  return result;
}

async function resolveAutoSalesSummaryForDate(db: D1Database, businessDate: string): Promise<AutoSalesSummary | null> {
  return (await resolveAutoSalesSummariesByDate(db, [businessDate])).get(businessDate) ?? null;
}

// GET /staff/cash-closing — Cash closing list & form
ops.get("/staff/cash-closing", async (c) => {
  // Show the latest closing per date with closing count to detect multi-closing dates
  const closings = await c.env.DB.prepare(
    `SELECT c.*, latest.closing_count FROM luggage_cash_closings c
     INNER JOIN (
       SELECT business_date, MAX(closing_id) as max_id, COUNT(*) as closing_count
       FROM luggage_cash_closings
       GROUP BY business_date
     ) latest ON c.closing_id = latest.max_id
     ORDER BY c.business_date DESC LIMIT 400`
  ).all<Record<string, unknown>>();
  const staffNameMap = await fetchStaffNamesByIds(
    c.env,
    closings.results.map((closing) => closing.staff_id as string | null | undefined),
  );
  const closingRows: Array<Record<string, unknown> & { staff_name: string | null; has_multi: boolean }> = closings.results.map((closing) => ({
    ...closing,
    staff_name: (closing.staff_id as string | null)
      ? staffNameMap.get(closing.staff_id as string) || (closing.owner_name as string) || null
      : (closing.owner_name as string) || null,
    has_multi: ((closing.closing_count as number) || 0) > 1,
  }));
  const autoSalesByDate = await resolveAutoSalesSummariesByDate(
    c.env.DB,
    closingRows.map((cl) => String(cl.business_date || ""))
  );

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
                      <span>{formatDenominationLabel(d)}</span>
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

              <div class="grid2">
                <label class="field">
                  <span class="field-label">4층 위탁 건수</span>
                  <input class="control" type="number" name="floor_4f_count" defaultValue="0" min="0" />
                </label>
                <label class="field">
                  <span class="field-label">8층 위탁 건수</span>
                  <input class="control" type="number" name="floor_8f_count" defaultValue="0" min="0" />
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
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">10,000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">5,000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">2,000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">1,000</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">500</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">100</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">50</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">10</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">5</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">1</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569;font-weight:700">Total</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">PayPay</th>
                    <th title="짐보관 신청서 기준 합계" style="padding:3px 6px;text-align:right;font-size:10px;color:#2563eb">자동매출</th>
                    <th style="padding:3px 6px;text-align:right;font-size:10px;color:#475569">차액</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">4F</th>
                    <th style="padding:3px 4px;text-align:right;font-size:10px;color:#475569">8F</th>
                    <th style="padding:3px 4px;text-align:left;font-size:10px;color:#475569">작성자</th>
                    <th style="padding:3px 4px;text-align:left;font-size:10px;color:#475569">메모</th>
                    <th style="padding:3px 4px;font-size:10px"></th>
                  </tr>
                </thead>
                <tbody>
                  {closingRows.map((cl: Record<string, unknown>) => {
                    const noteStr = (cl.note as string) || "";
                    const businessDate = cl.business_date as string;
                    const dateDisplay = formatClosingDate(businessDate);
                    const autoAmount = autoSalesByDate.get(businessDate)?.totalAmount ?? ((cl.check_auto_amount as number) || 0);
                    const diff = (((cl.total_amount as number) || 0) - STARTING_FLOAT + ((cl.paypay_amount as number) || 0)) - autoAmount;
                    return (
                      <tr style="border-bottom:1px solid #e2e8f0">
                        <td style={`padding:2px 6px;white-space:nowrap;${dateDisplay.style}`} title={dateDisplay.title}><a href={`/staff/cash-closing/${cl.closing_id}`} style="color:inherit;font-weight:600">{dateDisplay.label}{dateDisplay.suffix}</a>{(cl as Record<string, unknown> & { has_multi: boolean }).has_multi && <span style="margin-left:4px;font-size:9px;background:#fef3c7;color:#92400e;padding:1px 4px;border-radius:3px;vertical-align:middle">+1</span>}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_10000 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_5000 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_2000 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_1000 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_500 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_100 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_50 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_10 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_5 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.count_1 as number) || 0).toLocaleString()}</td>
                        <td style="padding:2px 6px;text-align:right;font-weight:700">¥{(cl.total_amount as number).toLocaleString()}</td>
                        <td style="padding:2px 6px;text-align:right">¥{(cl.paypay_amount as number).toLocaleString()}</td>
                        <td style="padding:2px 6px;text-align:right;color:#2563eb">¥{autoAmount.toLocaleString()}</td>
                        <td style={`padding:2px 6px;text-align:right;font-weight:600;color:${diff === 0 ? '#166534' : '#dc2626'}`}>{diff > 0 ? "+" : ""}{diff.toLocaleString()}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.floor_4f_count as number) || 0) > 0 ? (cl.floor_4f_count as number) : "-"}</td>
                        <td style="padding:2px 4px;text-align:right">{((cl.floor_8f_count as number) || 0) > 0 ? (cl.floor_8f_count as number) : "-"}</td>
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
                {closingRows.length > 0 && (() => {
                  const rows = closingRows.map((cl) => {
                    const auto = autoSalesByDate.get(cl.business_date as string)?.totalAmount ?? ((cl.check_auto_amount as number) || 0);
                    return {
                      total: (cl.total_amount as number) || 0,
                      paypay: (cl.paypay_amount as number) || 0,
                      auto,
                      diff: ((cl.total_amount as number) || 0) + ((cl.paypay_amount as number) || 0) - auto,
                      f4: (cl.floor_4f_count as number) || 0,
                      f8: (cl.floor_8f_count as number) || 0,
                    };
                  });
                  const n = rows.length;
                  const sum = (fn: (r: typeof rows[0]) => number) => rows.reduce((s, r) => s + fn(r), 0);
                  const avg = (fn: (r: typeof rows[0]) => number) => Math.round(sum(fn) / n);
                  const mn = (fn: (r: typeof rows[0]) => number) => Math.min(...rows.map(fn));
                  const mx = (fn: (r: typeof rows[0]) => number) => Math.max(...rows.map(fn));
                  const st = "padding:3px 6px;text-align:right;font-size:10px;font-weight:600";
                  const lb = "padding:3px 6px;font-size:10px;font-weight:700";
                  return (
                    <tfoot style="border-top:2px solid #cbd5e1">
                      <tr style="background:#f8fafc">
                        <td style={lb}>Avg</td><td colSpan={10}></td>
                        <td style={st}>¥{avg(r => r.total).toLocaleString()}</td>
                        <td style={st}>¥{avg(r => r.paypay).toLocaleString()}</td>
                        <td style={`${st};color:#2563eb`}>¥{avg(r => r.auto).toLocaleString()}</td>
                        <td style={st}>{avg(r => r.diff).toLocaleString()}</td>
                        <td style={st}>{avg(r => r.f4) > 0 ? avg(r => r.f4) : "-"}</td>
                        <td style={st}>{avg(r => r.f8) > 0 ? avg(r => r.f8) : "-"}</td>
                        <td colSpan={3}></td>
                      </tr>
                      <tr>
                        <td style={lb}>Min</td><td colSpan={10}></td>
                        <td style={st}>¥{mn(r => r.total).toLocaleString()}</td>
                        <td style={st}>¥{mn(r => r.paypay).toLocaleString()}</td>
                        <td style={`${st};color:#2563eb`}>¥{mn(r => r.auto).toLocaleString()}</td>
                        <td style={st}>{mn(r => r.diff).toLocaleString()}</td>
                        <td style={st}>{mn(r => r.f4) > 0 ? mn(r => r.f4) : "-"}</td>
                        <td style={st}>{mn(r => r.f8) > 0 ? mn(r => r.f8) : "-"}</td>
                        <td colSpan={3}></td>
                      </tr>
                      <tr style="background:#f8fafc">
                        <td style={lb}>Max</td><td colSpan={10}></td>
                        <td style={st}>¥{mx(r => r.total).toLocaleString()}</td>
                        <td style={st}>¥{mx(r => r.paypay).toLocaleString()}</td>
                        <td style={`${st};color:#2563eb`}>¥{mx(r => r.auto).toLocaleString()}</td>
                        <td style={st}>{mx(r => r.diff).toLocaleString()}</td>
                        <td style={st}>{mx(r => r.f4) > 0 ? mx(r => r.f4) : "-"}</td>
                        <td style={st}>{mx(r => r.f8) > 0 ? mx(r => r.f8) : "-"}</td>
                        <td colSpan={3}></td>
                      </tr>
                    </tfoot>
                  );
                })()}
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
  const businessDate = formatDateJST(new Date());

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
  const floor4fCount = parseInt(String(body.floor_4f_count || "0"), 10) || 0;
  const floor8fCount = parseInt(String(body.floor_8f_count || "0"), 10) || 0;
  const closingType = String(body.closing_type || "FINAL_CLOSE");

  // Prevent duplicate closings for same date + type
  const existing = await c.env.DB.prepare(
    "SELECT closing_id FROM luggage_cash_closings WHERE business_date = ? AND closing_type = ?"
  ).bind(businessDate, closingType).first();
  if (existing) return c.redirect("/staff/cash-closing?error=이미 해당 날짜/유형의 정산이 존재합니다");
  // 차액 = (현금Total - 시제40000) + PayPay - 자동매출
  const autoSales = await resolveAutoSalesSummaryForDate(c.env.DB, businessDate);
  const checkAutoAmount = autoSales?.totalAmount ?? 0;
  const expectedAmount = checkAutoAmount;
  const actualAmount = (totalAmount - STARTING_FLOAT) + paypayAmount;
  const differenceAmount = actualAmount - expectedAmount;
  const qrDifferenceAmount = actualQrAmount - (autoSales?.qrAmount ?? 0);

  await c.env.DB.prepare(
    `INSERT INTO luggage_cash_closings (
       business_date, closing_type, workflow_status,
       count_10000, count_5000, count_2000, count_1000, count_500,
       count_100, count_50, count_10, count_5, count_1,
       total_amount, paypay_amount, actual_qr_amount,
       actual_amount, check_auto_amount, expected_amount,
       difference_amount, qr_difference_amount,
       rental_cash, wand_refund,
       floor_4f_count, floor_8f_count,
       staff_id, note
     ) VALUES (?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      businessDate, closingType,
      ...denomValues, totalAmount, paypayAmount, actualQrAmount,
      actualAmount, checkAutoAmount, expectedAmount,
      differenceAmount, qrDifferenceAmount,
      rentalCash, wandRefund,
      floor4fCount, floor8fCount,
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
  const closing = await c.env.DB.prepare(
    `SELECT * FROM luggage_cash_closings
     WHERE closing_id = ?`
  )
    .bind(closingId)
    .first<Record<string, unknown>>();

  if (!closing) return c.html(<p>Not found</p>, 404);
  const staff = getStaff(c);
  const autoSales = await resolveAutoSalesSummaryForDate(c.env.DB, String((closing as Record<string, unknown>).business_date || ""));

  // Fetch morning handover for the same date (if this is FINAL_CLOSE)
  const morningClosing = closing.closing_type === "FINAL_CLOSE"
    ? await c.env.DB.prepare(
        `SELECT * FROM luggage_cash_closings WHERE business_date = ? AND closing_type = 'MORNING_HANDOVER'`
      ).bind(closing.business_date as string).first<Record<string, unknown>>()
    : null;

  const audits = await c.env.DB.prepare(
    `SELECT *
     FROM luggage_cash_closing_audits
     WHERE closing_id = ? ORDER BY created_at DESC`
  )
    .bind(closingId)
    .all<Record<string, unknown>>();

  const cashClosingStaffNameMap = await fetchStaffNamesByIds(
    c.env,
    uniqueStaffIds([
      closing.staff_id as string | null | undefined,
      ...audits.results.map((audit) => audit.staff_id as string | null | undefined),
      morningClosing?.staff_id as string | null | undefined,
    ]),
  );
  const auditRows = audits.results.map((audit) => ({
    ...audit,
    staff_name: (audit.staff_id as string | null)
      ? cashClosingStaffNameMap.get(audit.staff_id as string) || (audit.staff_id as string)
      : null,
  }));

  const cl = closing as Record<string, unknown>;
  const autoAmount = autoSales?.totalAmount ?? ((cl.check_auto_amount as number) || 0);
  const differenceAmount = (((cl.total_amount as number) || 0) - STARTING_FLOAT + ((cl.paypay_amount as number) || 0)) - autoAmount;
  const closingStaffName = (cl.staff_id as string | null)
    ? cashClosingStaffNameMap.get(cl.staff_id as string) || (cl.owner_name as string) || "-"
    : (cl.owner_name as string) || "-";
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
                <p class="stat-label">자동매출 <span title="Daily 시트(짐보관 신청서 합계)를 우선 사용하고, 당일 시트 미반영 시 실시간 신청서 주문을 사용합니다." style="cursor:help;color:#94a3b8;font-size:10px">(?)</span></p>
                <p class="stat-value">¥{autoAmount.toLocaleString()}</p>
              </div>
              <div class="card stat-card">
                <p class="stat-label">차액</p>
                <p class="stat-value" style={`color:${differenceAmount === 0 ? '#166534' : '#dc2626'}`}>¥{differenceAmount.toLocaleString()}</p>
              </div>
            </div>

            <p style="margin-bottom:12px;font-size:11px;color:#64748b;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 10px">
              ※ 자동매출은 Daily 시트의 짐보관 신청서 합계를 우선 사용합니다. 당일 시트가 아직 비어 있으면 실시간 신청서 주문 합계로 표시됩니다.
            </p>

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
              <p><strong>4층 위탁</strong><span>{((cl.floor_4f_count as number) || 0)}건</span></p>
              <p><strong>8층 위탁</strong><span>{((cl.floor_8f_count as number) || 0)}건</span></p>
              <p><strong>QR 차액</strong><span style={`color:${(cl.qr_difference_amount as number) === 0 ? '#166534' : '#dc2626'}`}>¥{(cl.qr_difference_amount as number).toLocaleString()}</span></p>
              <p><strong>작성자</strong><span>{closingStaffName}</span></p>
              <p><strong>메모</strong><span>{(cl.note as string) || "-"}</span></p>
            </div>

            <div style="margin-top:12px;padding:10px;background:#f5f5f4;border-radius:6px;font-size:13px;color:#37352f">
              {(() => {
                const typeLabel = CLOSING_TYPE_LABELS[cl.closing_type as string] || cl.closing_type as string;
                return `${typeLabel} 정산현금 (¥${(cl.total_amount as number).toLocaleString()} / ${differenceAmount > 0 ? "+" : ""}${differenceAmount.toLocaleString()}엔)`;
              })()}
            </div>

            {cl.workflow_status === "SUBMITTED" && (
              <div style="margin-top:12px">
                <a href={`/staff/cash-closing/${closingId}/edit`} class="btn btn-primary">수정</a>
              </div>
            )}
          </section>

          {morningClosing && (() => {
            const mc = morningClosing as Record<string, unknown>;
            const morningStaffName = (mc.staff_id as string | null)
              ? cashClosingStaffNameMap.get(mc.staff_id as string) || (mc.owner_name as string) || "-"
              : (mc.owner_name as string) || "-";
            return (
              <section class="card" style="border-left:3px solid #fbbf24">
                <h3 class="card-title" style="color:#92400e">오전 인수인계 마감</h3>
                <div class="stat-grid" style="margin-bottom:12px">
                  <div class="card stat-card">
                    <p class="stat-label">현금 합계</p>
                    <p class="stat-value">¥{((mc.total_amount as number) || 0).toLocaleString()}</p>
                  </div>
                  <div class="card stat-card">
                    <p class="stat-label">PayPay</p>
                    <p class="stat-value">¥{((mc.paypay_amount as number) || 0).toLocaleString()}</p>
                  </div>
                  <div class="card stat-card">
                    <p class="stat-label">QR 실제</p>
                    <p class="stat-value">¥{((mc.actual_qr_amount as number) || 0).toLocaleString()}</p>
                  </div>
                </div>
                <div class="summary-grid" style="font-size:13px">
                  <p><strong>렌탈 현금</strong><span>¥{((mc.rental_cash as number) || 0).toLocaleString()}</span></p>
                  <p><strong>지팡이 환불</strong><span>¥{((mc.wand_refund as number) || 0).toLocaleString()}</span></p>
                  <p><strong>작성자</strong><span>{morningStaffName}</span></p>
                  <p><strong>메모</strong><span>{(mc.note as string) || "-"}</span></p>
                </div>
                <div style="margin-top:8px">
                  <a href={`/staff/cash-closing/${mc.closing_id}`} style="color:var(--primary);font-size:12px">오전 마감 상세 보기 →</a>
                </div>
              </section>
            );
          })()}

          <section class="card">
            <h3 class="card-title">감사 로그</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>시간</th><th>행동</th><th>직원</th></tr>
                </thead>
                <tbody>
                  {auditRows.map((a: Record<string, unknown>) => (
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
                      <span>{formatDenominationLabel(d)}</span>
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

              <div class="grid2">
                <label class="field">
                  <span class="field-label">4층 위탁 건수</span>
                  <input class="control" type="number" name="floor_4f_count" defaultValue={String(cl.floor_4f_count ?? 0)} min="0" />
                </label>
                <label class="field">
                  <span class="field-label">8층 위탁 건수</span>
                  <input class="control" type="number" name="floor_8f_count" defaultValue={String(cl.floor_8f_count ?? 0)} min="0" />
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
  const floor4fCount = parseInt(String(body.floor_4f_count || "0"), 10) || 0;
  const floor8fCount = parseInt(String(body.floor_8f_count || "0"), 10) || 0;
  // 차액 = (현금Total - 시제40000) + PayPay - 자동매출
  const cl = existing as Record<string, unknown>;
  const autoSales = await resolveAutoSalesSummaryForDate(c.env.DB, cl.business_date as string);
  const expectedAmount = autoSales?.totalAmount ?? ((cl.expected_amount as number) || 0);
  const actualAmount = (totalAmount - STARTING_FLOAT) + paypayAmount;
  const differenceAmount = actualAmount - expectedAmount;
  const qrDiff = actualQrAmount - (autoSales?.qrAmount ?? 0);

  await c.env.DB.prepare(
    `UPDATE luggage_cash_closings SET
       count_10000 = ?, count_5000 = ?, count_2000 = ?, count_1000 = ?, count_500 = ?,
       count_100 = ?, count_50 = ?, count_10 = ?, count_5 = ?, count_1 = ?,
       total_amount = ?, paypay_amount = ?, actual_qr_amount = ?,
       actual_amount = ?, check_auto_amount = ?, expected_amount = ?, difference_amount = ?, qr_difference_amount = ?,
       rental_cash = ?, wand_refund = ?,
       floor_4f_count = ?, floor_8f_count = ?,
       note = ?, updated_at = datetime('now')
     WHERE closing_id = ?`
  )
    .bind(
      ...denomValues, totalAmount, paypayAmount, actualQrAmount,
      actualAmount, expectedAmount, expectedAmount, differenceAmount, qrDiff,
      rentalCash, wandRefund,
      floor4fCount, floor8fCount,
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

  const result = await resolveAutoSalesSummaryForDate(c.env.DB, businessDate);
  return c.json(result ? {
    cash_amount: result.cashAmount,
    qr_amount: result.qrAmount,
    total_amount: result.totalAmount,
    order_count: result.orderCount,
    source: result.source,
  } : { cash_amount: 0, qr_amount: 0, total_amount: 0, order_count: 0, source: "daily_sales" });
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
  const handoverQ = c.req.query("handover_q") || "";

  // Build notes query with optional search filter
  let notesSql = `SELECT * FROM luggage_handover_notes`;
  const notesParams: string[] = [];
  if (handoverQ) {
    notesSql += ` WHERE (title LIKE ? OR content LIKE ?)`;
    const like = `%${handoverQ}%`;
    notesParams.push(like, like);
  }
  notesSql += ` ORDER BY is_pinned DESC, created_at DESC LIMIT 50`;

  // Fetch notes with author names, read status, comments, and edits in parallel
  const [notes, reads, comments] = await Promise.all([
    c.env.DB.prepare(notesSql).bind(...notesParams).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT note_id, staff_id
       FROM luggage_handover_reads`
    ).all<{ note_id: number; staff_id: string }>(),
    c.env.DB.prepare(
      `SELECT *
       FROM luggage_handover_comments
       ORDER BY created_at ASC`
    ).all<Record<string, unknown>>(),
  ]);
  const edits = await c.env.DB.prepare(
    `SELECT note_id, staff_id, created_at
     FROM luggage_handover_edits
     ORDER BY created_at DESC`
  ).all<{ note_id: number; staff_id: string; created_at: string }>();
  const handoverStaffNameMap = await fetchStaffNamesByIds(
    c.env,
    uniqueStaffIds([
      ...notes.results.map((note) => note.staff_id as string | null | undefined),
      ...reads.results.map((read) => read.staff_id),
      ...comments.results.map((comment) => comment.staff_id as string | null | undefined),
      ...edits.results.map((edit) => edit.staff_id),
    ]),
  );
  const noteRows = notes.results.map((note) => ({
    ...note,
    author_name: (note.staff_id as string | null)
      ? handoverStaffNameMap.get(note.staff_id as string) || null
      : null,
  }));
  const commentRows = comments.results.map((comment) => ({
    ...comment,
    author_name: (comment.staff_id as string | null)
      ? handoverStaffNameMap.get(comment.staff_id as string) || null
      : null,
  }));
  const editRows = edits.results.map((edit) => ({
    ...edit,
    editor_name: handoverStaffNameMap.get(edit.staff_id) || edit.staff_id,
  }));
  const readNoteIds = new Set(reads.results.filter((r) => r.staff_id === staff.id).map((r) => r.note_id));
  const readersByNote = new Map<number, string[]>();
  for (const r of reads.results) {
    if (!readersByNote.has(r.note_id)) readersByNote.set(r.note_id, []);
    const readerName = handoverStaffNameMap.get(r.staff_id) || r.staff_id;
    readersByNote.get(r.note_id)!.push(readerName);
  }
  const commentsByNote = new Map<number, Record<string, unknown>[]>();
  for (const cm of commentRows as Record<string, unknown>[]) {
    const nid = cm.note_id as number;
    if (!commentsByNote.has(nid)) commentsByNote.set(nid, []);
    commentsByNote.get(nid)!.push(cm);
  }
  const editsByNote = new Map<number, { editor_name: string; created_at: string }[]>();
  for (const ed of editRows) {
    if (!editsByNote.has(ed.note_id)) editsByNote.set(ed.note_id, []);
    editsByNote.get(ed.note_id)!.push({ editor_name: ed.editor_name, created_at: ed.created_at });
  }

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>인수인계</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/handover" />
        <main class="container">

          {/* Search */}
          <section class="card" style="margin-bottom:12px">
            <form method="get" action="/staff/handover" style="display:flex;gap:8px;align-items:center">
              <input class="control" type="text" name="handover_q" placeholder="노트 검색..." value={handoverQ} style="flex:1" />
              <button class="btn btn-primary" type="submit">검색</button>
              {handoverQ && <a href="/staff/handover" class="btn btn-secondary">초기화</a>}
            </form>
          </section>

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
                {noteRows.map((note: Record<string, unknown>) => {
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

                      {/* Edit/Delete (author or admin) */}
                      {((note.staff_id as string) === staff.id || staff.role === "admin") && (
                        <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
                          <a href={`/staff/handover/${noteId}/edit`} class="btn btn-sm" style="font-size:11px;text-decoration:none">수정</a>
                          <form method="post" action={`/staff/handover/${noteId}/delete`} style="display:inline" onsubmit="return confirm('이 노트를 삭제하시겠습니까?')">
                            <button class="btn btn-sm btn-secondary" style="font-size:11px" type="submit">삭제</button>
                          </form>
                        </div>
                      )}
                      {/* Edit history */}
                      {(() => {
                        const noteEdits = editsByNote.get(noteId) || [];
                        if (noteEdits.length === 0) return null;
                        return (
                          <details style="margin-top:6px;font-size:11px;color:#94a3b8">
                            <summary style="cursor:pointer">수정됨 ({noteEdits.length}회)</summary>
                            <ul style="margin:4px 0 0 16px;padding:0;list-style:disc">
                              {noteEdits.map((ed) => (
                                <li>{ed.editor_name} · {ed.created_at ? new Date(ed.created_at as string).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" }) : ""}</li>
                              ))}
                            </ul>
                          </details>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>

        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// GET /staff/experience — Experience visits list
ops.get("/staff/experience", async (c) => {
  const staff = getStaff(c);

  const expVisits = await c.env.DB.prepare(
    `SELECT *
     FROM luggage_experience_visits
     ORDER BY scheduled_date DESC, created_at DESC LIMIT 50`
  ).all<Record<string, unknown>>();
  const expStaffNameMap = await fetchStaffNamesByIds(
    c.env,
    uniqueStaffIds([
      ...expVisits.results.flatMap((visit) => [
        visit.created_by_staff_id as string | null | undefined,
        visit.processed_by_staff_id as string | null | undefined,
      ]),
    ]),
  );
  const expVisitRows = expVisits.results.map((visit) => ({
    ...visit,
    creator_name: (visit.created_by_staff_id as string | null)
      ? expStaffNameMap.get(visit.created_by_staff_id as string) || null
      : null,
    processor_name: (visit.processed_by_staff_id as string | null)
      ? expStaffNameMap.get(visit.processed_by_staff_id as string) || null
      : null,
  }));

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>체험단 관리</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/experience" />
        <main class="container">
          <section class="card">
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
              <table style="font-size:12px;border-collapse:collapse;width:100%;min-width:860px">
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
                  {expVisitRows.map((v: Record<string, unknown>) => {
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
                        <td style="padding:3px 6px;font-size:11px;color:#64748b;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{(v.note as string) || "-"}</td>
                        <td style="padding:3px 6px;text-align:center;white-space:nowrap">
                          {/* Detail inline expand */}
                          <details style="display:inline-block;margin-right:2px;text-align:left">
                            <summary class="btn btn-sm" style="font-size:10px;cursor:pointer;list-style:none">상세</summary>
                            <div style="position:absolute;z-index:10;background:white;border:1px solid #e2e8f0;border-radius:6px;padding:10px 14px;min-width:220px;font-size:11px;color:#37352f;box-shadow:0 4px 12px rgba(0,0,0,0.1);margin-top:4px">
                              <p style="margin:2px 0"><strong>방문자:</strong> {v.visitor_name as string}</p>
                              <p style="margin:2px 0"><strong>유형:</strong> {vtLabel}</p>
                              <p style="margin:2px 0"><strong>예정일:</strong> {v.scheduled_date as string}</p>
                              <p style="margin:2px 0"><strong>혜택:</strong> {btLabel} / {(v.benefit_amount as string) || "-"}</p>
                              <p style="margin:2px 0"><strong>상태:</strong> {stLabel}</p>
                              <p style="margin:2px 0"><strong>메모:</strong> {(v.note as string) || "-"}</p>
                              <p style="margin:2px 0"><strong>등록자:</strong> {(v.creator_name as string) || "-"}</p>
                              <p style="margin:2px 0"><strong>처리자:</strong> {(v.processor_name as string) || "-"}</p>
                              <p style="margin:2px 0"><strong>수령자:</strong> {(v.received_by as string) || "-"}</p>
                              <p style="margin:2px 0"><strong>수령일시:</strong> {v.received_at ? new Date(v.received_at as string + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}</p>
                              <p style="margin:2px 0"><strong>등록일시:</strong> {v.created_at ? new Date(v.created_at as string + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}</p>
                              <p style="margin:2px 0"><strong>수정일시:</strong> {v.updated_at ? new Date(v.updated_at as string + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}</p>
                            </div>
                          </details>
                          <a href={`/staff/handover/experience/${v.visit_id}/edit`} class="btn btn-sm" style="font-size:10px;margin-right:2px;text-decoration:none">수정</a>
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

// GET /staff/handover/:id/edit — Edit form
ops.get("/staff/handover/:id/edit", async (c) => {
  const noteId = c.req.param("id");
  const staff = getStaff(c);
  const note = await c.env.DB.prepare(
    `SELECT *
     FROM luggage_handover_notes
     WHERE note_id = ?`
  ).bind(noteId).first<Record<string, unknown>>();
  if (!note) return c.html(<p>Not found</p>, 404);
  if ((note.staff_id as string) !== staff.id && staff.role !== "admin") return c.redirect("/staff/handover");

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>노트 수정</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/handover" />
        <main class="container">
          <section class="card">
            <h3 class="card-title">노트 수정</h3>
            <form method="post" action={`/staff/handover/${noteId}/edit`}>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">분류</span>
                  <select class="control" name="category">
                    {["HANDOVER", "NOTICE", "URGENT", "EXPERIENCE", "OTHER"].map((cat) => (
                      <option value={cat} selected={cat === (note.category as string)}>{NOTE_CATEGORY_LABELS[cat] || cat}</option>
                    ))}
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">제목</span>
                  <input class="control" type="text" name="title" value={note.title as string} required />
                </label>
              </div>
              <label class="field">
                <span class="field-label">내용</span>
                <textarea class="control" name="content" required rows={4}>{note.content as string}</textarea>
              </label>
              <label class="check-row">
                <input type="checkbox" name="is_pinned" value="1" checked={!!(note.is_pinned as number)} />
                <span>고정</span>
              </label>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-primary" type="submit">수정 저장</button>
                <a href="/staff/handover" class="btn btn-secondary">취소</a>
              </div>
            </form>
          </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// POST /staff/handover/:id/edit — Update note with edit history
ops.post("/staff/handover/:id/edit", async (c) => {
  const noteId = c.req.param("id");
  const staff = getStaff(c);
  const body = await c.req.parseBody();

  const note = await c.env.DB.prepare("SELECT * FROM luggage_handover_notes WHERE note_id = ?").bind(noteId).first<Record<string, unknown>>();
  if (!note) return c.redirect("/staff/handover");
  if ((note.staff_id as string) !== staff.id && staff.role !== "admin") return c.redirect("/staff/handover");

  const newTitle = String(body.title || "");
  const newContent = String(body.content || "");

  // Insert edit history
  await c.env.DB.prepare(
    `INSERT INTO luggage_handover_edits (note_id, staff_id, old_title, old_content, new_title, new_content) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(noteId, staff.id, note.title as string, note.content as string, newTitle, newContent).run();

  // Update note
  await c.env.DB.prepare(
    "UPDATE luggage_handover_notes SET title = ?, content = ?, category = ?, is_pinned = ? WHERE note_id = ?"
  ).bind(
    newTitle,
    newContent,
    String(body.category || "HANDOVER"),
    body.is_pinned ? 1 : 0,
    noteId
  ).run();

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

  return c.redirect("/staff/experience");
});

// POST /staff/handover/experience/:id/visit — Mark as visited
ops.post("/staff/handover/experience/:id/visit", async (c) => {
  const visitId = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE luggage_experience_visits SET status = 'VISITED', updated_at = datetime('now') WHERE visit_id = ? AND status = 'SCHEDULED'"
  ).bind(visitId).run();
  return c.redirect("/staff/experience");
});

// POST /staff/handover/experience/:id/receive — Mark as received
ops.post("/staff/handover/experience/:id/receive", async (c) => {
  const visitId = c.req.param("id");
  const staff = getStaff(c);
  await c.env.DB.prepare(
    `UPDATE luggage_experience_visits SET status = 'RECEIVED', processed_by_staff_id = ?, received_by = ?, received_at = datetime('now'), updated_at = datetime('now')
     WHERE visit_id = ? AND status IN ('SCHEDULED', 'VISITED')`
  ).bind(staff.id, getStaff(c).display_name || getStaff(c).username, visitId).run();
  return c.redirect("/staff/experience");
});

// POST /staff/handover/experience/:id/cancel — Cancel visit
ops.post("/staff/handover/experience/:id/cancel", async (c) => {
  const visitId = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE luggage_experience_visits SET status = 'CANCELLED', updated_at = datetime('now') WHERE visit_id = ? AND status IN ('SCHEDULED', 'VISITED')"
  ).bind(visitId).run();
  return c.redirect("/staff/experience");
});

// GET /staff/handover/experience/:id/edit — Edit form for experience visit
ops.get("/staff/handover/experience/:id/edit", async (c) => {
  const visitId = c.req.param("id");
  const staff = getStaff(c);
  const visit = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE visit_id = ?"
  ).bind(visitId).first<Record<string, unknown>>();
  if (!visit) return c.html(<p>Not found</p>, 404);

  return c.html(
    <html lang="ko">
      <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><link rel="stylesheet" href="/static/styles.css" /><title>체험단 수정</title></head>
      <body class="staff-site">
        <StaffTopbar staff={staff} active="/staff/handover" />
        <main class="container">
          <section class="card">
            <h3 class="card-title">체험단 수정</h3>
            <form method="post" action={`/staff/handover/experience/${visitId}/update`}>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">방문자 이름</span>
                  <input class="control" type="text" name="visitor_name" value={visit.visitor_name as string} required />
                </label>
                <label class="field">
                  <span class="field-label">유형</span>
                  <select class="control" name="visitor_type">
                    {["BLOGGER", "INFLUENCER", "YOUTUBER", "OTHER"].map((vt) => (
                      <option value={vt} selected={vt === (visit.visitor_type as string)}>
                        {vt === "BLOGGER" ? "블로거" : vt === "INFLUENCER" ? "인플루언서" : vt === "YOUTUBER" ? "유튜버" : "기타"}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">방문 예정일</span>
                  <input class="control" type="date" name="scheduled_date" value={visit.scheduled_date as string} required />
                </label>
                <label class="field">
                  <span class="field-label">혜택 유형</span>
                  <select class="control" name="benefit_type">
                    {[["", "선택"], ["GIFT_CARD", "상품권"], ["CASH", "지원금"], ["PRODUCT", "물품"], ["OTHER", "기타"]].map(([val, label]) => (
                      <option value={val} selected={val === (visit.benefit_type as string ?? "")}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div class="grid2">
                <label class="field">
                  <span class="field-label">혜택 금액/내용</span>
                  <input class="control" type="text" name="benefit_amount" value={(visit.benefit_amount as string) || ""} placeholder="예: ¥3,000" />
                </label>
                <label class="field">
                  <span class="field-label">메모</span>
                  <input class="control" type="text" name="note" value={(visit.note as string) || ""} placeholder="메모" />
                </label>
              </div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-primary" type="submit">수정 저장</button>
                <a href="/staff/experience" class="btn btn-secondary">취소</a>
              </div>
            </form>
          </section>
        </main>
        <NewOrderAlert />
      </body>
    </html>
  );
});

// POST /staff/handover/experience/:id/update — Update experience visit
ops.post("/staff/handover/experience/:id/update", async (c) => {
  const visitId = c.req.param("id");
  const body = await c.req.parseBody();

  await c.env.DB.prepare(
    `UPDATE luggage_experience_visits SET
       visitor_name = ?, visitor_type = ?, scheduled_date = ?,
       benefit_type = ?, benefit_amount = ?, note = ?,
       updated_at = datetime('now')
     WHERE visit_id = ?`
  ).bind(
    String(body.visitor_name || ""),
    String(body.visitor_type || "BLOGGER"),
    String(body.scheduled_date || ""),
    String(body.benefit_type || "") || null,
    String(body.benefit_amount || "") || null,
    String(body.note || "") || null,
    visitId
  ).run();

  return c.redirect("/staff/experience");
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

// POST /staff/lost-found/:id/delete — Delete entry (editor/admin only)
ops.post("/staff/lost-found/:id/delete", async (c) => {
  const staff = getStaff(c);
  if (staff.role !== "admin" && staff.role !== "editor") {
    return c.redirect("/staff/lost-found");
  }
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
