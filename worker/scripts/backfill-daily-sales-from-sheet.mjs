#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPREADSHEET_ID = "10mn-Eg0YMk6tKOYfebtjP-mWMGQiaKhmNpLLA04YhoA";
const DB_NAME = "center-luggage-db";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseYen(raw) {
  const text = `${raw ?? ""}`.trim();
  if (!text || text === "-" || text === "¥ -" || text === "¥ -   ") {
    return 0;
  }
  const digits = text.replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : 0;
}

function parseDate(raw) {
  const match = `${raw ?? ""}`.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error("Set GOOGLE_SHEETS_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_KEY before running this script.");
  }
  return JSON.parse(raw);
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

  return (await resp.json()).access_token;
}

async function fetchSheetTitles(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets(properties(title))`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`Failed to list sheet tabs: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return (data.sheets || []).map((sheet) => sheet.properties?.title).filter((title) => typeof title === "string");
}

async function fetchSheetRows(token, title) {
  const range = `'${title}'!A:K`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${title}: ${resp.status} ${await resp.text()}`);
  }
  return (await resp.json()).values || [];
}

function parseDailyRows(rows) {
  const parsed = [];
  for (const row of rows.slice(2)) {
    const saleDate = parseDate(row[0]);
    if (!saleDate) {
      continue;
    }
    const people = Number.parseInt(`${row[1] ?? ""}`.replace(/[^\d]/g, ""), 10) || 0;
    const cash = parseYen(row[2]);
    const qr = parseYen(row[3]);
    const luggageTotal = cash + qr;
    const rentalTotal = parseYen(row[10]);
    if (people === 0 && luggageTotal === 0 && rentalTotal === 0) {
      continue;
    }
    parsed.push({ saleDate, people, cash, qr, luggageTotal, rentalTotal });
  }
  return parsed;
}

function buildSql(rows) {
  return `${rows.map((row) => (
    `INSERT OR REPLACE INTO luggage_daily_sales (sale_date, people, cash, qr, luggage_total, rental_total)
     VALUES (${sqlString(row.saleDate)}, ${row.people}, ${row.cash}, ${row.qr}, ${row.luggageTotal}, ${row.rentalTotal});`
  )).join("\n")}\n`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const useLocal = process.argv.includes("--local");
  const token = await getAccessToken(getServiceAccount());
  const titles = await fetchSheetTitles(token);
  const dailyTitles = titles.filter((title) => title.startsWith("Daily"));
  const allRows = [];

  for (const title of dailyTitles) {
    const rows = parseDailyRows(await fetchSheetRows(token, title));
    allRows.push(...rows);
  }

  allRows.sort((a, b) => a.saleDate.localeCompare(b.saleDate));
  console.error(`Prepared ${allRows.length} daily sales rows from ${allRows[0]?.saleDate} to ${allRows.at(-1)?.saleDate}.`);
  const sql = buildSql(allRows);

  if (!apply) {
    process.stdout.write(sql);
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "daily-sales-backfill-"));
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
