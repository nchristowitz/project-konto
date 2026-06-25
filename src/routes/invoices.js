const { Router } = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const { getNextInvoiceNumber, decrementIfLast, getNextTestNumber } = require('../services/invoiceNumber');
const archiver = require('archiver');
const { sendInvoiceEmail, sendReminderEmail } = require('../services/email');
const { generateEInvoice, buildEInvoicePdfBytes } = require('../services/einvoice');
const { buildBankAccountSnapshot } = require('../services/bankAccount');

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

  query += ' ORDER BY i.issue_date DESC, i.number DESC';

  const { rows: invoices } = await pool.query(query, params);
  res.render('invoices/index', { invoices, filters: { status, client_id }, query: req.query });
});

// GET /invoices/new
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
    bankAccounts,
  });
});

// POST /invoices
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      client_id, currency, issue_date, due_date,
      service_period_start, service_period_end,
      vat_rate, vat_label, vat_note, reverse_charge,
      payment_details, notes, internal_notes,
      bank_account_id, reference,
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
      const { rows: baRows } = await client.query(
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
        unit_code: unitArray[i] || 'DAY',
        unit_price: price,
        line_total: lineTotal,
        sort_order: i,
      });
    }

    const vatRate = parseFloat(vat_rate) || 0;
    const isReverseCharge = reverse_charge === 'on';
    const vatAmount = isReverseCharge ? 0 : Math.round(subtotal * vatRate / 100 * 100) / 100;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;

    // Generate invoice number and token.
    // Pass the txn client so a failed INSERT rolls back the sequence increment
    // (keeps numbering gapless for tax-audit purposes). Year is derived from
    // issue_date, not wall clock, so a backdated invoice lands in the right year.
    // Test-client documents draw from the throwaway TEST counter, never the
    // gapless INV sequence, so they can be made and deleted freely.
    const isTest = clientData.is_test === true;
    const number = isTest
      ? await getNextTestNumber(client)
      : await getNextInvoiceNumber('INV', issue_date, client);
    const viewToken = crypto.randomBytes(16).toString('hex');

    // Insert invoice
    const { rows: invoiceRows } = await client.query(`
      INSERT INTO invoices (
        number, client_id, client_snapshot,
        issue_date, due_date, currency,
        service_period_start, service_period_end,
        vat_rate, vat_label, vat_note, reverse_charge,
        subtotal, vat_amount, total,
        view_token, payment_details, notes, internal_notes,
        bank_account_id, bank_account_snapshot, reference
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING id
    `, [
      number, client_id, JSON.stringify(clientSnapshot),
      issue_date, due_date || null, currency || 'EUR',
      service_period_start || null, service_period_end || null,
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      viewToken, payment_details || null, notes || null, internal_notes || null,
      baId, bankAccountSnapshot ? JSON.stringify(bankAccountSnapshot) : null,
      reference || null,
    ]);

    const invoiceId = invoiceRows[0].id;

    // Sandbox flag — keeps it out of numbering reclaim, revenue, exports, reminders.
    // Set post-insert to avoid threading is_test through the INSERT column list.
    if (isTest) {
      await client.query('UPDATE invoices SET is_test = TRUE WHERE id = $1', [invoiceId]);
    }

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

// POST /invoices/export — batch PDF export
router.post('/export', async (req, res) => {
  let ids = req.body.invoice_ids;
  if (!ids) return res.redirect('/invoices');
  if (!Array.isArray(ids)) ids = [ids];

  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/invoices');

  // Fetch invoices
  const { rows: invoices } = await pool.query(
    `SELECT * FROM invoices WHERE id = ANY($1) ORDER BY number`,
    [numericIds]
  );
  if (!invoices.length) return res.redirect('/invoices');

  // Auto-generate PDFs for any that don't have one
  for (const inv of invoices) {
    if (!inv.pdf_filename) {
      try {
        const result = await generateEInvoice(inv.id);
        inv.pdf_filename = result.filename;
      } catch (err) {
        console.error(`Failed to generate PDF for invoice ${inv.number}:`, err);
      }
    }
  }

  // Filter to invoices that have PDFs
  const withPdf = invoices.filter(inv => inv.pdf_filename);
  if (!withPdf.length) return res.redirect('/invoices?error=no_pdfs');

  if (withPdf.length === 1) {
    // Single invoice — stream PDF directly
    const inv = withPdf[0];
    const filePath = path.join(process.cwd(), 'data', 'invoices', inv.pdf_filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('PDF file not found');
    return res.download(filePath, `Invoice-${inv.number}.pdf`);
  }

  // Multiple — create zip
  const now = new Date();
  const zipName = `invoices-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (const inv of withPdf) {
    const filePath = path.join(process.cwd(), 'data', 'invoices', inv.pdf_filename);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: `Invoice-${inv.number}.pdf` });
    }
  }

  await archive.finalize();
});

// POST /invoices/batch — batch cancel or delete
router.post('/batch', async (req, res) => {
  let ids = req.body.invoice_ids;
  if (!ids) return res.redirect('/invoices');
  if (!Array.isArray(ids)) ids = [ids];
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (!numericIds.length) return res.redirect('/invoices');

  const action = req.body.action;

  if (action === 'cancel') {
    await pool.query(`
      UPDATE invoices SET status = 'cancelled', updated_at = NOW()
      WHERE id = ANY($1) AND status NOT IN ('paid', 'cancelled')
    `, [numericIds]);
  } else if (action === 'delete') {
    const { rows } = await pool.query(
      `SELECT id, pdf_filename FROM invoices WHERE id = ANY($1) AND (status IN ('draft', 'cancelled') OR is_test)`,
      [numericIds]
    );
    for (const inv of rows) {
      if (inv.pdf_filename) {
        const filePath = path.join(process.cwd(), 'data', 'invoices', inv.pdf_filename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    if (rows.length) {
      // Delete one at a time so FK-linked invoices are skipped, not crash the whole batch
      let skipped = 0;
      for (const inv of rows) {
        try {
          await pool.query(`DELETE FROM invoices WHERE id = $1`, [inv.id]);
        } catch (err) {
          if (err.code === '23503') { skipped++; continue; } // FK constraint — skip
          throw err;
        }
      }
      if (skipped > 0) {
        return res.redirect('/invoices?error=Some invoices were skipped because they are linked to estimates');
      }
    }
  }

  res.redirect('/invoices');
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

  // Credit-note cross-links: the original this one credits, and any credit
  // notes that reference this invoice.
  let creditedInvoice = null;
  if (invoice.credits_invoice_id) {
    const { rows } = await pool.query(
      'SELECT id, number, issue_date FROM invoices WHERE id = $1',
      [invoice.credits_invoice_id]
    );
    creditedInvoice = rows[0] || null;
  }
  const { rows: creditNotes } = await pool.query(
    'SELECT id, number, status, total FROM invoices WHERE credits_invoice_id = $1 ORDER BY id',
    [invoice.id]
  );

  res.render('invoices/show', { invoice, lines, payments, creditedInvoice, creditNotes, query: req.query });
});

// POST /invoices/:id/credit-note — create a draft credit note: a negated copy
// of an issued invoice, numbered from the same sequence, referencing the
// original (§14 correction practice). Draft-first so partial credits can be
// made by editing lines before sending.
router.post('/:id/credit-note', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).send('Invoice not found');
    }
    const original = rows[0];
    if (original.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).send('Drafts can be edited or deleted directly — credit notes are for issued invoices.');
    }
    if (original.credits_invoice_id) {
      await client.query('ROLLBACK');
      return res.status(400).send('Cannot create a credit note for a credit note.');
    }

    const { rows: lineRows } = await client.query(
      'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
      [original.id]
    );

    const today = new Date().toISOString().slice(0, 10);
    // A credit note of a test invoice is itself a test document.
    const isTest = original.is_test === true;
    const number = isTest
      ? await getNextTestNumber(client)
      : await getNextInvoiceNumber('INV', today, client);
    const viewToken = crypto.randomBytes(16).toString('hex');

    // Negate quantities, keep unit prices positive (EN 16931 BR-27)
    let subtotal = 0;
    const creditLines = lineRows.map((l) => {
      const qty = -Number(l.quantity);
      const lineTotal = Math.round(qty * Number(l.unit_price) * 100) / 100;
      subtotal += lineTotal;
      return { ...l, quantity: qty, line_total: lineTotal };
    });
    subtotal = Math.round(subtotal * 100) / 100;
    const vatAmount = original.reverse_charge
      ? 0
      : Math.round(subtotal * Number(original.vat_rate) / 100 * 100) / 100;
    const total = Math.round((subtotal + vatAmount) * 100) / 100;

    const { rows: created } = await client.query(`
      INSERT INTO invoices (
        number, client_id, client_snapshot,
        issue_date, due_date, currency,
        service_period_start, service_period_end,
        vat_rate, vat_label, vat_note, reverse_charge,
        subtotal, vat_amount, total,
        view_token, payment_details, notes, internal_notes,
        bank_account_id, bank_account_snapshot, reference,
        credits_invoice_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      RETURNING id
    `, [
      number, original.client_id, JSON.stringify(original.client_snapshot),
      today, null, original.currency,
      // The credited supply keeps the original's service date/period. When the
      // original had none ("service date = invoice date"), pin the CN to the
      // original's issue date — "as invoice date" would wrongly mean the CN's.
      original.service_period_start || original.issue_date, original.service_period_end,
      original.vat_rate, original.vat_label, original.vat_note, original.reverse_charge,
      subtotal, vatAmount, total,
      viewToken, null,
      `Credit note for invoice ${original.number} dated ${original.issue_date}.`,
      null,
      original.bank_account_id,
      original.bank_account_snapshot ? JSON.stringify(original.bank_account_snapshot) : null,
      original.reference,
      original.id,
    ]);

    if (isTest) {
      await client.query('UPDATE invoices SET is_test = TRUE WHERE id = $1', [created[0].id]);
    }

    for (const line of creditLines) {
      await client.query(`
        INSERT INTO invoice_lines (
          invoice_id, description, detail, quantity,
          unit_code, unit_price, line_total, sort_order
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [
        created[0].id, line.description, line.detail, line.quantity,
        line.unit_code, line.unit_price, line.line_total, line.sort_order,
      ]);
    }

    await client.query('COMMIT');
    res.redirect(`/invoices/${created[0].id}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /invoices/:id/preview — owner-only preview of the public client view, for
// ANY status incl. draft, with NO side effects: it renders the same public
// template but suppresses the view-tracking beacon (no view_count bump, no
// sent->viewed flip). This is the answer to "what will the client see" without
// having to mark the invoice sent first.
router.get('/:id/preview', async (req, res) => {
  const { rows: invoiceRows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!invoiceRows.length) return res.status(404).send('Invoice not found');
  const invoice = invoiceRows[0];

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order', [invoice.id]
  );
  const { rows: profileRows } = await pool.query('SELECT * FROM business_profile WHERE id = 1');

  let creditRef = null;
  if (invoice.credits_invoice_id) {
    const { rows } = await pool.query(
      'SELECT number, issue_date FROM invoices WHERE id = $1', [invoice.credits_invoice_id]
    );
    creditRef = rows[0] || null;
  }

  res.render('public/invoice', {
    invoice, lines, profile: profileRows[0] || {},
    clientData: invoice.client_snapshot, creditRef, preview: true,
  });
});

// GET /invoices/:id/preview/pdf — owner-only inline PDF preview, any status,
// generated on the fly and NOT persisted (never sets pdf_filename), so previewing
// a draft can't leave a stale PDF that a later Send would reuse.
router.get('/:id/preview/pdf', async (req, res) => {
  const { rows } = await pool.query('SELECT id, number FROM invoices WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).send('Invoice not found');
  try {
    const { bytes } = await buildEInvoicePdfBytes(rows[0].id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Invoice-${rows[0].number}-preview.pdf"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(`Preview PDF failed for invoice ${rows[0].number}:`, err);
    res.status(500).send('Could not generate preview PDF. ' + err.message);
  }
});

// GET /invoices/:id/duplicate — open a pre-filled "New invoice" form seeded from
// an existing one (any status). Nothing is written and no number is minted until
// the user saves, so abandoning a duplicate costs nothing and never burns a gap
// in the sequence. Built for the monthly-recurring case (e.g. Metalab) where last
// month's invoice is the fastest starting point — tweak what changed (descriptions,
// PO#, dates) and save. The prefill object deliberately has no `id`, so the shared
// form renders in "new" mode and POSTs to /invoices.
router.get('/:id/duplicate', async (req, res) => {
  const { rows: srcRows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!srcRows.length) return res.status(404).send('Invoice not found');
  const src = srcRows[0];

  // A credit note is a negated correction of a specific invoice — duplicating it
  // into a fresh invoice makes no sense. Corrections go through "Issue credit note".
  if (src.credits_invoice_id) {
    const msg = 'Credit notes cannot be duplicated. Use "Issue credit note" on the original invoice instead.';
    return res.redirect(`/invoices/${src.id}?error=${encodeURIComponent(msg)}`);
  }

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [src.id]
  );
  const { rows: clients } = await pool.query(
    'SELECT c.*, c.default_bank_account_id FROM clients c WHERE c.archived = FALSE ORDER BY c.name'
  );
  const { rows: settingsRows } = await pool.query('SELECT * FROM settings WHERE id = 1');
  const { rows: bankAccounts } = await pool.query(
    'SELECT * FROM bank_accounts ORDER BY is_default DESC, label'
  );

  // Fresh dates: issue today; due today + the client's payment terms (same rule
  // as estimate→invoice convert). The service period is copied as a starting
  // point — it usually shifts month to month, so it's the field most likely to
  // need editing.
  const { rows: clientRows } = await pool.query(
    'SELECT payment_terms_days FROM clients WHERE id = $1', [src.client_id]
  );
  const terms = clientRows[0]?.payment_terms_days || 30;
  const today = new Date();
  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + terms);

  const prefill = {
    client_id: src.client_id,
    currency: src.currency,
    issue_date: today.toISOString().slice(0, 10),
    due_date: dueDate.toISOString().slice(0, 10),
    service_period_start: src.service_period_start,
    service_period_end: src.service_period_end,
    vat_rate: src.vat_rate,
    vat_label: src.vat_label,
    vat_note: src.vat_note,
    reverse_charge: src.reverse_charge,
    payment_details: src.payment_details,
    notes: src.notes,
    internal_notes: src.internal_notes,
    bank_account_id: src.bank_account_id,
    reference: src.reference,
  };

  res.render('invoices/form', {
    invoice: prefill,
    lines,
    clients,
    settings: settingsRows[0],
    selectedClient: null,
    bankAccounts,
    duplicateSource: src.number,
  });
});

// GET /invoices/:id/edit
router.get('/:id/edit', async (req, res) => {
  const { rows: invoiceRows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!invoiceRows.length) return res.status(404).send('Invoice not found');

  const invoice = invoiceRows[0];
  // Only drafts are editable. Sent invoices are immutable records under GoBD —
  // corrections go through cancel + re-issue, not edit-in-place.
  if (invoice.status !== 'draft') {
    return res.redirect(`/invoices/${invoice.id}`);
  }

  const { rows: lines } = await pool.query(
    'SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order',
    [invoice.id]
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

  res.render('invoices/form', {
    invoice,
    lines,
    clients,
    settings: settingsRows[0],
    selectedClient: null,
    bankAccounts,
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
    // Only drafts are editable — see GET /:id/edit for rationale.
    if (existing[0].status !== 'draft') throw new Error('Only draft invoices can be edited. To correct a sent invoice, cancel it and issue a new one.');

    const {
      client_id, currency, issue_date, due_date,
      service_period_start, service_period_end,
      vat_rate, vat_label, vat_note, reverse_charge,
      payment_details, notes, internal_notes,
      bank_account_id, reference,
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
      const { rows: baRows } = await client.query(
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
        unit_code: unitArray[i] || 'DAY',
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
        service_period_start = $6, service_period_end = $7,
        vat_rate = $8, vat_label = $9, vat_note = $10, reverse_charge = $11,
        subtotal = $12, vat_amount = $13, total = $14,
        payment_details = $15, notes = $16, internal_notes = $17,
        bank_account_id = $18, bank_account_snapshot = $19,
        reference = $20,
        updated_at = NOW()
      WHERE id = $21
    `, [
      client_id, JSON.stringify(clientSnapshot),
      issue_date, due_date || null, currency || 'EUR',
      service_period_start || null, service_period_end || null,
      vatRate, vat_label || 'VAT', vat_note || null, isReverseCharge,
      subtotal, vatAmount, total,
      payment_details || null, notes || null, internal_notes || null,
      baId, bankAccountSnapshot ? JSON.stringify(bankAccountSnapshot) : null,
      reference || null,
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

// POST /invoices/:id/pdf — generate or regenerate PDF
router.post('/:id/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Invoice not found');

  try {
    await generateEInvoice(rows[0].id);
    res.redirect(`/invoices/${rows[0].id}?pdf_generated=1`);
  } catch (err) {
    console.error(`Failed to generate PDF for invoice ${rows[0].number}:`, err);
    res.redirect(`/invoices/${rows[0].id}?error=pdf_failed`);
  }
});

// GET /invoices/:id/pdf — download the PDF
router.get('/:id/pdf', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM invoices WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).send('Invoice not found');
  if (!rows[0].pdf_filename) return res.status(404).send('PDF not generated yet');

  const filePath = path.join(process.cwd(), 'data', 'invoices', rows[0].pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('PDF file not found');

  res.download(filePath, `${rows[0].credits_invoice_id ? 'Credit-Note' : 'Invoice'}-${rows[0].number}.pdf`);
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
    // Auto-generate PDF before sending if not already generated
    if (!invoice.pdf_filename) {
      try {
        await generateEInvoice(invoice.id);
        // Refresh invoice to get updated pdf_filename
        const { rows: refreshed } = await pool.query(
          'SELECT pdf_filename FROM invoices WHERE id = $1', [invoice.id]
        );
        invoice.pdf_filename = refreshed[0].pdf_filename;
      } catch (pdfErr) {
        // The e-invoice PDF is a compliance artifact — abort rather than
        // silently emailing without it. "Mark as sent (no email)" remains
        // the explicit escape hatch.
        console.error(`PDF generation failed for invoice ${invoice.number}, send aborted:`, pdfErr);
        return res.redirect(`/invoices/${invoice.id}?error=pdf_failed_send`);
      }
    }

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

  // Fraction of the total settled — sign-agnostic so credit notes (negative
  // totals, refund payments) follow the same paid/partially_paid rules.
  const progress = invoiceTotal === 0 ? 1 : totalPaid / invoiceTotal;
  let newStatus;
  if (progress >= 0.999999) {
    newStatus = 'paid';
  } else if (progress > 0) {
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

  // Same sign-agnostic settling math as payment recording above
  const progress = invoiceTotal === 0 ? 1 : totalPaid / invoiceTotal;
  let newStatus = invRows[0].status;
  if (progress >= 0.999999) {
    newStatus = 'paid';
  } else if (progress > 0) {
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

// POST /invoices/:id/delete — hard delete a draft invoice
router.post('/:id/delete', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).send('Invoice not found');
  const invoice = rows[0];

  // Drafts are deletable; so are test documents at any status (they're not GoBD
  // records). Real sent/paid invoices stay immutable.
  if (invoice.status !== 'draft' && !invoice.is_test) {
    return res.status(400).send('Only draft invoices can be deleted');
  }

  // Delete PDF from disk if exists
  if (invoice.pdf_filename) {
    const filePath = path.join(process.cwd(), 'data', 'invoices', invoice.pdf_filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  // Try to decrement sequence if this was the last number. Real invoices only —
  // test docs use the throwaway TEST counter (TEST-N has no yyNNNN to parse).
  if (!invoice.is_test) {
    const yearPrefix = invoice.number.slice(0, 2);
    const num = parseInt(invoice.number.slice(2), 10);
    const fullYear = 2000 + parseInt(yearPrefix, 10);
    await decrementIfLast('INV', fullYear, num);
  }

  // Test docs stay freely deletable even when convert-linked: clear the
  // estimate's back-reference first. Real converted invoices keep the FK
  // protection (the 23503 catch below).
  if (invoice.is_test) {
    // Clear the non-cascading references TO this test invoice (convert + credit-note
    // links) so it deletes at any status. email_log rows cascade (migration 012).
    await pool.query('UPDATE estimates SET converted_invoice_id = NULL WHERE converted_invoice_id = $1', [req.params.id]);
    await pool.query('UPDATE invoices SET credits_invoice_id = NULL WHERE credits_invoice_id = $1', [req.params.id]);
  }

  // Delete invoice (lines cascade)
  try {
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  } catch (err) {
    if (err.code === '23503') {
      return res.redirect(`/invoices/${req.params.id}?error=Cannot delete this invoice because it is linked to an estimate`);
    }
    throw err;
  }

  res.redirect('/invoices');
});

module.exports = router;
