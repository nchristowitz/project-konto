const { Pool } = require('pg');
const { migrate } = require('postgres-migrations');
const path = require('path');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
});

// Set search_path on each new client so all queries default to the konto schema
pool.on('connect', (client) => {
  client.query(`SET search_path TO ${config.dbSchema}, public`);
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Ensure the schema exists before migrations run, so the search_path resolves
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${config.dbSchema}`);
    await migrate({ client }, path.join(__dirname, '..', 'migrations'), {
      logger: (msg) => console.log(`[migration] ${msg}`),
    });
    console.log('Migrations complete');
  } finally {
    client.release();
  }
}

module.exports = { pool, runMigrations };
