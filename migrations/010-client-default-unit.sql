-- Per-client default billing unit. Service lines on new invoices/estimates
-- start in this unit (hours/days/months); one-off items are still set per line.
-- Defaults to DAY; Metalab-style hourly clients are set to HUR per client.
ALTER TABLE clients ADD COLUMN default_unit TEXT NOT NULL DEFAULT 'DAY';
