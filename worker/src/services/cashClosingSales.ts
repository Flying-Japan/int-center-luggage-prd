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
  grossCashAmount?: number;
  grossQrAmount?: number;
  cashRefundAmount?: number;
  refundCount?: number;
  qrRefundAmount?:number;
  unallocatedRefundAmount?:number;
  generalReturnedAmount?:number;
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
    `SELECT *, cash AS cash_amount, qr AS qr_amount, paid_count AS order_count
     FROM luggage_sales_daily WHERE business_date >= ? AND business_date <= ?`,
  ).bind(dateRange.rangeStart, dateRange.rangeEnd).all<{
    business_date: string; cash_amount: number; qr_amount: number; total_amount: number; order_count: number; legacy_estimated_amount: number; recorded_amount: number; gross_cash: number; gross_qr: number; cash_refund_amount: number; refund_count: number; qr_refund_amount:number; unallocated_refund_amount:number; general_returned_amount:number;
  }>();
  const result = new Map<string, AutoSalesSummary>();
  for (const row of rows.results) {
    result.set(row.business_date, { cashAmount: row.cash_amount ?? 0, qrAmount: row.qr_amount ?? 0, totalAmount: row.total_amount ?? 0, orderCount: row.order_count ?? 0, source: "live_orders",
      ...(row.refund_count > 0 ? { grossCashAmount: row.gross_cash, grossQrAmount: row.gross_qr, cashRefundAmount: row.cash_refund_amount, refundCount: row.refund_count,...(row.general_returned_amount>0?{qrRefundAmount:row.qr_refund_amount,unallocatedRefundAmount:row.unallocated_refund_amount,generalReturnedAmount:row.general_returned_amount}:{}) } : {}),
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
    if (live && ((live.refundCount ?? 0) > 0 || live.totalAmount > 0 || live.orderCount > 0 || businessDate === today)) {
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

/** Resolve only returns already present in the immutable closing basis. Later
 * newly recorded returns remain a visible post-close change, not a rewritten count. */
export async function resolveClosingReturnBasis(db:D1Database,snapshotJson:string){
 const basis=JSON.parse(snapshotJson) as {generalReturns:Array<{id:string}>};
 return db.prepare(`SELECT COALESCE(SUM(CASE WHEN r.method='PAY_QR' THEN r.amount ELSE 0 END),0) AS resolvedQrReturned,
 COALESCE(SUM(CASE WHEN r.method='UNKNOWN' THEN r.amount ELSE 0 END),0) AS snapshotUnallocated
 FROM luggage_correction_returns r JOIN json_each(?) ids ON r.correction_id=json_extract(ids.value,'$.id')`)
 .bind(JSON.stringify(basis.generalReturns)).first<{resolvedQrReturned:number;snapshotUnallocated:number}>();
}
