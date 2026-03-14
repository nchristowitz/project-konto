require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
const { pool } = require('../src/db');

// Parse number strings like "12,305.00" or "$12,305.00" or "€825.00" → number
function parseAmount(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[$€,]/g, '')) || 0;
}

// Parse DD.MM.YYYY or MM/DD/YYYY → YYYY-MM-DD
function parseDate(str) {
  if (!str) return null;
  // DD.MM.YYYY (European)
  const eu = str.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (eu) return `${eu[3]}-${eu[2]}-${eu[1]}`;
  // MM/DD/YYYY (US)
  const us = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  return null;
}

function parsePdfText(text) {
  const lines = text.split('\n');

  // --- Header fields (tab-separated) ---
  const field = (label) => {
    const re = new RegExp(`^${label}\\s*\\t\\s*(.+)$`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  const invoiceNumber = field('Invoice Number');
  const reference = field('Reference');
  const issueDate = parseDate(field('Date of Issue') || '');
  const dueDate = parseDate(field('Due Date') || '');

  // Currency from "Amount Due (XXX)" label
  const currencyMatch = text.match(/Amount Due \((\w{3})\)/);
  const currency = currencyMatch ? currencyMatch[1] : 'EUR';

  // Client block: lines after "Tax ID:" and before "Invoice Number"
  // May contain: person name, company name, address lines, country, VAT number
  // We keep all lines for flexible matching (person name or company name)
  const taxIdIdx = text.indexOf('Tax ID:');
  const invNumIdx = text.indexOf('Invoice Number');
  let clientName = null;
  let clientBlockLines = [];
  if (taxIdIdx !== -1 && invNumIdx !== -1) {
    const between = text.substring(taxIdIdx, invNumIdx);
    clientBlockLines = between.split('\n').slice(1) // skip the Tax ID line
      .map(l => l.trim()).filter(Boolean);
    clientName = clientBlockLines[0] || null; // first line (person or company)
  }

  // --- Notes: between "Notes" heading and "Terms" heading ---
  let notes = null;
  const notesIdx = text.indexOf('\nNotes\n');
  const termsIdx = text.indexOf('\nTerms\n');
  if (notesIdx !== -1 && termsIdx !== -1) {
    notes = text.substring(notesIdx + 7, termsIdx).trim() || null;
  } else if (notesIdx !== -1) {
    // Notes at end, no Terms section
    notes = text.substring(notesIdx + 7).trim() || null;
  }

  // --- Line items ---
  // Find the "Description  Rate  Qty  Line Total" header (tabs may have surrounding spaces)
  const headerMatch = text.match(/Description\s+Rate\s+Qty\s+Line Total/);
  const headerIdx = headerMatch ? headerMatch.index : -1;
  // Find "Subtotal" to know where line items end
  const subtotalIdx = text.indexOf('\nSubtotal\n');

  const lineItems = [];
  if (headerIdx !== -1 && subtotalIdx !== -1) {
    const itemsBlock = text.substring(
      text.indexOf('\n', headerIdx) + 1,
      subtotalIdx
    );
    const itemLines = itemsBlock.split('\n');

    // Currency symbol pattern for $ or €
    const cur = '[\\$€]?';
    // Format A: rate, qty, total on one line (separated by tabs or 2+ spaces)
    const fmtA = new RegExp(`^${cur}([\\d,]+\\.?\\d*)\\s{2,}(\\d+\\.?\\d*)\\s{2,}${cur}([\\d,]+\\.?\\d*)$`);
    // Format B: qty, total only (rate was on a prior line)
    const fmtB = new RegExp(`^(\\d+\\.?\\d*)\\s{2,}${cur}([\\d,]+\\.?\\d*)$`);
    // Standalone rate line (e.g. "€825.00" or "$115.00")
    const rateLine = new RegExp(`^${cur}([\\d,]+\\.?\\d*)$`);

    let currentItem = null;
    let pendingRate = null;
    for (const line of itemLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip "+VAT" marker lines
      if (/^\+\s*VAT$/i.test(trimmed)) continue;

      // Format A: rate, qty, total all on one line
      const matchA = trimmed.match(fmtA);
      if (matchA) {
        if (currentItem) {
          currentItem.unit_price = parseAmount(matchA[1]);
          currentItem.quantity = parseFloat(matchA[2]);
          currentItem.line_total = parseAmount(matchA[3]);
          lineItems.push(currentItem);
          currentItem = null;
          pendingRate = null;
        }
        continue;
      }

      // Format B: qty and total only (rate was a prior standalone line)
      const matchB = trimmed.match(fmtB);
      if (matchB && currentItem && pendingRate !== null) {
        currentItem.unit_price = pendingRate;
        currentItem.quantity = parseFloat(matchB[1]);
        currentItem.line_total = parseAmount(matchB[2]);
        lineItems.push(currentItem);
        currentItem = null;
        pendingRate = null;
        continue;
      }

      // Standalone rate line (e.g. "€825.00")
      const matchRate = trimmed.match(rateLine);
      if (matchRate && currentItem) {
        pendingRate = parseAmount(matchRate[1]);
        continue;
      }

      // Text line — either start new item or add detail
      if (!currentItem) {
        currentItem = {
          description: trimmed,
          detail_lines: [],
          unit_price: 0,
          quantity: 0,
          line_total: 0,
        };
        pendingRate = null;
      } else {
        currentItem.detail_lines.push(trimmed);
      }
    }
  }

  // --- Totals: after Subtotal marker ---
  // Formats vary:
  //   No VAT:  "Subtotal\nTax\n825.00\n0.00\nTotal\nAmount Paid\n825.00\n825.00"
  //   With VAT: "Subtotal\nVAT (19%)\n#DE...\n825.00\n156.75\nTotal\nAmount Paid\n981.75\n981.75"
  let subtotal = 0, tax = 0, total = 0, amountPaid = 0;
  if (subtotalIdx !== -1) {
    const totalsBlock = text.substring(subtotalIdx + 1);
    const totalsLines = totalsBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const vals = [];
    for (const tl of totalsLines) {
      // Skip known labels
      if (/^(Subtotal|Tax|VAT|Total|Amount Paid|Amount Due|Paid|--)/i.test(tl)) continue;
      if (tl.includes('\t')) continue; // skip "Amount Due (USD)\t$0.00"
      if (tl.startsWith('#')) continue; // skip VAT number lines like "#DE312544292"
      const num = parseAmount(tl);
      if (!isNaN(num)) vals.push(num);
    }
    if (vals.length >= 4) {
      [subtotal, tax, total, amountPaid] = vals;
    } else if (vals.length >= 2) {
      [subtotal, tax] = vals;
      total = subtotal + tax;
    }
  }

  // Amount due for status derivation
  const amountDueMatch = text.match(/Amount Due \(\w{3}\)\s*\t\s*[$€]?([\d,]+\.?\d*)/);
  const amountDue = amountDueMatch ? parseAmount(amountDueMatch[1]) : total - amountPaid;

  // Detect VAT rate from "VAT (19%)" label in totals
  const vatRateMatch = text.match(/VAT \((\d+)%\)/);
  const vatRate = vatRateMatch ? parseFloat(vatRateMatch[1]) : (tax > 0 ? 19 : 0);

  return {
    invoiceNumber,
    reference,
    issueDate,
    dueDate,
    currency,
    clientName,
    notes,
    lineItems: lineItems.map((item, i) => ({
      description: item.description,
      detail: item.detail_lines.length ? item.detail_lines.join(' ') : null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
      unit_code: 'HUR',
      sort_order: i,
    })),
    subtotal,
    vatRate,
    tax,
    total,
    amountPaid,
    amountDue,
    clientBlockLines,
  };
}

function deriveStatus(amountDue, dueDate) {
  if (amountDue <= 0) return 'paid';
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate && dueDate < today) return 'overdue';
  return 'sent';
}

async function importInvoices(inputDir) {
  const files = fs.readdirSync(inputDir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (!files.length) {
    console.log('No PDF files found in', inputDir);
    return;
  }

  console.log(`Found ${files.length} PDF files in ${inputDir}\n`);

  // Load all clients for name matching
  const { rows: allClients } = await pool.query(
    'SELECT id, name, contact_person, email, additional_emails, address_line1, address_line2, city, postal_code, country_code, vat_number FROM clients'
  );

  const clientsByName = new Map();
  for (const c of allClients) {
    clientsByName.set(c.name.toUpperCase(), c);
  }

  let imported = 0, skipped = 0, errors = 0;

  for (const file of files) {
    const filePath = path.join(inputDir, file);
    const buf = fs.readFileSync(filePath);
    const uint8 = new Uint8Array(buf);

    let parsed;
    try {
      const pdf = new PDFParse(uint8);
      const result = await pdf.getText();
      parsed = parsePdfText(result.text);
    } catch (err) {
      console.error(`  ✗ ${file}: PDF parse error — ${err.message}`);
      errors++;
      continue;
    }

    if (!parsed.invoiceNumber) {
      console.error(`  ✗ ${file}: Could not extract invoice number`);
      errors++;
      continue;
    }

    // Check if already imported (idempotent)
    const { rows: existing } = await pool.query(
      'SELECT id FROM invoices WHERE number = $1', [parsed.invoiceNumber]
    );
    if (existing.length) {
      console.log(`  - ${file}: #${parsed.invoiceNumber} already exists, skipping`);
      skipped++;
      continue;
    }

    // Match client: try each line from the client block against DB client names
    // and contact_person fields (Freshbooks puts person name first, company second)
    function normalize(s) {
      return s.toUpperCase().replace(/[\u2018\u2019\u201C\u201D]/g, "'").replace(/[,.]*/g, '').replace(/\b(GMBH|UG|AG|LTD|LLC|INC|CORP|HAFTUNGSBESCHR.NKT)\b/g, '').replace(/\s+/g, ' ').trim();
    }
    let clientRow = null;
    for (const blockLine of parsed.clientBlockLines) {
      const search = blockLine.toUpperCase();
      // Exact match on client name
      clientRow = clientsByName.get(search);
      if (clientRow) break;
      // Match on contact_person, partial name, or normalized name match
      const searchNorm = normalize(blockLine);
      for (const c of allClients) {
        const cName = c.name.toUpperCase();
        const cContact = (c.contact_person || '').toUpperCase();
        if (cContact === search || cName.includes(search) || search.includes(cName)) {
          clientRow = c;
          break;
        }
        // Fuzzy match: strip legal suffixes and compare
        if (searchNorm && normalize(c.name) === searchNorm) {
          clientRow = c;
          break;
        }
      }
      if (clientRow) break;
    }

    if (!clientRow) {
      console.error(`  ✗ ${file}: #${parsed.invoiceNumber} — client not found (tried: ${parsed.clientBlockLines.slice(0, 2).join(', ')})`);
      errors++;
      continue;
    }

    const status = deriveStatus(parsed.amountDue, parsed.dueDate);
    const reverseCharge = parsed.tax === 0 && clientRow.country_code !== 'DE';
    const viewToken = crypto.randomBytes(16).toString('hex');

    const clientSnapshot = {
      name: clientRow.name,
      contact_person: clientRow.contact_person,
      email: clientRow.email,
      additional_emails: clientRow.additional_emails,
      address_line1: clientRow.address_line1,
      address_line2: clientRow.address_line2,
      city: clientRow.city,
      postal_code: clientRow.postal_code,
      country_code: clientRow.country_code,
      vat_number: clientRow.vat_number,
    };

    // Determine PDF destination
    const year = parsed.issueDate ? parsed.issueDate.slice(0, 4) : new Date().getFullYear().toString();
    const pdfFilename = `${year}/${parsed.invoiceNumber}.pdf`;
    const pdfDir = path.join(process.cwd(), 'data', 'invoices', year);
    const pdfDest = path.join(pdfDir, `${parsed.invoiceNumber}.pdf`);

    // Transaction: insert invoice + lines + payment
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [inv] } = await client.query(`
        INSERT INTO invoices (
          number, client_id, client_snapshot,
          issue_date, due_date, currency,
          vat_rate, vat_label, reverse_charge,
          subtotal, vat_amount, total, amount_paid,
          status, view_token,
          notes, internal_notes, pdf_filename
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING id
      `, [
        parsed.invoiceNumber,
        clientRow.id,
        JSON.stringify(clientSnapshot),
        parsed.issueDate,
        parsed.dueDate || null,
        parsed.currency,
        reverseCharge ? 0 : parsed.vatRate,
        reverseCharge ? 'Reverse Charge' : (parsed.vatRate > 0 ? 'VAT' : 'Tax'),
        reverseCharge,
        parsed.subtotal,
        parsed.tax,
        parsed.total,
        parsed.amountPaid,
        status,
        viewToken,
        parsed.notes,
        parsed.reference ? `Ref: ${parsed.reference}` : null,
        pdfFilename,
      ]);

      const invoiceId = inv.id;

      // Insert line items
      for (const line of parsed.lineItems) {
        await client.query(`
          INSERT INTO invoice_lines (
            invoice_id, description, detail, quantity,
            unit_code, unit_price, line_total, sort_order
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          invoiceId,
          line.description,
          line.detail,
          line.quantity,
          line.unit_code,
          line.unit_price,
          line.line_total,
          line.sort_order,
        ]);
      }

      // Insert payment record if paid
      if (parsed.amountPaid > 0) {
        await client.query(`
          INSERT INTO payments (invoice_id, amount, currency, paid_at, method, reference)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          invoiceId,
          parsed.amountPaid,
          parsed.currency,
          parsed.issueDate,
          'imported',
          'Freshbooks import',
        ]);
      }

      await client.query('COMMIT');

      // Copy PDF to data/invoices/{year}/
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.copyFileSync(filePath, pdfDest);

      console.log(`  + ${file}: #${parsed.invoiceNumber} → ${clientRow.name} [${status}] (${parsed.lineItems.length} lines, ${parsed.currency} ${parsed.total})`);
      imported++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${file}: #${parsed.invoiceNumber} — DB error: ${err.message}`);
      errors++;
    } finally {
      client.release();
    }
  }

  console.log(`\nDone. ${imported} imported, ${skipped} skipped, ${errors} errors.`);
  await pool.end();
}

const inputDir = process.argv[2];
if (!inputDir) {
  console.error('Usage: node scripts/import-invoices.js <directory-of-pdfs>');
  process.exit(1);
}

const resolved = path.resolve(inputDir);
if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
  console.error(`Not a directory: ${resolved}`);
  process.exit(1);
}

importInvoices(resolved).catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
