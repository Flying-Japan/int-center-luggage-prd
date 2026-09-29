/**
 * Today's JPY→KRW rate for on-demand reference conversion only.
 * Same provider the center dashboard and integrated admin use. Never stored or used in totals.
 */

const RATE_URL = "https://api.exchangerate-api.com/v4/latest/JPY";

export interface TodayJpyRate {
  krwPerJpy: number;
  rateDate: string | null;
}

export function parseJpyRateResponse(body: unknown): TodayJpyRate | null {
  if (typeof body !== "object" || body === null) return null;
  const { rates, date } = body as { rates?: Record<string, unknown>; date?: unknown };
  const krw = rates?.KRW;
  if (typeof krw !== "number" || !Number.isFinite(krw) || krw <= 0) return null;
  return { krwPerJpy: krw, rateDate: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null };
}

export async function fetchTodayJpyRate(): Promise<TodayJpyRate | null> {
  const resp = await fetch(RATE_URL, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!resp.ok) return null;
  return parseJpyRateResponse(await resp.json());
}
