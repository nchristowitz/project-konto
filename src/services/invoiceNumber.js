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

  const result = await executor.query(`
    INSERT INTO invoice_sequences (prefix, year, next_number)
    VALUES ($1, $2, 1)
    ON CONFLICT (prefix, year)
    DO UPDATE SET next_number = invoice_sequences.next_number + 1
    RETURNING next_number - 1 AS current_number
  `, [prefix, year]);

  const num = result.rows[0].current_number || 1;
  return `${yy}${String(num).padStart(3, '0')}`;
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
