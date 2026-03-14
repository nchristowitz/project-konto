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
  const { rows: bankAccounts } = await pool.query(
    'SELECT * FROM bank_accounts ORDER BY is_default DESC, label'
  );

  res.render('settings', {
    profile: profileResult.rows[0] || null,
    settings: settingsResult.rows[0],
    bankAccounts,
  });
});

// POST /settings/profile
router.post('/profile', async (req, res) => {
  const {
    name, address_line1, address_line2, city, postal_code,
    country_code, vat_number, tax_number, email, phone,
    website,
  } = req.body;

  await pool.query(`
    INSERT INTO business_profile (
      id, name, address_line1, address_line2, city, postal_code,
      country_code, vat_number, tax_number, email, phone,
      website
    ) VALUES (
      1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    )
    ON CONFLICT (id) DO UPDATE SET
      name = $1, address_line1 = $2, address_line2 = $3,
      city = $4, postal_code = $5, country_code = $6,
      vat_number = $7, tax_number = $8, email = $9,
      phone = $10, website = $11
  `, [
    name, address_line1, address_line2, city, postal_code,
    country_code, vat_number, tax_number, email, phone,
    website,
  ]);

  res.redirect('/settings');
});

// POST /settings/bank-accounts — create new
router.post('/bank-accounts', async (req, res) => {
  const {
    label, bank_name, account_holder,
    iban, bic, account_number, routing_number, swift_code,
    is_default,
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // If setting as default, clear existing default first
    if (is_default === 'on') {
      await dbClient.query('UPDATE bank_accounts SET is_default = FALSE WHERE is_default = TRUE');
    }

    await dbClient.query(`
      INSERT INTO bank_accounts (
        label, bank_name, account_holder,
        iban, bic, account_number, routing_number, swift_code,
        is_default
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      label, bank_name || null, account_holder || null,
      iban || null, bic || null,
      account_number || null, routing_number || null, swift_code || null,
      is_default === 'on',
    ]);

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  res.redirect('/settings');
});

// POST /settings/bank-accounts/:id — update existing
router.post('/bank-accounts/:id', async (req, res) => {
  const {
    label, bank_name, account_holder,
    iban, bic, account_number, routing_number, swift_code,
    is_default,
  } = req.body;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    if (is_default === 'on') {
      await dbClient.query('UPDATE bank_accounts SET is_default = FALSE WHERE is_default = TRUE');
    }

    await dbClient.query(`
      UPDATE bank_accounts SET
        label = $1, bank_name = $2, account_holder = $3,
        iban = $4, bic = $5,
        account_number = $6, routing_number = $7, swift_code = $8,
        is_default = $9, updated_at = NOW()
      WHERE id = $10
    `, [
      label, bank_name || null, account_holder || null,
      iban || null, bic || null,
      account_number || null, routing_number || null, swift_code || null,
      is_default === 'on',
      req.params.id,
    ]);

    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  res.redirect('/settings');
});

// POST /settings/bank-accounts/:id/delete
router.post('/bank-accounts/:id/delete', async (req, res) => {
  await pool.query('DELETE FROM bank_accounts WHERE id = $1', [req.params.id]);
  res.redirect('/settings');
});

// POST /settings/bank-accounts/:id/default — set as default
router.post('/bank-accounts/:id/default', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query('UPDATE bank_accounts SET is_default = FALSE WHERE is_default = TRUE');
    await dbClient.query('UPDATE bank_accounts SET is_default = TRUE WHERE id = $1', [req.params.id]);
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
  res.redirect('/settings');
});

// GET /api/bank-accounts — JSON for client-side JS
router.get('/api/bank-accounts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, label, bank_name, account_holder, iban, bic,
            account_number, routing_number, swift_code, is_default
     FROM bank_accounts ORDER BY is_default DESC, label`
  );
  res.json(rows);
});

// POST /settings/targets — save revenue targets
router.post('/targets', async (req, res) => {
  const { rows } = await pool.query('SELECT revenue_targets FROM settings WHERE id = 1');
  const targets = rows[0]?.revenue_targets || {};

  // Update targets from form fields (target_2026, target_2027, etc.)
  for (const [key, value] of Object.entries(req.body)) {
    if (key.startsWith('target_')) {
      const year = key.replace('target_', '');
      if (value && parseFloat(value) > 0) {
        targets[year] = parseFloat(value);
      } else {
        delete targets[year];
      }
    }
  }

  await pool.query(
    'UPDATE settings SET revenue_targets = $1 WHERE id = 1',
    [JSON.stringify(targets)]
  );
  res.redirect('/settings');
});

// POST /settings/reset — data reset
router.post('/reset', async (req, res) => {
  const action = req.body.action;
  const fs = require('fs');
  const path = require('path');

  function clearDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) {
        clearDir(p);
        fs.rmdirSync(p);
      } else {
        fs.unlinkSync(p);
      }
    }
  }

  if (action === 'all') {
    await pool.query(`
      DELETE FROM email_log;
      DELETE FROM invoice_views;
      DELETE FROM estimate_views;
      DELETE FROM payments;
      DELETE FROM invoice_lines;
      DELETE FROM estimate_lines;
      DELETE FROM estimates;
      DELETE FROM invoices;
      DELETE FROM clients;
      DELETE FROM invoice_sequences;
    `);
    clearDir(path.join(process.cwd(), 'data', 'invoices'));
    clearDir(path.join(process.cwd(), 'data', 'estimates'));
  } else if (action === 'invoices') {
    // Clear estimate FK references first
    await pool.query(`UPDATE estimates SET converted_invoice_id = NULL WHERE converted_invoice_id IS NOT NULL`);
    await pool.query(`
      DELETE FROM email_log;
      DELETE FROM invoice_views;
      DELETE FROM payments;
      DELETE FROM invoice_lines;
      DELETE FROM invoices;
      DELETE FROM invoice_sequences WHERE prefix = 'INV';
    `);
    clearDir(path.join(process.cwd(), 'data', 'invoices'));
  } else if (action === 'estimates') {
    await pool.query(`
      UPDATE invoices SET estimate_id = NULL WHERE estimate_id IS NOT NULL;
      DELETE FROM email_log WHERE estimate_id IS NOT NULL;
      DELETE FROM estimate_views;
      DELETE FROM estimate_lines;
      DELETE FROM estimates;
      DELETE FROM invoice_sequences WHERE prefix = 'EST';
    `);
    clearDir(path.join(process.cwd(), 'data', 'estimates'));
  } else if (action === 'clients') {
    // Clients FK'd by invoices and estimates — must clear those first
    await pool.query(`
      DELETE FROM email_log;
      DELETE FROM invoice_views;
      DELETE FROM estimate_views;
      DELETE FROM payments;
      DELETE FROM invoice_lines;
      DELETE FROM estimate_lines;
      DELETE FROM estimates;
      DELETE FROM invoices;
      DELETE FROM clients;
      DELETE FROM invoice_sequences;
    `);
    clearDir(path.join(process.cwd(), 'data', 'invoices'));
    clearDir(path.join(process.cwd(), 'data', 'estimates'));
  }

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
