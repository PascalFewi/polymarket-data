#!/usr/bin/env node
// src/workers/orderbook-collector.js
// Worker 2: Orderbook Collector Worker
//
// Responsibilities:
// - Reads active tokens directly from the database (populated by market-sync worker)
// - Manages WebSocket connections to Polymarket CLOB
// - Stores orderbook snapshots to the database using BATCHED WRITES
// - Handles reconnection and connection pooling
//
// This worker does NOT fetch market data from Gamma API.
//
// KEY OPTIMIZATION: Uses a write buffer to batch database inserts.
// Instead of inserting every snapshot immediately (which overloaded the DB),
// snapshots are accumulated in a buffer and flushed periodically or when
// the buffer reaches a threshold. This reduces DB load by ~100x.

import dotenv from 'dotenv';
import WebSocket from 'ws';

dotenv.config();

import { closePool } from '../lib/db.js';
import { insertOrderbookSnapshotBatch, getActiveOutcomeTokens } from '../lib/db-operations.js';
import { 
  chunkArray, 
  compactLevels, 
  createLogger, 
  formatDuration,
  sleep,
} from '../utils/helpers.js';

const log = createLogger('Orderbook');

// Configuration
const CONFIG = {
  // Maximum assets per WebSocket connection (Polymarket limit)
  maxAssetsPerSocket: parseInt(process.env.MAX_ASSETS_PER_SOCKET || '500', 10),
  // How often to check for token updates from database (ms)
  tokenCheckInterval: parseInt(process.env.TOKEN_CHECK_INTERVAL || '30000', 10),
  // WebSocket ping interval (ms)
  wsPingInterval: parseInt(process.env.WS_PING_INTERVAL || '10000', 10),
  // Maximum reconnect delay (ms)
  maxReconnectDelay: parseInt(process.env.MAX_RECONNECT_DELAY || '30000', 10),
  // No-message timeout before reconnect (ms)
  noMessageTimeout: parseInt(process.env.NO_MESSAGE_TIMEOUT || '30000', 10),
  // Dashboard update interval (ms)
  dashboardInterval: parseInt(process.env.DASHBOARD_INTERVAL || '2000', 10),
  // Write buffer settings
  writeBufferMaxSize: parseInt(process.env.WRITE_BUFFER_MAX_SIZE || '100', 10),
  writeBufferFlushInterval: parseInt(process.env.WRITE_BUFFER_FLUSH_INTERVAL || '1000', 10),
  // Script ID for logging/monitoring purposes
  scriptId: parseInt(process.env.SCRIPT_ID || '1', 10),
};

// WebSocket URL
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Global stats
const stats = {
  startTime: Date.now(),
  snapshotsReceived: 0,
  snapshotsStored: 0,
  snapshotsBuffered: 0,
  flushCount: 0,
  errors: 0,
  reconnections: 0,
  lastSnapshot: null,
  lastFlush: null,
  lastTokenCheck: null,
  currentTokenCount: 0,
};

/**
 * Shared Write Buffer for all WebSocket managers
 * Accumulates snapshots and flushes them in batches to reduce DB load
 */
class WriteBuffer {
  constructor(maxSize, flushIntervalMs) {
    this.buffer = [];
    this.maxSize = maxSize;
    this.flushIntervalMs = flushIntervalMs;
    this.flushTimer = null;
    this.isFlushing = false;

  }

  start() {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  add(snapshot) {
    this.buffer.push(snapshot);
    stats.snapshotsBuffered = this.buffer.length;

    // Flush if buffer is full
    if (this.buffer.length >= this.maxSize) {
      this.flush();
    }
  }

  async flush() {
    // Prevent concurrent flushes
    if (this.isFlushing || this.buffer.length === 0) return;

    this.isFlushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    stats.snapshotsBuffered = this.buffer.length;

    try {
      await insertOrderbookSnapshotBatch(batch);
      stats.snapshotsStored += batch.length;
      stats.flushCount++;
      stats.lastFlush = new Date();
      stats.lastSnapshot = new Date();
    } catch (err) {
      stats.errors++;
      log.error(`Batch insert failed (${batch.length} items):`, err.message);
      // Optionally: re-add failed items to buffer for retry
      this.buffer.unshift(...batch);
    } finally {
      this.isFlushing = false;
    }
  }

  async flushAndStop() {
    this.stop();
    await this.flush();
  }
}

// Global write buffer instance
const writeBuffer = new WriteBuffer(
  CONFIG.writeBufferMaxSize,
  CONFIG.writeBufferFlushInterval
);

/**
 * WebSocket Manager class with reconnection logic
 */
class WebSocketManager {
  constructor(assetIds, outcomeMap, idx) {
    this.assetIds = assetIds;
    this.outcomeMap = outcomeMap;
    this.idx = idx;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.isClosing = false;
    this.lastMessageTime = Date.now();
    this.status = 'disconnected';
    this.messagesReceived = 0;
  }

  connect() {
    if (this.isClosing) return;

    this.ws = new WebSocket(WS_URL);
    this.status = 'connecting';

    this.ws.on('open', () => {
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();

      // Subscribe to market data
      this.ws.send(
        JSON.stringify({
          assets_ids: this.assetIds,
          type: 'market',
        })
      );

      log.info(`[WS #${this.idx}] Connected, subscribed to ${this.assetIds.length} assets`);
      this.setupPingInterval();
    });

    this.ws.on('message', (data) => {
      this.lastMessageTime = Date.now();
      this.messagesReceived++;

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const eventType = msg.event_type ?? msg.type;
      if (eventType === 'book') {
        stats.snapshotsReceived++;
        
        try {
          const tokenMeta = this.outcomeMap.get(String(msg.asset_id));
          this.queueSnapshot(msg, tokenMeta);
        } catch (err) {
          stats.errors++;
          log.error(`[WS #${this.idx}] Error queueing snapshot:`, err.message);
        }
      }
    });

    this.ws.on('error', (err) => {
      this.status = 'error';
      stats.errors++;
      log.error(`[WS #${this.idx}] Error:`, err.message);
    });

    this.ws.on('close', (code, reason) => {
      this.status = 'disconnected';
      this.cleanup();

      if (!this.isClosing) {
        log.warn(`[WS #${this.idx}] Closed (${code}), scheduling reconnect...`);
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Queue a snapshot for batched insertion instead of inserting immediately
   */
  queueSnapshot(msg, tokenMeta) {
    const bidsRaw = msg.bids ?? msg.buys ?? [];
    const asksRaw = msg.asks ?? msg.sells ?? [];
    const assetId = msg.asset_id;

    if (!assetId) return;

    const bids = compactLevels(bidsRaw);
    const asks = compactLevels(asksRaw);

    // Add to shared write buffer instead of inserting directly
    writeBuffer.add({
      assetId: String(assetId),
      marketId: tokenMeta?.marketId ?? null,
      outcomeIndex: tokenMeta?.outcomeIndex ?? null,
      bids,
      asks,
      timestamp: Date.now(),
      scriptId: CONFIG.scriptId,
    });
  }

  setupPingInterval() {
    if (this.pingInterval) clearInterval(this.pingInterval);

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PING');

        // Check for stale connection
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        if (timeSinceLastMessage > CONFIG.noMessageTimeout) {
          log.warn(`[WS #${this.idx}] No messages for ${timeSinceLastMessage}ms, reconnecting...`);
          this.reconnect();
        }
      }
    }, CONFIG.wsPingInterval);
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      CONFIG.maxReconnectDelay
    );

    this.status = 'reconnecting';

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      stats.reconnections++;
      this.connect();
    }, delay);

    log.debug(`[WS #${this.idx}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
  }

  reconnect() {
    if (this.ws) {
      this.ws.terminate();
    }
    this.cleanup();
    this.connect();
  }

  cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  close() {
    this.isClosing = true;
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  updateAssetIds(newAssetIds, newOutcomeMap) {
    this.assetIds = newAssetIds;
    this.outcomeMap = newOutcomeMap;
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          assets_ids: this.assetIds,
          type: 'market',
        })
      );
      log.info(`[WS #${this.idx}] Resubscribed to ${this.assetIds.length} assets`);
    }
  }
}

/**
 * Get active tokens from database
 * @returns {Promise<{tokens: Map, count: number} | null>}
 */
async function getTokensFromDatabase() {
  try {
    const tokens = await getActiveOutcomeTokens();
    return {
      tokens,
      count: tokens.size,
    };
  } catch (err) {
    log.error('Error reading tokens from database:', err.message);
    return null;
  }
}

/**
 * Display dashboard
 */
function displayDashboard(wsManagers) {
  const uptime = formatDuration(Date.now() - stats.startTime);
  const rate = (Date.now() - stats.startTime) / 1000 > 0
    ? (stats.snapshotsStored / ((Date.now() - stats.startTime) / 1000)).toFixed(2)
    : '0.00';
  const lastSnapshot = stats.lastSnapshot
    ? stats.lastSnapshot.toLocaleTimeString()
    : 'N/A';
  const lastFlush = stats.lastFlush
    ? stats.lastFlush.toLocaleTimeString()
    : 'N/A';

  console.clear();
  
  // Header
  console.log('╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                                        POLYMARKET ORDERBOOK COLLECTOR v2.1                                        ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝');

  // Stats row
  const totalAssets = wsManagers.reduce((sum, m) => sum + m.assetIds.length, 0);
  console.log(`  Uptime: ${uptime.padEnd(18)} Connections: ${wsManagers.length.toString().padEnd(4)} Assets: ${totalAssets.toString().padEnd(8)} Snapshots: ${stats.snapshotsStored.toString().padEnd(10)} Rate: ${rate}/s`);
  console.log('');

  // Write buffer stats
  console.log('┌─ WRITE BUFFER ────────────────────────────────────────────────────────────────────────────────────────────────────┐');
  const bufferStatus = `Buffered: ${stats.snapshotsBuffered.toString().padEnd(6)} │  Flushes: ${stats.flushCount.toString().padEnd(8)} │  Last Flush: ${lastFlush.padEnd(12)} │  Max Size: ${CONFIG.writeBufferMaxSize}  │  Interval: ${CONFIG.writeBufferFlushInterval}ms`;
  console.log(`│ ${bufferStatus.padEnd(113)} │`);
  console.log('└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘');
  console.log('');

  // WebSocket connections
  console.log('┌─ WEBSOCKET CONNECTIONS ───────────────────────────────────────────────────────────────────────────────────────────┐');

  const maxDisplay = 10;
  const displayManagers = wsManagers.slice(0, maxDisplay);

  displayManagers.forEach(mgr => {
    const status = getStatusIndicator(mgr.status);
    const idx = String(mgr.idx).padStart(2);
    const assets = String(mgr.assetIds.length).padStart(4);
    const messages = String(mgr.messagesReceived).padStart(10);
    const timeSince = Math.floor((Date.now() - mgr.lastMessageTime) / 1000);
    const lastMsg = timeSince < 60 ? `${timeSince}s ago` : `${Math.floor(timeSince / 60)}m ago`;

    const content = `WS #${idx} ${status}  Assets: ${assets}  │  Messages: ${messages}  │  Last: ${lastMsg.padEnd(10)}  │  Reconnects: ${mgr.reconnectAttempts}`;
    console.log(`│ ${content.padEnd(113)} │`);
  });

  if (wsManagers.length > maxDisplay) {
    const remaining = wsManagers.length - maxDisplay;
    const remainingConnected = wsManagers.slice(maxDisplay).filter(m => m.status === 'connected').length;
    console.log(`│ ... and ${remaining} more connections (${remainingConnected} connected)`.padEnd(115) + '│');
  }

  console.log('└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘');
  console.log('');

  // Footer stats
  console.log(`  Last Snapshot: ${lastSnapshot.padEnd(15)} │  Errors: ${stats.errors.toString().padEnd(8)} │  Reconnections: ${stats.reconnections}`);
  console.log('');
  console.log(`  Token Source: PostgreSQL (outcomes table)    │  Last Check: ${stats.lastTokenCheck ? stats.lastTokenCheck.toLocaleTimeString() : 'N/A'}`);
  console.log('  Press Ctrl+C to stop gracefully');
}

function getStatusIndicator(status) {
  switch(status) {
    case 'connected': return '🟢';
    case 'connecting': return '🟡';
    case 'reconnecting': return '🟠';
    case 'error': return '🔴';
    case 'disconnected': return '⚫';
    default: return '⚪';
  }
}

/**
 * Main worker loop
 */
async function main() {
  log.info('Starting Orderbook Collector Worker...');
  log.info('Configuration:', CONFIG);

  let wsManagers = [];
  let isShuttingDown = false;
  let tokenCheckTimer = null;
  let dashboardTimer = null;
  let previousTokenCount = 0;

  // Start the write buffer
  writeBuffer.start();
  log.info(`Write buffer started (maxSize=${CONFIG.writeBufferMaxSize}, flushInterval=${CONFIG.writeBufferFlushInterval}ms)`);

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.clear();
    console.log('\n╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                                              SHUTTING DOWN GRACEFULLY                                             ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝\n');

    log.info('Closing WebSocket connections...');
    if (tokenCheckTimer) clearInterval(tokenCheckTimer);
    if (dashboardTimer) clearInterval(dashboardTimer);
    wsManagers.forEach(mgr => mgr.close());

    log.info('Flushing remaining buffered snapshots...');
    await writeBuffer.flushAndStop();

    log.info('Closing database pool...');
    await closePool();

    log.info('Shutdown complete');
    console.log('\n  Final Stats:');
    console.log(`    - Total Snapshots: ${stats.snapshotsStored}`);
    console.log(`    - Total Flushes: ${stats.flushCount}`);
    console.log(`    - Uptime: ${formatDuration(Date.now() - stats.startTime)}`);
    console.log(`    - Errors: ${stats.errors}`);
    console.log(`    - Reconnections: ${stats.reconnections}\n`);
    
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  /**
   * Update WebSocket subscriptions based on database tokens
   */
  async function updateSubscriptions() {
    const tokenData = await getTokensFromDatabase();
    if (!tokenData) {
      log.warn('No token data available from database');
      log.warn('Make sure the market-sync worker has run at least once!');
      return false;
    }

    const { tokens: outcomeMap, count } = tokenData;
    const assetIds = [...outcomeMap.keys()];
    
    stats.lastTokenCheck = new Date();
    stats.currentTokenCount = count;

    if (assetIds.length === 0) {
      log.warn('No active tokens found in database');
      wsManagers.forEach(mgr => mgr.close());
      wsManagers = [];
      return false;
    }

    // Check if we need to rebuild connections (significant change in token count)
    const tokenCountChanged = Math.abs(count - previousTokenCount) > 10;
    const needsRebuild = wsManagers.length === 0 || tokenCountChanged;

    if (needsRebuild) {
      log.info(`Building WebSocket connections for ${assetIds.length} assets...`);
      
      // Close old connections
      wsManagers.forEach(mgr => mgr.close());
      wsManagers = [];

      // Create new connections
      const chunks = chunkArray(assetIds, CONFIG.maxAssetsPerSocket);
      wsManagers = chunks.map((chunk, idx) => {
        const manager = new WebSocketManager(chunk, outcomeMap, idx);
        manager.connect();
        return manager;
      });

      log.info(`Created ${wsManagers.length} WebSocket connections`);
      previousTokenCount = count;
    } else {
      // Just update outcome maps for existing managers
      wsManagers.forEach(mgr => {
        mgr.outcomeMap = outcomeMap;
      });
    }
    
    return true;
  }

  // Wait for initial data in database
  log.info('Waiting for market data in database...');
  let attempts = 0;
  let success = false;
  
  while (attempts < 60 && !success) {
    success = await updateSubscriptions();
    if (!success) {
      await sleep(1000);
      attempts++;
      if (attempts % 10 === 0) {
        log.info(`Still waiting for market data... (${attempts}s)`);
      }
    }
  }

  if (!success) {
    log.error('Timeout waiting for market data. Make sure market-sync worker is running.');
    process.exit(1);
  }

  // Check for token updates periodically
  tokenCheckTimer = setInterval(async () => {
    if (!isShuttingDown) {
      await updateSubscriptions();
    }
  }, CONFIG.tokenCheckInterval);

  // Dashboard update
  dashboardTimer = setInterval(() => {
    if (!isShuttingDown) {
      displayDashboard(wsManagers);
    }
  }, CONFIG.dashboardInterval);

  // Initial dashboard
  displayDashboard(wsManagers);

  log.info('Worker started. Press Ctrl+C to stop.');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { WebSocketManager, WriteBuffer, getTokensFromDatabase };
