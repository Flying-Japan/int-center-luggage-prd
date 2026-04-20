/**
 * Daily sales sync — pulls luggage + rental data from Google Sheets into D1.
 * Supports two modes:
 *   - Incremental (cron): syncs last 3 days of current month
 *   - Full backfill: syncs all months from start to current
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

function getCurrentMonthCutoffDate(now = new Date()): { cutoffDate: string; month: number; year: number } {
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth();
  const cutoffDate = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  return { cutoffDate, month, year };
}

/** Sync a single month's sheet data into D1. Returns number of rows synced. */
async function syncMonth(
  db: D1Database,
  credentials: string,
  year: number,
  month: number, // 0-based
  cutoffDate?: string // Only sync rows >= this date (for incremental)
): Promise<number> {
  const sheetName = `Daily 01.${MONTH_ABBR[month]}`;

  let dailyRows: string[][];
  try {
    dailyRows = await fetchSheetData(credentials, SPREADSHEET_ID, `'${sheetName}'!A:K`);
  } catch {
    return 0; // Sheet doesn't exist for this month
  }

  // Fetch rental yen from New Rental (col W=timestamp, col AC=yen live, col AB=yen base)
  let rentalRows: string[][] = [];
  try {
    rentalRows = await fetchSheetData(credentials, SPREADSHEET_ID, "'New Rental'!W:AD");
  } catch {
    // Rental sheet might not exist
  }

  // Compute rental per date
  const rentalMap = new Map<string, number>();
  for (let i = 1; i < rentalRows.length; i++) {
    const r = rentalRows[i];
    const ts = r?.[0] || "";
    if (!ts.includes("T")) continue;
    const dateMatch = ts.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;
    const date = dateMatch[1];
    // Only include rental for the month we're syncing
    const [dy, dm] = date.split("-").map(Number);
    if (dy !== year || dm !== month + 1) continue;
    let yen = parseYen(r?.[6] || ""); // col AC = yen live
    if (yen === 0) {
      const krw = parseYen(r?.[5] || ""); // col AB = base amount
      if (krw > 0) yen = Math.round(krw / 9.48);
    }
    rentalMap.set(date, (rentalMap.get(date) || 0) + yen);
  }

  const stmts: D1PreparedStatement[] = [];
  for (let i = 2; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    if (!row || row.length < 5) continue;
    const date = parseDate(row[0] || "");
    if (!date) continue;
    if (cutoffDate && date < cutoffDate) continue;
    const people = parseInt((row[1] || "0").replace(/[^0-9]/g, ""), 10) || 0;
    const cash = parseYen(row[2] || "");
    const qr = parseYen(row[3] || "");
    const luggage = cash + qr;
    const rental = Math.max(rentalMap.get(date) || 0, parseYen(row[10] || ""));
    if (luggage === 0 && rental === 0 && people === 0) continue;

    stmts.push(
      db.prepare(
        "INSERT OR REPLACE INTO luggage_daily_sales (sale_date, people, cash, qr, luggage_total, rental_total) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(date, people, cash, qr, luggage, rental)
    );
  }

  if (stmts.length > 0) {
    // D1 batch limit: process in chunks of 100
    for (let i = 0; i < stmts.length; i += 100) {
      await db.batch(stmts.slice(i, i + 100));
    }
  }

  return stmts.length;
}

/** Incremental sync — resync the full current month daily so missing rows self-heal. */
export async function syncDailySales(
  db: D1Database,
  credentials: string
): Promise<{ synced: number }> {
  if (!credentials) return { synced: 0 };

  const { cutoffDate, month, year } = getCurrentMonthCutoffDate();
  const synced = await syncMonth(db, credentials, year, month, cutoffDate);
  return { synced };
}

/** Full backfill — all months from startYear/startMonth to now */
export async function backfillAllDailySales(
  db: D1Database,
  credentials: string,
  startYear = 2025,
  startMonth = 0 // 0-based (Jan)
): Promise<{ synced: number; months: number }> {
  if (!credentials) return { synced: 0, months: 0 };

  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();

  let totalSynced = 0;
  let monthCount = 0;

  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 0;
    const mEnd = y === endYear ? endMonth : 11;
    for (let m = mStart; m <= mEnd; m++) {
      const synced = await syncMonth(db, credentials, y, m);
      totalSynced += synced;
      monthCount++;
    }
  }

  return { synced: totalSynced, months: monthCount };
}
