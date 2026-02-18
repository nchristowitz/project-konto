const { Router } = require('express');
const bcrypt = require('bcrypt');
const config = require('./config');

const router = Router();

// GET /login
router.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

// POST /login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (
    username === config.adminUsername &&
    await bcrypt.compare(password, config.adminPasswordHash)
  ) {
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }

  res.render('login', { error: 'Invalid credentials' });
});

// GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Middleware: require authentication
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

module.exports = { authRouter: router, requireAuth };
