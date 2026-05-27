export const DEFAULT_LUGGAGE_ENV = "ACCOUNT_CONTEXT_SECRET";
export const DEFAULT_ACCOUNT_ENV = "ACCOUNT_LUGGAGE_CONTEXT_SECRET";
export const DEFAULT_MIN_LENGTH = 32;

export const FORBIDDEN_VALUES = new Set([
  "dev-luggage-account-context-secret",
  "dev-account-context-secret-for-smoke",
  "account-context-test-secret",
  "changeme",
  "change-me",
  "secret",
  "password",
]);

export function validateSharedSecretPair({
  luggage,
  account,
  luggageEnv = DEFAULT_LUGGAGE_ENV,
  accountEnv = DEFAULT_ACCOUNT_ENV,
  minLength = DEFAULT_MIN_LENGTH,
}) {
  const failures = [
    ...validateSecret(luggage, luggageEnv, minLength),
    ...validateSecret(account, accountEnv, minLength),
  ];

  if (luggage !== account) {
    failures.push(`${luggageEnv} and ${accountEnv} must be identical`);
  }

  return failures;
}

export function validateSecret(value, envName, minLength) {
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
