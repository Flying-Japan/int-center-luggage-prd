import { formatDateJST } from "./storage";

export const CASH_CLOSING_STARTING_FLOAT = 40000;

export type AutoSalesSummary = {
  cashAmount: number;
  qrAmount: number;
  totalAmount: number;
  orderCount: number;
  source: "daily_sales" | "live_orders";
  /** Present only when the legacy reconciliation total contains PAID estimates without tender rows. */
  estimatedAmount?: number;
  recordedAmount?: number;
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
    `SELECT business_date, cash AS cash_amount, qr AS qr_amount, total_amount, paid_count AS order_count, legacy_estimated_amount, recorded_amount
     FROM luggage_sales_daily WHERE business_date >= ? AND business_date <= ?`,
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{
    business_date: string; cash_amount: number; qr_amount: number; total_amount: number; order_count: number; legacy_estimated_amount: number; recorded_amount: number;
  }>();
  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.business_date, { cashAmount: row.cash_amount ?? 0, qrAmount: row.qr_amount ?? 0, totalAmount: row.total_amount ?? 0, orderCount: row.order_count ?? 0, source: "live_orders",
      ...(row.legacy_estimated_amount > 0 ? { estimatedAmount: row.legacy_estimated_amount, recordedAmount: row.recorded_amount } : {}),
    });
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
