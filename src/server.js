const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const path = require('path');
const config = require('./config');
const { pool, runMigrations } = require('./db');
const { authRouter, requireAuth } = require('./auth');
const dashboardRouter = require('./routes/dashboard');
const settingsRouter = require('./routes/settings');
const clientsRouter = require('./routes/clients');
const invoicesRouter = require('./routes/invoices');
const estimatesRouter = require('./routes/estimates');
const publicRouter = require('./routes/public');
const { startReminderCron } = require('./services/reminder');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Sessions
app.use(session({
  store: new PgStore({
    pool,
    schemaName: config.dbSchema,
    tableName: 'sessions',
    createTableIfMissing: true,
  }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: config.baseUrl.startsWith('https'),
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

// Make session state available to all templates
app.use((req, res, next) => {
  res.locals.authenticated = req.session && req.session.authenticated;
  // Format number with thousands separator for display (e.g. 12305 → "12,305.00")
  res.locals.fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  next();
});

// Public routes (no auth)
app.use('/', publicRouter);

// Auth routes
app.use('/', authRouter);
app.use('/dashboard', requireAuth, dashboardRouter);
app.use('/settings', requireAuth, settingsRouter);
app.use('/clients', requireAuth, clientsRouter);
app.use('/invoices', requireAuth, invoicesRouter);
app.use('/estimates', requireAuth, estimatesRouter);

// Root redirect
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

// Start
async function start() {
  await runMigrations();
  startReminderCron();
  app.listen(config.port, () => {
    console.log(`Konto running at ${config.baseUrl}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
