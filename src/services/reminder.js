const cron = require('node-cron');
const { pool } = require('../db');
const { sendReminderEmail } = require('./email');

function startReminderCron() {
  // Every day at 09:00 Europe/Berlin
  cron.schedule('0 9 * * *', async () => {
    console.log('[reminder] Running overdue check...');

    try {
      const { rows: settingsRows } = await pool.query(
        'SELECT * FROM settings WHERE id = 1'
      );
      const settings = settingsRows[0];
      if (!settings.reminder_enabled) {
        console.log('[reminder] Reminders disabled, skipping.');
        return;
      }

      const { rows: overdueInvoices } = await pool.query(`
        SELECT i.*
        FROM invoices i
        JOIN clients c ON i.client_id = c.id
        WHERE i.status IN ('sent', 'viewed')
          AND i.due_date < CURRENT_DATE
          AND i.reminder_count < $1
          AND (
            i.last_reminder_at IS NULL
            OR i.last_reminder_at < NOW() - INTERVAL '1 day' * $2
          )
      `, [settings.max_reminders, settings.reminder_interval_days]);

      console.log(`[reminder] Found ${overdueInvoices.length} overdue invoices.`);

      for (const invoice of overdueInvoices) {
        try {
          await sendReminderEmail(invoice);
          await pool.query(`
            UPDATE invoices SET
              reminder_count = reminder_count + 1,
              last_reminder_at = NOW(),
              status = 'overdue',
              updated_at = NOW()
            WHERE id = $1
          `, [invoice.id]);
          console.log(`[reminder] Sent reminder for invoice ${invoice.number}`);
        } catch (err) {
          console.error(`[reminder] Failed for invoice ${invoice.number}:`, err.message);
          await pool.query(
            "INSERT INTO email_log (invoice_id, type, recipient, subject, status) VALUES ($1, 'reminder', $2, $3, 'failed')",
            [invoice.id, invoice.client_snapshot?.email || '', `Reminder: Invoice ${invoice.number} is overdue`]
          );
        }
      }
    } catch (err) {
      console.error('[reminder] Cron job error:', err);
    }
  }, { timezone: 'Europe/Berlin' });

  console.log('[reminder] Cron scheduled: daily at 09:00 Europe/Berlin');
}

module.exports = { startReminderCron };
