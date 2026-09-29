import type { Env } from "../types";
import { createSupabaseAdmin } from "./supabase";

// Unified admin roles allowed to request operational-record writes. The unified
// admin checks this too; the worker re-checks so a signed request cannot widen it.
const UNIFIED_WRITE_ACTOR_ROLES = new Set(["center_staff", "manager", "super_admin"]);
const LEGACY_WRITE_STAFF_ROLES = new Set(["editor", "admin"]);

export type UnifiedWriteActor = {
  userId: string;
  name: string;
  email: string;
  role: "center_staff" | "manager" | "super_admin";
};

export type InternalActorStaff = {
  id: string;
  displayName: string;
  email: string;
  role: "editor" | "admin";
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
  if (!UNIFIED_WRITE_ACTOR_ROLES.has(role)) {
    throw new Error("actor.role is not allowed");
  }
  const email = requiredActorText(value.email, "email", 254);
  if (!email.includes("@")) {
    throw new Error("actor.email is invalid");
  }
  return {
    userId: requiredActorText(value.userId, "userId", 200),
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
export async function resolveInternalActorStaff(env: Env, actor: UnifiedWriteActor): Promise<InternalActorStaffResolution> {
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

export function unifiedActorAuditSnapshot(actor: UnifiedWriteActor, staff: InternalActorStaff) {
  return {
    actor: { userId: actor.userId, name: actor.name, email: actor.email, role: actor.role },
    legacyStaff: { id: staff.id, displayName: staff.displayName, role: staff.role },
  };
}
