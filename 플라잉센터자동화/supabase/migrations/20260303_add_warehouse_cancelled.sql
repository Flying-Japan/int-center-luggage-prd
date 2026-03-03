-- Add in_warehouse flag for warehouse storage tracking
ALTER TABLE luggage_orders ADD COLUMN IF NOT EXISTS in_warehouse BOOLEAN DEFAULT false;

-- Add index for warehouse filtering
CREATE INDEX IF NOT EXISTS idx_luggage_orders_in_warehouse ON luggage_orders(in_warehouse) WHERE in_warehouse = true;
