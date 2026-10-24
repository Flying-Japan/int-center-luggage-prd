import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("customer photo Blob URLs are allowed by CSP", () => {
  const security = readFileSync(
    new URL("../src/middleware/security.ts", import.meta.url),
    "utf8"
  );

  const customer = readFileSync(
    new URL("../src/routes/customer.tsx", import.meta.url),
    "utf8"
  );

  const match = security.match(/img-src\s+([^;]+);/);
  assert.ok(match, "img-src directive must exist");

  const sources = match[1].trim().split(/\s+/);

  assert.ok(
    sources.includes("blob:"),
    "img-src must allow blob: for customer photo optimization"
  );

  assert.match(
    customer,
    /URL\.createObjectURL\(file\)/,
    "customer optimizer uses Blob URLs"
  );
});
