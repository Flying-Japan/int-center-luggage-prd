/**
 * Google Sheets API client for Cloudflare Workers.
 * Uses service account JWT auth with Web Crypto API (no Node.js crypto).
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** Cached access token */
let cachedToken: { token: string; expiresAt: number } | null = null;

/** Base64url encode (no padding, URL-safe) */
function base64url(input: string): string {
  return btoa(input)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Create a signed JWT for Google API authentication.
 * Uses RSASSA-PKCS1-v1_5 with SHA-256 (RS256) via Web Crypto API.
 */
async function createJWT(sa: ServiceAccount): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );

  // Import private key
  const pemContent = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const keyData = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const input = new TextEncoder().encode(`${header}.${claims}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, input);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${header}.${claims}.${sig}`;
}

/**
 * Get an access token for Google APIs, caching for ~55 minutes.
 */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const jwt = await createJWT(sa);
  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google token exchange failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in - 300) * 1000, // refresh 5 min early
  };
  return data.access_token;
}

/**
 * Fetch rows from a Google Sheet.
 * @param credentialsJson JSON string of service account credentials
 * @param spreadsheetId Google Sheets spreadsheet ID
 * @param range Sheet range (e.g., "Daily 01.Mar!A:N")
 * @returns 2D array of cell values
 */
export async function fetchSheetData(
  credentialsJson: string,
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const sa = JSON.parse(credentialsJson) as ServiceAccount;
  const token = await getAccessToken(sa);

  const encodedRange = encodeURIComponent(range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedRange}?valueRenderOption=FORMATTED_VALUE`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google Sheets API error: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { values?: string[][] };
  return data.values || [];
}
