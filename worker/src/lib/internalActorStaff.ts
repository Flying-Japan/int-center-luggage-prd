import type { Context, Next } from "hono";
import type { AppType, Env } from "../types";
import { createSupabaseAdmin } from "./supabase";

// Unified admin roles allowed to request operational-record writes. The unified
// admin checks this too; the worker re-checks so a signed request cannot widen it.
const UNIFIED_WRITE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin"]);
const LEGACY_WRITE_STAFF_ROLES = new Set(["editor", "admin"]);

// ERP Part-time Auth workers write as their own "pt:<uid>" id, never as an editor/admin profile.
// The signed request is the only proof: the worker cannot check the ERP account, so a part_time actor
// is accepted only when LUGGAGE_PART_TIME_ACTORS_ENABLED is "true" (partTimeActorGate, for every internal route).
// part_time has exactly center_staff's business permissions; the staff-resolved operations below are all of them.
// A staff-resolved call site that passes no operation name (or an unlisted one) is still refused with 403 (fail closed).
const PART_TIME_ACTOR_ROLE = "part_time";
const PART_TIME_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PART_TIME_EMAIL_SUFFIX = "@part-time.local";
export const PART_TIME_ALLOWED_OPERATIONS = new Set([
  "handover.create", "handover.update", "handover.delete", "handover.read", "handover.comment",
  "lostFound.create", "lostFound.update", "lostFound.delete",
  "cashClosing.create", "cashClosing.update", "order.cancel", "order.phone", "order.pricing", "order.flyingPassRefund", "order.bagAddition", "order.bagCollection",
]);

/** A part_time actor must be a real ERP Auth UID (lowercase UUID) with a part-time.local email; email is absent on the pickup actor. */
export function assertPartTimeActorShape(role: string, userId: string, email?: string): void {
  if (role === PART_TIME_ACTOR_ROLE
    && (!PART_TIME_UID_RE.test(userId) || (email !== undefined && !email.toLowerCase().endsWith(PART_TIME_EMAIL_SUFFIX)))) {
    throw new Error("part_time actor needs a lowercase UUID userId and a part-time.local email");
  }
}

/**
 * Internal-route gate: a signed request whose actor.role is part_time is refused (403) unless the flag is on.
 * Runs after internalAuth, so the body it reads is the HMAC-verified one.
 */
export async function partTimeActorGate(c: Context<AppType>, next: Next) {
  const raw = c.get("rawBody");
  if (raw && raw.byteLength > 0 && c.env.LUGGAGE_PART_TIME_ACTORS_ENABLED !== "true") {
    let role: unknown;
    try { role = (JSON.parse(new TextDecoder().decode(raw)) as { actor?: { role?: unknown } } | null)?.actor?.role; } catch { role = undefined; }
    // Same normalization as the routes' requiredActorText (String.trim): a padded " part_time" is still a part_time actor there.
    if (typeof role === "string" && role.trim() === PART_TIME_ACTOR_ROLE) return c.json({ error: "Part-time actors are not enabled" }, 403);
  }
  await next();
}

export type UnifiedWriteActor = {
  userId: string;
  name: string;
  email: string;
  role: "center_staff" | "manager" | "super_admin" | "part_time";
};

export type InternalActorStaff = {
  id: string;
  displayName: string;
  email: string;
  role: "editor" | "admin" | "part_time";
};

export type InternalActorStaffResolution =
  | { ok: true; staff: InternalActorStaff }
  | { ok: false; status: 403 | 503; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredActorText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`actor.${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`actor.${field} exceeds ${maxLength} characters`);
  }
  return normalized;
}

export function normalizeUnifiedWriteActor(value: unknown): UnifiedWriteActor {
  const allowedKeys = new Set(["userId", "name", "email", "role"]);
  if (!isPlainRecord(value) || !Object.keys(value).every((key) => allowedKeys.has(key))) {
    throw new Error("actor must contain only userId, name, email, and role");
  }
  const role = requiredActorText(value.role, "role", 50);
  if (!UNIFIED_WRITE_ACTOR_ROLES.has(role) && role !== PART_TIME_ACTOR_ROLE) {
    throw new Error("actor.role is not allowed");
  }
  const email = requiredActorText(value.email, "email", 254);
  if (!email.includes("@")) {
    throw new Error("actor.email is invalid");
  }
  const userId = requiredActorText(value.userId, "userId", 200);
  assertPartTimeActorShape(role, userId, email);
  return {
    userId,
    name: requiredActorText(value.name, "name", 100),
    email,
    role: role as UnifiedWriteActor["role"],
  };
}

/**
 * Resolve the legacy staff profile that a unified-admin actor writes as.
 * The caller never supplies a staff_id: the worker matches actor.email against
 * Supabase user_profiles and fails closed unless exactly one active editor/admin matches.
 */
export async function resolveInternalActorStaff(env: Env, actor: UnifiedWriteActor, operation?: string): Promise<InternalActorStaffResolution> {
  if (actor.role === PART_TIME_ACTOR_ROLE) {
    if (env.LUGGAGE_PART_TIME_ACTORS_ENABLED !== "true") {
      return { ok: false, status: 403, error: "Part-time actors are not enabled" };
    }
    if (!operation || !PART_TIME_ALLOWED_OPERATIONS.has(operation)) {
      return { ok: false, status: 403, error: "Part-time actors cannot perform this operation" };
    }
    return { ok: true, staff: { id: `pt:${actor.userId}`, displayName: actor.name, email: actor.email, role: "part_time" } };
  }
  const email = actor.email.trim().toLowerCase();
  let rows: unknown[];
  try {
    const { data, error } = await createSupabaseAdmin(env)
      .from("user_profiles")
      .select("id, display_name, username, email, role, is_active")
      .not("email", "is", null);
    if (error || !Array.isArray(data)) {
      return { ok: false, status: 503, error: "Unable to verify legacy staff profile" };
    }
    rows = data;
  } catch {
    return { ok: false, status: 503, error: "Unable to verify legacy staff profile" };
  }

  const matches = rows.filter((row): row is Record<string, unknown> =>
    isPlainRecord(row) && typeof row.email === "string" && row.email.trim().toLowerCase() === email);
  if (matches.length === 0) {
    return { ok: false, status: 403, error: "No legacy staff profile matches the actor email" };
  }
  if (matches.length > 1) {
    return { ok: false, status: 403, error: "Multiple legacy staff profiles match the actor email" };
  }
  const profile = matches[0];
  if (typeof profile.id !== "string" || !profile.id.trim()) {
    return { ok: false, status: 503, error: "Unable to verify legacy staff profile" };
  }
  if (profile.is_active !== true) {
    return { ok: false, status: 403, error: "Legacy staff profile is inactive" };
  }
  if (typeof profile.role !== "string" || !LEGACY_WRITE_STAFF_ROLES.has(profile.role)) {
    return { ok: false, status: 403, error: "Legacy staff role is not allowed to write" };
  }
  const displayName = (typeof profile.display_name === "string" && profile.display_name.trim())
    || (typeof profile.username === "string" && profile.username.trim())
    || profile.id;
  return {
    ok: true,
    staff: {
      id: profile.id,
      displayName,
      email: String(profile.email).trim(),
      role: profile.role as InternalActorStaff["role"],
    },
  };
}

// Flying Pass refund routes only. A Unified Admin part_time worker (ERP Part-time Auth) acts as itself:
// staff id "pt:<uid>", never an editor/admin user_profiles row and never relabeled as center_staff.
// The Worker cannot look the account up, so the HMAC-signed Unified session is the proof; the flag keeps it OFF by default.
const PART_TIME_ROLE = "part_time";
const PART_TIME_UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type RefundWriteActor = Omit<UnifiedWriteActor, "role"> & { role: UnifiedWriteActor["role"] | "part_time" };
export type RefundActorStaff = Omit<InternalActorStaff, "role"> & { role: InternalActorStaff["role"] | "part_time" };

export function normalizeRefundWriteActor(value: unknown): RefundWriteActor {
  // Preserve the existing refund actor contract: padded part_time roles are never accepted.
  if (isPlainRecord(value) && typeof value.role === "string" && value.role.trim() === PART_TIME_ROLE && value.role !== PART_TIME_ROLE) {
    throw new Error("actor.role is not allowed");
  }
  if (!isPlainRecord(value) || value.role !== PART_TIME_ROLE) return normalizeUnifiedWriteActor(value);
  // Same key/length/email checks as every other actor; only the role differs.
  const actor = normalizeUnifiedWriteActor({ ...value, role: "center_staff" });
  if (!PART_TIME_UID.test(actor.userId) || !actor.email.toLowerCase().endsWith("@part-time.local")) {
    throw new Error("part_time actor needs a lowercase UUID userId and a part-time.local email");
  }
  return { ...actor, role: PART_TIME_ROLE };
}

export async function resolveRefundActorStaff(env: Env, actor: RefundWriteActor):
  Promise<{ ok: true; staff: RefundActorStaff } | { ok: false; status: 403 | 503; error: string }> {
  if (actor.role !== PART_TIME_ROLE) return resolveInternalActorStaff(env, actor as UnifiedWriteActor);
  if (env.LUGGAGE_PART_TIME_REFUND_ACTORS_ENABLED !== "true") return { ok: false, status: 403, error: "Part-time refund actors are not enabled" };
  return { ok: true, staff: { id: `pt:${actor.userId}`, displayName: actor.name, email: actor.email, role: PART_TIME_ROLE } };
}

export function unifiedActorAuditSnapshot(actor: UnifiedWriteActor, staff: InternalActorStaff) {
  return {
    actor: { userId: actor.userId, name: actor.name, email: actor.email, role: actor.role },
    legacyStaff: { id: staff.id, displayName: staff.displayName, role: staff.role },
    // Derived from the resolved worker, never read from the request.
    ...(staff.role === PART_TIME_ACTOR_ROLE ? { authSource: "part_time_auth" } : {}),
  };
}

/**
 * Keeps the part-time display name current. Append it LAST to the same D1 batch as the work so both commit or
 * neither does (earlier statements rely on changes() of their predecessor, so it must not sit between them).
 */
export function partTimeActorNameStatements(env: Env, staff: InternalActorStaff): D1PreparedStatement[] {
  if (staff.role !== PART_TIME_ACTOR_ROLE) return [];
  return [env.DB.prepare(
    `INSERT INTO luggage_part_time_actors (actor_id, display_name, last_seen_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(actor_id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at`,
  ).bind(staff.id, staff.displayName)];
}
