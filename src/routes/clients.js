const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// GET /clients
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE archived = FALSE ORDER BY name ASC'
  );
  res.render('clients/index', { clients: rows });
});

// GET /clients/new
router.get('/new', (req, res) => {
  res.render('clients/form', { client: null });
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

// GET /clients/:id
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Client not found');
  res.render('clients/form', { client: rows[0] });
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

  res.redirect('/clients');
});

// POST /clients/:id/archive
router.post('/:id/archive', async (req, res) => {
  await pool.query(
    'UPDATE clients SET archived = TRUE, updated_at = NOW() WHERE id = $1',
    [req.params.id]
  );
  res.redirect('/clients');
});

module.exports = router;
