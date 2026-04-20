# CLAUDE.md - Luggage Storage Worker

## Project: int-center-luggage-prd/worker

Cloudflare Worker (Hono + D1 + R2) for Flying Japan luggage storage system.
Migrated from FastAPI/Supabase. Auth stays in Supabase.

## Architecture

- **Backend**: Hono on Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite)
- **Auth**: Supabase Auth (email/password + Google OAuth PKCE)
- **Images**: Cloudflare R2 (Worker binding)
- **Frontend**: Hono JSX server-rendered pages
- **Deploy**: `wrangler deploy` via GitHub Actions

## Commands

```bash
pnpm dev                         # Local dev server (port 8787)
pnpm deploy                      # Deploy to Cloudflare
pnpm typecheck                   # TypeScript check
pnpm test                        # Vitest (uses @cloudflare/vitest-pool-workers)
pnpm db:migrate:local            # Apply base D1 schema locally
pnpm db:migrate:prod             # Apply base D1 schema to production
pnpm db:migrate:experience:local # Apply Phase 3 experience-infra migration locally
pnpm db:migrate:experience:prod  # Apply Phase 3 experience-infra migration in prod
```

## Project Structure

```
worker/
├── src/
│   ├── index.tsx           # Entry point, route wiring, scheduled handler
│   ├── types.ts            # Env bindings, AppType
│   ├── routes/
│   │   ├── auth.tsx        # Login, logout, Google OAuth
│   │   ├── customer.tsx    # Customer form, submit, success, price preview
│   │   ├── staffApi.ts     # Staff JSON API (orders CRUD, bulk actions)
│   │   ├── staffOrders.tsx # Staff order detail, mark-paid, pickup, images
│   │   ├── operations.tsx  # Cash closing, handover notes, lost & found
│   │   └── admin.tsx       # Sales, accounts, settings, logs, retention
│   ├── middleware/
│   │   ├── auth.ts         # Session cookie, staffAuth, adminAuth
│   │   └── security.ts     # Headers, error handler, rate limiter
│   ├── services/
│   │   ├── pricing.ts      # Rates, discounts, Flying Pass
│   │   ├── storage.ts      # JST date math, business hours
│   │   ├── orderNumber.ts  # Daily sequential IDs
│   │   └── retention.ts    # 14/60-day cleanup
│   └── lib/
│       ├── supabase.ts     # Supabase client (auth only)
│       ├── r2.ts           # R2 upload/download/delete
│       └── i18n.ts         # KO/EN/JA translations
├── wrangler.toml           # D1, R2 bindings, cron trigger
├── package.json
└── tsconfig.json
```

## Conventions

- All UI text in Korean (staff pages), multilingual for customer pages
- D1 queries use parameterized `.bind()` — never string interpolation
- R2 via Worker binding (not REST API)
- Session cookies for auth (not JWTs)
- Tables prefixed `luggage_`; staff profiles and roles live in Supabase `user_profiles`

## Environment Variables (Cloudflare Dashboard)

- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (secret)
- `APP_SECRET_KEY` — Session encryption key (secret)
- `APP_BASE_URL` — Public URL (e.g., https://luggage.flyingjp.com)
- `APP_ENV` — "production" or "development"
- `INTERNAL_API_SECRET` — HMAC-SHA256 secret for `/internal/*` (secret; required once Phase 3 is in use)
- `SYNC_JOBS_ENABLED` — `"true"` to enable the `*/5 * * * *` sync-jobs consumer cron. Defaults to disabled; leave unset until the reviewer-side enqueuer is live.

## Cron Trigger

Daily at 03:00 JST (18:00 UTC): retention cleanup
- 14 days: delete images from R2, clear URL fields
- Customer data (orders, audit logs) kept permanently for service/marketing

Every 5 minutes (`*/5 * * * *`): sync-jobs consumer
- Drains pending rows from `sync_jobs`, signs each with `INTERNAL_API_SECRET`, POSTs to upstream
- Gated by `SYNC_JOBS_ENABLED="true"` — silently skipped otherwise
- Each job is individually guarded, so a DB failure on one row does not abort the batch

## Internal API (Phase 3)

`src/routes/internalApi.ts` exposes a machine-to-machine surface at `/internal/*` for reviewer → luggage data flow. Every request is verified by `middleware/internalAuth.ts` using HMAC-SHA256 over a canonical string.

### HMAC authentication

Clients must attach two headers:
- `x-internal-timestamp`: Unix seconds as a string. Accepted if within ±5 minutes of server clock.
- `x-internal-signature`: hex HMAC-SHA256 of `METHOD\npath_with_search\ntimestamp\nsha256(body)` keyed by `INTERNAL_API_SECRET`.

Helpers live in `src/lib/hmac.ts`:
- `createTimestampHeader()` — timestamp header value
- `signInternalRequest({ body, method, secret, timestamp, url })` — returns `{ bodyHash, canonical, signature }`
- `verifyInternalRequestSignature(...)` — server-side verifier (used by `internalAuth`)

Missing secret → 503. Missing/bad signature → 401. No IP allowlist; the HMAC key is the sole gate, so rotate on any suspected leak.

### Secret generation and rotation

```bash
# Generate and install
openssl rand -hex 32 | wrangler secret put INTERNAL_API_SECRET

# Mirror the same value in the reviewer-side caller (int-center-automation).
# Rotation: generate a new value, update both sides in the same change window,
# and redeploy. There is no dual-key support today, so expect a brief window
# where in-flight requests signed with the old key will 401.
```

### D1 migration (20260417_experience_infra)

- Adds `scheduled_time`, `benefit_label`, `external_id`, `pii_masked_at` columns to `luggage_experience_visits`
- Adds `external_id` unique index (partial, on non-null) and `scheduled_date` index
- Creates `sync_jobs` table and its two indexes
- Tracked by `schema_migrations` so repeated applies can be detected

Apply order is **migration first, worker deploy second** — `operations.tsx` hardcodes the new columns and will 500 against an un-migrated database.

```bash
pnpm db:migrate:experience:prod   # D1 schema first
pnpm deploy                       # Then push the worker
```

### Sync jobs

`src/services/syncJobs.ts` owns the consumer:
- `enqueueSyncJob(env, input)` — inserts with `ON CONFLICT(external_id) DO UPDATE` so retries reset cleanly.
- `runSyncJobs(env)` — pulls up to 8 due rows, signs with HMAC if `requires_hmac`, POSTs upstream, marks `COMPLETED` / reschedules on transient failure / moves to `DEAD_LETTER` after `max_attempts` (default 3). Backoff: 1 min → 10 min → 60 min.
- Dead-lettered jobs file an Asana bug via `createBugTask`.

To pause: set `SYNC_JOBS_ENABLED` to anything other than `"true"` and redeploy (no migration change needed).

### Rollback

Additive-only migration — safe to revert the worker code without a down-migration. Orphan columns and the `sync_jobs` table remain but do not break prior queries.

```bash
# 1. Revert worker code
git revert <commit-range> && git push origin main
wrangler deploy  # or: wrangler rollback

# 2. Leave the D1 migration in place (additive, no down-migration needed)

# 3. Remove the secret only after confirming no caller depends on it
wrangler secret delete INTERNAL_API_SECRET

# 4. To hard-remove the tables (NOT recommended — data loss on sync_jobs)
# DROP TABLE sync_jobs;
# SQLite does not support dropping columns without a table rebuild;
# leave the four ALTERed columns in place.
```
