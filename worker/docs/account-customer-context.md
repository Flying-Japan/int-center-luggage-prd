# Account Customer Context Contract

Luggage accepts logged-in customer identity only from signed Account-provided
context. It does not infer identity from customer-submitted email or phone.

## Header Contract

Server-to-server callers or reverse proxies may send:

- `X-Flying-Account-Person-Id`: canonical Account `person_id`.
- `X-Flying-Account-Timestamp`: ISO timestamp generated when the context is signed.
- `X-Flying-Account-Signature`: base64url HMAC-SHA256 signature.

Optional profile headers:

- `X-Flying-Account-Email`
- `X-Flying-Account-Provider`
- `X-Flying-Account-Display-Name`
- `X-Flying-Account-Phone`
- `X-Flying-Account-Locale`

If `X-Flying-Account-Provider` is omitted, luggage uses `account`.

## Browser Handoff Cookie

Normal browser redirects cannot attach custom `X-Flying-Account-*` request
headers. For direct customer navigation from `account.flyingjp.com` to
`luggage.flyingjp.com`, Account should set:

```txt
fj_account_context=<base64url-json>; Max-Age=300; Path=/; Domain=.flyingjp.com; SameSite=Lax; HttpOnly; Secure
```

The cookie JSON payload uses snake_case keys:

```json
{
  "person_id": "person_123",
  "provider": "account",
  "timestamp": "2026-05-22T03:15:00.000Z",
  "signature": "<base64url hmac>",
  "email": "customer@example.com",
  "display_name": "Kim Customer",
  "phone": "010-1111-2222",
  "locale": "ko"
}
```

## Signature Payload

The signature is computed over these newline-separated fields in this exact
order:

```txt
timestamp
person_id
email
provider
display_name
phone
locale
```

Missing optional fields are signed as empty strings.

## Luggage Behavior

- Requests without Account headers or cookie remain anonymous.
- Requests with Account context are rejected unless the shared
  `ACCOUNT_CONTEXT_SECRET` validates the signature.
- Signed contexts expire after 300 seconds by default. Override with
  `ACCOUNT_CONTEXT_MAX_AGE_SECONDS` only for controlled testing.
- Logged-in intake stores `person_id` in `luggage_orders.account_person_id`.
- For logged-in intake, Account-provided `display_name`, `phone`, and `email`
  take precedence over form-submitted values.
- Anonymous intake never sets `account_person_id`, even if submitted email or
  phone matches a previous customer.
- `/customer/api/context` is available as a no-store smoke/preset endpoint. It
  returns `is_authenticated`, point balance, and previous-order preset fields
  only; it does not return profile PII or the Account person id.
- `pnpm --dir worker run smoke:account-context` signs the same cookie/header
  contract with synthetic data and verifies anonymous, cookie, header, stale
  timestamp, and invalid-header-over-cookie behavior against
  `/customer/api/context`. Add `--include-page-checks` during release-window
  smoke to also GET anonymous `/customer`, signed `/customer`, and
  `/staff/login` without submitting forms. Add
  `--include-price-preview-checks` to verify anonymous and signed
  `/api/price-preview` behavior without writing data. For local-only
  verification, add `--include-local-submit-checks` to POST a synthetic signed
  `/customer/submit`, then confirm the submitted language is reused from the
  local profile cache on the next signed `/customer` render and that the same
  order appears in `/customer/api/context` as a safe previous-history preset
  without profile PII or Account identifiers. This option refuses non-loopback
  base URLs. The smoke script rejects real-looking identity values by default:
  email values must use the reserved `.invalid` TLD, and optional name/phone
  values must be empty or clearly synthetic.
- If Account headers and cookie are both present, Luggage validates the headers
  and does not fall back to the cookie. This prevents a browser-supplied invalid
  header from being hidden by a valid cookie.

## Account-Side Gate

The matching Account production PR is
`Flying-Japan/pub-account-prd#1`. The currently verified Account head is:

```txt
477b8b6e6966da9628760943ac35a79676411ebd
```

That Account head adds the production auth success hooks that call
`provisionAccountCustomerIdentity()` for non-admin customers after Supabase Auth
succeeds, plus `pnpm run smoke:luggage-handoff`, a local-only synthetic handoff
smoke that:

- builds a `.invalid` local v2 session cookie.
- calls Account `/luggage/handoff`.
- requires a `303` redirect to the configured local Luggage URL.
- decodes `fj_account_context`.
- verifies the cookie HMAC with `ACCOUNT_LUGGAGE_CONTEXT_SECRET`.
- can write the verified synthetic cookie to a temporary file for Luggage to
  consume with `pnpm --dir worker run smoke:account-context -- --context-cookie-file <path>`.
- includes a production-host route test proving `account.flyingjp.com` redirects
  to `https://luggage.flyingjp.com/customer` with a short-lived
  `Domain=.flyingjp.com`, `HttpOnly`, `Secure` context cookie.
- includes `check:luggage-shared-secret` and Vitest coverage proving matching
  planned Account/Luggage secret values pass, known development placeholders
  fail, mismatches fail, custom env names work, and the secret value is not
  printed.

This proves Account can provision customer identity after auth success and can
produce the same signed browser handoff cookie that Luggage validates here,
without enabling production secrets or deploying this Luggage branch.

Production secrets must be configured in Cloudflare and must match the Account
caller. Never commit real shared secrets.

Before writing production secrets, verify the two intended values locally
without printing the secret itself:

```sh
ACCOUNT_CONTEXT_SECRET=... \
ACCOUNT_LUGGAGE_CONTEXT_SECRET=... \
pnpm --dir worker run check:account-shared-secret
```

The preflight rejects empty, short, placeholder, whitespace-padded, multiline,
or mismatched values and prints only a short SHA-256 fingerprint.
