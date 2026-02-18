const { Router } = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { getNextInvoiceNumber } = require('../services/invoiceNumber');
const { sendInvoiceEmail, sendReminderEmail } = require('../services/email');

const router = Router();

// GET /invoices
router.get('/', async (req, res) => {
  const { status, client_id } = req.query;
  let query = `
    SELECT i.*, c.name AS client_name
    FROM invoices i
    JOIN clients c ON i.client_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND i.status = $${params.length}`;
  }
  if (client_id) {
    params.push(client_id);
    query += ` AND i.client_id = $${params.length}`;
  }

  query += ' ORDER BY i.created_at DESC';

  const { rows: invoices } = await pool.query(query, params);
  res.render('invoices/index', { invoices, filters: { status, client_id } });
});

// GET /invoices/new
router.get('/new', async (req, res) => {
  const { rows: clients } = await pool.query(
    'SELECT * FROM clients WHERE archived = FALSE ORDER BY name'
  );
  const { rows: settingsRows } = await pool.query(
    'SELECT * FROM settings WHERE id = 1'
  );
  const settings = settingsRows[0];

  // Pre-fill from client if specified
  let selectedClient = null;
  if (req.query.client) {
    selectedClient = clients.find(c => c.id === parseInt(req.query.client, 10));
  }

  res.render('invoices/form', {
    invoice: null,
    lines: [],
    clients,
    settings,
    selectedClient,
  });
});

// POST /invoices
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      client_id, currency, issue_date, due_date,
      vat_rate, vat_label, vat_note, reverse_charge,
      payment_details, notes, internal_notes,
      descriptions = [], details = [], quantities = [],
      unit_codes = [], unit_prices = [],
    } = req.body;

    // Get client for snapshot
    const { rows: clientRows } = await client.query(
      'SELECT * FROM clients WHERE id = $1', [client_id]
    );
    if (!clientRows.length) throw new Error('Client not found');
    const clientData = clientRows[0];

    const clientSnapshot = {
      name: clientData.name,
      contact_person: clientData.contact_person,
      email: clientData.email,
      address_line1: clientData.address_line1,
      address_line2: clientData.address_line2,
      city: clientData.city,
      postal_code: clientData.postal_code,
      country_code: clientData.country_code,
      vat_number: clientData.vat_number,
    };

    // Calculate totals
    const lineItems = [];
    const descArray = Array.isArray(descriptions) ? descriptions : [descriptions];
    const detailArray = Array.isArray(details) ? details : [details];
    const qtyArray = Array.isArray(quantities) ? quantities : [quantities];
    const unitArray = Array.isArray(unit_codes) ? unit_codes : [unit_codes];
    const priceArray = Array.isArray(unit_prices) ? unit_prices : [unit_prices];

    let subtotal = 0;
    for (let i = 0; i < descArray.length; i++) {
      if (!descArray[i] || !descArray[i].trim()) continue;
      const qty = parseFloat(qtyArray[i]) || 1;
      const price = parseFloat(priceArray[i]) || 0;
      const lineTotal = Math.round(qty * price * 100) / 100;
      subtotal += lineTotal;
      lineItems.push({
        description: descArray[i].trim(),
        detail: (detailArray[i] || '').trim() || null,
        quantity: qty,
        unit_code: unitArray[i] || 'HUR',
        unit_price: price,
        line_total: lineTotal,
        sort_order: i,
      });
    }

    const vatRate = parseFloat(vat_rate) || 0;
    const isReverseCharge = reverse_charge === 'on';
    const vatAmount = isReverseCharge ? 0 : Math.round(subtotal * vatRate / 100 * 100) / 100;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;

    // Generate invoice number and token
    const number = await getNextInvoiceNumber('INV');
    const viewToken = crypto.randomBytes(16).toString('hex');

    // Insert invoice
    const { rows: invoiceRows } = await client.query(`
      INSERT INTO invoices (
        number, client_id, client_snapshot,
        issue_date, due_date, currency,
        vat_rate, vat_label, vat_note, reverse_charge,
        subtotal, vat_amount, total,
        view_token, payment_details, notes, internal_notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id
    `, [
      number, client_id, JSON.stringify(clientSnapshot),
      issue_date, due_date || null, currency || 'EUR',
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      viewToken, payment_details || null, notes || null, internal_notes || null,
    ]);

    const invoiceId = invoiceRows[0].id;

    // Insert line items
    for (const line of lineItems) {
      await client.query(`
        INSERT INTO invoice_lines (
          invoice_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        invoiceId, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    await client.query('COMMIT');
    res.redirect(`/invoices/${invoiceId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /invoices/:id
router.get('/:id', async (req, res) => {
  const { rows: invoiceRows } = await pool.query(
    'SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON i.client_id = c.id WHERE i.id = $1',
    [req.params.id]
  );
  if (!invoiceRows.length) return res.status(404).send('Invoice not found');

  const invoice = invoiceRows[0];
  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoice.id]
  );
  const { rows: payments } = await pool.query(
    'SELECT * FROM payments WHERE invoice_id = $1 ORDER BY paid_at DESC',
    [invoice.id]
  );

  res.render('invoices/show', { invoice, lines, payments, query: req.query });
});

// GET /invoices/:id/edit
router.get('/:id/edit', async (req, res) => {
  const { rows: invoiceRows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!invoiceRows.length) return res.status(404).send('Invoice not found');

  const invoice = invoiceRows[0];
  if (invoice.status !== 'draft') {
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoice.id]
  );
  const { rows: clients } = await pool.query(
    'SELECT * FROM clients WHERE archived = FALSE ORDER BY name'
  );
  const { rows: settingsRows } = await pool.query(
    'SELECT * FROM settings WHERE id = 1'
  );

  res.render('invoices/form', {
    invoice,
    lines,
    clients,
    settings: settingsRows[0],
    selectedClient: null,
  });
});

// POST /invoices/:id
router.post('/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT * FROM invoices WHERE id = $1', [req.params.id]
    );
    if (!existing.length) throw new Error('Invoice not found');
    if (existing[0].status !== 'draft') throw new Error('Only drafts can be edited');

    const {
      client_id, currency, issue_date, due_date,
      vat_rate, vat_label, vat_note, reverse_charge,
      payment_details, notes, internal_notes,
      descriptions = [], details = [], quantities = [],
      unit_codes = [], unit_prices = [],
    } = req.body;

    // Refresh client snapshot
    const { rows: clientRows } = await client.query(
      'SELECT * FROM clients WHERE id = $1', [client_id]
    );
    const clientData = clientRows[0];
    const clientSnapshot = {
      name: clientData.name,
      contact_person: clientData.contact_person,
      email: clientData.email,
      address_line1: clientData.address_line1,
      address_line2: clientData.address_line2,
      city: clientData.city,
      postal_code: clientData.postal_code,
      country_code: clientData.country_code,
      vat_number: clientData.vat_number,
    };

    // Calculate totals
    const lineItems = [];
    const descArray = Array.isArray(descriptions) ? descriptions : [descriptions];
    const detailArray = Array.isArray(details) ? details : [details];
    const qtyArray = Array.isArray(quantities) ? quantities : [quantities];
    const unitArray = Array.isArray(unit_codes) ? unit_codes : [unit_codes];
    const priceArray = Array.isArray(unit_prices) ? unit_prices : [unit_prices];

    let subtotal = 0;
    for (let i = 0; i < descArray.length; i++) {
      if (!descArray[i] || !descArray[i].trim()) continue;
      const qty = parseFloat(qtyArray[i]) || 1;
      const price = parseFloat(priceArray[i]) || 0;
      const lineTotal = Math.round(qty * price * 100) / 100;
      subtotal += lineTotal;
      lineItems.push({
        description: descArray[i].trim(),
        detail: (detailArray[i] || '').trim() || null,
        quantity: qty,
        unit_code: unitArray[i] || 'HUR',
        unit_price: price,
        line_total: lineTotal,
        sort_order: i,
      });
    }

    const vatRate = parseFloat(vat_rate) || 0;
    const isReverseCharge = reverse_charge === 'on';
    const vatAmount = isReverseCharge ? 0 : Math.round(subtotal * vatRate / 100 * 100) / 100;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;

    // Update invoice
    await client.query(`
      UPDATE invoices SET
        client_id = $1, client_snapshot = $2,
        issue_date = $3, due_date = $4, currency = $5,
        vat_rate = $6, vat_label = $7, vat_note = $8, reverse_charge = $9,
        subtotal = $10, vat_amount = $11, total = $12,
        payment_details = $13, notes = $14, internal_notes = $15,
        updated_at = NOW()
      WHERE id = $16
    `, [
      client_id, JSON.stringify(clientSnapshot),
      issue_date, due_date || null, currency || 'EUR',
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      payment_details || null, notes || null, internal_notes || null,
      req.params.id,
    ]);

    // Replace line items
    await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [req.params.id]);
    for (const line of lineItems) {
      await client.query(`
        INSERT INTO invoice_lines (
          invoice_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        req.params.id, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    await client.query('COMMIT');
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /invoices/:id/send — send invoice email to client
router.post('/:id/send', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Invoice not found');

  const invoice = rows[0];
  if (invoice.status === 'cancelled') return res.status(400).send('Cannot send cancelled invoice');

  try {
    const result = await sendInvoiceEmail(invoice);

    // Update status to sent if currently draft
    if (invoice.status === 'draft') {
      await pool.query(
        "UPDATE invoices SET status = 'sent', updated_at = NOW() WHERE id = $1",
        [invoice.id]
      );
    }

    const params = new URLSearchParams({ sent: '1' });
    if (result.previewUrl) params.set('preview', result.previewUrl);
    res.redirect(`/invoices/${invoice.id}?${params}`);
  } catch (err) {
    console.error(`Failed to send invoice ${invoice.number}:`, err);
    await pool.query(
      "INSERT INTO email_log (invoice_id, type, recipient, subject, status) VALUES ($1, 'invoice_sent', $2, $3, 'failed')",
      [invoice.id, invoice.client_snapshot?.email || '', `Invoice ${invoice.number}`]
    );
    res.redirect(`/invoices/${invoice.id}?error=send_failed`);
  }
});

// POST /invoices/:id/remind — manually send reminder
router.post('/:id/remind', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Invoice not found');

  const invoice = rows[0];

  try {
    const result = await sendReminderEmail(invoice);
    await pool.query(`
      UPDATE invoices SET
        reminder_count = reminder_count + 1,
        last_reminder_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [invoice.id]);

    const params = new URLSearchParams({ reminded: '1' });
    if (result.previewUrl) params.set('preview', result.previewUrl);
    res.redirect(`/invoices/${invoice.id}?${params}`);
  } catch (err) {
    console.error(`Failed to send reminder for invoice ${invoice.number}:`, err);
    res.redirect(`/invoices/${invoice.id}?error=remind_failed`);
  }
});

// POST /invoices/:id/status
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['draft', 'sent', 'viewed', 'paid', 'partially_paid', 'overdue', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).send('Invalid status');

  await pool.query(
    'UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, req.params.id]
  );
  res.redirect(`/invoices/${req.params.id}`);
});

// POST /invoices/:id/payments — record a payment
router.post('/:id/payments', async (req, res) => {
  const { amount, paid_at, method, reference } = req.body;
  const invoiceId = req.params.id;

  await pool.query(`
    INSERT INTO payments (invoice_id, amount, paid_at, method, reference)
    VALUES ($1, $2, $3, $4, $5)
  `, [
    invoiceId,
    parseFloat(amount),
    paid_at || new Date().toISOString().slice(0, 10),
    method || null,
    reference || null,
  ]);

  // Recalculate amount_paid and update status
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1',
    [invoiceId]
  );
  const totalPaid = parseFloat(rows[0].total_paid);

  const { rows: invRows } = await pool.query(
    'SELECT total FROM invoices WHERE id = $1', [invoiceId]
  );
  const invoiceTotal = parseFloat(invRows[0].total);

  let newStatus;
  if (totalPaid >= invoiceTotal) {
    newStatus = 'paid';
  } else if (totalPaid > 0) {
    newStatus = 'partially_paid';
  }

  const statusUpdate = newStatus ? ', status = $3' : '';
  const params = newStatus
    ? [totalPaid, invoiceId, newStatus]
    : [totalPaid, invoiceId];

  await pool.query(
    `UPDATE invoices SET amount_paid = $1, updated_at = NOW()${statusUpdate} WHERE id = $2`,
    params
  );

  res.redirect(`/invoices/${invoiceId}`);
});

// DELETE /invoices/:id/payments/:pid — remove a payment
router.post('/:id/payments/:pid/delete', async (req, res) => {
  const { id: invoiceId, pid } = req.params;

  await pool.query('DELETE FROM payments WHERE id = $1 AND invoice_id = $2', [pid, invoiceId]);

  // Recalculate amount_paid
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payments WHERE invoice_id = $1',
    [invoiceId]
  );
  const totalPaid = parseFloat(rows[0].total_paid);

  const { rows: invRows } = await pool.query(
    'SELECT total, status FROM invoices WHERE id = $1', [invoiceId]
  );
  const invoiceTotal = parseFloat(invRows[0].total);

  let newStatus = invRows[0].status;
  if (totalPaid >= invoiceTotal) {
    newStatus = 'paid';
  } else if (totalPaid > 0) {
    newStatus = 'partially_paid';
  } else if (['paid', 'partially_paid'].includes(newStatus)) {
    newStatus = 'sent';
  }

  await pool.query(
    'UPDATE invoices SET amount_paid = $1, status = $2, updated_at = NOW() WHERE id = $3',
    [totalPaid, newStatus, invoiceId]
  );

  res.redirect(`/invoices/${invoiceId}`);
});

module.exports = router;
