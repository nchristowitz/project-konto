const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');
const { pool } = require('../db');

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

  const contactName = invoice.client_snapshot?.contact_person || invoice.client_snapshot?.name || 'there';
  const link = `${config.baseUrl}/i/${invoice.view_token}`;

  const mailOptions = {
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `Invoice ${invoice.number} from ${config.senderName || 'Konto'}`,
    text: `Hi ${contactName},

Please find invoice ${invoice.number} for ${invoice.currency} ${Number(invoice.total).toFixed(2)}.

View online: ${link}
${invoice.due_date ? `Due date: ${new Date(invoice.due_date).toISOString().slice(0, 10)}` : ''}

Best regards,
${config.senderName || 'Konto'}`,
  };

  // Attach PDF if available
  if (invoice.pdf_filename) {
    const pdfPath = path.join(process.cwd(), 'data', 'invoices', invoice.pdf_filename);
    if (fs.existsSync(pdfPath)) {
      mailOptions.attachments = [{
        filename: `Invoice-${invoice.number}.pdf`,
        path: pdfPath,
      }];
    }
  }

  const info = await transport.sendMail(mailOptions);

  // Log to email_log
  await pool.query(`
    INSERT INTO email_log (invoice_id, type, recipient, subject, status)
    VALUES ($1, 'invoice_sent', $2, $3, 'sent')
  `, [invoice.id, clientEmail, `Invoice ${invoice.number}`]);

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

  const contactName = invoice.client_snapshot?.contact_person || invoice.client_snapshot?.name || 'there';
  const link = `${config.baseUrl}/i/${invoice.view_token}`;

  const info = await transport.sendMail({
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `Reminder: Invoice ${invoice.number} is overdue`,
    text: `Hi ${contactName},

This is a friendly reminder that invoice ${invoice.number} for ${invoice.currency} ${Number(invoice.total).toFixed(2)} was due on ${invoice.due_date ? new Date(invoice.due_date).toISOString().slice(0, 10) : 'receipt'}.

View online: ${link}

If you've already made payment, please disregard this message.

Best regards,
${config.senderName || 'Konto'}`,
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

  const contactName = estimate.client_snapshot?.contact_person || estimate.client_snapshot?.name || 'there';
  const link = `${config.baseUrl}/e/${estimate.view_token}`;

  const mailOptions = {
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `Estimate ${estimate.number} from ${config.senderName || 'Konto'}`,
    text: `Hi ${contactName},

Please find estimate ${estimate.number} for ${estimate.currency} ${Number(estimate.total).toFixed(2)}.

View and accept online: ${link}
${estimate.valid_until ? `Valid until: ${new Date(estimate.valid_until).toISOString().slice(0, 10)}` : ''}

Best regards,
${config.senderName || 'Konto'}`,
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
