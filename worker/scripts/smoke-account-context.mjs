#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DEFAULT_SECRET_ENV = "ACCOUNT_CONTEXT_SECRET";
const DEFAULT_PERSON_ID = "smoke_luggage_20260522";
const DEFAULT_EMAIL = "luggage-smoke@example.invalid";
const DEFAULT_DISPLAY_NAME = "Luggage Smoke";
const DEFAULT_LOCALE = "ko";
const CONTEXT_PATH = "/customer/api/context";
const CUSTOMER_PATH = "/customer";
const PRICE_PREVIEW_PATH = "/api/price-preview";
const STAFF_LOGIN_PATH = "/staff/login";
const COOKIE_NAME = "fj_account_context";
const SYNTHETIC_MARKER_PATTERN = /(^local_|smoke|synthetic|test|example|dummy)/i;

const HEADERS = {
  personId: "X-Flying-Account-Person-Id",
  email: "X-Flying-Account-Email",
  provider: "X-Flying-Account-Provider",
  displayName: "X-Flying-Account-Display-Name",
  phone: "X-Flying-Account-Phone",
  locale: "X-Flying-Account-Locale",
  timestamp: "X-Flying-Account-Timestamp",
  signature: "X-Flying-Account-Signature",
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const secret = process.env[options.secretEnv];
  if (!secret) {
    throw new Error(`Missing ${options.secretEnv}. Set it to the shared Account/Luggage context secret.`);
  }

  const context = {
    personId: cleanValue(options.personId, "personId"),
    provider: cleanOptional(options.provider, "provider") || "account",
    email: cleanOptional(options.email, "email"),
    displayName: cleanOptional(options.displayName, "displayName"),
    phone: cleanOptional(options.phone, "phone"),
    locale: cleanOptional(options.locale, "locale"),
    timestamp: new Date().toISOString(),
  };
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const validCookie = buildCookie(secret, context);
  const validHeaders = buildHeaders(secret, context);
  const staleContext = { ...context, timestamp: "2000-01-01T00:00:00.000Z" };
  const externalCookie = options.contextCookieFile && !options.dryRun
    ? cleanValue(await readFile(options.contextCookieFile, "utf8"), "contextCookieFile").trim()
    : "";
  const externalContext = externalCookie ? contextFromCookiePayload(externalCookie) : null;
  assertSyntheticSmokeContext(context, "generated smoke context");
  if (externalContext) {
    assertSyntheticSmokeContext(externalContext, "Account-minted smoke context");
  }

  const checks = [
    {
      label: "anonymous context remains anonymous",
      headers: {},
      expectedStatus: 200,
      expectedAuthenticated: false,
    },
    {
      label: "signed cookie authenticates synthetic context",
      headers: { Cookie: `${COOKIE_NAME}=${validCookie}` },
      expectedStatus: 200,
      expectedAuthenticated: true,
    },
    ...(externalCookie && externalContext
      ? [{
        label: "Account-minted signed cookie authenticates synthetic context",
        headers: { Cookie: `${COOKIE_NAME}=${externalCookie}` },
        expectedStatus: 200,
        expectedAuthenticated: true,
        context: externalContext,
      }]
      : []),
    {
      label: "signed headers authenticate synthetic context",
      headers: validHeaders,
      expectedStatus: 200,
      expectedAuthenticated: true,
    },
    {
      label: "stale signed cookie is rejected",
      headers: { Cookie: `${COOKIE_NAME}=${buildCookie(secret, staleContext)}` },
      expectedStatus: 401,
    },
    {
      label: "invalid headers do not fall back to a valid cookie",
      headers: {
        ...validHeaders,
        [HEADERS.signature]: "invalid-signature",
        Cookie: `${COOKIE_NAME}=${validCookie}`,
      },
      expectedStatus: 401,
    },
  ];

  console.log(`Account context smoke target: ${new URL(CONTEXT_PATH, baseUrl).toString()}`);
  console.log(`Synthetic person id: ${context.personId}`);
  if (options.dryRun) {
    if (options.includePageChecks) {
      console.log(`dry-run: anonymous ${CUSTOMER_PATH} renders`);
      console.log(`dry-run: signed ${CUSTOMER_PATH} renders with identity prefill`);
      if (externalCookie && externalContext) {
        console.log(`dry-run: Account-minted signed ${CUSTOMER_PATH} renders with identity prefill`);
      }
      console.log(`dry-run: ${STAFF_LOGIN_PATH} renders`);
    }
    if (options.includePricePreviewChecks) {
      console.log(`dry-run: anonymous ${PRICE_PREVIEW_PATH} ignores requested points`);
      console.log(`dry-run: signed ${PRICE_PREVIEW_PATH} accepts synthetic context`);
    }
    for (const check of checks) console.log(`dry-run: ${check.label}`);
    return;
  }

  if (options.includePageChecks) {
    await runPageChecks(baseUrl, validCookie, context, externalCookie, externalContext);
  }
  if (options.includePricePreviewChecks) {
    await runPricePreviewChecks(baseUrl, validCookie, context);
  }

  for (const check of checks) {
    await runCheck(baseUrl, check, check.context ?? context);
    console.log(`ok: ${check.label}`);
  }
}

async function runPageChecks(baseUrl, validCookie, context, externalCookie = "", externalContext = null) {
  await runPageCheck(baseUrl, {
    label: "anonymous customer page renders",
    path: CUSTOMER_PATH,
    headers: {},
    forbiddenValues: [
      context.personId,
      context.email,
      context.displayName,
      context.phone,
    ],
  });
  console.log(`ok: anonymous ${CUSTOMER_PATH} renders`);

  await runPageCheck(baseUrl, {
    label: "signed customer page renders with identity prefill",
    path: CUSTOMER_PATH,
    headers: { Cookie: `${COOKIE_NAME}=${validCookie}` },
    expectedValues: expectedPrefillValues(context),
  });
  console.log(`ok: signed ${CUSTOMER_PATH} renders with identity prefill`);

  if (externalCookie && externalContext) {
    await runPageCheck(baseUrl, {
      label: "Account-minted signed customer page renders with identity prefill",
      path: CUSTOMER_PATH,
      headers: { Cookie: `${COOKIE_NAME}=${externalCookie}` },
      expectedValues: expectedPrefillValues(externalContext),
    });
    console.log(`ok: Account-minted signed ${CUSTOMER_PATH} renders with identity prefill`);
  }

  await runPageCheck(baseUrl, {
    label: "staff login page renders",
    path: STAFF_LOGIN_PATH,
    headers: {},
  });
  console.log(`ok: ${STAFF_LOGIN_PATH} renders`);
}

async function runPricePreviewChecks(baseUrl, validCookie, context) {
  await runPricePreviewCheck(baseUrl, {
    label: "anonymous price preview ignores requested points",
    headers: {},
    expectAnonymous: true,
    context,
  });
  console.log(`ok: anonymous ${PRICE_PREVIEW_PATH} ignores requested points`);

  await runPricePreviewCheck(baseUrl, {
    label: "signed price preview accepts synthetic context",
    headers: { Cookie: `${COOKIE_NAME}=${validCookie}` },
    expectAnonymous: false,
    context,
  });
  console.log(`ok: signed ${PRICE_PREVIEW_PATH} accepts synthetic context`);
}

async function runPricePreviewCheck(baseUrl, check) {
  const response = await fetch(pricePreviewUrl(baseUrl), {
    headers: check.headers,
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`${check.label}: expected HTTP 200, got ${response.status}. Body: ${summarize(text)}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${check.label}: expected JSON response. Body: ${summarize(text)}`);
  }

  for (const field of [
    "set_qty",
    "price_per_day",
    "expected_storage_days",
    "prepaid_amount",
    "final_amount",
    "points_to_use",
    "point_discount_amount",
    "point_balance",
  ]) {
    if (typeof body[field] !== "number") {
      throw new Error(`${check.label}: ${field} must be numeric`);
    }
  }

  if (check.expectAnonymous) {
    if (body.point_balance !== 0 || body.points_to_use !== 0 || body.point_discount_amount !== 0) {
      throw new Error(`${check.label}: anonymous preview must ignore point usage`);
    }
  }

  assertNoSyntheticLeak(text, check.context, check.label);
}

function pricePreviewUrl(baseUrl) {
  const url = new URL(PRICE_PREVIEW_PATH, baseUrl);
  url.searchParams.set("suitcase_qty", "1");
  url.searchParams.set("backpack_qty", "1");
  url.searchParams.set("expected_pickup_at", nextTokyoNoon());
  url.searchParams.set("points_to_use", "1000");
  return url;
}

async function runPageCheck(baseUrl, check) {
  const response = await fetch(new URL(check.path, baseUrl), {
    headers: check.headers,
    redirect: "manual",
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`${check.label}: expected HTTP 200, got ${response.status}. Body: ${summarize(text)}`);
  }
  for (const value of (check.forbiddenValues ?? []).filter(Boolean)) {
    if (text.includes(value)) {
      throw new Error(`${check.label}: response leaked synthetic profile value "${value}"`);
    }
  }
  for (const value of (check.expectedValues ?? []).filter(Boolean)) {
    if (!text.includes(value) && !text.includes(escapeHtml(value))) {
      throw new Error(`${check.label}: response did not include expected prefilled value "${value}"`);
    }
  }
}

function expectedPrefillValues(context) {
  return [
    context.displayName,
    context.email,
    context.phone,
  ].filter(Boolean);
}

function nextTokyoNoon() {
  const future = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(future);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T12:00:00+09:00`;
}

async function runCheck(baseUrl, check, context) {
  const response = await fetch(new URL(CONTEXT_PATH, baseUrl), {
    headers: check.headers,
    redirect: "manual",
  });
  const text = await response.text();

  if (response.status !== check.expectedStatus) {
    throw new Error(`${check.label}: expected HTTP ${check.expectedStatus}, got ${response.status}. Body: ${summarize(text)}`);
  }

  if (check.expectedStatus !== 200) return;

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${check.label}: expected JSON response. Body: ${summarize(text)}`);
  }

  if (body.is_authenticated !== check.expectedAuthenticated) {
    throw new Error(`${check.label}: expected is_authenticated=${check.expectedAuthenticated}, got ${body.is_authenticated}`);
  }
  if (typeof body.point_balance !== "number") {
    throw new Error(`${check.label}: point_balance must be numeric`);
  }
  if (!Array.isArray(body.recent_orders)) {
    throw new Error(`${check.label}: recent_orders must be an array`);
  }

  assertNoSyntheticLeak(text, context, check.label);
}

function buildHeaders(secret, context) {
  const signature = signContext(secret, context);
  return pruneEmptyHeaders({
    [HEADERS.personId]: context.personId,
    [HEADERS.email]: context.email,
    [HEADERS.provider]: context.provider,
    [HEADERS.displayName]: context.displayName,
    [HEADERS.phone]: context.phone,
    [HEADERS.locale]: context.locale,
    [HEADERS.timestamp]: context.timestamp,
    [HEADERS.signature]: signature,
  });
}

function buildCookie(secret, context) {
  const payload = {
    person_id: context.personId,
    provider: context.provider,
    timestamp: context.timestamp,
    signature: signContext(secret, context),
    ...(context.email ? { email: context.email } : {}),
    ...(context.displayName ? { display_name: context.displayName } : {}),
    ...(context.phone ? { phone: context.phone } : {}),
    ...(context.locale ? { locale: context.locale } : {}),
  };
  return base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
}

function contextFromCookiePayload(cookieValue) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(cookieValue, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`Unable to decode ${COOKIE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    personId: cleanValue(payload.person_id, "cookie person_id"),
    provider: cleanOptional(payload.provider, "cookie provider") || "account",
    email: cleanOptional(payload.email, "cookie email"),
    displayName: cleanOptional(payload.display_name, "cookie display_name"),
    phone: cleanOptional(payload.phone, "cookie phone"),
    locale: cleanOptional(payload.locale, "cookie locale"),
    timestamp: cleanValue(payload.timestamp, "cookie timestamp"),
  };
}

function signContext(secret, context) {
  return createHmac("sha256", cleanValue(secret, "secret"))
    .update(canonicalize(context))
    .digest("base64url");
}

function canonicalize(context) {
  return [
    context.timestamp,
    context.personId,
    context.email,
    context.provider,
    context.displayName,
    context.phone,
    context.locale,
  ].join("\n");
}

function assertNoSyntheticLeak(text, context, label) {
  const forbidden = [
    context.personId,
    context.email,
    context.displayName,
    context.phone,
  ].filter(Boolean);
  for (const value of forbidden) {
    if (text.includes(value)) {
      throw new Error(`${label}: response leaked synthetic profile value "${value}"`);
    }
  }
}

function assertSyntheticSmokeContext(context, label) {
  const email = context.email.toLowerCase();
  const hasSyntheticEmail = email.endsWith(".invalid");
  if (email && !hasSyntheticEmail) {
    throw new Error(`${label}: email must use the reserved .invalid TLD for smoke data`);
  }

  if (!hasSyntheticEmail && !SYNTHETIC_MARKER_PATTERN.test(context.personId)) {
    throw new Error(`${label}: use a .invalid email or an obvious synthetic person id`);
  }

  if (context.displayName && !SYNTHETIC_MARKER_PATTERN.test(context.displayName)) {
    throw new Error(`${label}: display name must be empty or clearly synthetic`);
  }

  if (context.phone && !isSyntheticPhone(context.phone)) {
    throw new Error(`${label}: phone must be empty or clearly synthetic`);
  }
}

function isSyntheticPhone(value) {
  if (SYNTHETIC_MARKER_PATTERN.test(value)) return true;
  const digits = value.replace(/\D/g, "");
  if (!digits) return false;
  return /^0+$/.test(digits) || /^1+$/.test(digits) || /^9+$/.test(digits) || digits === "1234567890";
}

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.LUGGAGE_SMOKE_BASE_URL || DEFAULT_BASE_URL,
    displayName: process.env.LUGGAGE_SMOKE_DISPLAY_NAME || DEFAULT_DISPLAY_NAME,
    dryRun: false,
    email: process.env.LUGGAGE_SMOKE_EMAIL || DEFAULT_EMAIL,
    help: false,
    locale: process.env.LUGGAGE_SMOKE_LOCALE || DEFAULT_LOCALE,
    personId: process.env.LUGGAGE_SMOKE_PERSON_ID || DEFAULT_PERSON_ID,
    phone: process.env.LUGGAGE_SMOKE_PHONE || "",
    provider: process.env.LUGGAGE_SMOKE_PROVIDER || "account",
    secretEnv: process.env.LUGGAGE_SMOKE_SECRET_ENV || DEFAULT_SECRET_ENV,
    contextCookieFile: process.env.LUGGAGE_SMOKE_CONTEXT_COOKIE_FILE || "",
    includePageChecks: process.env.LUGGAGE_SMOKE_INCLUDE_PAGE_CHECKS === "1",
    includePricePreviewChecks: process.env.LUGGAGE_SMOKE_INCLUDE_PRICE_PREVIEW_CHECKS === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--base-url":
        options.baseUrl = requireValue(argv, ++index, arg);
        break;
      case "--context-cookie-file":
        options.contextCookieFile = requireValue(argv, ++index, arg);
        break;
      case "--display-name":
        options.displayName = requireValue(argv, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--email":
        options.email = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--locale":
        options.locale = requireValue(argv, ++index, arg);
        break;
      case "--include-page-checks":
        options.includePageChecks = true;
        break;
      case "--include-price-preview-checks":
        options.includePricePreviewChecks = true;
        break;
      case "--person-id":
        options.personId = requireValue(argv, ++index, arg);
        break;
      case "--phone":
        options.phone = requireValue(argv, ++index, arg);
        break;
      case "--provider":
        options.provider = requireValue(argv, ++index, arg);
        break;
      case "--secret-env":
        options.secretEnv = requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv, index, label) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${label} requires a value`);
  return value;
}

function resolveBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must be an http(s) URL");
  }
  return url;
}

function cleanValue(value, label) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) throw new Error(`${label} is required`);
  if (/[\r\n]/.test(cleaned)) throw new Error(`${label} must not contain line breaks`);
  return cleaned;
}

function cleanOptional(value, label) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return "";
  return cleanValue(cleaned, label);
}

function pruneEmptyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
}

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function summarize(text) {
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function printUsage() {
  console.log(`Usage:
  ACCOUNT_CONTEXT_SECRET=... pnpm run smoke:account-context -- --base-url https://luggage.flyingjp.com

Options:
  --base-url URL       Luggage origin or local Worker URL. Default: ${DEFAULT_BASE_URL}
  --secret-env NAME    Environment variable containing the shared secret. Default: ${DEFAULT_SECRET_ENV}
  --context-cookie-file PATH
                       Read a synthetic fj_account_context value minted by Account smoke
  --person-id VALUE    Synthetic Account person id. Default: ${DEFAULT_PERSON_ID}
  --email VALUE        Synthetic email. Default: ${DEFAULT_EMAIL}
  --display-name VALUE Synthetic display name. Default: ${DEFAULT_DISPLAY_NAME}
  --phone VALUE        Synthetic phone. Default: empty
  --locale VALUE       Synthetic locale. Default: ${DEFAULT_LOCALE}
  --provider VALUE     Provider value. Default: account
  --include-page-checks
                       Also GET /customer anonymously, /customer with a signed
                       synthetic cookie, and /staff/login. These checks do not
                       submit forms or write data.
  --include-price-preview-checks
                       Also GET /api/price-preview anonymously and with a signed
                       synthetic cookie. This check does not write data.
  --dry-run            Build checks without sending HTTP requests

Smoke identity values must be synthetic. Emails must use the reserved .invalid
TLD; names and phone values must be empty or clearly synthetic. This prevents
release-window smoke from accidentally using real customer PII.
`);
}
