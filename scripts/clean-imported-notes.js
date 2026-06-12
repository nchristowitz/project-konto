require('dotenv').config();
const { pool } = require('../src/db');

// One-off maintenance: imported Freshbooks invoices whose `notes` swallowed
// the rest of the document text (line-item table, totals, page markers —
// see the matching guard in import-invoices.js). Truncates at the first
// document-body line, keeping genuine notes above it. Originals are backed
// up to invoice_notes_backup before anything is changed, so the run is
// reversible and idempotent (already-clean notes are left untouched).
//
// Usage: node scripts/clean-imported-notes.js [--dry-run]

const CHROME = [
  /^Date of Issue\s/m,
  /^Due Date\s/m,
  /^Description\s+Rate\s+Qty\s+Line Total/m,
  /^Invoice Number$/m,
  /^Subtotal$/m,
  /^Amount Due \([A-Z]{3}\)/m,
  /^-- \d+ of \d+ --$/m,
];

function cutIndex(notes) {
  let idx = -1;
  for (const re of CHROME) {
    const m = notes.match(re);
    if (m && (idx === -1 || m.index < idx)) idx = m.index;
  }
  return idx;
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_notes_backup (
        invoice_id INT PRIMARY KEY,
        number TEXT,
        notes TEXT,
        backed_up_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query(
      'SELECT id, number, notes FROM invoices WHERE notes IS NOT NULL ORDER BY number'
    );

    let cleaned = 0;
    for (const r of rows) {
      const idx = cutIndex(r.notes);
      if (idx === -1) continue;

      const head = r.notes.slice(0, idx).replace(/\s+$/, '');
      const newNotes = head.length ? head : null;
      cleaned++;
      console.log(`${r.number}: ${r.notes.length} chars -> ${newNotes ? newNotes.length : 'null'}`);

      if (dryRun) continue;
      await client.query(
        `INSERT INTO invoice_notes_backup (invoice_id, number, notes)
         VALUES ($1, $2, $3) ON CONFLICT (invoice_id) DO NOTHING`,
        [r.id, r.number, r.notes]
      );
      await client.query(
        'UPDATE invoices SET notes = $1, updated_at = NOW() WHERE id = $2',
        [newNotes, r.id]
      );
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    console.log(`${dryRun ? '[dry run] would clean' : 'cleaned'} ${cleaned} invoice(s)`);
    if (!dryRun && cleaned) {
      console.log('Originals saved in invoice_notes_backup. Regenerate the PDF of any');
      console.log('affected invoice that was previously regenerated through Konto.');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
