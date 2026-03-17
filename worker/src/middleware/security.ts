import { type Context, type Next } from "hono";

/**
 * Middleware: add standard security headers to every response.
 */
export async function securityHeaders(c: Context, next: Next) {
  await next();
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("X-XSS-Protection", "1; mode=block");
  c.res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
}

/**
 * Error handler (onError): logs full error server-side, returns generic 500.
 */
export function errorHandler(err: Error, c: Context) {
  console.error("[error]", err.stack ?? err.message);
  return c.json({ error: "Internal server error" }, 500);
}

/**
 * Not found handler (notFound): returns 404 JSON.
 */
export function notFoundHandler(c: Context) {
  return c.json({ error: "Not found" }, 404);
}

type RateLimitEntry = { count: number; resetAt: number };

/**
 * Factory: in-memory rate limiter middleware.
 * NOTE: resets per Worker isolate — use Cloudflare's rate limiting for
 * production-grade enforcement across all instances.
 */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, RateLimitEntry>();
  let totalRequests = 0;

  return async function rateLimiter(c: Context, next: Next) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();

    // Periodic cleanup of expired entries (every 100 requests)
    totalRequests += 1;
    if (totalRequests % 100 === 0) {
      for (const [key, entry] of store) {
        if (entry.resetAt <= now) {
          store.delete(key);
        }
      }
    }

    const entry = store.get(ip);

    if (!entry || entry.resetAt <= now) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      return c.json({ error: "Too many requests" }, 429);
    }

    entry.count += 1;
    return next();
  };
}
