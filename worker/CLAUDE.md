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
pnpm dev                # Local dev server (port 8787)
pnpm deploy             # Deploy to Cloudflare
pnpm typecheck          # TypeScript check
pnpm db:migrate:local   # Apply D1 schema locally
pnpm db:migrate:prod    # Apply D1 schema to production
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

## Cron Trigger

Daily at 03:00 JST (18:00 UTC): retention cleanup
- 14 days: delete images from R2, clear URL fields
- Customer data (orders, audit logs) kept permanently for service/marketing
