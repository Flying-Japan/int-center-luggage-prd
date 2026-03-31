#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DB_NAME = "center-luggage-db";
const OWNER_NAME_ALIASES = {
  jin: "yejinkim",
};

function normalizeToken(value) {
  return `${value ?? ""}`.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function runD1Json(sql, { useLocal = false, allowEmpty = false } = {}) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    DB_NAME,
    useLocal ? "--local" : "--remote",
    "--json",
    "--command",
    sql,
  ];

  const stdout = execFileSync("npx", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  const payload = JSON.parse(stdout);
  const first = payload[0];
  if (!first?.success && !allowEmpty) {
    throw new Error(`D1 query failed: ${stdout}`);
  }
  return first;
}

async function fetchSupabaseUsers() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.");
  }

  const response = await fetch(
    `${supabaseUrl}/rest/v1/user_profiles?select=id,username,display_name&order=display_name.asc.nullslast,username.asc`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Supabase user_profiles query failed: ${response.status} ${await response.text()}`);
  }

  return await response.json();
}

function buildUserLookup(users) {
  const exactUsernameMap = new Map();
  const tokenMap = new Map();

  for (const user of users) {
    const tokens = new Set();
    const usernameLocal = `${user.username ?? ""}`.split("@")[0];
    const displayName = `${user.display_name ?? ""}`;
    const exactUsername = normalizeToken(usernameLocal);

    if (exactUsername) {
      if (!exactUsernameMap.has(exactUsername)) {
        exactUsernameMap.set(exactUsername, []);
      }
      exactUsernameMap.get(exactUsername).push(user);
    }

    const candidates = [usernameLocal, displayName];
    for (const candidate of candidates) {
      const normalizedWhole = normalizeToken(candidate);
      if (normalizedWhole) {
        tokens.add(normalizedWhole);
      }
      for (const piece of candidate.split(/[^a-zA-Z0-9]+/)) {
        const normalizedPiece = normalizeToken(piece);
        if (normalizedPiece) {
          tokens.add(normalizedPiece);
        }
      }
    }

    for (const token of tokens) {
      if (!tokenMap.has(token)) {
        tokenMap.set(token, []);
      }
      tokenMap.get(token).push(user);
    }
  }

  return { exactUsernameMap, tokenMap };
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildUpdateSql(matches) {
  return matches.map(({ user, ownerNames }) => {
    const ownerNameList = ownerNames.map(sqlString).join(", ");
    return `UPDATE luggage_cash_closings
SET staff_id = ${sqlString(user.id)}, updated_at = datetime('now')
WHERE staff_id IS NULL AND owner_name IN (${ownerNameList});`;
  }).join("\n");
}

async function main() {
  const apply = process.argv.includes("--apply");
  const useLocal = process.argv.includes("--local");

  const users = await fetchSupabaseUsers();
  const unmatchedOwners = runD1Json(
    "SELECT DISTINCT owner_name FROM luggage_cash_closings WHERE owner_name IS NOT NULL AND staff_id IS NULL ORDER BY owner_name;",
    { useLocal },
  ).results;

  const { exactUsernameMap, tokenMap } = buildUserLookup(users);
  const groupedMatches = new Map();
  const unresolved = [];
  const ambiguous = [];

  for (const row of unmatchedOwners) {
    const ownerName = `${row.owner_name ?? ""}`.trim();
    const token = normalizeToken(ownerName);
    if (!token) {
      continue;
    }

    const aliasToken = OWNER_NAME_ALIASES[token] ?? token;
    const exactUsernameMatches = exactUsernameMap.get(aliasToken) ?? [];
    const candidates = exactUsernameMatches.length > 0 ? exactUsernameMatches : (tokenMap.get(token) ?? []);
    if (candidates.length === 1) {
      const user = candidates[0];
      const existing = groupedMatches.get(user.id);
      if (existing) {
        existing.ownerNames.push(ownerName);
      } else {
        groupedMatches.set(user.id, { user, ownerNames: [ownerName] });
      }
      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push({
        ownerName,
        candidates: candidates.map((user) => `${user.display_name || user.username} <${user.username}>`),
      });
      continue;
    }

    unresolved.push(ownerName);
  }

  const matches = Array.from(groupedMatches.values()).sort((a, b) => a.user.username.localeCompare(b.user.username));
  const sql = buildUpdateSql(matches);

  console.log(`Matched ${matches.reduce((sum, entry) => sum + entry.ownerNames.length, 0)} owner labels across ${matches.length} users.`);
  for (const match of matches) {
    console.log(`- ${match.user.display_name || match.user.username} <${match.user.username}> <= ${match.ownerNames.join(", ")}`);
  }

  if (ambiguous.length > 0) {
    console.log("\nAmbiguous owner labels:");
    for (const row of ambiguous) {
      console.log(`- ${row.ownerName}: ${row.candidates.join(" | ")}`);
    }
  }

  if (unresolved.length > 0) {
    console.log(`\nUnresolved owner labels: ${unresolved.join(", ")}`);
  }

  if (!apply) {
    if (sql) {
      console.log("\nSQL preview:\n");
      console.log(sql);
    }
    return;
  }

  if (!sql) {
    console.log("No safe staff_id matches found.");
    return;
  }

  runD1Json(sql, { useLocal });
  console.log(`\nApplied ${matches.length} staff mapping updates to ${useLocal ? "local" : "remote"} D1.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
