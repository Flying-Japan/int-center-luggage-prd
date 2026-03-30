/**
 * Storage day calculation and business hours validation.
 * Ported from Python: app/services/storage.py
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // UTC+9

/**
 * Convert a Date or ISO string to JST Date.
 */
export function toJST(dt: Date | string): Date {
  const d = typeof dt === "string" ? new Date(dt) : dt;
  return new Date(d.getTime() + JST_OFFSET_MS);
}

/**
 * Get current time in JST.
 */
export function nowJST(): Date {
  return toJST(new Date());
}

/**
 * Get today's business date string (YYYYMMDD) in JST.
 */
export function todayBusinessDate(): string {
  const jst = nowJST();
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * Format a Date as YYYY-MM-DD in JST.
 */
export function formatDateJST(dt: Date | string): string {
  const jst = toJST(dt);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Validate that a pickup time is within business hours (09:00-21:00 JST).
 */
export function validatePickupTimeWindow(
  pickupAt: Date | string,
  openHour = 9,
  closeHour = 21
): { valid: boolean; error?: string } {
  const jst = toJST(pickupAt);
  const hour = jst.getUTCHours();
  if (hour < openHour || hour >= closeHour) {
    return {
      valid: false,
      error: `영업시간 ${String(openHour).padStart(2, "0")}:00~${String(closeHour).padStart(2, "0")}:00 내에서 수령 가능합니다.`,
    };
  }
  return { valid: true };
}

/**
 * Calculate storage days between creation date and pickup date.
 * Both dates converted to JST, count includes the creation day.
 * Minimum is 1 day.
 */
export function calculateStorageDays(createdAt: Date | string, pickupAt: Date | string): number {
  const created = toJST(createdAt);
  const pickup = toJST(pickupAt);

  // Compare dates only (not time)
  const createdDate = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate()));
  const pickupDate = new Date(Date.UTC(pickup.getUTCFullYear(), pickup.getUTCMonth(), pickup.getUTCDate()));

  const diffMs = pickupDate.getTime() - createdDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Include the creation day: minimum 1 day
  return Math.max(1, diffDays + 1);
}

/**
 * Calculate extra days (actual pickup date - expected pickup date).
 */
export function calculateExtraDays(expectedPickupAt: Date | string, actualPickupAt: Date | string): number {
  const expected = toJST(expectedPickupAt);
  const actual = toJST(actualPickupAt);

  const expectedDate = new Date(Date.UTC(expected.getUTCFullYear(), expected.getUTCMonth(), expected.getUTCDate()));
  const actualDate = new Date(Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth(), actual.getUTCDate()));

  const diffMs = actualDate.getTime() - expectedDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return Math.max(0, diffDays);
}
