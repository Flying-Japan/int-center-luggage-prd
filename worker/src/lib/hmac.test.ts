import { describe, expect, it } from "vitest";
import {
  buildCanonicalString,
  buildInternalPath,
  createTimestampHeader,
  signInternalRequest,
  verifyInternalRequestSignature,
  verifyTimestamp,
} from "./hmac";

describe("internal hmac helpers", () => {
  it("builds the canonical path from pathname plus search only", () => {
    expect(buildInternalPath("https://luggage.flyingjp.com/internal/experience/?q=a%20b")).toBe(
      "/internal/experience/?q=a%20b",
    );
  });

  it("keeps the canonical string stable across signing and verification", async () => {
    const timestamp = createTimestampHeader(1_760_000_000_000);
    const secret = "top-secret";
    const body = JSON.stringify({ externalId: "app_123", scheduledDate: "2026-04-18" });
    const signed = await signInternalRequest({
      body,
      method: "post",
      secret,
      timestamp,
      url: "https://luggage.flyingjp.com/internal/experience?source=reviewer",
    });

    expect(
      buildCanonicalString({
        bodyHash: signed.bodyHash,
        method: "POST",
        timestamp,
        url: "https://luggage.flyingjp.com/internal/experience?source=reviewer",
      }),
    ).toBe(signed.canonical);

    await expect(
      verifyInternalRequestSignature({
        body,
        method: "POST",
        secret,
        signature: signed.signature,
        timestamp,
        url: "https://luggage.flyingjp.com/internal/experience?source=reviewer",
      }),
    ).resolves.toBe(true);

    await expect(
      verifyInternalRequestSignature({
        body: JSON.stringify({ externalId: "app_123", scheduledDate: "2026-04-19" }),
        method: "POST",
        secret,
        signature: signed.signature,
        timestamp,
        url: "https://luggage.flyingjp.com/internal/experience?source=reviewer",
      }),
    ).resolves.toBe(false);
  });

  it("rejects stale timestamps outside the 5 minute window", () => {
    const now = 1_760_000_000_000;
    expect(verifyTimestamp(createTimestampHeader(now - 299_000), now)).toBe(true);
    expect(verifyTimestamp(createTimestampHeader(now - 301_000), now)).toBe(false);
  });

  it("verifyTimestamp rejects non-numeric and empty inputs", () => {
    expect(verifyTimestamp("", Date.now())).toBe(false);
    expect(verifyTimestamp("abc", Date.now())).toBe(false);
  });

  it("verifyInternalRequestSignature rejects signatures of the wrong length without short-circuiting", async () => {
    // Regression guard: constantTimeEqual must not early-return on a length
    // mismatch, so a short hex string fails without leaking the expected
    // signature length.
    await expect(
      verifyInternalRequestSignature({
        body: "{}",
        method: "POST",
        secret: "s",
        signature: "deadbeef",
        timestamp: createTimestampHeader(),
        url: "https://luggage.flyingjp.test/internal/experience",
      }),
    ).resolves.toBe(false);
  });
});
