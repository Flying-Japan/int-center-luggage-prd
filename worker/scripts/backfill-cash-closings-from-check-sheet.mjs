#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";
const CHECK_RANGE = "'Check'!A:S";
const CLOSING_TYPE = "MORNING_HANDOVER";
const DB_NAME = "center-luggage-db";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("Set GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_KEY before running this script.");
  }
  return JSON.parse(raw);
}

function parseCount(raw) {
  const digits = `${raw ?? ""}`.replace(/[^\d-]/g, "");
  const count = Number.parseInt(digits, 10);
  return Number.isFinite(count) ? count : 0;
}

function parseYen(raw) {
  const text = `${raw ?? ""}`.trim();
  if (!text || text === "-" || text === "¥ -" || text === "¥ -   ") {
    return 0;
  }
  const negative = text.includes("(") || /^-/.test(text);
  const digits = text.replace(/[^\d]/g, "");
  if (!digits) {
    return 0;
  }
  const value = Number.parseInt(digits, 10);
  return negative ? -value : value;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const resp = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Google token exchange failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  return data.access_token;
}

async function fetchRows(token) {
  const encodedRange = encodeURIComponent(CHECK_RANGE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodedRange}?valueRenderOption=FORMATTED_VALUE`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    throw new Error(`Google Sheets API error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  return data.values || [];
}

function parseSheetRows(rows) {
  const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const parsed = [];

  for (const row of rows.slice(1)) {
    const businessDate = `${row[0] ?? ""}`.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || businessDate >= todayJst) {
      continue;
    }

    const counts = [
      parseCount(row[1]),
      parseCount(row[2]),
      parseCount(row[3]),
      parseCount(row[4]),
      parseCount(row[5]),
      parseCount(row[6]),
      parseCount(row[7]),
      parseCount(row[8]),
      parseCount(row[9]),
      parseCount(row[10]),
    ];

    const totalAmount = parseYen(row[11]);
    const paypayAmount = parseYen(row[12]);
    const checkAutoAmount = parseYen(row[13]);
    const differenceAmount = parseYen(row[14]);
    const ownerName = `${row[15] ?? ""}`.trim() || null;
    const note = `${row[16] ?? ""}`.trim() || null;
    const rentalCash = parseYen(row[17]);
    const wandRefund = parseYen(row[18]);

    const hasMoney = totalAmount !== 0 || paypayAmount !== 0 || checkAutoAmount !== 0 || rentalCash !== 0 || wandRefund !== 0;
    const hasText = ownerName !== null || note !== null;
    if (!hasMoney && !hasText) {
      continue;
    }

    parsed.push({
      businessDate,
      counts,
      totalAmount,
      paypayAmount,
      actualQrAmount: paypayAmount,
      checkAutoAmount,
      expectedAmount: checkAutoAmount,
      actualAmount: totalAmount + paypayAmount,
      differenceAmount,
      qrDifferenceAmount: 0,
      rentalCash,
      wandRefund,
      ownerName,
      note,
    });
  }

  return parsed;
}

function buildSql(rows) {
  const statements = [];

  for (const row of rows) {
    const [
      count10000,
      count5000,
      count2000,
      count1000,
      count500,
      count100,
      count50,
      count10,
      count5,
      count1,
    ] = row.counts;

    statements.push(
      `INSERT INTO luggage_cash_closings (
        business_date, closing_type, workflow_status,
        count_10000, count_5000, count_2000, count_1000, count_500,
        count_100, count_50, count_10, count_5, count_1,
        total_amount, paypay_amount, actual_qr_amount, qr_difference_amount,
        check_auto_amount, expected_amount, actual_amount, difference_amount,
        owner_name, note, rental_cash, wand_refund, staff_id, updated_at
      ) VALUES (
        ${sqlString(row.businessDate)}, ${sqlString(CLOSING_TYPE)}, 'SUBMITTED',
        ${count10000}, ${count5000}, ${count2000}, ${count1000}, ${count500},
        ${count100}, ${count50}, ${count10}, ${count5}, ${count1},
        ${row.totalAmount}, ${row.paypayAmount}, ${row.actualQrAmount}, ${row.qrDifferenceAmount},
        ${row.checkAutoAmount}, ${row.expectedAmount}, ${row.actualAmount}, ${row.differenceAmount},
        ${sqlString(row.ownerName)}, ${sqlString(row.note)}, ${row.rentalCash}, ${row.wandRefund}, NULL, datetime('now')
      )
      ON CONFLICT(business_date, closing_type) DO UPDATE SET
        workflow_status = excluded.workflow_status,
        count_10000 = excluded.count_10000,
        count_5000 = excluded.count_5000,
        count_2000 = excluded.count_2000,
        count_1000 = excluded.count_1000,
        count_500 = excluded.count_500,
        count_100 = excluded.count_100,
        count_50 = excluded.count_50,
        count_10 = excluded.count_10,
        count_5 = excluded.count_5,
        count_1 = excluded.count_1,
        total_amount = excluded.total_amount,
        paypay_amount = excluded.paypay_amount,
        actual_qr_amount = excluded.actual_qr_amount,
        qr_difference_amount = excluded.qr_difference_amount,
        check_auto_amount = excluded.check_auto_amount,
        expected_amount = excluded.expected_amount,
        actual_amount = excluded.actual_amount,
        difference_amount = excluded.difference_amount,
        owner_name = excluded.owner_name,
        note = excluded.note,
        rental_cash = excluded.rental_cash,
        wand_refund = excluded.wand_refund,
        staff_id = COALESCE(excluded.staff_id, luggage_cash_closings.staff_id),
        updated_at = datetime('now');`
    );
  }
  return `${statements.join("\n")}\n`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const useLocal = process.argv.includes("--local");
  const serviceAccount = getServiceAccount();
  const token = await getAccessToken(serviceAccount);
  const rows = parseSheetRows(await fetchRows(token));

  if (rows.length === 0) {
    console.log("No historical cash closing rows found in the Check sheet.");
    return;
  }

  const sql = buildSql(rows);
  console.error(`Prepared ${rows.length} ${CLOSING_TYPE} rows from ${rows[0].businessDate} to ${rows.at(-1).businessDate}.`);

  if (!apply) {
    process.stdout.write(sql);
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "cash-closing-backfill-"));
  const sqlPath = join(tempDir, "backfill.sql");
  writeFileSync(sqlPath, sql);

  try {
    const args = [
      "wrangler",
      "d1",
      "execute",
      DB_NAME,
      ...(useLocal ? [] : ["--remote"]),
      "--file",
      sqlPath,
    ];
    execFileSync("npx", args, { stdio: "inherit" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
