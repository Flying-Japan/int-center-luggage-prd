# Handoff — Account history/points intake + luggage hardening

**Date:** 2026-05-28
**Status:** ON HOLD — development paused, ready for another owner to pick up.
**Repo:** `Flying-Japan/int-center-luggage-prd` (Cloudflare Worker: Hono + D1 + R2)

This document is the single source of truth for where this stream of work stands.
Everything technical is done; the only remaining work is a **cross-team deployment
gate** plus a follow-up infra landing that is blocked on it.

---

## TL;DR — what the next person needs to do

1. **Get deployment approval** for the Account history/points feature (business/release gate).
2. **Roll out the shared secret `ACCOUNT_CONTEXT_SECRET`** to BOTH workers (see §4). This is a hard gate — deploying PR #7 without it breaks the signed-context middleware.
3. **Smoke-test, then merge PR #7** (see §4).
4. **Land the orphaned Phase-3 infra** (see §5) — separate, can follow later.

Nothing auto-deploys. PR #7 is a draft and will not ship until someone merges it.

---

## 1. What already shipped to production (DONE — no action needed)

All merged to `main`, deployed via Workers Builds, and smoke-verified on `https://luggage.flyingjp.com`:

| PR | Commit | What |
| --- | --- | --- |
| #8 | `595156f` | `fix(security)`: calendar embed URL host-allowlist (parse + exact hostname match + `rel=noopener`) before iframe render on `/staff/schedule` |
| #9 | `adc2413` | `chore(security)`: gitignore `secrets/` + `*.service-account.json` (closed a path where a GCP key could be committed) |
| #10 | `1e77b12` | `fix(sentry)`: narrow `customer_required_asset_load_failed` filter to same-origin assets (was firing on cross-origin CDN flakes) — resolves Sentry issue `INT-CENTER-LUGGAGE-PRD-6` |

## 2. Credentials handled (DONE)

- The Google Chat ops-alert **GCP service-account key** was migrated to **Cloudflare Secrets Store**:
  - Store: `flying-ops` (ID `7ff0a5eb1c4a46829b23870def9a688a`)
  - Secret: `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` (ID `ec5960e590c840e9b77fe1388be00d84`), scope `workers`, status `active`
- The local plaintext key file (`worker/secrets/…service-account.json`) was **deleted**. Verified it was never in git history or pushed.
- **Policy note:** Flying projects use **Cloudflare Secrets Store** as the canonical secret store. 1Password is no longer used.

---

## 3. PR #7 — `Promote Account history and points intake` (READY, GATED)

- Branch: `codex/promote-account-history-points-prod`
- Head: `9f871e2` · synced with current `main` · **CI green** · **MERGEABLE** · still **draft**
- Full worker test suite: **79 passing** · `pnpm typecheck` clean

### What it does
Signed Account context (cookie `fj_account_context`) → optional customer auth on
`/customer`, `/customer/*`, `/api/price-preview`; previous-order history with
ownership guards; atomic point usage; `no-store` on signed responses.

### Code review — all findings resolved
| Severity | Finding | Resolution |
| --- | --- | --- |
| HIGH | Timing oracle in `customerAuth.ts` (length-leaking compare) | Replaced with `constantTimeEqual` from `lib/hmac` |
| HIGH | Point-batch `changes()` chain relied on undocumented D1 behavior | Documented load-bearing invariant (D1 batch is sequential/non-concurrent — confirmed in CF docs). No logic change. |
| HIGH | `cacheSignedCustomerProfile` stamped `identity_verified_at` on every submit | Removed that column from the write |
| MEDIUM | Points on cancel ("ambiguous") | **Was a real points-loss bug** — see below — FIXED (`9f871e2`) |

### The points-loss bug (most important fix — `9f871e2`)
`releaseReservedPointUseForOrder` only acts on `RESERVED` reservations, but PAID
flips the reservation to `POSTED`. So cancelling a **paid** order
(`PAID → CANCELLED`, or `PAID → PAYMENT_PENDING → CANCELLED`) left the customer's
**spent points permanently deducted**.
Fix: added `refundCommittedPointUseForOrder` (`POSTED → REFUNDED`, key
`point:refund:<order>`) and wired it into the CANCELLED branch alongside release.
Confirmed reachable from the real staff cancel route (`staffApi.ts:242`).
**Policy decision (confirmed):** cancelling a paid order refunds the spent points.

### Account-side security prerequisites — VERIFIED SAFE
- Cookie `fj_account_context` is issued by `pub-account-prd` with
  `HttpOnly; Secure; SameSite=Lax; Max-Age=300; Domain=.flyingjp.com`
  (`secure:false` only for localhost). 19 account-side tests pass.
- Luggage prod has `ACCOUNT_CONTEXT_MAX_AGE_SECONDS` **unset** → safe 300s default
  (NOT the 7-day test fixture).

---

## 4. THE GATE — secret rollout + merge (next owner does this)

PR #7's own promotion doc (`worker/docs/account-history-points-production-promotion-2026-05-22.md`)
declares: *"must not be deployed until `ACCOUNT_CONTEXT_SECRET` is configured"* +
release-window smoke + explicit deployment approval.

**`ACCOUNT_CONTEXT_SECRET` is currently NOT set in luggage prod** (verified).

The two sides use different env-var names for the **same value**:

| Service | Worker | Env var |
| --- | --- | --- |
| Luggage | `int-center-luggage-api` | `ACCOUNT_CONTEXT_SECRET` |
| Account | `pub-account-prd` | `ACCOUNT_LUGGAGE_CONTEXT_SECRET` |

### Step A — set the shared secret (after approval)
```bash
SHARED=$(openssl rand -hex 32)

cd <repo>/int-center-luggage-prd/worker
ACCOUNT_CONTEXT_SECRET="$SHARED" ACCOUNT_LUGGAGE_CONTEXT_SECRET="$SHARED" \
  pnpm run check:account-shared-secret        # must print "preflight passed" + sha256 fingerprint

printf '%s' "$SHARED" | pnpm wrangler secret put ACCOUNT_CONTEXT_SECRET            # luggage
cd <repo>/pub-account-prd
printf '%s' "$SHARED" | pnpm wrangler secret put ACCOUNT_LUGGAGE_CONTEXT_SECRET    # account (same value)
```
- Use `printf '%s'` (NOT `echo`) — no trailing newline, or the HMAC won't match.
- Both default (prod) env, no `--env`.
- The two values MUST be identical (HMAC sign vs verify).

### Step B — smoke, then merge
```bash
cd <repo>/int-center-luggage-prd/worker
ACCOUNT_CONTEXT_SECRET="$SHARED" pnpm run smoke:account-context -- \
  --base-url https://luggage.flyingjp.com --include-page-checks --include-price-preview-checks
unset SHARED

gh pr ready 7 && gh pr merge 7 --squash --delete-branch   # un-draft → merge → deploy
```
> Order matters: secret FIRST, then merge/deploy. Deploying before the secret exists breaks the middleware.

---

## 5. Phase E — orphaned Phase-3 infra (blocked on PR #7 merge)

Snapshot branch: **`wip/phase3-infra-uncommitted`** (`8247016`). Nothing lost.
This is ~3 weeks of un-landed infra. It is entangled with PR #7's foundation
(test harness, `orderAmounts`, wiring files), so it must land **after** #7 merges.

Land as separate, reviewable PRs in this order, re-validating each against the
current schema (the snapshot is 5 weeks old — crons can deploy clean but emit
wrong numbers if schema drifted):

1. `googleChat.ts` + `retentionAlerts.ts` → retention cron. **Land dark / secret-guarded.** Add the Secrets Store binding:
   ```toml
   [[secrets_store_secrets]]
   binding     = "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
   store_id    = "7ff0a5eb1c4a46829b23870def9a688a"
   secret_name = "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
   ```
   Secrets Store bindings are async — read via `await env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON.get()`, and set the `Env` type to `SecretsStoreSecret`.
2. `syncJobs.ts` + migration `20260417_experience_infra` (sync_jobs table). Gated by `SYNC_JOBS_ENABLED`.
3. Migration `20260422_perf_indexes` + static-asset scripts. Validate indexed columns exist on current schema first.
4. **LAST, own PR, validated:** Sheets-pipeline SUNSET — deletes `rentalSync` / `dailySalesSync` / `googleSheets`. Destructive; grep-confirm zero live callers (rental sync now flows via Supabase SOT).
5. (optional) `cashClosing.ts` extraction — main already runs the logic inline; low priority.

> NOTE: the internal API (`hmac`/`internalApi`/`internalAuth`) is ALREADY on main (commit `85cb05a`). Do NOT re-land it.

---

## 6. Open follow-ups outside this repo

- **`pub-account-prd`**: nothing blocking — cookie issuance already verified safe.
- Decide deployment-window timing with whoever owns the Account-side rollout
  (the shared secret must be live on both sides before signed traffic flows).

## 7. Key references

- Promotion/gate doc: `worker/docs/account-history-points-production-promotion-2026-05-22.md`
- Preflight: `pnpm --dir worker run check:account-shared-secret`
- Pre-deploy checks (all currently pass): `pnpm --dir worker typecheck`, `pnpm --dir worker test`, `check:schema-drift`, `check:static-assets`, `deploy:dry-run`
