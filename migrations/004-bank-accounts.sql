-- ============================================================
-- Bank accounts (multi-account support)
-- Supports both EU (IBAN/BIC) and international (account number/routing/SWIFT)
-- Idempotent: safe to run against a DB where the original version was partially applied
-- ============================================================

-- Create table if it doesn't exist yet
CREATE TABLE IF NOT EXISTS bank_accounts (
    id              SERIAL PRIMARY KEY,
    label           TEXT NOT NULL,
    bank_name       TEXT,
    account_holder  TEXT,
    iban            TEXT,
    bic             TEXT,
    account_number  TEXT,
    routing_number  TEXT,
    swift_code      TEXT,
    is_default      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Add international columns if they don't exist (for DBs with original migration)
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS routing_number TEXT;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS swift_code TEXT;

-- Make iban nullable (it was NOT NULL in original migration)
ALTER TABLE bank_accounts ALTER COLUMN iban DROP NOT NULL;

-- Add check constraint: must have either IBAN or account_number
-- Drop first in case it already exists
ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_has_account;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_has_account CHECK (
    iban IS NOT NULL OR account_number IS NOT NULL
);

-- Only one bank account can be the default
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_accounts_single_default
    ON bank_accounts (is_default) WHERE is_default = TRUE;

-- Migrate existing bank data from business_profile (skip if already migrated)
INSERT INTO bank_accounts (label, bank_name, iban, bic, is_default)
SELECT 'Primary', bank_name, iban, bic, TRUE
FROM business_profile
WHERE iban IS NOT NULL AND iban != ''
  AND NOT EXISTS (SELECT 1 FROM bank_accounts);

-- Add columns to other tables if they don't exist
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS default_bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL;

ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE invoices
    ADD COLUMN IF NOT EXISTS bank_account_snapshot JSONB;

ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL;
ALTER TABLE estimates
    ADD COLUMN IF NOT EXISTS bank_account_snapshot JSONB;

-- Backfill existing invoices/estimates that don't have a bank account yet
UPDATE invoices
SET bank_account_id = ba.id,
    bank_account_snapshot = jsonb_build_object(
        'label', ba.label,
        'bank_name', ba.bank_name,
        'account_holder', ba.account_holder,
        'iban', ba.iban,
        'bic', ba.bic,
        'account_number', ba.account_number,
        'routing_number', ba.routing_number,
        'swift_code', ba.swift_code
    )
FROM bank_accounts ba
WHERE ba.is_default = TRUE
  AND invoices.bank_account_id IS NULL;

UPDATE estimates
SET bank_account_id = ba.id,
    bank_account_snapshot = jsonb_build_object(
        'label', ba.label,
        'bank_name', ba.bank_name,
        'account_holder', ba.account_holder,
        'iban', ba.iban,
        'bic', ba.bic,
        'account_number', ba.account_number,
        'routing_number', ba.routing_number,
        'swift_code', ba.swift_code
    )
FROM bank_accounts ba
WHERE ba.is_default = TRUE
  AND estimates.bank_account_id IS NULL;
