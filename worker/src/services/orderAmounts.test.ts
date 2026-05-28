import { describe, expect, it } from "vitest";
import adminSource from "../routes/admin.tsx?raw";
import operationsSource from "../routes/operations.tsx?raw";
import {
  calculateOrderCollectedAmount,
  orderCollectedAmountSql,
} from "./orderAmounts";

describe("order amount helpers", () => {
  it("falls back to prepaid amount for legacy rows with zero final amount", () => {
    expect(calculateOrderCollectedAmount({
      prepaidAmount: 1200,
      finalAmount: 0,
      extraAmount: 0,
    })).toBe(1200);
  });

  it("keeps explicit zero final amount for point usage", () => {
    expect(calculateOrderCollectedAmount({
      prepaidAmount: 1200,
      finalAmount: 0,
      pointsUsed: 1200,
    })).toBe(0);
  });

  it("keeps explicit zero final amount for full Flying Pass discount", () => {
    expect(calculateOrderCollectedAmount({
      prepaidAmount: 1200,
      finalAmount: 0,
      flyingPassDiscountAmount: 1200,
    })).toBe(0);
  });

  it("adds extension or extra charges to the selected base amount", () => {
    expect(calculateOrderCollectedAmount({
      prepaidAmount: 1200,
      finalAmount: 1000,
      extraAmount: 500,
    })).toBe(1500);
  });

  it("can qualify SQL columns with an alias", () => {
    const sql = orderCollectedAmountSql("o");
    expect(sql).toContain("o.final_amount");
    expect(sql).toContain("o.points_used");
    expect(sql).toContain("o.extra_amount");
  });

  it("can avoid point columns for routes that must deploy before the point migration", () => {
    const sql = orderCollectedAmountSql(undefined, { includePointColumns: false });
    expect(sql).not.toContain("points_used");
    expect(sql).not.toContain("point_discount_amount");
    expect(sql).toContain("flying_pass_discount_amount");
  });

  it("keeps live dashboard sales SQL on the shared collected amount helper", () => {
    const legacyExpression = "COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount";

    expect(adminSource).toContain('orderCollectedAmountSql("o")');
    expect(operationsSource).toContain('orderCollectedAmountSql("o")');
    expect(adminSource).not.toContain(legacyExpression);
    expect(operationsSource).not.toContain(legacyExpression);
  });
});
