const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// GET /settings
router.get('/', async (req, res) => {
  const profileResult = await pool.query(
    'SELECT * FROM business_profile WHERE id = 1'
  );
  const settingsResult = await pool.query(
    'SELECT * FROM settings WHERE id = 1'
  );

  res.render('settings', {
    profile: profileResult.rows[0] || null,
    settings: settingsResult.rows[0],
  });
});

// POST /settings/profile
router.post('/profile', async (req, res) => {
  const {
    name, address_line1, address_line2, city, postal_code,
    country_code, vat_number, tax_number, email, phone,
    website, bank_name, iban, bic,
  } = req.body;

  await pool.query(`
    INSERT INTO business_profile (
      id, name, address_line1, address_line2, city, postal_code,
      country_code, vat_number, tax_number, email, phone,
      website, bank_name, iban, bic
    ) VALUES (
      1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    ON CONFLICT (id) DO UPDATE SET
      name = $1, address_line1 = $2, address_line2 = $3,
      city = $4, postal_code = $5, country_code = $6,
      vat_number = $7, tax_number = $8, email = $9,
      phone = $10, website = $11, bank_name = $12,
      iban = $13, bic = $14
  `, [
    name, address_line1, address_line2, city, postal_code,
    country_code, vat_number, tax_number, email, phone,
    website, bank_name, iban, bic,
  ]);

  res.redirect('/settings');
});

// POST /settings
router.post('/', async (req, res) => {
  const {
    reminder_enabled, reminder_interval_days, max_reminders,
    default_payment_terms, default_currency, default_vat_rate,
    default_payment_details, default_notes,
  } = req.body;

  await pool.query(`
    UPDATE settings SET
      reminder_enabled = $1,
      reminder_interval_days = $2,
      max_reminders = $3,
      default_payment_terms = $4,
      default_currency = $5,
      default_vat_rate = $6,
      default_payment_details = $7,
      default_notes = $8
    WHERE id = 1
  `, [
    reminder_enabled === 'on',
    parseInt(reminder_interval_days, 10),
    parseInt(max_reminders, 10),
    parseInt(default_payment_terms, 10),
    default_currency,
    parseFloat(default_vat_rate),
    default_payment_details || null,
    default_notes || null,
  ]);

  res.redirect('/settings');
});

module.exports = router;
