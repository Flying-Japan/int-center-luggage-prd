/**
 * Rental revenue fetcher — reads daily rental data from Google Sheets.
 */
import { fetchSheetData } from "../lib/googleSheets";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Generate sheet name for a given date's month, e.g. "Daily 01.Mar" */
function getSheetName(date: Date = new Date()): string {
  // Convert to JST (UTC+9)
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `Daily 01.${MONTH_ABBR[jst.getUTCMonth()]}`;
}

export interface RentalDailyRevenue {
  date: string; // YYYY-MM-DD format
  rentalRevenue: number; // yen amount
  rentalCount: number; // number of rental orders
}

/**
 * Parse date format "2026/03/01/日" → "2026-03-01"
 */
function parseSheetDate(raw: string): string | null {
  if (!raw) return null;
  // Match YYYY/MM/DD with optional trailing day-of-week character
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Parse yen format "¥58,132" → 58132, or plain number "58132" → 58132
 */
function parseYen(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[¥,\s]/g, "");
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Fetch rental daily revenue from Google Sheets.
 * @param credentials JSON string of service account credentials
 * @returns Array of { date, rentalRevenue } for rows with non-zero rental
 */
export async function fetchRentalDailyRevenue(
  credentials: string
): Promise<RentalDailyRevenue[]> {
  const sheetName = getSheetName();

  // Fetch daily revenue + rental order counts in parallel
  const [dailyRows, rentalRows] = await Promise.all([
    fetchSheetData(credentials, SPREADSHEET_ID, `'${sheetName}'!A:K`),
    fetchSheetData(credentials, SPREADSHEET_ID, "'New Rental'!X:X"),
  ]);

  // Count rental orders per date from "New Rental" col X (결제(월/일))
  const countMap = new Map<string, number>();
  for (let i = 1; i < rentalRows.length; i++) {
    const raw = rentalRows[i]?.[0];
    if (!raw) continue;
    // Format varies: "2026/03/01/日" or just a date string
    const dateStr = parseSheetDate(raw);
    if (!dateStr) continue;
    countMap.set(dateStr, (countMap.get(dateStr) || 0) + 1);
  }

  const results: RentalDailyRevenue[] = [];

  // Skip header rows (row 0 = header group, row 1 = column headers)
  for (let i = 2; i < dailyRows.length; i++) {
    const row = dailyRows[i];
    if (!row || row.length === 0) continue;

    const dateStr = parseSheetDate(row[0] || "");
    if (!dateStr) continue;

    // Col K = index 10
    const rentalRevenue = parseYen(row[10] || "");
    if (rentalRevenue === 0) continue;

    results.push({
      date: dateStr,
      rentalRevenue,
      rentalCount: countMap.get(dateStr) || 0,
    });
  }

  return results;
}
