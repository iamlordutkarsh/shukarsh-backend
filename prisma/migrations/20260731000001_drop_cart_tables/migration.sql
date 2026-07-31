-- The cart has always lived in the browser's localStorage and is sent with the
-- order, so no code ever wrote to these two tables: they were scaffolding from
-- the first schema. Dropped child first, and without CASCADE, so that an
-- unexpected dependency fails this migration loudly instead of quietly taking
-- a real constraint with it.
DROP TABLE IF EXISTS "CartItem";
DROP TABLE IF EXISTS "Cart";
