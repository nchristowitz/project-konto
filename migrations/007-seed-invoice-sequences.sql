-- Seed invoice_sequences from the MAX existing invoice number per year.
--
-- Why: the numbering sequence is incremented by getNextInvoiceNumber() at
-- invoice-creation time. Invoices inserted directly by the Freshbooks
-- import script bypass that helper, so the sequence has no knowledge of
-- them — meaning the first invoice created through the UI would collide
-- with an imported one (e.g. new '260001' vs imported '260001').
--
-- This migration parses every existing invoice number of the form YYNNNN
-- (Konto + 2024-2026 Freshbooks) or YYNNNNN (2022-2023 Freshbooks), takes
-- the max per year, and sets the sequence to max+1 so the next assignment
-- continues from there. `GREATEST` means the migration is safe to re-run
-- conceptually (if the sequence is already ahead of the data, don't
-- rewind it).

WITH parsed AS (
  SELECT
    'INV'::TEXT AS prefix,
    2000 + CAST(SUBSTRING(number FROM 1 FOR 2) AS INTEGER) AS year,
    CAST(SUBSTRING(number FROM 3) AS INTEGER) AS counter
  FROM invoices
  WHERE number ~ '^[0-9]{5,7}$'
),
max_per_year AS (
  SELECT prefix, year, MAX(counter) + 1 AS next_number
  FROM parsed
  GROUP BY prefix, year
)
INSERT INTO invoice_sequences (prefix, year, next_number)
SELECT prefix, year, next_number FROM max_per_year
ON CONFLICT (prefix, year) DO UPDATE
SET next_number = GREATEST(invoice_sequences.next_number, EXCLUDED.next_number);
