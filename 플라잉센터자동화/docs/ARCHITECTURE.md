# Flying Japan Luggage Storage - Architecture Memo

> Last updated: 2026-02-25

---

## Overview

Luggage storage automation system for Flying Japan International Center (Osaka).
Two user groups: **customers** (tourists, self-service check-in) and **staff** (operations dashboard).

- URL: https://luggage.flyingjp.com
- Staff login: https://luggage.flyingjp.com/admin

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | Python 3.12 |
| Framework | FastAPI 0.115.7 + Jinja2 templates |
| Server | Uvicorn |
| Database | Supabase (PostgreSQL) |
| Image Storage | Cloudflare R2 (REST API via httpx) |
| Auth | Supabase Auth (email/password + Google OAuth PKCE) |
| Frontend | Server-rendered HTML + vanilla JS + CSS |
| Tunnel | Cloudflare Tunnel (cloudflared) |
| Host | macOS native via launchd |

---

## Project Structure

```
플라잉센터자동화/
├── app/
│   ├── main.py              # All FastAPI routes (~3500 lines)
│   ├── config.py             # Environment config, constants
│   ├── auth.py               # Staff auth (email/pw + Google OAuth)
│   ├── database.py           # DB dependency injection
│   ├── supabase_client.py    # Supabase client wrapper
│   ├── r2.py                 # Cloudflare R2 storage (upload/download/delete)
│   ├── i18n.py               # Translations (KO/EN/JA)
│   ├── schemas.py            # Pydantic models
│   └── services/
│       ├── pricing.py        # Price calculation, discounts
│       ├── retention.py      # Data lifecycle cleanup
│       ├── storage.py        # Storage day calculation, pickup validation
│       └── order_number.py   # Sequential order ID + tag number generation
├── templates/                # Jinja2 HTML templates
│   ├── base.html             # Layout (header, lang switcher)
│   ├── customer_form.html    # Customer intake form
│   ├── customer_success.html # Post-submission confirmation
│   ├── staff_login.html
│   ├── staff_dashboard.html  # Main order board
│   ├── staff_order_detail.html
│   ├── staff_cash_closing.html
│   ├── staff_handover.html   # Shift notes
│   ├── staff_lost_found.html
│   ├── staff_admin_sales.html
│   ├── staff_admin_accounts.html
│   └── ...
├── static/
│   ├── app.css               # All styles
│   ├── customer.js           # Image compression, price preview
│   └── staff_dashboard.js    # Dashboard polling, inline editing
├── scripts/
│   ├── run-native.sh         # Startup script (sources .env.local)
│   ├── deploy.sh             # git pull + pip install + launchd reload
│   └── create_staff.py       # CLI staff account creation
├── supabase/
│   └── migrations/           # SQL schema
├── tests/
├── docker-compose.yml        # Docker deploy (app + tunnel + watchtower)
├── requirements.txt
├── .env.local                # Production secrets (not in git)
└── .env.example              # Template
```

---

## Routes

### Customer

| Method | Path | Description |
|---|---|---|
| GET | `/customer` | Intake form (?lang=ko/en/ja) |
| POST | `/customer/submit` | Submit order (multipart: name, phone, bags, photos) |
| GET | `/customer/orders/{id}` | Success page |
| GET | `/api/price-preview` | Real-time pricing calculation |

### Staff

| Method | Path | Description |
|---|---|---|
| GET | `/staff/dashboard` | Order board (filter, search, inline edit) |
| GET | `/staff/orders/{id}` | Order detail |
| POST | `/staff/orders/{id}/mark-paid` | Mark as paid |
| POST | `/staff/orders/{id}/mark-picked-up` | Complete pickup |
| POST | `/staff/orders/manual` | Staff-created order (no photo) |
| GET | `/staff/orders/{id}/id-image` | View ID photo (audit logged) |
| GET | `/staff/orders/{id}/luggage-image` | View luggage photo (audit logged) |
| GET | `/staff/lost-found` | Lost & found management |
| GET | `/staff/handover` | Shift handover notes |
| GET | `/staff/cash-closing` | Cash register closing |
| GET | `/staff/schedule` | Work schedule (Google Calendar embed) |

### Admin (staff with admin role)

| Method | Path | Description |
|---|---|---|
| GET | `/staff/admin/sales` | Sales analytics (daily + monthly) |
| GET | `/staff/admin/staff-accounts` | Account management |
| GET | `/staff/admin/completion-message` | Edit post-submission message |
| POST | `/staff/admin/retention/run` | Manual retention cleanup trigger |

---

## Database

All tables prefixed `luggage_` in shared Supabase project. RLS disabled; access controlled via service role key.

### Core Tables

- **`luggage_orders`** - Main business table. Fields: order_id, name, phone, bag counts, pricing, status (PAYMENT_PENDING → PAID → PICKED_UP), image URLs, flying pass tier, timestamps.
- **`luggage_audit_logs`** - Tracks staff image views (VIEW_ID / VIEW_LUGGAGE).
- **`luggage_daily_counters`** / **`luggage_daily_tag_counters`** - Sequential ID generation per business date.

### Operations Tables

- **`luggage_lost_found_entries`** - Status: STORED / RETURNED / DISPOSED.
- **`luggage_handover_notes`** - Shift notes with category (NOTICE/HANDOVER), pinning, read tracking.
- **`luggage_handover_reads`** / **`luggage_handover_comments`** - Read status and comments per note.
- **`luggage_cash_closings`** - Full denomination breakdown, QR reconciliation, workflow (DRAFT → SUBMITTED → LOCKED).
- **`luggage_cash_closing_audits`** - Audit trail for closing changes.

### Other

- **`luggage_rental_daily_sales`** - Daily rental revenue entries.
- **`luggage_app_settings`** - Key-value config (completion messages, calendar URL).
- **`luggage_work_schedules`** - Staff schedule data.
- **`user_profiles`** - Shared auth table (id, username, role, is_active).

---

## Image Storage (Cloudflare R2)

```
Customer upload → save_image_file() → r2_upload() → PUT Cloudflare API → R2 bucket
Staff view     → _serve_storage_image() → r2_download() → GET Cloudflare API → Response
Retention      → _safe_r2_delete() → r2_delete() → DELETE Cloudflare API
```

- Bucket: `luggage-images`
- Path format: `{id|luggage}/{order_id}-{uuid}.{ext}`
- Auth: Cloudflare API Bearer token
- Lifecycle rule: Auto-delete after 14 days (R2-level)

### Config

```
R2_ACCOUNT_ID=6efe0c5d58f6e8bb28165c599fa36c33
R2_API_TOKEN=<cloudflare-api-token>
R2_BUCKET_NAME=luggage-images
```

---

## Pricing

### Base Rates (per day)

| Type | Price |
|---|---|
| Suitcase (wheeled) | ¥800 |
| Backpack/bag | ¥500 |
| Set (1 suitcase + 1 backpack) | ¥1,200 |

Sets are paired automatically: `set_qty = min(suitcase_qty, backpack_qty)`.

### Long-Stay Discount

| Days | Discount |
|---|---|
| 1-6 | 0% |
| 7-13 | 5% |
| 14-29 | 10% |
| 30-59 | 15% |
| 60+ | 20% |

### Flying Pass Tiers

| Tier | Discount |
|---|---|
| BLUE | ¥100 off |
| SILVER | ¥200 off |
| GOLD | ¥300 off |
| PLATINUM | ¥400 off |
| BLACK | 100% free |

### Extra Charges

If actual pickup exceeds expected days: `extra_days × price_per_day`.

---

## Data Retention

Two layers of protection:

### 1. R2 Lifecycle Rule (Cloudflare-level)
Auto-deletes all objects in `luggage-images` bucket after **14 days**. Runs automatically by Cloudflare regardless of app state.

### 2. App-Level Cleanup (daily at 03:00 JST)
Background scheduler thread runs `run_retention_cleanup()`:

- **14-day pass**: Delete ID/luggage images from R2, clear URL fields in DB.
- **60-day pass**: Delete entire order record + associated audit logs.

Also triggerable manually: `POST /staff/admin/retention/run`.

---

## Authentication

### Staff Login
- **Email/password**: Supabase Auth `sign_in_with_password()`
- **Google OAuth**: PKCE flow via Supabase → callback exchanges code → session set

### Session
- Starlette SessionMiddleware, 12-hour max age
- `SameSite=lax`, HTTPS-only in production
- Session stores `user_id` (UUID), looked up in `user_profiles` on each request

### Roles
- **admin**: Full access (sales, accounts, retention, schedule config)
- **editor**: Standard staff access (orders, handover, cash closing, lost & found)

---

## i18n

Three languages: Korean (ko, default), English (en), Japanese (ja).

- Customer pages: language via `?lang=` query param
- ~35 UI string keys per language in `app/i18n.py`
- Completion messages: admin writes in Korean, auto-translated to EN/JA via Google Translate API with fallback to canonical lookup table

---

## Infrastructure

### Production (current: native macOS)

```
launchd (com.flyingjapan.luggage)
  └── scripts/run-native.sh
       └── source .env.local
       └── .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

launchd (com.flyingjapan.cloudflared)
  └── cloudflared tunnel → luggage.flyingjp.com → localhost:8000
```

- Logs: `~/Library/Logs/flyingjapan-luggage.log`
- Deploy: `scripts/deploy.sh` (git pull → pip install → launchd reload)
- Auto-restart: `KeepAlive: true` in plist

### Docker Alternative

```yaml
docker-compose.yml:
  app:        ghcr.io/flying-japan/int-center-luggage-prd:latest
  tunnel:     cloudflare/cloudflared:2026.2.0
  watchtower: containrrr/watchtower (auto-update every 300s)
```

---

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `APP_ENV` | `production` or `development` | Yes |
| `APP_SECRET_KEY` | Session encryption key | Yes |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes |
| `APP_BASE_URL` | Public URL (for QR codes) | Yes |
| `R2_ACCOUNT_ID` | Cloudflare account ID | Yes |
| `R2_API_TOKEN` | Cloudflare API token | Yes |
| `R2_BUCKET_NAME` | R2 bucket name (default: `luggage-images`) | No |
| `SESSION_HTTPS_ONLY` | HTTPS-only cookies | No (auto in prod) |
| `AUTO_SEED_DEFAULT_STAFF` | Seed test staff on startup | No (auto in dev) |

---

## Business Hours

- Operating: 09:00 ~ 21:00 JST
- Pickup must be within business hours
- Orders created outside hours get next-day 09:00 as start time
- Cash closing types: MORNING_HANDOVER and FINAL_CLOSE
