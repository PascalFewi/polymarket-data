// src/lib/db-operations.js
// Database operations for events, markets, and outcomes
// Uses TRUE BULK INSERTS to prevent database overload

import { getPool, getClient, query } from './db.js';
import { getOutcomesForMarket } from './gamma-api.js';

// Batch size for database operations
const BATCH_SIZE = 100;

/**
 * Build a bulk INSERT query with multiple value rows
 * This is the key optimization: instead of N separate INSERT statements,
 * we build ONE INSERT with N value rows, reducing round-trips by ~100x
 * 
 * @param {string} baseQuery - Query up to VALUES (e.g., "INSERT INTO table (a, b) VALUES")
 * @param {number} columnsPerRow - Number of columns per row
 * @param {Array<Array>} rows - Array of value arrays
 * @returns {{text: string, values: Array}}
 */
function buildBulkInsert(baseQuery, columnsPerRow, rows) {
  const values = [];
  const valueClauses = [];
  let paramIndex = 1;

  for (const row of rows) {
    const placeholders = [];
    for (let i = 0; i < columnsPerRow; i++) {
      placeholders.push(`$${paramIndex++}`);
    }
    valueClauses.push(`(${placeholders.join(', ')})`);
    values.push(...row);
  }

  return {
    text: `${baseQuery} ${valueClauses.join(', ')}`,
    values,
  };
}

/**
 * Process items in batches with true bulk inserts
 * @param {Array} items - Items to process
 * @param {number} batchSize - Number of items per batch
 * @param {Function} queryBuilder - Function that builds bulk query from batch
 */
async function processBulkBatches(items, batchSize, queryBuilder) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const { text, values } = queryBuilder(batch);
    await query(text, values);
  }
}

/**
 * Upsert events into the database (true bulk insert)
 * @param {Array} events - Array of event objects from Gamma API
 */
export async function upsertEvents(events) {
  if (!events.length) return;

  const baseQuery = `
    INSERT INTO events (
      id, title, slug, description, categories,
      created_at, start_date, end_date,
      active, closed, archived,
      volume, liquidity, open_interest, comment_count
    ) VALUES`;

  // Only update if something actually changed (reduces write amplification)
  // PostgreSQL will skip the update if the WHERE clause is false
  const conflictClause = `
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      slug = EXCLUDED.slug,
      description = EXCLUDED.description,
      categories = EXCLUDED.categories,
      created_at = EXCLUDED.created_at,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      active = EXCLUDED.active,
      closed = EXCLUDED.closed,
      archived = EXCLUDED.archived,
      volume = EXCLUDED.volume,
      liquidity = EXCLUDED.liquidity,
      open_interest = EXCLUDED.open_interest,
      comment_count = EXCLUDED.comment_count
    WHERE events.active IS DISTINCT FROM EXCLUDED.active
       OR events.closed IS DISTINCT FROM EXCLUDED.closed
       OR events.archived IS DISTINCT FROM EXCLUDED.archived
       OR events.volume IS DISTINCT FROM EXCLUDED.volume
       OR events.liquidity IS DISTINCT FROM EXCLUDED.liquidity
       OR events.open_interest IS DISTINCT FROM EXCLUDED.open_interest`;

  const buildQuery = (batch) => {
    const rows = batch.map((e) => {
      let categories = null;
      if (Array.isArray(e.tags) && e.tags.length > 0) {
        categories = e.tags.map((tag) => tag.slug).join('-');
      }
      const start = e.startTime ?? e.startDate ?? null;
      const end = e.endDate ?? null;
      const created = e.createdAt ?? null;

      return [
        String(e.id),
        e.title ?? null,
        e.slug ?? null,
        e.description ?? null,
        categories,
        created ? new Date(created) : null,
        start ? new Date(start) : null,
        end ? new Date(end) : null,
        e.active ?? null,
        e.closed ?? null,
        e.archived ?? null,
        e.volume ?? null,
        e.liquidity ?? e.liquidityClob ?? null,
        e.openInterest ?? e.open_interest ?? null,
        e.commentCount ?? e.comment_count ?? null,
      ];
    });

    const bulk = buildBulkInsert(baseQuery, 15, rows);
    return { text: bulk.text + conflictClause, values: bulk.values };
  };

  await processBulkBatches(events, BATCH_SIZE, buildQuery);
}

/**
 * Upsert markets into the database (true bulk insert)
 * @param {Array} markets - Array of market objects
 */
export async function upsertMarkets(markets) {
  if (!markets.length) return;

  const baseQuery = `
    INSERT INTO markets (
      id, event_id, question, slug, description,
      created_at, start_date, end_date, deploying_timestamp,
      active, closed, archived, ready, funded, accepting_orders, neg_risk,
      volume_24h, volume_total, liquidity,
      order_min_size, order_price_min_tick_size
    ) VALUES`;

  // Only update if something actually changed (reduces write amplification)
  const conflictClause = `
    ON CONFLICT (id) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      question = EXCLUDED.question,
      slug = EXCLUDED.slug,
      description = EXCLUDED.description,
      created_at = EXCLUDED.created_at,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      deploying_timestamp = EXCLUDED.deploying_timestamp,
      active = EXCLUDED.active,
      closed = EXCLUDED.closed,
      archived = EXCLUDED.archived,
      ready = EXCLUDED.ready,
      funded = EXCLUDED.funded,
      accepting_orders = EXCLUDED.accepting_orders,
      neg_risk = EXCLUDED.neg_risk,
      volume_24h = EXCLUDED.volume_24h,
      volume_total = EXCLUDED.volume_total,
      liquidity = EXCLUDED.liquidity,
      order_min_size = EXCLUDED.order_min_size,
      order_price_min_tick_size = EXCLUDED.order_price_min_tick_size
    WHERE markets.active IS DISTINCT FROM EXCLUDED.active
       OR markets.closed IS DISTINCT FROM EXCLUDED.closed
       OR markets.archived IS DISTINCT FROM EXCLUDED.archived
       OR markets.volume_24h IS DISTINCT FROM EXCLUDED.volume_24h
       OR markets.volume_total IS DISTINCT FROM EXCLUDED.volume_total
       OR markets.liquidity IS DISTINCT FROM EXCLUDED.liquidity`;

  const buildQuery = (batch) => {
    const rows = batch.map((m) => {
      const created = m.createdAt ? new Date(m.createdAt) : null;
      const start = m.startDate ? new Date(m.startDate) : null;
      const end = m.endDate ? new Date(m.endDate) : null;
      const deployingTs = m.deployingTimestamp ? new Date(m.deployingTimestamp) : null;
      const vol24 = m.volume24hr ?? m.volume24hrClob ?? m.volumeNum ?? Number(m.volume ?? 0) ?? 0;
      const volTotal = Number(m.volume ?? 0) || null;

      return [
        String(m.id),
        m.event_id ? String(m.event_id) : null,
        m.question ?? m.title ?? m.slug ?? null,
        m.slug ?? null,
        m.description ?? null,
        created,
        start,
        end,
        deployingTs,
        m.active ?? null,
        m.closed ?? null,
        m.archived ?? null,
        m.ready ?? null,
        m.funded ?? null,
        m.acceptingOrders ?? null,
        m.negRisk ?? null,
        vol24,
        volTotal,
        m.liquidity ?? m.liquidityNum ?? null,
        m.orderMinSize ?? null,
        m.orderPriceMinTickSize ?? null,
      ];
    });

    const bulk = buildBulkInsert(baseQuery, 21, rows);
    return { text: bulk.text + conflictClause, values: bulk.values };
  };

  await processBulkBatches(markets, BATCH_SIZE, buildQuery);
}

/**
 * Upsert outcomes for markets into the database (true bulk insert)
 * @param {Array} markets - Array of market objects
 */
export async function upsertOutcomes(markets) {
  if (!markets.length) return;

  // Collect all outcomes first
  const allOutcomes = [];
  for (const m of markets) {
    const marketId = String(m.id);
    const outcomes = getOutcomesForMarket(m);
    for (const o of outcomes) {
      allOutcomes.push([marketId, o.index, o.outcome, o.tokenId]);
    }
  }

  if (!allOutcomes.length) return;

  const baseQuery = `
    INSERT INTO outcomes (market_id, outcome_index, outcome, token_id)
    VALUES`;

  // Only update if something actually changed
  const conflictClause = `
    ON CONFLICT (market_id, outcome_index) DO UPDATE SET
      outcome = EXCLUDED.outcome,
      token_id = EXCLUDED.token_id
    WHERE outcomes.outcome IS DISTINCT FROM EXCLUDED.outcome
       OR outcomes.token_id IS DISTINCT FROM EXCLUDED.token_id`;

  const buildQuery = (batch) => {
    const bulk = buildBulkInsert(baseQuery, 4, batch);
    return { text: bulk.text + conflictClause, values: bulk.values };
  };

  await processBulkBatches(allOutcomes, BATCH_SIZE * 2, buildQuery);
}

/**
 * Get all active market IDs from the database
 * @returns {Promise<Set<string>>} Set of active market IDs
 */
export async function getActiveMarketIds() {
  const result = await query(`
    SELECT id FROM markets 
    WHERE active = true AND closed = false AND archived = false
  `);
  return new Set(result.rows.map(r => r.id));
}

/**
 * Get all token IDs for active markets from the database
 * @returns {Promise<Map<string, {marketId: string, outcomeIndex: number, outcome: string}>>}
 */
export async function getActiveOutcomeTokens() {
  const result = await query(`
    SELECT o.token_id, o.market_id, o.outcome_index, o.outcome
    FROM outcomes o
    JOIN markets m ON o.market_id = m.id
    WHERE m.active = true 
      AND m.closed = false 
      AND m.archived = false
      AND o.token_id IS NOT NULL
  `);
  
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.token_id, {
      marketId: row.market_id,
      outcomeIndex: row.outcome_index,
      outcome: row.outcome,
    });
  }
  return map;
}

/**
 * Insert orderbook snapshots in BULK
 * This is the critical function for the orderbook collector.
 * Instead of inserting one snapshot at a time (which caused DB overload),
 * this function inserts multiple snapshots in a single query.
 * 
 * @param {Array<Object>} snapshots - Array of snapshot objects
 */
export async function insertOrderbookSnapshotBatch(snapshots) {
  if (!snapshots.length) return;

  const baseQuery = `
    INSERT INTO orderbooks (ts, asset_id, market_id, outcome_index, bids, asks, script_id)
    VALUES`;

  const rows = snapshots.map((s) => [
    s.timestamp,
    String(s.assetId),
    s.marketId,
    s.outcomeIndex,
    JSON.stringify(s.bids),
    JSON.stringify(s.asks),
    s.scriptId,
  ]);

  const bulk = buildBulkInsert(baseQuery, 7, rows);
  
  const text = bulk.text.replace(
    /\((\$\d+), (\$\d+), (\$\d+), (\$\d+), (\$\d+), (\$\d+), (\$\d+)\)/g,
    '($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)'
  ) /*+ `
    ON CONFLICT (ts, asset_id) DO UPDATE SET
      market_id = EXCLUDED.market_id,
      outcome_index = EXCLUDED.outcome_index,
      bids = EXCLUDED.bids,
      asks = EXCLUDED.asks,
      script_id = EXCLUDED.script_id`;;*/

  await query(text, bulk.values);
}

/**
 * Insert a single orderbook snapshot
 * Kept for backwards compatibility, but prefer insertOrderbookSnapshotBatch
 * 
 * @param {Object} params - Snapshot parameters
 */
export async function insertOrderbookSnapshot(params) {
  await insertOrderbookSnapshotBatch([params]);
}

export default {
  upsertEvents,
  upsertMarkets,
  upsertOutcomes,
  getActiveMarketIds,
  getActiveOutcomeTokens,
  insertOrderbookSnapshot,
  insertOrderbookSnapshotBatch,
};
