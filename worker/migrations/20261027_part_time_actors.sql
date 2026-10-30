-- Additive only: apply before the matching Worker. Creates the display-name table for ERP Part-time Auth workers.
-- actor_id is "pt:" + lowercase ERP Auth UID (also stored in staff_id columns); it never collides with user_profiles UUIDs or "SYSTEM".
-- Does not touch, update or delete any existing table or row.
CREATE TABLE IF NOT EXISTS luggage_part_time_actors (
  actor_id TEXT PRIMARY KEY CHECK (actor_id LIKE 'pt:%' AND length(actor_id) = 39),
  display_name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
