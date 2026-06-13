require('dotenv').config();
const { pool } = require('../src/db');

// One-time correction: the Freshbooks import had no unit column, so every
// imported line defaulted to hours. Re-set them from the per-client billing
// unit (migration 010): the hourly client stays hours, all others become
// days, and one-off items (licenses, fees) become "each". Amounts are never
// touched — only the unit label on Konto's copy; the original Freshbooks PDFs
// are unchanged. Reversible via invoice_unit_backup, idempotent, and supports
// --dry-run (rolls back without writing).
//
// Usage: node scripts/fix-billing-units.js [--dry-run]

const ITEM_DESCRIPTIONS = ['Figma license', 'Referral Fee'];
const HOURLY_CLIENT = 'METALAB DESIGN LTD.';

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Flag the hourly client. Every other client keeps the DAY default
    //    that migration 010 set, so the backfill below reads the right unit.
    const metalab = await client.query(
      `UPDATE clients SET default_unit = 'HUR', updated_at = NOW()
       WHERE name = $1 AND default_unit <> 'HUR' RETURNING id`,
      [HOURLY_CLIENT]
    );

    // 2. Snapshot current line units before changing anything.
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_unit_backup (
        line_id INT PRIMARY KEY,
        unit_code TEXT,
        backed_up_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO invoice_unit_backup (line_id, unit_code)
      SELECT id, unit_code FROM invoice_lines
      ON CONFLICT (line_id) DO NOTHING
    `);

    // 3. Backfill: item lines -> EA, all others -> the client's billing unit.
    //    IS DISTINCT FROM keeps it to rows that actually change (idempotent).
    const updated = await client.query(`
      UPDATE invoice_lines il
      SET unit_code = CASE
        WHEN il.description = ANY($1) THEN 'EA'
        ELSE c.default_unit
      END
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE il.invoice_id = i.id
        AND il.unit_code IS DISTINCT FROM (CASE
          WHEN il.description = ANY($1) THEN 'EA'
          ELSE c.default_unit
        END)
      RETURNING il.id
    `, [ITEM_DESCRIPTIONS]);

    // 4. Report the resulting distribution.
    const dist = await client.query(`
      SELECT c.name AS client, il.unit_code, count(*)::int AS lines
      FROM invoice_lines il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN clients c ON c.id = i.client_id
      GROUP BY c.name, il.unit_code
      ORDER BY c.name, il.unit_code
    `);

    console.log(`Hourly client flagged: ${metalab.rowCount} (${HOURLY_CLIENT})`);
    console.log(`Line units changed: ${updated.rowCount}`);
    console.log('Resulting per-client distribution:');
    for (const r of dist.rows) {
      console.log(`  ${r.client.padEnd(42)} ${r.unit_code.padEnd(4)} ${r.lines}`);
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    console.log(dryRun ? '\n[dry run] rolled back — nothing written.' : '\nCommitted. Originals saved in invoice_unit_backup.');
    if (!dryRun && updated.rowCount > 0) {
      console.log('Regenerate the PDF of any non-draft invoice you want re-issued with the corrected unit.');
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
