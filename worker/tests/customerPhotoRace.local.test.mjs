import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const source = readFileSync(new URL("../src/routes/customer.tsx", import.meta.url), "utf8");
const begin = source.indexOf("  function optimizeInputIfNeeded(");
const finish = source.indexOf("  function initFilePickers()", begin);
assert.ok(begin >= 0 && finish > begin, "actual function boundaries");
const actual = source.slice(begin, finish);

function setup(impl = async f => ({ ...f, name: f.name + "-optimized" })) {
  const cached = new Map();
  const pending = new Map();
  let count = 0;
  const optimize = async f => { count++; return impl(f); };
  const runner = new Function("optimizedFilesByField", "imagePreparationsByField", "messages", "shouldOptimizeImage", "optimizeImageFile", "formatFileSize", actual + "\nreturn optimizeInputIfNeeded;")(
    cached, pending, { fileOptimized: "optimized" }, () => true, optimize, () => "100KB"
  );
  const makeFile = (name, ms = 0, fail = false) => ({ name, size: 1200, delayMs: ms,
    slice: () => ({ arrayBuffer: async () => { if (fail) throw new Error("unreadable"); return new ArrayBuffer(1); } }),
    arrayBuffer: async () => new ArrayBuffer(1),
  });
  return { runner, cached, pending, makeFile, getCount: () => count };
}

test("latest photo wins even if previous optimization finishes later", async () => {
  const s = setup(async file => { await delay(file.delayMs); return file; });
  const input = { name: "id_image", files: [s.makeFile("A", 70)] };
  const label = { textContent: "" };
  const a = s.runner(input, label, "");
  await delay(5);
  input.files = [s.makeFile("B", 10)];
  const b = s.runner(input, label, "");
  await Promise.all([a,b]);
  assert.equal(s.cached.get("id_image").name, "B");
  assert.equal(label.textContent, "B");
});

test("same selection reuses in-flight and completed work", async () => {
  const s = setup();
  const input = { name: "id_image", files: [s.makeFile("A")] };
  const label = { textContent: "" };
  await Promise.all([s.runner(input,label,""),s.runner(input,label,"")]);
  await s.runner(input,label,"");
  assert.equal(s.getCount(), 1);
});

test("unreadable file fails instead of entering upload cache", async () => {
  const s = setup(async f => f);
  const input = { name: "id_image", files: [s.makeFile("bad",0,true)] };
  await assert.rejects(s.runner(input,{textContent:""},""), /unreadable/);
  assert.equal(s.cached.has("id_image"),false);
});

test("clearing selection removes prepared file", async () => {
  const s = setup(async f => f);
  const input = { name: "id_image", files: [s.makeFile("A")] };
  const label = { textContent: "" };
  await s.runner(input,label,"");
  input.files = [];
  await s.runner(input,label,"No photo");
  assert.equal(s.cached.has("id_image"),false);
  assert.equal(label.textContent,"No photo");
});
