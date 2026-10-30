import type { Env } from "../types";
import { createSupabaseAdmin } from "./supabase";

export type StaffProfileRow = {
  id: string;
  display_name: string | null;
  username: string | null;
  email?: string | null;
  role?: string | null;
  is_active?: boolean | null;
  created_at?: string | null;
};

export function getStaffDisplayName(profile: Pick<StaffProfileRow, "id" | "display_name" | "username">): string {
  return profile.display_name || profile.username || profile.id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchStaffProfilesByIds(env: Env, ids: Array<string | null | undefined>): Promise<Map<string, StaffProfileRow>> {
  const uniqueIds = [...new Set(ids.map((value) => `${value ?? ""}`.trim()).filter((v) => v && UUID_RE.test(v)))];
  if (uniqueIds.length === 0) return new Map();

  const supabaseAdmin = createSupabaseAdmin(env);
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("id, display_name, username, email, role, is_active, created_at")
    .in("id", uniqueIds);

  if (error || !data) return new Map();

  const profileMap = new Map<string, StaffProfileRow>();
  for (const row of data) {
    profileMap.set(row.id, row);
  }
  return profileMap;
}

export async function fetchStaffNamesByIds(env: Env, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const profileMap = await fetchStaffProfilesByIds(env, ids);
  const nameMap = new Map<string, string>();
  for (const [id, profile] of profileMap.entries()) {
    nameMap.set(id, getStaffDisplayName(profile));
  }
  // "pt:<uid>" ids (ERP Part-time Auth workers) are not user_profiles rows; their names live in D1.
  const partTimeIds = [...new Set(ids.map((value) => `${value ?? ""}`.trim()).filter((v) => v.startsWith("pt:")))];
  if (partTimeIds.length > 0) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT actor_id, display_name FROM luggage_part_time_actors WHERE actor_id IN (${partTimeIds.map(() => "?").join(",")})`,
      ).bind(...partTimeIds).all<{ actor_id: string; display_name: string }>();
      for (const row of results) nameMap.set(row.actor_id, row.display_name);
    } catch {
      // Like the staff lookup above, a failed name lookup only drops names.
    }
  }
  return nameMap;
}
