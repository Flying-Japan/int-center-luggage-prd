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
  `/customer/api/context`.
- If Account headers and cookie are both present, Luggage validates the headers
  and does not fall back to the cookie. This prevents a browser-supplied invalid
  header from being hidden by a valid cookie.

Production secrets must be configured in Cloudflare and must match the Account
caller. Never commit real shared secrets.
