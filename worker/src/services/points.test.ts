import { describe, expect, it } from "vitest";
import { calculatePointUsage } from "./points";

describe("calculatePointUsage", () => {
  it("caps point usage by request, balance, and payable amount", () => {
    expect(calculatePointUsage({
      requestedPoints: 2000,
      balancePoints: 800,
      payableAmount: 1200,
    })).toEqual({ pointsToUse: 800, amountAfterPoints: 400 });
  });

  it("rounds partial use down to the minimum unit", () => {
    expect(calculatePointUsage({
      requestedPoints: 850,
      balancePoints: 2000,
      payableAmount: 1200,
      minimumUnit: 100,
    })).toEqual({ pointsToUse: 800, amountAfterPoints: 400 });
  });

  it("allows exact full payment even when it is not a minimum-unit multiple", () => {
    expect(calculatePointUsage({
      requestedPoints: 950,
      balancePoints: 950,
      payableAmount: 950,
      minimumUnit: 100,
    })).toEqual({ pointsToUse: 950, amountAfterPoints: 0 });
  });

  it("normalizes invalid values to zero", () => {
    expect(calculatePointUsage({
      requestedPoints: -1,
      balancePoints: 1000,
      payableAmount: 1200,
    })).toEqual({ pointsToUse: 0, amountAfterPoints: 1200 });
  });
});
