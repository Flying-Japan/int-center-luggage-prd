import { describe, expect, it } from "vitest";
// @ts-expect-error The production CLI helper is an ESM runtime module outside the TS source tree.
import { validateSharedSecretPair } from "../../scripts/shared-secret-preflight.mjs";

describe("check-account-shared-secret", () => {
  it("passes matching non-placeholder Luggage and Account values", () => {
    const secret = "synthetic-release-secret-20260527-abcdef";

    const failures = validateSharedSecretPair({
      account: secret,
      luggage: secret,
    });

    expect(failures).toEqual([]);
  });

  it("rejects known development placeholders", () => {
    const failures = validateSharedSecretPair({
      account: "dev-account-context-secret-for-smoke",
      luggage: "dev-account-context-secret-for-smoke",
    });

    expect(failures).toContain("ACCOUNT_CONTEXT_SECRET is a known development placeholder");
    expect(failures).toContain("ACCOUNT_LUGGAGE_CONTEXT_SECRET is a known development placeholder");
  });

  it("rejects mismatched Luggage and Account values without echoing the values", () => {
    const luggage = "synthetic-release-secret-20260527-luggage";
    const account = "synthetic-release-secret-20260527-account";
    const failures = validateSharedSecretPair({
      account,
      luggage,
    });
    const joined = failures.join("\n");

    expect(failures).toContain("ACCOUNT_CONTEXT_SECRET and ACCOUNT_LUGGAGE_CONTEXT_SECRET must be identical");
    expect(joined).not.toContain(luggage);
    expect(joined).not.toContain(account);
  });

  it("supports custom environment variable names", () => {
    const secret = "synthetic-release-secret-20260527-custom";
    const failures = validateSharedSecretPair({
      account: secret,
      accountEnv: "ACCOUNT_SHARED_SECRET_NEXT",
      luggage: secret,
      luggageEnv: "LUGGAGE_SHARED_SECRET_NEXT",
    });

    expect(failures).toEqual([]);
  });
});
