import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppType } from "../types";
import { ACCOUNT_CONTEXT_COOKIE, optionalCustomerAuth, signAccountContext } from "./customerAuth";

const SECRET = "account-context-test-secret";
const BASE = "https://luggage.flyingjp.test/customer";
const CONTRACT_SECRET = "dev-luggage-account-context-secret";
const CONTRACT_TIMESTAMP = "2026-05-22T03:15:00.000Z";
const CONTRACT_SIGNATURE = "Z3Wrapy8H99FCGPIW1uyLnpbz4yAdg39I5YsITzH4hU";

function buildTestApp() {
  const app = new Hono<AppType>();
  app.use("/customer", optionalCustomerAuth);
  app.use("/customer/*", optionalCustomerAuth);
  app.get("/customer", (c) => c.json({ customer: c.get("customer") ?? null }));
  return app;
}

async function dispatch(headers: Record<string, string>, env: Record<string, string> = {}) {
  const app = buildTestApp();
  return app.fetch(new Request(BASE, { headers }), env as never);
}

async function buildSignedHeaders(overrides: Partial<{
  personId: string;
  email: string;
  provider: string;
  displayName: string;
  phone: string;
  locale: string;
  timestamp: string;
}> = {}) {
  const context = {
    personId: overrides.personId ?? "person_123",
    email: overrides.email ?? "customer@example.com",
    provider: overrides.provider ?? "account",
    displayName: overrides.displayName ?? "Kim Customer",
    phone: overrides.phone ?? "010-1111-2222",
    locale: overrides.locale ?? "ko",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
  const signature = await signAccountContext(SECRET, context);

  return {
    "x-flying-account-person-id": context.personId,
    "x-flying-account-email": context.email,
    "x-flying-account-provider": context.provider,
    "x-flying-account-display-name": context.displayName,
    "x-flying-account-phone": context.phone,
    "x-flying-account-locale": context.locale,
    "x-flying-account-timestamp": context.timestamp,
    "x-flying-account-signature": signature,
  };
}

async function buildSignedCookie(overrides: Partial<{
  personId: string;
  email: string;
  provider: string;
  displayName: string;
  phone: string;
  locale: string;
  timestamp: string;
  signature: string;
}> = {}) {
  const context = {
    personId: overrides.personId ?? "person_123",
    email: overrides.email ?? "customer@example.com",
    provider: overrides.provider ?? "account",
    displayName: overrides.displayName ?? "Kim Customer",
    phone: overrides.phone ?? "010-1111-2222",
    locale: overrides.locale ?? "ko",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
  const signature = overrides.signature ?? (await signAccountContext(SECRET, context));
  return `${ACCOUNT_CONTEXT_COOKIE}=${toBase64Url(JSON.stringify({
    person_id: context.personId,
    email: context.email,
    provider: context.provider,
    display_name: context.displayName,
    phone: context.phone,
    locale: context.locale,
    timestamp: context.timestamp,
    signature,
  }))}`;
}

function toBase64Url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("optionalCustomerAuth", () => {
  it("signs the documented Account handoff sample the same way as pub-account", async () => {
    await expect(
      signAccountContext(CONTRACT_SECRET, {
        timestamp: CONTRACT_TIMESTAMP,
        personId: "person_123",
        email: "customer@example.com",
        provider: "account",
        displayName: "Kim Customer",
        phone: "010-1111-2222",
        locale: "ko",
      }),
    ).resolves.toBe(CONTRACT_SIGNATURE);
  });

  it("accepts the documented Account handoff cookie fixture", async () => {
    const cookie = `${ACCOUNT_CONTEXT_COOKIE}=${toBase64Url(JSON.stringify({
      person_id: "person_123",
      email: "customer@example.com",
      provider: "account",
      display_name: "Kim Customer",
      phone: "010-1111-2222",
      locale: "ko",
      timestamp: CONTRACT_TIMESTAMP,
      signature: CONTRACT_SIGNATURE,
    }))}`;
    const res = await dispatch({ cookie }, {
      ACCOUNT_CONTEXT_MAX_AGE_SECONDS: "604800",
      ACCOUNT_CONTEXT_SECRET: CONTRACT_SECRET,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      customer: {
        personId: "person_123",
        email: "customer@example.com",
        provider: "account",
        displayName: "Kim Customer",
        phone: "010-1111-2222",
        locale: "ko",
        issuedBy: "pub-account",
      },
    });
  });

  it("keeps anonymous customer requests unchanged when no Account context exists", async () => {
    const res = await dispatch({}, {});

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ customer: null });
  });

  it("populates customer session from signed Account context headers", async () => {
    const headers = await buildSignedHeaders();
    const res = await dispatch(headers, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      customer: {
        personId: "person_123",
        email: "customer@example.com",
        provider: "account",
        displayName: "Kim Customer",
        phone: "010-1111-2222",
        locale: "ko",
        issuedBy: "pub-account",
      },
    });
  });

  it("populates customer session from a signed Account context cookie", async () => {
    const res = await dispatch({
      cookie: await buildSignedCookie(),
    }, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      customer: {
        personId: "person_123",
        email: "customer@example.com",
        provider: "account",
        displayName: "Kim Customer",
        phone: "010-1111-2222",
        locale: "ko",
        issuedBy: "pub-account",
      },
    });
  });

  it("rejects unsigned Account headers instead of trusting browser-provided identity", async () => {
    const res = await dispatch({
      "x-flying-account-person-id": "person_123",
      "x-flying-account-timestamp": new Date().toISOString(),
    }, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Invalid account context" });
  });

  it("rejects Account context when the shared secret is not configured", async () => {
    const headers = await buildSignedHeaders();
    const res = await dispatch(headers, {});

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Account context is not configured" });
  });

  it("rejects stale signed Account context headers", async () => {
    const headers = await buildSignedHeaders({
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const res = await dispatch(headers, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Expired account context" });
  });

  it("rejects stale signed Account context cookies", async () => {
    const res = await dispatch({
      cookie: await buildSignedCookie({
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    }, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Expired account context" });
  });

  it("does not fall back to a cookie when browser-supplied Account headers are invalid", async () => {
    const res = await dispatch({
      cookie: await buildSignedCookie(),
      "x-flying-account-person-id": "attacker",
      "x-flying-account-timestamp": new Date().toISOString(),
    }, { ACCOUNT_CONTEXT_SECRET: SECRET });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Invalid account context" });
  });
});
