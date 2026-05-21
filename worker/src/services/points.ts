export type PointUsageInput = {
  requestedPoints: number;
  balancePoints: number;
  payableAmount: number;
  minimumUnit?: number;
};

export type PointUsageResult = {
  pointsToUse: number;
  amountAfterPoints: number;
};

export function calculatePointUsage(input: PointUsageInput): PointUsageResult {
  const minimumUnit = normalizeMinimumUnit(input.minimumUnit);
  const requested = normalizePositiveInteger(input.requestedPoints);
  const balance = normalizePositiveInteger(input.balancePoints);
  const payable = normalizePositiveInteger(input.payableAmount);
  const capped = Math.min(requested, balance, payable);
  const pointsToUse = capped === payable ? capped : Math.floor(capped / minimumUnit) * minimumUnit;

  return {
    pointsToUse,
    amountAfterPoints: Math.max(0, payable - pointsToUse),
  };
}

function normalizeMinimumUnit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return 100;
  return Math.max(1, Math.floor(value));
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}
