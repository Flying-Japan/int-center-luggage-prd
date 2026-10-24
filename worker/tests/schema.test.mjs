import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("fresh schema includes a nullable TEXT view_token on luggage_orders", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8"));
    const columns = sqlite.prepare("PRAGMA table_info(luggage_orders)").all();
    const viewToken = columns.find(column => column.name === "view_token");

    assert.ok(viewToken, "schema.sql must create luggage_orders.view_token without migrations");
    assert.equal(viewToken.type, "TEXT");
    assert.equal(viewToken.notnull, 0);
  } finally {
    sqlite.close();
  }
});
