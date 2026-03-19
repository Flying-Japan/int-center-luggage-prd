/**
 * Rental revenue fetcher — reads daily rental data from Google Sheets.
 */
import { fetchSheetData } from "../lib/googleSheets";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";
// TODO: Sheet name changes monthly (e.g., "Daily 01.Mar", "Daily 01.Apr").
// Consider making this configurable or auto-detecting the current month's sheet.
const SHEET_NAME = "Daily 01.Mar";

export interface RentalDailyRevenue {
  date: string; // YYYY-MM-DD format
  rentalRevenue: number; // yen amount
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
  // Fetch columns A and K (date and rental revenue)
  const rows = await fetchSheetData(
    credentials,
    SPREADSHEET_ID,
    `'${SHEET_NAME}'!A:K`
  );

  const results: RentalDailyRevenue[] = [];

  // Skip header rows (row 0 = header group, row 1 = column headers)
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const dateStr = parseSheetDate(row[0] || "");
    if (!dateStr) continue;

    // Col K = index 10
    const rentalRevenue = parseYen(row[10] || "");
    if (rentalRevenue === 0) continue;

    results.push({ date: dateStr, rentalRevenue });
  }

  return results;
}
