export type OrderAmountInput = {
  prepaidAmount?: number | null;
  finalAmount?: number | null;
  extraAmount?: number | null;
  pointDiscountAmount?: number | null;
  pointsUsed?: number | null;
  flyingPassDiscountAmount?: number | null;
};

export type OrderCollectedAmountSqlOptions = {
  includePointColumns?: boolean;
};

const AMOUNT_COLUMNS = {
  prepaidAmount: "prepaid_amount",
  finalAmount: "final_amount",
  extraAmount: "extra_amount",
  pointDiscountAmount: "point_discount_amount",
  pointsUsed: "points_used",
  flyingPassDiscountAmount: "flying_pass_discount_amount",
} as const;

export function orderCollectedAmountSql(alias?: string, options: OrderCollectedAmountSqlOptions = {}): string {
  const includePointColumns = options.includePointColumns ?? true;
  const col = (name: keyof typeof AMOUNT_COLUMNS) => {
    const column = AMOUNT_COLUMNS[name];
    return alias ? `${alias}.${column}` : column;
  };

  const prepaidAmount = `COALESCE(${col("prepaidAmount")}, 0)`;
  const finalAmount = `COALESCE(${col("finalAmount")}, 0)`;
  const extraAmount = `COALESCE(${col("extraAmount")}, 0)`;
  const pointDiscountAmount = `COALESCE(${col("pointDiscountAmount")}, 0)`;
  const pointsUsed = `COALESCE(${col("pointsUsed")}, 0)`;
  const flyingPassDiscountAmount = `COALESCE(${col("flyingPassDiscountAmount")}, 0)`;
  const explicitZeroConditions = [
    ...(includePointColumns ? [`${pointDiscountAmount} > 0`, `${pointsUsed} > 0`] : []),
    `${flyingPassDiscountAmount} > 0`,
    `${prepaidAmount} = 0`,
  ];

  return `(CASE
    WHEN ${finalAmount} > 0 THEN ${finalAmount}
    WHEN ${explicitZeroConditions.join(" OR ")} THEN ${finalAmount}
    ELSE ${prepaidAmount}
  END + ${extraAmount})`;
}

export function calculateOrderCollectedAmount(input: OrderAmountInput): number {
  const prepaidAmount = numberOrZero(input.prepaidAmount);
  const finalAmount = numberOrZero(input.finalAmount);
  const extraAmount = numberOrZero(input.extraAmount);
  const hasExplicitZeroFinalAmount =
    numberOrZero(input.pointDiscountAmount) > 0 ||
    numberOrZero(input.pointsUsed) > 0 ||
    numberOrZero(input.flyingPassDiscountAmount) > 0 ||
    prepaidAmount === 0;

  const baseAmount = finalAmount > 0 || hasExplicitZeroFinalAmount
    ? finalAmount
    : prepaidAmount;

  return baseAmount + extraAmount;
}

function numberOrZero(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}
