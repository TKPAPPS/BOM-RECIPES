const { Pool } = require('pg');

/**
 * Connection config — two supported forms, in priority order:
 *
 *  1. DATABASE_URL  — a single connection string, the format Neon /
 *     Render / Railway hand you (e.g.
 *     postgresql://user:pass@host/db?sslmode=require). Preferred on
 *     hosted platforms: paste one value and you're done.
 *
 *  2. Discrete DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD —
 *     the original local form, kept for backward compatibility.
 *
 * Either way the DB credentials live ONLY here, server-side. They are
 * read from process.env and never shipped to the browser.
 */
const connectionConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool({
  ...connectionConfig,
  // Neon (and most cloud Postgres) require TLS. rejectUnauthorized:false
  // accepts their managed certs without bundling a CA file.
  ssl: { rejectUnauthorized: false },
  // Resilience against a remote DB that drops idle connections (cloud
  // Postgres often suspends / caps connections).  Close our own idle
  // clients before the server does, keep TCP alive, and bound the pool.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

module.exports = pool;
