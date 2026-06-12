-- Credit notes (Stornorechnung/Rechnungskorrektur) are stored as invoices with
-- negated quantities and a reference to the invoice they correct. They share
-- the same gapless number sequence. credits_invoice_id is set on the credit
-- note row and points at the original.
ALTER TABLE invoices ADD COLUMN credits_invoice_id INTEGER REFERENCES invoices(id);
