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

export async function fetchStaffProfilesByIds(env: Env, ids: Array<string | null | undefined>): Promise<Map<string, StaffProfileRow>> {
  const uniqueIds = [...new Set(ids.map((value) => `${value ?? ""}`.trim()).filter(Boolean))];
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
  return nameMap;
}
