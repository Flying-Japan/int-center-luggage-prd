#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  DEFAULT_ACCOUNT_ENV,
  DEFAULT_LUGGAGE_ENV,
  DEFAULT_MIN_LENGTH,
  FORBIDDEN_VALUES,
  validateSharedSecretPair,
} from "./shared-secret-preflight.mjs";

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
  const failures = validateSharedSecretPair({
    account,
    accountEnv: options.accountEnv,
    luggage,
    luggageEnv: options.luggageEnv,
    minLength: options.minLength,
  });

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
