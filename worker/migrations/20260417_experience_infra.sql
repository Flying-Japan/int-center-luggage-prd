-- Phase 3 reviewer -> luggage integration infra
-- Apply to an existing database where luggage_experience_visits already exists.

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
