#!/usr/bin/env node

/**
 * Backfill luggage_orders from Google Sheets "Luggage" tab.
 *
 * Usage:
 *   # Step 1: Print headers to verify column mapping
 *   GOOGLE_SHEETS_CREDENTIALS='...' node scripts/backfill-orders-from-sheet.mjs --headers
 *
 *   # Step 2: Dry run — print SQL without executing
 *   GOOGLE_SHEETS_CREDENTIALS='...' node scripts/backfill-orders-from-sheet.mjs
 *
 *   # Step 3: Apply to remote D1
 *   GOOGLE_SHEETS_CREDENTIALS='...' node scripts/backfill-orders-from-sheet.mjs --apply
 *
 *   # Apply to local D1 (dev)
 *   GOOGLE_SHEETS_CREDENTIALS='...' node scripts/backfill-orders-from-sheet.mjs --apply --local
 */

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";
const DB_NAME = "center-luggage-db";

// ── Column mapping (verified via --headers) ──
// Col 0: タイムスタンプ (created_at)
// Col 1: 성명/Name (name)
// Col 2: No (sequential number)
// Col 3: People (luggage count)
// Col 4: Rate (amount charged — import as-is)
// Col 5: 짐 찾는 시각 (expected pickup time, time-only like "18:00:00")
// Col 6: 짐 사진 URL
// Col 7: flag (TRUE/blank)
// Col 8: pick up time (actual pickup datetime)
// Col 9: 신분증 사진 URL
// Col 10: note
// Col 11: 연락처/phone
// Col 12: email
// Col 13: consent
const COL = {
  created_at: 0,          // タイムスタンプ — "2026/01/03 18:01:07"
  name: 1,                // 성명
  seq_no: 2,              // No — sequential number from sheet
  people: 3,              // People — luggage count
  rate: 4,                // Rate — amount charged (import as-is)
  expected_pickup_time: 5, // 짐 찾는 시각 — time only "18:00:00"
  actual_pickup_at: 8,    // pick up time — "2026-01-05 18:27:31"
  note: 10,               // note
  phone: 11,              // 연락처
  email: 12,              // email
};

// ── Helpers ──

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseInt0(raw) {
  const n = parseInt(`${raw ?? ""}`.replace(/[^\d]/g, ""), 10);
  return isFinite(n) ? n : 0;
}

/**
 * Parse a date string from the sheet into ISO 8601 UTC.
 * Assumes sheet dates are in JST (UTC+9).
 * Handles: "2025/10/15", "2025-10-15", "2025/10/15 14:30", etc.
 */
function parseJSTDate(raw) {
  const text = `${raw ?? ""}`.trim();
  if (!text || text === "-") return null;

  // Try parsing as-is
  const normalized = text.replace(/\//g, "-");
  let d;

  // If it has time component
  if (/\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}/.test(normalized)) {
    d = new Date(normalized.replace(" ", "T") + "+09:00");
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    // Date only — assume 10:00 JST (middle of business hours)
    d = new Date(normalized + "T10:00:00+09:00");
  } else {
    return null;
  }

  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extract YYYYMMDD business date from a JST date string.
 */
function businessDateFromISO(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}


// ── Google Sheets API ──

function getServiceAccount() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("Set GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_KEY");
  return JSON.parse(raw);
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const sig = signer.sign(sa.private_key, "base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${sig}` }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).access_token;
}

async function fetchSheetTitles(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets(properties(title))`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Failed to list tabs: ${resp.status}`);
  return (await resp.json()).sheets.map((s) => s.properties?.title).filter(Boolean);
}

async function fetchSheetRows(token, title) {
  const range = `'${title}'!A:Z`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Failed to fetch ${title}: ${resp.status}`);
  return (await resp.json()).values || [];
}

// ── Date math (ported from services/storage.ts) ──

function calcStorageDays(createdAt, pickupAt) {
  const toJST = (s) => new Date(new Date(s).getTime() + 9 * 60 * 60 * 1000);
  const c = toJST(createdAt);
  const p = toJST(pickupAt);
  const cd = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate());
  const pd = Date.UTC(p.getUTCFullYear(), p.getUTCMonth(), p.getUTCDate());
  return Math.max(1, Math.floor((pd - cd) / 86400000) + 1);
}

// ── Parse & Build ──

function parseOrderRows(rows) {
  if (rows.length < 2) return [];

  const orders = [];
  const dateCounters = new Map(); // businessDate -> last seq

  for (const row of rows.slice(1)) {
    const createdAt = parseJSTDate(row[COL.created_at]);
    const name = `${row[COL.name] ?? ""}`.trim();
    const people = parseInt0(row[COL.people]);
    const rate = parseInt0(`${row[COL.rate] ?? ""}`.replace(/[^\d]/g, ""));
    const phone = `${row[COL.phone] ?? ""}`.trim();
    const email = `${row[COL.email] ?? ""}`.trim() || null;
    const note = `${row[COL.note] ?? ""}`.trim() || null;
    const actualPickupAt = parseJSTDate(row[COL.actual_pickup_at]);

    // Build expected_pickup_at from created_at date + time-only col 5
    const expectedTimeRaw = `${row[COL.expected_pickup_time] ?? ""}`.trim();
    let expectedPickupAt = null;
    if (createdAt && /^\d{1,2}:\d{2}/.test(expectedTimeRaw)) {
      // Combine created_at's date with the pickup time
      const createdDate = createdAt.slice(0, 10); // "2026-01-03"
      expectedPickupAt = parseJSTDate(`${createdDate} ${expectedTimeRaw}`);
    }

    // Skip junk rows: no name AND no people AND no rate
    if (!name && people === 0 && rate === 0) continue;
    // Skip rows with no date
    if (!createdAt) continue;

    const businessDate = businessDateFromISO(createdAt);
    if (!businessDate) continue;

    // Generate sequential order_id per business date
    const seq = (dateCounters.get(businessDate) || 0) + 1;
    dateCounters.set(businessDate, seq);
    const orderId = `${businessDate}-${String(seq).padStart(3, "0")}`;
    const tagNo = seq;

    // Treat "People" as suitcase count (most common case)
    const suitcaseQty = people || 1;
    const backpackQty = 0;
    const setQty = 0;

    // Rate from sheet = actual amount charged (import as-is)
    const prepaidAmount = rate;
    const finalAmount = rate;
    const pricePerDay = people > 0 ? Math.round(rate / Math.max(1, people)) : rate;

    const expectedStorageDays = (expectedPickupAt && createdAt)
      ? calcStorageDays(createdAt, expectedPickupAt)
      : 1;
    const actualStorageDays = (actualPickupAt && createdAt)
      ? calcStorageDays(createdAt, actualPickupAt)
      : 0;

    const status = actualPickupAt ? "PICKED_UP" : "PAID";

    orders.push({
      orderId, tagNo, name, phone, email,
      suitcaseQty, backpackQty, setQty,
      createdAt, expectedPickupAt, actualPickupAt,
      expectedStorageDays, actualStorageDays,
      pricePerDay, discountRate: 0,
      prepaidAmount, finalAmount,
      flyingPassTier: "NONE", passDiscount: 0,
      paymentMethod: "CASH", status, note,
    });
  }

  return orders;
}

function buildSql(orders) {
  const stmts = [];

  for (const o of orders) {
    stmts.push(
      `INSERT OR IGNORE INTO luggage_orders (
        order_id, tag_no, name, phone, email,
        suitcase_qty, backpack_qty, set_qty,
        created_at, expected_pickup_at, actual_pickup_at,
        expected_storage_days, actual_storage_days,
        price_per_day, discount_rate,
        prepaid_amount, final_amount,
        flying_pass_tier, flying_pass_discount_amount,
        payment_method, status, note,
        manual_entry, in_warehouse
      ) VALUES (
        ${sqlString(o.orderId)}, ${o.tagNo}, ${sqlString(o.name)}, ${sqlString(o.phone)}, ${sqlString(o.email)},
        ${o.suitcaseQty}, ${o.backpackQty}, ${o.setQty},
        ${sqlString(o.createdAt)}, ${sqlString(o.expectedPickupAt)}, ${sqlString(o.actualPickupAt)},
        ${o.expectedStorageDays}, ${o.actualStorageDays},
        ${o.pricePerDay}, ${o.discountRate},
        ${o.prepaidAmount}, ${o.finalAmount},
        ${sqlString(o.flyingPassTier)}, ${o.passDiscount},
        ${sqlString(o.paymentMethod)}, ${sqlString(o.status)}, ${sqlString(o.note)},
        1, 0
      );`
    );
  }

  // Update daily counters to reflect backfilled orders
  const dateCounters = new Map();
  for (const o of orders) {
    const bd = o.orderId.split("-")[0];
    const seq = parseInt(o.orderId.split("-")[1], 10);
    dateCounters.set(bd, Math.max(dateCounters.get(bd) || 0, seq));
  }
  for (const [bd, maxSeq] of dateCounters) {
    stmts.push(
      `INSERT INTO luggage_daily_counters (business_date, last_seq) VALUES ('${bd}', ${maxSeq})
       ON CONFLICT(business_date) DO UPDATE SET last_seq = MAX(last_seq, ${maxSeq});`
    );
  }

  return stmts.join("\n") + "\n";
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const showHeaders = args.includes("--headers");
  const apply = args.includes("--apply");
  const useLocal = args.includes("--local");

  const sa = getServiceAccount();
  const token = await getAccessToken(sa);

  // Find the Luggage tab
  const titles = await fetchSheetTitles(token);
  const luggageTab = titles.find((t) => /luggage/i.test(t));
  if (!luggageTab) {
    console.error("Available tabs:", titles.join(", "));
    throw new Error("No 'Luggage' tab found. Update the tab name match.");
  }
  console.error(`Using tab: "${luggageTab}"`);

  const rows = await fetchSheetRows(token, luggageTab);
  console.error(`Fetched ${rows.length} rows (including header).`);

  if (showHeaders) {
    console.log("Headers:", JSON.stringify(rows[0]));
    console.log("\nFirst 3 data rows:");
    for (const row of rows.slice(1, 4)) {
      console.log(JSON.stringify(row));
    }
    console.log("\nUpdate COL mapping in this script if columns don't match.");
    return;
  }

  const orders = parseOrderRows(rows);
  console.error(`Parsed ${orders.length} orders from ${orders[0]?.orderId} to ${orders.at(-1)?.orderId}`);
  console.error(`Status breakdown: PICKED_UP=${orders.filter((o) => o.status === "PICKED_UP").length}, PAID=${orders.filter((o) => o.status === "PAID").length}`);

  const sql = buildSql(orders);

  if (!apply) {
    process.stdout.write(sql);
    console.error("\nDry run complete. Use --apply to execute against D1.");
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "order-backfill-"));
  const sqlPath = join(tempDir, "backfill.sql");
  writeFileSync(sqlPath, sql);

  try {
    execFileSync("npx", [
      "wrangler", "d1", "execute", DB_NAME,
      ...(useLocal ? [] : ["--remote"]),
      "--file", sqlPath,
    ], { stdio: "inherit" });
    console.error("Backfill complete.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
