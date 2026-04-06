const { Router } = require('express');
const { pool } = require('../db');
const { convertToEUR } = require('../services/exchangeRate');

const router = Router();

router.get('/', async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();

  // Earned YTD (amount received this year) by currency
  // Use total for fully paid invoices, amount_paid for partial payments
  const { rows: earnedRows } = await pool.query(`
    SELECT currency,
           COALESCE(SUM(CASE WHEN status = 'paid' THEN total ELSE amount_paid END), 0) AS amount
    FROM invoices
    WHERE EXTRACT(YEAR FROM issue_date) = $1
      AND status != 'cancelled'
      AND (status = 'paid' OR amount_paid > 0)
    GROUP BY currency
    ORDER BY currency
  `, [year]);

  // Outstanding: pending vs overdue, by currency
  const { rows: pendingRows } = await pool.query(`
    SELECT currency,
           COALESCE(SUM(total - amount_paid), 0) AS amount
    FROM invoices
    WHERE status NOT IN ('cancelled', 'paid', 'draft')
      AND (due_date >= CURRENT_DATE OR due_date IS NULL)
    GROUP BY currency
    ORDER BY currency
  `);

  const { rows: overdueRows } = await pool.query(`
    SELECT currency,
           COALESCE(SUM(total - amount_paid), 0) AS amount
    FROM invoices
    WHERE status NOT IN ('cancelled', 'paid', 'draft')
      AND due_date < CURRENT_DATE
    GROUP BY currency
    ORDER BY currency
  `);

  // Combine for total outstanding
  const outstandingMap = {};
  for (const r of pendingRows) {
    outstandingMap[r.currency] = (outstandingMap[r.currency] || 0) + Number(r.amount);
  }
  for (const r of overdueRows) {
    outstandingMap[r.currency] = (outstandingMap[r.currency] || 0) + Number(r.amount);
  }
  const outstandingRows = Object.entries(outstandingMap).map(([currency, amount]) => ({ currency, amount }));

  // Convert to EUR
  let earnedEUR = 0, outstandingEUR = 0, pendingEUR = 0, overdueEUR = 0, rateDate = null;
  try {
    const earnedResult = await convertToEUR(earnedRows);
    earnedEUR = earnedResult.totalEUR;
    rateDate = earnedResult.date;

    const outstandingResult = await convertToEUR(outstandingRows);
    outstandingEUR = outstandingResult.totalEUR;

    const pendingResult = await convertToEUR(pendingRows);
    pendingEUR = pendingResult.totalEUR;

    const overdueResult = await convertToEUR(overdueRows);
    overdueEUR = overdueResult.totalEUR;
  } catch (e) {
    // Exchange rate fetch failed — EUR amounts stay 0
  }

  // Year progress
  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year + 1, 0, 1);
  const yearProgress = Math.round((now - startOfYear) / (endOfYear - startOfYear) * 100);

  // Status counts for invoice tabs
  const { rows: statusCounts } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'draft')) AS total,
      COUNT(*) FILTER (WHERE status IN ('sent', 'viewed', 'partially_paid') AND (due_date >= CURRENT_DATE OR due_date IS NULL)) AS pending,
      COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'paid', 'draft') AND due_date < CURRENT_DATE) AS overdue,
      COUNT(*) FILTER (WHERE status = 'paid') AS paid
    FROM invoices
  `);
  const counts = statusCounts[0];

  // Recent invoices (all non-draft, non-cancelled, limit 20)
  const { rows: invoices } = await pool.query(`
    SELECT i.*, c.name AS client_name
    FROM invoices i JOIN clients c ON i.client_id = c.id
    WHERE i.status NOT IN ('cancelled', 'draft')
    ORDER BY i.issue_date DESC
    LIMIT 20
  `);

  // Revenue target for current year
  const { rows: settingsRows } = await pool.query('SELECT revenue_targets FROM settings WHERE id = 1');
  const revenueTargets = settingsRows[0]?.revenue_targets || {};
  const yearTarget = revenueTargets[year] || 0;
  const earnedProgress = yearTarget > 0 ? Math.min(Math.round(earnedEUR / yearTarget * 100), 100) : 0;

  // Accepted estimates awaiting conversion
  const { rows: acceptedEstimates } = await pool.query(`
    SELECT e.*, c.name AS client_name
    FROM estimates e JOIN clients c ON e.client_id = c.id
    WHERE e.status = 'accepted'
    ORDER BY e.accepted_at DESC
  `);

  res.render('dashboard', {
    invoices,
    acceptedEstimates,
    earnedEUR,
    earnedRows,
    outstandingEUR,
    pendingEUR,
    overdueEUR,
    pendingRows,
    overdueRows,
    rateDate,
    yearProgress,
    yearTarget,
    earnedProgress,
    counts,
  });
});

module.exports = router;
