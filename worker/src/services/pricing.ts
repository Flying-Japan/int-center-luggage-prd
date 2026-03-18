/**
 * Pricing engine for luggage storage.
 * Ported from Python: app/services/pricing.py + app/services/flying_pass.py
 */

// Base daily rates (JPY)
export const SUITCASE_DAILY_RATE = 800;
export const BACKPACK_DAILY_RATE = 500;
export const SET_DAILY_RATE = 1200; // 1 suitcase + 1 backpack as a set

// Long-stay discount tiers
const DISCOUNT_TIERS: [number, number][] = [
  [60, 0.2], // 60+ days: 20%
  [30, 0.15], // 30-59 days: 15%
  [14, 0.1], // 14-29 days: 10%
  [7, 0.05], // 7-13 days: 5%
];

// Flying Pass fixed discount amounts (JPY per day)
export const FLYING_PASS_TIERS = ["NONE", "BLUE", "SILVER", "GOLD", "PLATINUM", "BLACK"] as const;
export type FlyingPassTier = (typeof FLYING_PASS_TIERS)[number];

const FLYING_PASS_FIXED_DISCOUNTS: Record<FlyingPassTier, number> = {
  NONE: 0,
  BLUE: 100,
  SILVER: 200,
  GOLD: 300,
  PLATINUM: 400,
  BLACK: 0, // BLACK = 100% free (handled separately)
};

export type PricingResult = {
  setQty: number;
  pricePerDay: number;
};

/**
 * Calculate price per day based on bag counts.
 * Sets are paired automatically: set_qty = min(suitcase, backpack)
 */
export function calculatePricePerDay(suitcaseQty: number, backpackQty: number): PricingResult {
  const setQty = Math.min(suitcaseQty, backpackQty);
  const remainingSuitcases = suitcaseQty - setQty;
  const remainingBackpacks = backpackQty - setQty;

  const pricePerDay =
    setQty * SET_DAILY_RATE +
    remainingSuitcases * SUITCASE_DAILY_RATE +
    remainingBackpacks * BACKPACK_DAILY_RATE;

  return { setQty, pricePerDay };
}

/**
 * Get discount rate for given storage days.
 */
export function discountRateForDays(storageDays: number): number {
  for (const [minDays, rate] of DISCOUNT_TIERS) {
    if (storageDays >= minDays) return rate;
  }
  return 0;
}

/**
 * Calculate prepaid amount with long-stay discount applied.
 */
export function calculatePrepaidAmount(
  pricePerDay: number,
  expectedStorageDays: number
): { discountRate: number; prepaidAmount: number } {
  const discountRate = discountRateForDays(expectedStorageDays);
  const baseAmount = pricePerDay * expectedStorageDays;
  const prepaidAmount = Math.round(baseAmount * (1 - discountRate));
  return { discountRate, prepaidAmount };
}

/**
 * Normalize a Flying Pass tier string to a valid tier.
 */
export function normalizeFlyingPassTier(raw: string | null | undefined, defaultTier: FlyingPassTier = "NONE"): FlyingPassTier {
  if (!raw) return defaultTier;
  const upper = raw.trim().toUpperCase();
  if (FLYING_PASS_TIERS.includes(upper as FlyingPassTier)) {
    return upper as FlyingPassTier;
  }
  return defaultTier;
}

/**
 * Calculate Flying Pass discount amount per day.
 * BLACK tier = 100% free (returns the full prepaid amount as discount).
 */
export function flyingPassDiscountAmount(basePrepaid: number, tier: FlyingPassTier): number {
  if (tier === "BLACK") return basePrepaid; // 100% free
  if (tier === "NONE") return 0;
  return FLYING_PASS_FIXED_DISCOUNTS[tier] || 0;
}

/**
 * Recalculate order prepaid amount with Flying Pass discount.
 */
export function recalculateOrderPrepaid(
  pricePerDay: number,
  expectedStorageDays: number,
  flyingPassTier: FlyingPassTier
): {
  discountRate: number;
  prepaidAmount: number;
  flyingPassDiscountAmount: number;
  finalPrepaid: number;
} {
  const { discountRate, prepaidAmount } = calculatePrepaidAmount(pricePerDay, expectedStorageDays);
  const passDiscount = flyingPassDiscountAmount(prepaidAmount, flyingPassTier);
  const finalPrepaid = Math.max(0, prepaidAmount - passDiscount);
  return { discountRate, prepaidAmount, flyingPassDiscountAmount: passDiscount, finalPrepaid };
}

/**
 * Calculate extra charge for days exceeding expected pickup.
 * Extra days are charged at full price (no discount).
 */
export function calculateExtraAmount(pricePerDay: number, extraDays: number): number {
  if (extraDays <= 0) return 0;
  return pricePerDay * extraDays;
}

