import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/routes/customer.tsx", import.meta.url),
  "utf8"
);

const start = source.indexOf(
  '  formEl.addEventListener("submit", async function(event){'
);
const end = source.indexOf(
  '\n  });\n\n  refreshPreview();',
  start
);

assert.ok(start >= 0 && end > start, "actual submit handler");
const actual = source.slice(start, end + 5);

async function check(options = {}) {
  let handler;
  let submits = 0;
  let alerts = 0;
  let busy = false;

  const file = name => ({
    name,
    size: 1000,
    type: "image/jpeg"
  });

  const originals = [file("id-original"), file("bag-original")];
  const optimized = [file("id-opt"), file("bag-opt")];

  let failAssignment = !!options.failAssignment;

  function makeInput(name, original, index) {
    let files = [original];

    return {
      name,
      get files() { return files; },
      set files(next) {
        if (
          index === 1 &&
          failAssignment &&
          next[0] === optimized[1]
        ) {
          failAssignment = false;
          throw Error("assignment failed");
        }
        files = next;
      }
    };
  }

  const inputs = [
    makeInput("id_image", originals[0], 0),
    makeInput("luggage_image", originals[1], 1)
  ];

  const cache = new Map();

  const formEl = {
    addEventListener(type, fn) {
      if (type === "submit") handler = fn;
    },
    querySelectorAll() { return []; },
    submit() { submits++; }
  };

  const deps = {
    formEl,
    isSubmitting: false,
    getValidationMissing: () => [],
    validationAttempts: 0,
    syncPickupHiddenValue() {},
    syncBagQuantities: () => true,
    syncCompanionCount: () => true,
    maybeWarnLatePickup() {},
    setSubmitBusy(value) { busy = value; },
    setUploadStatus() {},
    clearUploadStatus() {},
    messages: {
      uploadOptimizing: "",
      uploadSubmitting: "",
      uploadError: "Upload failed"
    },
    idImageInputEl: inputs[0],
    luggageImageInputEl: inputs[1],
    optimizedFilesByField: cache,
    optimizeInputIfNeeded: async input => {
      if (options.missing && input.name === "luggage_image") {
        return null;
      }
      const index = input.name === "id_image" ? 0 : 1;
      const prepared = options.originalOnly
        ? originals[index]
        : optimized[index];
      cache.set(input.name, prepared);
      return prepared;
    },
    document: {
      getElementById: () => ({ getAttribute: () => "" })
    },
    window: { alert() { alerts++; } },
    showValidationBanner() {},
    suitcaseSelectEl: {},
    suitcaseEl: {},
    backpackSelectEl: {},
    backpackEl: {},
    suitcaseCustomEl: {},
    backpackCustomEl: {},
    companionCustomEl: {}
  };

  class Transfer {
    constructor() {
      const files = [];
      this.items = { add(f) { files.push(f); } };
      this.files = files;
    }
  }

  new Function(
    ...Object.keys(deps),
    "DataTransfer",
    actual
  )(
    ...Object.values(deps),
    options.noTransfer ? undefined : Transfer
  );

  await handler({ preventDefault() {} });

  return {
    submits,
    alerts,
    busy,
    names: inputs.map(i => i.files[0]?.name)
  };
}

test("optimized images are submitted", async () => {
  const r = await check();
  assert.equal(r.submits, 1);
  assert.equal(r.alerts, 0);
  assert.deepEqual(r.names, ["id-opt", "bag-opt"]);
});

test("original files work without DataTransfer", async () => {
  const r = await check({
    originalOnly: true,
    noTransfer: true
  });
  assert.equal(r.submits, 1);
  assert.equal(r.alerts, 0);
});

test("optimized files require DataTransfer", async () => {
  const r = await check({ noTransfer: true });
  assert.equal(r.submits, 0);
  assert.equal(r.alerts, 1);
  assert.equal(r.busy, false);
});

test("missing prepared image blocks submission", async () => {
  const r = await check({ missing: true });
  assert.equal(r.submits, 0);
  assert.equal(r.alerts, 1);
});

test("failed assignment restores original files", async () => {
  const r = await check({ failAssignment: true });
  assert.equal(r.submits, 0);
  assert.equal(r.alerts, 1);
  assert.deepEqual(
    r.names,
    ["id-original", "bag-original"]
  );
});
