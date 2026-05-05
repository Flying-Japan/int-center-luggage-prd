const encoder = new TextEncoder();

type BinaryInput = string | ArrayBuffer | Uint8Array | null | undefined;

export type InternalSignatureParams = {
  body?: BinaryInput;
  method: string;
  secret: string;
  timestamp: string;
  url: string | URL;
};

function toBytes(input: BinaryInput): Uint8Array {
  if (input === null || input === undefined) {
    return new Uint8Array();
  }

  if (typeof input === "string") {
    return encoder.encode(input);
  }

  if (input instanceof Uint8Array) {
    return input;
  }

  return new Uint8Array(input);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function urlFromInput(url: string | URL): URL {
  if (url instanceof URL) {
    return url;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return new URL(url);
  }

  return new URL(url, "https://internal.invalid");
}

export function buildInternalPath(url: string | URL): string {
  const normalized = urlFromInput(url);
  return `${normalized.pathname}${normalized.search}`;
}

export async function sha256Hex(input: BinaryInput): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(input));
  return bytesToHex(new Uint8Array(digest));
}

export function buildCanonicalString(params: {
  bodyHash: string;
  method: string;
  timestamp: string;
  url: string | URL;
}): string {
  return [
    params.method.trim().toUpperCase(),
    buildInternalPath(params.url),
    params.timestamp.trim(),
    params.bodyHash.toLowerCase(),
  ].join("\n");
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

export function constantTimeEqual(left: string, right: string): boolean {
  // Compare over the max length rather than short-circuiting on a mismatch so
  // the runtime does not leak the expected signature length. `diff` is seeded
  // with the length-mismatch bit, which makes unequal-length inputs fail the
  // final zero check without exposing a faster early-return branch.
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}

export function createTimestampHeader(now = Date.now()): string {
  return String(Math.floor(now / 1000));
}

export function verifyTimestamp(timestamp: string, now = Date.now(), toleranceMs = 300_000): boolean {
  const parsed = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(parsed * 1000 - now) <= toleranceMs;
}

export async function signInternalRequest(params: InternalSignatureParams): Promise<{
  bodyHash: string;
  canonical: string;
  signature: string;
}> {
  const bodyHash = await sha256Hex(params.body);
  const canonical = buildCanonicalString({
    bodyHash,
    method: params.method,
    timestamp: params.timestamp,
    url: params.url,
  });
  const signature = await hmacSha256Hex(params.secret, canonical);

  return { bodyHash, canonical, signature };
}

export async function verifyInternalRequestSignature(
  params: InternalSignatureParams & { signature: string },
): Promise<boolean> {
  const { signature } = await signInternalRequest(params);
  return constantTimeEqual(signature, params.signature.trim().toLowerCase());
}
