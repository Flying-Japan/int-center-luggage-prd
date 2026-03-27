import { type Context, type Next } from "hono";

/**
 * Middleware: add standard security headers to every response.
 */
export async function securityHeaders(c: Context, next: Next) {
  await next();
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("X-XSS-Protection", "1; mode=block");
  c.res.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; font-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'"
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
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/staff")) {
    return c.html(
      `<html><head><meta charset="UTF-8"><title>404</title></head><body style="font-family:sans-serif;text-align:center;padding:80px 16px;background:#f8fafc"><h1 style="font-size:64px;color:#1e293b;margin:0">404</h1><p style="color:#64748b;margin:12px 0 24px">페이지를 찾을 수 없습니다</p><a href="/staff/dashboard" style="display:inline-block;padding:10px 24px;background:#2383e2;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">대시보드로 이동</a></body></html>`,
      404
    );
  }
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
