import { formatDateJST } from "./storage";

export const CASH_CLOSING_STARTING_FLOAT = 40000;

export type AutoSalesSummary = {
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
  return { uniqueDates, rangeStart: sortedDates[0], rangeEnd: sortedDates[sortedDates.length - 1] };
}

async function fetchDailySalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
  const dateRange = buildDateRange(businessDates);
  if (!dateRange) return new Map();
  const rows = await db.prepare(
    `SELECT sale_date, cash, qr, luggage_total
     FROM luggage_daily_sales
     WHERE sale_date >= ?
       AND sale_date <= ?`,
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{ sale_date: string; cash: number; qr: number; luggage_total: number }>();
  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.sale_date, { cashAmount: row.cash ?? 0, qrAmount: row.qr ?? 0, totalAmount: row.luggage_total ?? 0, orderCount: 0, source: "daily_sales" });
  }
  return result;
}

async function fetchLiveOrderSalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
  const dateRange = buildDateRange(businessDates);
  if (!dateRange) return new Map();
  const rows = await db.prepare(
    `WITH payment_allocations AS (
       SELECT order_id,
              SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) as cash_amount,
              SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) as qr_amount,
              COUNT(*) as payment_count
       FROM luggage_order_payments
       GROUP BY order_id
     )
     SELECT
       date(o.created_at, '+9 hours') as business_date,
       SUM(CASE WHEN COALESCE(pa.payment_count, 0) > 0 THEN pa.qr_amount WHEN o.payment_method = 'PAY_QR' THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) as qr_amount,
       SUM(CASE WHEN COALESCE(pa.payment_count, 0) > 0 THEN pa.cash_amount WHEN o.payment_method = 'CASH' OR o.payment_method IS NULL THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) as cash_amount,
       SUM(COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount) as total_amount,
       COUNT(*) as order_count
     FROM luggage_orders o
     LEFT JOIN payment_allocations pa ON pa.order_id = o.order_id
     WHERE date(o.created_at, '+9 hours') >= ?
       AND date(o.created_at, '+9 hours') <= ?
       AND o.status IN ('PAID', 'PICKED_UP')
     GROUP BY date(o.created_at, '+9 hours')`,
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{
    business_date: string; cash_amount: number; qr_amount: number; total_amount: number; order_count: number;
  }>();
  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.business_date, { cashAmount: row.cash_amount ?? 0, qrAmount: row.qr_amount ?? 0, totalAmount: row.total_amount ?? 0, orderCount: row.order_count ?? 0, source: "live_orders" });
  }
  return result;
}

export async function resolveAutoSalesSummariesByDate(db: D1Database, businessDates: string[]): Promise<Map<string, AutoSalesSummary>> {
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
    if (live && (live.totalAmount > 0 || live.orderCount > 0 || businessDate === today)) {
      result.set(businessDate, live);
      continue;
    }
    if (daily && daily.totalAmount > 0) {
      result.set(businessDate, daily);
      continue;
    }
    if (daily) result.set(businessDate, daily);
  }
  return result;
}

export async function resolveAutoSalesSummaryForDate(db: D1Database, businessDate: string): Promise<AutoSalesSummary | null> {
  return (await resolveAutoSalesSummariesByDate(db, [businessDate])).get(businessDate) ?? null;
}
