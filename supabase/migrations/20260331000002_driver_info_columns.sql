-- Add driver info columns to customer_orders for delivery tracking
ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS driver_name text,
  ADD COLUMN IF NOT EXISTS driver_phone text;

COMMENT ON COLUMN public.customer_orders.driver_name IS 'Driver name from OTO webhook (driverName field)';
COMMENT ON COLUMN public.customer_orders.driver_phone IS 'Driver phone from OTO webhook (driverPhone field)';
