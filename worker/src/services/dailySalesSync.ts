/**
 * Daily sales sync — pulls luggage + rental data from Google Sheets into D1.
 * Designed to run via cron, syncing the last 3 days to catch late updates.
 */
import { fetchSheetData } from "../lib/googleSheets";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(raw: string): string | null {
  const m = raw?.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function parseYen(raw: string): number {
  if (!raw || raw.includes("#")) return 0;
  const n = parseInt(raw.replace(/[¥,\s]/g, ""), 10);
  return isNaN(n) ? 0 : n;
}

export async function syncDailySales(
  db: D1Database,
  credentials: string
): Promise<{ synced: number }> {
  if (!credentials) return { synced: 0 };

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const sheetName = `Daily 01.${MONTH_ABBR[now.getUTCMonth()]}`;

  // Fetch luggage data from Daily sheet
  const dailyRows = await fetchSheetData(credentials, SPREADSHEET_ID, `'${sheetName}'!A:K`);

  // Fetch rental yen from New Rental (col W=timestamp, col AC=yen live, col AB=yen base)
  const rentalRows = await fetchSheetData(credentials, SPREADSHEET_ID, "'New Rental'!W:AD");

  // Compute rental per date
  const rentalMap = new Map<string, number>();
  for (let i = 1; i < rentalRows.length; i++) {
    const r = rentalRows[i];
    const ts = r?.[0] || "";
    if (!ts.includes("T")) continue;
    const dateMatch = ts.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    let yen = parseYen(r?.[6] || ""); // col AC = yen live
    if (yen === 0) {
      const krw = parseYen(r?.[5] || ""); // col AB = base amount
      if (krw > 0) yen = Math.round(krw / 9.48);
    }
    rentalMap.set(date, (rentalMap.get(date) || 0) + yen);
  }

  // Only sync last 3 days to catch late updates
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000).toISOString().slice(0, 10);

  const stmts: D1PreparedStatement[] = [];
  for (let i = 2; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    if (!row || row.length < 5) continue;
    const date = parseDate(row[0] || "");
    if (!date || date < threeDaysAgo) continue;
    const people = parseInt((row[1] || "0").replace(/[^0-9]/g, ""), 10) || 0;
    const cash = parseYen(row[2] || "");
    const qr = parseYen(row[3] || "");
    const luggage = parseYen(row[4] || "");
    const rental = rentalMap.get(date) || parseYen(row[10] || "");
    if (luggage === 0 && rental === 0 && people === 0) continue;

    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO luggage_daily_sales (sale_date, people, cash, qr, luggage_total, rental_total) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(date, people, cash, qr, luggage, rental)
    );
  }

  if (stmts.length > 0) {
    await db.batch(stmts);
  }

  return { synced: stmts.length };
}
