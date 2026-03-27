import { type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { createSupabaseAdmin } from "../lib/supabase";

/** Staff user from Supabase PG user_profiles table */
export type StaffUser = {
  id: string;
  display_name: string | null;
  username: string | null;
  is_active: boolean;
  role: string;
  created_at: string;
};

type AppContext = Context<{ Bindings: Env; Variables: { staff: StaffUser } }>;

const SESSION_COOKIE = "luggage_session";
const SESSION_MAX_AGE = 60 * 60 * 12; // 12 hours

/** Compute HMAC-SHA256 hex signature for a payload string. */
async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify HMAC-SHA256 signature using constant-time comparison. */
async function hmacVerify(payload: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(payload, secret);
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Set session cookie with user_id after successful login (HMAC-signed).
 */
export async function setSession(c: AppContext, userId: string) {
  if (!c.env.APP_SECRET_KEY) throw new Error("APP_SECRET_KEY is not configured");
  const payload = btoa(JSON.stringify({ user_id: userId, exp: Date.now() + SESSION_MAX_AGE * 1000 }));
  const sig = await hmacSign(payload, c.env.APP_SECRET_KEY);
  setCookie(c, SESSION_COOKIE, `${payload}.${sig}`, {
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
 * Read user_id from session cookie. Returns null if expired, invalid, or tampered.
 */
async function readSession(c: AppContext): Promise<string | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  try {
    const dotIdx = raw.lastIndexOf(".");
    if (dotIdx === -1) return null; // unsigned cookie (legacy) → reject
    const payload = raw.slice(0, dotIdx);
    const sig = raw.slice(dotIdx + 1);
    if (!await hmacVerify(payload, sig, c.env.APP_SECRET_KEY)) return null;
    const data = JSON.parse(atob(payload)) as { user_id: string; exp: number };
    if (data.exp < Date.now()) return null;
    return data.user_id;
  } catch {
    return null;
  }
}

/**
 * Get current authenticated staff user from session cookie + Supabase PG lookup.
 * Returns null if not authenticated.
 */
export async function getCurrentStaff(c: AppContext): Promise<StaffUser | null> {
  // Return cached profile if already fetched this request
  const cached = c.get("staff") as StaffUser | undefined;
  if (cached) return cached;

  const userId = await readSession(c);
  if (!userId) return null;

  const supabaseAdmin = createSupabaseAdmin(c.env);
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("id, display_name, username, is_active, role, created_at")
    .eq("id", userId)
    .single();

  if (error || !data || !data.is_active) {
    clearSession(c);
    return null;
  }

  const staff: StaffUser = {
    id: data.id,
    display_name: data.display_name,
    username: data.username,
    is_active: data.is_active,
    role: data.role,
    created_at: data.created_at,
  };

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
    return c.html(
      `<html><head><meta charset="UTF-8"><title>접근 불가</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 16px;background:#f8fafc"><h1 style="font-size:48px;color:#1e293b;margin:0">403</h1><p style="color:#64748b;margin:12px 0 24px">관리자 권한이 필요합니다</p><a href="/staff/dashboard" style="display:inline-block;padding:10px 24px;background:#2383e2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">대시보드로 이동</a></body></html>`,
      403
    );
  }
  if (!existing) {
    c.set("staff", staff);
  }
  await next();
}

export async function editorAuth(c: AppContext, next: Next) {
  const existing = c.get("staff") as StaffUser | undefined;
  const staff = existing ?? (await getCurrentStaff(c));
  if (!staff) {
    return c.redirect("/staff/login");
  }
  if (staff.role !== "admin" && staff.role !== "editor") {
    return c.json({ error: "Editor or Admin required" }, 403);
  }
  if (!existing) {
    c.set("staff", staff);
  }
  await next();
}
