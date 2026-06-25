-- Supports test-mode deletion. email_log rows reference invoices/estimates with
-- NO ACTION, which blocks deleting a sandbox (test) document that has been
-- emailed. Switch those FKs to ON DELETE CASCADE so a test doc's send-log rows
-- clear automatically on delete.
--
-- Harmless for real documents: only DRAFT invoices/estimates are deletable for
-- real, and a draft has never been sent, so it has no email_log rows. The
-- existing rows (for real, sent documents) are unaffected because those
-- documents are never deleted.
ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_invoice_id_fkey;
ALTER TABLE email_log ADD CONSTRAINT email_log_invoice_id_fkey
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE;

ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_estimate_id_fkey;
ALTER TABLE email_log ADD CONSTRAINT email_log_estimate_id_fkey
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE;
