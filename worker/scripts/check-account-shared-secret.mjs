#!/usr/bin/env node
import { createHash } from "node:crypto";

const DEFAULT_LUGGAGE_ENV = "ACCOUNT_CONTEXT_SECRET";
const DEFAULT_ACCOUNT_ENV = "ACCOUNT_LUGGAGE_CONTEXT_SECRET";
const DEFAULT_MIN_LENGTH = 32;

const FORBIDDEN_VALUES = new Set([
  "dev-luggage-account-context-secret",
  "dev-account-context-secret-for-smoke",
  "account-context-test-secret",
  "changeme",
  "change-me",
  "secret",
  "password",
]);

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

  const luggage = readSecret(options.luggageEnv);
  const account = readSecret(options.accountEnv);
  const failures = [
    ...validateSecret(luggage, options.luggageEnv, options.minLength),
    ...validateSecret(account, options.accountEnv, options.minLength),
  ];

  if (luggage !== account) {
    failures.push(`${options.luggageEnv} and ${options.accountEnv} must be identical`);
  }

  if (failures.length > 0) {
    console.error("Account/Luggage shared secret preflight failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  const digest = createHash("sha256").update(luggage).digest("hex").slice(0, 12);
  console.log("Account/Luggage shared secret preflight passed.");
  console.log(`Secret fingerprint: sha256:${digest}`);
  console.log(`Checked env vars: ${options.luggageEnv}, ${options.accountEnv}`);
}

function readSecret(envName) {
  return process.env[envName] ?? "";
}

function validateSecret(value, envName, minLength) {
  const failures = [];
  if (!value) {
    failures.push(`${envName} is required`);
    return failures;
  }

  if (value !== value.trim()) {
    failures.push(`${envName} must not have leading or trailing whitespace`);
  }
  if (/[\r\n]/.test(value)) {
    failures.push(`${envName} must not contain line breaks`);
  }
  if (value.length < minLength) {
    failures.push(`${envName} must be at least ${minLength} characters`);
  }
  if (FORBIDDEN_VALUES.has(value.toLowerCase())) {
    failures.push(`${envName} is a known development placeholder`);
  }
  if (/^(.)\1+$/.test(value)) {
    failures.push(`${envName} must not be a repeated single character`);
  }
  return failures;
}

function parseArgs(argv) {
  const options = {
    accountEnv: DEFAULT_ACCOUNT_ENV,
    help: false,
    luggageEnv: DEFAULT_LUGGAGE_ENV,
    minLength: DEFAULT_MIN_LENGTH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--account-env":
        options.accountEnv = requireValue(argv, ++index, arg);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--luggage-env":
        options.luggageEnv = requireValue(argv, ++index, arg);
        break;
      case "--min-length":
        options.minLength = positiveInteger(requireValue(argv, ++index, arg), arg);
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

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function printUsage() {
  console.log(`Usage:
  ACCOUNT_CONTEXT_SECRET=... ACCOUNT_LUGGAGE_CONTEXT_SECRET=... pnpm run check:account-shared-secret

Options:
  --luggage-env NAME   Env var for the Luggage-side secret. Default: ${DEFAULT_LUGGAGE_ENV}
  --account-env NAME   Env var for the Account-side secret. Default: ${DEFAULT_ACCOUNT_ENV}
  --min-length NUMBER  Minimum accepted secret length. Default: ${DEFAULT_MIN_LENGTH}
`);
}
