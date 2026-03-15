# Polymarket Data Collector

A robust, production-ready system for collecting and storing Polymarket orderbook data. The system is split into two independent workers for better reliability, scalability, and maintainability.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           POLYMARKET DATA COLLECTOR                         │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐                  ┌─────────────────────┐
│                     │                  │                     │
│  MARKET SYNC WORKER │                  │  ORDERBOOK WORKER   │
│                     │                  │                     │
│  • Fetches events   │                  │  • WebSocket mgmt   │
│  • Fetches markets  │                  │  • Orderbook data   │
│  • Updates database │                  │  • Auto-reconnect   │
│                     │                  │  • Stores snapshots │
│                     │                  │                     │
└────────┬────────────┘                  └────────┬────────────┘
         │                                        │
         │            ┌───────────┐               │
         │            │           │               │
         └───────────►│ PostgreSQL│◄──────────────┘
                      │ TimescaleDB               
                      │           │               
                      │ events    │  Worker 2 queries active
                      │ markets   │  tokens from outcomes table
                      │ outcomes ─┼─────────────────────────────►
                      │ orderbooks│               
                      └───────────┘               

┌─────────────────────────────────────────────────────────────────────────────┐
│  External Services:                                                         │
│  • Gamma API (https://gamma-api.polymarket.com) - Market/Event data         │
│  • CLOB WebSocket (wss://ws-subscriptions-clob.polymarket.com) - Orderbooks │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Two Independent Workers**: Market sync and orderbook collection run separately
- **Database-Based Communication**: Workers share data via PostgreSQL (no file dependencies)
- **Robust WebSocket Management**: Auto-reconnection with exponential backoff
- **Connection Pooling**: Multiple WebSocket connections for scaling (500 assets per connection)
- **Batched Database Operations**: Prevents memory exhaustion with large datasets
- **TimescaleDB Support**: Optimized time-series storage with compression
- **Real-time Dashboard**: Visual monitoring of system health
- **Graceful Shutdown**: Clean resource cleanup on termination

## Prerequisites

- **Node.js** >= 18.0.0 (for native fetch support)
- **PostgreSQL** >= 13 (with optional TimescaleDB extension)
- **npm** or **yarn**

## Quick Start

### 1. Clone and Install

```bash
# Clone the repository (or copy files)
cd polymarket-data

# Install dependencies
npm install
```

### 2. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit with your database credentials
nano .env
```

**Required environment variables:**

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=polymarket
DB_USER=postgres
DB_PASSWORD=your_password_here
```

### 3. Run


| Script | Description |
|--------|-------------|
| `node scripts/db-init.js` | Initialize database schema |
| `node scripts/db-clear.js` | Clear all data (with confirmation) |
| `node src/workers/market-sync.js` | Start market sync worker |
| `node src/workers/orderbook-collector.js` | Start orderbook collector worker |



## Workers

### Market Sync Worker (`worker:market-sync`)

Responsible for:
- Fetching active events from Polymarket's Gamma API
- Fetching recently closed events (for status updates)
- Upserting events, markets, and outcomes to the database

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ACTIVE_POLL_INTERVAL` | 60000 | Poll interval for active events (ms) |
| `CLOSED_POLL_INTERVAL` | 300000 | Poll interval for closed events (ms) |
| `MIN_24H_VOLUME` | 0 | Minimum 24h volume filter |
| `MAX_24H_VOLUME` | Infinity | Maximum 24h volume filter |
| `CLOSED_EVENTS_DAYS_BACK` | 7 | Days to look back for closed events |

### Orderbook Collector Worker (`worker:orderbook`)

Responsible for:
- Reading active tokens directly from the database (outcomes table)
- Managing WebSocket connections to Polymarket CLOB
- Storing orderbook snapshots to the database
- Handling reconnection and connection health

**Configuration:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_ASSETS_PER_SOCKET` | 500 | Max assets per WebSocket (Polymarket limit) |
| `TOKEN_CHECK_INTERVAL` | 30000 | How often to check database for token updates (ms) |
| `WS_PING_INTERVAL` | 10000 | WebSocket ping interval (ms) |
| `MAX_RECONNECT_DELAY` | 30000 | Maximum reconnect delay (ms) |
| `NO_MESSAGE_TIMEOUT` | 30000 | Reconnect if no messages received (ms) |

## Database Schema

### Tables

**events** - High-level prediction questions
```sql
id              TEXT PRIMARY KEY
title           TEXT
slug            TEXT
description     TEXT
categories      TEXT
created_at      TIMESTAMPTZ
start_date      TIMESTAMPTZ
end_date        TIMESTAMPTZ
active          BOOLEAN
closed          BOOLEAN
archived        BOOLEAN
volume          NUMERIC
liquidity       NUMERIC
open_interest   NUMERIC
```

**markets** - Individual trading markets within events
```sql
id                        TEXT PRIMARY KEY
event_id                  TEXT (FK -> events)
question                  TEXT
slug                      TEXT
active                    BOOLEAN
closed                    BOOLEAN
volume_24h                NUMERIC
volume_total              NUMERIC
liquidity                 NUMERIC
...
```

**outcomes** - YES/NO or multi-outcome options per market
```sql
id            BIGSERIAL PRIMARY KEY
market_id     TEXT (FK -> markets)
outcome_index INT
outcome       TEXT
token_id      TEXT
```

**orderbooks** - Time-series orderbook snapshots (TimescaleDB hypertable)
```sql
id            BIGSERIAL PRIMARY KEY
ts            BIGINT (Unix timestamp in milliseconds)
asset_id      TEXT
market_id     TEXT
outcome_index INT
bids          JSONB
asks          JSONB
```

## How Workers Communicate

The orderbook worker queries the database directly to get active tokens:

```sql
SELECT o.token_id, o.market_id, o.outcome_index, o.outcome
FROM outcomes o
JOIN markets m ON o.market_id = m.id
WHERE m.active = true 
  AND m.closed = false 
  AND m.archived = false
  AND o.token_id IS NOT NULL
```

This approach:
- **No file system dependency** - works across machines, containers, etc.
- **Single source of truth** - database is already there
- **Simpler deployment** - no shared volumes needed
- **Atomic updates** - database transactions ensure consistency

## Project Structure

```
polymarket-collector/
├── package.json
├── .env.example
├── README.md
├── ecosystem.config.cjs        # PM2 configuration
├── scripts/
│   ├── db-init.js             # Database initialization
│   └── db-clear.js            # Database reset (with confirmation)
└── src/
    ├── lib/
    │   ├── db.js              # Database connection pool
    │   ├── db-operations.js   # Database CRUD operations (batched)
    │   └── gamma-api.js       # Polymarket Gamma API client
    ├── utils/
    │   └── helpers.js         # Shared utility functions
    └── workers/
        ├── market-sync.js     # Worker 1: Market synchronization
        └── orderbook-collector.js  # Worker 2: Orderbook collection
```





## Monitoring

### Health Checks

Both workers display real-time dashboards with:
- Uptime and connection status
- Message rates and counts
- Error counts and reconnection attempts
- Last snapshot timestamp

### Logs

Enable debug logging:

```bash
DEBUG=true npm run src/worker/market-sync.js
```

### Database Queries

Check recent orderbook snapshots:

```sql
SELECT 
  to_timestamp(ts/1000) as time,
  market_id,
  outcome_index,
  jsonb_array_length(bids) as bid_levels,
  jsonb_array_length(asks) as ask_levels
FROM orderbooks
ORDER BY ts DESC
LIMIT 10;
```

Check active markets:

```sql
SELECT 
  m.id,
  m.question,
  e.title as event_title,
  m.volume_24h,
  m.liquidity
FROM markets m
JOIN events e ON m.event_id = e.id
WHERE m.active = true AND m.closed = false
ORDER BY m.volume_24h DESC
LIMIT 20;
```

## Troubleshooting

### "No token data available from database" error

The orderbook worker requires the market sync worker to populate the database first. Make sure:
1. Market sync worker has run at least once
2. Both workers are connecting to the same database
3. Database credentials are correct in `.env`

### WebSocket disconnections

The system handles reconnections automatically with exponential backoff. If you see frequent disconnections:
1. Check your network connection
2. Verify you're not exceeding rate limits
3. Check Polymarket API status

### Database connection errors

1. Verify database credentials in `.env`
2. Check PostgreSQL is running
3. Ensure SSL settings match your database configuration
4. Check connection pool isn't exhausted

### High memory usage

1. Reduce `DB_POOL_SIZE`
2. Enable TimescaleDB compression
3. Consider archiving old orderbook data

### Process killed during sync

If the market-sync worker gets killed during initial sync (with 26,000+ markets), the batched database operations should prevent this. If it still occurs:
1. Check available system memory
2. Reduce batch size in `src/lib/db-operations.js` (default: 100)

