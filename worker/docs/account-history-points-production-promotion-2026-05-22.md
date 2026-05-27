# Account History + Points Production Promotion

This branch prepares `int-center-luggage-prd` for Account history presets and
point usage promotion without deploying production behavior yet.

## Current Gate State

- Production D1 schema migration `20260521_customer_history_points_prep` has
  been applied and audited separately.
- Account signed context is still blocked on coordinated shared secret rollout,
  release-window smoke, and explicit production deployment approval.
- Track the live Luggage PR head and check status in
  `Flying-Japan/int-center-luggage-prd#7` and the dev promotion gate. Do not
  copy this branch's moving head SHA into this document; each docs-only commit
  would immediately make that value stale.
- The matching Account PR is `Flying-Japan/pub-account-prd#1` at
  `2993bb8e3accffde6ea83910a937f313dfdca51f`; its CI is green, its production
  auth success hooks call `provisionAccountCustomerIdentity()` for non-admin
  customers, its production-host route test covers the secure
  `.flyingjp.com` handoff cookie, and its synthetic local `/luggage/handoff`
  smoke verifies the `fj_account_context` cookie signature.
- This branch must not be deployed until `ACCOUNT_CONTEXT_SECRET` is configured
  and the Account caller has passed a synthetic no-PII smoke.

## Promotion Scope

- Signed Account customer context middleware.
- Browser-compatible `fj_account_context` cookie validation for Account ->
  Luggage handoff.
- Previous-history preset loading by `account_person_id`.
- Point usage validation and order snapshot fields.
- Point ledger mutation helpers and staff status transition hooks already
  present in this prep branch.
- Customer submit now reserves point usage and inserts the order in a single D1
  `batch()` transaction. The intake transaction stays `RESERVED` so existing
  staff status transitions can commit or release it later.
- Customer submit redirects now send `Cache-Control: no-store`, `Pragma:
  no-cache`, and `Expires: 0` so completion-token and validation-error
  redirects are not cached.
- Previous-history selection records `source_preset_order_id` only after
  ownership is checked against the signed Account person.
- `/customer/api/context` returns a no-store JSON smoke surface with only
  authentication state, point balance, and previous-order preset fields. It does
  not return profile PII or the Account person id.

## Branch Verification

Last run on 2026-05-27 JST from `/private/tmp/luggage-pr7-next`:

```sh
node --check worker/scripts/smoke-account-context.mjs
node --check worker/scripts/smoke-cross-app-account-handoff.mjs
node --check worker/scripts/check-account-shared-secret.mjs
node --check worker/scripts/shared-secret-preflight.mjs
pnpm --dir worker typecheck
pnpm --dir worker test src/scripts/checkAccountSharedSecret.test.ts
pnpm --dir worker test
pnpm --dir worker run check:schema-drift
pnpm --dir worker run check:static-assets
pnpm --dir worker run deploy:dry-run
ACCOUNT_CONTEXT_SECRET=... ACCOUNT_LUGGAGE_CONTEXT_SECRET=... \
  pnpm --dir worker run check:account-shared-secret
ACCOUNT_CONTEXT_SECRET=... pnpm --dir worker run smoke:account-context -- \
  --dry-run \
  --include-page-checks \
  --include-price-preview-checks
pnpm --dir worker run smoke:cross-app-account-handoff -- \
  --account-dir /Users/sanghunbruceham/Documents/GitHub/pub-account-prd \
  --account-port 13011 \
  --luggage-port 18788 \
  --include-page-checks \
  --include-price-preview-checks \
  --include-local-submit-checks
```

Results:

- Smoke script syntax checks passed.
- Typecheck passed.
- Shared-secret preflight tests passed: 4 tests.
- Vitest passed: 9 files, 74 tests.
- Schema drift passed for 3 customer history/points tables, 8 required
  `luggage_orders` columns including `view_token`, and 5 indexes; customer
  asset guard and Wrangler deploy dry-run passed.
- `check:account-shared-secret` passed with a synthetic non-production value and
  printed only a short SHA-256 fingerprint. It also rejected known development
  placeholders and mismatched Account/Luggage values without printing either
  secret value.
- The Luggage preflight validation helper is covered by Worker-pool-compatible
  Vitest tests for matching values, placeholder rejection, mismatch rejection,
  custom env names, and no secret-value echoing in failure text.
- `smoke:account-context -- --dry-run --include-page-checks --include-price-preview-checks`
  passed locally without printing the shared secret or signed cookie value, and
  the smoke now rejects real-looking identity values by default.
- `smoke:cross-app-account-handoff -- --include-page-checks --include-price-preview-checks`
  passed against the Luggage PR runtime code and Account head
  `2993bb8e3accffde6ea83910a937f313dfdca51f` with
  `--include-local-submit-checks`. This verified
  anonymous `/customer`, signed `/customer`, `/staff/login`, anonymous and
  signed `/api/price-preview`, anonymous context, signed generated cookie,
  Account-minted cookie, signed headers, stale timestamp rejection,
  invalid-header-over-cookie rejection, and Account-minted signed
  `/customer/submit` writing the profile-cache locale that the next signed
  `/customer` render reuses. Focused submit tests now verify both successful
  completion redirects and validation-error redirects are no-store. The same
  submit smoke now also verifies the submitted order appears in
  `/customer/api/context` as a safe previous-history preset without profile PII
  or Account identifiers.
- Account PR #1 local handoff smoke passed on the Account branch head
  `2993bb8e3accffde6ea83910a937f313dfdca51f`, and Account CI
  #26491551536 passed `build-and-test`, `e2e-canary`, and `gitleaks`.

## Required Verification Before Deployment

Run from the repository root:

```sh
pnpm --dir worker typecheck
pnpm --dir worker test src/scripts/checkAccountSharedSecret.test.ts
pnpm --dir worker test
pnpm --dir worker run check:schema-drift
pnpm --dir worker run check:static-assets
pnpm --dir worker run deploy:dry-run
ACCOUNT_CONTEXT_SECRET=... ACCOUNT_LUGGAGE_CONTEXT_SECRET=... \
  pnpm --dir worker run check:account-shared-secret
ACCOUNT_CONTEXT_SECRET=... pnpm --dir worker run smoke:account-context -- \
  --base-url <luggage-base-url> \
  --include-page-checks \
  --include-price-preview-checks
```

Use `--dry-run` before secrets are wired to verify the synthetic payload and
check list without sending HTTP requests. `--include-page-checks` adds GET-only
checks for `/customer` and `/staff/login`; `--include-price-preview-checks`
adds GET-only checks for `/api/price-preview`. The smoke script does not submit
a customer intake form unless `--include-local-submit-checks` is explicitly
added. That submit option is for loopback/local smoke only and refuses
non-loopback base URLs; use it before release to prove the profile-cache write
and locale reuse path plus safe previous-history preset output without touching
production data. Smoke identity values must remain synthetic: use a reserved
`.invalid` email address, and leave optional name/phone values empty or clearly
mark them as smoke/test values.

`check:account-shared-secret` is a local preflight for the planned production
secret values. It does not read Cloudflare and does not print the secret; it
only verifies both env vars are identical and acceptable before an operator
writes them to Account and Luggage production. The validation helper is tested
so placeholder, mismatch, custom env-name, and no-secret-output behavior are
guarded in CI.

For a cross-app local smoke, first ask Account to write its verified synthetic
handoff cookie, then pass that cookie to Luggage:

```sh
ACCOUNT_LOCAL_V2_SESSION_SECRET=... \
ACCOUNT_LUGGAGE_CONTEXT_SECRET=... \
pnpm run smoke:luggage-handoff -- --write-context-cookie-file /tmp/fj-account-context.cookie

ACCOUNT_CONTEXT_SECRET=... \
pnpm --dir worker run smoke:account-context -- \
  --base-url http://127.0.0.1:8787 \
  --context-cookie-file /tmp/fj-account-context.cookie
```

The same flow can be run as one command from this Luggage promotion worktree:

```sh
pnpm --dir worker run smoke:cross-app-account-handoff -- \
  --account-dir /path/to/pub-account-prd \
  --include-page-checks \
  --include-price-preview-checks \
  --include-local-submit-checks
```

## Production Smoke Checklist

Do not use real customer PII for smoke data.

1. Anonymous `/customer` render has no Account context and no points UI.
2. Anonymous `/customer/submit` creates an order with `account_person_id IS NULL`
   and no point ledger rows, and the success redirect is no-store.
3. Signed synthetic Account context renders `/customer` as authenticated.
4. `/customer/api/context` returns `is_authenticated = true`, point balance,
   and only safe previous-order preset fields for the signed synthetic person.
   Use `pnpm --dir worker run smoke:account-context -- --include-page-checks --include-price-preview-checks`
   for this check after the shared secret is configured.
5. Selecting a previous-history preset fills the form only after customer action.
6. Submitting with controlled point usage writes:
   - `luggage_orders.account_person_id`
   - `source_preset_order_id`
   - `gross_amount`
   - `point_discount_amount`
   - `points_used`
   - `point_usage_status`
   - corresponding point ledger/account mutations
7. Staff order amount views show gross/discount/final amounts correctly.
8. Bad signature, stale timestamp, and browser-supplied invalid Account headers
   all return 401 and do not silently fall back to another identity source.

## Rollback

1. Disable the Account caller route or remove the Account -> Luggage handoff.
2. Remove or rotate `ACCOUNT_CONTEXT_SECRET` if the shared secret is suspected
   to be exposed.
3. Redeploy the previous Worker version if customer intake behavior regresses.
4. Leave the D1 schema in place unless a separate D1 rollback is explicitly
   approved; the added columns/tables are inert without signed Account context.
