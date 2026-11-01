-- Customer renewal foundation; NOT applied to any remote database.
-- No contact details, photo bytes, payment data or bearer view tokens here.
CREATE TABLE IF NOT EXISTS luggage_intake_requests (
  request_hash TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PROCESSING', 'COMMITTED', 'FAILED')),
  order_id TEXT UNIQUE REFERENCES luggage_orders(order_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((state = 'COMMITTED' AND order_id IS NOT NULL)
    OR (state != 'COMMITTED' AND order_id IS NULL))
);
