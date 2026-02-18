const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

const router = Router();

// GET /i/:token — public invoice view
router.get('/i/:token', async (req, res) => {
  const { rows: invoiceRows } = await pool.query(
    'SELECT * FROM invoices WHERE view_token = $1', [req.params.token]
  );
  if (!invoiceRows.length) return res.status(404).send('Invoice not found');

  const invoice = invoiceRows[0];
  if (invoice.status === 'draft') return res.status(404).send('Invoice not found');

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoice.id]
  );

  // Get business profile
  const { rows: profileRows } = await pool.query(
    'SELECT * FROM business_profile WHERE id = 1'
  );

  res.render('public/invoice', {
    invoice,
    lines,
    profile: profileRows[0] || {},
    client: invoice.client_snapshot,
  });
});

// GET /i/:token/pdf — download invoice PDF
router.get('/i/:token/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE view_token = $1', [req.params.token]
  );
  if (!rows.length) return res.status(404).send('Invoice not found');

  const invoice = rows[0];
  if (invoice.status === 'draft') return res.status(404).send('Invoice not found');
  if (!invoice.pdf_filename) return res.status(404).send('PDF not available');

  const filePath = path.join(process.cwd(), 'data', 'invoices', invoice.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF file not found');

  res.download(filePath, `Invoice-${invoice.number}.pdf`);
});

// POST /api/views/:token — view tracking beacon
router.post('/api/views/:token', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, status, first_viewed_at FROM invoices WHERE view_token = $1',
    [req.params.token]
  );
  if (!rows.length) return res.status(404).json({});

  const invoice = rows[0];
  const ip = req.ip;
  const userAgent = req.get('user-agent') || null;
  const referrer = req.get('referrer') || null;

  // Log the view
  await pool.query(
    'INSERT INTO invoice_views (invoice_id, ip_address, user_agent, referrer) VALUES ($1, $2, $3, $4)',
    [invoice.id, ip, userAgent, referrer]
  );

  // Update invoice view stats
  const updates = ['view_count = view_count + 1', 'last_viewed_at = NOW()'];
  if (!invoice.first_viewed_at) {
    updates.push('first_viewed_at = NOW()');
  }
  if (invoice.status === 'sent') {
    updates.push("status = 'viewed'");
  }

  await pool.query(
    `UPDATE invoices SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`,
    [invoice.id]
  );

  res.json({ ok: true });
});

module.exports = router;
