const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// GET /clients
router.get('/', async (req, res) => {
  const showArchived = req.query.archived === '1';

  const { rows: clients } = await pool.query(`
    SELECT c.*,
      COALESCE(r.revenue, 0) AS revenue,
      COALESCE(o.outstanding, 0) AS outstanding
    FROM clients c
    LEFT JOIN (
      SELECT client_id,
        SUM(amount_paid) AS revenue
      FROM invoices
      WHERE status != 'cancelled'
      GROUP BY client_id
    ) r ON r.client_id = c.id
    LEFT JOIN (
      SELECT client_id,
        SUM(total - amount_paid) AS outstanding
      FROM invoices
      WHERE status NOT IN ('paid', 'cancelled', 'draft')
      GROUP BY client_id
    ) o ON o.client_id = c.id
    WHERE c.archived = $1
    ORDER BY c.name ASC
  `, [showArchived]);

  res.render('clients/index', { clients, showArchived });
});

// POST /clients/batch-archive
router.post('/batch-archive', async (req, res) => {
  let ids = req.body.client_ids;
  if (!ids) return res.redirect('/clients');
  if (!Array.isArray(ids)) ids = [ids];
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/clients');

  await pool.query(
    'UPDATE clients SET archived = TRUE, updated_at = NOW() WHERE id = ANY($1)',
    [numericIds]
  );
  res.redirect('/clients');
});

// POST /clients/batch-unarchive
router.post('/batch-unarchive', async (req, res) => {
  let ids = req.body.client_ids;
  if (!ids) return res.redirect('/clients?archived=1');
  if (!Array.isArray(ids)) ids = [ids];
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/clients?archived=1');

  await pool.query(
    'UPDATE clients SET archived = FALSE, updated_at = NOW() WHERE id = ANY($1)',
    [numericIds]
  );
  res.redirect('/clients?archived=1');
});

// POST /clients/batch-delete
router.post('/batch-delete', async (req, res) => {
  let ids = req.body.client_ids;
  const returnArchived = req.body.return_archived === '1';
  if (!ids) return res.redirect('/clients');
  if (!Array.isArray(ids)) ids = [ids];
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/clients');

  // Only delete clients that have no invoices
  const { rows: withInvoices } = await pool.query(
    'SELECT DISTINCT client_id FROM invoices WHERE client_id = ANY($1)',
    [numericIds]
  );
  const hasInvoices = new Set(withInvoices.map(r => r.client_id));
  const deletable = numericIds.filter(id => !hasInvoices.has(id));

  if (deletable.length) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [deletable]);
  }

  const redirect = returnArchived ? '/clients?archived=1' : '/clients';
  if (deletable.length < numericIds.length) {
    const skipped = numericIds.length - deletable.length;
    return res.redirect(`${redirect}&error=clients_have_invoices&count=${skipped}`);
  }
  res.redirect(redirect);
});

// GET /clients/new
router.get('/new', (req, res) => {
  res.render('clients/form', { clientData: null });
});

// POST /clients
router.post('/', async (req, res) => {
  const {
    name, contact_person, email, address_line1, address_line2,
    city, postal_code, country_code, vat_number, currency,
    default_vat_rate, payment_terms_days, notes,
  } = req.body;

  await pool.query(`
    INSERT INTO clients (
      name, contact_person, email, address_line1, address_line2,
      city, postal_code, country_code, vat_number, currency,
      default_vat_rate, payment_terms_days, notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [
    name, contact_person || null, email || null,
    address_line1 || null, address_line2 || null,
    city || null, postal_code || null, country_code || 'DE',
    vat_number || null, currency || 'EUR',
    parseFloat(default_vat_rate) || 19,
    parseInt(payment_terms_days, 10) || 30,
    notes || null,
  ]);

  res.redirect('/clients');
});

// GET /clients/:id — show page
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Client not found');
  const client = rows[0];

  const { rows: invoices } = await pool.query(`
    SELECT id, number, issue_date, due_date, total, currency, status
    FROM invoices
    WHERE client_id = $1
    ORDER BY issue_date DESC
  `, [client.id]);

  const { rows: estimates } = await pool.query(`
    SELECT id, number, issue_date, valid_until, total, currency, status
    FROM estimates
    WHERE client_id = $1
    ORDER BY issue_date DESC
  `, [client.id]);

  const { rows: statsRows } = await pool.query(`
    SELECT
      COALESCE(SUM(amount_paid), 0) AS revenue,
      COALESCE(SUM(CASE WHEN status NOT IN ('paid','cancelled','draft') THEN total - amount_paid ELSE 0 END), 0) AS outstanding
    FROM invoices
    WHERE client_id = $1 AND status != 'cancelled'
  `, [client.id]);

  const stats = {
    revenue: statsRows[0].revenue,
    outstanding: statsRows[0].outstanding,
    invoiceCount: invoices.length,
    estimateCount: estimates.length,
  };

  res.render('clients/show', { clientData: client, invoices, estimates, stats });
});

// GET /clients/:id/edit
router.get('/:id/edit', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Client not found');
  res.render('clients/form', { clientData: rows[0] });
});

// POST /clients/:id
router.post('/:id', async (req, res) => {
  const {
    name, contact_person, email, address_line1, address_line2,
    city, postal_code, country_code, vat_number, currency,
    default_vat_rate, payment_terms_days, notes,
  } = req.body;

  await pool.query(`
    UPDATE clients SET
      name = $1, contact_person = $2, email = $3,
      address_line1 = $4, address_line2 = $5,
      city = $6, postal_code = $7, country_code = $8,
      vat_number = $9, currency = $10,
      default_vat_rate = $11, payment_terms_days = $12,
      notes = $13, updated_at = NOW()
    WHERE id = $14
  `, [
    name, contact_person || null, email || null,
    address_line1 || null, address_line2 || null,
    city || null, postal_code || null, country_code || 'DE',
    vat_number || null, currency || 'EUR',
    parseFloat(default_vat_rate) || 19,
    parseInt(payment_terms_days, 10) || 30,
    notes || null,
    req.params.id,
  ]);

  res.redirect(`/clients/${req.params.id}`);
});

// POST /clients/:id/archive
router.post('/:id/archive', async (req, res) => {
  await pool.query(
    'UPDATE clients SET archived = TRUE, updated_at = NOW() WHERE id = $1',
    [req.params.id]
  );
  res.redirect(`/clients/${req.params.id}`);
});

// POST /clients/:id/unarchive
router.post('/:id/unarchive', async (req, res) => {
  await pool.query(
    'UPDATE clients SET archived = FALSE, updated_at = NOW() WHERE id = $1',
    [req.params.id]
  );
  res.redirect(`/clients/${req.params.id}`);
});

module.exports = router;
