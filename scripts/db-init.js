#!/usr/bin/env node
// scripts/db-init.js
// Initialize PostgreSQL schema for Polymarket data

import dotenv from 'dotenv';
import pg from 'pg';

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

async function init() {
  console.log('🚀 Initializing database schema...\n');

  const client = await pool.connect();
  let hasTimescale = false;
  // Ensure TimescaleDB extension if available (non-fatal if missing)
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
    console.log('✅ TimescaleDB extension enabled');
    hasTimescale = true;
  } catch (e) {
    console.log('ℹ️  TimescaleDB extension not available (continuing without it)');
  }

  try {
    await client.query('BEGIN');

    // EVENTS table
    console.log('📦 Creating events table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id              TEXT PRIMARY KEY,
        title           TEXT,
        slug            TEXT,
        description     TEXT,
        categories      TEXT,
        created_at      TIMESTAMPTZ,
        start_date      TIMESTAMPTZ,
        end_date        TIMESTAMPTZ,
        active          BOOLEAN,
        closed          BOOLEAN,
        archived        BOOLEAN,
        volume          NUMERIC,
        liquidity       NUMERIC,
        open_interest   NUMERIC,
        comment_count   INT
      );
    `);

    // MARKETS table
    console.log('📦 Creating markets table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS markets (
        id                        TEXT PRIMARY KEY,
        event_id                  TEXT REFERENCES events(id) ON DELETE CASCADE,
        question                  TEXT,
        slug                      TEXT,
        description               TEXT,
        created_at                TIMESTAMPTZ,
        start_date                TIMESTAMPTZ,
        end_date                  TIMESTAMPTZ,
        deploying_timestamp       TIMESTAMPTZ,
        active                    BOOLEAN,
        closed                    BOOLEAN,
        archived                  BOOLEAN,
        ready                     BOOLEAN,
        funded                    BOOLEAN,
        accepting_orders          BOOLEAN,
        neg_risk                  BOOLEAN,
        volume_24h                NUMERIC,
        volume_total              NUMERIC,
        liquidity                 NUMERIC,
        order_min_size            NUMERIC,
        order_price_min_tick_size NUMERIC
      );
    `);

    // OUTCOMES table
    console.log('📦 Creating outcomes table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS outcomes (
        id            BIGSERIAL PRIMARY KEY,
        market_id     TEXT REFERENCES markets(id) ON DELETE CASCADE,
        outcome_index INT NOT NULL,
        outcome       TEXT,
        token_id      TEXT,
        UNIQUE (market_id, outcome_index)
      );
    `);

    // ORDERBOOKS table
    console.log('📦 Creating orderbooks table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS orderbooks (
        ts            BIGINT NOT NULL,
        asset_id      TEXT NOT NULL,
        market_id     TEXT,
        outcome_index INT,
        bids          JSONB,
        asks          JSONB,
        script_id     SMALLINT
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Base tables created');
/*
   if (hasTimescale) {
      // Create hypertable
      try {
        await client.query(`
          SELECT create_hypertable(
            'orderbooks', 
            'ts',
            chunk_time_interval => 86400000,
            if_not_exists => TRUE
          );
        `);
        console.log('✅ Hypertable created');
      } catch (e) {
        if (e.message.includes('already a hypertable')) {
          console.log('ℹ️  Already a hypertable');
        } else {
          throw e;
        }
      }

      // Compression settings
      try {
        await client.query(`
          ALTER TABLE orderbooks SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'asset_id',
            timescaledb.compress_orderby = 'ts DESC'
          );
        `);

        await client.query(`
          SELECT add_compression_policy('orderbooks', BIGINT '604800000', if_not_exists => true);
        `);
        console.log('✅ Compression configured (7 days)');
      } catch (e) {
        if (e.message.includes('already')) {
          console.log('ℹ️  Compression already configured');
        } else {
          throw e;
        }
      }
    }

*/
    // === Indexes (after hypertable, so they're chunk-aware) ===
    console.log('📦 Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orderbooks_asset_ts
        ON orderbooks (asset_id, ts DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orderbooks_market_ts
        ON orderbooks (market_id, ts DESC);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_orderbooks_script_id
        ON orderbooks (script_id);
    `);

    console.log('\n✅ Database schema initialized successfully!\n');

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Error initializing database:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch((err) => {
  console.error(err);
  process.exit(1);
});