import { Hono } from "hono";
import type { AppType } from "../types";
import { verifyInternalRequestSignature, verifyTimestamp } from "../lib/hmac";
import { readExperienceOccupancy, validateOccupancyRange } from "../services/experienceRentals";

const inventory = new Hono<AppType>();

// Mount before reviewer routes: this exact read-only endpoint uses its own key.
inventory.get("/internal/experience-rental-occupancy", async (c) => {
  c.header("Cache-Control", "no-store");
  const timestamp = c.req.header("x-internal-timestamp")?.trim() || "";
  const signature = c.req.header("x-internal-signature")?.trim() || "";
  if (!/^\d+$/.test(timestamp) || !/^[a-fA-F0-9]{64}$/.test(signature) || !verifyTimestamp(timestamp)) {
    return c.json({ error: "Invalid internal authentication" }, 401);
  }
  const secret = c.env.CENTER_INVENTORY_API_SECRET;
  if (!secret) {
    console.error("Center inventory secret is not configured");
    return c.json({ error: "Inventory integration is unavailable" }, 503);
  }
  if (!await verifyInternalRequestSignature({
    method: c.req.method, url: c.req.url, timestamp, signature, secret,
    body: await c.req.raw.clone().arrayBuffer(),
  })) return c.json({ error: "Invalid internal authentication" }, 401);

  const start = c.req.query("start") || "";
  const end = c.req.query("end") || "";
  if (!validateOccupancyRange(start, end)) {
    return c.json({ error: "Use valid YYYY-MM-DD dates and a range of 1 to 93 days" }, 400);
  }
  try {
    return c.json({ items: await readExperienceOccupancy(c.env.DB, start, end) });
  } catch {
    console.error("Experience rental occupancy query failed");
    return c.json({ error: "Inventory occupancy is unavailable" }, 503);
  }
});
export default inventory;
