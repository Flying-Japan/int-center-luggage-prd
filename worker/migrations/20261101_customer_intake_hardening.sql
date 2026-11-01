-- Local preparation only. Receipt lifetime is independent of order edits.
ALTER TABLE luggage_intake_requests ADD COLUMN receipt_issued_at INTEGER;
CREATE TRIGGER luggage_intake_receipt_immutable BEFORE UPDATE ON luggage_intake_requests
WHEN OLD.state='COMMITTED' AND (NEW.receipt_issued_at IS NOT OLD.receipt_issued_at
  OR NEW.order_id IS NOT OLD.order_id OR NEW.state!='COMMITTED')
BEGIN SELECT RAISE(ABORT,'committed intake receipt is immutable'); END;
-- Reserved BEFORE R2 PUT, so interrupted/failed attempts retain cleanup evidence.
CREATE TABLE luggage_intake_uploads (
  object_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL REFERENCES luggage_intake_requests(request_hash),
  claim_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('id','luggage')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX luggage_intake_uploads_attempt ON luggage_intake_uploads(request_hash,claim_id);
