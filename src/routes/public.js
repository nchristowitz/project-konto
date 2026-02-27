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
    clientData: invoice.client_snapshot,
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

// GET /e/:token — public estimate view
router.get('/e/:token', async (req, res) => {
  const { rows: estimateRows } = await pool.query(
    'SELECT * FROM estimates WHERE view_token = $1', [req.params.token]
  );
  if (!estimateRows.length) return res.status(404).send('Estimate not found');

  const estimate = estimateRows[0];
  if (estimate.status === 'draft') return res.status(404).send('Estimate not found');

  // Auto-expire if past valid_until
  if (estimate.valid_until && ['sent', 'viewed'].includes(estimate.status)) {
    if (new Date(estimate.valid_until) < new Date()) {
      await pool.query(
        "UPDATE estimates SET status = 'expired', updated_at = NOW() WHERE id = $1",
        [estimate.id]
      );
      estimate.status = 'expired';
    }
  }

  const { rows: lines } = await pool.query(
    'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order',
    [estimate.id]
  );

  const { rows: profileRows } = await pool.query(
    'SELECT * FROM business_profile WHERE id = 1'
  );

  res.render('public/estimate', {
    estimate,
    lines,
    profile: profileRows[0] || {},
    clientData: estimate.client_snapshot,
    query: req.query,
  });
});

// GET /e/:token/pdf — download estimate PDF
router.get('/e/:token/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE view_token = $1', [req.params.token]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');

  const estimate = rows[0];
  if (estimate.status === 'draft') return res.status(404).send('Estimate not found');
  if (!estimate.pdf_filename) return res.status(404).send('PDF not available');

  const filePath = path.join(process.cwd(), 'data', 'estimates', estimate.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF file not found');

  res.download(filePath, `Estimate-${estimate.number}.pdf`);
});

// POST /e/:token/accept — client accepts estimate
router.post('/e/:token/accept', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE view_token = $1', [req.params.token]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');

  const estimate = rows[0];
  if (!['sent', 'viewed'].includes(estimate.status)) {
    return res.redirect(`/e/${req.params.token}?error=already_processed`);
  }

  // Check if expired
  if (estimate.valid_until && new Date(estimate.valid_until) < new Date()) {
    await pool.query(
      "UPDATE estimates SET status = 'expired', updated_at = NOW() WHERE id = $1",
      [estimate.id]
    );
    return res.redirect(`/e/${req.params.token}?error=expired`);
  }

  const ip = req.ip;
  const userAgent = req.get('user-agent') || null;

  await pool.query(`
    UPDATE estimates SET
      status = 'accepted',
      accepted_at = NOW(),
      accepted_ip = $1,
      accepted_user_agent = $2,
      updated_at = NOW()
    WHERE id = $3
  `, [ip, userAgent, estimate.id]);

  // Send admin notification (fire and forget)
  const { sendEstimateAcceptedNotification } = require('../services/email');
  const { rows: updated } = await pool.query('SELECT * FROM estimates WHERE id = $1', [estimate.id]);
  sendEstimateAcceptedNotification(updated[0]).catch(err => {
    console.error('[email] Failed to send acceptance notification:', err.message);
  });

  res.redirect(`/e/${req.params.token}?accepted=1`);
});

// POST /api/views/estimate/:token — view tracking beacon for estimates
router.post('/api/views/estimate/:token', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, status, first_viewed_at FROM estimates WHERE view_token = $1',
    [req.params.token]
  );
  if (!rows.length) return res.status(404).json({});

  const estimate = rows[0];
  const ip = req.ip;
  const userAgent = req.get('user-agent') || null;
  const referrer = req.get('referrer') || null;

  await pool.query(
    'INSERT INTO estimate_views (estimate_id, ip_address, user_agent, referrer) VALUES ($1, $2, $3, $4)',
    [estimate.id, ip, userAgent, referrer]
  );

  const updates = ['view_count = view_count + 1', 'last_viewed_at = NOW()'];
  if (!estimate.first_viewed_at) {
    updates.push('first_viewed_at = NOW()');
  }
  if (estimate.status === 'sent') {
    updates.push("status = 'viewed'");
  }

  await pool.query(
    `UPDATE estimates SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1`,
    [estimate.id]
  );

  res.json({ ok: true });
});

module.exports = router;
