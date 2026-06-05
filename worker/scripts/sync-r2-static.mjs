#!/usr/bin/env node
/**
 * Sync canonical static promo assets into the production R2 bucket.
 *
 * Why this exists
 * ---------------
 * The customer pages and confirmation emails reference `/static/*` images that
 * are served from R2 (binding `IMAGES` -> bucket `luggage-images`). These images
 * are NOT bundled with the Worker and are NOT in the deploy artifact, so the only
 * way they reach production is an explicit upload.
 *
 * Two failure modes this script prevents:
 *   1. `wrangler r2 object put` WITHOUT `--remote` writes to the local miniflare
 *      state only, so `pnpm dev` looks correct while production stays empty.
 *      This script always passes `--remote`.
 *   2. The bucket lifecycle policy must keep `static/` objects forever. (Customer
 *      PII under `id/` and `luggage/` is expired at 14 days by scoped rules.)
 *      Re-running this script on every deploy makes `static/` self-healing even
 *      if an object is ever lost.
 *
 * Source of truth: worker/assets/r2-static/*. Every file there is uploaded to
 * `static/<filename>` in the bucket. Adding/replacing an image = drop the file
 * in that folder and deploy (or run `pnpm r2:push:static`).
 */

import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(scriptDir, "..", "assets", "r2-static");
const BUCKET = "luggage-images";

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function main() {
  const files = readdirSync(assetsDir).filter((f) => CONTENT_TYPES[extname(f).toLowerCase()]);

  if (files.length === 0) {
    console.error(`[sync-r2-static] No image files found in ${assetsDir}`);
    process.exit(1);
  }

  let uploaded = 0;
  const failures = [];

  for (const file of files) {
    const path = join(assetsDir, file);
    const size = statSync(path).size;
    if (size < 100) {
      // Guard against committing 0-byte / placeholder files that would blank a live image.
      failures.push(`${file} (suspicious size: ${size} bytes)`);
      continue;
    }

    const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
    const key = `${BUCKET}/static/${file}`;

    try {
      execFileSync(
        "pnpm",
        ["exec", "wrangler", "r2", "object", "put", key, "--file", path, "--content-type", contentType, "--remote"],
        { cwd: join(scriptDir, ".."), stdio: ["ignore", "ignore", "inherit"] }
      );
      console.log(`[sync-r2-static] uploaded static/${file} (${size} bytes)`);
      uploaded += 1;
    } catch (e) {
      failures.push(`${file} (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  console.log(`[sync-r2-static] ${uploaded}/${files.length} objects synced to ${BUCKET}/static/`);

  if (failures.length > 0) {
    console.error(`[sync-r2-static] FAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
}

main();
