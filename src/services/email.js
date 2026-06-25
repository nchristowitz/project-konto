const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');
const { pool } = require('../db');

// Currency for client-facing emails: symbol-prefixed for the common currencies
// (€4,284.00), code-suffixed otherwise (4,284.00 SEK). en-US grouping only — no
// ICU/locale-data dependency.
const CURRENCY_SYMBOL = { EUR: '€', USD: '$', GBP: '£', JPY: '¥' };
function formatMoney(amount, currency) {
  const n = Number(amount) || 0;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '-' : '';
  return CURRENCY_SYMBOL[currency] ? `${sign}${CURRENCY_SYMBOL[currency]}${abs}` : `${sign}${abs} ${currency}`;
}

// Long date like "June 26, 2026", built from UTC parts so a 'YYYY-MM-DD' DATE
// string never shifts a day (matches the rest of the app's date handling).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatLongDate(d) {
  const dt = new Date(d);
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;

  if (config.smtpHost) {
    // Real SMTP (production)
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });
  } else {
    // Ethereal test account (local dev)
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log(`[email] Using Ethereal test account: ${testAccount.user}`);
  }

  return transporter;
}

async function sendInvoiceEmail(invoice) {
  const transport = await getTransporter();
  const clientEmail = invoice.client_snapshot?.email || invoice.client_email;
  if (!clientEmail) throw new Error('Client has no email address');

  const link = `${config.baseUrl}/i/${invoice.view_token}`;
  const isCreditNote = !!invoice.credits_invoice_id;
  const docTitle = isCreditNote ? 'Credit note' : 'Invoice';
  const sender = config.senderName || 'Konto';
  const docNoun = isCreditNote ? 'a credit note' : 'an invoice';

  // Third-person, system-style wording (like FreshBooks) — reads as if an
  // automated service sent the document on the sender's behalf.
  let opening = `${sender} sent you ${docNoun} (${invoice.number}) for ${formatMoney(invoice.total, invoice.currency)}`;
  if (!isCreditNote && invoice.due_date) opening += ` that's due on ${formatLongDate(invoice.due_date)}`;
  opening += '.';

  const mailOptions = {
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `${sender} sent you ${docNoun} (${invoice.number})`,
    text: `${opening}

View it online:
${link}`,
  };

  // Attach PDF if available
  if (invoice.pdf_filename) {
    const pdfPath = path.join(process.cwd(), 'data', 'invoices', invoice.pdf_filename);
    if (fs.existsSync(pdfPath)) {
      mailOptions.attachments = [{
        filename: `${isCreditNote ? 'Credit-Note' : 'Invoice'}-${invoice.number}.pdf`,
        path: pdfPath,
      }];
    }
  }

  const info = await transport.sendMail(mailOptions);

  // Log to email_log
  await pool.query(`
    INSERT INTO email_log (invoice_id, type, recipient, subject, status)
    VALUES ($1, 'invoice_sent', $2, $3, 'sent')
  `, [invoice.id, clientEmail, `${docTitle} ${invoice.number}`]);

  // Show Ethereal preview URL in dev
  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[email] Preview: ${previewUrl}`);
  }

  return { previewUrl };
}

async function sendReminderEmail(invoice) {
  const transport = await getTransporter();
  const clientEmail = invoice.client_snapshot?.email || invoice.client_email;
  if (!clientEmail) throw new Error('Client has no email address');

  const link = `${config.baseUrl}/i/${invoice.view_token}`;
  const sender = config.senderName || 'Konto';
  const dueClause = invoice.due_date ? `was due on ${formatLongDate(invoice.due_date)}` : 'is past due';

  const info = await transport.sendMail({
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `Reminder: invoice (${invoice.number}) from ${sender} is past due`,
    text: `This is a reminder that invoice (${invoice.number}) for ${formatMoney(invoice.total, invoice.currency)} ${dueClause}.

View it online:
${link}

If you've already paid, please disregard this reminder.`,
  });

  await pool.query(`
    INSERT INTO email_log (invoice_id, type, recipient, subject, status)
    VALUES ($1, 'reminder', $2, $3, 'sent')
  `, [invoice.id, clientEmail, `Reminder: Invoice ${invoice.number} is overdue`]);

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[email] Reminder preview: ${previewUrl}`);
  }

  return { previewUrl };
}

async function sendEstimateEmail(estimate) {
  const transport = await getTransporter();
  const clientEmail = estimate.client_snapshot?.email;
  if (!clientEmail) throw new Error('Client has no email address');

  const link = `${config.baseUrl}/e/${estimate.view_token}`;
  const sender = config.senderName || 'Konto';

  // Third-person, system-style wording to match the invoice emails.
  let opening = `${sender} sent you an estimate (${estimate.number}) for ${formatMoney(estimate.total, estimate.currency)}`;
  if (estimate.valid_until) opening += ` that's valid until ${formatLongDate(estimate.valid_until)}`;
  opening += '.';

  const mailOptions = {
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `${sender} sent you an estimate (${estimate.number})`,
    text: `${opening}

View and accept it online:
${link}`,
  };

  if (estimate.pdf_filename) {
    const pdfPath = path.join(process.cwd(), 'data', 'estimates', estimate.pdf_filename);
    if (fs.existsSync(pdfPath)) {
      mailOptions.attachments = [{
        filename: `Estimate-${estimate.number}.pdf`,
        path: pdfPath,
      }];
    }
  }

  const info = await transport.sendMail(mailOptions);

  await pool.query(`
    INSERT INTO email_log (estimate_id, type, recipient, subject, status)
    VALUES ($1, 'estimate_sent', $2, $3, 'sent')
  `, [estimate.id, clientEmail, `Estimate ${estimate.number}`]);

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[email] Estimate preview: ${previewUrl}`);
  }

  return { previewUrl };
}

async function sendEstimateAcceptedNotification(estimate) {
  const transport = await getTransporter();

  const { rows: profileRows } = await pool.query('SELECT email FROM business_profile WHERE id = 1');
  const adminEmail = profileRows[0]?.email || config.emailFrom;
  if (!adminEmail) {
    console.log('[email] No admin email configured, skipping acceptance notification');
    return {};
  }

  const clientName = estimate.client_snapshot?.name || 'Unknown client';
  const link = `${config.baseUrl}/estimates/${estimate.id}`;

  const info = await transport.sendMail({
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: adminEmail,
    subject: `Estimate ${estimate.number} accepted by ${clientName}`,
    text: `Estimate ${estimate.number} for ${estimate.currency} ${Number(estimate.total).toFixed(2)} has been accepted by ${clientName}.

Accepted at: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}

View estimate and convert to invoice: ${link}

This is an automated notification from Konto.`,
  });

  await pool.query(`
    INSERT INTO email_log (estimate_id, type, recipient, subject, status)
    VALUES ($1, 'estimate_accepted', $2, $3, 'sent')
  `, [estimate.id, adminEmail, `Estimate ${estimate.number} accepted`]);

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[email] Acceptance notification preview: ${previewUrl}`);
  }

  return { previewUrl };
}

module.exports = { sendInvoiceEmail, sendReminderEmail, sendEstimateEmail, sendEstimateAcceptedNotification };
