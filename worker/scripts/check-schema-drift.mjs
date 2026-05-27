import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const schemaPath = resolve(projectRoot, "src/schema.sql");

const schema = await readFile(schemaPath, "utf8");

const requiredTables = [
  {
    table: "luggage_customer_profiles",
    reason: "Account customer profile lookup for signed luggage intake",
  },
  {
    table: "luggage_customer_point_accounts",
    reason: "customer point balance display and validation",
  },
  {
    table: "luggage_customer_point_transactions",
    reason: "point ledger reservation/earn/void history",
  },
];

const requiredColumns = [
  {
    table: "luggage_orders",
    column: "account_person_id",
    reason: "link signed Account customer to luggage orders",
  },
  {
    table: "luggage_orders",
    column: "gross_amount",
    reason: "preserve pre-discount order amount",
  },
  {
    table: "luggage_orders",
    column: "point_discount_amount",
    reason: "show applied point discount to staff and customer",
  },
  {
    table: "luggage_orders",
    column: "points_used",
    reason: "record point usage snapshot on order",
  },
  {
    table: "luggage_orders",
    column: "points_earned",
    reason: "record earned point snapshot on order",
  },
  {
    table: "luggage_orders",
    column: "point_usage_status",
    reason: "track point usage lifecycle",
  },
  {
    table: "luggage_orders",
    column: "source_preset_order_id",
    reason: "audit previous-history preset selection",
  },
  {
    table: "luggage_orders",
    column: "view_token",
    reason: "customer order completion page updates and validates view_token",
  },
];

const requiredIndexes = [
  "idx_luggage_orders_account_recent",
  "idx_luggage_orders_source_preset",
  "idx_luggage_customer_profiles_email",
  "idx_luggage_point_transactions_person_created",
  "idx_luggage_point_transactions_order",
];

function extractCreateTableBody(table) {
  const escaped = escapeRegExp(table);
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${escaped}\\s*\\(([\\s\\S]*?)\\);`, "i");
  return schema.match(pattern)?.[1] ?? null;
}

function hasTable(table) {
  return extractCreateTableBody(table) !== null;
}

function hasColumn(table, column) {
  const body = extractCreateTableBody(table);
  if (!body) return false;
  return new RegExp(`(^|\\n)\\s*${escapeRegExp(column)}\\b`, "i").test(body);
}

function hasIndex(indexName) {
  return new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${escapeRegExp(indexName)}\\b`, "i").test(schema);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const failures = [];

for (const { table, reason } of requiredTables) {
  if (!hasTable(table)) failures.push(`missing table ${table} (${reason})`);
}

for (const { table, column, reason } of requiredColumns) {
  if (!hasColumn(table, column)) failures.push(`missing column ${table}.${column} (${reason})`);
}

for (const indexName of requiredIndexes) {
  if (!hasIndex(indexName)) failures.push(`missing index ${indexName}`);
}

if (failures.length > 0) {
  console.error("Schema drift checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Schema drift checks passed for ${requiredTables.length} tables, ` +
    `${requiredColumns.length} columns, and ${requiredIndexes.length} indexes.`,
);
