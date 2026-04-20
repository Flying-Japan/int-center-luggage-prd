import { describe, expect, it } from "vitest";
import {
  hasMissingFinalClose,
  shouldIncludeClosingInStats,
} from "./cashClosing";

describe("cash closing helpers", () => {
  it("flags dates that have a morning handover but no final close", () => {
    expect(hasMissingFinalClose({ finalCount: 0, morningCount: 1 })).toBe(true);
    expect(hasMissingFinalClose({ finalCount: null, morningCount: 2 })).toBe(true);
  });

  it("does not flag dates that already have a final close", () => {
    expect(hasMissingFinalClose({ finalCount: 1, morningCount: 1 })).toBe(false);
    expect(hasMissingFinalClose({ finalCount: 1, morningCount: 0 })).toBe(false);
  });

  it("only includes final closes in aggregate stats", () => {
    expect(shouldIncludeClosingInStats({ closingType: "FINAL_CLOSE" })).toBe(true);
    expect(shouldIncludeClosingInStats({ closingType: "MORNING_HANDOVER" })).toBe(false);
    expect(shouldIncludeClosingInStats({ closingType: null })).toBe(false);
  });
});
