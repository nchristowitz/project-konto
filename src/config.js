require('dotenv').config();
const bcrypt = require('bcrypt');

const required = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Accept either a pre-hashed password or a plain-text password (hashed at startup).
// Plain-text avoids the bcrypt $ escaping problem in Docker Compose env vars.
let adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
if (!adminPasswordHash) {
  if (!process.env.ADMIN_PASSWORD) {
    console.error('Missing required environment variable: ADMIN_PASSWORD_HASH or ADMIN_PASSWORD');
    process.exit(1);
  }
  adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
}

module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  dbSchema: process.env.DB_SCHEMA || 'konto',
  sessionSecret: process.env.SESSION_SECRET,
  adminUsername: process.env.ADMIN_USERNAME,
  adminPasswordHash,
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  port: parseInt(process.env.PORT, 10) || 3000,
  // SMTP (optional — falls back to Ethereal in dev)
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT, 10) || 465,
  smtpSecure: process.env.SMTP_SECURE === 'true',
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  emailFrom: process.env.EMAIL_FROM || '',
  senderName: process.env.SENDER_NAME || 'Konto',
};
