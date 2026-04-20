import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppType } from "../types";
import {
  createTimestampHeader,
  signInternalRequest,
} from "../lib/hmac";
import { internalAuth } from "./internalAuth";

type FakeEnv = {
  INTERNAL_API_SECRET?: string;
};

// Build a throwaway Hono app that mounts internalAuth and returns 200 on any
// passthrough. DB is intentionally not injected: the handler should never run
// in the rejection paths, and if it does the test will crash loudly.
function buildTestApp(env: FakeEnv) {
  const app = new Hono<AppType>();
  app.use("/internal/*", internalAuth);
  app.put("/internal/experience/:externalId", (c) => c.json({ ok: true }));
  app.get("/internal/experience/:externalId", (c) =>
    c.json({ externalId: c.req.param("externalId") }),
  );
  return { app, env };
}

async function dispatch(
  app: ReturnType<typeof buildTestApp>["app"],
  env: FakeEnv,
  init: RequestInit & { url: string },
) {
  return app.fetch(new Request(init.url, init), env as never);
}

const BASE = "https://luggage.flyingjp.test/internal/experience/app_42";
const METHOD = "PUT";
const SECRET = "integration-test-secret";

describe("internalAuth middleware", () => {
  it("returns 503 when the secret binding is missing", async () => {
    const { app, env } = buildTestApp({});
    const res = await dispatch(app, env, { method: METHOD, url: BASE });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "INTERNAL_API_SECRET is not configured" });
  });

  it("returns 401 when signature or timestamp headers are missing", async () => {
    const { app, env } = buildTestApp({ INTERNAL_API_SECRET: SECRET });
    const res = await dispatch(app, env, {
      method: METHOD,
      url: BASE,
      headers: { "x-internal-timestamp": "0" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Missing internal auth headers" });
  });

  it("returns 401 for a timestamp outside the 5 minute tolerance", async () => {
    const { app, env } = buildTestApp({ INTERNAL_API_SECRET: SECRET });
    const staleTimestamp = createTimestampHeader(Date.now() - 10 * 60_000);
    const res = await dispatch(app, env, {
      method: METHOD,
      url: BASE,
      headers: {
        "x-internal-timestamp": staleTimestamp,
        "x-internal-signature": "deadbeef",
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Stale internal request" });
  });

  it("returns 401 when the signature does not match the body", async () => {
    const { app, env } = buildTestApp({ INTERNAL_API_SECRET: SECRET });
    const timestamp = createTimestampHeader();
    const signed = await signInternalRequest({
      body: JSON.stringify({ foo: "bar" }),
      method: METHOD,
      secret: SECRET,
      timestamp,
      url: BASE,
    });
    // Send the legit signature but with a tampered body so hashing diverges.
    const res = await dispatch(app, env, {
      method: METHOD,
      url: BASE,
      body: JSON.stringify({ foo: "tampered" }),
      headers: {
        "content-type": "application/json",
        "x-internal-timestamp": timestamp,
        "x-internal-signature": signed.signature,
      },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid internal signature" });
  });

  it("returns 401 when the signature length differs (constant-time compare)", async () => {
    const { app, env } = buildTestApp({ INTERNAL_API_SECRET: SECRET });
    const timestamp = createTimestampHeader();
    const res = await dispatch(app, env, {
      method: METHOD,
      url: BASE,
      headers: {
        "x-internal-timestamp": timestamp,
        // 8-char signature instead of the 64-char HMAC hex output.
        "x-internal-signature": "abcdef01",
      },
    });
    expect(res.status).toBe(401);
  });

  it("passes through when the signature is valid", async () => {
    const { app, env } = buildTestApp({ INTERNAL_API_SECRET: SECRET });
    const timestamp = createTimestampHeader();
    const body = JSON.stringify({ externalId: "app_42", scheduledDate: "2026-05-01" });
    const signed = await signInternalRequest({
      body,
      method: METHOD,
      secret: SECRET,
      timestamp,
      url: BASE,
    });
    const res = await dispatch(app, env, {
      method: METHOD,
      url: BASE,
      body,
      headers: {
        "content-type": "application/json",
        "x-internal-timestamp": timestamp,
        "x-internal-signature": signed.signature,
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
  });
});
