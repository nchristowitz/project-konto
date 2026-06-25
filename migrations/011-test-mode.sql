-- Test mode: a flagged "test client" whose invoices and estimates are sandbox
-- documents. They draw from a separate TEST-numbering counter (never the gapless
-- INV/EST tax sequence), are excluded from revenue, the dashboard, the
-- Steuerberater CSV exports, and the reminder cron, and can be deleted at any
-- status. Lets the operator exercise the full send/view/accept loop in
-- production without touching real data or the numbering system.
--
-- Additive and idempotent: a NOT NULL column with a constant default is a
-- metadata-only change in Postgres 11+, so no table rewrite / long lock.
ALTER TABLE clients   ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invoices  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
