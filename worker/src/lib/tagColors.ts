/** Tag number → color class mapping. Single source of truth for server + client. */
export const TAG_COLOR_RANGES: [number, number, string][] = [
  [1, 10, "tag-color-orange"],
  [11, 20, "tag-color-blue"],
  [21, 30, "tag-color-yellow"],
  [31, 40, "tag-color-green"],
  [41, 50, "tag-color-purple"],
  [51, 60, "tag-color-black"],
  [61, 70, "tag-color-gray"],
  [71, 80, "tag-color-pink"],
  [81, 90, "tag-color-brown"],
  [91, 100, "tag-color-skyblue"],
  [101, 110, "tag-pattern-orange-vertical"],
  [111, 120, "tag-pattern-blue-vertical"],
  [121, 130, "tag-pattern-yellow-vertical"],
  [131, 140, "tag-pattern-green-vertical"],
  [141, 145, "tag-pattern-purple-vertical"],
  [146, 150, "tag-pattern-red-horizontal"],
];

/** Map tag_no to one dedicated solid-color or stripe-pattern class. */
export function tagColorClass(tagNo: string | null): string {
  if (!tagNo) return "";
  const num = parseInt(String(tagNo).replace(/^[A-Za-z]+/, ""), 10);
  if (!Number.isFinite(num) || num < 1) return "";
  for (const [min, max, cls] of TAG_COLOR_RANGES) {
    if (num >= min && num <= max) return cls;
  }
  return "";
}
