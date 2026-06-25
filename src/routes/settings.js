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
  const { rows: yearRows } = await pool.query(`
    SELECT DISTINCT EXTRACT(YEAR FROM issue_date)::int AS year
    FROM invoices WHERE status NOT IN ('draft', 'cancelled')
      AND NOT is_test
    ORDER BY year DESC
  `);

  res.render('settings', {
    profile: profileResult.rows[0] || null,
    settings: settingsResult.rows[0],
    bankAccounts,
    exportYears: yearRows.map((r) => r.year),
  });
});

// --- CSV exports for the tax advisor ---
// Semicolon-delimited with a UTF-8 BOM so German Excel opens them directly.

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sendCsv(res, filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + body);
}

const money = (v) => Number(v || 0).toFixed(2);

// GET /settings/export/invoices.csv?year=YYYY — issued invoices by issue date
router.get('/export/invoices.csv', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  if (!year) return res.status(400).send('year required');

  const { rows } = await pool.query(`
    SELECT i.number, i.issue_date, i.service_period_start, i.service_period_end,
           i.client_snapshot->>'name' AS client,
           i.client_snapshot->>'country_code' AS client_country,
           i.client_snapshot->>'vat_number' AS client_vat,
           i.currency, i.subtotal, i.vat_rate, i.vat_amount, i.total,
           i.reverse_charge, i.status, i.amount_paid,
           o.number AS credits_number
    FROM invoices i
    LEFT JOIN invoices o ON o.id = i.credits_invoice_id
    WHERE i.status NOT IN ('draft', 'cancelled')
      AND EXTRACT(YEAR FROM i.issue_date) = $1
      AND NOT i.is_test
    ORDER BY i.number
  `, [year]);

  sendCsv(res, `konto-invoices-${year}.csv`,
    ['Number', 'Type', 'Issue date', 'Service from', 'Service to', 'Client', 'Country',
     'Client VAT ID', 'Currency', 'Net', 'VAT rate %', 'VAT amount', 'Gross',
     'Reverse charge', 'Status', 'Amount paid', 'Credits invoice'],
    rows.map((r) => [
      r.number, r.credits_number ? 'credit note' : 'invoice',
      r.issue_date, r.service_period_start, r.service_period_end,
      r.client, r.client_country, r.client_vat,
      r.currency, money(r.subtotal), Number(r.vat_rate), money(r.vat_amount), money(r.total),
      r.reverse_charge ? 'yes' : 'no', r.status, money(r.amount_paid), r.credits_number,
    ]));
});

// GET /settings/export/payments.csv?year=YYYY — payments received by date
// (the EÜR-relevant view: income counts when the money arrives, §11 EStG)
router.get('/export/payments.csv', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  if (!year) return res.status(400).send('year required');

  const { rows } = await pool.query(`
    SELECT p.paid_at, i.number, i.client_snapshot->>'name' AS client,
           p.method, p.reference, i.currency, p.amount,
           i.total AS invoice_total, i.vat_rate, i.reverse_charge
    FROM payments p
    JOIN invoices i ON i.id = p.invoice_id
    WHERE EXTRACT(YEAR FROM p.paid_at) = $1
      AND NOT i.is_test
    ORDER BY p.paid_at, i.number
  `, [year]);

  sendCsv(res, `konto-payments-${year}.csv`,
    ['Paid on', 'Invoice', 'Client', 'Method', 'Reference', 'Currency',
     'Amount', 'Invoice total', 'VAT rate %', 'Reverse charge'],
    rows.map((r) => [
      r.paid_at, r.number, r.client, r.method, r.reference, r.currency,
      money(r.amount), money(r.invoice_total), Number(r.vat_rate), r.reverse_charge ? 'yes' : 'no',
    ]));
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
