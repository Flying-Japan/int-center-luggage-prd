import type { Context } from "hono";
import type { AppType, CustomerSession } from "../types";

export type CustomerProfile = {
  accountPersonId: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  identityVerifiedAt: string | null;
};

export type RecentCustomerOrder = {
  orderId: string;
  createdAt: string;
  suitcaseQty: number;
  backpackQty: number;
  companionCount: number;
  paymentMethod: string | null;
  grossAmount: number;
  pointDiscountAmount: number;
  finalAmount: number;
  status: string;
};

export type CustomerContext = {
  session: CustomerSession | null;
  profile: CustomerProfile | null;
  recentOrders: RecentCustomerOrder[];
  pointBalance: number;
  isAuthenticated: boolean;
};

export type CustomerIntakeIdentity = {
  accountPersonId: string | null;
  name: string;
  phone: string;
  email: string;
};

type ProfileRow = {
  account_person_id: string;
  display_name: string | null;
  phone: string | null;
  email: string | null;
  locale: string | null;
  identity_verified_at: string | null;
};

type RecentOrderRow = {
  order_id: string;
  created_at: string;
  suitcase_qty: number | null;
  backpack_qty: number | null;
  companion_count: number | null;
  payment_method: string | null;
  gross_amount: number | null;
  prepaid_amount: number | null;
  point_discount_amount: number | null;
  final_amount: number | null;
  status: string;
};

type PointAccountRow = {
  balance_points: number | null;
};

type SourcePresetRow = {
  order_id: string;
};

export function getCurrentCustomer(c: Context<AppType>): CustomerSession | null {
  return c.get("customer") ?? null;
}

export function resolveCustomerIntakeIdentity(input: {
  session: CustomerSession | null;
  formName: string;
  formPhone: string;
  formEmail: string;
}): CustomerIntakeIdentity {
  return {
    accountPersonId: input.session?.personId ?? null,
    name: firstNonBlank(input.session?.displayName, input.formName),
    phone: firstNonBlank(input.session?.phone, input.formPhone),
    email: firstNonBlank(input.session?.email, input.formEmail),
  };
}

export async function loadCustomerContext(c: Context<AppType>, limit = 3): Promise<CustomerContext> {
  const session = getCurrentCustomer(c);
  if (!session) {
    return {
      session: null,
      profile: null,
      recentOrders: [],
      pointBalance: 0,
      isAuthenticated: false,
    };
  }

  const [profile, recentOrders, pointBalance] = await Promise.all([
    loadCustomerProfile(c.env.DB, session.personId),
    loadRecentCustomerOrders(c.env.DB, session.personId, limit),
    loadPointBalance(c.env.DB, session.personId),
  ]);

  return {
    session,
    profile,
    recentOrders,
    pointBalance,
    isAuthenticated: true,
  };
}

export async function loadCustomerProfile(db: D1Database, accountPersonId: string): Promise<CustomerProfile | null> {
  const row = await db.prepare(
    `SELECT account_person_id, display_name, phone, email, locale, identity_verified_at
     FROM luggage_customer_profiles
     WHERE account_person_id = ?
     LIMIT 1`
  ).bind(accountPersonId).first<ProfileRow>();

  if (!row) return null;
  return {
    accountPersonId: row.account_person_id,
    displayName: row.display_name ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    locale: row.locale ?? null,
    identityVerifiedAt: row.identity_verified_at ?? null,
  };
}

export async function loadRecentCustomerOrders(
  db: D1Database,
  accountPersonId: string,
  limit = 3
): Promise<RecentCustomerOrder[]> {
  const safeLimit = clampLimit(limit);
  const rows = await db.prepare(
    `SELECT
       order_id,
       created_at,
       suitcase_qty,
       backpack_qty,
       companion_count,
       payment_method,
       gross_amount,
       prepaid_amount,
       point_discount_amount,
       final_amount,
       status
     FROM luggage_orders
     WHERE account_person_id = ?
       AND parent_order_id IS NULL
       AND status IN ('PAID', 'PICKED_UP', 'PAYMENT_PENDING')
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(accountPersonId, safeLimit).all<RecentOrderRow>();

  return rows.results.map((row) => {
    const grossAmount = numberOrZero(row.gross_amount) || numberOrZero(row.prepaid_amount);
    return {
      orderId: row.order_id,
      createdAt: row.created_at,
      suitcaseQty: numberOrZero(row.suitcase_qty),
      backpackQty: numberOrZero(row.backpack_qty),
      companionCount: numberOrZero(row.companion_count),
      paymentMethod: row.payment_method ?? null,
      grossAmount,
      pointDiscountAmount: numberOrZero(row.point_discount_amount),
      finalAmount: numberOrZero(row.final_amount),
      status: row.status,
    };
  });
}

export async function loadPointBalance(db: D1Database, accountPersonId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT balance_points
     FROM luggage_customer_point_accounts
     WHERE account_person_id = ?
     LIMIT 1`
  ).bind(accountPersonId).first<PointAccountRow>();

  return numberOrZero(row?.balance_points);
}

export async function verifyOwnedSourcePresetOrder(
  db: D1Database,
  accountPersonId: string,
  sourcePresetOrderId: string
): Promise<string | null> {
  const cleaned = sourcePresetOrderId.trim();
  if (!cleaned) return null;

  const row = await db.prepare(
    `SELECT order_id
     FROM luggage_orders
     WHERE order_id = ?
       AND account_person_id = ?
       AND parent_order_id IS NULL
     LIMIT 1`
  ).bind(cleaned, accountPersonId).first<SourcePresetRow>();

  return row?.order_id ?? null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 3;
  return Math.max(1, Math.min(10, Math.floor(limit)));
}

function numberOrZero(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const cleaned = value?.trim();
    if (cleaned) return cleaned;
  }
  return "";
}
