# Account History + Points Production Promotion

This branch prepares `int-center-luggage-prd` for Account history presets and
point usage promotion without deploying production behavior yet.

## Current Gate State

- Production D1 schema migration `20260521_customer_history_points_prep` has
  been applied and audited separately.
- Account signed context is still blocked on the production Account login/signup
  source and shared secret rollout.
- The matching Account PR is `Flying-Japan/pub-account-prd#1` at
  `5966b6d0ab47d28f184cc9ecc13feb5573378fdd`; its CI is green and its
  synthetic local `/luggage/handoff` smoke verifies the `fj_account_context`
  cookie signature.
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
- Previous-history selection records `source_preset_order_id` only after
  ownership is checked against the signed Account person.
- `/customer/api/context` returns a no-store JSON smoke surface with only
  authentication state, point balance, and previous-order preset fields. It does
  not return profile PII or the Account person id.

## Branch Verification

Last run on 2026-05-22 JST from `/private/tmp/luggage-prep`:

```sh
pnpm --dir worker typecheck
pnpm --dir worker test
pnpm --dir worker run check:schema-drift
pnpm --dir worker run check:static-assets
pnpm --dir worker run deploy:dry-run
ACCOUNT_CONTEXT_SECRET=... pnpm --dir worker run smoke:account-context -- --base-url <luggage-base-url>
```

Results:

- Typecheck passed.
- Vitest passed: 6 files, 46 tests.
- Schema drift passed for 3 tables, 7 columns, and 5 indexes.
- Customer asset guard passed.
- Wrangler dry run passed with no deployment.
- `smoke:account-context -- --dry-run` passed locally without printing the
  shared secret or signed cookie value.
- Account PR #1 local handoff smoke passed on the Account branch head
  `5966b6d0ab47d28f184cc9ecc13feb5573378fdd`, and Account CI passed
  `build-and-test`, `e2e-canary`, and `gitleaks`.

## Required Verification Before Deployment

Run from the repository root:

```sh
pnpm --dir worker typecheck
pnpm --dir worker test
pnpm --dir worker run check:schema-drift
pnpm --dir worker run check:static-assets
pnpm --dir worker run deploy:dry-run
ACCOUNT_CONTEXT_SECRET=... pnpm --dir worker run smoke:account-context -- --base-url <luggage-base-url>
```

Use `--dry-run` before secrets are wired to verify the synthetic payload and
check list without sending HTTP requests. The smoke script only calls
`/customer/api/context`; it does not submit a customer intake form.

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
  --account-dir /path/to/pub-account-prd
```

## Production Smoke Checklist

Do not use real customer PII for smoke data.

1. Anonymous `/customer` render has no Account context and no points UI.
2. Anonymous `/customer/submit` creates an order with `account_person_id IS NULL`
   and no point ledger rows.
3. Signed synthetic Account context renders `/customer` as authenticated.
4. `/customer/api/context` returns `is_authenticated = true`, point balance,
   and only safe previous-order preset fields for the signed synthetic person.
   Use `pnpm --dir worker run smoke:account-context` for this check after the
   shared secret is configured.
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
