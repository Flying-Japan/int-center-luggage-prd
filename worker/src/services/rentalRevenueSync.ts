/**
 * Rental revenue sync — pulls order data from Supabase (Naver orders DB)
 * and aggregates daily rental revenue into luggage_rental_daily_sales.
 *
 * Source of truth: Supabase product_orders.payed_datetime (KST date)
 * Revenue: unit_price (KRW) * quantity / 9.5 → JPY
 */

const KRW_TO_JPY_RATE = 9.5;

interface ProductOrderRow {
  payed_datetime: string;
  unit_price: number | null;
  quantity: number | null;
}

/**
 * Sync rental revenue for the last N days from Supabase into D1.
 */
export async function syncRentalRevenue(
  db: D1Database,
  supabaseUrl: string,
  supabaseKey: string,
  syncDays = 7
): Promise<{ synced: number }> {
  if (!supabaseUrl || !supabaseKey) return { synced: 0 };

  // KST = UTC+9; calculate date range
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const fromDate = new Date(now.getTime() - syncDays * 86400000);
  // Convert KST dates to UTC for Supabase query (subtract 9 hours)
  const fromUtc = new Date(fromDate.getTime() - 9 * 60 * 60 * 1000).toISOString();
  const toUtc = new Date(now.getTime() - 9 * 60 * 60 * 1000 + 86400000).toISOString();

  // Fetch product_orders with payed_datetime in range
  const url = `${supabaseUrl}/rest/v1/product_orders?select=payed_datetime,unit_price,quantity&payed_datetime=gte.${fromUtc}&payed_datetime=lte.${toUtc}&order=payed_datetime.desc&limit=5000`;
  const resp = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  });

  if (!resp.ok) {
    console.error(`Supabase rental sync failed: ${resp.status} ${await resp.text()}`);
    return { synced: 0 };
  }

  const rows: ProductOrderRow[] = await resp.json();

  // Group by KST date
  const daily = new Map<string, { krw: number; count: number }>();
  for (const row of rows) {
    if (!row.payed_datetime) continue;
    // Parse and convert to KST date
    const dt = new Date(row.payed_datetime);
    const kstMs = dt.getTime() + 9 * 60 * 60 * 1000;
    const kstDate = new Date(kstMs).toISOString().slice(0, 10);

    const price = Number(row.unit_price) || 0;
    const qty = Number(row.quantity) || 0;
    const existing = daily.get(kstDate) || { krw: 0, count: 0 };
    existing.krw += price * qty;
    existing.count += qty;
    daily.set(kstDate, existing);
  }

  // Upsert into D1
  const stmts: D1PreparedStatement[] = [];
  for (const [date, val] of daily) {
    const jpy = Math.round(val.krw / KRW_TO_JPY_RATE);
    const note = `Supabase SOT payed_datetime KRW${Math.round(val.krw)}/${KRW_TO_JPY_RATE}`;
    stmts.push(
      db.prepare(
        `INSERT INTO luggage_rental_daily_sales (business_date, revenue_amount, customer_count, note, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(business_date) DO UPDATE SET
           revenue_amount = excluded.revenue_amount,
           customer_count = excluded.customer_count,
           note = excluded.note,
           updated_at = datetime('now')`
      ).bind(date, jpy, val.count, note)
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  return { synced: stmts.length };
}
