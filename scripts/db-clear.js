#!/usr/bin/env node
// scripts/db-clear.js
// Clear all Polymarket tables (for debugging/reset)

import dotenv from 'dotenv';
import pg from 'pg';
import readline from 'readline';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
  ssl: process.env.DB_SSL === 'false' ? false : {
    rejectUnauthorized: false,
  },
});

async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

async function clear() {
  console.log('\n⚠️  WARNING: This will delete ALL data from the following tables:');
  console.log('   - orderbooks');
  console.log('   - outcomes');
  console.log('   - markets');
  console.log('   - events\n');

  const shouldProceed = await confirm('Are you sure you want to continue?');
  
  if (!shouldProceed) {
    console.log('❌ Aborted.\n');
    await pool.end();
    return;
  }

  console.log('\n🗑️  Clearing tables...');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      TRUNCATE TABLE orderbooks, outcomes, markets, events
      RESTART IDENTITY CASCADE;
    `);

    await client.query('COMMIT');
    console.log('✅ Tables cleared successfully!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error clearing tables:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

clear().catch((err) => {
  console.error(err);
  process.exit(1);
});
