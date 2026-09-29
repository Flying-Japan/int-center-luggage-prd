/**
 * Naver rental revenue sync — pulls online (Naver Smartstore) order data from the
 * center Supabase and stores daily KRW totals in luggage_naver_rental_daily_sales.
 *
 * This is online revenue, not on-site luggage revenue: it is kept in KRW and is
 * never converted to JPY or added to luggage totals.
 *
 * Formula mirrors the center dashboard /revenue page (useDailyRevenueData):
 *   - date: product_orders.payed_datetime as a KST calendar date
 *   - amount: SUM(total_payment_amount) over every row paid that day
 *   - excludes damage/loss charge products (reported separately there)
 *   - order_count: number of product_order rows
 */

import { captureOperationalMessage } from "../lib/observability";

const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAMAGE_LOSS_PRODUCT_ID = "12611527498";

export interface NaverProductOrderRow {
  product_id: string | null;
  product_name: string | null;
  payed_datetime: string | null;
  total_payment_amount: number | string | null;
}

export interface NaverRentalDailyTotal {
  revenueKrw: number;
  orderCount: number;
}

/** Same rule as center-dashboard src/lib/revenueExclusions.ts */
export function isDamageLossProduct(row: Pick<NaverProductOrderRow, "product_id" | "product_name">): boolean {
  if (row.product_id === DAMAGE_LOSS_PRODUCT_ID) return true;
  const name = row.product_name ?? "";
  return name.includes("파손") || name.includes("분실");
}

export function toKstDate(timestamp: string): string | null {
  const ms = new Date(timestamp).getTime();
  if (Number.isNaN(ms)) return null;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function aggregateNaverRentalDaily(rows: NaverProductOrderRow[]): Map<string, NaverRentalDailyTotal> {
  const daily = new Map<string, NaverRentalDailyTotal>();
  for (const row of rows) {
    if (!row.payed_datetime || isDamageLossProduct(row)) continue;
    const date = toKstDate(row.payed_datetime);
    if (!date) continue;
    const current = daily.get(date) ?? { revenueKrw: 0, orderCount: 0 };
    current.revenueKrw += Number(row.total_payment_amount) || 0;
    current.orderCount += 1;
    daily.set(date, current);
  }
  return daily;
}

function kstDayStartUtc(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - KST_OFFSET_MS).toISOString();
}

function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

function todayKst(): string {
  return new Date(Date.now() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Re-sync Naver rental revenue for the KST date range [fromDate, toDate].
 * Existing rows in the range are replaced, so days whose orders disappeared drop to nothing.
 */
export async function syncNaverRentalRevenueRange(
  db: D1Database,
  supabaseUrl: string,
  supabaseKey: string,
  fromDate: string,
  toDate: string,
): Promise<{ synced: number; rows: number }> {
  const fromUtc = kstDayStartUtc(fromDate);
  const toUtcExclusive = kstDayStartUtc(addDays(toDate, 1));
  const rows: NaverProductOrderRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${supabaseUrl}/rest/v1/product_orders?select=product_id,product_name,payed_datetime,total_payment_amount`
      + `&payed_datetime=gte.${encodeURIComponent(fromUtc)}&payed_datetime=lt.${encodeURIComponent(toUtcExclusive)}`
      + `&order=payed_datetime.asc,product_order_id.asc`;
    const resp = await fetch(url, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Range: `${page * PAGE_SIZE}-${page * PAGE_SIZE + PAGE_SIZE - 1}`,
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`Supabase rental sync failed: ${resp.status} ${body}`);
      captureOperationalMessage("Supabase rental sync failed", {
        level: "error",
        operation: "scheduled.rental_revenue_sync",
        tags: { external_service: "supabase", status: resp.status },
        context: { fromDate, toDate, page, responseBody: body.slice(0, 500) },
        fingerprint: ["scheduled.rental_revenue_sync", String(resp.status)],
      });
      // Never replace stored totals with a partial fetch.
      throw new Error(`Supabase rental sync failed: ${resp.status}`);
    }

    const pageRows: NaverProductOrderRow[] = await resp.json();
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
    if (page === MAX_PAGES - 1) throw new Error("Supabase rental sync exceeded page limit");
  }

  const daily = aggregateNaverRentalDaily(rows);
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM luggage_naver_rental_daily_sales WHERE business_date BETWEEN ? AND ?").bind(fromDate, toDate),
  ];
  for (const [date, total] of daily) {
    if (date < fromDate || date > toDate) continue;
    stmts.push(
      db.prepare(
        `INSERT INTO luggage_naver_rental_daily_sales (business_date, revenue_krw, order_count, synced_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).bind(date, Math.round(total.revenueKrw), total.orderCount)
    );
  }
  await db.batch(stmts);

  return { synced: stmts.length - 1, rows: rows.length };
}

/** Cron entry point: re-sync the last N days (default 60) so late claims and edits are picked up. */
export async function syncRentalRevenue(
  db: D1Database,
  supabaseUrl: string,
  supabaseKey: string,
  syncDays = 60,
): Promise<{ synced: number; rows: number }> {
  if (!supabaseUrl || !supabaseKey) return { synced: 0, rows: 0 };
  const today = todayKst();
  return syncNaverRentalRevenueRange(db, supabaseUrl, supabaseKey, addDays(today, -syncDays), today);
}
