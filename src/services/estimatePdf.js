const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const { generateInvoicePdf } = require('./pdf');
const { formatPaymentDetails } = require('./bankAccount');

async function generateEstimatePdf(estimateId) {
  const { rows: estimateRows } = await pool.query(
    'SELECT * FROM estimates WHERE id = $1', [estimateId]
  );
  if (!estimateRows.length) throw new Error('Estimate not found');
  const estimate = estimateRows[0];

  const { rows: lineRows } = await pool.query(
    'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order', [estimateId]
  );

  const { rows: profileRows } = await pool.query(
    'SELECT * FROM business_profile WHERE id = 1'
  );
  const profile = profileRows[0] || {};
  const client = estimate.client_snapshot || {};

  // Map valid_until to due_date so the PDF renderer picks it up
  const invoiceForPdf = {
    ...estimate,
    due_date: estimate.valid_until,
    amount_paid: 0,
    payment_details: formatPaymentDetails(estimate.bank_account_snapshot) || null,
  };

  const pdfBytes = await generateInvoicePdf({
    invoice: invoiceForPdf,
    lines: lineRows,
    profile,
    client,
    documentTitle: 'ESTIMATE',
    dueDateLabel: 'Valid until:',
  });

  // Write to data/estimates/{year}/{number}.pdf
  const year = new Date(estimate.issue_date).getFullYear().toString();
  const safeNumber = estimate.number.replace(/[^a-zA-Z0-9\-]/g, '');
  const filename = `${year}/${safeNumber}.pdf`;
  const dir = path.join(process.cwd(), 'data', 'estimates', year);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `${safeNumber}.pdf`);
  fs.writeFileSync(filePath, Buffer.from(pdfBytes));

  await pool.query(
    'UPDATE estimates SET pdf_filename = $1, updated_at = NOW() WHERE id = $2',
    [filename, estimateId]
  );

  return { filename, path: filePath };
}

module.exports = { generateEstimatePdf };
