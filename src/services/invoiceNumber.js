const { pool } = require('../db');

/**
 * Allocate the next invoice/estimate number for a given prefix and issue date.
 *
 * @param {string} prefix        'INV' or 'EST'
 * @param {string|Date} issueDate  The invoice's issue_date — used to pick
 *                                 the sequence year. We derive the year from
 *                                 issue_date rather than wall clock so that
 *                                 backdated invoices land in the right year.
 * @param {import('pg').PoolClient} [executor]
 *                                 Pass the transaction client so the sequence
 *                                 increment rolls back if the surrounding
 *                                 INSERT fails. Falls back to the pool when
 *                                 omitted (e.g. standalone scripts).
 */
async function getNextInvoiceNumber(prefix = 'INV', issueDate, executor = pool) {
  if (!issueDate) throw new Error('getNextInvoiceNumber: issueDate is required');
  const year = new Date(issueDate).getFullYear();
  if (!Number.isFinite(year)) throw new Error(`getNextInvoiceNumber: invalid issueDate ${issueDate}`);
  const yy = String(year).slice(-2);

  // Sequence semantics: next_number = "the number to assign on the NEXT call".
  // So we seed a new row at 2 (we're claiming 1 right now) and on conflict
  // bump by 1 before returning old. `next_number - 1` in RETURNING gives the
  // value just claimed in both paths. (Postgres' RETURNING in an upsert
  // returns post-update values, so new=old+1 → new-1=old on conflict, and
  // seeded 2 → 2-1=1 on insert.) Previously seeded at 1 which caused a
  // collision: first call gave 1, row stayed at 1, second call tried 1 again.
  const result = await executor.query(`
    INSERT INTO invoice_sequences (prefix, year, next_number)
    VALUES ($1, $2, 2)
    ON CONFLICT (prefix, year)
    DO UPDATE SET next_number = invoice_sequences.next_number + 1
    RETURNING next_number - 1 AS current_number
  `, [prefix, year]);

  const num = result.rows[0].current_number || 1;
  // 4-digit counter to match the Freshbooks convention used on all imported
  // history from 2024 onwards (e.g. 260001, 260002 ...). Gives us 9999/year.
  return `${yy}${String(num).padStart(4, '0')}`;
}

async function decrementIfLast(prefix, year, number) {
  const { rows } = await pool.query(
    'SELECT next_number FROM invoice_sequences WHERE prefix = $1 AND year = $2',
    [prefix, year]
  );
  if (rows.length && rows[0].next_number - 1 === number) {
    await pool.query(
      'UPDATE invoice_sequences SET next_number = next_number - 1 WHERE prefix = $1 AND year = $2',
      [prefix, year]
    );
  }
}

module.exports = { getNextInvoiceNumber, decrementIfLast };
