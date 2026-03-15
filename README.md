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
cd polymarket-collector

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

### 3. Initialize Database

```bash
# Create tables and indexes
npm run db:init
```

### 4. Start Workers

**Option A: Run both workers (recommended for production)**

```bash
# Terminal 1: Start the market sync worker
npm run worker:market-sync

# Terminal 2: Start the orderbook collector worker  
npm run worker:orderbook
```

**Option B: Run with a process manager (PM2)**

```bash
# Install PM2 globally
npm install -g pm2

# Start both workers
pm2 start ecosystem.config.cjs
```

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

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run db:init` | Initialize database schema |
| `npm run db:clear` | Clear all data (with confirmation) |
| `npm run worker:market-sync` | Start market sync worker |
| `npm run worker:orderbook` | Start orderbook collector worker |
| `npm run dev:market-sync` | Start market sync with debug logging |
| `npm run dev:orderbook` | Start orderbook collector with debug logging |

## Production Deployment

### Using PM2

Create `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [
    {
      name: 'market-sync',
      script: 'src/workers/market-sync.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'orderbook-collector',
      script: 'src/workers/orderbook-collector.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

Start with PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # Enable auto-start on boot
```

### Using Docker

Create `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# Default to market-sync worker
CMD ["node", "src/workers/market-sync.js"]
```

Create `docker-compose.yml`:

```yaml
version: '3.8'
services:
  market-sync:
    build: .
    command: node src/workers/market-sync.js
    env_file: .env
    restart: unless-stopped
    depends_on:
      - postgres

  orderbook-collector:
    build: .
    command: node src/workers/orderbook-collector.js
    env_file: .env
    restart: unless-stopped
    depends_on:
      - market-sync

  postgres:
    image: timescale/timescaledb:latest-pg15
    environment:
      POSTGRES_DB: polymarket
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: your_password
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

volumes:
  pgdata:
```

### Using systemd

Create `/etc/systemd/system/polymarket-market-sync.service`:

```ini
[Unit]
Description=Polymarket Market Sync Worker
After=network.target postgresql.service

[Service]
Type=simple
User=polymarket
WorkingDirectory=/opt/polymarket-collector
ExecStart=/usr/bin/node src/workers/market-sync.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Create similar file for orderbook-collector.

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-market-sync polymarket-orderbook
sudo systemctl start polymarket-market-sync polymarket-orderbook
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
DEBUG=true npm run worker:market-sync
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

