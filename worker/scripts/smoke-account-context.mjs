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
const STAFF_LOGIN_PATH = "/staff/login";
const COOKIE_NAME = "fj_account_context";

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
      console.log(`dry-run: signed ${CUSTOMER_PATH} renders`);
      console.log(`dry-run: ${STAFF_LOGIN_PATH} renders`);
    }
    for (const check of checks) console.log(`dry-run: ${check.label}`);
    return;
  }

  if (options.includePageChecks) {
    await runPageChecks(baseUrl, validCookie, context);
  }

  for (const check of checks) {
    await runCheck(baseUrl, check, check.context ?? context);
    console.log(`ok: ${check.label}`);
  }
}

async function runPageChecks(baseUrl, validCookie, context) {
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
    label: "signed customer page renders",
    path: CUSTOMER_PATH,
    headers: { Cookie: `${COOKIE_NAME}=${validCookie}` },
  });
  console.log(`ok: signed ${CUSTOMER_PATH} renders`);

  await runPageCheck(baseUrl, {
    label: "staff login page renders",
    path: STAFF_LOGIN_PATH,
    headers: {},
  });
  console.log(`ok: ${STAFF_LOGIN_PATH} renders`);
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
  --dry-run            Build checks without sending HTTP requests
`);
}
