/** Fetch staff display names from Supabase user_profiles by IDs */
import { createSupabaseAdmin } from "./supabase";
import type { Env } from "../types";

export async function fetchStaffNamesByIds(
  env: Env,
  staffIds: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(staffIds.filter((id): id is string => !!id))];
  const nameMap = new Map<string, string>();

  if (uniqueIds.length === 0) return nameMap;

  const supabaseAdmin = createSupabaseAdmin(env);
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("id, display_name, username")
    .in("id", uniqueIds);

  if (data) {
    for (const profile of data) {
      nameMap.set(profile.id, profile.display_name || profile.username || profile.id);
    }
  }

  return nameMap;
}
