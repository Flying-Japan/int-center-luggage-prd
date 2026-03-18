import { type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";

/** Staff user from user_profiles table */
export type StaffUser = {
  id: string;
  display_name: string | null;
  username: string | null;
  is_active: number;
  role: string;
  created_at: string;
};

type AppContext = Context<{ Bindings: Env; Variables: { staff: StaffUser } }>;

const SESSION_COOKIE = "luggage_session";
const SESSION_MAX_AGE = 60 * 60 * 12; // 12 hours

/**
 * Set session cookie with user_id after successful login.
 */
export function setSession(c: AppContext, userId: string) {
  const payload = btoa(JSON.stringify({ user_id: userId, exp: Date.now() + SESSION_MAX_AGE * 1000 }));
  setCookie(c, SESSION_COOKIE, payload, {
    httpOnly: true,
    secure: c.env.APP_ENV === "production",
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

/**
 * Clear session cookie on logout.
 */
export function clearSession(c: AppContext) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Read user_id from session cookie. Returns null if expired or invalid.
 */
function readSession(c: AppContext): string | null {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const data = JSON.parse(atob(raw)) as { user_id: string; exp: number };
    if (data.exp < Date.now()) return null;
    return data.user_id;
  } catch {
    return null;
  }
}

/**
 * Get current authenticated staff user from session cookie + D1 lookup.
 * Returns null if not authenticated.
 */
export async function getCurrentStaff(c: AppContext): Promise<StaffUser | null> {
  const userId = readSession(c);
  if (!userId) return null;

  const staff = await c.env.DB.prepare(
    "SELECT id, display_name, username, is_active, role, created_at FROM user_profiles WHERE id = ?"
  )
    .bind(userId)
    .first<StaffUser>();

  if (!staff || !staff.is_active) {
    clearSession(c);
    return null;
  }

  return staff;
}

/**
 * Middleware: require staff authentication. Redirects to login if not authenticated.
 */
export async function staffAuth(c: AppContext, next: Next) {
  const staff = await getCurrentStaff(c);
  if (!staff) {
    return c.redirect("/staff/login");
  }
  c.set("staff", staff);
  await next();
}

/**
 * Middleware: require admin role.
 */
/**
 * Get staff user from Hono context. Use after staffAuth middleware.
 */
export function getStaff(c: { get: (key: "staff") => StaffUser }): StaffUser {
  return c.get("staff");
}

/**
 * Insert an audit log entry.
 */
export async function insertAuditLog(
  db: D1Database,
  orderId: string,
  staffId: string,
  action: string,
  details?: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO luggage_audit_logs (order_id, staff_id, action, details, timestamp) VALUES (?, ?, ?, ?, datetime('now'))"
    )
    .bind(orderId, staffId, action, details ?? null)
    .run();
}

export async function adminAuth(c: AppContext, next: Next) {
  const existing = c.get("staff") as StaffUser | undefined;
  const staff = existing ?? (await getCurrentStaff(c));
  if (!staff) {
    return c.redirect("/staff/login");
  }
  if (staff.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }
  if (!existing) {
    c.set("staff", staff);
  }
  await next();
}
