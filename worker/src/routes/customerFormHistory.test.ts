import { describe, expect, it } from "vitest";
import customerSource from "./customer.tsx?raw";

describe("customer previous-history form script", () => {
  it("preserves zero companion count when applying a previous-history preset", () => {
    expect(customerSource).toContain('Object.prototype.hasOwnProperty.call(payload, "companion_count")');
    expect(customerSource).toContain("var comp = hasCompanionCount ? Number(payload.companion_count) : 1;");
    expect(customerSource).not.toContain("Number(payload.companion_count||1) || 1");
  });

  it("offers zero as a preset companion option while keeping one as the default", () => {
    expect(customerSource).toContain("Array.from({ length: 11 }, (_, i) => i)");
    expect(customerSource).toContain("selected={n === 1}");
  });
});
