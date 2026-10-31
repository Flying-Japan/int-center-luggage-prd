/** Allocation ranges. Existing order tags and physical tag colours are preserved. */
export const SAME_DAY_TAG_MAX = 140;
export const OVERNIGHT_TAG_MIN = 141;
export const LUGGAGE_TAG_MAX = 150;

// Only module constants are interpolated into SQL, never request input.
export const OVERNIGHT_TAG_VALUES_SQL = Array.from(
  { length: LUGGAGE_TAG_MAX - OVERNIGHT_TAG_MIN + 1 },
  (_, index) => `(${OVERNIGHT_TAG_MIN + index})`,
).join(", ");
