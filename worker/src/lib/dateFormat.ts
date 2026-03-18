/** Shared JST date formatting helpers. */

const JST_FULL: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
};

const JST_SHORT: Intl.DateTimeFormatOptions = {
  month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo",
};

/** Format ISO string to full JST display (YYYY/MM/DD HH:MM JST). */
export function fmtJST(iso: string | null, fmt: Intl.DateTimeFormatOptions = JST_FULL): string {
  return iso ? new Date(iso).toLocaleString("ja-JP", fmt) + " JST" : "-";
}

/** Format ISO string to short JST display (MM/DD HH:MM). */
export function fmtJSTShort(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("ja-JP", JST_SHORT) : "-";
}
