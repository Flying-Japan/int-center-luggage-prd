#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const luggageRepoRoot = resolve(projectRoot, "..");

const DEFAULT_ACCOUNT_PORT = 3010;
const DEFAULT_LUGGAGE_PORT = 8787;
const DEFAULT_CONTEXT_SECRET = "dev-luggage-account-context-secret";
const DEFAULT_SESSION_SECRET = "dev-local-session-secret";
const DEFAULT_SMOKE_EMAIL = "luggage-smoke@example.invalid";
const DEFAULT_SMOKE_DISPLAY_NAME = "Luggage Smoke";
const DEFAULT_SMOKE_PHONE = "000-0000-0000";
const DEFAULT_SMOKE_LOCALE = "ko";

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

  const accountDir = resolveAccountDir(options.accountDir);
  const luggageBaseUrl = `http://127.0.0.1:${options.luggagePort}`;
  const accountBaseUrl = `http://127.0.0.1:${options.accountPort}`;
  const cookieFile = options.contextCookieFile || resolve(
    tmpdir(),
    `fj-account-context-${process.pid}.cookie`,
  );
  const shouldRemoveCookie = !options.keepCookieFile;
  const processes = [];

  console.log("Cross-app Account handoff smoke");
  console.log(`Account dir: ${accountDir}`);
  console.log(`Luggage dir: ${luggageRepoRoot}`);
  console.log(`Account URL: ${accountBaseUrl}`);
  console.log(`Luggage URL: ${luggageBaseUrl}`);

  try {
    if (!options.skipMigrate) {
      run("pnpm", ["run", "db:migrate:local"], { cwd: projectRoot });
    }

    const luggageProcess = startProcess("luggage", "pnpm", [
      "exec",
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(options.luggagePort),
      "--var",
      `ACCOUNT_CONTEXT_SECRET:${options.contextSecret}`,
    ], { cwd: projectRoot });
    processes.push(luggageProcess);

    const accountProcess = startProcess("account", "pnpm", [
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.accountPort),
    ], {
      cwd: accountDir,
      env: {
        ACCOUNT_ENABLE_LOCAL_V2_SHELL: "1",
        ACCOUNT_LUGGAGE_HANDOFF_ENABLED: "1",
        ACCOUNT_LOCAL_V2_SESSION_SECRET: options.sessionSecret,
        ACCOUNT_LUGGAGE_CONTEXT_SECRET: options.contextSecret,
        ACCOUNT_LUGGAGE_CUSTOMER_URL: `${luggageBaseUrl}/customer`,
      },
    });
    processes.push(accountProcess);

    await Promise.all([
      waitForHttp(`${luggageBaseUrl}/customer/api/context`, "luggage", luggageProcess),
      waitForHttp(`${accountBaseUrl}/luggage/handoff`, "account", accountProcess),
    ]);

    run("pnpm", [
      "run",
      "smoke:luggage-handoff",
      "--",
      "--account-base-url",
      accountBaseUrl,
      "--expected-luggage-url",
      `${luggageBaseUrl}/customer`,
      "--email",
      options.smokeEmail,
      "--display-name",
      options.smokeDisplayName,
      "--phone",
      options.smokePhone,
      "--locale",
      options.smokeLocale,
      "--write-context-cookie-file",
      cookieFile,
    ], {
      cwd: accountDir,
      env: {
        ACCOUNT_LOCAL_V2_SESSION_SECRET: options.sessionSecret,
        ACCOUNT_LUGGAGE_CONTEXT_SECRET: options.contextSecret,
      },
    });

    run("pnpm", [
      "run",
      "smoke:account-context",
      "--",
      "--base-url",
      luggageBaseUrl,
      "--context-cookie-file",
      cookieFile,
      ...(options.includePageChecks ? ["--include-page-checks"] : []),
      ...(options.includePricePreviewChecks ? ["--include-price-preview-checks"] : []),
    ], {
      cwd: projectRoot,
      env: {
        ACCOUNT_CONTEXT_SECRET: options.contextSecret,
      },
    });

    console.log("ok: cross-app Account handoff smoke passed");
  } finally {
    for (const child of processes.reverse()) stopProcess(child);
    if (shouldRemoveCookie) await rm(cookieFile, { force: true });
  }
}

function parseArgs(argv) {
  const options = {
    accountDir: process.env.ACCOUNT_HANDOFF_SMOKE_ACCOUNT_DIR || "",
    accountPort: numberOption(process.env.ACCOUNT_HANDOFF_SMOKE_ACCOUNT_PORT, DEFAULT_ACCOUNT_PORT),
    contextCookieFile: process.env.ACCOUNT_HANDOFF_SMOKE_CONTEXT_COOKIE_FILE || "",
    contextSecret: process.env.ACCOUNT_HANDOFF_SMOKE_CONTEXT_SECRET || DEFAULT_CONTEXT_SECRET,
    help: false,
    includePageChecks: process.env.ACCOUNT_HANDOFF_SMOKE_INCLUDE_PAGE_CHECKS === "1",
    includePricePreviewChecks: process.env.ACCOUNT_HANDOFF_SMOKE_INCLUDE_PRICE_PREVIEW_CHECKS === "1",
    keepCookieFile: false,
    luggagePort: numberOption(process.env.ACCOUNT_HANDOFF_SMOKE_LUGGAGE_PORT, DEFAULT_LUGGAGE_PORT),
    sessionSecret: process.env.ACCOUNT_HANDOFF_SMOKE_SESSION_SECRET || DEFAULT_SESSION_SECRET,
    skipMigrate: false,
    smokeDisplayName: process.env.ACCOUNT_HANDOFF_SMOKE_DISPLAY_NAME || DEFAULT_SMOKE_DISPLAY_NAME,
    smokeEmail: process.env.ACCOUNT_HANDOFF_SMOKE_EMAIL || DEFAULT_SMOKE_EMAIL,
    smokeLocale: process.env.ACCOUNT_HANDOFF_SMOKE_LOCALE || DEFAULT_SMOKE_LOCALE,
    smokePhone: process.env.ACCOUNT_HANDOFF_SMOKE_PHONE || DEFAULT_SMOKE_PHONE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--account-dir":
        options.accountDir = requireValue(argv, ++index, arg);
        break;
      case "--account-port":
        options.accountPort = numberOption(requireValue(argv, ++index, arg), DEFAULT_ACCOUNT_PORT, arg);
        break;
      case "--context-cookie-file":
        options.contextCookieFile = requireValue(argv, ++index, arg);
        break;
      case "--context-secret":
        options.contextSecret = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--keep-cookie-file":
        options.keepCookieFile = true;
        break;
      case "--include-page-checks":
        options.includePageChecks = true;
        break;
      case "--include-price-preview-checks":
        options.includePricePreviewChecks = true;
        break;
      case "--luggage-port":
        options.luggagePort = numberOption(requireValue(argv, ++index, arg), DEFAULT_LUGGAGE_PORT, arg);
        break;
      case "--session-secret":
        options.sessionSecret = requireValue(argv, ++index, arg);
        break;
      case "--smoke-display-name":
        options.smokeDisplayName = requireValue(argv, ++index, arg);
        break;
      case "--smoke-email":
        options.smokeEmail = requireValue(argv, ++index, arg);
        break;
      case "--smoke-locale":
        options.smokeLocale = requireValue(argv, ++index, arg);
        break;
      case "--smoke-phone":
        options.smokePhone = requireValue(argv, ++index, arg);
        break;
      case "--skip-migrate":
        options.skipMigrate = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function resolveAccountDir(value) {
  const candidates = [
    value,
    resolve(luggageRepoRoot, "../pub-account-prd"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolve(resolved, "package.json")) && existsSync(resolve(resolved, "scripts/smoke-luggage-handoff.mjs"))) {
      return resolved;
    }
  }

  throw new Error("Account repo not found. Pass --account-dir /path/to/pub-account-prd.");
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function startProcess(label, command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")} (${label})`);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processInfo = { child, label, exited: false, exitCode: null, signal: null };
  child.on("exit", (code, signal) => {
    processInfo.exited = true;
    processInfo.exitCode = code;
    processInfo.signal = signal;
  });
  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(label, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(label, chunk)));
  return processInfo;
}

function stopProcess(processInfo) {
  if (!processInfo.exited && !processInfo.child.killed) processInfo.child.kill("SIGTERM");
}

async function waitForHttp(url, label, processInfo) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (processInfo?.exited) {
      throw new Error(`${label} process exited before it was ready: ${formatExit(processInfo)}`);
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) {
        await delay(250);
        if (processInfo?.exited) {
          throw new Error(`${label} process exited while starting: ${formatExit(processInfo)}`);
        }
        console.log(`ok: ${label} responded with HTTP ${response.status}`);
        return;
      }
    } catch {
      // server is still starting
    }
    await delay(500);
  }
  throw new Error(`${label} did not respond within 30s: ${url}`);
}

function formatExit(processInfo) {
  if (processInfo.signal) return `signal ${processInfo.signal}`;
  return `exit code ${processInfo.exitCode ?? "unknown"}`;
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(?<=\n)/)
    .filter(Boolean)
    .map((line) => `[${label}] ${line}`)
    .join("");
}

function requireValue(argv, index, label) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${label} requires a value`);
  return value;
}

function numberOption(value, fallback, label = "number option") {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function printUsage() {
  console.log(`Usage:
  pnpm --dir worker run smoke:cross-app-account-handoff -- --account-dir /path/to/pub-account-prd

Options:
  --account-dir PATH       Account repo checkout containing smoke:luggage-handoff
  --account-port PORT      Local Account port. Default: ${DEFAULT_ACCOUNT_PORT}
  --luggage-port PORT      Local Luggage Worker port. Default: ${DEFAULT_LUGGAGE_PORT}
  --context-secret VALUE   Synthetic shared Account/Luggage context secret
  --session-secret VALUE   Synthetic Account local session secret
  --smoke-email VALUE      Synthetic Account smoke email. Default: ${DEFAULT_SMOKE_EMAIL}
  --smoke-display-name VALUE
                           Synthetic Account smoke display name. Default: ${DEFAULT_SMOKE_DISPLAY_NAME}
  --smoke-phone VALUE      Synthetic Account smoke phone. Default: ${DEFAULT_SMOKE_PHONE}
  --smoke-locale VALUE     Synthetic Account smoke locale. Default: ${DEFAULT_SMOKE_LOCALE}
  --context-cookie-file PATH
                           Cookie handoff file path. Defaults to a temp file
  --include-page-checks    Also run Luggage GET-only /customer and /staff/login
                           page checks through smoke:account-context
  --include-price-preview-checks
                           Also run Luggage GET-only /api/price-preview checks
                           through smoke:account-context
  --keep-cookie-file       Keep the generated synthetic cookie file
  --skip-migrate           Skip local D1 schema migration before starting Luggage
`);
}
