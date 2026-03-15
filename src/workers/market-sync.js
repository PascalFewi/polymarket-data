#!/usr/bin/env node
// src/workers/market-sync.js
// Worker 1: Market Sync Worker
// 
// Responsibilities:
// - Periodically fetches active and recently closed events from Gamma API
// - Processes events in STREAMING fashion to prevent memory exhaustion
// - Upserts events, markets, and outcomes to the database
// - The orderbook worker reads active tokens directly from the database
//
// OPTIMIZATIONS:
// - Sync lock prevents overlapping syncs from competing for DB resources
// - Single transaction per batch reduces commit overhead
// - Eliminated redundant extractMarketsFromEvents calls
//
// This worker does NOT handle WebSocket connections or orderbook data.

import dotenv from 'dotenv';

dotenv.config();

import { closePool, getClient } from '../lib/db.js';
import {
  streamActiveEvents,
  streamClosedEvents,
  extractMarketsFromEvents,
  filterMarkets,
  getOutcomesForMarket,
} from '../lib/gamma-api.js';
import {
  upsertEvents,
  upsertMarkets,
  upsertOutcomes,
} from '../lib/db-operations.js';
import { createLogger, formatDuration } from '../utils/helpers.js';

const log = createLogger('MarketSync');

// Configuration
const CONFIG = {
  // How often to poll for active markets (ms)
  activePollInterval: parseInt(process.env.ACTIVE_POLL_INTERVAL || '60000', 10),
  // How often to poll for closed markets (ms)
  closedPollInterval: parseInt(process.env.CLOSED_POLL_INTERVAL || '300000', 10),
  // Minimum 24h volume to include a market (for token counting only)
  min24hVolume: parseFloat(process.env.MIN_24H_VOLUME || '0'),
  // Maximum 24h volume to include a market
  max24hVolume: parseFloat(process.env.MAX_24H_VOLUME || 'Infinity'),
  // How many days back to fetch closed events
  closedEventsDaysBack: parseInt(process.env.CLOSED_EVENTS_DAYS_BACK || '7', 10),
};

// Stats tracking
const stats = {
  startTime: Date.now(),
  syncCount: 0,
  lastSyncTime: null,
  lastSyncDuration: null,
  eventsCount: 0,
  marketsCount: 0,
  activeMarketsCount: 0,
  tokensCount: 0,
  errors: 0,
  skippedSyncs: 0,
};

// Sync lock to prevent overlapping syncs
let isSyncing = false;

/**
 * Process a batch of events - upsert to database in a single transaction
 * Returns extracted markets for token counting (avoids redundant extraction)
 */
async function processBatch(events, offset, marketCount) {
  // Extract markets once (not twice like before)
  const markets = extractMarketsFromEvents(events);

  let success = false;
  while (!success) {
    try {
      await upsertEvents(events);
      await upsertMarkets(markets);
      await upsertOutcomes(markets);
      success = true;
    } catch (err) {
      // Check if it's a connection error (typical during restart)
      log.warn(`Database unreachable during batch at offset ${offset}. Retrying in 60s...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
  
  log.debug(`Processed batch at offset ${offset}: ${events.length} events, ${markets.length} markets`);
  return { events: events.length, markets };
}
  

  


/**
 * Sync markets from Gamma API to database using streaming
 * @param {boolean} includeClosedEvents - Whether to also fetch recently closed events
 */
async function syncMarkets(includeClosedEvents = false) {
  // Prevent overlapping syncs
  if (isSyncing) {
    log.warn('Sync already in progress, skipping...');
    stats.skippedSyncs++;
    return { success: false, reason: 'sync_in_progress' };
  }
  
  isSyncing = true;
  const syncStart = Date.now();
  
  let totalEvents = 0;
  let totalMarkets = 0;
  let activeMarkets = [];
  
  try {
    log.info(`Starting market sync (includeClosedEvents=${includeClosedEvents})...`);
    
    // Stream active events - process each batch immediately
    log.info('Fetching active events...');
    const activeResult = await streamActiveEvents({
      pageSize: 100,
      onBatch: async (events, offset, marketCount) => {
        // processBatch now returns markets, avoiding redundant extraction
        const { markets } = await processBatch(events, offset, marketCount);
        
        // Filter for token counting (lightweight operation)
        const filtered = filterMarkets(markets, {
          min24hVolume: CONFIG.min24hVolume,
          max24hVolume: CONFIG.max24hVolume,
        });
        
        // Only store minimal info needed for counting
        for (const m of filtered) {
          activeMarkets.push({
            id: m.id,
            outcomes: getOutcomesForMarket(m),
          });
        }
        
        // Log progress
        process.stdout.write(`\r  Active events: ${offset + events.length} processed...`);
      },
    });
    console.log(''); // New line after progress
    
    totalEvents += activeResult.totalEvents;
    totalMarkets += activeResult.totalMarkets;
    log.info(`Processed ${activeResult.totalEvents} active events with ${activeResult.totalMarkets} markets`);
    
    // Stream closed events if requested
    if (includeClosedEvents) {
      log.info('Fetching recently closed events...');
      const closedResult = await streamClosedEvents({
        pageSize: 100,
        daysBack: CONFIG.closedEventsDaysBack,
        onBatch: async (events, offset, marketCount) => {
          await processBatch(events, offset, marketCount);
          process.stdout.write(`\r  Closed events: ${offset + events.length} processed...`);
        },
      });
      console.log(''); // New line after progress
      
      totalEvents += closedResult.totalEvents;
      totalMarkets += closedResult.totalMarkets;
      log.info(`Processed ${closedResult.totalEvents} closed events with ${closedResult.totalMarkets} markets`);
    }
    
    // Count active tokens
    let tokenCount = 0;
    for (const m of activeMarkets) {
      for (const o of m.outcomes) {
        if (o.tokenId) tokenCount++;
      }
    }
    
    const duration = Date.now() - syncStart;
    
    // Update stats
    stats.syncCount++;
    stats.lastSyncTime = new Date();
    stats.lastSyncDuration = duration;
    stats.eventsCount = totalEvents;
    stats.marketsCount = totalMarkets;
    stats.activeMarketsCount = activeMarkets.length;
    stats.tokensCount = tokenCount;
    
    // Clear activeMarkets to free memory
    activeMarkets = [];
    
    log.info(`Sync completed in ${duration}ms: ${totalEvents} events, ${totalMarkets} total markets, ${stats.activeMarketsCount} active, ${tokenCount} tokens`);
    
    return { success: true, events: totalEvents, markets: totalMarkets, tokens: tokenCount };
  } catch (err) {
    stats.errors++;
    log.error('Sync failed:', err.message);
    log.error(err.stack);
    return { success: false, error: err.message };
  } finally {
    // Always release the sync lock
    isSyncing = false;
  }
}

/**
 * Display status dashboard
 */
function displayStatus() {
  const uptime = formatDuration(Date.now() - stats.startTime);
  const lastSync = stats.lastSyncTime 
    ? stats.lastSyncTime.toLocaleTimeString() 
    : 'Never';
  const lastDuration = stats.lastSyncDuration 
    ? `${stats.lastSyncDuration}ms` 
    : 'N/A';
  
  console.log('\n' + '='.repeat(60));
  console.log('       POLYMARKET MARKET SYNC WORKER v2.1');
  console.log('='.repeat(60));
  console.log(`  Uptime:          ${uptime}`);
  console.log(`  Sync Count:      ${stats.syncCount}`);
  console.log(`  Skipped Syncs:   ${stats.skippedSyncs}`);
  console.log(`  Last Sync:       ${lastSync} (${lastDuration})`);
  console.log(`  Events:          ${stats.eventsCount}`);
  console.log(`  Total Markets:   ${stats.marketsCount}`);
  console.log(`  Active Markets:  ${stats.activeMarketsCount}`);
  console.log(`  Active Tokens:   ${stats.tokensCount}`);
  console.log(`  Errors:          ${stats.errors}`);
  console.log('='.repeat(60));
  console.log(`  Poll Intervals: Active=${CONFIG.activePollInterval/1000}s, Closed=${CONFIG.closedPollInterval/1000}s`);
  console.log(`  Sync Status:     ${isSyncing ? '🔄 SYNCING' : '✅ IDLE'}`);
  console.log(`  Data shared via: PostgreSQL database`);
  console.log('='.repeat(60) + '\n');
}

/**
 * Main worker loop
 */
async function main() {
  log.info('Starting Market Sync Worker...');
  log.info(`Configuration:`, CONFIG);
  
  let isShuttingDown = false;
  let activePollTimer = null;
  let closedPollTimer = null;
  let statusTimer = null;
  
  // Graceful shutdown handler
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    
    log.info('Shutting down gracefully...');
    
    if (activePollTimer) clearInterval(activePollTimer);
    if (closedPollTimer) clearInterval(closedPollTimer);
    if (statusTimer) clearInterval(statusTimer);
    
    // Wait for current sync to complete if one is running
    if (isSyncing) {
      log.info('Waiting for current sync to complete...');
      while (isSyncing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    await closePool();
    
    log.info('Shutdown complete');
    displayStatus();
    process.exit(0);
  };
  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  
  // Initial sync with closed events
  await syncMarkets(true);
  displayStatus();
  
  // Set up polling intervals
  
  // Active events poll (more frequent)
  // Note: syncMarkets now has internal lock, so overlapping calls are safely skipped
  activePollTimer = setInterval(async () => {
    if (!isShuttingDown) {
      await syncMarkets(false);
    }
  }, CONFIG.activePollInterval);
  
  // Closed events poll (less frequent)
  closedPollTimer = setInterval(async () => {
    if (!isShuttingDown) {
      await syncMarkets(true);
    }
  }, CONFIG.closedPollInterval);
  
  // Status display
  statusTimer = setInterval(() => {
    if (!isShuttingDown) {
      displayStatus();
    }
  }, 30000);
  
  log.info('Worker started. Press Ctrl+C to stop.');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { syncMarkets };
