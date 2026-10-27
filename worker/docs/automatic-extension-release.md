# 21:00 JST automatic extension release — 2026-10-28

This is a forward change on the deployed finance F1 release. Do not repeat the
older F0/F1 database migrations or restore an old Worker/database automatically.

## Charging policy

- Asia/Tokyo has a fixed UTC+09:00 offset. Each expected pickup date closes at
  21:00 JST. The first extra service date is the following calendar date; each
  further 21:00 boundary adds one more service date. Midnight changes tags only.
- Reads calculate the accrued balance immediately. The existing 03:00 JST Cron
  materializes the same dates into separate extension orders, without changing
  the original price, receipts, or the total outstanding balance.
- Use the order's stored daily rate. Existing pricing policy charges excess days
  at the full stored daily rate; prepaid long-stay/pass discounts are not applied
  again. A stored daily rate of zero remains free.
- The new singleton `luggage_automatic_billing_policy.starts_at` records the
  database cutover instant. All earlier orders are excluded from new automatic
  accrual, including the unverified pending order identified before this release.
  Issued extension claims, original unpaid amounts and settlement reviews remain.
- New pending intakes without an actual tender record are unconfirmed and do not
  accrue automatically. PAID orders and partially collected pending orders can
  accrue while uncollected. A recorded pickup, invalid chronology or invalid
  daily rate excludes automatic accrual. Staff must separately review legacy or
  unconfirmed intakes; exclusion is not a waiver of a stored claim.
- Existing extension coverage, including paid and partially paid lines, excludes
  those dates from projection. The existing date uniqueness and transaction
  checks protect retries. A missed Cron run catches up uncovered dates.

## Release gates and procedure

1. Match the live F1 artifact to its validated baseline; capture all 26 bindings
   (hash non-secret values), routes, schedules, version and original table hashes.
   Leave GitHub Actions disabled and Cloudflare Builds disconnected.
2. Obtain a fresh SQL export and Time Travel bookmark. Restore only into an
   isolated local database, checking integrity and all original table values.
3. Apply `20261028_close_time_extension.sql` only, using the verified atomic D1
   import path. Never rerun it blindly: its singleton/table creation is deliberate.
   Rehearse actual Wrangler CLI success and full DDL rollback on deliberate
   failure. Keep any CASE-token whitespace formatting token-equivalent.
4. Compare all original financial summaries, claims, payment and audit rows before
   and after. Existing unverified orders must produce zero new automatic charges.
5. Package F1 offline with the existing `offlinePackage` safeguards. Deploy the
   exact verified prebuilt artifact with `wrangler.f1.toml`, `--no-bundle` and
   `--keep-vars`. Do not deploy the default F0 entry or upload static R2 assets.
6. Confirm 100% new version, exact artifact bytes, all existing binding values,
   D1/R2, routes, both Crons and disabled preview URLs. Perform signed GET-only
   financial API verification before enabling automatic generation.
7. Enable only `AUTO_EXTENSION_ENABLED` after the final zero-legacy-charge
   simulation passes. Preserve all existing bindings/Secrets and runtime metadata.
   Verify the actual active setting and unchanged Cron schedules afterward.

Unified Admin's existing billing contract is sufficient: `outstanding_amount`
and `extension_outstanding_amount` include projection and issued charges once.
The old original-order `extra_amount` field is not overwritten by child invoices.
No Unified Admin redeploy is required. A simulation is not a production Cron run.

## Validation

The billing suite covers 20:59 pickup, 21:00/21:01 accrual, consecutive evenings,
midnight, duplicate/concurrent runs, missed-run catch-up, paid/partial receipts,
cutover exclusion, unconfirmed pending intake, cancelled/picked-up/invalid orders,
preserved settlement reviews and unchanged original money. Additional release
evidence is stored privately outside Git; SQL backups contain customer data.

Stop on any unexplained money difference, backup/import failure, artifact drift,
or deployment guard failure. Keep the current service running when preparation
fails. Do not delete/rewrite receipts, restore production D1 or roll back to a
pre-finance Worker. Diagnose and use a verified forward fix if a live gate fails.
