-- §14 UStG requires the supply (service) date or period on every invoice.
-- Both nullable: start+end = period, start only = single service date,
-- neither = "service date corresponds to invoice date" (rendered + embedded as such).
ALTER TABLE invoices ADD COLUMN service_period_start DATE;
ALTER TABLE invoices ADD COLUMN service_period_end DATE;
