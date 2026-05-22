import { getCookie } from "hono/cookie";
import { type Context, type Next } from "hono";
import type { AppType } from "../types";

const HEADER_PREFIX = "x-flying-account-";
export const ACCOUNT_CONTEXT_COOKIE = "fj_account_context";
const PERSON_ID_HEADER = `${HEADER_PREFIX}person-id`;
const EMAIL_HEADER = `${HEADER_PREFIX}email`;
const PROVIDER_HEADER = `${HEADER_PREFIX}provider`;
const DISPLAY_NAME_HEADER = `${HEADER_PREFIX}display-name`;
const PHONE_HEADER = `${HEADER_PREFIX}phone`;
const LOCALE_HEADER = `${HEADER_PREFIX}locale`;
const TIMESTAMP_HEADER = `${HEADER_PREFIX}timestamp`;
const SIGNATURE_HEADER = `${HEADER_PREFIX}signature`;
const DEFAULT_MAX_AGE_SECONDS = 300;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type AccountHeaderContext = {
  personId: string;
  email?: string;
  provider: string;
  displayName?: string;
  phone?: string;
  locale?: string;
  timestamp: string;
};

type ParsedAccountContext = {
  context: AccountHeaderContext;
  signature: string;
};

export async function optionalCustomerAuth(c: Context<AppType>, next: Next) {
  const hasAccountHeaders = [...c.req.raw.headers.keys()].some((name) =>
    name.toLowerCase().startsWith(HEADER_PREFIX)
  );
  const accountContextCookie = getCookie(c, ACCOUNT_CONTEXT_COOKIE);

  if (!hasAccountHeaders && !accountContextCookie) return next();

  const secret = c.env.ACCOUNT_CONTEXT_SECRET;
  if (!secret) {
    return c.json({ error: "Account context is not configured" }, 401);
  }

  const parsed = hasAccountHeaders
    ? parseAccountHeaders(c)
    : parseAccountCookie(accountContextCookie);
  if (!parsed) {
    return c.json({ error: "Invalid account context" }, 401);
  }

  if (!isFreshTimestamp(parsed.context.timestamp, resolveMaxAgeSeconds(c.env.ACCOUNT_CONTEXT_MAX_AGE_SECONDS))) {
    return c.json({ error: "Expired account context" }, 401);
  }

  const expected = await signAccountContext(secret, parsed.context);
  if (!timingSafeEqual(parsed.signature, expected)) {
    return c.json({ error: "Invalid account context signature" }, 401);
  }

  c.set("customer", {
    personId: parsed.context.personId,
    email: parsed.context.email,
    displayName: parsed.context.displayName,
    phone: parsed.context.phone,
    locale: parsed.context.locale,
    provider: parsed.context.provider,
    issuedBy: "pub-account",
  });

  return next();
}

export async function signAccountContext(secret: string, input: AccountHeaderContext): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(canonicalize(input)));
  return bytesToBase64Url(new Uint8Array(signature));
}

function parseAccountHeaders(c: Context<AppType>): ParsedAccountContext | null {
  const personId = cleanHeader(c.req.header(PERSON_ID_HEADER));
  const timestamp = cleanHeader(c.req.header(TIMESTAMP_HEADER));
  const signature = cleanHeader(c.req.header(SIGNATURE_HEADER));

  if (!personId || !timestamp || !signature) return null;

  const provider = cleanHeader(c.req.header(PROVIDER_HEADER)) || "account";
  const email = cleanHeader(c.req.header(EMAIL_HEADER));
  const displayName = cleanHeader(c.req.header(DISPLAY_NAME_HEADER));
  const phone = cleanHeader(c.req.header(PHONE_HEADER));
  const locale = cleanHeader(c.req.header(LOCALE_HEADER));

  return {
    context: {
      personId,
      timestamp,
      provider,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
      ...(phone ? { phone } : {}),
      ...(locale ? { locale } : {}),
    },
    signature,
  };
}

function parseAccountCookie(value: string | undefined): ParsedAccountContext | null {
  if (!value || value.length > 4096) return null;

  try {
    const payload = JSON.parse(textDecoder.decode(base64UrlToBytes(value))) as Record<string, unknown>;
    const personId = cleanHeader(asString(payload.person_id));
    const timestamp = cleanHeader(asString(payload.timestamp));
    const signature = cleanHeader(asString(payload.signature));

    if (!personId || !timestamp || !signature) return null;

    const provider = cleanHeader(asString(payload.provider)) || "account";
    const email = cleanHeader(asString(payload.email));
    const displayName = cleanHeader(asString(payload.display_name));
    const phone = cleanHeader(asString(payload.phone));
    const locale = cleanHeader(asString(payload.locale));

    return {
      context: {
        personId,
        timestamp,
        provider,
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {}),
        ...(phone ? { phone } : {}),
        ...(locale ? { locale } : {}),
      },
      signature,
    };
  } catch {
    return null;
  }
}

function canonicalize(input: AccountHeaderContext): string {
  return [
    input.timestamp,
    input.personId,
    input.email ?? "",
    input.provider,
    input.displayName ?? "",
    input.phone ?? "",
    input.locale ?? "",
  ].join("\n");
}

function cleanHeader(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned || /[\r\n]/.test(cleaned)) return undefined;
  return cleaned;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isFreshTimestamp(value: string, maxAgeSeconds: number): boolean {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  return Math.abs(Date.now() - millis) <= maxAgeSeconds * 1000;
}

function resolveMaxAgeSeconds(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_AGE_SECONDS;
  return Math.floor(parsed);
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
