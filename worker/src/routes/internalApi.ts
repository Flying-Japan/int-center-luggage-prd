import { Hono } from "hono";
import type { AppType } from "../types";
import { internalAuth } from "../middleware/internalAuth";
import {
  normalizePaymentAllocation,
  paymentAllocationStatements,
  payableAmountFromOrder,
} from "../lib/payments";
import { FLYING_PASS_TIERS, calculateExtraAmount, calculatePrepaidAmount, calculatePricePerDay, flyingPassDiscountAmount, normalizeFlyingPassTier, recalculateOrderPrepaid } from "../services/pricing";
import { buildOrderId, buildOvernightTag, buildSameDayTag } from "../services/orderNumber";
import { downloadImage } from "../lib/r2";
import { fetchStaffNamesByIds } from "../lib/staffProfiles";
import { createSupabaseAdmin } from "../lib/supabase";
import { CASH_CLOSING_STARTING_FLOAT, resolveAutoSalesSummariesByDate, type AutoSalesSummary } from "../services/cashClosingSales";
import { calculateExtraDays, calculateStorageDays, toJST, validatePickupTimeWindow } from "../services/storage";
import { getSalesHolidayFlags, JST_DOW_JP } from "../services/salesHolidays";
import { hmacSha256Hex } from "../lib/hmac";
import { loadCompletionMessages } from "../services/completionMessages";

const internalApi = new Hono<AppType>();
// Mounted via `app.route("/", internalApi)` in index.tsx, so a bare "/*" here
// would swallow every request on the worker. Scope the auth middleware to the
// prefix we actually own so /customer, /login, /admin, etc. stay untouched.
internalApi.use("/internal/*", internalAuth);

const EXPERIENCE_STATUSES = new Set(["SCHEDULED", "VISITED", "RECEIVED", "CANCELLED"]);
const EXPERIENCE_VISITOR_TYPES = new Set(["BLOGGER", "INFLUENCER", "YOUTUBER", "OTHER"]);
const EXPERIENCE_BENEFIT_TYPES = new Set(["GIFT_CARD", "CASH", "PRODUCT", "OTHER", "REVIEWER_EXPERIENCE"]);
const EXPERIENCE_VISIT_SORTS = new Set(["newest", "oldest"]);
const LUGGAGE_NOTE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin"]);
const LUGGAGE_IMAGE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin", "viewer"]);
const LUGGAGE_ORDER_ID_PATTERN = /^(?:EXT-)?\d{8}-\d{3,10}$/;
const LUGGAGE_HANDOVER_CATEGORIES = new Set(["HANDOVER", "NOTICE", "URGENT", "EXPERIENCE", "OTHER"]);
const LUGGAGE_HANDOVER_SORTS = new Set(["newest", "oldest", "pinned"]);
const LUGGAGE_LOST_FOUND_STATUSES = new Set(["UNCLAIMED", "CLAIMED", "DISPOSED", "RETURNED"]);
const LUGGAGE_LOST_FOUND_SORTS = new Set(["newest", "oldest"]);
const LUGGAGE_ACTIVITY_LOG_SORTS = new Set(["newest", "oldest"]);
const LUGGAGE_ACTIVITY_LOG_SOURCES = new Set(["staff", "unified-admin", "system"]);
const LUGGAGE_CUSTOMER_SORTS = new Set(["recent", "oldest", "visits_desc", "spent_desc"]);
const LUGGAGE_CUSTOMER_LIMITS = new Set([20, 50, 100]);
const LUGGAGE_AUDIT_ACTION_LABELS: Record<string, string> = {
  INLINE_UPDATE: "수정", TOGGLE_PAYMENT: "결제변경", PICKUP: "수령완료",
  UNDO_PICKUP: "수령취소", CANCEL: "취소", TOGGLE_WAREHOUSE: "창고",
  UPDATE_PRICE: "요금변경", MARK_PAID: "결제완료", MARK_PICKED_UP: "수령완료",
  UNDO_PICKED_UP: "수령취소", MANUAL_CREATE: "수기접수", UPDATE: "수정",
  VIEW_ID_IMAGE: "신분증조회", VIEW_LUGGAGE_IMAGE: "짐사진조회",
  VIEW_ID: "신분증조회", VIEW_LUGGAGE: "짐사진조회",
  CREATE_EXTENSION: "연장접수", BULK_CANCEL: "일괄취소", BULK_MARK_PAID: "일괄결제",
};

type LuggageWorkScheduleDto = {
  calendarEmbedUrl: string | null;
  configured: boolean;
};

type LuggageCompletionMessageSetDto = {
  ko: string;
  en: string;
  ja: string;
};

type LuggageCompletionMessagesDto = {
  primary: LuggageCompletionMessageSetDto;
  secondary: LuggageCompletionMessageSetDto;
};

type LuggageStaffAccountRole = "admin" | "editor" | "viewer";

type LuggageStaffAccountDto = {
  id: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
  role: LuggageStaffAccountRole;
  isActive: boolean;
  createdAt: string;
};

function normalizeGoogleCalendarEmbedUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const isEmbedPath = /^\/calendar\/embed\/?$/.test(url.pathname)
      || /^\/calendar\/u\/\d+\/embed\/?$/.test(url.pathname);
    return url.protocol === "https:" && url.hostname === "calendar.google.com" && isEmbedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// Stable response shape for callers. Prevents raw D1 columns from leaking
// into the contract — future schema additions stay internal unless we
// explicitly surface them here.
type ExperienceVisitDto = {
  externalId: string | null;
  visitorName: string | null;
  visitorType: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  benefitType: string | null;
  benefitLabel: string | null;
  benefitAmount: string | null;
  status: string | null;
  note: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  processedByStaffId: string | null;
  createdByStaffId: string | null;
  piiMaskedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function serializeVisit(row: Record<string, unknown> | null): ExperienceVisitDto | null {
  if (!row) return null;
  const str = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  return {
    benefitAmount: str(row.benefit_amount),
    benefitLabel: str(row.benefit_label),
    benefitType: str(row.benefit_type),
    createdAt: str(row.created_at),
    createdByStaffId: str(row.created_by_staff_id),
    externalId: str(row.external_id),
    note: str(row.note),
    piiMaskedAt: str(row.pii_masked_at),
    processedByStaffId: str(row.processed_by_staff_id),
    receivedAt: str(row.received_at),
    receivedBy: str(row.received_by),
    scheduledDate: str(row.scheduled_date),
    scheduledTime: str(row.scheduled_time),
    status: str(row.status),
    updatedAt: str(row.updated_at),
    visitorName: str(row.visitor_name),
    visitorType: str(row.visitor_type),
  };
}

type LuggageExperienceVisitDto = {
  visitId: number;
  visitorName: string | null;
  visitorType: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  benefitType: string | null;
  benefitLabel: string | null;
  benefitAmount: string | null;
  externalId: string | null;
  status: string | null;
  note: string | null;
  registeredByStaffId: string | null;
  registeredByStaffName: string;
  processedByStaffId: string | null;
  processedByStaffName: string;
  receivedBy: string | null;
  receivedAt: string | null;
  piiMaskedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type LuggageExperienceVisitRow = {
  visitId: number;
  visitorName: string | null;
  visitorType: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  benefitType: string | null;
  benefitLabel: string | null;
  benefitAmount: string | null;
  externalId: string | null;
  status: string | null;
  note: string | null;
  createdByStaffId: string | null;
  processedByStaffId: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  piiMaskedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type LuggageOrderDto = {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  suitcaseQty: number;
  backpackQty: number;
  setQty: number;
  expectedPickupAt: string | null;
  actualPickupAt: string | null;
  expectedStorageDays: number;
  actualStorageDays: number;
  extraDays: number;
  prepaidAmount: number;
  finalAmount: number | null;
  extraAmount: number;
  pricePerDay: number;
  paymentMethod: string | null;
  status: string;
  tagNo: string | null;
  note: string | null;
  manualEntry: number;
  parentOrderId: string | null;
  inWarehouse: number;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  staffPrepaidOverrideAmount: number | null;
  paymentCashAmount: number;
  paymentQrAmount: number;
  hasIdImage: boolean;
  hasLuggageImage: boolean;
  extensions: LuggageExtensionSummaryDto[];
};

type LuggageExtensionSummaryDto = {
  orderId: string;
  parentOrderId: string;
  status: string;
  createdAt: string;
  prepaidAmount: number;
  finalAmount: number | null;
  pricePerDay: number;
  paymentCashAmount: number;
  paymentQrAmount: number;
};

type LuggageStatusCounts = {
  paymentPending: number;
  paid: number;
  pickedUp: number;
  cancelled: number;
};

function parsePaginationQuery(value: string | undefined, fallback: number, maximum?: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function parseJstDateQuery(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value) ? value : null;
}

const SALES_ANALYTICS_MAX_DAYS = 365;
const SALES_STARTING_FLOAT = 40000;

function jstToday(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function resolveAnalyticsRange(startRaw: string | undefined, endRaw: string | undefined): { startDate: string; endDate: string } | null {
  if (!startRaw && !endRaw) {
    const endDate = jstToday();
    return { startDate: addCalendarDays(endDate, -29), endDate };
  }
  const startDate = parseJstDateQuery(startRaw);
  const endDate = parseJstDateQuery(endRaw);
  if (!startDate || !endDate || startDate > endDate) return null;
  const dayCount = Math.round((new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86400000);
  return dayCount <= SALES_ANALYTICS_MAX_DAYS ? { startDate, endDate } : null;
}

function emptyWeekHourGrid(): number[][] {
  return Array.from({ length: 7 }, () => Array(24).fill(0));
}

function emptyHourGrid(): number[][] {
  return Array.from({ length: 24 }, () => Array(24).fill(0));
}

function gridMax(grid: number[][]): number {
  return grid.reduce((maximum, row) => Math.max(maximum, ...row), 0);
}

function weekHourTotals(grid: number[][]) {
  return {
    byDay: grid.map((row) => row.reduce((total, value) => total + value, 0)),
    byHour: Array.from({ length: 24 }, (_, hour) => grid.reduce((total, row) => total + row[hour], 0)),
  };
}

// GET /internal/luggage-sales-analytics — read-only sales projection for the integrated admin.
internalApi.get("/internal/luggage-sales-analytics", async (c) => {
  c.header("Cache-Control", "no-store");
  const range = resolveAnalyticsRange(c.req.query("startDate"), c.req.query("endDate"));
  if (!range) return c.json({ status: "error", error: "invalid JST date range" }, 400);

  try {
    const [sheetRows, rentalRows, actualRows, closingRows] = await Promise.all([
      c.env.DB.prepare("SELECT sale_date, people, cash, qr, luggage_total FROM luggage_daily_sales WHERE sale_date BETWEEN ? AND ?")
        .bind(range.startDate, range.endDate).all<{ sale_date: string; people: number; cash: number; qr: number; luggage_total: number }>(),
      c.env.DB.prepare("SELECT business_date AS sale_date, revenue_amount AS rental_total FROM luggage_rental_daily_sales WHERE business_date BETWEEN ? AND ?")
        .bind(range.startDate, range.endDate).all<{ sale_date: string; rental_total: number }>(),
      c.env.DB.prepare(
        `WITH payment_allocations AS (
          SELECT order_id, SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash_amount,
                 SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr_amount, COUNT(*) AS payment_count
          FROM luggage_order_payments GROUP BY order_id
        )
        SELECT date(o.created_at, '+9 hours') AS sale_date, SUM(1 + o.companion_count) AS people,
               SUM(o.suitcase_qty) AS suitcase_total, SUM(o.backpack_qty) AS backpack_total,
               SUM(CASE WHEN COALESCE(pa.payment_count, 0) > 0 THEN pa.cash_amount WHEN o.payment_method = 'CASH' OR o.payment_method IS NULL THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) AS cash,
               SUM(CASE WHEN COALESCE(pa.payment_count, 0) > 0 THEN pa.qr_amount WHEN o.payment_method = 'PAY_QR' THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) AS qr
        FROM luggage_orders o LEFT JOIN payment_allocations pa ON pa.order_id = o.order_id
        WHERE o.status IN ('PAID', 'PICKED_UP') AND date(o.created_at, '+9 hours') BETWEEN ? AND ? GROUP BY sale_date`
      ).bind(range.startDate, range.endDate).all<{ sale_date: string; people: number; suitcase_total: number; backpack_total: number; cash: number; qr: number }>(),
      c.env.DB.prepare("SELECT business_date AS sale_date, total_amount, paypay_amount, actual_qr_amount FROM luggage_cash_closings WHERE closing_type = 'FINAL_CLOSE' AND business_date BETWEEN ? AND ?")
        .bind(range.startDate, range.endDate).all<{ sale_date: string; total_amount: number; paypay_amount: number; actual_qr_amount: number }>(),
    ]);

    const sheetByDate = new Map(sheetRows.results.map((row) => [row.sale_date, row]));
    const rentalByDate = new Map(rentalRows.results.map((row) => [row.sale_date, Number(row.rental_total) || 0]));
    const actualByDate = new Map(actualRows.results.map((row) => [row.sale_date, row]));
    const closingByDate = new Map(closingRows.results.map((row) => {
      const cash = Math.max(0, (Number(row.total_amount) || 0) - SALES_STARTING_FLOAT);
      const qr = Number(row.actual_qr_amount) || Number(row.paypay_amount) || 0;
      return [row.sale_date, { cash, qr, luggage: cash + qr }] as const;
    }));
    const today = jstToday();
    const dates = new Set([...sheetByDate.keys(), ...rentalByDate.keys(), ...actualByDate.keys(), ...closingByDate.keys()]);
    if (today >= range.startDate && today <= range.endDate) dates.add(today);
    const dailyRows = [...dates].sort((a, b) => b.localeCompare(a)).map((date) => {
      const actual = actualByDate.get(date);
      const sheet = sheetByDate.get(date);
      const closing = closingByDate.get(date);
      const settled = Boolean(closing) && date !== today;
      const cash = settled ? closing!.cash : actual ? Number(actual.cash) || 0 : Number(sheet?.cash) || 0;
      const qr = settled ? closing!.qr : actual ? Number(actual.qr) || 0 : Number(sheet?.qr) || 0;
      const luggage = settled ? closing!.luggage : cash + qr;
      const flags = getSalesHolidayFlags(date);
      return {
        date, weekdayJst: JST_DOW_JP[new Date(`${date}T12:00:00Z`).getUTCDay()], isWeekend: flags.isWeekend,
        japaneseHoliday: flags.jp, koreanHoliday: flags.kr, people: Math.max(Number(actual?.people) || 0, Number(sheet?.people) || 0),
        suitcases: Number(actual?.suitcase_total) || 0, backpacks: Number(actual?.backpack_total) || 0, cash, qr, luggage,
        rental: rentalByDate.get(date) ?? 0, combined: luggage + (rentalByDate.get(date) ?? 0), realtime: date === today,
        settled, luggageSource: settled ? "final_close" : actual ? "orders" : sheet ? "daily_sales_fallback" : "none",
      };
    });
    const todayRow = dailyRows.find((row) => row.date === today);
    const todayOrders = await c.env.DB.prepare(
      `WITH payment_allocations AS (SELECT order_id, SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END) AS cash_amount, SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END) AS qr_amount, COUNT(*) AS payment_count FROM luggage_order_payments GROUP BY order_id)
       SELECT COUNT(*) AS order_count, SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') THEN 1 ELSE 0 END) AS paid_count, SUM(CASE WHEN o.status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END) AS pending_count, SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') THEN 1 + o.companion_count ELSE 0 END) AS people,
              SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') AND COALESCE(pa.payment_count, 0) > 0 THEN pa.cash_amount WHEN o.status IN ('PAID','PICKED_UP') AND (o.payment_method = 'CASH' OR o.payment_method IS NULL) THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) AS cash,
              SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') AND COALESCE(pa.payment_count, 0) > 0 THEN pa.qr_amount WHEN o.status IN ('PAID','PICKED_UP') AND o.payment_method = 'PAY_QR' THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) AS qr,
              SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') THEN COALESCE(NULLIF(o.final_amount, 0), o.prepaid_amount) + o.extra_amount ELSE 0 END) AS luggage,
              SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') THEN o.suitcase_qty ELSE 0 END) AS suitcases, SUM(CASE WHEN o.status IN ('PAID','PICKED_UP') THEN o.backpack_qty ELSE 0 END) AS backpacks
       FROM luggage_orders o LEFT JOIN payment_allocations pa ON pa.order_id = o.order_id WHERE date(o.created_at, '+9 hours') = ?`
    ).bind(today).first<{ order_count: number; paid_count: number; pending_count: number; people: number; cash: number; qr: number; luggage: number; suitcases: number; backpacks: number }>();
    const rows = todayRow ? dailyRows.map((row) => row.date === today ? { ...row, people: Number(todayOrders?.people) || 0, suitcases: Number(todayOrders?.suitcases) || 0, backpacks: Number(todayOrders?.backpacks) || 0, cash: Number(todayOrders?.cash) || 0, qr: Number(todayOrders?.qr) || 0, luggage: Number(todayOrders?.luggage) || 0, combined: (Number(todayOrders?.luggage) || 0) + row.rental, realtime: true, settled: false, luggageSource: "orders" } : row) : dailyRows;
    const total = (key: "cash" | "qr" | "luggage" | "rental" | "combined" | "people" | "suitcases" | "backpacks") => rows.reduce((sum, row) => sum + row[key], 0);
    const activeRows = rows.filter((row) => row.combined > 0);
    const historical = activeRows.filter((row) => row.date !== today);
    const historicalAverage = historical.length ? Math.round(historical.reduce((sum, row) => sum + row.combined, 0) / historical.length) : 0;
    const minRows = historical.length ? historical : activeRows;
    const totalCash = total("cash"); const totalQr = total("qr"); const totalCombined = total("combined");
    return c.json({ status: "ok", range, today: { date: today, orders: Number(todayOrders?.order_count) || 0, paid: Number(todayOrders?.paid_count) || 0, pending: Number(todayOrders?.pending_count) || 0, cash: Number(todayOrders?.cash) || 0, qr: Number(todayOrders?.qr) || 0, luggage: Number(todayOrders?.luggage) || 0, suitcases: Number(todayOrders?.suitcases) || 0, backpacks: Number(todayOrders?.backpacks) || 0, versusHistoricalAverage: { amount: (Number(todayOrders?.luggage) || 0) - historicalAverage, percent: historicalAverage ? Math.round(((Number(todayOrders?.luggage) || 0) - historicalAverage) / historicalAverage * 100) : 0 } }, summary: { luggage: total("luggage"), rental: total("rental"), combined: totalCombined, cash: totalCash, qr: totalQr, cashPercent: totalCash + totalQr ? Math.round(totalCash / (totalCash + totalQr) * 100) : 0, qrPercent: totalCash + totalQr ? Math.round(totalQr / (totalCash + totalQr) * 100) : 0, people: total("people"), suitcases: total("suitcases"), backpacks: total("backpacks"), dailyAverage: historicalAverage, activeMin: minRows.length ? Math.min(...minRows.map((row) => row.combined)) : null, activeMax: activeRows.length ? Math.max(...activeRows.map((row) => row.combined)) : null }, dailyRows: rows });
  } catch {
    return c.json({ status: "error", error: "failed to read luggage sales analytics" }, 500);
  }
});

// GET /internal/luggage-sales-heatmap — read-only storage and pickup time projections.
internalApi.get("/internal/luggage-sales-heatmap", async (c) => {
  c.header("Cache-Control", "no-store");
  const range = resolveAnalyticsRange(c.req.query("startDate"), c.req.query("endDate"));
  if (!range) return c.json({ status: "error", error: "invalid JST date range" }, 400);
  try {
    const [storageRows, pickupRows, cycleRows, stats] = await Promise.all([
      c.env.DB.prepare("SELECT CAST(strftime('%w', created_at, '+9 hours') AS INTEGER) AS dow, CAST(strftime('%H', created_at, '+9 hours') AS INTEGER) AS hour, COUNT(*) AS count FROM luggage_orders WHERE status IN ('PAID','PICKED_UP','PAYMENT_PENDING') AND date(created_at, '+9 hours') BETWEEN ? AND ? GROUP BY dow, hour").bind(range.startDate, range.endDate).all<{ dow: number; hour: number; count: number }>(),
      c.env.DB.prepare("SELECT CAST(strftime('%w', actual_pickup_at, '+9 hours') AS INTEGER) AS dow, CAST(strftime('%H', actual_pickup_at, '+9 hours') AS INTEGER) AS hour, COUNT(*) AS count FROM luggage_orders WHERE actual_pickup_at IS NOT NULL AND status IN ('PAID','PICKED_UP') AND date(actual_pickup_at, '+9 hours') BETWEEN ? AND ? GROUP BY dow, hour").bind(range.startDate, range.endDate).all<{ dow: number; hour: number; count: number }>(),
      c.env.DB.prepare("SELECT CAST(strftime('%H', created_at, '+9 hours') AS INTEGER) AS storage_hour, CAST(strftime('%H', actual_pickup_at, '+9 hours') AS INTEGER) AS pickup_hour, COUNT(*) AS count FROM luggage_orders WHERE status = 'PICKED_UP' AND actual_pickup_at IS NOT NULL AND date(created_at, '+9 hours') BETWEEN ? AND ? GROUP BY storage_hour, pickup_hour").bind(range.startDate, range.endDate).all<{ storage_hour: number; pickup_hour: number; count: number }>(),
      c.env.DB.prepare("SELECT COUNT(*) AS total_orders, MIN(date(created_at, '+9 hours')) AS earliest_date, MAX(date(created_at, '+9 hours')) AS latest_date FROM luggage_orders WHERE date(created_at, '+9 hours') BETWEEN ? AND ?").bind(range.startDate, range.endDate).first<{ total_orders: number; earliest_date: string | null; latest_date: string | null }>(),
    ]);
    const storage = emptyWeekHourGrid(); const pickup = emptyWeekHourGrid(); const cycle = emptyHourGrid();
    for (const row of storageRows.results) if (row.dow >= 0 && row.dow < 7 && row.hour >= 0 && row.hour < 24) storage[row.dow][row.hour] = Number(row.count) || 0;
    for (const row of pickupRows.results) if (row.dow >= 0 && row.dow < 7 && row.hour >= 0 && row.hour < 24) pickup[row.dow][row.hour] = Number(row.count) || 0;
    for (const row of cycleRows.results) if (row.storage_hour >= 0 && row.storage_hour < 24 && row.pickup_hour >= 0 && row.pickup_hour < 24) cycle[row.storage_hour][row.pickup_hour] = Number(row.count) || 0;
    return c.json({ status: "ok", range, totalDataCount: Number(stats?.total_orders) || 0, dataDateRange: { min: stats?.earliest_date ?? null, max: stats?.latest_date ?? null }, grids: { storage, pickup, cycle }, maximums: { storage: gridMax(storage), pickup: gridMax(pickup), cycle: gridMax(cycle) }, totals: { storage: weekHourTotals(storage), pickup: weekHourTotals(pickup), cycle: { byStorageHour: cycle.map((row) => row.reduce((sum, value) => sum + value, 0)), byPickupHour: Array.from({ length: 24 }, (_, hour) => cycle.reduce((sum, row) => sum + row[hour], 0)) } } });
  } catch {
    return c.json({ status: "error", error: "failed to read luggage sales heatmap" }, 500);
  }
});

type LuggageHandoverNoteDto = {
  noteId: number;
  category: string;
  title: string;
  content: string;
  isPinned: boolean;
  authorId: string | null;
  authorName: string;
  createdAt: string;
  readers: Array<{ staffId: string; staffName: string; readAt: string }>;
  comments: Array<{ commentId: number; staffId: string; staffName: string; content: string; createdAt: string }>;
  editCount: number;
  lastEditedAt: string | null;
  mentionedStaff: Array<{ staffId: string; staffName: string }>;
};

type LuggageHandoverAuthorDto = { staffId: string; staffName: string };

type LuggageHandoverNoteRow = {
  noteId: number;
  category: string | null;
  title: string | null;
  content: string | null;
  isPinned: number | null;
  authorId: string | null;
  createdAt: string | null;
};

type LuggageLostFoundDto = {
  entryId: number;
  foundAt: string | null;
  itemName: string | null;
  quantity: number;
  foundLocation: string | null;
  status: string;
  claimedBy: string | null;
  note: string | null;
  registeredByStaffId: string | null;
  registeredByStaffName: string;
  createdAt: string;
};

type LuggageLostFoundRow = {
  entryId: number;
  foundAt: string | null;
  itemName: string | null;
  quantity: number;
  foundLocation: string | null;
  status: string;
  claimedBy: string | null;
  note: string | null;
  staffId: string | null;
  createdAt: string;
};

function handoverStaffName(staffId: string | null, names: Map<string, string>): string {
  if (staffId === "SYSTEM") return "시스템";
  return staffId ? names.get(staffId) ?? staffId.slice(0, 8) : "작성자 미상";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function maskLuggageCustomerName(value: string | null): string {
  const characters = Array.from(value?.trim() ?? "");
  if (characters.length === 0) return "—";
  if (characters.length === 1) return "*";
  if (characters.length === 2) return `${characters[0]}*`;
  return `${characters[0]}${"*".repeat(characters.length - 2)}${characters[characters.length - 1]}`;
}

async function fetchActiveHandoverAuthorNames(env: AppType["Bindings"]): Promise<Map<string, string>> {
  const { data } = await createSupabaseAdmin(env)
    .from("user_profiles")
    .select("id, display_name, username")
    .eq("is_active", true);
  const names = new Map<string, string>();
  for (const profile of data ?? []) {
    const name = (profile.display_name || profile.username || "").trim();
    if (profile.id && name) names.set(profile.id, name);
  }
  return names;
}

type LuggageCashClosingType = "MORNING_HANDOVER" | "FINAL_CLOSE" | "UNKNOWN";

type LuggageCashClosingDto = {
  closingId: number;
  businessDate: string | null;
  closingType: LuggageCashClosingType;
  workflowStatus: string | null;
  denominations: Record<string, number | null>;
  cashTotal: number | null;
  paypayAmount: number | null;
  actualQrAmount: number | null;
  actualAmount: number | null;
  qrDifferenceAmount: number | null;
  rentalCashAmount: number | null;
  wandRefundAmount: number | null;
  floor4fCount: number | null;
  floor8fCount: number | null;
  autoSalesAmount: number | null;
  differenceAmount: number | null;
  note: string | null;
  authorName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  submittedAt: string | null;
  morningHandover: {
    closingId: number;
    createdAt: string | null;
    authorName: string | null;
  } | null;
};

type LuggageCashClosingRow = Record<string, unknown>;

const CASH_CLOSING_DENOMINATIONS = [10000, 5000, 2000, 1000, 500, 100, 50, 10, 5, 1] as const;

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCashClosingType(value: unknown): LuggageCashClosingType {
  if (value === "MORNING_HANDOVER" || value === "FINAL_CLOSE") return value;
  return "UNKNOWN";
}

function serializeCashClosing(
  row: LuggageCashClosingRow,
  authorNames: Map<string, string>,
  autoSalesByDate: Map<string, AutoSalesSummary>,
): LuggageCashClosingDto {
  const authorId = nullableString(row.staffId);
  const morningAuthorId = nullableString(row.morningStaffId);
  const denominations: Record<string, number | null> = {};
  for (const denomination of CASH_CLOSING_DENOMINATIONS) {
    denominations[String(denomination)] = nullableFiniteNumber(row[`count${denomination}`]);
  }

  const morningClosingId = nullableFiniteNumber(row.morningClosingId);
  const businessDate = nullableString(row.businessDate);
  const paypayAmount = nullableFiniteNumber(row.paypayAmount);
  const rawActualQrAmount = nullableFiniteNumber(row.rawActualQrAmount);
  const actualQrAmount = rawActualQrAmount === 0 ? paypayAmount : rawActualQrAmount;
  const autoSalesAmount = businessDate && autoSalesByDate.get(businessDate)
    ? autoSalesByDate.get(businessDate)?.totalAmount ?? null
    : nullableFiniteNumber(row.storedAutoSalesAmount);
  const cashTotal = nullableFiniteNumber(row.cashTotal);
  const differenceAmount = cashTotal === null || actualQrAmount === null || autoSalesAmount === null
    ? null
    : (cashTotal - CASH_CLOSING_STARTING_FLOAT) + actualQrAmount - autoSalesAmount;
  return {
    closingId: nullableFiniteNumber(row.closingId) ?? 0,
    businessDate,
    closingType: normalizeCashClosingType(row.closingType),
    workflowStatus: nullableString(row.workflowStatus),
    denominations,
    cashTotal,
    paypayAmount,
    actualQrAmount,
    actualAmount: nullableFiniteNumber(row.actualAmount),
    qrDifferenceAmount: nullableFiniteNumber(row.qrDifferenceAmount),
    rentalCashAmount: nullableFiniteNumber(row.rentalCashAmount),
    wandRefundAmount: nullableFiniteNumber(row.wandRefundAmount),
    floor4fCount: nullableFiniteNumber(row.floor4fCount),
    floor8fCount: nullableFiniteNumber(row.floor8fCount),
    autoSalesAmount,
    differenceAmount,
    note: nullableString(row.note),
    authorName: authorId ? authorNames.get(authorId) ?? nullableString(row.ownerName) : nullableString(row.ownerName),
    createdAt: nullableString(row.createdAt),
    updatedAt: nullableString(row.updatedAt),
    submittedAt: nullableString(row.submittedAt),
    morningHandover: morningClosingId === null ? null : {
      closingId: morningClosingId,
      createdAt: nullableString(row.morningCreatedAt),
      authorName: morningAuthorId ? authorNames.get(morningAuthorId) ?? nullableString(row.morningOwnerName) : nullableString(row.morningOwnerName),
    },
  };
}

const CASH_CLOSING_SELECT = `
  SELECT c.closing_id AS closingId,
         c.business_date AS businessDate,
         c.closing_type AS closingType,
         c.workflow_status AS workflowStatus,
         c.count_10000 AS count10000,
         c.count_5000 AS count5000,
         c.count_2000 AS count2000,
         c.count_1000 AS count1000,
         c.count_500 AS count500,
         c.count_100 AS count100,
         c.count_50 AS count50,
         c.count_10 AS count10,
         c.count_5 AS count5,
         c.count_1 AS count1,
         c.total_amount AS cashTotal,
         c.paypay_amount AS paypayAmount,
         c.actual_qr_amount AS rawActualQrAmount,
         c.actual_amount AS actualAmount,
         c.qr_difference_amount AS qrDifferenceAmount,
         c.rental_cash AS rentalCashAmount,
         c.wand_refund AS wandRefundAmount,
         c.floor_4f_count AS floor4fCount,
         c.floor_8f_count AS floor8fCount,
         c.check_auto_amount AS storedAutoSalesAmount,
         c.note AS note,
         c.staff_id AS staffId,
         c.owner_name AS ownerName,
         c.created_at AS createdAt,
         c.updated_at AS updatedAt,
         c.submitted_at AS submittedAt,
         morning.closing_id AS morningClosingId,
         morning.created_at AS morningCreatedAt,
         morning.staff_id AS morningStaffId,
         morning.owner_name AS morningOwnerName
  FROM luggage_cash_closings c
  LEFT JOIN luggage_cash_closings morning
    ON morning.business_date = c.business_date
   AND c.closing_type = 'FINAL_CLOSE'
   AND morning.closing_type = 'MORNING_HANDOVER'`;

async function serializeCashClosings(env: AppType["Bindings"], rows: LuggageCashClosingRow[]): Promise<LuggageCashClosingDto[]> {
  const staffIds = rows.flatMap((row) => [nullableString(row.staffId), nullableString(row.morningStaffId)]);
  const businessDates = rows.map((row) => nullableString(row.businessDate)).filter((value): value is string => value !== null);
  const [authorNames, autoSalesByDate] = await Promise.all([
    fetchStaffNamesByIds(env, staffIds),
    resolveAutoSalesSummariesByDate(env.DB, businessDates),
  ]);
  return rows.map((row) => serializeCashClosing(row, authorNames, autoSalesByDate));
}

// GET /internal/luggage-staff-accounts — Read-only projection of existing Supabase staff profiles.
internalApi.get("/internal/luggage-staff-accounts", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const { data, error } = await createSupabaseAdmin(c.env)
      .from("user_profiles")
      .select("id, display_name, username, email, role, is_active, created_at")
      .order("is_active", { ascending: false })
      .order("created_at", { ascending: false });

    if (error || !Array.isArray(data)) {
      return c.json({ status: "error", error: "failed to read luggage staff accounts" }, 500);
    }

    const accounts: LuggageStaffAccountDto[] = [];
    for (const row of data) {
      if (typeof row.id !== "string" || !row.id.trim()
        || (row.display_name !== null && typeof row.display_name !== "string")
        || (row.username !== null && typeof row.username !== "string")
        || (row.email !== null && typeof row.email !== "string")
        || (row.role !== "admin" && row.role !== "editor" && row.role !== "viewer")
        || typeof row.is_active !== "boolean"
        || typeof row.created_at !== "string" || !row.created_at) {
        return c.json({ status: "error", error: "failed to read luggage staff accounts" }, 500);
      }
      accounts.push({
        id: row.id,
        displayName: row.display_name,
        username: row.username,
        email: row.email,
        role: row.role,
        isActive: row.is_active,
        createdAt: row.created_at,
      });
    }

    const active = accounts.filter((account) => account.isActive).length;
    return c.json({
      status: "ok",
      accounts,
      summary: {
        total: accounts.length,
        active,
        inactive: accounts.length - active,
        admins: accounts.filter((account) => account.role === "admin").length,
      },
    });
  } catch {
    return c.json({ status: "error", error: "failed to read luggage staff accounts" }, 500);
  }
});

// GET /internal/luggage-work-schedule — Read-only projection of the existing staff calendar setting.
internalApi.get("/internal/luggage-work-schedule", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const setting = await c.env.DB.prepare(
      "SELECT setting_value FROM luggage_app_settings WHERE setting_key = 'calendar_embed_url'",
    ).first<{ setting_value: string | null }>();
    const calendarEmbedUrl = normalizeGoogleCalendarEmbedUrl(setting?.setting_value);
    const response: LuggageWorkScheduleDto = {
      calendarEmbedUrl,
      configured: calendarEmbedUrl !== null,
    };
    return c.json(response);
  } catch {
    return c.json({ error: "failed to read luggage work schedule setting" }, 500);
  }
});

// GET /internal/luggage-completion-messages — Read-only effective completion messages.
internalApi.get("/internal/luggage-completion-messages", async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const messages = await loadCompletionMessages(c.env.DB);
    const response: LuggageCompletionMessagesDto = {
      primary: {
        ko: messages.primary.ko,
        en: messages.primary.en,
        ja: messages.primary.ja,
      },
      secondary: {
        ko: messages.secondary.ko,
        en: messages.secondary.en,
        ja: messages.secondary.ja,
      },
    };
    return c.json(response);
  } catch {
    return c.json({ error: "failed to read luggage completion messages" }, 500);
  }
});

// GET /internal/luggage-cash-closings — Read-only cash-closing list for the integrated admin.
internalApi.get("/internal/luggage-cash-closings", async (c) => {
  c.header("Cache-Control", "no-store");
  const dateFromRaw = c.req.query("dateFrom");
  const dateToRaw = c.req.query("dateTo");
  const dateFrom = parseJstDateQuery(dateFromRaw);
  const dateTo = parseJstDateQuery(dateToRaw);
  if ((dateFromRaw && !dateFrom) || (dateToRaw && !dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) {
    return c.json({ error: "invalid JST date range" }, 400);
  }
  const limit = parsePaginationQuery(c.req.query("limit"), 50, 200);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: string[] = [];
  if (dateFrom) { clauses.push("c.business_date >= ?"); params.push(dateFrom); }
  if (dateTo) { clauses.push("c.business_date <= ?"); params.push(dateTo); }
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`${CASH_CLOSING_SELECT}${where} ORDER BY c.business_date DESC, c.created_at DESC, c.closing_id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<LuggageCashClosingRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM luggage_cash_closings c${where}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);
  return c.json({ closings: await serializeCashClosings(c.env, rows.results), total: total?.total ?? 0, limit, offset });
});

// GET /internal/luggage-cash-closings/:closingId — Read-only cash-closing detail for the integrated admin.
internalApi.get("/internal/luggage-cash-closings/:closingId", async (c) => {
  c.header("Cache-Control", "no-store");
  const closingId = c.req.param("closingId");
  if (!/^\d+$/.test(closingId) || !Number.isSafeInteger(Number(closingId)) || Number(closingId) < 1) {
    return c.json({ error: "invalid cash closing id" }, 400);
  }
  const row = await c.env.DB.prepare(`${CASH_CLOSING_SELECT} WHERE c.closing_id = ?`)
    .bind(Number(closingId))
    .first<LuggageCashClosingRow>();
  if (!row) return c.json({ error: "cash closing not found" }, 404);
  return c.json({ closing: (await serializeCashClosings(c.env, [row]))[0] });
});

type LuggageActivityLogSource = "staff" | "unified-admin" | "system";
type LuggageActivityLogRow = {
  logId: number;
  orderId: string | null;
  staffId: string | null;
  deviceId: string | null;
  action: string;
  details: string | null;
  timestamp: string;
};

function activityLogSource(staffId: string | null, deviceId: string | null): LuggageActivityLogSource {
  if (deviceId === "unified-admin") return "unified-admin";
  return staffId ? "staff" : "system";
}

// GET /internal/luggage-activity-logs — Read-only audit log projection for the integrated admin.
internalApi.get("/internal/luggage-activity-logs", async (c) => {
  c.header("Cache-Control", "no-store");
  const dateFromRaw = c.req.query("dateFrom");
  const dateToRaw = c.req.query("dateTo");
  let dateFrom: string;
  let dateTo: string;
  if (!dateFromRaw && !dateToRaw) {
    dateTo = jstToday();
    dateFrom = addCalendarDays(dateTo, -6);
  } else {
    const parsedFrom = parseJstDateQuery(dateFromRaw);
    const parsedTo = parseJstDateQuery(dateToRaw);
    if (!parsedFrom || !parsedTo || parsedFrom > parsedTo) return c.json({ error: "invalid JST date range" }, 400);
    const span = Math.round((new Date(`${parsedTo}T00:00:00Z`).getTime() - new Date(`${parsedFrom}T00:00:00Z`).getTime()) / 86400000);
    if (span > 365) return c.json({ error: "JST date range exceeds one year" }, 400);
    dateFrom = parsedFrom;
    dateTo = parsedTo;
  }

  const search = c.req.query("search")?.trim() ?? "";
  const action = c.req.query("action")?.trim() ?? "";
  const staffId = c.req.query("staffId")?.trim() ?? "";
  const sourceQuery = c.req.query("source")?.trim() ?? "";
  const sortQuery = c.req.query("sort")?.trim() ?? "newest";
  const sort = LUGGAGE_ACTIVITY_LOG_SORTS.has(sortQuery) ? sortQuery : "newest";
  const source = LUGGAGE_ACTIVITY_LOG_SOURCES.has(sourceQuery) ? sourceQuery : "";
  const limit = parsePaginationQuery(c.req.query("limit"), 50, 200);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses = ["date(a.timestamp, '+9 hours') BETWEEN ? AND ?"];
  const params: Array<string | number> = [dateFrom, dateTo];

  if (search) {
    const like = `%${escapeLike(search)}%`;
    clauses.push("(a.order_id LIKE ? ESCAPE '\\' OR a.action LIKE ? ESCAPE '\\' OR a.details LIKE ? ESCAPE '\\' OR a.device_id LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (action) { clauses.push("a.action = ?"); params.push(action); }
  if (staffId) { clauses.push("a.staff_id = ?"); params.push(staffId); }
  if (source === "unified-admin") clauses.push("a.device_id = 'unified-admin'");
  if (source === "staff") clauses.push("a.staff_id IS NOT NULL AND (a.device_id IS NULL OR a.device_id != 'unified-admin')");
  if (source === "system") clauses.push("a.staff_id IS NULL AND (a.device_id IS NULL OR a.device_id != 'unified-admin')");

  const where = ` WHERE ${clauses.join(" AND ")}`;
  const orderBy = sort === "oldest" ? "a.timestamp ASC, a.log_id ASC" : "a.timestamp DESC, a.log_id DESC";
  const [logsResult, totalResult, actionResult, staffResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT a.log_id AS logId, a.order_id AS orderId, a.staff_id AS staffId, a.device_id AS deviceId,
              a.action, a.details, a.timestamp
       FROM luggage_audit_logs a${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all<LuggageActivityLogRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM luggage_audit_logs a${where}`)
      .bind(...params).first<{ total: number }>(),
    c.env.DB.prepare("SELECT DISTINCT action FROM luggage_audit_logs WHERE action IS NOT NULL AND action != '' ORDER BY action ASC")
      .all<{ action: string }>(),
    c.env.DB.prepare("SELECT DISTINCT staff_id AS staffId FROM luggage_audit_logs WHERE staff_id IS NOT NULL AND staff_id != '' ORDER BY staff_id ASC")
      .all<{ staffId: string }>(),
  ]);

  const allStaffIds = [...new Set([
    ...logsResult.results.map((log) => log.staffId).filter((value): value is string => Boolean(value)),
    ...staffResult.results.map((entry) => entry.staffId),
  ])];
  let staffNames = new Map<string, string>();
  try {
    staffNames = await fetchStaffNamesByIds(c.env, allStaffIds);
  } catch {
    // Audit history remains available when the optional profile lookup is unavailable.
  }
  const logs = logsResult.results.map((log) => {
    const sourceValue = activityLogSource(log.staffId, log.deviceId);
    return {
      logId: log.logId,
      orderId: log.orderId,
      staffId: log.staffId,
      staffName: log.staffId ? staffNames.get(log.staffId) ?? log.staffId : sourceValue === "system" ? "시스템" : "알 수 없음",
      deviceId: log.deviceId,
      source: sourceValue,
      action: log.action,
      actionLabel: LUGGAGE_AUDIT_ACTION_LABELS[log.action] ?? log.action,
      details: log.details,
      timestamp: log.timestamp,
    };
  });
  const actions = actionResult.results.map((entry) => ({ value: entry.action, label: LUGGAGE_AUDIT_ACTION_LABELS[entry.action] ?? entry.action }));
  const staff = staffResult.results
    .map((entry) => ({ staffId: entry.staffId, staffName: staffNames.get(entry.staffId) ?? entry.staffId }))
    .sort((left, right) => left.staffName.localeCompare(right.staffName, "ko"));
  return c.json({ logs, filters: { actions, staff }, total: totalResult?.total ?? 0, limit, offset });
});

type LuggageCustomerAggregateRow = {
  customerIdentity: string;
  name: string | null;
  orderCount: number;
  totalSpent: number;
  firstVisitAt: string;
  lastVisitAt: string;
  totalSuitcases: number;
  totalBackpacks: number;
};

// GET /internal/luggage-customers — Read-only, privacy-reduced customer aggregates.
internalApi.get("/internal/luggage-customers", async (c) => {
  c.header("Cache-Control", "no-store");
  const q = c.req.query("q")?.trim() ?? "";
  const sortQuery = c.req.query("sort")?.trim() ?? "recent";
  const sort = LUGGAGE_CUSTOMER_SORTS.has(sortQuery) ? sortQuery : "recent";
  const parsedLimit = Number(c.req.query("limit")?.trim() ?? "50");
  const limit = LUGGAGE_CUSTOMER_LIMITS.has(parsedLimit) ? parsedLimit : 50;
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses = [
    "status != 'CANCELLED'",
    "COALESCE(NULLIF(TRIM(phone), ''), NULLIF(TRIM(email), '')) IS NOT NULL",
  ];
  const params: string[] = [];

  if (q) {
    const like = `%${escapeLike(q)}%`;
    clauses.push("(name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }

  const filteredSql = `SELECT order_id AS orderId,
      COALESCE(NULLIF(TRIM(phone), ''), NULLIF(TRIM(email), '')) AS customerIdentity,
      name, created_at AS createdAt, COALESCE(final_amount, 0) AS finalAmount,
      COALESCE(suitcase_qty, 0) AS suitcaseQty, COALESCE(backpack_qty, 0) AS backpackQty
    FROM luggage_orders WHERE ${clauses.join(" AND ")}`;
  const orderBy = sort === "oldest"
    ? "lastVisitAt ASC, firstVisitAt ASC, customerIdentity ASC"
    : sort === "visits_desc"
      ? "orderCount DESC, lastVisitAt DESC, customerIdentity ASC"
      : sort === "spent_desc"
        ? "totalSpent DESC, lastVisitAt DESC, customerIdentity ASC"
        : "lastVisitAt DESC, customerIdentity ASC";

  try {
    const [totalResult, rowsResult] = await Promise.all([
      c.env.DB.prepare(
        `WITH filtered AS (${filteredSql}),
         grouped AS (SELECT customerIdentity FROM filtered GROUP BY customerIdentity)
         SELECT COUNT(*) AS total FROM grouped`,
      ).bind(...params).first<{ total: number }>(),
      c.env.DB.prepare(
        `WITH filtered AS (${filteredSql}),
         grouped AS (
           SELECT customerIdentity, COUNT(*) AS orderCount,
             SUM(finalAmount) AS totalSpent, MIN(createdAt) AS firstVisitAt,
             MAX(createdAt) AS lastVisitAt, SUM(suitcaseQty) AS totalSuitcases,
             SUM(backpackQty) AS totalBackpacks
           FROM filtered GROUP BY customerIdentity
         )
         SELECT grouped.*,
           (SELECT recent.name FROM filtered recent
            WHERE recent.customerIdentity IS grouped.customerIdentity
            ORDER BY recent.createdAt DESC, recent.orderId DESC LIMIT 1) AS name
         FROM grouped ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ).bind(...params, limit, offset).all<LuggageCustomerAggregateRow>(),
    ]);

    const customers = await Promise.all(rowsResult.results.map(async (row) => ({
      customerKey: `lc_${await hmacSha256Hex(
        c.env.INTERNAL_API_SECRET,
        `luggage-customer:value:${row.customerIdentity}`,
      )}`,
      maskedName: maskLuggageCustomerName(row.name),
      orderCount: Math.max(0, Number(row.orderCount) || 0),
      totalSpent: Math.max(0, Number(row.totalSpent) || 0),
      firstVisitAt: row.firstVisitAt,
      lastVisitAt: row.lastVisitAt,
      totalSuitcases: Math.max(0, Number(row.totalSuitcases) || 0),
      totalBackpacks: Math.max(0, Number(row.totalBackpacks) || 0),
    })));

    return c.json({
      status: "ok",
      customers,
      total: Math.max(0, Number(totalResult?.total) || 0),
      limit,
      offset,
    });
  } catch {
    return c.json({ status: "error", error: "failed to read luggage customers" }, 500);
  }
});

// GET /internal/luggage-lost-found — Read-only lost-and-found list for the integrated admin.
internalApi.get("/internal/luggage-lost-found", async (c) => {
  c.header("Cache-Control", "no-store");
  const search = c.req.query("search")?.trim() ?? "";
  const statusQuery = c.req.query("status")?.trim() ?? "";
  const sortQuery = c.req.query("sort")?.trim() ?? "newest";
  if (statusQuery && !LUGGAGE_LOST_FOUND_STATUSES.has(statusQuery)) {
    return c.json({ error: "invalid lost-found status" }, 400);
  }
  const sort = LUGGAGE_LOST_FOUND_SORTS.has(sortQuery) ? sortQuery : "newest";
  const limitQuery = c.req.query("limit");
  const limit = limitQuery?.trim() === "0" ? 50 : parsePaginationQuery(limitQuery, 50, 200);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: string[] = [];

  if (search) {
    const like = `%${escapeLike(search)}%`;
    clauses.push("(item_name LIKE ? ESCAPE '\\' OR found_location LIKE ? ESCAPE '\\' OR claimed_by LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  if (statusQuery) {
    clauses.push("status = ?");
    params.push(statusQuery);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = sort === "oldest" ? "created_at ASC, entry_id ASC" : "created_at DESC, entry_id DESC";
  const [entriesResult, totalResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT entry_id AS entryId, found_at AS foundAt, item_name AS itemName, quantity,
              found_location AS foundLocation, status, claimed_by AS claimedBy, note,
              staff_id AS staffId, created_at AS createdAt
       FROM luggage_lost_found_entries${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all<LuggageLostFoundRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM luggage_lost_found_entries${where}`)
      .bind(...params).first<{ total: number }>(),
  ]);
  let staffNames = new Map<string, string>();
  try {
    staffNames = await fetchStaffNamesByIds(c.env, entriesResult.results.map((entry) => entry.staffId));
  } catch {
    // Lost-and-found data must remain readable even when the optional profile lookup is unavailable.
  }
  const entries: LuggageLostFoundDto[] = entriesResult.results.map((entry) => ({
    entryId: entry.entryId,
    foundAt: entry.foundAt,
    itemName: entry.itemName,
    quantity: entry.quantity,
    foundLocation: entry.foundLocation,
    status: entry.status,
    claimedBy: entry.claimedBy,
    note: entry.note,
    registeredByStaffId: entry.staffId,
    registeredByStaffName: handoverStaffName(entry.staffId, staffNames),
    createdAt: entry.createdAt,
  }));
  return c.json({ entries, total: totalResult?.total ?? 0, limit, offset });
});

// GET /internal/luggage-handovers — Read-only handover notes for the integrated admin.
// Related rows are deliberately constrained to the current page of notes so this endpoint
// does not turn into a full-table read as the staff handover history grows.
internalApi.get("/internal/luggage-handovers", async (c) => {
  c.header("Cache-Control", "no-store");
  const search = c.req.query("search")?.trim() ?? "";
  const categoryQuery = c.req.query("category")?.trim() ?? "";
  const authorId = c.req.query("authorId")?.trim() ?? "";
  const sortQuery = c.req.query("sort")?.trim() ?? "newest";
  const category = LUGGAGE_HANDOVER_CATEGORIES.has(categoryQuery) ? categoryQuery : "";
  const sort = LUGGAGE_HANDOVER_SORTS.has(sortQuery) ? sortQuery : "newest";
  const limitQuery = c.req.query("limit");
  const limit = limitQuery?.trim() === "0" ? 50 : parsePaginationQuery(limitQuery, 50, 200);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: string[] = [];

  if (search) {
    const like = `%${escapeLike(search)}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }
  if (authorId) {
    clauses.push("staff_id = ?");
    params.push(authorId);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = sort === "oldest"
    ? "created_at ASC, note_id ASC"
    : sort === "pinned"
      ? "is_pinned DESC, created_at DESC, note_id DESC"
      : "created_at DESC, note_id DESC";
  const [notesResult, totalResult, authorIdsResult, activeAuthorNames] = await Promise.all([
    c.env.DB.prepare(
      `SELECT note_id AS noteId, category, title, content, is_pinned AS isPinned, staff_id AS authorId, created_at AS createdAt
       FROM luggage_handover_notes${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all<LuggageHandoverNoteRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM luggage_handover_notes${where}`)
      .bind(...params).first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT staff_id AS staffId FROM luggage_handover_notes
       WHERE staff_id IS NOT NULL AND trim(staff_id) <> ''`,
    ).all<{ staffId: string }>(),
    fetchActiveHandoverAuthorNames(c.env),
  ]);
  const notes = notesResult.results;
  const noteIds = notes.map((note) => note.noteId);
  const actualAuthorIds = authorIdsResult.results.map((author) => author.staffId);
  const authorProfileNames = await fetchStaffNamesByIds(c.env, actualAuthorIds);
  const authorNames = new Map(activeAuthorNames);
  for (const [staffId, staffName] of authorProfileNames) authorNames.set(staffId, staffName);
  if (actualAuthorIds.includes("SYSTEM")) authorNames.set("SYSTEM", "시스템");
  for (const staffId of actualAuthorIds) {
    if (!authorNames.has(staffId)) authorNames.set(staffId, handoverStaffName(staffId, authorNames));
  }
  const authors: LuggageHandoverAuthorDto[] = [...authorNames.entries()]
    .map(([staffId, staffName]) => ({ staffId, staffName }))
    .sort((first, second) => first.staffName.localeCompare(second.staffName, "ko") || first.staffId.localeCompare(second.staffId));
  if (noteIds.length === 0) {
    return c.json({ notes: [], authors, total: totalResult?.total ?? 0, limit, offset });
  }

  const placeholders = noteIds.map(() => "?").join(",");
  const [readsResult, commentsResult, editsResult, mentionsResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT note_id AS noteId, staff_id AS staffId, read_at AS readAt
       FROM luggage_handover_reads WHERE note_id IN (${placeholders})
       ORDER BY read_at ASC, read_id ASC`,
    ).bind(...noteIds).all<{ noteId: number; staffId: string; readAt: string }>(),
    c.env.DB.prepare(
      `SELECT comment_id AS commentId, note_id AS noteId, staff_id AS staffId, content, created_at AS createdAt
       FROM luggage_handover_comments WHERE note_id IN (${placeholders})
       ORDER BY created_at ASC, comment_id ASC`,
    ).bind(...noteIds).all<{ commentId: number; noteId: number; staffId: string; content: string | null; createdAt: string }>(),
    c.env.DB.prepare(
      `SELECT note_id AS noteId, COUNT(*) AS editCount, MAX(created_at) AS lastEditedAt
       FROM luggage_handover_edits WHERE note_id IN (${placeholders}) GROUP BY note_id`,
    ).bind(...noteIds).all<{ noteId: number; editCount: number; lastEditedAt: string | null }>(),
    c.env.DB.prepare(
      `SELECT note_id AS noteId, staff_id AS staffId
       FROM luggage_handover_mentions WHERE note_id IN (${placeholders})
       ORDER BY created_at ASC, mention_id ASC`,
    ).bind(...noteIds).all<{ noteId: number; staffId: string }>(),
  ]);

  const readersByNote = new Map<number, Array<{ staffId: string; staffName: string; readAt: string }>>();
  const commentsByNote = new Map<number, Array<{ commentId: number; staffId: string; staffName: string; content: string; createdAt: string }>>();
  const editsByNote = new Map<number, { editCount: number; lastEditedAt: string | null }>();
  const mentionsByNote = new Map<number, Array<{ staffId: string; staffName: string }>>();
  const staffIds = [
    ...actualAuthorIds,
    ...notes.map((note) => note.authorId),
    ...readsResult.results.map((read) => read.staffId),
    ...commentsResult.results.map((comment) => comment.staffId),
    ...mentionsResult.results.map((mention) => mention.staffId),
  ];
  const staffNames = await fetchStaffNamesByIds(c.env, staffIds);
  for (const [staffId, staffName] of authorNames) staffNames.set(staffId, staffName);
  staffNames.set("SYSTEM", "시스템");

  for (const read of readsResult.results) {
    const readers = readersByNote.get(read.noteId) ?? [];
    readers.push({ staffId: read.staffId, staffName: handoverStaffName(read.staffId, staffNames), readAt: read.readAt });
    readersByNote.set(read.noteId, readers);
  }
  for (const comment of commentsResult.results) {
    const comments = commentsByNote.get(comment.noteId) ?? [];
    comments.push({
      commentId: comment.commentId,
      staffId: comment.staffId,
      staffName: handoverStaffName(comment.staffId, staffNames),
      content: comment.content ?? "",
      createdAt: comment.createdAt,
    });
    commentsByNote.set(comment.noteId, comments);
  }
  for (const edit of editsResult.results) editsByNote.set(edit.noteId, edit);
  for (const mention of mentionsResult.results) {
    const mentions = mentionsByNote.get(mention.noteId) ?? [];
    if (!mentions.some((item) => item.staffId === mention.staffId)) {
      mentions.push({ staffId: mention.staffId, staffName: handoverStaffName(mention.staffId, staffNames) });
    }
    mentionsByNote.set(mention.noteId, mentions);
  }

  const serialized: LuggageHandoverNoteDto[] = notes.map((note) => {
    const edit = editsByNote.get(note.noteId);
    return {
      noteId: note.noteId,
      category: LUGGAGE_HANDOVER_CATEGORIES.has(note.category ?? "") ? note.category! : "OTHER",
      title: note.title ?? "",
      content: note.content ?? "",
      isPinned: Boolean(note.isPinned),
      authorId: note.authorId,
      authorName: handoverStaffName(note.authorId, staffNames),
      createdAt: note.createdAt ?? "",
      readers: readersByNote.get(note.noteId) ?? [],
      comments: commentsByNote.get(note.noteId) ?? [],
      editCount: edit?.editCount ?? 0,
      lastEditedAt: edit?.lastEditedAt ?? null,
      mentionedStaff: mentionsByNote.get(note.noteId) ?? [],
    };
  });
  return c.json({ notes: serialized, authors, total: totalResult?.total ?? 0, limit, offset });
});

// GET /internal/luggage-orders — Read-only order list for the integrated admin.
internalApi.get("/internal/luggage-orders", async (c) => {
  const status = c.req.query("status");
  const search = c.req.query("search");
  const dateFrom = parseJstDateQuery(c.req.query("dateFrom"));
  const dateTo = parseJstDateQuery(c.req.query("dateTo"));
  const limit = parsePaginationQuery(c.req.query("limit"), 100, 500);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const countClauses: string[] = [];
  const countParams: Array<string | number> = [];

  if (status) {
    if (status === "UNPICKED") {
      clauses.push("o.status IN ('PAYMENT_PENDING', 'PAID')");
    } else {
      clauses.push("o.status = ?");
      params.push(status);
    }
  }
  if (search) {
    clauses.push("(o.order_id LIKE ? OR o.name LIKE ? OR o.phone LIKE ? OR o.tag_no LIKE ?)");
    countClauses.push("(o.order_id LIKE ? OR o.name LIKE ? OR o.phone LIKE ? OR o.tag_no LIKE ?)");
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern);
    countParams.push(pattern, pattern, pattern, pattern);
  }
  // created_at is stored in UTC; SQLite applies +9 hours before comparing its
  // calendar date so dateFrom/dateTo consistently mean JST dates.
  if (dateFrom) {
    clauses.push("date(o.created_at, '+9 hours') >= ?");
    params.push(dateFrom);
    countClauses.push("date(o.created_at, '+9 hours') >= ?");
    countParams.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date(o.created_at, '+9 hours') <= ?");
    params.push(dateTo);
    countClauses.push("date(o.created_at, '+9 hours') <= ?");
    countParams.push(dateTo);
  }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const payments = `
    SELECT order_id,
           COALESCE(SUM(CASE WHEN tender_type = 'CASH' THEN amount ELSE 0 END), 0) AS paymentCashAmount,
           COALESCE(SUM(CASE WHEN tender_type = 'PAY_QR' THEN amount ELSE 0 END), 0) AS paymentQrAmount
    FROM luggage_order_payments
    GROUP BY order_id
  `;
  const result = await c.env.DB.prepare(
    `SELECT o.order_id AS orderId,
            o.created_at AS createdAt,
            o.updated_at AS updatedAt,
            o.name AS name,
            o.phone AS phone,
            o.email AS email,
            o.suitcase_qty AS suitcaseQty,
            o.backpack_qty AS backpackQty,
            o.set_qty AS setQty,
            o.expected_pickup_at AS expectedPickupAt,
            o.actual_pickup_at AS actualPickupAt,
            o.expected_storage_days AS expectedStorageDays,
            o.actual_storage_days AS actualStorageDays,
            o.extra_days AS extraDays,
            o.prepaid_amount AS prepaidAmount,
            o.final_amount AS finalAmount,
            o.extra_amount AS extraAmount,
            o.price_per_day AS pricePerDay,
            o.payment_method AS paymentMethod,
            o.status AS status,
            o.tag_no AS tagNo,
            o.note AS note,
            o.manual_entry AS manualEntry,
            o.parent_order_id AS parentOrderId,
            o.in_warehouse AS inWarehouse,
            o.flying_pass_tier AS flyingPassTier,
            o.flying_pass_discount_amount AS flyingPassDiscountAmount,
            o.staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
            COALESCE(p.paymentCashAmount, 0) AS paymentCashAmount,
            COALESCE(p.paymentQrAmount, 0) AS paymentQrAmount,
            CASE WHEN o.id_image_url IS NOT NULL AND trim(o.id_image_url) <> '' THEN 1 ELSE 0 END AS hasIdImage,
            CASE WHEN o.luggage_image_url IS NOT NULL AND trim(o.luggage_image_url) <> '' THEN 1 ELSE 0 END AS hasLuggageImage
     FROM luggage_orders o
     LEFT JOIN (${payments}) p ON p.order_id = o.order_id${where}
     ORDER BY o.created_at DESC, o.order_id DESC
     LIMIT ? OFFSET ?`,
  ).bind(...params, limit, offset).all<LuggageOrderDto>();
  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM luggage_orders o${where}`,
  ).bind(...params).first<{ total: number }>();
  const statusCountsResult = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN o.status = 'PAYMENT_PENDING' THEN 1 ELSE 0 END), 0) AS paymentPending,
       COALESCE(SUM(CASE WHEN o.status = 'PAID' THEN 1 ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN o.status = 'PICKED_UP' THEN 1 ELSE 0 END), 0) AS pickedUp,
       COALESCE(SUM(CASE WHEN o.status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled
     FROM luggage_orders o${countClauses.length ? ` WHERE ${countClauses.join(" AND ")}` : ""}`,
  ).bind(...countParams).first<LuggageStatusCounts>();

  const parentOrderIds = result.results
    .filter((order) => order.parentOrderId === null)
    .map((order) => order.orderId);
  const extensionsByParent = new Map<string, LuggageExtensionSummaryDto[]>();
  if (parentOrderIds.length > 0) {
    const placeholders = parentOrderIds.map(() => "?").join(",");
    const extensionResult = await c.env.DB.prepare(
      `SELECT o.order_id AS orderId,
              o.parent_order_id AS parentOrderId,
              o.status AS status,
              o.created_at AS createdAt,
              o.prepaid_amount AS prepaidAmount,
              o.final_amount AS finalAmount,
              o.price_per_day AS pricePerDay,
              COALESCE(SUM(CASE WHEN p.tender_type = 'CASH' THEN p.amount ELSE 0 END), 0) AS paymentCashAmount,
              COALESCE(SUM(CASE WHEN p.tender_type = 'PAY_QR' THEN p.amount ELSE 0 END), 0) AS paymentQrAmount
       FROM luggage_orders o
       LEFT JOIN luggage_order_payments p ON p.order_id = o.order_id
       WHERE o.parent_order_id IN (${placeholders})
       GROUP BY o.order_id
       ORDER BY o.created_at DESC, o.order_id DESC`,
    ).bind(...parentOrderIds).all<LuggageExtensionSummaryDto>();
    for (const extension of extensionResult.results) {
      const current = extensionsByParent.get(extension.parentOrderId) ?? [];
      current.push(extension);
      extensionsByParent.set(extension.parentOrderId, current);
    }
  }

  return c.json({
    orders: result.results.map((order) => ({
      ...order,
      hasIdImage: Boolean(order.hasIdImage),
      hasLuggageImage: Boolean(order.hasLuggageImage),
      extensions: extensionsByParent.get(order.orderId) ?? [],
    })),
    total: countResult?.total ?? 0,
    limit,
    offset,
    statusCounts: {
      paymentPending: statusCountsResult?.paymentPending ?? 0,
      paid: statusCountsResult?.paid ?? 0,
      pickedUp: statusCountsResult?.pickedUp ?? 0,
      cancelled: statusCountsResult?.cancelled ?? 0,
    },
  });
});

type LuggageNoteActor = {
  userId: string;
  name: string;
  email: string;
  role: "center_staff" | "manager" | "super_admin";
};

type LuggageNoteUpdateDto = {
  orderId: string;
  note: string | null;
  updatedAt: string;
};

type LuggageOperationsFieldsOrder = {
  orderId: string;
  status: string;
  name: string | null;
  tagNo: string | null;
  expectedPickupAt: string | null;
  inWarehouse: number;
  updatedAt: string;
};

type LuggageOperationsFieldsUpdateDto = {
  orderId: string;
  name: string | null;
  tagNo: string | null;
  expectedPickupAt: string | null;
  inWarehouse: number;
  updatedAt: string;
};

type LuggagePriceOrder = {
  orderId: string;
  pricePerDay: number;
  expectedStorageDays: number;
  prepaidAmount: number;
  finalAmount: number | null;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  paymentMethod: string | null;
  staffPrepaidOverrideAmount: number | null;
  updatedAt: string;
};

type LuggagePriceUpdateDto = {
  orderId: string;
  paymentMethod: string | null;
  flyingPassTier: string;
  flyingPassDiscountAmount: number;
  prepaidAmount: number;
  finalAmount: number;
  staffPrepaidOverrideAmount: number | null;
  updatedAt: string;
};

type LuggagePaymentStatus = "PAYMENT_PENDING" | "PAID";

type LuggagePaymentStatusOrder = {
  orderId: string;
  status: string;
  paymentMethod: string | null;
  businessDate: string;
  prepaidAmount: number;
  finalAmount: number | null;
  extraAmount: number | null;
  paymentCashAmount: number;
  paymentQrAmount: number;
};

type LuggagePaymentStatusResponse = {
  success: true;
  changed: boolean;
  order: {
    orderId: string;
    status: LuggagePaymentStatus;
    paymentMethod: string | null;
    paymentCashAmount: number;
    paymentQrAmount: number;
  };
};

type LuggagePickupStatusAction = "mark_picked_up" | "undo_picked_up";

type LuggagePickupStatusActor = {
  userId: string;
  name: string;
  role: LuggageNoteActor["role"];
};

type LuggagePickupStatusOrder = {
  orderId: string;
  status: string;
  createdAt: string;
  expectedPickupAt: string | null;
  actualPickupAt: string | null;
  pricePerDay: number;
  actualStorageDays: number;
  extraDays: number;
  extraAmount: number;
  updatedAt: string;
};

type LuggagePickupStatusUpdateDto = {
  orderId: string;
  status: "PAID" | "PICKED_UP";
  actualPickupAt: string | null;
  actualStorageDays: number;
  extraDays: number;
  extraAmount: number;
  updatedAt: string;
};

type LuggageExtensionParentOrder = {
  orderId: string;
  parentOrderId: string | null;
  updatedAt: string;
  status: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  companionCount: number;
  suitcaseQty: number;
  backpackQty: number;
  tagNo: string | null;
  inWarehouse: number;
};

type LuggageExtensionCreateResponse = {
  order: LuggageOrderDto;
  parentUpdatedAt: string;
};

type LuggageManualOrderCreatePayload = {
  name: string;
  phone: string;
  suitcaseQty: number;
  backpackQty: number;
  companionCount: number;
  expectedPickupAt: string;
  flyingPassTier: "NONE" | "BLUE" | "SILVER" | "GOLD" | "PLATINUM" | "BLACK";
  freeReason: "" | "지인 접수" | "블로거 방문" | "쿠폰" | "기타";
  freeReasonText: string;
  note: string;
  actor: LuggageNoteActor;
};

class LuggageManualOrderActorForbiddenError extends Error {}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function requiredActorText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`actor.${field} is required`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`actor.${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`actor.${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function normalizeLuggageNotePayload(payload: unknown): { actor: LuggageNoteActor; note: string | null } {
  const payloadKeys = new Set(["note", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("note" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only note and actor");
  }
  if (typeof payload.note !== "string" && payload.note !== null) {
    throw new Error("note must be a string or null");
  }
  const note = payload.note?.trim() || null;
  if (note && note.length > 500) {
    throw new Error("note exceeds 500 characters");
  }

  const actorKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_NOTE_ACTOR_ROLES.has(role)) {
    throw new Error("actor.role is not allowed");
  }

  return {
    note,
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      email: requiredActorText(payload.actor.email, "email", 254),
      role: role as LuggageNoteActor["role"],
    },
  };
}

function parseTimezoneIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) throw new Error("expectedPickupAt must be an ISO timestamp with timezone");
  const [, year, month, day, hour, minute, second = "00", fraction = "", timezone] = match;
  const localDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0"))));
  if (
    localDate.getUTCFullYear() !== Number(year)
    || localDate.getUTCMonth() + 1 !== Number(month)
    || localDate.getUTCDate() !== Number(day)
    || localDate.getUTCHours() !== Number(hour)
    || localDate.getUTCMinutes() !== Number(minute)
    || localDate.getUTCSeconds() !== Number(second)
  ) {
    throw new Error("expectedPickupAt is not a valid calendar timestamp");
  }
  if (timezone !== "Z") {
    const [, , timezoneHour, timezoneMinute] = /^([+-])(\d{2}):(\d{2})$/.exec(timezone) ?? [];
    if (Number(timezoneHour) > 23 || Number(timezoneMinute) > 59) {
      throw new Error("expectedPickupAt has an invalid timezone offset");
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("expectedPickupAt is not a valid date");
  return parsed.toISOString();
}

function normalizeLuggageOperationsFieldsPayload(payload: unknown): {
  actor: LuggageNoteActor;
  update: { name?: string | null; tagNo?: string | null; expectedPickupAt?: string | null; inWarehouse?: number };
} {
  const payloadKeys = new Set(["name", "tagNo", "expectedPickupAt", "inWarehouse", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain actor and only supported operation fields");
  }
  const hasOperationsField = "name" in payload || "tagNo" in payload || "expectedPickupAt" in payload || "inWarehouse" in payload;
  if (!hasOperationsField) throw new Error("At least one operation field is required");
  const actor = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  const update: { name?: string | null; tagNo?: string | null; expectedPickupAt?: string | null; inWarehouse?: number } = {};
  if ("name" in payload) {
    if (typeof payload.name !== "string" && payload.name !== null) throw new Error("name must be a string or null");
    // Match the staff inline-update contract: null and an empty string remain distinct stored values.
    update.name = typeof payload.name === "string" ? payload.name.trim() : null;
  }
  if ("tagNo" in payload) {
    if (typeof payload.tagNo !== "string" && payload.tagNo !== null) throw new Error("tagNo must be a string or null");
    const tagNo = payload.tagNo?.trim() ?? "";
    if (!tagNo) {
      update.tagNo = null;
    } else if (!/^\d+$/.test(tagNo) || Number(tagNo) < 1 || Number(tagNo) > 100) {
      throw new Error("tagNo must be an integer from 1 to 100");
    } else {
      update.tagNo = String(Number(tagNo));
    }
  }
  if ("expectedPickupAt" in payload) {
    if (typeof payload.expectedPickupAt !== "string" && payload.expectedPickupAt !== null) {
      throw new Error("expectedPickupAt must be an ISO timestamp with timezone or null");
    }
    update.expectedPickupAt = typeof payload.expectedPickupAt === "string" ? parseTimezoneIso(payload.expectedPickupAt) : null;
  }
  if ("inWarehouse" in payload) {
    if (typeof payload.inWarehouse !== "boolean") throw new Error("inWarehouse must be a boolean");
    update.inWarehouse = payload.inWarehouse ? 1 : 0;
  }
  return { actor, update };
}

function normalizeLuggagePricePayload(payload: unknown): {
  actor: LuggageNoteActor;
  update: { paymentMethod?: "CASH" | "PAY_QR"; flyingPassTier?: string; staffPrepaidOverrideAmount?: number | null };
} {
  const payloadKeys = new Set(["paymentMethod", "flyingPassTier", "staffPrepaidOverrideAmount", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain actor and only supported price fields");
  }
  if (!("paymentMethod" in payload) && !("flyingPassTier" in payload) && !("staffPrepaidOverrideAmount" in payload)) {
    throw new Error("At least one price field is required");
  }
  const actor = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  const update: { paymentMethod?: "CASH" | "PAY_QR"; flyingPassTier?: string; staffPrepaidOverrideAmount?: number | null } = {};
  if ("paymentMethod" in payload) {
    if (payload.paymentMethod !== "CASH" && payload.paymentMethod !== "PAY_QR") {
      throw new Error("paymentMethod must be CASH or PAY_QR");
    }
    update.paymentMethod = payload.paymentMethod;
  }
  if ("flyingPassTier" in payload) {
    if (typeof payload.flyingPassTier !== "string" || !FLYING_PASS_TIERS.includes(payload.flyingPassTier as typeof FLYING_PASS_TIERS[number])) {
      throw new Error("flyingPassTier is invalid");
    }
    update.flyingPassTier = normalizeFlyingPassTier(payload.flyingPassTier);
  }
  if ("staffPrepaidOverrideAmount" in payload) {
    const override = payload.staffPrepaidOverrideAmount;
    if (override !== null && (typeof override !== "number" || !Number.isInteger(override) || override < 0 || override > 500000)) {
      throw new Error("staffPrepaidOverrideAmount must be an integer from 0 to 500000 or null");
    }
    update.staffPrepaidOverrideAmount = override;
  }
  return { actor, update };
}

function normalizeLuggagePaymentStatusPayload(payload: unknown): {
  actor: LuggageNoteActor;
  targetStatus: LuggagePaymentStatus;
  payment?: { cashAmount: number; qrAmount: number };
} {
  const payloadKeys = new Set(["targetStatus", "payment", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("targetStatus" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain targetStatus, actor, and optional payment");
  }
  if (payload.targetStatus !== "PAYMENT_PENDING" && payload.targetStatus !== "PAID") {
    throw new Error("targetStatus must be PAYMENT_PENDING or PAID");
  }
  const actorPayload = normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor;
  if (payload.targetStatus === "PAYMENT_PENDING") {
    if ("payment" in payload) throw new Error("payment is only allowed when targetStatus is PAID");
    return { actor: actorPayload, targetStatus: payload.targetStatus };
  }
  if (!("payment" in payload)) {
    return { actor: actorPayload, targetStatus: payload.targetStatus };
  }
  if (!isPlainRecord(payload.payment) || !hasOnlyKeys(payload.payment, new Set(["cashAmount", "qrAmount"]))) {
    throw new Error("payment must contain only cashAmount and qrAmount");
  }
  const cashAmount = payload.payment.cashAmount;
  const qrAmount = payload.payment.qrAmount;
  if (
    typeof cashAmount !== "number"
    || typeof qrAmount !== "number"
    || !Number.isInteger(cashAmount)
    || cashAmount < 0
    || !Number.isInteger(qrAmount)
    || qrAmount < 0
  ) {
    throw new Error("payment amounts must be non-negative integers");
  }
  return { actor: actorPayload, targetStatus: payload.targetStatus, payment: { cashAmount, qrAmount } };
}

function normalizeLuggagePickupStatusPayload(payload: unknown): {
  action: LuggagePickupStatusAction;
  expectedUpdatedAt: string;
  actor: LuggagePickupStatusActor;
} {
  const payloadKeys = new Set(["action", "expectedUpdatedAt", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys)
    || !("action" in payload) || !("expectedUpdatedAt" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only action, expectedUpdatedAt, and actor");
  }
  if (payload.action !== "mark_picked_up" && payload.action !== "undo_picked_up") {
    throw new Error("action must be mark_picked_up or undo_picked_up");
  }
  if (typeof payload.expectedUpdatedAt !== "string" || !payload.expectedUpdatedAt.trim() || payload.expectedUpdatedAt.length > 100) {
    throw new Error("expectedUpdatedAt must be a non-empty string");
  }
  const actorKeys = new Set(["userId", "name", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)
    || !("userId" in payload.actor) || !("name" in payload.actor) || !("role" in payload.actor)) {
    throw new Error("actor must contain only userId, name, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_NOTE_ACTOR_ROLES.has(role)) throw new Error("actor.role is not allowed");
  return {
    action: payload.action,
    expectedUpdatedAt: payload.expectedUpdatedAt,
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      role: role as LuggageNoteActor["role"],
    },
  };
}

function normalizeLuggageExtensionCreatePayload(payload: unknown): {
  expectedUpdatedAt: string;
  actor: LuggageNoteActor;
} {
  const payloadKeys = new Set(["expectedUpdatedAt", "actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys)
    || !("expectedUpdatedAt" in payload) || !("actor" in payload)) {
    throw new Error("Body must contain only expectedUpdatedAt and actor");
  }
  if (typeof payload.expectedUpdatedAt !== "string" || !payload.expectedUpdatedAt.trim() || payload.expectedUpdatedAt.length > 100) {
    throw new Error("expectedUpdatedAt must be a non-empty string");
  }
  return {
    expectedUpdatedAt: payload.expectedUpdatedAt,
    actor: normalizeLuggageNotePayload({ note: null, actor: payload.actor }).actor,
  };
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return normalized;
}

function requiredInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function formatBusinessDateFromJst(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

function isSameJstDate(first: Date, second: Date): boolean {
  return first.getUTCFullYear() === second.getUTCFullYear()
    && first.getUTCMonth() === second.getUTCMonth()
    && first.getUTCDate() === second.getUTCDate();
}

function normalizeLuggageManualOrderCreatePayload(payload: unknown, serverNow: Date): LuggageManualOrderCreatePayload {
  const payloadKeys = new Set([
    "name", "phone", "suitcaseQty", "backpackQty", "companionCount", "expectedPickupAt",
    "flyingPassTier", "freeReason", "freeReasonText", "note", "actor",
  ]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys)
    || !["name", "phone", "suitcaseQty", "backpackQty", "companionCount", "expectedPickupAt", "flyingPassTier", "freeReason", "freeReasonText", "note", "actor"].every((key) => key in payload)) {
    throw new Error("Body must contain only the manual order fields and actor");
  }

  const actorKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_NOTE_ACTOR_ROLES.has(role)) throw new LuggageManualOrderActorForbiddenError("actor.role is not allowed");

  const suitcaseQty = requiredInteger(payload.suitcaseQty, "suitcaseQty", 0, 99);
  const backpackQty = requiredInteger(payload.backpackQty, "backpackQty", 0, 99);
  if (suitcaseQty === 0 && backpackQty === 0) throw new Error("At least one luggage item is required");
  const expectedPickupAt = parseTimezoneIso(requiredText(payload.expectedPickupAt, "expectedPickupAt", 100));
  const expectedPickupDate = new Date(expectedPickupAt);
  if (expectedPickupDate.getTime() < serverNow.getTime()) throw new Error("expectedPickupAt must not be in the past");
  const pickupWindow = validatePickupTimeWindow(expectedPickupDate);
  if (!pickupWindow.valid) throw new Error(pickupWindow.error ?? "expectedPickupAt is outside business hours");
  if (typeof payload.flyingPassTier !== "string" || !FLYING_PASS_TIERS.includes(payload.flyingPassTier as typeof FLYING_PASS_TIERS[number])) {
    throw new Error("flyingPassTier is invalid");
  }
  if (payload.freeReason !== "" && payload.freeReason !== "지인 접수" && payload.freeReason !== "블로거 방문" && payload.freeReason !== "쿠폰" && payload.freeReason !== "기타") {
    throw new Error("freeReason is invalid");
  }
  if (typeof payload.freeReasonText !== "string" || payload.freeReasonText.trim().length > 100) throw new Error("freeReasonText exceeds 100 characters");
  const freeReasonText = payload.freeReasonText.trim();
  if (payload.freeReason === "기타" && !freeReasonText) throw new Error("freeReasonText is required when freeReason is 기타");
  if (typeof payload.note !== "string" || payload.note.trim().length > 500) throw new Error("note exceeds 500 characters");

  return {
    name: requiredText(payload.name, "name", 100),
    phone: requiredText(payload.phone, "phone", 50),
    suitcaseQty,
    backpackQty,
    companionCount: requiredInteger(payload.companionCount, "companionCount", 0, 99),
    expectedPickupAt,
    flyingPassTier: normalizeFlyingPassTier(payload.flyingPassTier),
    freeReason: payload.freeReason,
    freeReasonText,
    note: payload.note.trim(),
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      email: requiredActorText(payload.actor.email, "email", 254),
      role: role as LuggageNoteActor["role"],
    },
  };
}

type LuggageImageActor = Omit<LuggageNoteActor, "role"> & { role: "center_staff" | "manager" | "super_admin" | "viewer" };

function normalizeLuggageImagePayload(payload: unknown): { actor: LuggageImageActor } {
  const payloadKeys = new Set(["actor"]);
  if (!isPlainRecord(payload) || !hasOnlyKeys(payload, payloadKeys) || !("actor" in payload)) {
    throw new Error("Body must contain only actor");
  }
  const actorKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(payload.actor) || !hasOnlyKeys(payload.actor, actorKeys)) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(payload.actor.role, "role", 50);
  if (!LUGGAGE_IMAGE_ACTOR_ROLES.has(role)) throw new Error("actor.role is not allowed");
  return {
    actor: {
      userId: requiredActorText(payload.actor.userId, "userId", 200),
      name: requiredActorText(payload.actor.name, "name", 100),
      email: requiredActorText(payload.actor.email, "email", 254),
      role: role as LuggageImageActor["role"],
    },
  };
}

function isAllowedImageContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  return ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"].includes(normalized);
}

function serializePaymentStatusOrder(order: LuggagePaymentStatusOrder): LuggagePaymentStatusResponse["order"] {
  return {
    orderId: order.orderId,
    status: order.status as LuggagePaymentStatus,
    paymentMethod: order.paymentMethod,
    paymentCashAmount: order.paymentCashAmount,
    paymentQrAmount: order.paymentQrAmount,
  };
}

function serializePaymentAuditActor(actor: LuggageNoteActor) {
  return { id: actor.userId, name: actor.name, email: actor.email };
}

// POST /internal/luggage-orders/:orderId/images/:kind — Private image stream for the unified admin.
internalApi.post("/internal/luggage-orders/:orderId/images/:kind", async (c) => {
  const orderId = c.req.param("orderId");
  const kind = c.req.param("kind");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }
  if (kind !== "id" && kind !== "luggage") return c.json({ error: "Invalid image kind" }, 400);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggageImagePayload>;
  try {
    normalized = normalizeLuggageImagePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const imageColumn = kind === "id" ? "id_image_url" : "luggage_image_url";
  const imageKey = await c.env.DB.prepare(
    `SELECT ${imageColumn} AS imageKey FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<{ imageKey: string | null }>();
  if (!imageKey?.imageKey?.trim()) return c.json({ error: "Image not found" }, 404);

  const image = await downloadImage(c.env.IMAGES, imageKey.imageKey);
  if (!image || !isAllowedImageContentType(image.contentType)) {
    return c.json({ error: "Image not found" }, 404);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
       VALUES (?, NULL, 'unified-admin', ?, ?, datetime('now'))`,
    ).bind(
      orderId,
      kind === "id" ? "UNIFIED_ADMIN_VIEW_ID_IMAGE" : "UNIFIED_ADMIN_VIEW_LUGGAGE_IMAGE",
      JSON.stringify({ actor: normalized.actor, kind }),
    ).run();
  } catch {
    return c.json({ error: "Unable to record image access" }, 500);
  }

  return new Response(image.body, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": "inline",
      "Content-Type": image.contentType,
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// POST /internal/luggage-orders/manual — Manual order creation for the unified admin.
// This intentionally does not call the staff HTML route; it reuses the same order,
// tag, storage, and pricing services while keeping the staff session contract intact.
internalApi.post("/internal/luggage-orders/manual", async (c) => {
  const serverNow = new Date();
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let input: LuggageManualOrderCreatePayload;
  try {
    input = normalizeLuggageManualOrderCreatePayload(payload, serverNow);
  } catch (error) {
    if (error instanceof LuggageManualOrderActorForbiddenError) {
      return c.json({ error: error.message }, 403);
    }
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const receivedJst = toJST(serverNow);
  const expectedPickupDate = new Date(input.expectedPickupAt);
  const expectedPickupJst = toJST(expectedPickupDate);
  const isOvernight = !isSameJstDate(receivedJst, expectedPickupJst);
  const businessDate = formatBusinessDateFromJst(receivedJst);
  const orderId = await buildOrderId(c.env.DB, serverNow, isOvernight);
  const tagNo = isOvernight
    ? await buildOvernightTag(c.env.DB, businessDate)
    : await buildSameDayTag(c.env.DB, businessDate);
  if (tagNo === null) return c.json({ error: "당일 태그(1-90)가 모두 사용 중입니다." }, 409);

  const { setQty, pricePerDay } = calculatePricePerDay(input.suitcaseQty, input.backpackQty);
  const expectedStorageDays = calculateStorageDays(serverNow, expectedPickupDate);
  const { discountRate, prepaidAmount: rawPrepaidAmount } = calculatePrepaidAmount(pricePerDay, expectedStorageDays);
  const isFree = input.freeReason !== "";
  const prepaidAmount = isFree ? 0 : rawPrepaidAmount;
  const flyingPassDiscount = isFree ? 0 : flyingPassDiscountAmount(prepaidAmount, input.flyingPassTier);
  const finalAmount = Math.max(0, prepaidAmount - flyingPassDiscount);
  const finalPricePerDay = isFree ? 0 : pricePerDay;
  const freeLabel = input.freeReason === "기타" ? input.freeReasonText : input.freeReason;
  const note = isFree
    ? `[무료: ${freeLabel}]${input.note ? ` ${input.note}` : ""}`
    : input.note;
  const nowIso = serverNow.toISOString();
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    actor: input.actor,
    suitcaseQty: input.suitcaseQty,
    backpackQty: input.backpackQty,
    expectedPickupAt: input.expectedPickupAt,
    tagNo,
    isOvernight,
    freeReason: input.freeReason,
    amounts: {
      pricePerDay: finalPricePerDay,
      expectedStorageDays,
      discountRate,
      prepaidAmount,
      flyingPassDiscountAmount: flyingPassDiscount,
      finalAmount,
    },
  });

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO luggage_orders (
           order_id, created_at, updated_at, name, phone, companion_count,
           suitcase_qty, backpack_qty, set_qty, expected_pickup_at, expected_storage_days,
           actual_storage_days, extra_days, price_per_day, discount_rate, prepaid_amount,
           flying_pass_tier, flying_pass_discount_amount, extra_amount, final_amount,
           payment_method, status, tag_no, note, manual_entry, staff_id,
           consent_checked, parent_order_id, in_warehouse, id_image_url, luggage_image_url
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 0, ?, NULL, 'PAYMENT_PENDING', ?, ?, 1, NULL, 1, NULL, 0, NULL, NULL
           WHERE ? = 1 OR NOT EXISTS (
             SELECT 1 FROM luggage_orders
             WHERE CAST(tag_no AS INTEGER) = CAST(? AS INTEGER)
               AND order_id LIKE ? || '-%'
               AND status IN ('PAYMENT_PENDING', 'PAID')
           )
           RETURNING order_id`,
      ).bind(
        orderId, nowIso, nowIso, input.name, input.phone, input.companionCount,
        input.suitcaseQty, input.backpackQty, setQty, input.expectedPickupAt, expectedStorageDays,
        finalPricePerDay, discountRate, prepaidAmount, input.flyingPassTier, flyingPassDiscount,
        finalAmount, tagNo, note || null, isOvernight ? 1 : 0, tagNo, businessDate,
      ),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_MANUAL_CREATE', ?, ?
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ?)`,
      ).bind(orderId, auditDetails, nowIso, orderId),
    ]);
    if (!results[0]?.results?.[0]) {
      return c.json({ error: "당일 태그가 다른 요청에 먼저 배정되었습니다. 다시 시도해 주세요." }, 409);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("unique") || message.includes("constraint")) {
      return c.json({ error: "주문 생성이 다른 요청과 충돌했습니다. 다시 시도해 주세요." }, 409);
    }
    return c.json({ error: "Manual luggage order creation failed" }, 500);
  }

  const order: LuggageOrderDto = {
    orderId,
    createdAt: nowIso,
    updatedAt: nowIso,
    name: input.name,
    phone: input.phone,
    email: null,
    suitcaseQty: input.suitcaseQty,
    backpackQty: input.backpackQty,
    setQty,
    expectedPickupAt: input.expectedPickupAt,
    actualPickupAt: null,
    expectedStorageDays,
    actualStorageDays: 0,
    extraDays: 0,
    prepaidAmount,
    finalAmount,
    extraAmount: 0,
    pricePerDay: finalPricePerDay,
    paymentMethod: null,
    status: "PAYMENT_PENDING",
    tagNo,
    note: note || null,
    manualEntry: 1,
    parentOrderId: null,
    inWarehouse: 0,
    flyingPassTier: input.flyingPassTier,
    flyingPassDiscountAmount: flyingPassDiscount,
    staffPrepaidOverrideAmount: null,
    paymentCashAmount: 0,
    paymentQrAmount: 0,
    hasIdImage: false,
    hasLuggageImage: false,
    extensions: [],
  };
  return c.json({ order }, 201);
});

// POST /internal/luggage-orders/:orderId/extensions — One-day manual extension for the unified admin.
// This stays separate from the staff HTML route so the existing /staff behavior is unchanged.
internalApi.post("/internal/luggage-orders/:orderId/extensions", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggageExtensionCreatePayload>;
  try {
    normalized = normalizeLuggageExtensionCreatePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const parent = await c.env.DB.prepare(
    `SELECT order_id AS orderId, parent_order_id AS parentOrderId, updated_at AS updatedAt, status, name, phone, email,
            companion_count AS companionCount, suitcase_qty AS suitcaseQty,
            backpack_qty AS backpackQty, tag_no AS tagNo, in_warehouse AS inWarehouse
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggageExtensionParentOrder>();
  if (!parent) return c.json({ error: "Luggage order not found" }, 404);
  if (parent.parentOrderId !== null) return c.json({ error: "Extension orders cannot be extended" }, 409);
  if (parent.status !== "PAYMENT_PENDING" && parent.status !== "PAID") {
    return c.json({ error: "Extension creation is not allowed for the current order status" }, 409);
  }
  if (parent.updatedAt !== normalized.expectedUpdatedAt) {
    return c.json({ error: "Luggage order was changed by another request" }, 409);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expectedPickupAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const extensionOrderId = `EXT-${await buildOrderId(c.env.DB, now, false, "ext")}`;
  const { setQty, pricePerDay } = calculatePricePerDay(parent.suitcaseQty, parent.backpackQty);
  const extensionNote = `연장 주문 (원본: ${orderId})`;
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    action: "create_manual_extension",
    parentOrderId: orderId,
    extensionOrderId,
    actor: normalized.actor,
  });

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE luggage_orders
         SET updated_at = ?
         WHERE order_id = ?
           AND parent_order_id IS NULL
           AND status IN ('PAYMENT_PENDING', 'PAID')
           AND updated_at = ?
         RETURNING updated_at AS updatedAt`,
      ).bind(nowIso, orderId, normalized.expectedUpdatedAt),
      c.env.DB.prepare(
        `INSERT INTO luggage_orders (
           order_id, created_at, updated_at, name, phone, email, companion_count,
           suitcase_qty, backpack_qty, set_qty, expected_pickup_at, expected_storage_days,
           actual_storage_days, extra_days, price_per_day, discount_rate, prepaid_amount,
           flying_pass_tier, flying_pass_discount_amount, staff_prepaid_override_amount,
           extra_amount, final_amount, payment_method, status, tag_no, note,
           manual_entry, staff_id, parent_order_id, in_warehouse
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, 0, ?, 'NONE', 0, NULL,
                0, ?, NULL, 'PAYMENT_PENDING', ?, ?, 1, NULL, ?, ?
         WHERE changes() = 1
         RETURNING order_id AS orderId, created_at AS createdAt, updated_at AS updatedAt,
                   name, phone, email, suitcase_qty AS suitcaseQty, backpack_qty AS backpackQty,
                   set_qty AS setQty, expected_pickup_at AS expectedPickupAt,
                   actual_pickup_at AS actualPickupAt, expected_storage_days AS expectedStorageDays,
                   actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                   prepaid_amount AS prepaidAmount, final_amount AS finalAmount,
                   extra_amount AS extraAmount, price_per_day AS pricePerDay,
                   payment_method AS paymentMethod, status, tag_no AS tagNo, note,
                   manual_entry AS manualEntry, parent_order_id AS parentOrderId,
                   in_warehouse AS inWarehouse, flying_pass_tier AS flyingPassTier,
                   flying_pass_discount_amount AS flyingPassDiscountAmount,
                   staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
                   0 AS paymentCashAmount, 0 AS paymentQrAmount,
                   0 AS hasIdImage, 0 AS hasLuggageImage`,
      ).bind(
        extensionOrderId, nowIso, nowIso, parent.name, parent.phone, parent.email, parent.companionCount,
        parent.suitcaseQty, parent.backpackQty, setQty, expectedPickupAt, pricePerDay, pricePerDay,
        pricePerDay, parent.tagNo ?? "", extensionNote, orderId, parent.inWarehouse,
      ),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_CREATE_EXTENSION', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ?)`,
      ).bind(extensionOrderId, auditDetails, extensionOrderId),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_CREATE_EXTENSION', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ?)`,
      ).bind(orderId, auditDetails, extensionOrderId),
    ]);
    const parentUpdate = results[0].results?.[0] as { updatedAt?: string } | undefined;
    const extension = results[1].results?.[0] as LuggageOrderDto | undefined;
    if (!parentUpdate || !extension) {
      return c.json({ error: "Luggage order was changed by another request" }, 409);
    }
    return c.json<LuggageExtensionCreateResponse>({
      parentUpdatedAt: parentUpdate.updatedAt ?? nowIso,
      order: { ...extension, extensions: [] },
    }, 201);
  } catch {
    return c.json({ error: "Unable to create luggage extension" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/payment-status — Explicit payment transition for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/payment-status", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggagePaymentStatusPayload>;
  try {
    normalized = normalizeLuggagePaymentStatusPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT o.order_id AS orderId, o.status, o.payment_method AS paymentMethod,
            date(o.created_at, '+9 hours') AS businessDate, o.prepaid_amount AS prepaidAmount,
            o.final_amount AS finalAmount, o.extra_amount AS extraAmount,
            COALESCE(SUM(CASE WHEN p.tender_type = 'CASH' THEN p.amount ELSE 0 END), 0) AS paymentCashAmount,
            COALESCE(SUM(CASE WHEN p.tender_type = 'PAY_QR' THEN p.amount ELSE 0 END), 0) AS paymentQrAmount
     FROM luggage_orders o
     LEFT JOIN luggage_order_payments p ON p.order_id = o.order_id
     WHERE o.order_id = ?
     GROUP BY o.order_id`,
  ).bind(orderId).first<LuggagePaymentStatusOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);
  if (current.status === normalized.targetStatus) {
    return c.json<LuggagePaymentStatusResponse>({ success: true, changed: false, order: serializePaymentStatusOrder(current) });
  }
  if ((current.status !== "PAYMENT_PENDING" && current.status !== "PAID")
    || !((current.status === "PAYMENT_PENDING" && normalized.targetStatus === "PAID")
      || (current.status === "PAID" && normalized.targetStatus === "PAYMENT_PENDING"))) {
    return c.json({ error: "Payment status transition is not allowed" }, 409);
  }
  if (normalized.targetStatus === "PAID" && !normalized.payment) {
    return c.json({ error: "payment is required when targetStatus is PAID" }, 400);
  }

  const before = serializePaymentStatusOrder(current);
  let after: LuggagePaymentStatusResponse["order"];
  let statements: D1PreparedStatement[];
  if (normalized.targetStatus === "PAID") {
    const payableAmount = payableAmountFromOrder({
      prepaid_amount: current.prepaidAmount,
      final_amount: current.finalAmount,
      extra_amount: current.extraAmount,
    });
    const allocation = normalizePaymentAllocation({
      cash_amount: normalized.payment?.cashAmount,
      qr_amount: normalized.payment?.qrAmount,
    }, payableAmount);
    if ("error" in allocation) return c.json({ error: allocation.error }, 400);
    after = { orderId, status: "PAID", paymentMethod: allocation.paymentMethod, paymentCashAmount: allocation.cashAmount, paymentQrAmount: allocation.qrAmount };
    const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: serializePaymentAuditActor(normalized.actor) });
    statements = [
      ...paymentAllocationStatements(c.env.DB, orderId, current.businessDate, null, allocation, "PAYMENT_PENDING"),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAYMENT_PENDING')`,
      ).bind(orderId, auditDetails, orderId),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET status = 'PAID', payment_method = ?, updated_at = datetime('now')
         WHERE order_id = ? AND status = 'PAYMENT_PENDING'
         RETURNING order_id AS orderId`,
      ).bind(allocation.paymentMethod, orderId),
    ];
  } else {
    after = { orderId, status: "PAYMENT_PENDING", paymentMethod: current.paymentMethod, paymentCashAmount: 0, paymentQrAmount: 0 };
    const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: serializePaymentAuditActor(normalized.actor) });
    statements = [
      c.env.DB.prepare(
        `DELETE FROM luggage_order_payments
         WHERE order_id = ? AND EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAID')`,
      ).bind(orderId, orderId),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PAYMENT_STATUS_UPDATE', ?, datetime('now')
         WHERE EXISTS (SELECT 1 FROM luggage_orders WHERE order_id = ? AND status = 'PAID')`,
      ).bind(orderId, auditDetails, orderId),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET status = 'PAYMENT_PENDING', updated_at = datetime('now')
         WHERE order_id = ? AND status = 'PAID'
         RETURNING order_id AS orderId`,
      ).bind(orderId),
    ];
  }
  try {
    const results = await c.env.DB.batch(statements);
    const updateResult = results[results.length - 1];
    if (!updateResult.results?.[0]) return c.json({ error: "Payment status was changed by another request" }, 409);
  } catch {
    return c.json({ error: "Unable to update payment status" }, 500);
  }
  return c.json<LuggagePaymentStatusResponse>({ success: true, changed: true, order: after });
});

// PATCH /internal/luggage-orders/:orderId/pickup-status — Pickup transition for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/pickup-status", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggagePickupStatusPayload>;
  try {
    normalized = normalizeLuggagePickupStatusPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, status, created_at AS createdAt,
            expected_pickup_at AS expectedPickupAt, actual_pickup_at AS actualPickupAt,
            price_per_day AS pricePerDay, actual_storage_days AS actualStorageDays,
            extra_days AS extraDays, extra_amount AS extraAmount, updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggagePickupStatusOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);
  if (current.updatedAt !== normalized.expectedUpdatedAt) {
    return c.json({ error: "Luggage order was changed by another request" }, 409);
  }

  const expectedStatus = normalized.action === "mark_picked_up" ? "PAID" : "PICKED_UP";
  const targetStatus: LuggagePickupStatusUpdateDto["status"] = normalized.action === "mark_picked_up" ? "PICKED_UP" : "PAID";
  if (current.status !== expectedStatus) {
    return c.json({ error: "Pickup status transition is not allowed" }, 409);
  }

  const now = new Date().toISOString();
  const actualPickupAt = normalized.action === "mark_picked_up" ? now : null;
  const actualStorageDays = normalized.action === "mark_picked_up"
    ? calculateStorageDays(current.createdAt, now)
    : 0;
  const extraDays = normalized.action === "mark_picked_up" && current.expectedPickupAt
    ? calculateExtraDays(current.expectedPickupAt, now)
    : 0;
  const extraAmount = normalized.action === "mark_picked_up"
    ? calculateExtraAmount(current.pricePerDay, extraDays)
    : 0;
  const before = {
    orderId,
    status: current.status,
    actualPickupAt: current.actualPickupAt,
    actualStorageDays: current.actualStorageDays,
    extraDays: current.extraDays,
    extraAmount: current.extraAmount,
  };
  const after = { orderId, status: targetStatus, actualPickupAt, actualStorageDays, extraDays, extraAmount };
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    action: normalized.action,
    before,
    after,
    actor: normalized.actor,
  });

  try {
    const results = await c.env.DB.batch([
      normalized.action === "mark_picked_up"
        ? c.env.DB.prepare(
          `UPDATE luggage_orders
           SET status = 'PICKED_UP', actual_pickup_at = ?, actual_storage_days = ?,
               extra_days = ?, extra_amount = ?, updated_at = datetime('now')
           WHERE order_id = ? AND status = 'PAID' AND updated_at = ?
           RETURNING order_id AS orderId, status, actual_pickup_at AS actualPickupAt,
                     actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                     extra_amount AS extraAmount, updated_at AS updatedAt`,
        ).bind(now, actualStorageDays, extraDays, extraAmount, orderId, current.updatedAt)
        : c.env.DB.prepare(
          `UPDATE luggage_orders
           SET status = 'PAID', actual_pickup_at = NULL, actual_storage_days = 0,
               extra_days = 0, extra_amount = 0, updated_at = datetime('now')
           WHERE order_id = ? AND status = 'PICKED_UP' AND updated_at = ?
           RETURNING order_id AS orderId, status, actual_pickup_at AS actualPickupAt,
                     actual_storage_days AS actualStorageDays, extra_days AS extraDays,
                     extra_amount AS extraAmount, updated_at AS updatedAt`,
        ).bind(orderId, current.updatedAt),
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PICKUP_STATUS_UPDATE', ?, datetime('now')
         WHERE changes() = 1
           AND EXISTS (
             SELECT 1 FROM luggage_orders
             WHERE order_id = ? AND status = ? AND updated_at = datetime('now')
               AND actual_pickup_at IS ? AND actual_storage_days = ?
               AND extra_days = ? AND extra_amount = ?
           )`,
      ).bind(orderId, auditDetails, orderId, targetStatus, actualPickupAt, actualStorageDays, extraDays, extraAmount),
    ]);
    const updatedRows = results[0].results ?? [];
    if (updatedRows.length !== 1) {
      return c.json({ error: "Luggage order was changed by another request" }, 409);
    }
    if (results[1].meta.changes !== 1) {
      return c.json({ error: "Unable to write pickup status audit log" }, 500);
    }
    const updated = updatedRows[0] as LuggagePickupStatusUpdateDto;
    return c.json({
      changed: true,
      orderId: updated.orderId,
      status: updated.status,
      actualPickupAt: updated.actualPickupAt,
      actualStorageDays: updated.actualStorageDays,
      extraDays: updated.extraDays,
      extraAmount: updated.extraAmount,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update pickup status" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/operations-fields — Limited operational field mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/operations-fields", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggageOperationsFieldsPayload>;
  try {
    normalized = normalizeLuggageOperationsFieldsPayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, status, name, tag_no AS tagNo, expected_pickup_at AS expectedPickupAt,
            in_warehouse AS inWarehouse, updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggageOperationsFieldsOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);

  const before = {
    orderId: current.orderId,
    name: current.name,
    tagNo: current.tagNo,
    expectedPickupAt: current.expectedPickupAt,
    inWarehouse: current.inWarehouse === 1,
  };
  const after = {
    orderId,
    name: "name" in normalized.update ? normalized.update.name! : current.name,
    tagNo: "tagNo" in normalized.update ? normalized.update.tagNo! : current.tagNo,
    expectedPickupAt: "expectedPickupAt" in normalized.update ? normalized.update.expectedPickupAt! : current.expectedPickupAt,
    inWarehouse: "inWarehouse" in normalized.update ? normalized.update.inWarehouse === 1 : current.inWarehouse === 1,
  };
  if (
    before.name === after.name
    && before.tagNo === after.tagNo
    && before.expectedPickupAt === after.expectedPickupAt
    && before.inWarehouse === after.inWarehouse
  ) {
    return c.json({
      changed: false,
      orderId: current.orderId,
      name: current.name,
      tagNo: current.tagNo,
      expectedPickupAt: current.expectedPickupAt,
      inWarehouse: current.inWarehouse === 1,
      updatedAt: current.updatedAt,
    });
  }

  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  if ("name" in normalized.update) {
    updates.push("name = ?");
    values.push(normalized.update.name ?? null);
  }
  if ("tagNo" in normalized.update) {
    updates.push("tag_no = ?");
    values.push(normalized.update.tagNo ?? null);
  }
  if ("expectedPickupAt" in normalized.update) {
    updates.push("expected_pickup_at = ?");
    values.push(normalized.update.expectedPickupAt ?? null);
  }
  if ("inWarehouse" in normalized.update) {
    updates.push("in_warehouse = ?");
    values.push(normalized.update.inWarehouse ?? 0);
  }
  const auditDetails = JSON.stringify({
    source: "unified-admin",
    before,
    after,
    actor: normalized.actor,
  });
  try {
    const results = await c.env.DB.batch<LuggageOperationsFieldsUpdateDto>([
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_OPERATION_FIELDS_UPDATE', ?, datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM luggage_orders
           WHERE order_id = ? AND updated_at = ? AND status = ?
             AND name IS ? AND tag_no IS ? AND expected_pickup_at IS ? AND in_warehouse = ?
         )`,
      ).bind(orderId, auditDetails, orderId, current.updatedAt, current.status, current.name, current.tagNo, current.expectedPickupAt, current.inWarehouse),
      c.env.DB.prepare(
        `UPDATE luggage_orders SET ${updates.join(", ")}, updated_at = datetime('now')
         WHERE order_id = ? AND updated_at = ? AND status = ?
           AND name IS ? AND tag_no IS ? AND expected_pickup_at IS ? AND in_warehouse = ?
         RETURNING order_id AS orderId, name, tag_no AS tagNo, expected_pickup_at AS expectedPickupAt,
                   in_warehouse AS inWarehouse, updated_at AS updatedAt`,
      ).bind(...values, orderId, current.updatedAt, current.status, current.name, current.tagNo, current.expectedPickupAt, current.inWarehouse),
    ]);
    const updated = results[1].results?.[0];
    if (!updated) return c.json({ error: "Luggage order was changed by another request" }, 409);
    return c.json({
      changed: true,
      orderId: updated.orderId,
      name: updated.name,
      tagNo: updated.tagNo,
      expectedPickupAt: updated.expectedPickupAt,
      inWarehouse: updated.inWarehouse === 1,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update luggage operation fields" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/price — Price configuration mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/price", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) return c.json({ error: "Invalid orderId" }, 400);
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let normalized: ReturnType<typeof normalizeLuggagePricePayload>;
  try {
    normalized = normalizeLuggagePricePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }
  const current = await c.env.DB.prepare(
    `SELECT order_id AS orderId, price_per_day AS pricePerDay, expected_storage_days AS expectedStorageDays,
            prepaid_amount AS prepaidAmount, final_amount AS finalAmount,
            flying_pass_tier AS flyingPassTier, flying_pass_discount_amount AS flyingPassDiscountAmount,
            payment_method AS paymentMethod, staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
            updated_at AS updatedAt
     FROM luggage_orders WHERE order_id = ?`,
  ).bind(orderId).first<LuggagePriceOrder>();
  if (!current) return c.json({ error: "Luggage order not found" }, 404);

  const flyingPassTier = normalizeFlyingPassTier(normalized.update.flyingPassTier ?? current.flyingPassTier);
  const paymentMethod = normalized.update.paymentMethod ?? current.paymentMethod ?? "CASH";
  if (paymentMethod !== "CASH" && paymentMethod !== "PAY_QR") return c.json({ error: "Invalid payment method" }, 400);
  const { finalPrepaid, flyingPassDiscountAmount } = recalculateOrderPrepaid(
    current.pricePerDay,
    current.expectedStorageDays,
    flyingPassTier,
  );
  const staffPrepaidOverrideAmount: number | null = "staffPrepaidOverrideAmount" in normalized.update
    ? normalized.update.staffPrepaidOverrideAmount ?? null
    : current.staffPrepaidOverrideAmount;
  const prepaidAmount = staffPrepaidOverrideAmount ?? finalPrepaid;
  const after = {
    orderId,
    paymentMethod,
    flyingPassTier,
    flyingPassDiscountAmount,
    prepaidAmount,
    finalAmount: prepaidAmount,
    staffPrepaidOverrideAmount,
  };
  const before = {
    orderId: current.orderId,
    paymentMethod: current.paymentMethod,
    flyingPassTier: current.flyingPassTier,
    flyingPassDiscountAmount: current.flyingPassDiscountAmount,
    prepaidAmount: current.prepaidAmount,
    finalAmount: current.finalAmount,
    staffPrepaidOverrideAmount: current.staffPrepaidOverrideAmount,
  };
  if (
    before.paymentMethod === after.paymentMethod
    && before.flyingPassTier === after.flyingPassTier
    && before.flyingPassDiscountAmount === after.flyingPassDiscountAmount
    && before.prepaidAmount === after.prepaidAmount
    && before.finalAmount === after.finalAmount
    && before.staffPrepaidOverrideAmount === after.staffPrepaidOverrideAmount
  ) {
    return c.json({
      changed: false,
      orderId: current.orderId,
      paymentMethod: current.paymentMethod,
      flyingPassTier: current.flyingPassTier,
      flyingPassDiscountAmount: current.flyingPassDiscountAmount,
      prepaidAmount: current.prepaidAmount,
      finalAmount: current.finalAmount,
      staffPrepaidOverrideAmount: current.staffPrepaidOverrideAmount,
      updatedAt: current.updatedAt,
    });
  }
  const auditDetails = JSON.stringify({ source: "unified-admin", before, after, actor: normalized.actor });
  try {
    const results = await c.env.DB.batch<LuggagePriceUpdateDto>([
      c.env.DB.prepare(
        `INSERT INTO luggage_audit_logs (order_id, staff_id, device_id, action, details, timestamp)
         SELECT ?, NULL, 'unified-admin', 'UNIFIED_ADMIN_PRICE_UPDATE', ?, datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM luggage_orders
           WHERE order_id = ? AND updated_at = ?
             AND price_per_day = ? AND expected_storage_days = ?
             AND prepaid_amount = ? AND final_amount IS ?
             AND flying_pass_tier IS ? AND flying_pass_discount_amount = ?
             AND payment_method IS ? AND staff_prepaid_override_amount IS ?
         )`,
      ).bind(orderId, auditDetails, orderId, current.updatedAt, current.pricePerDay, current.expectedStorageDays, current.prepaidAmount, current.finalAmount, current.flyingPassTier, current.flyingPassDiscountAmount, current.paymentMethod, current.staffPrepaidOverrideAmount),
      c.env.DB.prepare(
        `UPDATE luggage_orders
         SET payment_method = ?, flying_pass_tier = ?, flying_pass_discount_amount = ?,
             prepaid_amount = ?, final_amount = ?, staff_prepaid_override_amount = ?, updated_at = datetime('now')
         WHERE order_id = ? AND updated_at = ?
           AND price_per_day = ? AND expected_storage_days = ?
           AND prepaid_amount = ? AND final_amount IS ?
           AND flying_pass_tier IS ? AND flying_pass_discount_amount = ?
           AND payment_method IS ? AND staff_prepaid_override_amount IS ?
         RETURNING order_id AS orderId, payment_method AS paymentMethod, flying_pass_tier AS flyingPassTier,
                   flying_pass_discount_amount AS flyingPassDiscountAmount, prepaid_amount AS prepaidAmount,
                   final_amount AS finalAmount, staff_prepaid_override_amount AS staffPrepaidOverrideAmount,
                   updated_at AS updatedAt`,
      ).bind(after.paymentMethod, after.flyingPassTier, after.flyingPassDiscountAmount, after.prepaidAmount, after.finalAmount, after.staffPrepaidOverrideAmount, orderId, current.updatedAt, current.pricePerDay, current.expectedStorageDays, current.prepaidAmount, current.finalAmount, current.flyingPassTier, current.flyingPassDiscountAmount, current.paymentMethod, current.staffPrepaidOverrideAmount),
    ]);
    const updated = results[1].results?.[0];
    if (!updated) return c.json({ error: "Luggage order price was changed by another request" }, 409);
    return c.json({
      changed: true,
      orderId: updated.orderId,
      paymentMethod: updated.paymentMethod,
      flyingPassTier: updated.flyingPassTier,
      flyingPassDiscountAmount: updated.flyingPassDiscountAmount,
      prepaidAmount: updated.prepaidAmount,
      finalAmount: updated.finalAmount,
      staffPrepaidOverrideAmount: updated.staffPrepaidOverrideAmount,
      updatedAt: updated.updatedAt,
    });
  } catch {
    return c.json({ error: "Unable to update luggage price" }, 500);
  }
});

// PATCH /internal/luggage-orders/:orderId/note — Note-only mutation for the unified admin.
internalApi.patch("/internal/luggage-orders/:orderId/note", async (c) => {
  const orderId = c.req.param("orderId");
  if (orderId.length > 32 || !LUGGAGE_ORDER_ID_PATTERN.test(orderId)) {
    return c.json({ error: "Invalid orderId" }, 400);
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  let normalized: ReturnType<typeof normalizeLuggageNotePayload>;
  try {
    normalized = normalizeLuggageNotePayload(payload);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request body" }, 400);
  }

  const current = await c.env.DB.prepare(
    "SELECT note, updated_at AS updatedAt FROM luggage_orders WHERE order_id = ?",
  ).bind(orderId).first<{ note: string | null; updatedAt: string }>();
  if (!current) {
    return c.json({ error: "Luggage order not found" }, 404);
  }
  if (current.note === normalized.note) {
    return c.json({
      orderId,
      note: current.note,
      updatedAt: current.updatedAt,
    });
  }

  const auditDetails = JSON.stringify({
    before: current.note,
    after: normalized.note,
    actor: normalized.actor,
  });
  const [updateResult] = await c.env.DB.batch<LuggageNoteUpdateDto>([
    c.env.DB.prepare(
      `UPDATE luggage_orders
       SET note = ?, updated_at = datetime('now')
       WHERE order_id = ?
       RETURNING order_id AS orderId, note, updated_at AS updatedAt`,
    ).bind(normalized.note, orderId),
    c.env.DB.prepare(
      `INSERT INTO luggage_audit_logs
         (order_id, staff_id, device_id, action, details, timestamp)
       VALUES (?, NULL, 'unified-admin', 'UNIFIED_ADMIN_NOTE_UPDATE', ?, datetime('now'))`,
    ).bind(orderId, auditDetails),
  ]);
  const updated = updateResult.results[0];
  if (!updated) {
    return c.json({ error: "Luggage order not found" }, 404);
  }

  return c.json({
    orderId: updated.orderId,
    note: updated.note,
    updatedAt: updated.updatedAt,
  });
});

type ExperienceUpsertPayload = {
  benefitAmount?: unknown;
  benefitLabel?: unknown;
  benefitType?: unknown;
  createdByStaffId?: unknown;
  externalId?: unknown;
  note?: unknown;
  piiMaskedAt?: unknown;
  scheduledDate?: unknown;
  scheduledTime?: unknown;
  visitorName?: unknown;
  visitorType?: unknown;
};

function asOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new Error(`Text field exceeds ${maxLength} characters`);
  }
  return text;
}

function asRequiredText(value: unknown, field: string, maxLength: number): string {
  const text = asOptionalText(value, maxLength);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function asDate(value: unknown, field: string): string {
  const text = asRequiredText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} is not a valid date`);
  }
  // JS Date auto-rolls over semantically invalid calendar dates (e.g. 2026-02-30
  // becomes 2026-03-02). Regex alone passes these, so confirm the parsed value
  // serialises back to the exact input before accepting.
  if (!parsed.toISOString().startsWith(text)) {
    throw new Error(`${field} is not a valid calendar date`);
  }
  return text;
}

function asOptionalEnum(
  value: unknown,
  allowedValues: Set<string>,
  field: string,
): string | null {
  const text = asOptionalText(value, 100);
  if (!text) return null;
  if (!allowedValues.has(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeUpsertPayload(payload: ExperienceUpsertPayload) {
  return {
    benefitAmount: asOptionalText(payload.benefitAmount, 100),
    benefitLabel: asOptionalText(payload.benefitLabel, 200),
    benefitType:
      asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType") ?? "REVIEWER_EXPERIENCE",
    createdByStaffId: asOptionalText(payload.createdByStaffId, 100) ?? "system:reviewer",
    externalId: asRequiredText(payload.externalId, "externalId", 120),
    note: asOptionalText(payload.note, 500),
    piiMaskedAt: asOptionalText(payload.piiMaskedAt, 50),
    scheduledDate: asDate(payload.scheduledDate, "scheduledDate"),
    scheduledTime: asOptionalText(payload.scheduledTime, 50),
    visitorName: asRequiredText(payload.visitorName, "visitorName", 100),
    visitorType:
      asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER",
  };
}

// GET /internal/luggage-experience-visits — Read-only experience visit list for the integrated admin.
internalApi.get("/internal/luggage-experience-visits", async (c) => {
  c.header("Cache-Control", "no-store");
  const search = c.req.query("search")?.trim() ?? "";
  const status = c.req.query("status")?.trim() ?? "";
  const visitorType = c.req.query("visitorType")?.trim() ?? "";
  const benefitType = c.req.query("benefitType")?.trim() ?? "";
  const sortQuery = c.req.query("sort")?.trim() ?? "newest";
  if ((status && !EXPERIENCE_STATUSES.has(status))
    || (visitorType && !EXPERIENCE_VISITOR_TYPES.has(visitorType))
    || (benefitType && !EXPERIENCE_BENEFIT_TYPES.has(benefitType))
    || !EXPERIENCE_VISIT_SORTS.has(sortQuery)) {
    return c.json({ error: "invalid experience visit query" }, 400);
  }
  const limitQuery = c.req.query("limit");
  const limit = limitQuery?.trim() === "0" ? 50 : parsePaginationQuery(limitQuery, 50, 200);
  const offset = parsePaginationQuery(c.req.query("offset"), 0);
  const clauses: string[] = [];
  const params: string[] = [];

  if (search) {
    const like = `%${escapeLike(search)}%`;
    clauses.push("(visitor_name LIKE ? ESCAPE '\\' OR benefit_label LIKE ? ESCAPE '\\' OR benefit_amount LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR received_by LIKE ? ESCAPE '\\' OR external_id LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like, like);
  }
  if (status) { clauses.push("status = ?"); params.push(status); }
  if (visitorType) { clauses.push("visitor_type = ?"); params.push(visitorType); }
  if (benefitType) { clauses.push("benefit_type = ?"); params.push(benefitType); }

  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const direction = sortQuery === "oldest" ? "ASC" : "DESC";
  const orderBy = `scheduled_date ${direction}, scheduled_time ${direction}, created_at ${direction}, visit_id ${direction}`;
  const [visitsResult, totalResult] = await Promise.all([
    c.env.DB.prepare(
      `SELECT visit_id AS visitId, visitor_name AS visitorName, visitor_type AS visitorType,
              scheduled_date AS scheduledDate, scheduled_time AS scheduledTime,
              benefit_type AS benefitType, benefit_label AS benefitLabel, benefit_amount AS benefitAmount,
              external_id AS externalId, status, note, created_by_staff_id AS createdByStaffId,
              processed_by_staff_id AS processedByStaffId, received_by AS receivedBy,
              received_at AS receivedAt, pii_masked_at AS piiMaskedAt,
              created_at AS createdAt, updated_at AS updatedAt
       FROM luggage_experience_visits${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all<LuggageExperienceVisitRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM luggage_experience_visits${where}`)
      .bind(...params).first<{ total: number }>(),
  ]);
  let staffNames = new Map<string, string>();
  try {
    staffNames = await fetchStaffNamesByIds(
      c.env,
      visitsResult.results.flatMap((visit) => [visit.createdByStaffId, visit.processedByStaffId]),
    );
  } catch {
    // Profile enrichment is optional; the visit rows remain available with ID-based fallbacks.
  }
  const visits: LuggageExperienceVisitDto[] = visitsResult.results.map((visit) => ({
    visitId: visit.visitId,
    visitorName: visit.visitorName,
    visitorType: visit.visitorType,
    scheduledDate: visit.scheduledDate,
    scheduledTime: visit.scheduledTime,
    benefitType: visit.benefitType,
    benefitLabel: visit.benefitLabel,
    benefitAmount: visit.benefitAmount,
    externalId: visit.externalId,
    status: visit.status,
    note: visit.note,
    registeredByStaffId: visit.createdByStaffId,
    registeredByStaffName: visit.createdByStaffId
      ? staffNames.get(visit.createdByStaffId) ?? visit.createdByStaffId
      : "작성자 미상",
    processedByStaffId: visit.processedByStaffId,
    processedByStaffName: visit.processedByStaffId
      ? staffNames.get(visit.processedByStaffId) ?? visit.receivedBy ?? visit.processedByStaffId
      : visit.receivedBy ?? "—",
    receivedBy: visit.receivedBy,
    receivedAt: visit.receivedAt,
    piiMaskedAt: visit.piiMaskedAt,
    createdAt: visit.createdAt,
    updatedAt: visit.updatedAt,
  }));
  return c.json({ visits, total: totalResult?.total ?? 0, limit, offset });
});

internalApi.get("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");
  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  if (!row) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  return c.json({ visit: serializeVisit(row) });
});

async function upsertExperienceVisit(
  db: D1Database,
  normalized: ReturnType<typeof normalizeUpsertPayload>,
) {
  await db.prepare(
    `INSERT INTO luggage_experience_visits (
       visitor_name, visitor_type, scheduled_date, scheduled_time,
       benefit_type, benefit_label, benefit_amount, external_id,
       status, note, created_by_staff_id, pii_masked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
       visitor_name = excluded.visitor_name,
       visitor_type = excluded.visitor_type,
       scheduled_date = excluded.scheduled_date,
       scheduled_time = excluded.scheduled_time,
       benefit_type = COALESCE(excluded.benefit_type, luggage_experience_visits.benefit_type),
       benefit_label = COALESCE(excluded.benefit_label, luggage_experience_visits.benefit_label),
       benefit_amount = COALESCE(excluded.benefit_amount, luggage_experience_visits.benefit_amount),
       note = COALESCE(excluded.note, luggage_experience_visits.note),
       pii_masked_at = COALESCE(excluded.pii_masked_at, luggage_experience_visits.pii_masked_at),
       updated_at = datetime('now')`,
  ).bind(
    normalized.visitorName,
    normalized.visitorType,
    normalized.scheduledDate,
    normalized.scheduledTime,
    normalized.benefitType,
    normalized.benefitLabel,
    normalized.benefitAmount,
    normalized.externalId,
    normalized.note,
    normalized.createdByStaffId,
    normalized.piiMaskedAt,
  ).run();
}

// PUT is the right verb for an idempotent, client-addressed upsert: the
// externalId lives in the URL, the resource state lives in the body, and a
// replay produces an identical result. POST was the initial design but made
// 201-vs-200 ambiguous; PUT makes the create-or-update distinction explicit
// via the pre-check below.
internalApi.put("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");
  let payload: ExperienceUpsertPayload;
  try {
    payload = await c.req.json<ExperienceUpsertPayload>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (payload.externalId !== undefined && payload.externalId !== externalId) {
    return c.json({ error: "externalId in URL and body must match" }, 400);
  }

  let normalized: ReturnType<typeof normalizeUpsertPayload>;
  try {
    normalized = normalizeUpsertPayload({ ...payload, externalId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const existed = await c.env.DB.prepare(
    "SELECT 1 FROM luggage_experience_visits WHERE external_id = ? LIMIT 1",
  ).bind(externalId).first();

  await upsertExperienceVisit(c.env.DB, normalized);

  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(normalized.externalId).first<Record<string, unknown>>();

  return c.json({ visit: serializeVisit(row) }, existed ? 200 : 201);
});

internalApi.post("/internal/experience/batch", async (c) => {
  let payload: ExperienceUpsertPayload[];
  try {
    payload = await c.req.json<ExperienceUpsertPayload[]>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    return c.json({ error: "Batch payload must be a non-empty array" }, 400);
  }
  if (payload.length > 50) {
    return c.json({ error: "Batch payload cannot exceed 50 items" }, 400);
  }

  const results: Array<{ error?: string; externalId?: string; ok: boolean }> = [];

  for (const entry of payload) {
    try {
      const normalized = normalizeUpsertPayload(entry);
      await upsertExperienceVisit(c.env.DB, normalized);
      results.push({ externalId: normalized.externalId, ok: true });
    } catch (error) {
      results.push({
        error: error instanceof Error ? error.message : String(error),
        externalId: typeof entry.externalId === "string" ? entry.externalId : undefined,
        ok: false,
      });
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  return c.json(
    {
      failed,
      results,
      succeeded: results.length - failed,
    },
    failed > 0 ? 207 : 200,
  );
});

internalApi.patch("/internal/experience/:externalId", async (c) => {
  const externalId = c.req.param("externalId");

  let payload: Record<string, unknown>;
  try {
    payload = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates: string[] = [];
  const values: Array<string | null> = [];

  try {
    if ("visitorName" in payload) {
      updates.push("visitor_name = ?");
      values.push(asRequiredText(payload.visitorName, "visitorName", 100));
    }
    if ("visitorType" in payload) {
      updates.push("visitor_type = ?");
      values.push(asOptionalEnum(payload.visitorType, EXPERIENCE_VISITOR_TYPES, "visitorType") ?? "OTHER");
    }
    if ("scheduledDate" in payload) {
      updates.push("scheduled_date = ?");
      values.push(asDate(payload.scheduledDate, "scheduledDate"));
    }
    if ("scheduledTime" in payload) {
      updates.push("scheduled_time = ?");
      values.push(asOptionalText(payload.scheduledTime, 50));
    }
    if ("benefitType" in payload) {
      updates.push("benefit_type = ?");
      values.push(asOptionalEnum(payload.benefitType, EXPERIENCE_BENEFIT_TYPES, "benefitType"));
    }
    if ("benefitLabel" in payload) {
      updates.push("benefit_label = ?");
      values.push(asOptionalText(payload.benefitLabel, 200));
    }
    if ("benefitAmount" in payload) {
      updates.push("benefit_amount = ?");
      values.push(asOptionalText(payload.benefitAmount, 100));
    }
    if ("note" in payload) {
      updates.push("note = ?");
      values.push(asOptionalText(payload.note, 500));
    }
    if ("piiMaskedAt" in payload) {
      updates.push("pii_masked_at = ?");
      values.push(asOptionalText(payload.piiMaskedAt, 50));
    }
    if ("status" in payload) {
      const status = asRequiredText(payload.status, "status", 20);
      if (!EXPERIENCE_STATUSES.has(status)) {
        throw new Error("status is invalid");
      }
      updates.push("status = ?");
      values.push(status);
    }
    if ("receivedBy" in payload) {
      updates.push("received_by = ?");
      values.push(asOptionalText(payload.receivedBy, 100));
    }
    if ("receivedAt" in payload) {
      updates.push("received_at = ?");
      values.push(asOptionalText(payload.receivedAt, 50));
    }
    if ("processedByStaffId" in payload) {
      updates.push("processed_by_staff_id = ?");
      values.push(asOptionalText(payload.processedByStaffId, 100));
    }
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  if (updates.length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(externalId);

  const result = await c.env.DB.prepare(
    `UPDATE luggage_experience_visits
     SET ${updates.join(", ")}
     WHERE external_id = ?`,
  ).bind(...values).run();

  if (!result.meta.changes) {
    return c.json({ error: "Experience visit not found" }, 404);
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM luggage_experience_visits WHERE external_id = ?",
  ).bind(externalId).first<Record<string, unknown>>();

  return c.json({ visit: serializeVisit(row) });
});

export default internalApi;
