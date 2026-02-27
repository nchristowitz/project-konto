const { pool } = require('../db');

async function getNextInvoiceNumber(prefix = 'INV') {
  const year = new Date().getFullYear();
  const yy = String(year).slice(-2);

  const result = await pool.query(`
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
