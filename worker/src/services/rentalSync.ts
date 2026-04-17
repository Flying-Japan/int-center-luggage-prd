/**
 * Rental daily sales sync — fetches rental revenue from Supabase product_orders
 * and upserts into D1 luggage_rental_daily_sales.
 *
 * - Filters out cancelled/returned orders (CANCEL_DONE, RETURN_DONE, ADMIN_CANCEL_DONE)
 * - Groups by payed_datetime in KST (Asia/Seoul)
 * - Converts KRW to JPY at fixed rate
 * - Runs daily via cron, also backfills missing dates (last 30 days)
 */

const KRW_PER_JPY = 9.5;
const CANCELLED_STATUSES = ["CANCEL_DONE", "RETURN_DONE", "ADMIN_CANCEL_DONE"];

/** Convert a UTC ISO timestamp to KST date string (YYYY-MM-DD). */
function toKSTDate(utcTimestamp: string): string {
  const d = new Date(utcTimestamp);
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Fetch product_orders from Supabase REST API with pagination. */
async function fetchProductOrders(
  supabaseUrl: string,
  serviceRoleKey: string,
  fromKST: string,
  toKST: string
): Promise<{ payed_datetime: string; total_payment_amount: number; place_order_status: string }[]> {
  const fromUTC = new Date(`${fromKST}T00:00:00+09:00`).toISOString();
  const toUTC = new Date(`${toKST}T00:00:00+09:00`).toISOString();

  const allRows: { payed_datetime: string; total_payment_amount: number; place_order_status: string }[] = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const url = `${supabaseUrl}/rest/v1/product_orders` +
      `?select=payed_datetime,total_payment_amount,place_order_status` +
      `&payed_datetime=gte.${fromUTC}` +
      `&payed_datetime=lt.${toUTC}` +
      `&order=payed_datetime.asc` +
      `&limit=${pageSize}` +
      `&offset=${offset}`;

    const resp = await fetch(url, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    if (!resp.ok) {
      console.error(`[rentalSync] Supabase fetch failed: ${resp.status} ${await resp.text()}`);
      return [];
    }

    const data = await resp.json() as typeof allRows;
    allRows.push(...data);

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return allRows;
}

/** Aggregate raw orders into daily KRW totals, filtering cancellations. */
function aggregateDaily(
  rows: { payed_datetime: string; total_payment_amount: number; place_order_status: string }[]
): Map<string, { krw: number; count: number }> {
  const dailyMap = new Map<string, { krw: number; count: number }>();

  for (const row of rows) {
    if (!row.payed_datetime || !row.total_payment_amount) continue;
    if (CANCELLED_STATUSES.includes(row.place_order_status)) continue;

    const kstDate = toKSTDate(row.payed_datetime);
    const existing = dailyMap.get(kstDate) || { krw: 0, count: 0 };
    existing.krw += row.total_payment_amount;
    existing.count += 1;
    dailyMap.set(kstDate, existing);
  }

  return dailyMap;
}

/**
 * Sync rental daily sales into D1.
 * Fetches from Supabase, filters cancellations, converts KRW→JPY, upserts.
 * Backfills any missing previous days (up to 30 days back).
 */
export async function syncRentalDailySales(
  db: D1Database,
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<{ synced: number; backfilled: number }> {
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yesterday = new Date(jstNow);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const thirtyDaysAgo = new Date(jstNow);
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  const fromDateStr = thirtyDaysAgo.toISOString().slice(0, 10);

  // Get existing rental dates in D1
  const existing = await db
    .prepare(
      "SELECT business_date FROM luggage_rental_daily_sales WHERE business_date >= ? AND business_date <= ?"
    )
    .bind(fromDateStr, yesterdayStr)
    .all<{ business_date: string }>();

  const existingDates = new Set(existing.results.map((r) => r.business_date));

  // Find missing dates
  const missingDates: string[] = [];
  const d = new Date(fromDateStr);
  const end = new Date(yesterdayStr);
  while (d <= end) {
    const ds = d.toISOString().slice(0, 10);
    if (!existingDates.has(ds)) {
      missingDates.push(ds);
    }
    d.setDate(d.getDate() + 1);
  }

  // Always refresh yesterday
  if (!missingDates.includes(yesterdayStr)) {
    missingDates.push(yesterdayStr);
  }

  if (missingDates.length === 0) {
    console.log("[rentalSync] No missing dates");
    return { synced: 0, backfilled: 0 };
  }

  const fetchFrom = missingDates.sort()[0];
  const fetchToDate = new Date(yesterdayStr);
  fetchToDate.setDate(fetchToDate.getDate() + 1);
  const fetchTo = fetchToDate.toISOString().slice(0, 10);

  console.log(`[rentalSync] Fetching ${fetchFrom} to ${fetchTo} (${missingDates.length} dates to fill)`);

  const rows = await fetchProductOrders(supabaseUrl, serviceRoleKey, fetchFrom, fetchTo);
  if (rows.length === 0) {
    console.log("[rentalSync] No data from Supabase");
    return { synced: 0, backfilled: 0 };
  }

  const dailyData = aggregateDaily(rows);

  let synced = 0;
  let backfilled = 0;

  for (const [date, { krw, count }] of dailyData) {
    const jpyAmount = Math.round(krw / KRW_PER_JPY);
    const wasExisting = existingDates.has(date);

    await db
      .prepare("DELETE FROM luggage_rental_daily_sales WHERE business_date = ?")
      .bind(date)
      .run();

    await db
      .prepare(
        `INSERT INTO luggage_rental_daily_sales (business_date, revenue_amount, customer_count, note, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(date, jpyAmount, count, `auto-sync KRW${krw}/${KRW_PER_JPY}`, `${date} 21:00:00`)
      .run();

    if (wasExisting) {
      synced++;
    } else {
      backfilled++;
    }
  }

  console.log(`[rentalSync] Complete: synced=${synced}, backfilled=${backfilled}`);
  return { synced, backfilled };
}
