// src/lib/db.js
// Shared database pool and connection utilities

import pg from 'pg';

const { Pool } = pg;

let pool = null;

/**
 * Get or create the database connection pool
 */
export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: parseInt(process.env.DB_POOL_SIZE || '20', 10),
      idleTimeoutMillis: 30000,
      ssl: process.env.DB_SSL === 'false' ? false : {
        rejectUnauthorized: false,
      },
    });

    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err.message);
    });
  }

  return pool;
}

/**
 * Close the database pool
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Execute a query with automatic connection handling
 */
export async function query(text, params) {
  const dbPool = getPool();
  return dbPool.query(text, params);
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient() {
  const dbPool = getPool();
  return dbPool.connect();
}

export default {
  getPool,
  closePool,
  query,
  getClient,
};
