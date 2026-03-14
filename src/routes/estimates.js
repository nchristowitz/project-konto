const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { getNextInvoiceNumber } = require('../services/invoiceNumber');
const { sendEstimateEmail } = require('../services/email');
const { generateEstimatePdf } = require('../services/estimatePdf');
const { buildBankAccountSnapshot, formatPaymentDetails } = require('../services/bankAccount');

const router = Router();

// GET /estimates
router.get('/', async (req, res) => {
  const { status, client_id } = req.query;
  let query = `
    SELECT e.*, c.name AS client_name
    FROM estimates e
    JOIN clients c ON e.client_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND e.status = $${params.length}`;
  }
  if (client_id) {
    params.push(client_id);
    query += ` AND e.client_id = $${params.length}`;
  }

  query += ' ORDER BY e.created_at DESC';

  const { rows: estimates } = await pool.query(query, params);
  res.render('estimates/index', { estimates, filters: { status, client_id } });
});

// GET /estimates/new
router.get('/new', async (req, res) => {
  const { rows: clients } = await pool.query(
    'SELECT c.*, c.default_bank_account_id FROM clients c WHERE c.archived = FALSE ORDER BY c.name'
  );
  const { rows: settingsRows } = await pool.query(
    'SELECT * FROM settings WHERE id = 1'
  );
  const settings = settingsRows[0];
  const { rows: bankAccounts } = await pool.query(
    'SELECT * FROM bank_accounts ORDER BY is_default DESC, label'
  );

  let selectedClient = null;
  if (req.query.client) {
    selectedClient = clients.find(c => c.id === parseInt(req.query.client, 10));
  }

  res.render('estimates/form', {
    estimate: null,
    lines: [],
    clients,
    settings,
    selectedClient,
    bankAccounts,
  });
});

// POST /estimates
router.post('/', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const {
      client_id, currency, issue_date, valid_until,
      vat_rate, vat_label, vat_note, reverse_charge,
      terms_text, notes, internal_notes,
      bank_account_id, reference,
      descriptions = [], details = [], quantities = [],
      unit_codes = [], unit_prices = [],
    } = req.body;

    // Get client for snapshot
    const { rows: clientRows } = await dbClient.query(
      'SELECT * FROM clients WHERE id = $1', [client_id]
    );
    if (!clientRows.length) throw new Error('Client not found');
    const clientData = clientRows[0];

    const clientSnapshot = {
      name: clientData.name,
      contact_person: clientData.contact_person,
      email: clientData.email,
      additional_emails: clientData.additional_emails || [],
      address_line1: clientData.address_line1,
      address_line2: clientData.address_line2,
      city: clientData.city,
      postal_code: clientData.postal_code,
      country_code: clientData.country_code,
      vat_number: clientData.vat_number,
    };

    // Bank account snapshot
    let bankAccountSnapshot = null;
    const baId = bank_account_id ? parseInt(bank_account_id, 10) : null;
    if (baId) {
      const { rows: baRows } = await dbClient.query(
        'SELECT * FROM bank_accounts WHERE id = $1', [baId]
      );
      if (baRows.length) bankAccountSnapshot = buildBankAccountSnapshot(baRows[0]);
    }

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

    // Generate estimate number and token
    const seqNumber = await getNextInvoiceNumber('EST');
    const number = `E-${seqNumber}`;
    const viewToken = crypto.randomBytes(16).toString('hex');

    // Insert estimate
    const { rows: estimateRows } = await dbClient.query(`
      INSERT INTO estimates (
        number, client_id, client_snapshot,
        issue_date, valid_until, currency,
        vat_rate, vat_label, vat_note, reverse_charge,
        subtotal, vat_amount, total,
        view_token, terms_text, notes, internal_notes,
        bank_account_id, bank_account_snapshot, reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      RETURNING id
    `, [
      number, client_id, JSON.stringify(clientSnapshot),
      issue_date, valid_until || null, currency || 'EUR',
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      viewToken, terms_text || null, notes || null, internal_notes || null,
      baId, bankAccountSnapshot ? JSON.stringify(bankAccountSnapshot) : null,
      reference || null,
    ]);

    const estimateId = estimateRows[0].id;

    // Insert line items
    for (const line of lineItems) {
      await dbClient.query(`
        INSERT INTO estimate_lines (
          estimate_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        estimateId, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    await dbClient.query('COMMIT');
    res.redirect(`/estimates/${estimateId}`);
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// POST /estimates/batch — batch cancel or delete
router.post('/batch', async (req, res) => {
  let ids = req.body.estimate_ids;
  if (!ids) return res.redirect('/estimates');
  if (!Array.isArray(ids)) ids = [ids];
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/estimates');

  const action = req.body.action;

  if (action === 'cancel') {
    await pool.query(`
      UPDATE estimates SET status = 'cancelled', updated_at = NOW()
      WHERE id = ANY($1) AND status NOT IN ('accepted', 'converted', 'cancelled')
    `, [numericIds]);
  } else if (action === 'delete') {
    const { rows } = await pool.query(
      `SELECT id, pdf_filename FROM estimates WHERE id = ANY($1) AND status IN ('draft', 'cancelled')`,
      [numericIds]
    );
    for (const est of rows) {
      if (est.pdf_filename) {
        const filePath = path.join(process.cwd(), 'data', 'estimates', est.pdf_filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    if (rows.length) {
      await pool.query(
        `DELETE FROM estimates WHERE id = ANY($1) AND status IN ('draft', 'cancelled')`,
        [numericIds]
      );
    }
  }

  res.redirect('/estimates');
});

// GET /estimates/:id
router.get('/:id', async (req, res) => {
  const { rows: estimateRows } = await pool.query(
    'SELECT e.*, c.name AS client_name FROM estimates e JOIN clients c ON e.client_id = c.id WHERE e.id = $1',
    [req.params.id]
  );
  if (!estimateRows.length) return res.status(404).send('Estimate not found');

  const estimate = estimateRows[0];
  const { rows: lines } = await pool.query(
    'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order',
    [estimate.id]
  );

  res.render('estimates/show', { estimate, lines, query: req.query });
});

// GET /estimates/:id/edit
router.get('/:id/edit', async (req, res) => {
  const { rows: estimateRows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [req.params.id]
  );
  if (!estimateRows.length) return res.status(404).send('Estimate not found');

  const estimate = estimateRows[0];
  if (!['draft', 'sent'].includes(estimate.status)) {
    return res.redirect(`/estimates/${estimate.id}`);
  }

  const { rows: lines } = await pool.query(
    'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order',
    [estimate.id]
  );
  const { rows: clients } = await pool.query(
    'SELECT c.*, c.default_bank_account_id FROM clients c WHERE c.archived = FALSE ORDER BY c.name'
  );
  const { rows: settingsRows } = await pool.query(
    'SELECT * FROM settings WHERE id = 1'
  );
  const { rows: bankAccounts } = await pool.query(
    'SELECT * FROM bank_accounts ORDER BY is_default DESC, label'
  );

  res.render('estimates/form', {
    estimate,
    lines,
    clients,
    settings: settingsRows[0],
    selectedClient: null,
    bankAccounts,
  });
});

// POST /estimates/:id
router.post('/:id', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const { rows: existing } = await dbClient.query(
      'SELECT * FROM estimates WHERE id = $1', [req.params.id]
    );
    if (!existing.length) throw new Error('Estimate not found');
    if (!['draft', 'sent'].includes(existing[0].status)) throw new Error('Only draft or sent estimates can be edited');

    const {
      client_id, currency, issue_date, valid_until,
      vat_rate, vat_label, vat_note, reverse_charge,
      terms_text, notes, internal_notes,
      bank_account_id, reference,
      descriptions = [], details = [], quantities = [],
      unit_codes = [], unit_prices = [],
    } = req.body;

    // Refresh client snapshot
    const { rows: clientRows } = await dbClient.query(
      'SELECT * FROM clients WHERE id = $1', [client_id]
    );
    const clientData = clientRows[0];
    const clientSnapshot = {
      name: clientData.name,
      contact_person: clientData.contact_person,
      email: clientData.email,
      additional_emails: clientData.additional_emails || [],
      address_line1: clientData.address_line1,
      address_line2: clientData.address_line2,
      city: clientData.city,
      postal_code: clientData.postal_code,
      country_code: clientData.country_code,
      vat_number: clientData.vat_number,
    };

    // Bank account snapshot
    let bankAccountSnapshot = null;
    const baId = bank_account_id ? parseInt(bank_account_id, 10) : null;
    if (baId) {
      const { rows: baRows } = await dbClient.query(
        'SELECT * FROM bank_accounts WHERE id = $1', [baId]
      );
      if (baRows.length) bankAccountSnapshot = buildBankAccountSnapshot(baRows[0]);
    }

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

    // Update estimate
    await dbClient.query(`
      UPDATE estimates SET
        client_id = $1, client_snapshot = $2,
        issue_date = $3, valid_until = $4, currency = $5,
        vat_rate = $6, vat_label = $7, vat_note = $8, reverse_charge = $9,
        subtotal = $10, vat_amount = $11, total = $12,
        terms_text = $13, notes = $14, internal_notes = $15,
        bank_account_id = $16, bank_account_snapshot = $17,
        reference = $18,
        updated_at = NOW()
      WHERE id = $19
    `, [
      client_id, JSON.stringify(clientSnapshot),
      issue_date, valid_until || null, currency || 'EUR',
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      terms_text || null, notes || null, internal_notes || null,
      baId, bankAccountSnapshot ? JSON.stringify(bankAccountSnapshot) : null,
      reference || null,
      req.params.id,
    ]);

    // Replace line items
    await dbClient.query('DELETE FROM estimate_lines WHERE estimate_id = $1', [req.params.id]);
    for (const line of lineItems) {
      await dbClient.query(`
        INSERT INTO estimate_lines (
          estimate_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        req.params.id, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    await dbClient.query('COMMIT');
    res.redirect(`/estimates/${req.params.id}`);
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// POST /estimates/:id/pdf — generate or regenerate PDF
router.post('/:id/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');

  try {
    await generateEstimatePdf(rows[0].id);
    res.redirect(`/estimates/${rows[0].id}?pdf_generated=1`);
  } catch (err) {
    console.error(`Failed to generate PDF for estimate ${rows[0].number}:`, err);
    res.redirect(`/estimates/${rows[0].id}?error=pdf_failed`);
  }
});

// GET /estimates/:id/pdf — download the PDF
router.get('/:id/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');
  if (!rows[0].pdf_filename) return res.status(404).send('PDF not generated yet');

  const filePath = path.join(process.cwd(), 'data', 'estimates', rows[0].pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF file not found');

  res.download(filePath, `Estimate-${rows[0].number}.pdf`);
});

// POST /estimates/:id/send — send estimate email to client
router.post('/:id/send', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');

  const estimate = rows[0];
  if (['converted', 'expired'].includes(estimate.status)) {
    return res.status(400).send('Cannot send this estimate');
  }

  try {
    // Auto-generate PDF if not yet generated
    if (!estimate.pdf_filename) {
      try {
        await generateEstimatePdf(estimate.id);
        const { rows: refreshed } = await pool.query(
          'SELECT pdf_filename FROM estimates WHERE id = $1', [estimate.id]
        );
        estimate.pdf_filename = refreshed[0].pdf_filename;
      } catch (pdfErr) {
        console.error(`PDF generation failed for estimate ${estimate.number}, sending without PDF:`, pdfErr);
      }
    }

    const result = await sendEstimateEmail(estimate);

    // Update status to sent if currently draft
    if (estimate.status === 'draft') {
      await pool.query(
        "UPDATE estimates SET status = 'sent', updated_at = NOW() WHERE id = $1",
        [estimate.id]
      );
    }

    const params = new URLSearchParams({ sent: '1' });
    if (result.previewUrl) params.set('preview', result.previewUrl);
    res.redirect(`/estimates/${estimate.id}?${params}`);
  } catch (err) {
    console.error(`Failed to send estimate ${estimate.number}:`, err);
    res.redirect(`/estimates/${estimate.id}?error=send_failed`);
  }
});

// POST /estimates/:id/status — manual status change
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const allowed = ['draft', 'sent', 'rejected', 'expired'];
  if (!allowed.includes(status)) return res.status(400).send('Invalid status');

  await pool.query(
    'UPDATE estimates SET status = $1, updated_at = NOW() WHERE id = $2',
    [status, req.params.id]
  );
  res.redirect(`/estimates/${req.params.id}`);
});

// POST /estimates/:id/convert — convert accepted estimate to invoice
router.post('/:id/convert', async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const { rows: estRows } = await dbClient.query(
      'SELECT * FROM estimates WHERE id = $1', [req.params.id]
    );
    if (!estRows.length) throw new Error('Estimate not found');
    const estimate = estRows[0];
    if (estimate.status !== 'accepted') throw new Error('Only accepted estimates can be converted');

    // Get estimate lines
    const { rows: estLines } = await dbClient.query(
      'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]
    );

    // Generate invoice number and token
    const invoiceNumber = await getNextInvoiceNumber('INV');
    const viewToken = crypto.randomBytes(16).toString('hex');

    // Calculate due date from client payment terms
    const { rows: clientRows } = await dbClient.query(
      'SELECT payment_terms_days FROM clients WHERE id = $1', [estimate.client_id]
    );
    const terms = clientRows[0]?.payment_terms_days || 30;
    const issueDate = new Date();
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + terms);

    // Generate payment_details from bank account snapshot
    const paymentDetails = formatPaymentDetails(estimate.bank_account_snapshot);

    // Create invoice from estimate data
    const { rows: invoiceRows } = await dbClient.query(`
      INSERT INTO invoices (
        number, client_id, client_snapshot,
        issue_date, due_date, currency,
        vat_rate, vat_label, vat_note, reverse_charge,
        subtotal, vat_amount, total,
        view_token, notes, internal_notes, estimate_id,
        bank_account_id, bank_account_snapshot, payment_details, reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING id
    `, [
      invoiceNumber, estimate.client_id, JSON.stringify(estimate.client_snapshot),
      issueDate.toISOString().slice(0, 10),
      dueDate.toISOString().slice(0, 10),
      estimate.currency,
      estimate.vat_rate, estimate.vat_label, estimate.vat_note, estimate.reverse_charge,
      estimate.subtotal, estimate.vat_amount, estimate.total,
      viewToken, estimate.notes, estimate.internal_notes, estimate.id,
      estimate.bank_account_id,
      estimate.bank_account_snapshot ? JSON.stringify(estimate.bank_account_snapshot) : null,
      paymentDetails || null,
      estimate.reference || null,
    ]);

    const invoiceId = invoiceRows[0].id;

    // Copy line items
    for (const line of estLines) {
      await dbClient.query(`
        INSERT INTO invoice_lines (
          invoice_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        invoiceId, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    // Mark estimate as converted
    await dbClient.query(`
      UPDATE estimates SET
        status = 'converted',
        converted_invoice_id = $1,
        updated_at = NOW()
      WHERE id = $2
    `, [invoiceId, estimate.id]);

    await dbClient.query('COMMIT');
    res.redirect(`/invoices/${invoiceId}`);
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
});

// POST /estimates/:id/delete — hard delete draft estimates
router.post('/:id/delete', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Estimate not found');
  if (rows[0].status !== 'draft') return res.status(400).send('Only draft estimates can be deleted');

  // Delete PDF file if exists
  if (rows[0].pdf_filename) {
    const filePath = path.join(process.cwd(), 'data', 'estimates', rows[0].pdf_filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Lines cascade via ON DELETE CASCADE
  await pool.query('DELETE FROM estimates WHERE id = $1', [req.params.id]);
  res.redirect('/estimates');
});

module.exports = router;
