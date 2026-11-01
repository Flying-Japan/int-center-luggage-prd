-- Local renewal preparation. Remote application requires coordinated release.
-- Canonical Account identity only; never populate by matching contact details.
ALTER TABLE luggage_orders ADD COLUMN account_person_id TEXT;
CREATE INDEX idx_luggage_orders_account_person ON luggage_orders(account_person_id);
