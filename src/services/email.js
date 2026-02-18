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

  const info = await transport.sendMail({
    from: config.emailFrom || '"Konto" <noreply@localhost>',
    to: clientEmail,
    subject: `Invoice ${invoice.number} from ${config.senderName || 'Konto'}`,
    text: `Hi ${contactName},

Please find invoice ${invoice.number} for ${invoice.currency} ${Number(invoice.total).toFixed(2)}.

View online: ${link}
${invoice.due_date ? `Due date: ${new Date(invoice.due_date).toISOString().slice(0, 10)}` : ''}

Best regards,
${config.senderName || 'Konto'}`,
  });

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

module.exports = { sendInvoiceEmail, sendReminderEmail };
