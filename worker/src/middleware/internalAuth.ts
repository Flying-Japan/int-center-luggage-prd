import { type Context, type Next } from "hono";
import type { AppType } from "../types";
import { verifyInternalRequestSignature, verifyTimestamp } from "../lib/hmac";

type InternalContext = Context<AppType>;

export async function internalAuth(c: InternalContext, next: Next) {
  if (!c.env.INTERNAL_API_SECRET) {
    return c.json({ error: "INTERNAL_API_SECRET is not configured" }, 503);
  }

  const timestamp = c.req.header("x-internal-timestamp")?.trim() ?? "";
  const signature = c.req.header("x-internal-signature")?.trim() ?? "";

  if (!timestamp || !signature) {
    return c.json({ error: "Missing internal auth headers" }, 401);
  }

  const now = Date.now();
  if (!verifyTimestamp(timestamp, now)) {
    return c.json({ error: "Stale internal request" }, 401);
  }

  // Clone exactly once here so downstream handlers can still call c.req.json().
  const rawBody = await c.req.raw.clone().arrayBuffer();
  const isValid = await verifyInternalRequestSignature({
    body: rawBody,
    method: c.req.method,
    secret: c.env.INTERNAL_API_SECRET,
    signature,
    timestamp,
    url: c.req.url,
  });

  if (!isValid) {
    return c.json({ error: "Invalid internal signature" }, 401);
  }

  c.set("rawBody", rawBody);
  await next();
}
