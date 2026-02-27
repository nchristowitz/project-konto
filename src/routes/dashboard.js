const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

router.get('/', async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // Overdue invoices
  const { rows: overdue } = await pool.query(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON i.client_id = c.id
    WHERE i.status IN ('sent', 'viewed', 'overdue')
      AND i.due_date < CURRENT_DATE
    ORDER BY i.due_date ASC
  `);

  // Recent invoices
  const { rows: recent } = await pool.query(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON i.client_id = c.id
    ORDER BY i.created_at DESC
    LIMIT 10
  `);

  // This month stats grouped by currency
  const { rows: monthRows } = await pool.query(`
    SELECT
      currency,
      COALESCE(SUM(total), 0) AS invoiced,
      COALESCE(SUM(amount_paid), 0) AS received,
      COALESCE(SUM(total - amount_paid) FILTER (WHERE status NOT IN ('cancelled', 'paid')), 0) AS pending
    FROM invoices
    WHERE EXTRACT(YEAR FROM issue_date) = $1
      AND EXTRACT(MONTH FROM issue_date) = $2
      AND status != 'cancelled'
    GROUP BY currency
    ORDER BY currency
  `, [year, month]);

  // This year stats grouped by currency
  const { rows: yearRows } = await pool.query(`
    SELECT
      currency,
      COALESCE(SUM(total), 0) AS invoiced,
      COALESCE(SUM(amount_paid), 0) AS received,
      COALESCE(SUM(total - amount_paid) FILTER (WHERE status NOT IN ('cancelled', 'paid')), 0) AS pending
    FROM invoices
    WHERE EXTRACT(YEAR FROM issue_date) = $1
      AND status != 'cancelled'
    GROUP BY currency
    ORDER BY currency
  `, [year]);

  // Accepted estimates awaiting conversion
  const { rows: acceptedEstimates } = await pool.query(`
    SELECT e.*, c.name AS client_name
    FROM estimates e JOIN clients c ON e.client_id = c.id
    WHERE e.status = 'accepted'
    ORDER BY e.accepted_at DESC
  `);

  res.render('dashboard', {
    overdue,
    recent,
    monthStats: monthRows,
    yearStats: yearRows,
    acceptedEstimates,
  });
});

module.exports = router;
