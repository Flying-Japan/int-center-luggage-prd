# Account History + Points Production Promotion

This branch prepares `int-center-luggage-prd` for Account history presets and
point usage promotion without deploying production behavior yet.

## Current Gate State

- Production D1 schema migration `20260521_customer_history_points_prep` has
  been applied and audited separately.
- Account signed context is still blocked on the production Account login/signup
  source and shared secret rollout.
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

## Required Verification Before Deployment

Run from the repository root:

```sh
pnpm --dir worker typecheck
pnpm --dir worker test
pnpm --dir worker run check:schema-drift
pnpm --dir worker run check:static-assets
pnpm --dir worker run deploy:dry-run
```

## Production Smoke Checklist

Do not use real customer PII for smoke data.

1. Anonymous `/customer` render has no Account context and no points UI.
2. Anonymous `/customer/submit` creates an order with `account_person_id IS NULL`
   and no point ledger rows.
3. Signed synthetic Account context renders `/customer` as authenticated.
4. `/customer/api/context` returns only safe previous-order preset fields for
   the signed synthetic person.
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
