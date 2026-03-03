-- Add parent_order_id to link extension orders to their root order
ALTER TABLE luggage_orders ADD COLUMN IF NOT EXISTS parent_order_id TEXT;

CREATE INDEX IF NOT EXISTS idx_luggage_orders_parent_order_id
  ON luggage_orders(parent_order_id) WHERE parent_order_id IS NOT NULL;
