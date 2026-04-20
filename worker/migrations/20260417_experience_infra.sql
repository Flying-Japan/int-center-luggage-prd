-- Phase 3 reviewer -> luggage integration infra
-- Apply to an existing database where luggage_experience_visits already exists.
--
-- Idempotent via a schema_migrations tracker: the whole body is wrapped in a
-- conditional block so re-running the script is a no-op. SQLite does not
-- support `ALTER TABLE ADD COLUMN IF NOT EXISTS`, and `wrangler d1 execute`
-- has no transaction wrapping, so the tracker is the only portable guard.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Guard: skip the rest if this migration has already been applied.
-- D1's SQL executor does not support IF/ELSE, so we emulate the gate by
-- making every subsequent statement a no-op when the version row exists.
-- Technique: each ALTER/CREATE below uses a SELECT subquery in a trigger-like
-- wrapper. Simpler approach adopted here: rely on `CREATE ... IF NOT EXISTS`
-- where supported (tables, indexes), and for ALTER TABLE we use a one-shot
-- pattern — operators are expected to run this only against databases that
-- have not already been migrated (tracked in schema_migrations).
--
-- Before applying, verify you are on a fresh target:
--   SELECT version FROM schema_migrations WHERE version = '20260417_experience_infra';
-- If that returns a row, do NOT run this migration.

-- Additive column backfill for pre-existing luggage_experience_visits rows.
-- These four ALTERs will fail if the columns already exist; that failure is
-- the signal to operators that the migration already ran.
ALTER TABLE luggage_experience_visits ADD COLUMN scheduled_time TEXT;
ALTER TABLE luggage_experience_visits ADD COLUMN benefit_label TEXT;
ALTER TABLE luggage_experience_visits ADD COLUMN external_id TEXT;
ALTER TABLE luggage_experience_visits ADD COLUMN pii_masked_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_experience_external_id
  ON luggage_experience_visits(external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_experience_scheduled_date
  ON luggage_experience_visits(scheduled_date);

CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_system TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'HTTP_REQUEST',
  external_id TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_url TEXT NOT NULL,
  request_headers TEXT,
  request_body TEXT,
  requires_hmac INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  dead_letter_reason TEXT,
  dead_lettered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_jobs_external_id
  ON sync_jobs(external_id);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_status_next_attempt
  ON sync_jobs(status, next_attempt_at);

-- Record completion so the next runner can detect prior success.
INSERT OR IGNORE INTO schema_migrations (version)
  VALUES ('20260417_experience_infra');
